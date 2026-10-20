// 存档编辑器 —— .minecraft 定位、世界列表、世界属性 / 玩家数据编辑，以及区块编辑器入口。
//
// 视觉重写版：左侧可搜索世界列表，右侧「世界 / 玩家 / 区块」标签页。
// 后端契约（端点、payload 键、字段名、提示文案）与原实现保持一致。
import { h, clear, fmtDateTime, fmtAgo } from '/js/core/dom.js'
import { api } from '/js/core/api.js'
import { toast } from '/js/core/toast.js'
import { pickDir } from '/js/core/dirpicker.js'
import { btn, iconBtn, input, select, field, badge, emptyState, icon, spinner } from '/js/ui/kit.js'
import { openChunkEditor } from './chunk-editor.js'

const GAME_TYPES = ['生存', '创造', '冒险', '旁观']
const DIFFICULTIES = ['和平', '简单', '普通', '困难']

// 单个编辑器实例（磁贴 / 展开视图）共享同一份数据；UI 节点按实例分别渲染。
const instances = []

const state = {
  mcDir: '',
  worlds: [],
  world: null,          // 选中的世界 summary
  worldDetail: null,    // /api/saveeditor/world 返回
  detailError: '',
  playerKey: '',
  player: null,         // /api/saveeditor/player 返回
  playerError: '',
  busy: false,
  regions: null,        // /api/saveeditor/regions 的 items
  regionsDir: '',
  regionsFor: '',
  regionsError: '',
  regionsLoading: false
}

// 请求序号：快速切换世界时丢弃过期响应
let worldsSeq = 0
let detailSeq = 0
let playerSeq = 0
let regionsSeq = 0

export default {
  async mount(ctx) {
    const s = ctx.settings()
    state.mcDir = (s.saveEditor && s.saveEditor.mcDir) || ''
    buildInto(ctx.body, ctx)
  },

  renderExpanded(container, { ctx } = {}) {
    buildInto(container, ctx)
  }
}

// ---------------- 实例与小工具 ----------------

function liveInstances() {
  for (let i = instances.length - 1; i >= 0; i--) {
    if (!instances[i].root.isConnected) instances.splice(i, 1)
  }
  return instances
}

function note(text, { danger = false } = {}) {
  return h('div', {
    class: 'muted center',
    style: { padding: '14px 10px', fontSize: '12px', color: danger ? 'var(--danger)' : '' }
  }, text)
}

function loadingLine(text) {
  return h('div', { class: 'row', style: { gap: '8px', color: 'var(--mute)', padding: '10px 0' } }, spinner(13), text)
}

function hintLine(text) {
  return h('div', { class: 'se-hint' }, icon('warning', { size: 13 }), h('span', {}, text))
}

function playerBackupName(backup) {
  return String(backup || '').split(/[\\/]/).pop()
}

function numInput(value, { step = '1' } = {}) {
  return input({ type: 'number', step, value: value === null || value === undefined ? '' : value })
}

function txtInput(value) {
  return input({ value: value ?? '' })
}

function selInput(labels, value) {
  return select(labels.map((label, i) => [i, label]), value ?? 0)
}

function chkInput(value, label) {
  const cb = h('input', { type: 'checkbox', checked: !!value })
  const wrap = h('label', { class: 'row', style: { gap: '6px', margin: '0', cursor: 'pointer' } },
    cb, h('span', { style: { fontSize: '12px' } }, label))
  wrap._input = cb
  return wrap
}

// ---------------- 构建 UI ----------------

