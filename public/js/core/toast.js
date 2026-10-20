import { h } from './dom.js'

const MAX_VISIBLE = 4
const AUTO_MS = { ok: 3200, info: 3200, warn: 4200, err: 5000 }

/**
 * Toast — bottom-right, stacked, non-blocking.
 * @param {string} message
 * @param {'ok'|'err'|'warn'|'info'|''} type
 * @param {number} [ms]
 */
export function toast(message, type = 'info', ms) {
  const root = document.getElementById('toastRoot')
  if (!root) {
    console.warn('[toast]', message)
    return null
  }
  const kind = type === 'error' ? 'err' : type === 'success' ? 'ok' : type || 'info'
  const el = h('div', {
    class: 'toast ' + kind,
    role: kind === 'err' ? 'alert' : 'status',
    'aria-live': kind === 'err' ? 'assertive' : 'polite'
  }, String(message ?? ''))
  while (root.childElementCount >= MAX_VISIBLE) root.firstElementChild?.remove()
  root.appendChild(el)

  let closed = false
  const dismiss = () => {
    if (closed) return
    closed = true
    el.style.transition = 'opacity .18s, transform .18s'
    el.style.opacity = '0'
    el.style.transform = 'translateX(12px)'
    setTimeout(() => el.remove(), 190)
  }
  el.addEventListener('click', dismiss)
  setTimeout(dismiss, ms ?? AUTO_MS[kind] ?? 3200)
  return el
}
