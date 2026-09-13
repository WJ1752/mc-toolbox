// 区块编辑器（图形化）：区域文件 → 区块存在图 → 16×16 俯视彩色地图 → 点选列替换方块
import { h, clear } from '/js/core/dom.js'
import { api } from '/js/core/api.js'
import { toast } from '/js/core/toast.js'

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

const CELL = 12   // 区域存在图格子尺寸
const PX = 24     // 区块俯视图格子尺寸

export function openChunkEditor(ctx, world) {
  const st = {
    world,
    regions: [],
    file: '',
    bitmap: null,
    detail: null,
    picked: null,
    busy: false
  }

  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } })
  const modal = ctx.openModal({ title: '区块编辑 — ' + (world.levelName || world.name), size: 'lg', body })

  // ---- 顶部：区域文件选择 ----
  const regionSel = h('select', { class: 'input' })
  const statusEl = h('div', { class: 'muted', style: { fontSize: '12.5px' } }, '读取区域文件中…')
  body.appendChild(h('div', { class: 'field' }, h('label', {}, '区域文件（region/*.mca）'), regionSel))
  body.appendChild(statusEl)

  // ---- 中部：存在图 + 俯视图 并排 ----
  const maps = h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' } })
  const bitWrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } })
  const chunkWrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } })
  maps.appendChild(bitWrap)
  maps.appendChild(chunkWrap)
  body.appendChild(maps)

  // ---- 底部：信息 + 替换表单 ----
  const pickEl = h('div', { class: 'muted' }, '在右侧俯视图上点击格子以拾取方块。')
  body.appendChild(pickEl)

  const fromIn = h('input', { class: 'input mono', placeholder: '原方块（点击俯视图自动填入）', value: '' })
  const toIn = h('input', { class: 'input mono', list: 'seBlocks', placeholder: '新方块，如 minecraft:air' })
  const datalist = h('datalist', { id: 'seBlocks' })
  for (const b of COMMON_BLOCKS) datalist.appendChild(h('option', { value: b }))
  const allChk = h('input', { class: 'checkbox', type: 'checkbox' })
  const progressEl = h('span', { class: 'muted', style: { fontSize: '12px' } }, '')
  const btnGo = h('button', { class: 'btn btn-sm btn-danger', onclick: doReplace }, '⚡ 执行替换')
  body.appendChild(h('div', { class: 'field' },
    h('label', {}, '批量替换（先点俯视图拾取“原方块”，或手动输入）'),
    h('div', { class: 'row wrap' },
      h('div', { class: 'grow', style: { minWidth: '180px' } }, fromIn),
      h('span', {}, '→'),
      h('div', { class: 'grow', style: { minWidth: '180px' } }, toIn, datalist),
      btnGo),
    h('div', { class: 'row', style: { alignItems: 'center', gap: '6px', marginTop: '4px' } },
      allChk, h('span', { style: { fontSize: '12.5px' } }, '同时应用到本区域文件的全部区块（自动备份一次）'),
      progressEl)))

  body.appendChild(h('div', { class: 'muted', style: { fontSize: '12px', lineHeight: '1.7' } },
    '⚠️ 编辑前请关闭对应的游戏/服务端。首次替换会自动备份整个 .mca 文件（保留最近 10 份）；替换使用方块默认属性（如台阶朝向等复杂属性暂不支持）。'))

  regionSel.onchange = () => { st.file = regionSel.value; loadBitmap() }

  loadRegions()

  // ---------------- 逻辑 ----------------

  async function loadRegions() {
    try {
      const r = await api.get('/api/saveeditor/regions?world=' + encodeURIComponent(st.world.path))
      if (r.error) throw new Error(r.error)
      st.regions = r.items || []
      clear(regionSel)
      if (!st.regions.length) {
        statusEl.textContent = '这个世界的 region 目录里没有区域文件（还没有生成过地形）。'
        return
      }
      for (const it of st.regions) regionSel.appendChild(h('option', { value: it.name }, `${it.name}（${(it.size / 1024).toFixed(0)} KB）`))
      st.file = st.regions[0].name
      statusEl.textContent = `共 ${st.regions.length} 个区域文件。左侧绿格 = 已生成的区块，点击打开俯视图。`
      loadBitmap()
    } catch (e) {
      statusEl.textContent = '读取失败：' + e.message
    }
  }

  async function loadBitmap() {
    clear(bitWrap)
    st.bitmap = null
    bitWrap.appendChild(h('strong', { style: { fontSize: '12.5px' } }, '区域区块分布（32×32）'))
    if (!st.file) return
    try {
      const r = await api.get('/api/saveeditor/region?world=' + encodeURIComponent(st.world.path) + '&file=' + encodeURIComponent(st.file))
      if (r.error) throw new Error(r.error)
      st.bitmap = r.bitmap
      drawBitmap()
    } catch (e) {
      bitWrap.appendChild(h('div', { class: 'muted' }, '读取失败：' + e.message))
    }
  }

  function drawBitmap() {
    clear(bitWrap)
    bitWrap.appendChild(h('strong', { style: { fontSize: '12.5px' } }, '区域区块分布（32×32）'))
    const cv = h('canvas', { width: 32 * CELL, height: 32 * CELL, style: { border: '1px solid var(--line)', cursor: 'pointer', imageRendering: 'pixelated' } })
    bitWrap.appendChild(cv)
    const g = cv.getContext('2d')
    g.fillStyle = '#11151b'
    g.fillRect(0, 0, cv.width, cv.height)
    for (let cz = 0; cz < 32; cz++) {
      for (let cx = 0; cx < 32; cx++) {
        if (st.bitmap[cz * 32 + cx]) {
          g.fillStyle = 'color-mix(in srgb, var(--accent) 70%, #2c6e2c)'
          g.fillRect(cx * CELL + 1, cz * CELL + 1, CELL - 2, CELL - 2)
        }
      }
    }
    cv.onclick = (e) => {
      const rect = cv.getBoundingClientRect()
      const cx = Math.floor((e.clientX - rect.left) / CELL)
      const cz = Math.floor((e.clientY - rect.top) / CELL)
      if (cx < 0 || cx > 31 || cz < 0 || cz > 31) return
      if (!st.bitmap[cz * 32 + cx]) { toast('这个区块还没有生成', 'warn'); return }
      loadChunk(cx, cz)
    }
  }

  async function loadChunk(cx, cz) {
    clear(chunkWrap)
    st.detail = null
    st.picked = null
    renderPick()
    chunkWrap.appendChild(h('strong', { style: { fontSize: '12.5px' } }, `区块 (${cx}, ${cz}) 俯视图（顶层方块）`))
    chunkWrap.appendChild(h('div', { class: 'muted', style: { fontSize: '12px' } }, '解析中…'))
    try {
      const r = await api.get(`/api/saveeditor/chunk?world=${encodeURIComponent(st.world.path)}&file=${encodeURIComponent(st.file)}&cx=${cx}&cz=${cz}`)
      if (r.error) throw new Error(r.error)
      st.detail = r
      drawChunk(cx, cz)
    } catch (e) {
      clear(chunkWrap)
      chunkWrap.appendChild(h('div', { class: 'muted' }, '读取失败：' + e.message))
    }
  }

  function drawChunk(cx, cz) {
    clear(chunkWrap)
    const d = st.detail
    chunkWrap.appendChild(h('strong', { style: { fontSize: '12.5px' } }, `区块 (${cx}, ${cz}) 俯视图（顶层方块）`))

    const cv = h('canvas', { width: 16 * PX, height: 16 * PX, style: { border: '1px solid var(--line)', cursor: 'pointer' } })
    chunkWrap.appendChild(cv)
    const g = cv.getContext('2d')
    g.fillStyle = '#0c0f14'
    g.fillRect(0, 0, cv.width, cv.height)
    for (const col of d.top) {
      if (!col || col.name === 'minecraft:air' || col.y === null) continue
      g.fillStyle = colorOf(col.name)
      g.fillRect(col.x * PX + 1, col.z * PX + 1, PX - 2, PX - 2)
    }
    g.strokeStyle = 'rgba(255,255,255,.06)'
    for (let i = 1; i < 16; i++) {
      g.beginPath(); g.moveTo(i * PX, 0); g.lineTo(i * PX, cv.height); g.stroke()
      g.beginPath(); g.moveTo(0, i * PX); g.lineTo(cv.width, i * PX); g.stroke()
    }
    cv.onclick = (e) => {
      const rect = cv.getBoundingClientRect()
      const x = Math.floor((e.clientX - rect.left) / PX)
      const z = Math.floor((e.clientY - rect.top) / PX)
      const col = d.top[z * 16 + x]
      if (!col) return
      st.picked = col
      if (!fromIn.value) fromIn.value = col.name
      renderPick()
    }

    // 摘要 + 图例
    const legend = h('div', { class: 'row wrap', style: { gap: '6px' } })
    for (const s of (d.summary || [])) {
      legend.appendChild(h('span', { class: 'badge' },
        h('span', { style: { display: 'inline-block', width: '9px', height: '9px', background: colorOf(s.name), marginRight: '5px', borderRadius: '2px' } }),
        `${shortName(s.name)} ×${s.count}`))
    }
    chunkWrap.appendChild(legend)
    if (d.status) chunkWrap.appendChild(h('div', { class: 'muted', style: { fontSize: '11.5px' } }, `状态: ${d.status} · DataVersion: ${d.dataVersion ?? '?'}`))
  }

  function renderPick() {
    clear(pickEl)
    if (st.picked) {
      pickEl.appendChild(h('div', {},
        h('strong', {}, `已拾取：(${st.picked.x}, ${st.picked.z}) 高度 y=${st.picked.y} `),
        h('span', { class: 'mono' }, st.picked.name)))
    } else {
      pickEl.appendChild(h('span', { class: 'muted' }, '在俯视图上点击格子以拾取方块。'))
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
    const ok = await ctx.confirm(
      `把 ${scopeAll ? '本区域文件全部区块' : `区块 (${st.detail?.cx ?? '?'}, ${st.detail?.cz ?? '?'})`} 中的\n  ${from}\n替换为\n  ${to}\n\n首次执行会自动备份 .mca 文件。继续？`,
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
