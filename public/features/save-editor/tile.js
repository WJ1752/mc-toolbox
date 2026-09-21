import { h, clear, fmtDateTime, fmtAgo } from '/js/core/dom.js'
import { api } from '/js/core/api.js'
import { toast } from '/js/core/toast.js'
import { pickDir } from '/js/core/dirpicker.js'
import { openChunkEditor } from './chunk-editor.js'

let ctxRef = null
let rootEl = null

const state = {
  mcDir: '',
  worlds: [],
  world: null,        // 选中的世界 summary
  worldDetail: null,  // /api/saveeditor/world 返回
  playerKey: '',
  player: null,       // /api/saveeditor/player 返回
  busy: false
}

const GAME_TYPES = ['生存', '创造', '冒险', '旁观']
const DIFFICULTIES = ['和平', '简单', '普通', '困难']

export default {
  renderExpanded(container, { ctx } = {}) {
    ctxRef = ctx
    buildInto(container)
  },
  async mount(ctx) {
    ctxRef = ctx
    const s = ctx.settings()
    state.mcDir = (s.saveEditor && s.saveEditor.mcDir) || ''
    buildInto(ctx.body)
  }
}

// ---------------- 构建 UI ----------------

function buildInto(container) {
  clear(container)
  rootEl = container

  // 目录行
  const dirInput = h('input', { class: 'input mono', placeholder: '.minecraft 目录（例如 C:\\Users\\你\\AppData\\Roaming\\.minecraft）', value: state.mcDir })
  dirInput.onchange = () => { state.mcDir = dirInput.value.trim() }
  const btnDetect = h('button', { class: 'btn btn-sm', onclick: detectDir, disabled: state.busy }, '自动检测')
  const btnBrowse = h('button', { class: 'btn btn-sm', onclick: async () => {
    const p = await pickDir(state.mcDir)
    if (p) { dirInput.value = p; state.mcDir = p; saveDir(); loadWorlds() }
  } }, '浏览')
  const btnLoad = h('button', { class: 'btn btn-sm btn-primary', onclick: () => { state.mcDir = dirInput.value.trim(); saveDir(); loadWorlds() } }, '读取存档')
  const btnOpen = h('button', { class: 'btn btn-sm', onclick: openDir, disabled: !state.mcDir }, '📂')

  container.appendChild(h('div', { class: 'field' },
    h('label', {}, '.minecraft 目录'),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, dirInput), btnDetect, btnBrowse, btnOpen, btnLoad)))

  // 工具行
  const refreshBtn = h('button', { class: 'btn btn-sm', onclick: loadWorlds, disabled: state.busy }, '↻ 刷新')
  container.appendChild(h('div', { class: 'row wrap', style: { alignItems: 'center' } },
    refreshBtn,
    h('span', { class: 'spacer' }),
    h('span', { class: 'muted' }, state.world ? '已选中：' + (state.world.levelName || state.world.name) : '尚未选择世界')))

  // 世界列表
  const worldList = h('div', { class: 'scroll-y', style: { maxHeight: '180px', border: '1px solid var(--line)', borderRadius: '8px', padding: '6px' } })
  worldList.dataset.role = 'worlds'
  container.appendChild(worldList)

  // 编辑区
  const editor = h('div', { class: 'scroll-y', style: { maxHeight: '420px', display: state.world ? '' : 'none', flexDirection: 'column', gap: '10px' } })
  editor.dataset.role = 'editor'
  container.appendChild(editor)

  restore(worldList, editor)
  if (state.mcDir && !state.worlds.length) loadWorlds()
  else renderWorlds(worldList)

  function restore(list, ed) {
    state._list = list
    state._editor = ed
    if (state.world) renderEditor(ed)
  }

  async function detectDir() {
    try {
      const r = await api.get('/api/saveeditor/presets')
      if (!r.items || !r.items.length) { toast('未在默认位置找到 .minecraft，请手动浏览选择', 'warn'); return }
      state.mcDir = r.items[0].path
      dirInput.value = state.mcDir
      saveDir()
      toast('已找到：' + state.mcDir, 'ok')
      loadWorlds()
    } catch (e) { toast('检测失败：' + e.message, 'err') }
  }

  async function openDir() {
    if (!state.mcDir) return
    try { await api.post('/api/fs/open', { path: state.mcDir }) } catch (e) { toast(e.message, 'err') }
  }

  function saveDir() {
    api.put('/api/settings', { saveEditor: { mcDir: state.mcDir } }).catch(() => {})
    try { if (ctxRef.settings().saveEditor) ctxRef.settings().saveEditor.mcDir = state.mcDir } catch {}
    btnOpen.disabled = !state.mcDir
  }
}

