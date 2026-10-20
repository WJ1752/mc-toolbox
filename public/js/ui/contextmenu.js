import { h, clear } from '../core/dom.js'
import { icon } from './icons.js'

let current = null

/** Context menu anchored at viewport coordinates. */
export function openContextMenu({ x = 0, y = 0, items = [], label = '' } = {}) {
  closeContextMenu()
  const root = document.getElementById('contextRoot')
  if (!root) return { close: closeContextMenu }
  clear(root)
  const menu = h('div', { class: 'ctx-menu', role: 'menu', 'aria-label': label || '操作菜单' })
  if (label) menu.appendChild(h('div', { class: 'ctx-label' }, label))

  for (const item of items) {
    if (!item) continue
    if (item.separator) {
      menu.appendChild(h('div', { class: 'ctx-sep' }))
      continue
    }
    const b = h('button', {
      class: 'ctx-item' + (item.danger ? ' danger' : ''),
      type: 'button',
      role: 'menuitem',
      disabled: !!item.disabled,
      title: item.title || ''
    },
      item.iconName ? icon(item.iconName, { size: 14 }) : h('span', { style: { width: '14px' } }),
      h('span', {}, item.label),
      item.hint ? h('span', { class: 'ctx-hint' }, item.hint) : null
    )
    b.addEventListener('click', () => {
      closeContextMenu()
      item.onClick?.()
    })
    menu.appendChild(b)
  }

  root.appendChild(menu)
  root.hidden = false
  const rect = menu.getBoundingClientRect()
  const px = Math.min(Math.max(6, x), window.innerWidth - rect.width - 6)
  const py = Math.min(Math.max(6, y), window.innerHeight - rect.height - 6)
  menu.style.left = px + 'px'
  menu.style.top = py + 'px'
  current = { menu }
  requestAnimationFrame(() => menu.querySelector('.ctx-item:not([disabled])')?.focus({ preventScroll: true }))
  return { close: closeContextMenu }
}

export function closeContextMenu() {
  const root = document.getElementById('contextRoot')
  if (!root) return
  root.hidden = true
  clear(root)
  current = null
}

window.addEventListener('pointerdown', (e) => {
  if (!current) return
  if (!e.target.closest?.('.ctx-menu')) closeContextMenu()
}, true)
window.addEventListener('keydown', (e) => {
  if (!current) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopImmediatePropagation()
    closeContextMenu()
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const items = Array.from(current.menu.querySelectorAll('.ctx-item:not([disabled])'))
    if (!items.length) return
    e.preventDefault()
    const idx = items.indexOf(document.activeElement)
    const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length
    items[next].focus()
  }
}, true)
window.addEventListener('blur', closeContextMenu)
