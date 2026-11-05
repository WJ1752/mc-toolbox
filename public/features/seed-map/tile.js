import { h } from '/js/core/dom.js'
import { openModal } from '/js/core/modal.js'
import { btn, input, select } from '/js/ui/kit.js'

const SIDE = 96
const CELL = 6
const STEPS = [4, 16, 64]
const DIMENSIONS = [['overworld', '主世界'], ['nether', '下界'], ['end', '末地']]
const field = (name, node) => h('label', {}, name, node)
const option = (value, text) => h('option', { value }, text)
const small = (caption, action) => btn(caption, { size: 'sm', onClick: action })

function mapView(initial = {}) {
  if (!document.querySelector('link[data-seed-map]')) document.head.append(h('link', {
    rel: 'stylesheet', href: new URL('./style.css', import.meta.url).href, 'data-seed-map': true
  }))
  const seed = input({ value: String(initial.seed ?? '0'), mono: true, placeholder: '数字或文字种子' })
  const version = select([], '', { ariaLabel: 'Java 版本' })
  const dimension = select(DIMENSIONS, initial.dimension || 'overworld')
  const step = select(STEPS.map(n => [n, n + ' 格 / 像素']), '16')
  const coord = value => input({ type: 'number', step: 1, value: Math.floor(Number(value) || 0), mono: true })
  const cx = coord(initial.x), cz = coord(initial.z), cy = coord(initial.y ?? 64)
  const structure = select([], '', { ariaLabel: '显示结构' })
  const biome = select([], '', { ariaLabel: '定位群系' })
  const grid = h('input', { type: 'checkbox' })
  const slime = h('input', { type: 'checkbox' })
  const legend = h('div', { class: 'seed-legend', 'aria-label': '当前视野群系图例' })
  const status = h('div', { class: 'seed-status', role: 'status' })
  const searchStatus = h('div', { class: 'seed-status', 'aria-live': 'polite' })
  const location = h('div', { class: 'seed-status mono', 'aria-live': 'polite' })
  const hint = h('div', { class: 'seed-status' })
  const plot = h('canvas', { class: 'seed-plot', width: SIDE * CELL, height: SIDE * CELL,
    'aria-label': '种子群系地图：拖动平移，单击查看方块和区块坐标' })
  const ctx = plot.getContext('2d')
  let worker, catalog, params, map, selected, requestId = 0, waiting = false, nextRequest, closed = false
  let biomeCatalog, searchWorker
  const show = btn('生成地图', { variant: 'primary', type: 'submit' })
  const nearestBiome = small('查找最近群系', searchBiome)
  const cancelSearch = small('取消查找', () => { stopSearch(); searchStatus.textContent = '查找已取消。' })
  cancelSearch.hidden = true
  const nearestStructure = small('最近结构', () => {
    if (!map) return
    const x = params.x + SIDE / 2 * params.step, z = params.z + SIDE / 2 * params.step
    const distance = item => (item.x - x) ** 2 + (item.z - z) ** 2
    jump(map.structures.reduce((best, item) => !best || distance(item) < distance(best) ? item : best, null))
  })
  const controls = h('form', { class: 'seed-controls', onsubmit: e => { e.preventDefault(); render() } },
    field('世界种子', seed), field('Java 版本', version), field('维度', dimension), field('取样高度 Y', cy),
    field('中心 X', cx), field('中心 Z', cz), field('比例', step), show)
  const root = h('div', { class: 'seed-map' }, controls, status,
    h('div', { class: 'seed-layout' },
      h('div', {}, plot, h('div', { class: 'seed-nav' },
        ...[['向西',-1,0],['向北',0,-1],['向南',0,1],['向东',1,0]].map(([name,dx,dz]) =>
          small(name, () => move(dx * SIDE / 2, dz * SIDE / 2))),
        small('放大', () => zoom(-1)), small('缩小', () => zoom(1))), location),
      h('aside', {}, field('显示结构', structure), nearestStructure,
        field('目标群系', biome), h('div', { class: 'seed-nav' }, nearestBiome, cancelSearch), searchStatus,
        h('div', { class: 'seed-layers' }, field('区块网格', grid), field('史莱姆区块', slime)),
        hint, legend, h('small', { class: 'seed-status' }, '白色菱形标出群系筛选后的结构预测位置，实际地形可能影响生成。'))))

  function updateStructures() {
    const choices = catalog?.[version.value]?.[dimension.value] || []
    const previous = structure.options.length ? structure.value : 'all'
    structure.replaceChildren(option('', '隐藏结构'), option('all', '全部结构'), ...choices.map(s => option(s.id, s.name)))
    structure.value = [...structure.options].some(item => item.value === previous) ? previous : 'all'
    const targets = biomeCatalog?.[version.value]?.[dimension.value] || []
    const lastBiome = biome.value
    biome.replaceChildren(...targets.map(b => option(b.id,b.name)))
    if (targets.some(b => String(b.id) === lastBiome)) biome.value = lastBiome
  }
  function clearMap() {
    map = null; params = null; selected = null
    ctx.clearRect(0, 0, plot.width, plot.height)
    legend.replaceChildren()
    location.textContent = ''
    nearestBiome.disabled = nearestStructure.disabled = true
  }
  function render() {
    const id = ++requestId
    stopSearch()
    searchStatus.textContent = ''
    clearMap()
    nextRequest = null
    if (!catalog) return
    if (!version.value) { status.textContent = '请选择支持的 Java 版本后生成地图。'; return }
    if (!seed.value.trim()) { status.textContent = '请输入世界种子。'; return }
    const n = Number(step.value)
    const centerX = Number(cx.value), centerZ = Number(cz.value), y = Number(cy.value)
    if ([cx, cz, cy].some(el => el.value === '') || ![centerX,centerZ,y].every(Number.isSafeInteger) ||
        Math.max(Math.abs(centerX), Math.abs(centerZ)) + SIDE * n / 2 > 30000000 || y < -64 || y > 319) {
      status.textContent = '中心须在世界边界内，高度范围为 −64 至 319。'; return
    }
    const x = Math.floor(centerX / n) * n - SIDE / 2 * n
    const z = Math.floor(centerZ / n) * n - SIDE / 2 * n
    nextRequest = { id, params: { seed: seed.value, version: version.value, dimension: dimension.value,
      x, z, y, step: n, width: SIDE, height: SIDE, structure: structure.value } }
    slime.disabled = dimension.value !== 'overworld' || n > 4
    hint.textContent = slime.disabled ? '放大到主世界 4 格 / 像素可显示史莱姆区块。' : '绿色斜线标记史莱姆区块。'
    status.textContent = '正在本机计算种子地图…'
    dispatch()
  }
  let sent
  function dispatch() {
    if (!waiting && nextRequest && !closed) {
      sent = nextRequest; nextRequest = null; waiting = true
      worker.postMessage(sent)
    }
  }
  function draw() {
    if (!map) return
    const { x, z, step: n } = params
    map.biomes.forEach((id, i) => {
      ctx.fillStyle = map.palette[id]?.color || '#666'
      ctx.fillRect(i % SIDE * CELL, Math.floor(i / SIDE) * CELL, CELL, CELL)
    })
    const px = value => (value - x) / n * CELL
    const pz = value => (value - z) / n * CELL
    if (grid.checked && n <= 16) {
      ctx.strokeStyle = 'rgba(0,0,0,.32)'; ctx.lineWidth = 1; ctx.beginPath()
      for (let b = Math.ceil(x / 16) * 16; b < x + SIDE*n; b += 16) { ctx.moveTo(px(b), 0); ctx.lineTo(px(b), plot.height) }
      for (let b = Math.ceil(z / 16) * 16; b < z + SIDE*n; b += 16) { ctx.moveTo(0, pz(b)); ctx.lineTo(plot.width, pz(b)) }
      ctx.stroke()
    }
    if (slime.checked && !slime.disabled) {
      const size = CELL * 16 / n
      ctx.strokeStyle = '#b7ff68'; ctx.lineWidth = 2
      for (const chunk of map.slimeChunks) {
        const left = px(chunk.x * 16), top = pz(chunk.z * 16)
        ctx.strokeRect(left + 1, top + 1, size - 2, size - 2)
        ctx.beginPath(); ctx.moveTo(left, top + size); ctx.lineTo(left + size, top); ctx.stroke()
      }
    }
    for (const marker of map.structures) {
      const left = px(marker.x), top = pz(marker.z)
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#222'; ctx.lineWidth = 2; ctx.beginPath()
      ctx.moveTo(left, top-5); ctx.lineTo(left+5,top); ctx.lineTo(left,top+5); ctx.lineTo(left-5,top); ctx.closePath(); ctx.fill(); ctx.stroke()
    }
    if (selected) {
      ctx.beginPath(); ctx.arc(px(selected.x), pz(selected.z), 6, 0, Math.PI * 2)
      ctx.lineWidth = 3; ctx.strokeStyle = '#17191d'; ctx.stroke(); ctx.lineWidth = 1; ctx.strokeStyle = '#fff'; ctx.stroke()
    }
  }
  function locate(x, z) {
    if (!map) return
    const col = Math.floor((x - params.x) / params.step), row = Math.floor((z - params.z) / params.step)
    const id = map.biomes[row * SIDE + col]
    const chunkX = Math.floor(x / 16), chunkZ = Math.floor(z / 16)
    const structureHit = map.structures.find(s => Math.hypot(x-s.x,z-s.z) <= params.step)
    const slimeHit = map.slimeChunks.some(c => c.x === chunkX && c.z === chunkZ)
    selected = { x,z }
    location.textContent = `X ${x} · Z ${z} ｜ 区块 ${chunkX}, ${chunkZ} ｜ ${map.palette[id]?.name || '未知群系'}` +
      (structureHit ? ' ｜ ' + structureHit.name : '') + (slimeHit ? ' ｜ 史莱姆区块' : '')
    draw()
  }
  function jump(point) {
    if (!point) return
    cx.value = point.x; cz.value = point.z
    render()
  }
  function stopSearch() {
    searchWorker?.terminate()
    searchWorker = null
    cancelSearch.hidden = true
    nearestBiome.disabled = !map || !biome.options.length
  }
  function searchBiome() {
    if (!map || !biome.value || searchWorker) return
    const radius = 2048, spacing = 16
    const target = biome.selectedOptions[0].textContent
    const range = `半径 ${radius} 格、每 ${spacing} 格采样，可能遗漏狭窄群系。`
    try {
      const query = { ...params, x: Number(cx.value), z: Number(cz.value), step: spacing, radius, biomeId: Number(biome.value) }
      searchWorker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
      nearestBiome.disabled = true
      cancelSearch.hidden = false
      searchStatus.textContent = '正在查找' + target + '。' + range
      searchWorker.onmessage = ({ data }) => {
        stopSearch()
        if (data.error) { searchStatus.textContent = data.error; return }
        if (!data.point) { searchStatus.textContent = '未找到' + target + '。' + range; return }
        step.value = '4'
        jump(data.point)
        searchStatus.textContent = `${target} · X ${data.point.x} · Z ${data.point.z}。${range}`
      }
      searchWorker.onerror = () => { stopSearch(); searchStatus.textContent = '本地查找失败，请重试。' }
      searchWorker.postMessage({ search: true, params: query })
    } catch (error) { stopSearch(); searchStatus.textContent = error.message }
  }
  function move(dx, dz) {
    if (!map) return
    jump({ x: Number(cx.value) + Math.round(dx * params.step), z: Number(cz.value) + Math.round(dz * params.step) })
  }
  function zoom(delta) {
    const i = STEPS.indexOf(Number(step.value))
    step.value = STEPS[Math.max(0, Math.min(STEPS.length - 1, i + delta))]
    render()
  }
  let drag
  plot.onpointerdown = e => {
    if (!map) return
    drag = { x: e.clientX, z: e.clientY }; plot.setPointerCapture(e.pointerId)
  }
  plot.onpointercancel = () => { drag = null }
  plot.onpointerup = e => {
    if (!drag || !map) return
    const box = plot.getBoundingClientRect()
    const dx = drag.x - e.clientX, dz = drag.z - e.clientY
    drag = null
    if (Math.hypot(dx,dz) > 4) { move(dx / box.width * SIDE, dz / box.height * SIDE); return }
    const cell = (v, start, size) => Math.min(SIDE-1, Math.max(0, Math.floor((v-start)/size*SIDE)))
    locate(params.x + cell(e.clientX,box.left,box.width)*params.step, params.z + cell(e.clientY,box.top,box.height)*params.step)
  }
  for (const control of [dimension, version, step, structure]) control.onchange = () => {
    if (control === version || control === dimension) updateStructures()
    render()
  }
  grid.onchange = slime.onchange = draw
  biome.onchange = () => { stopSearch(); searchStatus.textContent = '' }
  function dispose() { closed = true; worker?.terminate(); stopSearch() }
  clearMap()
  status.textContent = '正在加载本地地图引擎…'
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }) => {
      if (closed) return
      if (data.versions) {
        catalog = data.catalog
        biomeCatalog = data.biomes
        version.replaceChildren(option('', '选择版本'), ...data.versions.map(v => option(v,v)))
        const unsupported = initial.version != null && !data.resolved
        version.value = unsupported ? '' : data.resolved || data.versions[0]
        updateStructures()
        if (unsupported) status.textContent = `存档版本「${initial.version || '未知'}」没有对应预测模型，请手动选择版本。`
        else render()
        return
      }
      waiting = false
      if (data.id === requestId) {
        if (data.error) status.textContent = data.error
        else {
          params = sent.params; map = data.result
          const ids = [...new Set(map.biomes)].sort((a,b) => (map.palette[a]?.name || '').localeCompare(map.palette[b]?.name || ''))
          legend.replaceChildren(...ids.map(id => h('span', {}, h('i', { style: { background: map.palette[id]?.color } }), map.palette[id]?.name || id)))
          nearestBiome.disabled = !biome.options.length; nearestStructure.disabled = !map.structures.length
          grid.disabled = params.step > 16
          status.textContent = `${SIDE * params.step} × ${SIDE * params.step} 格 · ${ids.length} 种群系 · ${map.structures.length} 处结构`
          locate(Number(cx.value), Number(cz.value))
        }
      }
      dispatch()
    }
    worker.onerror = () => { clearMap(); status.textContent = '本地地图引擎加载失败，请重新打开地图。'; dispose() }
    worker.postMessage({ init: true, version: initial.version })
  } catch (error) { status.textContent = error.message }
  return { root, dispose }
}

export function openSeedMap(initial = {}) {
  const { root, dispose } = mapView(initial)
  return openModal({ title: '种子地图', size: 'xl', body: root, onClose: dispose, buttons: [{ label: '关闭' }] })
}

export default {
  mount(ctx) {
    const seed = input({ placeholder: '输入 Java 版世界种子', mono: true })
    ctx.body.replaceChildren(h('form', { class: 'col', onsubmit: e => { e.preventDefault(); openSeedMap({ seed: seed.value || '0' }) } },
      field('世界种子', seed), btn('打开种子地图', { type: 'submit', variant: 'primary' })))
  },
  renderExpanded(container) {
    const { root, dispose } = mapView()
    container.replaceChildren(root)
    const observer = new MutationObserver(() => {
      if (!root.isConnected) { dispose(); observer.disconnect() }
    })
    observer.observe(container, { childList: true })
  }
}