// ---------------- 世界列表 ----------------

async function loadWorlds() {
  const list = state._list
  if (!state.mcDir) { toast('请先填写 .minecraft 目录', 'warn'); return }
  state.busy = true
  clear(list)
  list.appendChild(h('div', { class: 'muted', style: { padding: '8px' } }, '读取中…'))
  try {
    const r = await api.get('/api/saveeditor/worlds?mcDir=' + encodeURIComponent(state.mcDir))
    if (r.error) throw new Error(r.error)
    state.worlds = r.worlds || []
    if (!state.worlds.length) {
      clear(list)
      list.appendChild(h('div', { class: 'muted', style: { padding: '8px' } }, 'saves 目录里没有找到任何世界'))
    }
    renderWorlds(list)
  } catch (e) {
    clear(list)
    list.appendChild(h('div', { class: 'muted', style: { padding: '8px', color: 'var(--danger)' } }, '读取失败：' + e.message))
  } finally {
    state.busy = false
  }
}

function renderWorlds(list) {
  clear(list)
  for (const w of state.worlds) {
    const selected = state.world && state.world.path === w.path
    const row = h('div', {
      class: 'mod-row' + (selected ? ' active' : ''),
      style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '8px', cursor: 'pointer',
        background: selected ? 'color-mix(in srgb, var(--accent) 15%, transparent)' : '' },
      onclick: () => selectWorld(w, list)
    },
      h('div', { class: 'grow', style: { minWidth: 0 } },
        h('div', {}, h('strong', {}, w.error ? w.name : (w.levelName || w.name)),
          w.error ? '' : ' ',
          w.hardcore ? h('span', { class: 'badge bad' }, '极限') : null,
          w.cheats && !w.error ? h('span', { class: 'badge info' }, '作弊') : null),
        w.error
          ? h('div', { class: 'muted' }, '解析失败：' + w.error)
          : h('div', { class: 'muted', style: { fontSize: '12px' } },
            `${GAME_TYPES[w.gameType] || '?'} · ${DIFFICULTIES[w.difficulty] || '?'} · ${w.version} · ${w.lastPlayed ? fmtAgo(w.lastPlayed) : '时间未知'}`)))
    list.appendChild(row)
  }
}

async function selectWorld(w, list) {
  state.world = w
  state.worldDetail = null
  state.player = null
  state.playerKey = ''
  renderWorlds(list)
  renderEditor(state._editor)
  try {
    const r = await api.get('/api/saveeditor/world?world=' + encodeURIComponent(w.path))
    if (r.error) throw new Error(r.error)
    state.worldDetail = r
    if (!state.playerKey && (r.players || []).length) state.playerKey = r.players[0].key
    renderEditor(state._editor)
    if (state.playerKey) loadPlayer()
  } catch (e) {
    toast('读取世界失败：' + e.message, 'err')
  }
}

// ---------------- 编辑面板 ----------------

function fieldRow(label, input) {
  return h('div', { class: 'field' }, h('label', {}, label), input)
}

function numInput(value, { step = '1' } = {}) {
  return h('input', { class: 'input', type: 'number', step, value: value === null || value === undefined ? '' : value })
}

function txtInput(value) {
  return h('input', { class: 'input', value: value ?? '' })
}

function selInput(options, value) {
  const s = h('select', { class: 'input' })
  options.forEach((label, i) => s.appendChild(h('option', { value: String(i) }, label)))
  s.value = String(value ?? 0)
  return s
}

function chkInput(value, label) {
  const c = h('input', { class: 'checkbox', type: 'checkbox' })
  c.checked = !!value
  const wrap = h('label', { class: 'row', style: { alignItems: 'center', gap: '6px', margin: 0 } }, c, h('span', {}, label))
  wrap._input = c
  return wrap
}

