// 可拖拽磁贴网格：指针事件 + FLIP 动画，零依赖
const DRAG_THRESHOLD = 4

export class TileGrid {
  constructor(container, { onChange, animations = true, itemSelector = '.tile', handleSelector = '.tile-head', placeholderClass = 'tile-placeholder' } = {}) {
    this.container = container
    this.onChange = onChange || (() => {})
    this.animations = animations
    this.itemSelector = itemSelector
    this.handleSelector = handleSelector
    this.placeholderClass = placeholderClass
    this.dragging = null
    this.lastDragEnd = 0
    container.addEventListener('pointerdown', (e) => this._down(e))
  }

  setAnimations(v) {
    this.animations = !!v
  }

  /** 挂载一个磁贴元素（需带 data-id） */
  mount(el, beforeId) {
    if (beforeId) {
      const ref = this.container.querySelector(`[data-id="${beforeId}"]`)
      if (ref) {
        this.container.insertBefore(el, ref)
        return
      }
    }
    this.container.appendChild(el)
  }

  remove(id) {
    const el = this.container.querySelector(`[data-id="${id}"]`)
    if (el) el.remove()
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
  }

  _down(e) {
    if (e.button !== undefined && e.button !== 0) return
    const el = e.target.closest?.(this.itemSelector)
    if (!el || !this.container.contains(el)) return
    const handle = e.target.closest(this.handleSelector)
    if (!handle) return
    if (e.target.closest('button, input, select, textarea, a, [data-nodrag]')) return

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
    // 只复制横向跨列尺寸。展开磁贴的实际高度由内容决定，不能把
    // 旧的 h-2 标记复制成 grid-row 跨行占位，否则拖动时也会错行。
    ph.className = this.placeholderClass + ' ' + (el.className.match(/span-\d/g) || []).join(' ')
    ph.style.height = rect.height + 'px'
    ph.style.minHeight = rect.height + 'px'
    this.container.insertBefore(ph, el)

    // 记住拖拽前已有的行内尺寸（例如延迟监测的临时自定义宽高/高度策略），结束后原样还原
    const prevStyle = ['width', 'height', 'left', 'top', 'position', 'zIndex'].reduce((acc, k) => {
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
      height: rect.height,
      scrollRaf: null
    }
    el.dataset.w = rect.width
    el.style.width = rect.width + 'px'
    el.style.height = rect.height + 'px'
    el.style.left = rect.left + 'px'
    el.style.top = rect.top + 'px'
    el.classList.add('dragging')
    document.body.style.userSelect = 'none'
  }

  _move(ev) {
    const d = this.dragging
    if (!d) return
    const left = ev.clientX - d.offsetX
    const top = ev.clientY - d.offsetY
    d.el.style.left = left + 'px'
    d.el.style.top = top + 'px'

    // 边缘自动滚动
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
          it.style.transition = 'transform 170ms cubic-bezier(.2,.8,.3,1)'
          it.style.transform = ''
          setTimeout(() => {
            it.style.transition = ''
            it.style.transform = ''
            it.classList.remove('flip')
          }, 200)
        })
      }
    } else {
      this.container.insertBefore(d.ph, ref)
    }
  }

  _end() {
    const d = this.dragging
    if (!d) return
    this.container.insertBefore(d.el, d.ph)
    d.ph.remove()
    d.el.classList.remove('dragging')
    for (const k of Object.keys(d.prevStyle)) d.el.style[k] = d.prevStyle[k]
    document.body.style.userSelect = ''
    this.dragging = null
    this.lastDragEnd = Date.now()
    this.onChange(this.order())
  }
}
