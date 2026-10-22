// Tile grid — pointer dragging, manual columns or masonry, FLIP reflow, no deps.
//
// Three layouts share one drag machinery:
//   * `masonry: true, adaptive: false` (default for the workbench) — manual
//     columns. Every tile carries `data-col` (0-based) and stacks vertically
//     inside its own column in DOM order. Columns never influence each other,
//     so dragging a tile only inserts the placeholder into the target column;
//   * `masonry: true, adaptive: true` — the legacy shortest-column masonry;
//   * `masonry: false` — flow layout (e.g. latency-monitor cards): the browser
//     lays the children out, grid.js only moves the placeholder.
//
// Dragging rules (why it is written this way):
//   * the dragged tile is taken out of the flow (position: fixed) and moved with
//     translate3d() once per animation frame — never with left/top, which forces
//     a full layout on every pointermove and made the tile trail the cursor;
//   * pointermove is coalesced into one rAF tick, so a 1000 Hz mouse cannot
//     queue more work than the compositor can show;
//   * the placeholder target is computed from *predicted* slots and the
//     pointer, not from the live tile rectangles: hit-testing rectangles that
//     are still gliding (FLIP) made the "nearest" tile change under a still
//     pointer, so the placeholder kept bouncing between two slots;
//   * in manual mode the target column comes from the pointer x and the insert
//     position from the pointer y vs. the tile midlines of that column only —
//     the other columns are never re-ordered or re-positioned;
//   * every reflow is animated with a FLIP transform (compositor only), so the
//     surrounding tiles glide instead of snapping.
const DRAG_THRESHOLD = 5
const MIN_COLUMN_WIDTH = 300
const AUTOSCROLL_EDGE = 64
const AUTOSCROLL_MAX = 22
const FLIP_MS = 180
// How much closer another slot must be (px, centre to centre) before the
// placeholder leaves the slot it is already in. This is the dead zone that
// absorbs pointer jitter at a swap boundary.
const SWAP_BIAS = 32

/* ------------------------------------------------------------------ */
/* pure layout helpers (no DOM — covered by tests/tile-layout.test.mjs) */
/* ------------------------------------------------------------------ */

function wholeNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function columnCount(columns) {
  return Math.max(1, Math.floor(Number(columns)) || 1)
}

/** Clamp a requested column (0-based) into the effective column range. */
export function clampColumn(col, columns) {
  const count = columnCount(columns)
  return Math.min(Math.max(0, wholeNumber(col)), count - 1)
}

/**
 * Resolve a tile's persisted column for the first paint.
 * - valid saved value wins (including values beyond the current viewport);
 * - missing/invalid values are distributed by layout index so old settings
 *   without `col` keep roughly the same visual arrangement as before.
 */
export function resolveTileColumn(saved, index = 0, maxColumns = 1) {
  if (saved !== null && saved !== undefined && saved !== '') {
    const value = Number(saved)
    if (Number.isFinite(value) && value >= 0) return Math.trunc(value)
  }
  const columns = Math.max(1, Math.trunc(Number(maxColumns)) || 1)
  const pos = Math.max(0, Math.trunc(Number(index)) || 0)
  return pos % columns
}

/**
 * 手动列布局：每个磁贴按 `col` 落在自己的列里，列内按数组顺序（即 DOM 顺序）
 * 垂直堆叠，列与列互不影响；容器高度取最高列。
 *
 * @param {Array<{id?:string, col?:number, height?:number}>} items
 * @param {{columns?:number, colWidth?:number, gap?:number}} metrics
 * @returns {{columns:number, colWidth:number, gap:number,
 *            positions:Array<{id:any, col:number, requestedCol:number,
 *                             left:number, top:number, width:number, height:number}>,
 *            height:number, heights:number[]}}
 */
