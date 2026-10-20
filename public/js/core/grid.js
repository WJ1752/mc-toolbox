// Masonry tile grid — pointer dragging, FLIP reflow, no dependencies.
//
// Dragging rules (why it is written this way):
//   * the dragged tile is taken out of the flow (position: fixed) and moved with
//     translate3d() once per animation frame — never with left/top, which forces
//     a full layout on every pointermove and made the tile trail the cursor;
//   * pointermove is coalesced into one rAF tick, so a 1000 Hz mouse cannot
//     queue more work than the compositor can show;
//   * the placeholder target is computed from *predicted* masonry slots and the
//     pointer, not from the live tile rectangles: hit-testing rectangles that
//     are still gliding (FLIP) made the "nearest" tile change under a still
//     pointer, so the placeholder kept bouncing between two slots;
//   * the current slot wins ties by a small margin, so the pointer has to enter
//     the next slot clearly before the placeholder moves again;
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

export class TileGrid {
  constructor(container, {
    onChange,
    animations = true,
    itemSelector = '.tile',
    handleSelector = '.tile-head',
    placeholderClass = 'tile-placeholder',
    masonry = false,
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
    this.masonry = !!masonry
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
        // The container observer only cares about width: its own height is set
        // by _layoutMasonry, and reacting to that would loop.
        this.resizeObserver = new ResizeObserver(() => {
          const width = this.container.clientWidth
          if (width === this._lastWidth) return
          this._lastWidth = width
          this._scheduleLayout()
        })
        this.resizeObserver.observe(container)
      }
      window.addEventListener('resize', this._onResize)
    }
    container.addEventListener('pointerdown', this._onDown)
  }

  setAnimations(v) {
    this.animations = !!v
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
      this._layoutMasonry({ animate: animateNext })
    })
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

  _layoutChildren() {
    const dragged = this.drag?.el || this._settlingEl
    return Array.from(this.container.children).filter((el) => {
      if (el === dragged) return false
      return el.matches?.(this.itemSelector) || el.classList?.contains(this.placeholderClass)
    })
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

  _layoutMasonry({ animate = false } = {}) {
    if (!this.masonry) return
    const children = this._layoutChildren()
    if (!children.length) {
      this.container.style.height = ''
      return
    }
    const { columns, colWidth, gap, preferred } = this._metrics()
    if (!width(colWidth)) return
    if (columns !== this.columns) {
      this.columns = columns
      this.onColumnsChange?.(columns, preferred)
    }

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

    const prevStyle = {}
    for (const k of ['width', 'height', 'left', 'top', 'transform', 'transition', 'zIndex', 'pointerEvents']) {
      prevStyle[k] = el.style[k]
    }
    this.drag = {
      el,
      ph,
      prevStyle,
      originNext: ph.nextSibling,
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
    this._layoutMasonry({ animate: false })
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
    this._layoutMasonry({ animate: this.animations })
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
      this._restoreDragStyles(d)
      d.ph.remove()
      this.lastDragEnd = Date.now()
      this._layoutMasonry({ animate: false })
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