function buildInto(container, ctx) {
  clear(container)
  const inst = {
    root: container,
    ctx,
    list: null,
    head: null,
    pane: null,
    playerBox: null,
    tabBtns: {},
    tab: 'world',
    filter: '',
    dirInput: null,
    openBtn: null
  }
  instances.push(inst)

  // ---- 目录行 ----
  const dirInput = input({
    value: state.mcDir,
    mono: true,
    placeholder: '.minecraft 目录（例如 C:\\Users\\你\\AppData\\Roaming\\.minecraft）',
    onChange: () => {
      state.mcDir = dirInput.value.trim()
      syncOpenButtons()
    },
    onKeyDown: (e) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      readFromInput(inst)
    }
  })
  dirInput.setAttribute('aria-label', '.minecraft 目录')
  inst.dirInput = dirInput

  const btnDetect = btn('自动检测', { size: 'sm', iconName: 'search', onClick: () => detectDir(inst) })
  const btnBrowse = btn('浏览', { size: 'sm', iconName: 'folder', onClick: () => browseDir(inst) })
  const btnOpen = iconBtn('folder-open', { label: '在资源管理器中打开', size: 15, onClick: () => openDir() })
  btnOpen.disabled = !state.mcDir
  inst.openBtn = btnOpen
  const btnLoad = btn('读取存档', { size: 'sm', variant: 'primary', iconName: 'refresh', onClick: () => readFromInput(inst) })

  const dirRow = h('div', { class: 'row wrap', style: { gap: '6px' } },
    h('div', { style: { flex: '1 1 280px', minWidth: '0' } }, dirInput),
    btnDetect, btnBrowse, btnOpen, btnLoad
  )

  // ---- 左列：世界列表 ----
  const searchInput = input({
    placeholder: '搜索世界…',
    onInput: () => {
      inst.filter = searchInput.value.trim().toLowerCase()
      renderWorlds(inst)
    }
  })
  searchInput.setAttribute('aria-label', '搜索世界')
  const btnRefresh = iconBtn('refresh', { label: '刷新世界列表', size: 14, onClick: () => loadWorlds() })
  const list = h('div', { class: 'se-worlds-list' })
  inst.list = list

  const worldsBox = h('div', { class: 'se-worlds' },
    h('div', { class: 'se-worlds-head' },
      h('div', { class: 'grow' }, searchInput),
      btnRefresh
    ),
    list
  )

  // ---- 右列：标题 + 标签页 + 内容 ----
  const head = h('div', { class: 'row wrap', style: { gap: '6px', minHeight: '18px' } })
  inst.head = head

  const tabs = h('div', { class: 'tabs se-tabs' })
  for (const [key, label] of [['world', '世界'], ['player', '玩家'], ['chunk', '区块']]) {
    const tab = h('button', {
      class: 'tab',
      type: 'button',
      onclick: () => {
        if (inst.tab === key) return
        inst.tab = key
        renderPane(inst)
        if (key === 'chunk') ensureRegions(inst)
      }
    }, label)
    inst.tabBtns[key] = tab
    tabs.appendChild(tab)
  }

  const pane = h('div', { class: 'se-pane' })
  inst.pane = pane

  const editor = h('div', { class: 'se-editor' }, head, tabs, pane)
  const layout = h('div', { class: 'se-layout' }, worldsBox, editor)
  inst.layout = layout
  inst.worldsBox = worldsBox

  container.appendChild(h('div', { class: 'col', style: { gap: '10px' } },
    h('div', { class: 'field' },
      h('label', {}, '.minecraft 目录'),
      dirRow
    ),
    layout
  ))

  renderHead(inst)
  renderWorlds(inst)
  renderPane(inst)
  syncTabs(inst)
  fitInstance(inst)

  // 磁贴可被拖成 1 格宽：按容器宽度而非视口宽度切换单/双列
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      if (!container.isConnected) { ro.disconnect(); return }
      fitInstance(inst)
    })
    ro.observe(container)
    inst.ro = ro
  }

  if (state.mcDir && !state.worlds.length) loadWorlds()
  else if (!state.mcDir) renderWorlds(inst)
}