export function manualLayout(items, { columns = 1, colWidth = 0, gap = 0 } = {}) {
  const count = columnCount(columns)
  const width = Math.max(0, Number(colWidth) || 0)
  const spacing = Math.max(0, Number(gap) || 0)
  const heights = new Array(count).fill(0)
  const positions = []
  for (const item of Array.isArray(items) ? items : []) {
    // 保存的 col 可能超出当前有效列数：只影响显示（clamp 到最后一列），
    // 不写回/不修改输入值，窗口变宽后磁贴会回到原来的列。
    const requested = Math.max(0, wholeNumber(item?.col))
    const col = Math.min(requested, count - 1)
    const height = Math.max(0, Number(item?.height) || 0)
    const top = heights[col]
    positions.push({
      id: item?.id,
      col,
      requestedCol: requested,
      left: col * (width + spacing),
      top,
      width,
      height
    })
    heights[col] = top + height + spacing
  }
  const tallest = heights.length ? Math.max(...heights) : 0
  return {
    columns: count,
    colWidth: width,
    gap: spacing,
    positions,
    heights,
    height: positions.length ? Math.max(0, tallest - spacing) : 0
  }
}

/**
 * 根据指针 x（容器内坐标）计算目标列。
 * 列间距归左侧列所有：只有越过下一个列起点才会进入下一列。
 */
export function manualTargetColumn(x, { left = 0, colWidth = 0, gap = 0, columns = 1 } = {}) {
  const count = columnCount(columns)
  const width = Number(colWidth)
  if (!Number.isFinite(width) || width <= 0) return 0
  const spacing = Math.max(0, Number(gap) || 0)
  const local = Number(x) - (Number(left) || 0)
  if (!Number.isFinite(local)) return 0
  return clampColumn(Math.floor(local / (width + spacing)), count)
}

/**
 * 根据指针 y（容器内坐标）与目标列内磁贴的中线计算插入位置。
 * 指针在某磁贴中线之上时插到它前面；越过所有中线时追加到列尾。
 *
 * @param {Array<{top?:number, height?:number}>} items 目标列的磁贴（DOM 顺序）
 * @param {number} centerY
 */
export function manualInsertIndex(items, centerY) {
  const list = Array.isArray(items) ? items : []
  const y = Number(centerY)
  if (!Number.isFinite(y)) return list.length
  for (let i = 0; i < list.length; i++) {
    const top = Number(list[i]?.top) || 0
    const height = Math.max(0, Number(list[i]?.height) || 0)
    if (y < top + height / 2) return i
  }
  return list.length
}

/* ------------------------------------------------------------------ */
/* grid                                                                */
/* ------------------------------------------------------------------ */

export class TileGrid {
  constructor(container, {
    onChange,
    animations = true,
    itemSelector = '.tile',
    handleSelector = '.tile-head',
    placeholderClass = 'tile-placeholder',
    masonry = false,
    adaptive = false,
    minColumnWidth = MIN_COLUMN_WIDTH,
    onColumnsChange
  } = {}) {
    this.container = container
    this.onChange = onChange || (() => {})
    this.onColumnsChange = onColumnsChange || null
    this.animations = animations
    this.itemSelector = itemSelector
    this.handleSelector = handleSelector
    this.placeholderClass = placeholderClass
    // `masonry` selects the absolute-positioned grid; `adaptive` picks the
    // shortest-column algorithm inside it. Manual column layout is the default.
    this.masonry = !!masonry
    this.adaptive = !!adaptive
    this.minColumnWidth = minColumnWidth
    this.layoutRaf = null
    this._pendingAnimate = false
    this.resizeObserver = null
    this.drag = null
    this.lastDragEnd = 0
    this.columns = 1
    this._lastWidth = -1
    this._flipTimer = 0
    this._onResize = () => this._scheduleLayout()
    this._onDown = (e) => this._down(e)

    if (this.masonry) {
      container.classList.add('masonry-grid')
      if (typeof ResizeObserver === 'function') {
        // The container's own height is written by the layout pass, so height
        // changes on the container itself must be ignored (otherwise loop).
        // Tile height changes (async content, collapse, data arriving) do need
        // a reflow even when the container width did not change.
        this.resizeObserver = new ResizeObserver((entries) => {
          const width = this.container.clientWidth
          if (width !== this._lastWidth) {
            this._lastWidth = width
            this._scheduleLayout()
            return
          }
          if (entries.some((entry) => entry.target !== this.container)) this._scheduleLayout()
        })
        this.resizeObserver.observe(container)
      }
      window.addEventListener('resize', this._onResize)
    }
    container.addEventListener('pointerdown', this._onDown)
  }

