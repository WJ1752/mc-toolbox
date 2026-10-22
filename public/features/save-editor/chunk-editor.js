// 区块编辑器（图形化，全屏放大视图）
// 区域文件 → 32×32 区块存在图 → 16×16 俯视彩色地图 → 点选列替换方块。
// 两张地图都支持缩放（按钮 / 滚轮）与拖拽平移，点击坐标经逆变换换算，缩放后仍精确。
import { h, clear, escapeHtml } from '/js/core/dom.js'
import { api } from '/js/core/api.js'
import { toast } from '/js/core/toast.js'
import { btn, iconBtn, input } from '/js/ui/kit.js'

// 常见方块的展示色（俯视地图）；未收录的按名字哈希取稳定色
const BLOCK_COLORS = {
  'minecraft:air': '#000000',
  'minecraft:stone': '#7f7f7f', 'minecraft:deepslate': '#4a4a52', 'minecraft:cobblestone': '#828282',
  'minecraft:dirt': '#8b5a2b', 'minecraft:coarse_dirt': '#7a4f26', 'minecraft:grass_block': '#5d9c3c',
  'minecraft:sand': '#dbcf9c', 'minecraft:red_sand': '#bf6f27', 'minecraft:gravel': '#9a9a9a',
  'minecraft:water': '#3357d5', 'minecraft:lava': '#e25822', 'minecraft:ice': '#9cc6f5',
  'minecraft:oak_leaves': '#3e7a25', 'minecraft:birch_leaves': '#6f9c46', 'minecraft:spruce_leaves': '#2e5c33',
  'minecraft:oak_log': '#6b511f', 'minecraft:bedrock': '#333333',
  'minecraft:oak_planks': '#a8824e', 'minecraft:glass': '#c8e8f0', 'minecraft:snow': '#f0fafa',
  'minecraft:snow_block': '#f0fafa', 'minecraft:clay': '#a0a6b4', 'minecraft:netherrack': '#6b2c2c',
  'minecraft:end_stone': '#dbdf9e', 'minecraft:obsidian': '#1a1024',
  'minecraft:diamond_ore': '#7fd4d4', 'minecraft:iron_ore': '#c8a288', 'minecraft:gold_ore': '#d4af37',
  'minecraft:coal_ore': '#3a3a3a', 'minecraft:redstone_ore': '#a03030', 'minecraft:lapis_ore': '#2c5c9e',
  'minecraft:copper_ore': '#c07050', 'minecraft:emerald_ore': '#3cc458',
  'minecraft:glowstone': '#f5d76e', 'minecraft:white_concrete': '#cfd5d6', 'minecraft:bricks': '#96574a',
  'minecraft:podzol': '#5c3f1e', 'minecraft:mycelium': '#7a6f77', 'minecraft:moss_block': '#58802a'
}

function colorOf(name) {
  if (BLOCK_COLORS[name]) return BLOCK_COLORS[name]
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  const hue = ((hash % 360) + 360) % 360
  return `hsl(${hue} 42% 46%)`
}

function shortName(name) { return String(name || '').replace(/^minecraft:/, '') }

const COMMON_BLOCKS = [
  'minecraft:air', 'minecraft:stone', 'minecraft:deepslate', 'minecraft:dirt', 'minecraft:grass_block',
  'minecraft:cobblestone', 'minecraft:oak_planks', 'minecraft:glass', 'minecraft:water', 'minecraft:lava',
  'minecraft:sand', 'minecraft:gravel', 'minecraft:glowstone', 'minecraft:white_concrete', 'minecraft:bricks',
  'minecraft:obsidian', 'minecraft:oak_log', 'minecraft:oak_leaves', 'minecraft:bedrock', 'minecraft:iron_block',
  'minecraft:gold_block', 'minecraft:diamond_block', 'minecraft:copper_block'
]

const CELL = 12      // 区域存在图格子尺寸
const PX = 24        // 区块俯视图格子尺寸
const REGION_W = 32 * CELL
const REGION_H = 32 * CELL
const CHUNK_W = 16 * PX
const CHUNK_H = 16 * PX

let editorSeq = 0

/**
 * 打开图形化区块编辑器（全屏大弹窗）。
 * @param {object} ctx feature context（openModal / confirm）
 * @param {{path:string,name?:string,levelName?:string}} world
 */