function fitInstance(inst) {
  const w = inst.root && inst.root.clientWidth
  if (!w) return
  const narrow = w < 620
  if (inst.layout) inst.layout.style.gridTemplateColumns = narrow ? 'minmax(0, 1fr)' : '250px minmax(0, 1fr)'
  if (inst.worldsBox) inst.worldsBox.style.maxHeight = narrow ? '200px' : ''
  const cols = w < 460 ? '1fr' : '1fr 1fr'
  for (const grid of inst.root.querySelectorAll('.se-grid')) grid.style.gridTemplateColumns = cols
}

function syncOpenButtons() {
  for (const inst of liveInstances()) if (inst.openBtn) inst.openBtn.disabled = !state.mcDir
}

async function readFromInput(inst) {
  state.mcDir = inst.dirInput.value.trim()
  persistDir(inst)
  await loadWorlds()
}

async function browseDir(inst) {
  const p = await pickDir(state.mcDir)
  if (!p) return
  setDir(p, inst)
  await loadWorlds()
}

async function detectDir(inst) {
  try {
    const r = await api.get('/api/saveeditor/presets')
    if (!r.items || !r.items.length) {
      toast('未在默认位置找到 .minecraft，请手动浏览选择', 'warn')
      return
    }
    setDir(r.items[0].path, inst)
    toast('已找到：' + state.mcDir, 'ok')
    loadWorlds()
  } catch (e) {
    toast('检测失败：' + e.message, 'err')
  }
}

async function openDir() {
  if (!state.mcDir) return
  try { await api.post('/api/fs/open', { path: state.mcDir }) } catch (e) { toast(e.message, 'err') }
}

function setDir(p, inst) {
  state.mcDir = p || ''
  for (const i of liveInstances()) if (i.dirInput) i.dirInput.value = state.mcDir
  persistDir(inst)
  syncOpenButtons()
}

function persistDir(inst) {
  api.put('/api/settings', { saveEditor: { mcDir: state.mcDir } }).catch(() => {})
  try {
    const ctx = inst && inst.ctx
    if (!ctx) return
    const s = ctx.settings()
    if (!s) return
    if (!s.saveEditor) s.saveEditor = {}
    s.saveEditor.mcDir = state.mcDir
  } catch {}
}

// ---------------- 世界列表 ----------------

async function loadWorlds() {
  if (!state.mcDir) {
    toast('请先填写 .minecraft 目录', 'warn')
    return
  }
  const seq = ++worldsSeq
  state.busy = true
  for (const inst of liveInstances()) {
    clear(inst.list)
    inst.list.appendChild(loadingLine('读取中…'))
  }
  try {
    const r = await api.get('/api/saveeditor/worlds?mcDir=' + encodeURIComponent(state.mcDir))
    if (seq !== worldsSeq) return
    if (r.error) throw new Error(r.error)
    state.worlds = r.worlds || []
    if (state.world && !state.worlds.some((w) => w.path === state.world.path)) {
      state.world = null
      state.worldDetail = null
      state.detailError = ''
      state.player = null
      state.playerKey = ''
      state.playerError = ''
      state.regions = null
      state.regionsFor = ''
      state.regionsError = ''
      state.regionsLoading = false
    }
    for (const inst of liveInstances()) {
      renderWorlds(inst)
      if (!state.world) { renderHead(inst); renderPane(inst) }
    }
  } catch (e) {
    if (seq !== worldsSeq) return
    for (const inst of liveInstances()) {
      clear(inst.list)
      inst.list.appendChild(note('读取失败：' + e.message, { danger: true }))
    }
  } finally {
    if (seq === worldsSeq) state.busy = false
  }
}

function renderWorlds(inst) {
  const list = inst.list
  if (!list) return
  clear(list)
  if (!state.mcDir) {
    list.appendChild(note('请先填写 .minecraft 目录，或点击「自动检测」'))
    return
  }
  if (!state.worlds.length) {
    list.appendChild(note('saves 目录里没有找到任何世界'))
    return
  }
  const q = inst.filter
  const rows = q
    ? state.worlds.filter((w) => `${w.levelName || ''} ${w.name || ''}`.toLowerCase().includes(q))
    : state.worlds
  if (!rows.length) {
    list.appendChild(note(`没有匹配「${q}」的世界`))
    return
  }
  for (const w of rows) list.appendChild(worldRow(inst, w))
}