  /** 'flow' | 'manual' | 'adaptive' */
  get mode() {
    if (!this.masonry) return 'flow'
    return this.adaptive ? 'adaptive' : 'manual'
  }

  setAnimations(v) {
    this.animations = !!v
  }

  // Switching modes only changes the arrangement: `data-col` is kept, the
  // layout order and the mounted tiles stay exactly as they are.
  setAdaptive(v) {
    const next = !!v
    if (next === this.adaptive) return
    this.adaptive = next
    this._scheduleLayout(true)
  }

  mount(el, beforeId) {
    if (beforeId) {
      const ref = this.container.querySelector(`[data-id="${beforeId}"]`)
      if (ref) {
        this.container.insertBefore(el, ref)
        this._observe(el)
        this._scheduleLayout()
        return
      }
    }
    this.container.appendChild(el)
    this._observe(el)
    this._scheduleLayout()
  }

  remove(id) {
    const el = this.container.querySelector(`[data-id="${id}"]`)
    if (el) {
      this.resizeObserver?.unobserve(el)
      el.remove()
      this._scheduleLayout()
    }
  }

  get(id) {
    return this.container.querySelector(`[data-id="${id}"]`)
  }

  order() {
    return Array.from(this.container.children)
      .filter((c) => c.dataset && c.dataset.id)
      .map((c) => c.dataset.id)
  }

  setOrder(ids) {
    const map = new Map(Array.from(this.container.children).map((c) => [c.dataset.id, c]))
    for (const id of ids) {
      const el = map.get(id)
      if (el) this.container.appendChild(el)
    }
    this._scheduleLayout()
  }

  relayout() {
    this._scheduleLayout()
  }

  destroy() {
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    window.removeEventListener('resize', this._onResize)
    this.container.removeEventListener('pointerdown', this._onDown)
    this._endDrag()
  }

  /* ---------------- layout ---------------- */

  _observe(el) {
    if (this.masonry) this.resizeObserver?.observe(el)
  }

  _scheduleLayout(animate = false) {
    if (!this.masonry) return
    this._pendingAnimate = this._pendingAnimate || animate
    if (this.layoutRaf !== null) return
    this.layoutRaf = requestAnimationFrame(() => {
      const animateNext = this._pendingAnimate
      this.layoutRaf = null
      this._pendingAnimate = false
      this._layout({ animate: animateNext })
    })
  }

  _layout(options = {}) {
    if (!this.masonry) return
    if (this.adaptive) this._layoutMasonry(options)
    else this._layoutManual(options)
  }

  // Effective column count: the user picks a maximum, the width decides what
  // really fits. This is what makes the bench adapt while the window is resized.
  _metrics() {
    const styles = getComputedStyle(this.container)
    const gap = Number.parseFloat(styles.columnGap || styles.gap) || 0
    const width = this.container.clientWidth
    const preferred = Math.max(1, Number.parseInt(styles.getPropertyValue('--tile-cols'), 10) || 1)
    const fit = Math.max(1, Math.floor((width + gap) / (this.minColumnWidth + gap)))
    const columns = Math.max(1, Math.min(preferred, fit))
    const colWidth = Math.max(0, (width - gap * (columns - 1)) / columns)
    return { columns, colWidth, gap, width, preferred }
  }

  _noteColumns(columns, preferred) {
    if (columns === this.columns) return
    this.columns = columns
    this.onColumnsChange?.(columns, preferred)
  }

