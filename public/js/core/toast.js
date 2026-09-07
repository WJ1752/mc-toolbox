import { h } from './dom.js'

const root = () => document.getElementById('toastRoot')

export function toast(message, type = 'info', ms = 2600) {
  const el = h('div', { class: 'toast ' + (type || '') }, message)
  root().appendChild(el)
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s'
    el.style.opacity = '0'
    el.style.transform = 'translateX(16px)'
    setTimeout(() => el.remove(), 260)
  }, ms)
  return el
}
