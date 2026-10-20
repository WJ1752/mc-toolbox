// Masonry tile grid — pointer dragging, FLIP reflow, no dependencies.
const DRAG_THRESHOLD = 5

export class TileGrid {
  constructor(container, {
    onChange,
    animations = true,
    itemSelector = '.tile',
    handleSelector = '.tile-head',
    placeholderClass = 'tile-placeholder',
    masonry = false
  } = {}) {
    this.container = container
    this.onChange = onChange || (() => {})
    this.animations = animations
    this.itemSelector = itemSelector
    this.handleSelector = handleSelector
    this.placeholderClass = placeholderClass
    this.masonry = !!masonry
    this.layoutRaf = null
    this.resizeObserver = null
    this.dragging = null
    this.lastDragEnd = 0
    this._onResize = () => this._scheduleLayout()
    this._onDown = (e) => this._down(e)

    if (this.masonry) {
      container.classList.add('masonry-grid')
      this.resizeObserver = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => this._scheduleLayout())
        : null
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
  }

  _observe(el) {
    if (this.masonry) this.resizeObserver?.observe(el)
  }

  _scheduleLayout() {
    if (!this.masonry || this.layoutRaf !== null) return
    this.layoutRaf = requestAnimationFrame(() => {
      this.layoutRaf = null
      this._layoutMasonry()
    })
  }

  _columns() {
    const styles = getComputedStyle(this.container)
    return Math.max(1, Number.parseInt(styles.getPropertyValue('--tile-cols'), 10) || 1)
  }

  _layoutMasonry() {
    if (!this.masonry) return
    const children = Array.from(this.container.children).filter((el) => {
      if (el === this.dragging?.el) return false
      return el.matches?.(this.itemSelector) || el.classList?.contains(this.placeholderClass)
    })
    if (!children.length) {
      this.container.style.height = ''
      return
    }
    const styles = getComputedStyle(this.container)
    const columns = this._columns()
    const gap = Number.parseFloat(styles.columnGap || styles.gap) || 0
    const width = this.container.clientWidth
    if (!width) return
    const colWidth = Math.max(0, (width - gap * (columns - 1)) / columns)
    const heights = Array.from({ length: columns }, () => 0)

    for (const el of children) {
      el.style.width = colWidth + 'px'
      el.style.left = '0px'
      el.style.top = '0px'
    }
    for (const el of children) {
      let column = 0
      for (let i = 1; i < heights.length; i++) {
        if (heights[i] < heights[column]) column = i
      }
      const top = heights[column]
      const height = el.getBoundingClientRect().height
      el.style.left = `${column * (colWidth + gap)}px`
      el.style.top = `${top}px`
      heights[column] = top + height + gap
    }
    this.container.style.height = Math.max(0, Math.max(...heights) - gap) + 'px'
  }

  _down(e) {
    if (e.button !== undefined && e.button !== 0) return
    const el = e.target.closest?.(this.itemSelector)
    if (!el || !this.container.contains(el)) return
    const handle = e.target.closest(this.handleSelector)
    if (!handle) return
    if (e.target.closest('button, input, select, textarea, a, label, [data-nodrag]')) return

    const startX = e.clientX
    const startY = e.clientY
    let started = false

    const move = (ev) => {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
        started = true
        this._start(el, startX, startY)
      }
      this._move(ev)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (started) this._end()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  _start(el, x, y) {
    const rect = el.getBoundingClientRect()
    const ph = document.createElement('div')
    ph.className = this.placeholderClass + ' ' + (el.className.match(/span-\d/g) || []).join(' ')
    ph.style.height = rect.height + 'px'
    ph.style.minHeight = rect.height + 'px'
    this.container.insertBefore(ph, el)

    const prevStyle = ['width', 'height', 'left', 'top', 'position', 'zIndex', 'transform'].reduce((acc, k) => {
      acc[k] = el.style[k]
      return acc
    }, {})
    this.dragging = {
      el,
      ph,
      prevStyle,
      offsetX: x - rect.left,
      offsetY: y - rect.top,
      width: rect.width,
      height: rect.height
    }
    el.dataset.w = rect.width
    el.style.width = rect.width + 'px'
    el.style.height = rect.height + 'px'
    el.style.left = rect.left + 'px'
    el.style.top = rect.top + 'px'
    el.classList.add('dragging')
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'grabbing'
  }

  _move(ev) {
    const d = this.dragging
    if (!d) return
    const left = ev.clientX - d.offsetX
    const top = ev.clientY - d.offsetY
    d.el.style.left = left + 'px'
    d.el.style.top = top + 'px'

    const ws = this.container.parentElement
    if (ws && ws.scrollHeight > ws.clientHeight) {
      const r = ws.getBoundingClientRect()
      if (ev.clientY < r.top + 60) ws.scrollTop -= 12
      else if (ev.clientY > r.bottom - 60) ws.scrollTop += 12
    }

    const cx = left + d.width / 2
    const cy = top + d.height / 2
    const items = Array.from(this.container.children).filter((c) => c !== d.el && c !== d.ph)
    if (!items.length) return

    let best = null
    let bestDist = Infinity
    for (const it of items) {
      const r = it.getBoundingClientRect()
      const ix = r.left + r.width / 2
      const iy = r.top + r.height / 2
      const dist = Math.hypot(cx - ix, (cy - iy) * 2.2)
      if (dist < bestDist) {
        bestDist = dist
        best = { it, r, ix }
      }
    }
    if (!best) return
    const after = cx > best.ix
    const ref = after ? best.it.nextSibling : best.it
    if (ref === d.ph) return
    if (!after && best.it.previousSibling === d.ph) return

    if (this.animations) {
      const before = new Map(items.map((i) => [i, i.getBoundingClientRect()]))
      this.container.insertBefore(d.ph, ref)
      for (const it of items) {
        const b = before.get(it)
        const a = it.getBoundingClientRect()
        const dx = b.left - a.left
        const dy = b.top - a.top
        if (!dx && !dy) continue
        it.classList.add('flip')
        it.style.transition = 'none'
        it.style.transform = `translate(${dx}px, ${dy}px)`
        requestAnimationFrame(() => {
          it.style.transition = 'transform 170ms cubic-bezier(.2,.7,.3,1)'
          it.style.transform = ''
          setTimeout(() => {
            it.style.transition = ''
            it.style.transform = ''
            it.classList.remove('flip')
          }, 190)
        })
      }
    } else {
      this.container.insertBefore(d.ph, ref)
    }
    this._scheduleLayout()
  }

  _end() {
    const d = this.dragging
    if (!d) return
    this.container.insertBefore(d.el, d.ph)
    d.ph.remove()
    d.el.classList.remove('dragging')
    for (const k of Object.keys(d.prevStyle)) d.el.style[k] = d.prevStyle[k]
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    this.dragging = null
    this.lastDragEnd = Date.now()
    this._scheduleLayout()
    this.onChange(this.order())
  }
}