  _layoutChildren() {
    return Array.from(this.container.children).filter((el) => {
      // Exclude both the active drag and a tile that is still gliding into its
      // slot: otherwise starting a second drag inside the FLIP window counted
      // the settling tile twice (its placeholder is still in the DOM).
      if (el === this.drag?.el || el === this._settlingEl) return false
      return el.matches?.(this.itemSelector) || el.classList?.contains(this.placeholderClass)
    })
  }

  // The requested column of a tile (0-based). Values outside the effective
  // range are clamped by the layout, never rewritten here.
  _colOf(el) {
    const n = Number.parseInt(el?.dataset?.col, 10)
    return Number.isFinite(n) ? Math.max(0, n) : 0
  }

  _clearFlip() {
    clearTimeout(this._flipTimer)
    this._flipTimer = 0
    const dragging = this.drag?.el
    for (const el of this.container.children) {
      // Never touch the tile under the pointer: its transform is the drag.
      if (el === dragging || !el.style) continue
      el.style.transition = ''
      el.style.transform = ''
    }
  }

  // Manual columns: widths first (one forced layout), then every tile is
  // stacked inside its own column. Columns are independent by construction, so
  // a tile moving inside column 0 cannot change the coordinates of column 1.
  _layoutManual({ animate = false } = {}) {
    if (!this.masonry) return
    const children = this._layoutChildren()
    if (!children.length) {
      this.container.style.height = ''
      return
    }
    const { columns, colWidth, gap, preferred } = this._metrics()
    if (!width(colWidth)) return
    this._noteColumns(columns, preferred)

    const before = animate ? new Map(children.map((el) => [el, el.getBoundingClientRect()])) : null
    this._clearFlip()

    for (const el of children) el.style.width = colWidth + 'px'

    const layout = manualLayout(
      children.map((el) => ({
        id: el.dataset?.id || '',
        col: this._colOf(el),
        height: el.offsetHeight
      })),
      { columns, colWidth, gap }
    )
    for (let i = 0; i < children.length; i++) {
      const pos = layout.positions[i]
      children[i].style.left = pos.left + 'px'
      children[i].style.top = pos.top + 'px'
    }
    this.container.style.height = layout.height + 'px'
    this.container.classList.add('is-laid-out')
    if (before) this._flip(before)
  }

  _layoutMasonry({ animate = false } = {}) {
    if (!this.masonry) return
    const children = this._layoutChildren()
    if (!children.length) {
      this.container.style.height = ''
      return
    }
    const { columns, colWidth, gap, preferred } = this._metrics()
    if (!width(colWidth)) return
    this._noteColumns(columns, preferred)

    // Capture where the tiles are *right now* — including any FLIP transform
    // still in flight — before the layout is rewritten. Measuring after
    // _clearFlip() snapped mid-animation tiles onto their final slot and made
    // the whole grid twitch on every fast swap.
    const before = animate ? new Map(children.map((el) => [el, el.getBoundingClientRect()])) : null
    this._clearFlip()

    // Set every width first, then read every height: one forced layout, and all
    // heights are measured at their final width (measuring mid-transition used
    // to place tiles on top of each other).
    for (const el of children) el.style.width = colWidth + 'px'

    const heights = new Array(columns).fill(0)
    const targets = []
    for (const el of children) {
      const h = el.offsetHeight
      let column = 0
      for (let i = 1; i < columns; i++) {
        if (heights[i] < heights[column]) column = i
      }
      const top = heights[column]
      targets.push({ el, left: column * (colWidth + gap), top })
      heights[column] = top + h + gap
    }
    for (const t of targets) {
      t.el.style.left = t.left + 'px'
      t.el.style.top = t.top + 'px'
    }
    this.container.style.height = Math.max(0, Math.max(...heights) - gap) + 'px'
    this.container.classList.add('is-laid-out')
    if (before) this._flip(before)
  }