function renderEditor(ed) {
  clear(ed)
  if (!state.world) { ed.style.display = 'none'; return }
  ed.style.display = 'flex'

  ed.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
    '⚠️ 编辑前请先关闭对应的游戏 / 服务端；每次保存会自动把原文件备份到世界目录（保留最近 10 份）。'))

  if (!state.worldDetail) {
    ed.appendChild(h('div', { class: 'muted' }, '加载世界详情中…'))
    return
  }

  const f = state.worldDetail.fields || {}

  // ---- 世界属性 ----
  ed.appendChild(h('div', { class: 'hr' }))
  ed.appendChild(h('strong', {}, '世界属性'))

  const nameIn = txtInput(f.LevelName)
  const gtSel = selInput(GAME_TYPES, f.GameType)
  const dfSel = selInput(DIFFICULTIES, f.Difficulty)
  const hcChk = chkInput(f.hardcore, '极限模式')
  const acChk = chkInput(f.allowCommands, '允许作弊')
  const rainChk = chkInput(f.raining, '下雨')
  const thunChk = chkInput(f.thundering, '雷暴')
  const sxIn = numInput(f.SpawnX), syIn = numInput(f.SpawnY), szIn = numInput(f.SpawnZ)
  const timeIn = numInput(f.Time), dayIn = numInput(f.DayTime)
  const bsizeIn = numInput(f.BorderSize, { step: '1' })

  const grid = h('div', { class: 'grid', style: { gridTemplateColumns: '1fr 1fr', gap: '8px' } })
  grid.appendChild(h('div', { class: 'field', style: { gridColumn: '1 / -1' } }, h('label', {}, '世界名称'), nameIn))
  grid.appendChild(fieldRow('游戏模式', gtSel))
  grid.appendChild(fieldRow('难度', dfSel))
  grid.appendChild(fieldRow('出生点 X', sxIn))
  grid.appendChild(fieldRow('出生点 Y', syIn))
  grid.appendChild(fieldRow('出生点 Z', szIn))
  grid.appendChild(fieldRow('游戏刻（Time）', timeIn))
  grid.appendChild(fieldRow('白天刻（DayTime）', dayIn))
  grid.appendChild(fieldRow('世界边界大小', bsizeIn))
  grid.appendChild(h('div', { class: 'row wrap', style: { alignItems: 'center', gap: '12px' } },
    hcChk, acChk, rainChk, thunChk))
  ed.appendChild(grid)

  const info = h('div', { class: 'muted', style: { fontSize: '12px' } },
    `版本 ${state.world.version || '?'} · 上次游玩 ${state.world.lastPlayed ? fmtDateTime(state.world.lastPlayed) : '未知'} · 种子 ${state.world.seed || '?'}`)
  ed.appendChild(info)

  const btnSaveWorld = h('button', {
    class: 'btn btn-sm btn-primary',
    onclick: async () => {
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
      btnSaveWorld.disabled = true
      try {
        const r = await api.post('/api/saveeditor/level', { world: state.world.path, edits })
        if (r.error) throw new Error(r.error)
        toast('世界属性已保存（备份：' + r.backup.split(/[\\/]/).pop() + '）', 'ok')
        loadWorlds()
      } catch (e) { toast('保存失败：' + e.message, 'err') } finally { btnSaveWorld.disabled = false }
    }
  }, '💾 保存世界属性')
  ed.appendChild(h('div', { class: 'row' }, btnSaveWorld,
    h('button', { class: 'btn btn-sm', onclick: () => openChunkEditor(ctxRef, state.world) }, '🗺 区块编辑（图形化）')))

  // ---- 玩家数据 ----
  ed.appendChild(h('div', { class: 'hr' }))
  ed.appendChild(h('strong', {}, '玩家数据'))

  const players = state.worldDetail.players || []
  if (!players.length) {
    ed.appendChild(h('div', { class: 'muted' }, '这个存档没有玩家数据。'))
    return
  }
  const chips = h('div', { class: 'row wrap' })
  for (const p of players) {
    chips.appendChild(h('button', {
      class: 'btn btn-sm' + (p.key === state.playerKey ? ' active' : ''),
      onclick: () => { state.playerKey = p.key; renderEditor(ed); loadPlayer() }
    }, p.label))
  }
  ed.appendChild(chips)

  const playerBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } })
  playerBox.dataset.role = 'player'
  ed.appendChild(playerBox)
  if (state.player) renderPlayer(playerBox)
  else playerBox.appendChild(h('div', { class: 'muted' }, '加载玩家数据中…'))
}

