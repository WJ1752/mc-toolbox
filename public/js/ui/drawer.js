import { h, clear } from '../core/dom.js'
import { icon } from './icons.js'

let openApi = null

/**
 * Right-side task drawer. `render` receives the body element and may return
 * a count to display in the header.
 */
export function openDrawer({ title = '任务', render, footer = null, onClose = null, width = '' } = {}) {
  closeDrawer()
  const root = document.getElementById('drawerRoot')
  if (!root) return null
  const titleEl = document.getElementById('drawerTitle')
  const countEl = document.getElementById('drawerCount')
  const body = document.getElementById('drawerBody')
  const foot = document.getElementById('drawerFoot')
  const drawer = root.querySelector('.drawer')
  if (titleEl) titleEl.textContent = title
  if (width) drawer.style.width = typeof width === 'number' ? width + 'px' : width
  else drawer.style.width = ''
  clear(body)
  clear(foot)
  if (footer) foot.appendChild(footer)
  root.hidden = false

  const api = {
    body,
    foot,
    setTitle(t) { if (titleEl) titleEl.textContent = t },
    setCount(n) {
      if (!countEl) return
      countEl.textContent = String(n ?? 0)
      countEl.hidden = !n
    },
    setFooter(node) { clear(foot); if (node) foot.appendChild(node) },
    close: closeDrawer
  }
  openApi = { api, onClose }
  try {
    const count = render?.(body, api)
    if (typeof count === 'number') api.setCount(count)
  } catch (e) {
    body.appendChild(h('div', { class: 'error-state' }, '渲染失败：' + e.message))
  }
  return api
}

export function closeDrawer() {
  const root = document.getElementById('drawerRoot')
  if (!root || root.hidden) return
  root.hidden = true
  const body = document.getElementById('drawerBody')
  const foot = document.getElementById('drawerFoot')
  if (body) clear(body)
  if (foot) clear(foot)
  const cb = openApi?.onClose
  openApi = null
  try { cb?.() } catch {}
}

export function isDrawerOpen() {
  const root = document.getElementById('drawerRoot')
  return !!root && !root.hidden
}

document.getElementById('drawerRoot')?.addEventListener('click', (e) => {
  if (e.target.closest('[data-drawer-close]')) closeDrawer()
})
document.getElementById('drawerClose')?.addEventListener('click', closeDrawer)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isDrawerOpen()) {
    e.preventDefault()
    e.stopImmediatePropagation()
    closeDrawer()
  }
}, true)

// re-export for convenience
export { icon }