  // FLIP: put every tile back where it was with a transform, then let it glide
  // to its new position. Only transform/opacity are animated, so this stays on
  // the compositor and never fights with the layout.
  _flip(before) {
    if (!this.animations) return
    const moved = []
    for (const [el, b] of before) {
      if (!el.isConnected) continue
      const a = el.getBoundingClientRect()
      const dx = b.left - a.left
      const dy = b.top - a.top
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
      moved.push({ el, dx, dy })
    }
    if (!moved.length) return
    for (const m of moved) {
      m.el.style.transition = 'none'
      m.el.style.transform = `translate(${m.dx}px, ${m.dy}px)`
    }
    void this.container.offsetWidth // commit the start position
    for (const m of moved) {
      m.el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(.2,.7,.3,1)`
      m.el.style.transform = ''
    }
    clearTimeout(this._flipTimer)
    this._flipTimer = setTimeout(() => {
      this._flipTimer = 0
      for (const m of moved) {
        m.el.style.transition = ''
        m.el.style.transform = ''
      }
    }, FLIP_MS + 40)
  }

  /* ---------------- dragging ---------------- */

  _down(e) {
    if (e.button !== undefined && e.button !== 0) return
    if (this.drag) return
    const el = e.target.closest?.(this.itemSelector)
    if (!el || !this.container.contains(el)) return
    if (!e.target.closest(this.handleSelector)) return
    if (e.target.closest('button, input, select, textarea, a, label, [data-nodrag]')) return

    const pointerId = e.pointerId
    const startX = e.clientX
    const startY = e.clientY
    let started = false

    const move = (ev) => {
      if (pointerId !== undefined && ev.pointerId !== undefined && ev.pointerId !== pointerId) return
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
        started = true
        this._startDrag(el, startX, startY)
      }
      this._queueMove(ev.clientX, ev.clientY)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', up)
      if (started) this._endDrag()
    }
    const onKey = (ev) => {
      if (ev.key !== 'Escape' || !started) return
      ev.preventDefault()
      this._cancelDrag()
      up()
    }
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', up)
  }

  _startDrag(el, x, y) {
    const rect = el.getBoundingClientRect()
    const ph = document.createElement('div')
    ph.className = this.placeholderClass + ' ' + (el.className.match(/span-\d/g) || []).join(' ')
    ph.style.height = rect.height + 'px'
    ph.style.minHeight = rect.height + 'px'
    this.container.insertBefore(ph, el)

    // The placeholder carries the column it currently represents so the manual
    // layout can treat it like any other child.
    const startCol = this._colOf(el)
    const originCol = el.dataset?.col === undefined ? null : String(el.dataset.col)
    ph.dataset.col = String(startCol)
    const prevStyle = {}
    for (const k of ['width', 'height', 'left', 'top', 'transform', 'transition', 'zIndex', 'pointerEvents']) {
      prevStyle[k] = el.style[k]
    }
    this.drag = {
      el,
      ph,
      prevStyle,
      originNext: ph.nextSibling,
      originCol,
      originRequestedCol: startCol,
      startColumns: this._metrics().columns,
      targetCol: startCol,
      manualCol: -1,
      manualIndex: -1,
      cancelled: false,
      offsetX: x - rect.left,
      offsetY: y - rect.top,
      width: rect.width,
      height: rect.height,
      pointerX: x,
      pointerY: y,
      lastX: x,
      lastY: y,
      lastSwapX: x,
      lastSwapY: y,
      frame: 0,
      scroller: this._scroller(),
      prevScrollBehavior: ''
    }

    if (this.drag.scroller) {
      this.drag.prevScrollBehavior = this.drag.scroller.style.scrollBehavior
      // Smooth scrolling fights the per-frame auto-scroll: make it instant.
      this.drag.scroller.style.scrollBehavior = 'auto'
    }

    el.style.width = rect.width + 'px'
    el.style.height = rect.height + 'px'
    el.style.left = '0px'
    el.style.top = '0px'
    el.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`
    el.classList.add('dragging')
    this.container.classList.add('is-dragging')
    document.body.classList.add('dragging-tile')
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'grabbing'
    // Lay the grid out once with the placeholder already in the tile's slot.
    // Without this the placeholder sits at 0,0 until the first swap and then
    // flies across the grid as part of that FLIP, and the removed tile leaves
    // an unpacked hole behind.
    this._layout({ animate: false })
  }

  _queueMove(x, y) {
    const d = this.drag
    if (!d) return
    d.pointerX = x
    d.pointerY = y
    if (d.frame) return
    d.frame = requestAnimationFrame(() => this._frame())
  }

  _frame() {
    const d = this.drag
    if (!d) return
    d.frame = 0
    const x = d.pointerX
    const y = d.pointerY

    // 1:1 tracking: the tile follows the pointer exactly, one write per frame.
    d.el.style.transform = `translate3d(${x - d.offsetX}px, ${y - d.offsetY}px, 0)`

    const scrolled = this._autoScroll(d, y)
    if (scrolled || Math.abs(x - d.lastX) + Math.abs(y - d.lastY) >= 3) {
      d.lastX = x
      d.lastY = y
      this._evalTarget(d, x, y, scrolled)
    }
    if (scrolled) d.frame = requestAnimationFrame(() => this._frame())
  }

  _scroller() {
    let el = this.container.parentElement
    while (el && el !== document.body) {
      const style = getComputedStyle(el)
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) return el
      el = el.parentElement
    }
    return null
  }