function renderPlayer(box) {
  clear(box)
  const p = state.player
  const f = p.fields || {}

  const hpIn = numInput(f.Health, { step: '0.5' })
  const mhIn = numInput(p.maxHealth, { step: '1' })
  const foodIn = numInput(f.foodLevel)
  const satIn = numInput(f.foodSaturationLevel, { step: '0.5' })
  const xpLvlIn = numInput(f.XpLevel)
  const xpTotalIn = numInput(f.XpTotal)
  const gtSel = selInput(GAME_TYPES, f.playerGameType)
  const pxIn = numInput(f.PosX, { step: '0.5' }), pyIn = numInput(f.PosY, { step: '0.5' }), pzIn = numInput(f.PosZ, { step: '0.5' })
  const yawIn = numInput(f.RotationYaw), pitchIn = numInput(f.RotationPitch)
  const flyChk = chkInput(f.mayfly, '允许飞行')
  const invChk = chkInput(f.invulnerable, '无敌')

  const grid = h('div', { class: 'grid', style: { gridTemplateColumns: '1fr 1fr', gap: '8px' } })
  grid.appendChild(fieldRow('生命值（当前 ' + p.healthLabel + '）', hpIn))
  grid.appendChild(fieldRow('生命上限', mhIn))
  grid.appendChild(fieldRow('饥饿值', foodIn))
  grid.appendChild(fieldRow('饱和度', satIn))
  grid.appendChild(fieldRow('经验等级', xpLvlIn))
  grid.appendChild(fieldRow('经验总量', xpTotalIn))
  grid.appendChild(fieldRow('游戏模式', gtSel))
  grid.appendChild(h('div', { class: 'row wrap', style: { alignItems: 'center', gap: '12px' } }, flyChk, invChk))
  grid.appendChild(fieldRow('坐标 X', pxIn))
  grid.appendChild(fieldRow('坐标 Y', pyIn))
  grid.appendChild(fieldRow('坐标 Z', pzIn))
  grid.appendChild(fieldRow('视角 Yaw', yawIn))
  grid.appendChild(fieldRow('视角 Pitch', pitchIn))
  box.appendChild(grid)

  // 背包（只读预览）
  box.appendChild(h('div', { class: 'muted', style: { fontSize: '12.5px' } },
    `背包（只读预览）：${(p.inventory || []).length} 组 / 共 ${p.inventoryCount || 0} 件`))
  if ((p.inventory || []).length) {
    const list = h('div', { class: 'scroll-y', style: { maxHeight: '110px', border: '1px solid var(--line)', borderRadius: '8px', padding: '6px', fontSize: '12px' } })
    for (const it of p.inventory.slice(0, 36)) {
      list.appendChild(h('div', { class: 'row', style: { gap: '8px' } },
        h('span', { class: 'badge' }, '#' + it.slot),
        h('span', { class: 'grow' }, it.id || '(未知)'),
        h('span', { class: 'muted' }, '×' + it.count)))
    }
    box.appendChild(list)
  }

  const btnSave = h('button', {
    class: 'btn btn-sm btn-primary',
    onclick: async () => {
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
      const ok = await ctxRef.confirm('将写入玩家数据并自动备份原文件，继续？', { danger: true, okText: '保存' })
      if (!ok) return
      btnSave.disabled = true
      try {
        const r = await api.post('/api/saveeditor/player', { world: state.world.path, player: state.playerKey, edits })
        if (r.error) throw new Error(r.error)
        toast('玩家数据已保存（备份：' + r.backup.split(/[\\/]/).pop() + '）', 'ok')
        loadPlayer()
      } catch (e) { toast('保存失败：' + e.message, 'err') } finally { btnSave.disabled = false }
    }
  }, '💾 保存玩家数据')
  box.appendChild(h('div', { class: 'row' }, btnSave))
}

async function loadPlayer() {
  const box = (state._editor && state._editor.querySelector('[data-role=player]')) || null
  if (!state.world || !state.playerKey) return
  try {
    const r = await api.get('/api/saveeditor/player?world=' + encodeURIComponent(state.world.path) + '&player=' + encodeURIComponent(state.playerKey))
    if (r.error) throw new Error(r.error)
    state.player = r
    if (box) renderPlayer(box)
    else if (state.worldDetail) renderEditor(state._editor)
  } catch (e) {
    state.player = null
    if (box) { clear(box); box.appendChild(h('div', { class: 'muted', style: { color: 'var(--danger)' } }, '读取失败：' + e.message)) }
  }
}
