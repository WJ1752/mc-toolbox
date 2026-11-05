import { h } from '../core/dom.js'
import { badge, btn, input } from '../ui/kit.js'
import { buildModRelations, openModRelations } from './mod-relations.js'

const WIDTH = 1100, HEIGHT = 700
let mapSequence = 0

function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value))
  for (const child of children) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  return node
}

/** 整包视图只负责布局与交互，声明、关联和缺失状态均复用单模组关系图。 */
export function openModDependencyMap({ items = [], selected, projects, loadProjects, openModal, iconFor }) {
  const graph = buildModRelations(items, projects)
  const markerId = 'lp-map-arrow-' + (++mapSequence)
  let current = typeof selected === 'string' ? graph.find(selected) : selected
  let showOptional = false, hideIsolated = true, nearbyOnly = !!current
  let frame = 0, closed = false, pan = null, viewChanged = false
  let view = { x: 0, y: 0, width: WIDTH, height: HEIGHT }
  const search = input({ placeholder: '搜索模组名称、ID 或文件名', title: '搜索并定位模组或缺失前置', onInput: paintSearch,
    onKeyDown: event => { if (event.key === 'Enter') { const first = matches()[0]; if (first) focus(first) } } })
  const searchResults = h('div', { class: 'lp-map-search-results' })
  const summary = h('div', { class: 'lp-relation-summary' })
  const details = h('aside', { class: 'lp-map-details' })
  const canvas = svgEl('svg', { class: 'lp-dependency-map', viewBox: `0 0 ${WIDTH} ${HEIGHT}`, role: 'img', 'aria-label': '整合包模组依赖云图' })
  const edgeLayer = svgEl('g'), nodeLayer = svgEl('g')
  canvas.append(svgEl('defs', {}, svgEl('marker', { id: markerId, viewBox: '0 0 10 10', refX: 18, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' },
    svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'context-stroke' }))), edgeLayer, nodeLayer)
  const visibleCount = h('span', { class: 'lp-hint' })
  const check = (label, checked, change) => {
    const box = h('input', { type: 'checkbox', checked, onchange: () => { change(box.checked); draw() } })
    return h('label', { class: 'lp-inline-check' }, box, label)
  }
  const body = h('div', { class: 'lp-dependency-map-panel' }, summary,
    h('div', { class: 'lp-map-toolbar' }, search,
      btn('整包视图', { size: 'sm', onClick: () => { nearbyOnly = false; draw() } }),
      btn('仅看相邻依赖', { size: 'sm', onClick: () => { if (current) { nearbyOnly = true; draw() } } })),
    searchResults,
    h('div', { class: 'lp-map-toolbar' },
      check('显示可选依赖', showOptional, value => { showOptional = value }),
      check('隐藏无关联模组', hideIsolated, value => { hideIsolated = value }),
      h('span', { class: 'lp-map-legend enabled' }, '● 已安装'), h('span', { class: 'lp-map-legend missing' }, '● 缺失'),
      h('span', { class: 'lp-map-legend disabled' }, '● 已禁用 / 加载器不匹配'), h('span', { class: 'lp-map-legend unknown' }, '● 本地未安装'), visibleCount),
    h('div', { class: 'lp-map-workspace' }, h('div', { class: 'lp-map-canvas-wrap' }, canvas,
      h('div', { class: 'lp-map-zoom' }, btn('−', { size: 'xs', title: '缩小', onClick: () => zoom(1.3) }),
        btn('+', { size: 'xs', title: '放大', onClick: () => zoom(1 / 1.3) }),
        btn('复位', { size: 'xs', onClick: resetView }))), details),
    h('div', { class: 'lp-hint' }, '箭头指向依赖项；冲突为红色虚线。滚轮缩放、拖动空白平移；点击节点查看依赖链。来源：本地 JAR 元数据。'))
  const modal = openModal({ title: '整合包依赖云图', size: 'xl', class: 'lp-map-modal', body, buttons: [{ label: '关闭' }],
    onClose: () => { closed = true; cancelAnimationFrame(frame) } })
  const missingCount = new Set(items.flatMap(item => item.missingDependencies || []).map(id => id.toLowerCase())).size
  summary.append(badge(`模组 ${items.length}`, 'info'), badge(`缺少前置 ${missingCount}`, missingCount ? 'warn' : ''),
    badge(`已禁用 ${items.filter(item => item.disabled).length}`),
    badge(`冲突声明 ${graph.edges.filter(edge => edge.kind === 'conflicts').length}`, 'accent'))

  function matches() {
    const query = search.value.trim().toLowerCase()
    return query ? graph.nodes.filter(node => [node.name, node.modid, node.file, ...(node.providedModIds || [])].join(' ').toLowerCase().includes(query)) : []
  }
  function paintSearch() {
    const found = matches()
    searchResults.replaceChildren(...found.slice(0, 12).map(node => btn(node.name || node.modid || node.file, {
      size: 'xs', onClick: () => focus(node), title: [node.modid, node.file].filter(Boolean).join(' · ')
    })))
    if (search.value.trim() && !found.length) searchResults.append(h('span', { class: 'lp-hint' }, '没有匹配的模组或依赖'))
    if (found.length > 12) searchResults.append(h('span', { class: 'lp-hint' }, `共 ${found.length} 个匹配，请输入更具体的名称`))
  }
  function focus(node) {
    current = node
    nearbyOnly = true
    search.value = ''
    searchResults.replaceChildren()
    draw()
  }
  function resetView() {
    viewChanged = true
    view = { x: 0, y: 0, width: WIDTH, height: HEIGHT }
    updateView()
  }
  function updateView() { canvas.setAttribute('viewBox', `${view.x} ${view.y} ${view.width} ${view.height}`) }
  function zoom(factor, x = .5, y = .5) {
    viewChanged = true
    const width = Math.max(150, Math.min(WIDTH * 4, view.width * factor))
    const height = width * HEIGHT / WIDTH
    view = { x: view.x + (view.width - width) * x, y: view.y + (view.height - height) * y, width, height }
    updateView()
  }
  canvas.addEventListener('wheel', event => {
    event.preventDefault()
    const bounds = canvas.getBoundingClientRect()
    zoom(event.deltaY > 0 ? 1.13 : 1 / 1.13, (event.clientX - bounds.left) / bounds.width, (event.clientY - bounds.top) / bounds.height)
  }, { passive: false })
  canvas.addEventListener('pointerdown', event => {
    if (event.target.closest('.lp-map-node') || event.button !== 0) return
    pan = { x: event.clientX, y: event.clientY, view: { ...view } }
    viewChanged = true
    canvas.setPointerCapture(event.pointerId)
  })
  canvas.addEventListener('pointermove', event => {
    if (!pan) return
    const bounds = canvas.getBoundingClientRect()
    view.x = pan.view.x - (event.clientX - pan.x) * view.width / bounds.width
    view.y = pan.view.y - (event.clientY - pan.y) * view.height / bounds.height
    updateView()
  })
  canvas.addEventListener('pointerup', () => { pan = null })
  canvas.addEventListener('pointercancel', () => { pan = null })

  function paintDetails() {
    if (!current) {
      details.replaceChildren(h('b', {}, '选择一个模组'), h('p', { class: 'lp-hint' }, '点击云图节点或搜索名称，查看它需要的依赖、被谁依赖以及冲突声明。'))
      return
    }
    const { needs, usedBy, conflicts } = graph(current)
    const status = current.relationMissing ? (current.requiredMissing ? '缺少必需依赖' : '本地未安装')
      : current.disabled ? '已禁用' : current.loaderMismatch ? '加载器不匹配' : '已安装'
    const group = (title, nodes) => h('section', {}, h('h4', {}, `${title} (${nodes.length})`), nodes.length
      ? nodes.map(node => {
        const target = node.target || graph.find(node.id, node.platform)
        return h('button', { class: 'lp-map-detail-link', type: 'button', onclick: () => target && focus(target) },
          h('b', {}, target?.name || node.id), ...node.lines.map(line => h('small', {}, line)))
      }) : h('span', { class: 'lp-hint' }, '无已知声明'))
    details.replaceChildren(h('b', {}, current.name || current.modid || current.file),
      h('span', { class: 'lp-hint' }, [current.modid, current.version, status].filter(Boolean).join(' · ')),
      btn('打开依赖详情', { size: 'sm', onClick: () => openModRelations({ items, selected: current, projects, loadProjects, openModal, iconFor }) }),
      group('它需要的依赖', needs), group('依赖它的模组', usedBy), group('冲突声明', conflicts))
  }

  function draw() {
    cancelAnimationFrame(frame)
    resetView()
    viewChanged = false
    paintDetails()
    const allEdges = graph.edges.filter(edge => showOptional || !edge.optional)
    const connected = new Set(allEdges.flatMap(edge => [edge.owner, edge.target]))
    const neighbors = new Set([current])
    if (nearbyOnly && current) {
      for (const edge of allEdges) {
        if (edge.owner === current) neighbors.add(edge.target)
        if (edge.target === current) neighbors.add(edge.owner)
      }
    }
    const nodes = graph.nodes.filter(node => (node === current || !hideIsolated || connected.has(node)) && (!nearbyOnly || !current || neighbors.has(node)))
    const visible = new Set(nodes)
    const edges = allEdges.filter(edge => visible.has(edge.owner) && visible.has(edge.target))
    canvas.classList.toggle('compact', nodes.length > 65)
    visibleCount.textContent = `显示 ${nodes.length} 个节点 · ${edges.length} 条声明${nearbyOnly && current ? ' · 当前模组及相邻依赖' : ''}`
    edgeLayer.replaceChildren()
    nodeLayer.replaceChildren()
    if (!nodes.length) {
      nodeLayer.append(svgEl('text', { x: WIDTH / 2, y: HEIGHT / 2, 'text-anchor': 'middle', class: 'lp-map-empty' }, '暂无依赖声明，可取消隐藏无关联模组'))
      return
    }
    const degree = new Map()
    for (const edge of edges) {
      degree.set(edge.owner, (degree.get(edge.owner) || 0) + 1)
      degree.set(edge.target, (degree.get(edge.target) || 0) + 1)
    }
    const order = [...nodes].sort((a, b) => (degree.get(b) || 0) - (degree.get(a) || 0))
    const positions = new Map(order.map((node, index) => {
      const angle = index * 2.399963229728653
      const radius = Math.sqrt(index / Math.max(1, order.length)) * 290
      return [node, { x: WIDTH / 2 + Math.cos(angle) * radius * 1.5, y: HEIGHT / 2 + Math.sin(angle) * radius, vx: 0, vy: 0 }]
    }))
    const lines = edges.map(edge => {
      const line = svgEl('line', { class: `lp-map-edge${edge.kind === 'conflicts' ? ' conflict' : ''}${edge.optional ? ' optional' : ''}${edge.owner === current || edge.target === current ? ' selected' : ''}`, 'marker-end': `url(#${markerId})` })
      line.append(svgEl('title', {}, `${edge.owner.name || edge.owner.modid} → ${edge.target.name || edge.id}: ${edge.status}`))
      edgeLayer.append(line)
      return [edge, line]
    })
    const elements = nodes.map(node => {
      const state = node.relationMissing ? (node.requiredMissing ? 'missing' : 'unknown') : node.disabled || node.loaderMismatch ? 'disabled' : 'enabled'
      const group = svgEl('g', { class: `lp-map-node ${state}${node === current ? ' selected' : ''}`, tabindex: 0, role: 'button', 'aria-label': node.name || node.modid || node.file })
      const label = node.name || node.modid || node.file
      const radius = Math.min(16, 5 + Math.sqrt(degree.get(node) || 0) * 1.4)
      group.append(svgEl('circle', { r: radius }), svgEl('text', { x: radius + 4, y: 4 }, label.length > 24 ? label.slice(0, 22) + '…' : label),
        svgEl('title', {}, [label, node.modid, node.file, node.requiredMissing ? '缺少必需依赖' : node.disabled ? '已禁用' : ''].filter(Boolean).join('\n')))
      group.addEventListener('click', () => focus(node))
      group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focus(node) } })
      nodeLayer.append(group)
      return [node, group]
    })
    let ticks = 0
    function tick() {
      if (closed) return
      // 有限次力布局；完成后停止动画，避免大整合包持续占用 CPU。
      const cooling = Math.max(.04, 1 - ticks / 150)
      for (let i = 0; i < nodes.length; i++) {
        const a = positions.get(nodes[i])
        for (let j = i + 1; j < nodes.length; j++) {
          const b = positions.get(nodes[j]), dx = a.x - b.x || .1, dy = a.y - b.y || .1
          const distance = Math.max(80, dx * dx + dy * dy)
          const force = Math.min(1.8, 300 / (distance * Math.sqrt(distance))) * cooling
          a.vx += dx * force; a.vy += dy * force
          b.vx -= dx * force; b.vy -= dy * force
        }
      }
      for (const [edge] of lines) {
        const a = positions.get(edge.owner), b = positions.get(edge.target)
        const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1
        const force = (length - (nearbyOnly ? 140 : 80)) * .007 * cooling / length
        a.vx += dx * force; a.vy += dy * force
        b.vx -= dx * force; b.vy -= dy * force
      }
      for (const [node, el] of elements) {
        const p = positions.get(node)
        p.vx = (p.vx + (WIDTH / 2 - p.x) * .0015 * cooling) * .65
        p.vy = (p.vy + (HEIGHT / 2 - p.y) * .0015 * cooling) * .65
        p.x = Math.max(25, Math.min(WIDTH - 100, p.x + p.vx))
        p.y = Math.max(25, Math.min(HEIGHT - 25, p.y + p.vy))
        el.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`)
      }
      for (const [edge, line] of lines) {
        const a = positions.get(edge.owner), b = positions.get(edge.target)
        line.setAttribute('x1', a.x); line.setAttribute('y1', a.y)
        line.setAttribute('x2', b.x); line.setAttribute('y2', b.y)
      }
      if (++ticks < 150) frame = requestAnimationFrame(tick)
      else if (nearbyOnly && current && !viewChanged) {
        // 小型依赖链自动放大；预留文字和节点边距，整包视图保持默认比例。
        const points = [...positions.values()]
        const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x))
        const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y))
        const width = Math.min(WIDTH, Math.max(400, maxX - minX + 230, (maxY - minY + 100) * WIDTH / HEIGHT))
        const height = width * HEIGHT / WIDTH
        view = { x: (minX + maxX + 110 - width) / 2, y: (minY + maxY - height) / 2, width, height }
        updateView()
      }
    }
    tick()
  }
  draw()
  return modal
}