  _autoScroll(d, y) {
    const sc = d.scroller
    if (!sc) return false
    const r = sc.getBoundingClientRect()
    let delta = 0
    if (y < r.top + AUTOSCROLL_EDGE) delta = -Math.min(AUTOSCROLL_MAX, (r.top + AUTOSCROLL_EDGE - y) * 0.55)
    else if (y > r.bottom - AUTOSCROLL_EDGE) delta = Math.min(AUTOSCROLL_MAX, (y - (r.bottom - AUTOSCROLL_EDGE)) * 0.55)
    if (!delta) return false
    const before = sc.scrollTop
    sc.scrollTop = before + delta
    return sc.scrollTop !== before
  }

  _evalTarget(d, x, y, force = false) {
    // A few pixels of travel are required before the placeholder may swap
    // slots again; without it the pointer noise alone kept re-evaluating.
    if (!force && Math.hypot(x - d.lastSwapX, y - d.lastSwapY) < 8) return
    // A flow grid (monitor cards) is laid out by the browser: inserting the
    // placeholder is enough, so keep hit-testing the live rectangles there.
    if (!this.masonry) return this._evalFlowTarget(d, x, y)
    if (this.adaptive) return this._evalMasonryTarget(d, x, y)
    return this._evalManualTarget(d, x, y)
  }

  // Manual columns: column from pointer x, insert index from pointer y against
  // the midlines of the target column only. Other columns are never touched.
  _evalManualTarget(d, x, y) {
    const metrics = this._metrics()
    if (!width(metrics.colWidth)) return
    const rect = this.container.getBoundingClientRect()
    const column = manualTargetColumn(x - rect.left, metrics)
    const pointerY = y - rect.top

    const items = []
    for (const el of this.container.children) {
      if (el === d.el || el === d.ph) continue
      if (!el.matches?.(this.itemSelector)) continue
      if (clampColumn(this._colOf(el), metrics.columns) !== column) continue
      items.push(el)
    }

    // Midlines of the target column without the placeholder: stable boundaries
    // that do not move under the pointer every time the placeholder moves.
    const boxes = []
    let top = 0
    for (const el of items) {
      const h = el.offsetHeight
      boxes.push({ top, height: h })
      top += h + metrics.gap
    }
    const index = manualInsertIndex(boxes, pointerY)
    if (column === d.manualCol && index === d.manualIndex) return

    // Insert into the target column at the computed position. Inserting before
    // the tile that should follow keeps the column order without re-ordering
    // any other column.
    let ref = null
    if (index < items.length) ref = items[index]
    else if (items.length) ref = items[items.length - 1].nextSibling

    d.manualCol = column
    d.manualIndex = index
    d.targetCol = column
    d.ph.dataset.col = String(column)
    if (ref !== d.ph) this.container.insertBefore(d.ph, ref)
    d.lastSwapX = x
    d.lastSwapY = y
    this._layout({ animate: this.animations })
  }