export function openChunkEditor(ctx, world) {
  const st = {
    world,
    regions: [],
    file: '',
    bitmap: null,
    detail: null,
    picked: null,
    selChunk: null,
    busy: false
  }

  // 请求序号：快速切换区域 / 区块时丢弃过期响应
  let regionsSeq = 0
  let bitmapSeq = 0
  let chunkSeq = 0

  const dlId = 'seBlocks' + (++editorSeq)
  const body = h('div', { class: 'col', style: { gap: '10px' } })
  const modal = ctx.openModal({
    title: '区块编辑 — ' + (world.levelName || world.name),
    size: 'xl',
    class: 'ce-fullscreen',
    body
  })
  // 全屏放大：宽高吃满窗口，内容区内部滚动
  try {
    modal.panel.style.width = 'min(1260px, 97vw)'
    modal.panel.style.height = 'min(94vh, 1040px)'
    modal.panel.style.maxHeight = '94vh'
    modal.body.style.padding = '12px 14px'
  } catch {}

  // ---------------- 顶部：区域文件 ----------------
  const regionSel = h('select', { class: 'input', 'aria-label': '区域文件' })
  regionSel.style.width = '300px'
  const statusEl = h('div', { class: 'ce-status' }, '读取区域文件中…')
  const btnReloadRegions = iconBtn('refresh', { label: '重新读取区域文件', size: 14, onClick: () => loadRegions() })

  const toolbar = h('div', { class: 'ce-toolbar' },
    h('div', { class: 'field', style: { minWidth: '240px' } },
      h('label', {}, '区域文件（region/*.mca）'),
      regionSel
    ),
    btnReloadRegions,
    h('span', { class: 'spacer' }),
    statusEl
  )

  // ---------------- 地图 ----------------
  const regionMap = createMap({
    baseW: REGION_W,
    baseH: REGION_H,
    title: '区域区块分布（32×32）',
    ariaLabel: '区域区块分布图，点击已生成区块打开俯视图',
    draw: paintRegion,
    onPick: (p) => {
      const cx = Math.floor(p.x / CELL)
      const cz = Math.floor(p.y / CELL)
      if (cx < 0 || cx > 31 || cz < 0 || cz > 31) return
      if (!st.bitmap) return
      if (!st.bitmap[cz * 32 + cx]) { toast('这个区块还没有生成', 'warn'); return }
      loadChunk(cx, cz)
    }
  })

  const chunkMap = createMap({
    baseW: CHUNK_W,
    baseH: CHUNK_H,
    title: '区块俯视图（顶层方块）',
    ariaLabel: '区块俯视图，点击格子拾取方块',
    draw: paintChunk,
    onPick: (p) => {
      if (!st.detail) return
      const x = Math.floor(p.x / PX)
      const z = Math.floor(p.y / PX)
      if (x < 0 || x > 15 || z < 0 || z > 15) return
      const col = st.detail.top[z * 16 + x]
      if (!col) return
      st.picked = col
      if (!fromIn.value) fromIn.value = col.name
      renderPick()
      chunkMap.redraw()
    }
  })

  const bitFoot = h('div', { class: 'ce-status' }, '尚未读取区域文件')
  const chunkFoot = h('div', { class: 'ce-status' }, '点击左侧绿色区块以打开俯视图。')
  const legend = h('div', { class: 'ce-legend' })

  regionMap.wrap.appendChild(bitFoot)
  chunkMap.wrap.appendChild(legend)
  chunkMap.wrap.appendChild(chunkFoot)

  const maps = h('div', { class: 'ce-maps' }, regionMap.wrap, chunkMap.wrap)
  const pickEl = h('div', { class: 'ce-pick' })

  // ---------------- 批量替换 ----------------
  const fromIn = input({ mono: true, placeholder: '原方块（点击俯视图自动填入）' })
  const toIn = input({ mono: true, placeholder: '新方块，如 minecraft:air' })
  toIn.setAttribute('list', dlId)
  const datalist = h('datalist', { id: dlId })
  for (const b of COMMON_BLOCKS) datalist.appendChild(h('option', { value: b }))

  const allChk = h('input', { type: 'checkbox' })
  const progressEl = h('span', { class: 'ce-status' }, '')
  const btnGo = btn('执行替换', { size: 'sm', variant: 'danger', iconName: 'swap', onClick: doReplace })

  const batchSection = h('div', { class: 'ce-section' },
    h('label', {}, '批量替换（先点俯视图拾取“原方块”，或手动输入）'),
    h('div', { class: 'row wrap', style: { gap: '6px', alignItems: 'flex-end' } },
      h('div', { class: 'field grow', style: { minWidth: '190px' } }, h('label', {}, '原方块'), fromIn),
      h('span', { class: 'muted', style: { paddingBottom: '7px' } }, '→'),
      h('div', { class: 'field grow', style: { minWidth: '190px' } }, h('label', {}, '新方块'), toIn),
      btnGo
    ),
    h('label', { class: 'row', style: { gap: '6px', alignItems: 'center', cursor: 'pointer' } },
      allChk,
      h('span', { style: { fontSize: '12px' } }, '同时应用到本区域文件的全部区块（自动备份一次）'),
      h('span', { class: 'spacer' }),
      progressEl
    ),
    datalist
  )

  // ---------------- 按坐标操作 ----------------
  const mkNum = (ph) => {
    const el = h('input', { class: 'input', type: 'number', placeholder: ph })
    return el
  }
  const cx1In = mkNum('X1'), cy1In = mkNum('Y1'), cz1In = mkNum('Z1')
  const cx2In = mkNum('X2'), cy2In = mkNum('Y2'), cz2In = mkNum('Z2')
  const boxFromIn = h('input', { class: 'input mono', placeholder: '原方块，留空=全部（等效 /fill）' })
  boxFromIn.style.width = '220px'
  boxFromIn.setAttribute('list', dlId)
  const boxToIn = h('input', { class: 'input mono', placeholder: '新方块，如 minecraft:air' })
  boxToIn.style.width = '220px'
  boxToIn.setAttribute('list', dlId)
  const boxStatusEl = h('div', { class: 'ce-status' }, '')
  const progressEl2 = h('span', { class: 'ce-status' }, '')
  const btnBoxGo = btn('按坐标替换', { size: 'sm', variant: 'danger', iconName: 'swap', onClick: doBoxReplace })
  const btnQuery = btn('查询角1方块', { size: 'sm', iconName: 'search', onClick: queryBlock })
  const btnPick1 = btn('拾取→角1', { size: 'sm', iconName: 'pin', onClick: () => pickToCorner(1) })
  const btnPick2 = btn('拾取→角2', { size: 'sm', iconName: 'pin', onClick: () => pickToCorner(2) })
  const jcxIn = mkNum('区块X')
  const jczIn = mkNum('区块Z')
  const btnJump = btn('跳转', { size: 'sm', iconName: 'arrow-right', onClick: jumpToChunk })

  const boxSection = h('div', { class: 'ce-section' },
    h('label', {}, '按坐标操作（世界坐标；长方体范围替换，支持跨区块）'),
    h('div', { class: 'ce-coords' },
      h('span', { class: 'lbl' }, '角1'), cx1In, cy1In, cz1In,
      h('span', { class: 'lbl' }, '角2'), cx2In, cy2In, cz2In,
      btnPick1, btnPick2, btnQuery
    ),
    h('div', { class: 'ce-coords', style: { marginTop: '2px' } },
      h('span', { class: 'lbl' }, '原方块'), boxFromIn,
      h('span', { class: 'muted' }, '→'),
      h('span', { class: 'lbl' }, '新方块'), boxToIn,
      btnBoxGo
    ),
    h('div', { class: 'ce-coords', style: { marginTop: '2px' } },
      h('span', { class: 'lbl' }, '跳转到区块'), jcxIn, jczIn, btnJump,
      h('span', { class: 'spacer' }),
      progressEl2
    ),
    boxStatusEl
  )

  const noteEl = h('div', { class: 'ce-note' },
    '编辑前请关闭对应的游戏 / 服务端。首次替换会自动备份整个 .mca 文件（保留最近 10 份）；' +
    '替换使用方块默认属性（如台阶朝向等复杂属性暂不支持）。Y 超出世界高度时由服务端裁剪到有效范围。'
  )

  body.append(toolbar, maps, pickEl, batchSection, boxSection, noteEl)
  renderPick()

  regionSel.onchange = () => {
    st.file = regionSel.value
    loadBitmap()
  }

  loadRegions()

  // ---------------- 地图绘制 ----------------

  function paintRegion(g, view) {
    g.fillStyle = '#0c0f14'
    g.fillRect(0, 0, REGION_W, REGION_H)
    for (let cz = 0; cz < 32; cz++) {
      for (let cx = 0; cx < 32; cx++) {
        g.fillStyle = st.bitmap && st.bitmap[cz * 32 + cx] ? '#3f9e52' : '#1a2028'
        g.fillRect(cx * CELL + 1, cz * CELL + 1, CELL - 2, CELL - 2)
      }
    }
    const line = 1 / view.scale
    g.strokeStyle = 'rgba(255,255,255,.09)'
    g.lineWidth = line
    for (let i = 0; i <= 32; i++) {
      g.beginPath()
      g.moveTo(i * CELL + 0.5 * line, 0)
      g.lineTo(i * CELL + 0.5 * line, REGION_H)
      g.stroke()
      g.beginPath()
      g.moveTo(0, i * CELL + 0.5 * line)
      g.lineTo(REGION_W, i * CELL + 0.5 * line)
      g.stroke()
    }
    if (view.hover) {
      const hx = Math.floor(view.hover.x / CELL)
      const hz = Math.floor(view.hover.y / CELL)
      if (hx >= 0 && hx < 32 && hz >= 0 && hz < 32) {
        g.strokeStyle = 'rgba(255,255,255,.45)'
        g.lineWidth = line
        g.strokeRect(hx * CELL + 0.5 * line, hz * CELL + 0.5 * line, CELL - line, CELL - line)
      }
    }
    if (st.selChunk) {
      g.strokeStyle = '#e8f5e9'
      g.lineWidth = 2 / view.scale
      g.strokeRect(st.selChunk.cx * CELL, st.selChunk.cz * CELL, CELL, CELL)
    }
  }

  function paintChunk(g, view) {
    const d = st.detail
    if (d) {
      for (const col of d.top) {
        if (!col || col.name === 'minecraft:air' || col.y === null) continue
        g.fillStyle = colorOf(col.name)
        g.fillRect(col.x * PX + 1, col.z * PX + 1, PX - 2, PX - 2)
      }
    }
    const line = 1 / view.scale
    g.strokeStyle = 'rgba(255,255,255,.07)'
    g.lineWidth = line
    for (let i = 1; i < 16; i++) {
      g.beginPath()
      g.moveTo(i * PX, 0)
      g.lineTo(i * PX, CHUNK_H)
      g.stroke()
      g.beginPath()
      g.moveTo(0, i * PX)
      g.lineTo(CHUNK_W, i * PX)
      g.stroke()
    }
    if (view.hover && d) {
      const hx = Math.floor(view.hover.x / PX)
      const hz = Math.floor(view.hover.y / PX)
      if (hx >= 0 && hx < 16 && hz >= 0 && hz < 16) {
        g.strokeStyle = 'rgba(255,255,255,.4)'
        g.strokeRect(hx * PX + 0.5 * line, hz * PX + 0.5 * line, PX - line, PX - line)
      }
    }
    if (st.picked) {
      g.strokeStyle = '#e8f5e9'
      g.lineWidth = 2 / view.scale
      g.strokeRect(st.picked.x * PX, st.picked.z * PX, PX, PX)
    }
  }

  // ---------------- 区域 / 区块加载 ----------------

  async function loadRegions() {
    const seq = ++regionsSeq
    statusEl.textContent = '读取区域文件中…'
    try {
      const r = await api.get('/api/saveeditor/regions?world=' + encodeURIComponent(st.world.path))
      if (seq !== regionsSeq) return
      if (r.error) throw new Error(r.error)
      st.regions = r.items || []
      clear(regionSel)
      if (!st.regions.length) {
        regionSel.disabled = true
        statusEl.textContent = '这个世界的 region 目录里没有区域文件（还没有生成过地形）。'
        st.file = ''
        st.bitmap = null
        st.detail = null
        st.picked = null
        st.selChunk = null
        clear(legend)
        bitFoot.textContent = '尚未读取区域文件'
        chunkMap.setTitle('区块俯视图（顶层方块）')
        chunkFoot.textContent = '点击左侧绿色区块以打开俯视图。'
        regionMap.redraw()
        chunkMap.redraw()
        return
      }
      regionSel.disabled = false
      for (const it of st.regions) {
        regionSel.appendChild(h('option', { value: it.name }, `${it.name}（${(it.size / 1024).toFixed(0)} KB）`))
      }
      st.file = st.regions[0].name
      regionSel.value = st.file
      statusEl.textContent = `共 ${st.regions.length} 个区域文件。左侧绿格 = 已生成的区块，点击打开俯视图。`
      loadBitmap()
    } catch (e) {
      if (seq !== regionsSeq) return
      statusEl.textContent = '读取失败：' + e.message
    }
  }

  async function loadBitmap() {
    const seq = ++bitmapSeq
    chunkSeq++
    st.bitmap = null
    st.selChunk = null
    st.detail = null
    st.picked = null
    renderPick()
    clear(legend)
    chunkMap.setTitle('区块俯视图（顶层方块）')
    chunkFoot.textContent = '点击左侧绿色区块以打开俯视图。'
    bitFoot.textContent = '正在读取区域文件…'
    regionMap.redraw()
    chunkMap.redraw()
    if (!st.file) {
      bitFoot.textContent = '尚未选择区域文件'
      return
    }
    try {
      const r = await api.get('/api/saveeditor/region?world=' + encodeURIComponent(st.world.path) + '&file=' + encodeURIComponent(st.file))
      if (seq !== bitmapSeq) return
      if (r.error) throw new Error(r.error)
      st.bitmap = r.bitmap
      updateBitFoot()
      regionMap.redraw()
    } catch (e) {
      if (seq !== bitmapSeq) return
      bitFoot.textContent = '读取失败：' + e.message
      regionMap.redraw()
    }
  }

  function updateBitFoot() {
    if (!st.bitmap) {
      bitFoot.textContent = '尚未读取区域文件'
      return
    }
    let n = 0
    for (const v of st.bitmap) if (v) n++
    bitFoot.textContent = `${st.file} · 已生成 ${n} / 1024 个区块`
  }

  async function loadChunk(cx, cz) {
    const seq = ++chunkSeq
    st.detail = null
    st.picked = null
    st.selChunk = { cx, cz }
    renderPick()
    regionMap.redraw()
    chunkMap.redraw()
    clear(legend)
    chunkMap.setTitle(`区块 (${cx}, ${cz}) 俯视图（顶层方块）`)
    chunkFoot.textContent = '解析中…'
    try {
      const r = await api.get(`/api/saveeditor/chunk?world=${encodeURIComponent(st.world.path)}&file=${encodeURIComponent(st.file)}&cx=${cx}&cz=${cz}`)
      if (seq !== chunkSeq) return
      if (r.error) throw new Error(r.error)
      st.detail = r
      renderLegend()
      renderChunkStatus()
      chunkMap.redraw()
    } catch (e) {
      if (seq !== chunkSeq) return
      st.detail = null
      clear(legend)
      chunkFoot.textContent = '读取失败：' + e.message
      chunkMap.redraw()
    }
  }

  function renderLegend() {
    clear(legend)
    const list = (st.detail && st.detail.summary) || []
    if (!list.length) {
      legend.appendChild(h('span', { class: 'ce-status' }, '这个区块没有可显示的顶层方块。'))
      return
    }
    for (const s of list) {
      legend.appendChild(h('span', { class: 'badge', title: shortName(s.name) },
        h('span', {
          style: {
            display: 'inline-block', width: '9px', height: '9px',
            background: colorOf(s.name), marginRight: '5px', borderRadius: '2px'
          }
        }),
        `${shortName(s.name)} ×${s.count}`
      ))
    }
  }

  function renderChunkStatus() {
    if (!st.detail) {
      chunkFoot.textContent = '点击左侧绿色区块以打开俯视图。'
      return
    }
    const d = st.detail
    chunkFoot.textContent = `状态: ${d.status} · DataVersion: ${d.dataVersion ?? '?'}`
  }

  // ---------------- 坐标换算 ----------------

  function regionOffset() {
    const m = /r\.(-?\d+)\.(-?\d+)\.mca$/.exec(st.file || '')
    return m ? { rx: +m[1], rz: +m[2] } : { rx: 0, rz: 0 }
  }

  function pickedWorld() {
    if (!st.picked || !st.selChunk) return null
    const { rx, rz } = regionOffset()
    return {
      x: rx * 512 + st.selChunk.cx * 16 + st.picked.x,
      y: st.picked.y,
      z: rz * 512 + st.selChunk.cz * 16 + st.picked.z
    }
  }

  function renderPick() {
    clear(pickEl)
    if (st.picked) {
      const w = pickedWorld()
      pickEl.appendChild(h('div', {},
        h('strong', {}, `已拾取：局部 (${st.picked.x}, ${st.picked.z}) 高度 y=${st.picked.y} `),
        h('span', { class: 'mono' }, st.picked.name),
        w && w.y !== null ? h('span', { class: 'muted' }, `　世界坐标 (${w.x}, ${w.y}, ${w.z})`) : null
      ))
      pickEl.appendChild(h('div', { class: 'ce-status' }, '可点击「拾取→角1 / 角2」把此列坐标填入下方长方体。'))
    } else {
      pickEl.appendChild(h('span', { class: 'muted' }, '在俯视图上点击格子以拾取方块。'))
    }
  }

  function pickToCorner(n) {
    const w = pickedWorld()
    if (!w) { toast('请先在俯视图上点击拾取一个方块', 'warn'); return }
    if (w.y === null) { toast('拾取的列全是空气，没有可用的 Y 坐标', 'warn'); return }
    if (n === 1) { cx1In.value = w.x; cy1In.value = w.y; cz1In.value = w.z }
    else { cx2In.value = w.x; cy2In.value = w.y; cz2In.value = w.z }
    toast(`角${n} 已设为 (${w.x}, ${w.y}, ${w.z})`, 'ok')
  }

  async function jumpToChunk() {
    const cx = Math.trunc(Number(jcxIn.value)), cz = Math.trunc(Number(jczIn.value))
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) { toast('请输入区块坐标', 'warn'); return }
    const rx = Math.floor(cx / 32), rz = Math.floor(cz / 32)
    const fileName = `r.${rx}.${rz}.mca`
    if (!st.regions.some((r) => r.name === fileName)) {
      toast(`区域文件 ${fileName} 不存在（区块未生成）`, 'warn')
      return
    }
    regionSel.value = fileName
    st.file = fileName
    await loadBitmap()
    await loadChunk(cx - rx * 32, cz - rz * 32)
  }

  // ---------------- 按坐标查询 / 替换 ----------------

  async function queryBlock() {
    const x = Number(cx1In.value), y = Number(cy1In.value), z = Number(cz1In.value)
    if (![x, y, z].every(Number.isFinite)) { toast('请先填写角1坐标', 'warn'); return }
    try {
      const r = await api.post('/api/saveeditor/block', { world: st.world.path, x, y, z })
      if (r.error) throw new Error(r.error)
      boxStatusEl.textContent = `(${r.x}, ${r.y}, ${r.z}) = ${r.name}` +
        (r.properties ? ` ${JSON.stringify(r.properties)}` : '') +
        `  ·  所在 ${r.region} 区块 (${r.chunk[0]}, ${r.chunk[1]})`
      if (!boxFromIn.value) boxFromIn.value = r.name
    } catch (e) {
      boxStatusEl.textContent = '查询失败：' + e.message
    }
  }

  async function doBoxReplace() {
    const norm = (s) => (s.includes(':') ? s.trim() : 'minecraft:' + s.trim())
    const to = boxToIn.value.trim()
    if (!to) { toast('请填写新方块', 'warn'); return }
    const box = {
      x1: cx1In.value, y1: cy1In.value, z1: cz1In.value,
      x2: cx2In.value, y2: cy2In.value, z2: cz2In.value
    }
    if (Object.values(box).some((v) => v === '')) { toast('请填写完整的角1/角2坐标', 'warn'); return }
    const from = boxFromIn.value.trim() ? norm(boxFromIn.value) : ''
    try {
      const plan = await api.post('/api/saveeditor/box/plan', { world: st.world.path, box })
      if (plan.error) throw new Error(plan.error)
      if (!plan.items.length) { toast('范围内没有任何已生成的区块', 'warn'); return }
      const scope = from
        ? `把 ${escapeHtml(from)} 替换为 ${escapeHtml(to)}`
        : `把范围内所有方块（含空气）替换为 ${escapeHtml(to)}`
      const ok = await ctx.confirm(
        `范围 (${box.x1}, ${box.y1}, ${box.z1}) → (${box.x2}, ${box.y2}, ${box.z2})\n${scope}\n涉及 ${plan.totalChunks} 个区块。\n首次执行自动备份涉及的区域文件。继续？`,
        { danger: true, okText: '替换' })
      if (!ok) return
      btnBoxGo.disabled = true
      let total = 0, done = 0, skipped = 0
      const failures = []
      // 每个区域文件只备份一次：跨区域的批量替换不能只备份第一个文件。
      const backedUp = new Set()
      for (const it of plan.items) {
        progressEl2.textContent = `替换进度 ${done}/${plan.items.length}…`
        const r = await api.post('/api/saveeditor/box/apply', {
          world: st.world.path, file: it.file, cx: it.cx, cz: it.cz, box: plan.box, from, to,
          noBackup: backedUp.has(it.file)
        }).catch((e) => ({ error: e.message }))
        if (r.error) { skipped++; failures.push(`[${it.cx},${it.cz}] ${r.error}`); continue }
        backedUp.add(it.file)
        total += r.replaced || 0
        done++
      }
      progressEl2.textContent = ''
      if (!done) {
        // 全部失败时不能提示“完成 / 已备份”：用户会以为改成功了。
        toast('坐标替换失败：' + (failures[0] || '所有区块都未能写入'), 'err')
        return
      }
      if (skipped) {
        toast(`坐标替换完成：${total} 个方块，${skipped} 个区块失败（${failures[0]}）`, 'warn')
      } else {
        toast(`坐标替换完成：${total} 个方块（.mca 已备份）`, 'ok')
      }
      if (st.detail && st.selChunk && plan.items.some((i) => i.cx === st.selChunk.cx && i.cz === st.selChunk.cz && i.file === st.file)) {
        loadChunk(st.selChunk.cx, st.selChunk.cz)
      }
    } catch (e) {
      toast('坐标替换失败：' + e.message, 'err')
      progressEl2.textContent = ''
    } finally {
      btnBoxGo.disabled = false
    }
  }

  async function doReplace() {
    const norm = (s) => (s.includes(':') ? s.trim() : 'minecraft:' + s.trim())
    const from = norm(fromIn.value)
    const to = norm(toIn.value)
    if (!fromIn.value.trim() || !toIn.value.trim()) { toast('请填写原方块和新方块', 'warn'); return }
    if (from === to) { toast('两个方块相同', 'warn'); return }
    if (!st.file) { toast('请先选择区域文件', 'warn'); return }
    const scopeAll = allChk.checked
    if (!scopeAll && !st.detail) { toast('请先在上方选择一个已生成的区块', 'warn'); return }
    if (scopeAll && !st.bitmap) { toast('请先选择区域文件', 'warn'); return }

    const ok = await ctx.confirm(
      `把 ${scopeAll ? '本区域文件全部区块' : `区块 (${st.detail?.cx ?? '?'}, ${st.detail?.cz ?? '?'})`} 中的\n  ${escapeHtml(from)}\n替换为\n  ${escapeHtml(to)}\n\n首次执行会自动备份 .mca 文件。继续？`,
      { danger: true, okText: '替换' })
    if (!ok) return

    btnGo.disabled = true
    let total = 0
    try {
      if (!scopeAll) {
        const r = await api.post('/api/saveeditor/chunk/replace', { world: st.world.path, file: st.file, cx: st.detail.cx, cz: st.detail.cz, from, to })
        if (r.error) throw new Error(r.error)
        total = r.replaced
        toast(`替换完成：${r.replaced} 个方块（已备份 .mca）`, 'ok')
        if (st.detail) loadChunk(st.detail.cx, st.detail.cz)
      } else {
        const targets = []
        for (let cz = 0; cz < 32; cz++) {
          for (let cx = 0; cx < 32; cx++) if (st.bitmap[cz * 32 + cx]) targets.push({ cx, cz })
        }
        let done = 0
        for (const t of targets) {
          progressEl.textContent = `替换进度 ${done}/${targets.length}…`
          const r = await api.post('/api/saveeditor/chunk/replace', {
            world: st.world.path, file: st.file, cx: t.cx, cz: t.cz, from, to, noBackup: done > 0
          }).catch((e) => ({ error: e.message }))
          if (r.error) { console.warn('跳过区块', t, r.error); continue }
          total += r.replaced || 0
          done++
        }
        progressEl.textContent = ''
        toast(`区域批量替换完成：${done} 个区块、共 ${total} 个方块（.mca 已备份）`, 'ok')
        if (st.detail) loadChunk(st.detail.cx, st.detail.cz)
      }
    } catch (e) {
      toast('替换失败：' + e.message, 'err')
      progressEl.textContent = ''
    } finally {
      btnGo.disabled = false
    }
  }

  return modal
}

