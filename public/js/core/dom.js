// 极简 DOM / 格式化工具
export function h(tag, props, ...children) {
  const el = document.createElement(tag)
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
      else if (k === 'html') el.innerHTML = v
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
      else if (k === 'dataset') Object.assign(el.dataset, v)
      else el.setAttribute(k, v === true ? '' : v)
    }
  }
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)))
  }
  return el
}

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild)
  return el
}

export function fmtTime(ts, use12h = false) {
  if (!ts) return '--:--:--'
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  let hh = p(d.getHours())
  let suffix = ''
  if (use12h) {
    const h24 = d.getHours()
    suffix = h24 >= 12 ? ' PM' : ' AM'
    hh = String(((h24 + 11) % 12) + 1)
  }
  return `${hh}:${p(d.getMinutes())}:${p(d.getSeconds())}${suffix}`
}

export function fmtDateTime(ts, use12h = false) {
  if (!ts) return '--'
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  let hh = p(d.getHours())
  let suffix = ''
  if (use12h) {
    const h24 = d.getHours()
    suffix = h24 >= 12 ? ' PM' : ' AM'
    hh = String(((h24 + 11) % 12) + 1)
  }
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hh}:${p(d.getMinutes())}${suffix}`
}

export function fmtAgo(ts) {
  if (!ts) return '从未'
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return s + ' 秒前'
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前'
  return Math.floor(s / 86400) + ' 天前'
}

export function fmtBytes(n) {
  if (!n && n !== 0) return '-'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return s + ' 秒'
  if (s < 3600) return Math.floor(s / 60) + ' 分'
  if (s < 86400) return (s / 3600).toFixed(1) + ' 小时'
  return (s / 86400).toFixed(1) + ' 天'
}

export function debounce(fn, ms = 300) {
  let t
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}