  _evalMasonryTarget(d, x, y) {
    const items = []
    let current = 0
    for (const el of this.container.children) {
      if (el === d.el) continue
      if (el === d.ph) {
        current = items.length
        continue
      }
      if (el.matches?.(this.itemSelector)) items.push(el)
    }
    if (!items.length) return

    const { columns, colWidth, gap } = this._metrics()
    if (!width(colWidth)) return

    // The dragged tile in container coordinates. offsetX/offsetY are fixed for
    // the whole drag, so this only depends on the pointer.
    const rect = this.container.getBoundingClientRect()
    const cx = x - d.offsetX - rect.left + d.width / 2
    const cy = y - d.offsetY - rect.top + d.height / 2

    // Walk the tiles in DOM order while tracking the masonry column heights.
    // The slot for inserting at index i is the shortest column just before
    // tile i — that is exactly where the real layout will put the placeholder,
    // so the score never depends on the currently animated rectangles.
    const heights = new Array(columns).fill(0)
    let best = current
    let bestScore = Infinity
    for (let i = 0; i <= items.length; i++) {
      let column = 0
      for (let c = 1; c < columns; c++) {
        if (heights[c] < heights[column]) column = c
      }
      const top = heights[column]
      const dx = cx - (column * (colWidth + gap) + colWidth / 2)
      const dy = cy - (top + d.height / 2)
      let score = Math.hypot(dx, dy)
      // Stay put unless another slot is clearly closer.
      if (i === current) score -= SWAP_BIAS
      if (score < bestScore) {
        bestScore = score
        best = i
      }
      if (i === items.length) break
      heights[column] = top + items[i].offsetHeight + gap
    }

    if (best === current) return
    this.container.insertBefore(d.ph, items[best] || null)
    d.lastSwapX = x
    d.lastSwapY = y
    this._layout({ animate: this.animations })
  }

  // Flow layouts (e.g. the latency-monitor cards) reorder themselves when the
  // placeholder is inserted, so the nearest card under the pointer is still the
  // right target. No transforms are involved here, so the rectangles are exact.
  _evalFlowTarget(d, x, y) {
    const items = Array.from(this.container.children).filter((el) => {
      if (el === d.el || el === d.ph) return false
      return el.matches?.(this.itemSelector)
    })
    if (!items.length) return

    const cx = x - d.offsetX + d.width / 2
    const cy = y - d.offsetY + d.height / 2
    let best = -1
    let bestDist = Infinity
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect()
      const dx = cx - (r.left + r.width / 2)
      const dy = cy - (r.top + r.height / 2)
      const dist = Math.hypot(dx, dy * 1.8)
      if (dist < bestDist) {
        bestDist = dist
        best = i
      }
    }
    if (best < 0) return
    const r = items[best].getBoundingClientRect()
    const after = cx > r.left + r.width / 2
    const ref = after ? items[best].nextSibling : items[best]
    if (ref === d.ph) return
    if (!after && items[best].previousSibling === d.ph) return