// ---------------- 可缩放 / 平移的画布 ----------------

function createMap({ baseW, baseH, title, ariaLabel, draw, onPick }) {
  const canvas = h('canvas', { 'aria-label': ariaLabel, width: baseW, height: baseH })
  canvas.style.width = baseW + 'px'
  canvas.style.height = baseH + 'px'
  canvas.style.touchAction = 'none'
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.round(baseW * dpr)
  canvas.height = Math.round(baseH * dpr)
  const g = canvas.getContext('2d')

  const view = { scale: 1, tx: 0, ty: 0, hover: null, down: false, moved: 0, lastX: 0, lastY: 0 }

  const titleEl = h('strong', {
    style: {
      fontSize: '12px', flex: '1 1 auto', minWidth: '0',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
    }
  }, title)
  const zoomLabel = h('span', {
    style: {
      fontSize: '10.5px', color: 'var(--mute)', fontFamily: 'var(--font-mono)',
      minWidth: '34px', textAlign: 'center', flex: 'none'
    }
  }, '100%')

  const btnOut = iconBtn('minus', { label: '缩小', size: 13, onClick: () => zoomAt(baseW / 2, baseH / 2, 1 / 1.25) })
  const btnIn = iconBtn('add', { label: '放大', size: 13, onClick: () => zoomAt(baseW / 2, baseH / 2, 1.25) })
  const btnReset = iconBtn('refresh', { label: '重置视图', size: 13, onClick: () => resetView() })

  const head = h('div', { class: 'row', style: { gap: '3px', width: '100%' } },
    titleEl, btnOut, zoomLabel, btnIn, btnReset)

  const wrap = h('div', { class: 'ce-map-wrap', style: { width: baseW + 'px' } }, head, canvas)

  function clampView() {
    const w = baseW * view.scale
    const hgt = baseH * view.scale
    if (w <= baseW) view.tx = (baseW - w) / 2
    else view.tx = Math.min(0, Math.max(baseW - w, view.tx))
    if (hgt <= baseH) view.ty = (baseH - hgt) / 2
    else view.ty = Math.min(0, Math.max(baseH - hgt, view.ty))
  }

  function syncZoom() {
    zoomLabel.textContent = Math.round(view.scale * 100) + '%'
  }

  function paint() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.fillStyle = '#0c0f14'
    g.fillRect(0, 0, baseW, baseH)
    g.save()
    g.translate(view.tx, view.ty)
    g.scale(view.scale, view.scale)
    draw(g, view)
    g.restore()
  }

  function zoomAt(ax, ay, factor) {
    const next = Math.min(4, Math.max(0.5, view.scale * factor))
    if (next === view.scale) return
    view.tx = ax - ((ax - view.tx) / view.scale) * next
    view.ty = ay - ((ay - view.ty) / view.scale) * next
    view.scale = next
    clampView()
    paint()
    syncZoom()
  }

  function resetView() {
    view.scale = 1
    view.tx = 0
    view.ty = 0
    clampView()
    paint()
    syncZoom()
  }

  function pointAt(e) {
    const rect = canvas.getBoundingClientRect()
    const cw = canvas.clientWidth || baseW
    const ch = canvas.clientHeight || baseH
    if (!cw || !ch) return null
    const x = ((e.clientX - rect.left - canvas.clientLeft) * (baseW / cw) - view.tx) / view.scale
    const y = ((e.clientY - rect.top - canvas.clientTop) * (baseH / ch) - view.ty) / view.scale
    if (x < 0 || y < 0 || x >= baseW || y >= baseH) return null
    return { x, y }
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    view.down = true
    view.moved = 0
    view.lastX = e.clientX
    view.lastY = e.clientY
    try { canvas.setPointerCapture(e.pointerId) } catch {}
    e.preventDefault()
  })

  canvas.addEventListener('pointermove', (e) => {
    if (view.down) {
      const dx = e.clientX - view.lastX
      const dy = e.clientY - view.lastY
      view.moved += Math.abs(dx) + Math.abs(dy)
      view.lastX = e.clientX
      view.lastY = e.clientY
      view.tx += dx
      view.ty += dy
      clampView()
      paint()
      return
    }
    const p = pointAt(e)
    const same = (p && view.hover && Math.abs(p.x - view.hover.x) < 0.5 && Math.abs(p.y - view.hover.y) < 0.5) || (!p && !view.hover)
    if (!same) {
      view.hover = p
      paint()
    }
  })

  canvas.addEventListener('pointerup', (e) => {
    if (!view.down) return
    view.down = false
    if (view.moved < 6) {
      const p = pointAt(e)
      if (p) onPick?.(p)
    }
  })

  canvas.addEventListener('pointercancel', () => { view.down = false })

  canvas.addEventListener('pointerleave', () => {
    if (view.down) return
    if (view.hover) {
      view.hover = null
      paint()
    }
  })

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const rect = canvas.getBoundingClientRect()
    const cw = canvas.clientWidth || baseW
    const ch = canvas.clientHeight || baseH
    if (!cw || !ch) return
    const ax = (e.clientX - rect.left - canvas.clientLeft) * (baseW / cw)
    const ay = (e.clientY - rect.top - canvas.clientTop) * (baseH / ch)
    zoomAt(ax, ay, e.deltaY < 0 ? 1.15 : 1 / 1.15)
  }, { passive: false })

  canvas.addEventListener('contextmenu', (e) => e.preventDefault())

  paint()

  return {
    wrap,
    canvas,
    redraw: paint,
    reset: resetView,
    setTitle(text) { titleEl.textContent = text }
  }
}