function worldRow(inst, w) {
  const active = !!(state.world && state.world.path === w.path)

  const iconBox = h('div', { class: 'sw-icon' })
  if (!w.error && typeof w.icon === 'string' && /^data:image\//i.test(w.icon)) {
    const img = h('img', { src: w.icon, alt: '' })
    img.onerror = () => { clear(iconBox); iconBox.appendChild(icon('cube', { size: 15 })) }
    iconBox.appendChild(img)
  } else {
    iconBox.appendChild(icon(w.error ? 'warning' : 'cube', { size: 15 }))
  }

  const name = w.error ? w.name : (w.levelName || w.name)
  const meta = w.error
    ? '解析失败：' + w.error
    : `${GAME_TYPES[w.gameType] || '?'} · ${DIFFICULTIES[w.difficulty] || '?'} · ${w.version || '?'} · ${w.lastPlayed ? fmtAgo(w.lastPlayed) : '时间未知'}`

  const row = h('div', {
    class: 'se-world' + (active ? ' active' : ''),
    role: 'button',
    tabindex: '0',
    title: w.path || name,
    onclick: () => selectWorld(w),
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectWorld(w) }
    }
  },
    iconBox,
    h('div', { class: 'sw-main' },
      h('div', { class: 'row', style: { gap: '4px' } },
        h('span', { class: 'sw-name grow' }, name),
        w.hardcore ? badge('极限', 'bad') : null,
        !w.error && w.cheats ? badge('作弊', 'info') : null
      ),
      h('div', { class: 'sw-meta', style: w.error ? { color: 'var(--danger)' } : null }, meta)
    )
  )
  return row
}

async function selectWorld(w) {
  state.world = w
  state.worldDetail = null
  state.detailError = ''
  state.player = null
  state.playerKey = ''
  state.playerError = ''
  state.regions = null
  state.regionsDir = ''
  state.regionsFor = ''
  state.regionsError = ''
  state.regionsLoading = false
  const seq = ++detailSeq
  playerSeq++
  regionsSeq++

  for (const inst of liveInstances()) {
    renderWorlds(inst)
    renderHead(inst)
    renderPane(inst)
  }

  try {
    const r = await api.get('/api/saveeditor/world?world=' + encodeURIComponent(w.path))
    if (seq !== detailSeq) return
    if (r.error) throw new Error(r.error)
    state.worldDetail = r
    if (!state.playerKey && (r.players || []).length) state.playerKey = r.players[0].key
    for (const inst of liveInstances()) {
      syncTabs(inst)
      renderHead(inst)
      renderPane(inst)
    }
    if (state.playerKey) loadPlayer()
  } catch (e) {
    if (seq !== detailSeq) return
    state.detailError = e.message
    for (const inst of liveInstances()) renderPane(inst)
    toast('读取世界失败：' + e.message, 'err')
  }
}