    this.container.insertBefore(d.ph, ref)
    d.lastSwapX = x
    d.lastSwapY = y
  }

  _restoreDragStyles(d) {
    d.el.classList.remove('dragging')
    d.el.classList.remove('dropping')
    for (const k of Object.keys(d.prevStyle)) d.el.style[k] = d.prevStyle[k]
    if (d.ph.parentNode) d.ph.remove()
    if (d.scroller) d.scroller.style.scrollBehavior = d.prevScrollBehavior || ''
    // A new drag may have started while the previous tile was still settling;
    // in that case the new drag owns the body/container state.
    if (this.drag) return
    this.container.classList.remove('is-dragging')
    document.body.classList.remove('dragging-tile')
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }

  _cancelDrag() {
    const d = this.drag
    if (!d) return
    if (d.frame) cancelAnimationFrame(d.frame)
    d.frame = 0
    d.cancelled = true
    if (d.originNext && d.originNext.parentNode === this.container) {
      this.container.insertBefore(d.ph, d.originNext)
    }
    this._finishDrag(d)
  }

  _endDrag() {
    const d = this.drag
    if (!d) return
    if (d.frame) cancelAnimationFrame(d.frame)
    d.frame = 0
    this._finishDrag(d)
  }

  // Manual mode: persist the requested column on drop (or restore the original
  // one on cancel). Clamped display columns never overwrite data-col.
  _commitManualColumn(d) {
    if (!this.masonry || this.adaptive) return
    if (d.cancelled) {
      if (d.originCol === null || d.originCol === undefined) delete d.el.dataset.col
      else d.el.dataset.col = String(d.originCol)
      return
    }
    const requested = Math.max(0, Number(d.originRequestedCol) || 0)
    const startColumns = Math.max(1, Number(d.startColumns) || 1)
    const startDisplay = Math.min(requested, startColumns - 1)
    // The tile was saved in a column beyond the current narrow viewport and the
    // user only reordered inside that clamped display column. Keep the original
    // deep column so widening the window restores it.
    if (requested > startColumns - 1 && d.targetCol === startDisplay) {
      d.el.dataset.col = String(requested)
      return
    }
    d.el.dataset.col = String(d.targetCol)
  }

  // Adaptive mode also records the column the tile landed in, so switching
  // back to manual restores a meaningful arrangement.
  _rememberAdaptiveColumn(el) {
    const { columns, colWidth, gap } = this._metrics()
    const left = Number.parseFloat(el.style.left)
    const pitch = colWidth + gap
    if (!width(colWidth) || !Number.isFinite(left) || pitch <= 0) return
    el.dataset.col = String(Math.min(columns - 1, Math.max(0, Math.round(left / pitch))))
  }

  _finishDrag(d) {
    if (!d || this._finishing) return
    this._finishing = d
    const phRect = d.ph.getBoundingClientRect()
    const elRect = d.el.getBoundingClientRect()
    const moved = Math.hypot(phRect.left - elRect.left, phRect.top - elRect.top) > 1.5
    const animate = this.animations && moved

    const settle = () => {
      this._finishing = null
      this._settlingEl = null
      // Put the tile back where the placeholder is *before* the placeholder is
      // removed; insertBefore needs a reference that is still a child.
      if (d.ph.parentNode === this.container) this.container.insertBefore(d.el, d.ph)
      this._commitManualColumn(d)
      this._restoreDragStyles(d)
      d.ph.remove()
      this.lastDragEnd = Date.now()
      this._layout({ animate: false })
      if (this.masonry && this.adaptive) this._rememberAdaptiveColumn(d.el)
      this.onChange(this.order())
    }

    this.drag = null
    if (!animate) {
      settle()
      return
    }
    // Let the tile glide into its slot instead of teleporting on mouse-up.
    this._settlingEl = d.el
    d.el.classList.remove('dragging')
    d.el.classList.add('dropping')
    d.el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(.2,.7,.3,1), width ${FLIP_MS}ms ease, height ${FLIP_MS}ms ease`
    d.el.style.width = phRect.width + 'px'
    d.el.style.height = phRect.height + 'px'
    d.el.style.transform = `translate3d(${phRect.left}px, ${phRect.top}px, 0)`
    let done = false
    const onEnd = () => {
      if (done) return
      done = true
      d.el.removeEventListener('transitionend', onEnd)
      settle()
    }
    d.el.addEventListener('transitionend', onEnd)
    setTimeout(onEnd, FLIP_MS + 60)
  }
}

function width(v) {
  return Number.isFinite(v) && v > 0
}