function renderHead(inst) {
  const head = inst.head
  if (!head) return
  clear(head)
  const w = state.world
  if (!w) {
    head.appendChild(h('span', { class: 'muted', style: { fontSize: '12px' } }, '尚未选择世界'))
    return
  }
  const bits = [
    h('strong', { style: { fontSize: '13px' } }, w.error ? w.name : (w.levelName || w.name)),
    w.hardcore ? badge('极限', 'bad') : null,
    !w.error && w.cheats ? badge('作弊', 'info') : null,
    h('span', { class: 'spacer' }),
    h('span', {
      class: 'se-meta',
      title: w.path || '',
      style: { maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    }, w.path || '')
  ].filter(Boolean)
  head.append(...bits)
}

function syncTabs(inst) {
  for (const key of ['world', 'player', 'chunk']) {
    const tab = inst.tabBtns[key]
    if (!tab) continue
    tab.classList.toggle('active', inst.tab === key)
    if (key === 'player') {
      const n = ((state.worldDetail && state.worldDetail.players) || []).length
      clear(tab)
      tab.appendChild(document.createTextNode('玩家'))
      if (n) tab.appendChild(h('span', { class: 'count' }, String(n)))
    }
  }
}

// ---------------- 标签页内容 ----------------

function renderPane(inst) {
  renderPaneInner(inst)
  fitInstance(inst)
}

function renderPaneInner(inst) {
  const pane = inst.pane
  if (!pane) return
  syncTabs(inst)
  clear(pane)
  inst.playerBox = null

  if (!state.world) {
    pane.appendChild(emptyState(
      '尚未选择世界',
      state.worlds.length ? '在左侧选择一个存档开始编辑。' : '先设置 .minecraft 目录并读取存档列表。',
      null,
      { iconName: 'cube' }
    ))
    return
  }

  if (inst.tab === 'chunk') {
    renderChunkPane(inst, pane)
    return
  }

  if (!state.worldDetail) {
    if (state.detailError) {
      pane.appendChild(h('div', { class: 'error-state' },
        icon('warning', { size: 22, class: 'es-icon' }),
        h('div', { class: 'es-title' }, '读取世界详情失败'),
        h('div', { class: 'es-text' }, state.detailError),
        btn('重试', { size: 'sm', iconName: 'refresh', onClick: () => selectWorld(state.world) })
      ))
    } else {
      pane.appendChild(loadingLine('加载世界详情中…'))
    }
    return
  }

  if (inst.tab === 'player') renderPlayerPane(inst, pane)
  else renderWorldPane(inst, pane)
}

// ---- 世界属性 ----

function renderWorldPane(inst, pane) {
  const w = state.world
  const f = state.worldDetail.fields || {}

  pane.appendChild(hintLine('编辑前请先关闭对应的游戏 / 服务端；每次保存会自动把原文件备份到世界目录（保留最近 10 份）。'))

  const nameIn = txtInput(f.LevelName)
  const gtSel = selInput(GAME_TYPES, f.GameType)
  const dfSel = selInput(DIFFICULTIES, f.Difficulty)
  const hcChk = chkInput(f.hardcore, '极限模式')
  const acChk = chkInput(f.allowCommands, '允许作弊')
  const rainChk = chkInput(f.raining, '下雨')
  const thunChk = chkInput(f.thundering, '雷暴')
  const sxIn = numInput(f.SpawnX)
  const syIn = numInput(f.SpawnY)
  const szIn = numInput(f.SpawnZ)
  const timeIn = numInput(f.Time)
  const dayIn = numInput(f.DayTime)
  const bsizeIn = numInput(f.BorderSize)

  pane.appendChild(h('div', { class: 'se-grid' },
    field('世界名称', nameIn, { class: 'span-2' }),
    field('游戏模式', gtSel),
    field('难度', dfSel),
    field('出生点 X', sxIn),
    field('出生点 Y', syIn),
    field('出生点 Z', szIn),
    field('游戏刻（Time）', timeIn),
    field('白天刻（DayTime）', dayIn),
    field('世界边界大小', bsizeIn)
  ))

  pane.appendChild(h('div', { class: 'se-checks' }, hcChk, acChk, rainChk, thunChk))

  pane.appendChild(h('div', { class: 'se-meta' },
    `版本 ${w.version || '?'} · 上次游玩 ${w.lastPlayed ? fmtDateTime(w.lastPlayed) : '未知'} · 种子 ${w.seed || '?'}`))

  const btnSave = btn('保存世界属性', {
    size: 'sm',
    variant: 'primary',
    iconName: 'save',
    onClick: async () => {
      const edits = {
        LevelName: nameIn.value,
        GameType: Number(gtSel.value),
        Difficulty: Number(dfSel.value),
        hardcore: hcChk._input.checked,
        allowCommands: acChk._input.checked,
        raining: rainChk._input.checked,
        thundering: thunChk._input.checked,
        SpawnX: Number(sxIn.value) || 0,
        SpawnY: Number(syIn.value) || 0,
        SpawnZ: Number(szIn.value) || 0,
        Time: timeIn.value === '' ? undefined : (timeIn.value.includes('e') ? Number(timeIn.value) : timeIn.value),
        DayTime: dayIn.value === '' ? undefined : dayIn.value,
        BorderSize: bsizeIn.value === '' ? undefined : Number(bsizeIn.value)
      }
      for (const k of Object.keys(edits)) if (edits[k] === undefined) delete edits[k]
      btnSave.disabled = true
      try {
        const r = await api.post('/api/saveeditor/level', { world: state.world.path, edits })
        if (r.error) throw new Error(r.error)
        toast('世界属性已保存（备份：' + playerBackupName(r.backup) + '）', 'ok')
        loadWorlds()
      } catch (e) {
        toast('保存失败：' + e.message, 'err')
      } finally {
        btnSave.disabled = false
      }
    }
  })

  const btnChunk = btn('区块编辑', {
    size: 'sm',
    iconName: 'grid',
    onClick: () => { if (inst.ctx && state.world) openChunkEditor(inst.ctx, state.world) }
  })

  pane.appendChild(h('div', { class: 'se-savebar' },
    btnSave,
    btnChunk,
    h('span', { class: 'spacer' }),
    h('span', { class: 'se-meta' }, '自动备份 · 最近 10 份')
  ))
}

// ---- 玩家数据 ----

function renderPlayerPane(inst, pane) {
  pane.appendChild(hintLine('编辑前请先关闭对应的游戏 / 服务端；每次保存会自动把原文件备份到世界目录（保留最近 10 份）。'))

  const players = state.worldDetail.players || []
  if (!players.length) {
    pane.appendChild(h('div', { class: 'muted', style: { fontSize: '12px' } }, '这个存档没有玩家数据。'))
    return
  }

  const chips = h('div', { class: 'se-player-chips' })
  for (const p of players) {
    const active = p.key === state.playerKey
    chips.appendChild(h('button', {
      class: 'btn btn-sm' + (active ? ' active' : ''),
      type: 'button',
      title: p.key,
      onclick: () => {
        if (state.playerKey === p.key) return
        state.playerKey = p.key
        state.player = null
        state.playerError = ''
        renderPane(inst)
        loadPlayer()
      }
    }, p.label))
  }
  pane.appendChild(chips)

  const box = h('div', { class: 'col', style: { gap: '8px' } })
  inst.playerBox = box
  pane.appendChild(box)
  renderPlayerBox(inst)
}

function renderPlayerBox(inst) {
  const box = inst.playerBox
  if (!box) return
  clear(box)
  if (state.player) {
    renderPlayerInto(inst, box)
  } else if (state.playerError) {
    box.appendChild(h('div', { class: 'muted', style: { color: 'var(--danger)', fontSize: '12px' } },
      '读取失败：' + state.playerError))
  } else {
    box.appendChild(loadingLine('加载玩家数据中…'))
  }
  fitInstance(inst)
}

function renderPlayerInto(inst, box) {
  const p = state.player
  const f = p.fields || {}

  const hpIn = numInput(f.Health, { step: '0.5' })
  const mhIn = numInput(p.maxHealth, { step: '1' })
  const foodIn = numInput(f.foodLevel)
  const satIn = numInput(f.foodSaturationLevel, { step: '0.5' })
  const xpLvlIn = numInput(f.XpLevel)
  const xpTotalIn = numInput(f.XpTotal)
  const gtSel = selInput(GAME_TYPES, f.playerGameType)
  const pxIn = numInput(f.PosX, { step: '0.5' })
  const pyIn = numInput(f.PosY, { step: '0.5' })
  const pzIn = numInput(f.PosZ, { step: '0.5' })
  const yawIn = numInput(f.RotationYaw)
  const pitchIn = numInput(f.RotationPitch)
  const flyChk = chkInput(f.mayfly, '允许飞行')
  const invChk = chkInput(f.invulnerable, '无敌')

  box.appendChild(h('div', { class: 'se-grid' },
    field('生命值（当前 ' + p.healthLabel + '）', hpIn),
    field('生命上限', mhIn),
    field('饥饿值', foodIn),
    field('饱和度', satIn),
    field('经验等级', xpLvlIn),
    field('经验总量', xpTotalIn),
    field('游戏模式', gtSel),
    h('div', { class: 'se-checks', style: { gridColumn: '1 / -1' } }, flyChk, invChk),
    field('坐标 X', pxIn),
    field('坐标 Y', pyIn),
    field('坐标 Z', pzIn),
    field('视角 Yaw', yawIn),
    field('视角 Pitch', pitchIn)
  ))

  // 背包（只读预览）
  const inv = p.inventory || []
  box.appendChild(h('div', { class: 'se-meta' },
    `背包（只读预览）：${inv.length} 组 / 共 ${p.inventoryCount || 0} 件`))
  if (inv.length) {
    const gridInv = h('div', { class: 'se-inv' })
    for (const it of inv.slice(0, 36)) {
      gridInv.appendChild(h('div', { class: 'se-inv-row', title: it.id || '(未知)' },
        h('span', { class: 'slot' }, '#' + it.slot),
        h('span', { class: 'id' }, it.id || '(未知)'),
        h('span', { class: 'count' }, '×' + it.count)
      ))
    }
    box.appendChild(gridInv)
  }

  const btnSave = btn('保存玩家数据', {
    size: 'sm',
    variant: 'primary',
    iconName: 'save',
    onClick: async () => {
      const edits = {
        Health: Number(hpIn.value),
        maxHealth: Number(mhIn.value),
        foodLevel: Number(foodIn.value),
        foodSaturationLevel: Number(satIn.value),
        XpLevel: Number(xpLvlIn.value) || 0,
        XpTotal: Number(xpTotalIn.value) || 0,
        playerGameType: Number(gtSel.value),
        PosX: Number(pxIn.value) || 0,
        PosY: Number(pyIn.value) || 0,
        PosZ: Number(pzIn.value) || 0,
        RotationYaw: Number(yawIn.value) || 0,
        RotationPitch: Number(pitchIn.value) || 0,
        mayfly: flyChk._input.checked,
        invulnerable: invChk._input.checked
      }
      const ok = inst.ctx
        ? await inst.ctx.confirm('将写入玩家数据并自动备份原文件，继续？', { danger: true, okText: '保存' })
        : false
      if (!ok) return
      btnSave.disabled = true
      try {
        const r = await api.post('/api/saveeditor/player', { world: state.world.path, player: state.playerKey, edits })
        if (r.error) throw new Error(r.error)
        toast('玩家数据已保存（备份：' + playerBackupName(r.backup) + '）', 'ok')
        loadPlayer()
      } catch (e) {
        toast('保存失败：' + e.message, 'err')
      } finally {
        btnSave.disabled = false
      }
    }
  })

  box.appendChild(h('div', { class: 'se-savebar' },
    btnSave,
    h('span', { class: 'spacer' }),
    h('span', { class: 'se-meta' }, '自动备份 · 最近 10 份')
  ))
}

async function loadPlayer() {
  if (!state.world || !state.playerKey) return
  const seq = ++playerSeq
  try {
    const r = await api.get('/api/saveeditor/player?world=' + encodeURIComponent(state.world.path) + '&player=' + encodeURIComponent(state.playerKey))
    if (seq !== playerSeq) return
    if (r.error) throw new Error(r.error)
    state.player = r
    state.playerError = ''
    for (const inst of liveInstances()) if (inst.tab === 'player') renderPlayerBox(inst)
  } catch (e) {
    if (seq !== playerSeq) return
    state.player = null
    state.playerError = e.message
    for (const inst of liveInstances()) if (inst.tab === 'player') renderPlayerBox(inst)
  }
}

// ---- 区块入口 ----

function renderChunkPane(inst, pane) {
  pane.appendChild(hintLine('编辑前请先关闭对应的游戏 / 服务端；首次替换会自动备份 .mca 文件（保留最近 10 份）。'))

  const box = h('div', { class: 'col', style: { gap: '8px' } })
  pane.appendChild(box)

  if (state.regionsLoading) {
    box.appendChild(loadingLine('正在读取区域文件…'))
  } else if (state.regionsError) {
    box.appendChild(h('div', { class: 'muted', style: { color: 'var(--danger)', fontSize: '12px' } },
      '读取失败：' + state.regionsError))
  } else if (!state.regions) {
    box.appendChild(loadingLine('正在读取区域文件…'))
    ensureRegions(inst)
  } else if (!state.regions.length) {
    box.appendChild(h('div', { class: 'muted', style: { fontSize: '12px' } },
      '这个世界的 region 目录里没有区域文件（还没有生成过地形）。'))
  } else {
    const items = state.regions
    const total = items.reduce((sum, it) => sum + (Number(it.size) || 0), 0)
    box.appendChild(h('div', { class: 'row wrap', style: { gap: '6px' } },
      badge(items.length + ' 个区域文件', 'accent'),
      h('span', { class: 'se-meta' }, `${(total / 1024 / 1024).toFixed(1)} MB`)
    ))
    const chips = h('div', { class: 'row wrap', style: { gap: '4px', maxHeight: '76px', overflow: 'auto' } })
    for (const it of items.slice(0, 12)) {
      chips.appendChild(h('span', { class: 'pill', title: it.name },
        `${it.name} · ${Math.round((Number(it.size) || 0) / 1024)} KB`))
    }
    if (items.length > 12) chips.appendChild(h('span', { class: 'muted', style: { fontSize: '11px' } }, `… 另有 ${items.length - 12} 个`))
    box.appendChild(chips)
    if (state.regionsDir) box.appendChild(h('div', { class: 'se-meta', style: { overflowWrap: 'anywhere' } }, '目录：' + state.regionsDir))
  }

  const btnOpenEditor = btn('打开图形区块编辑器', {
    size: 'sm',
    variant: 'primary',
    iconName: 'grid',
    onClick: () => { if (inst.ctx && state.world) openChunkEditor(inst.ctx, state.world) }
  })
  const btnReload = btn('刷新区域文件', {
    size: 'sm',
    iconName: 'refresh',
    onClick: () => {
      regionsSeq++
      state.regions = null
      state.regionsError = ''
      state.regionsFor = ''
      state.regionsLoading = false
      renderPane(inst)
    }
  })
  box.appendChild(h('div', { class: 'se-savebar' }, btnOpenEditor, btnReload))
  box.appendChild(h('div', { class: 'se-meta' },
    '区域分布 32×32、区块俯视 16×16，可点选方块并批量替换；也可在「世界」标签页打开同一编辑器。'))
}

async function ensureRegions(inst) {
  const w = state.world
  if (!w || state.regionsLoading) return
  if (state.regionsFor === w.path && (state.regions || state.regionsError)) return
  const seq = ++regionsSeq
  const worldPath = w.path
  state.regionsFor = worldPath
  state.regions = null
  state.regionsError = ''
  state.regionsLoading = true
  try {
    const r = await api.get('/api/saveeditor/regions?world=' + encodeURIComponent(worldPath))
    if (seq !== regionsSeq) return
    if (r.error) throw new Error(r.error)
    state.regions = r.items || []
    state.regionsDir = r.dir || ''
  } catch (e) {
    if (seq !== regionsSeq) return
    state.regions = null
    state.regionsError = e.message
  } finally {
    if (seq === regionsSeq) {
      state.regionsLoading = false
      for (const i of liveInstances()) if (i.tab === 'chunk') renderPane(i)
    }
  }
}
