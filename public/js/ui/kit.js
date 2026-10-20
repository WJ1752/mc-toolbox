// Shared UI kit — plain DOM, no framework.
import { h, clear, fmtBytes, fmtAgo, copyText } from '../core/dom.js'
import { icon } from './icons.js'
import { toast } from '../core/toast.js'
import { api } from '../core/api.js'

export { icon }

const VARIANT = {
  primary: 'btn-primary',
  secondary: '',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
  ok: 'btn-ok'
}

/**
 * Button with optional leading icon.
 * @param {string|Node} label
 * @param {{variant?:string,size?:'sm'|'xs'|'',iconName?:string,onClick?:Function,title?:string,disabled?:boolean,type?:string,class?:string}} opts
 */
export function btn(label, opts = {}) {
  const { variant = 'secondary', size = '', iconName = '', onClick, title = '', disabled = false, type = 'button', class: extra = '' } = opts
  const cls = ['btn', VARIANT[variant] || '', size ? 'btn-' + size : '', extra].filter(Boolean).join(' ')
  const node = h('button', { class: cls, type, title, disabled: !!disabled }, iconName ? icon(iconName, { size: 14 }) : null, label)
  if (onClick) node.addEventListener('click', onClick)
  return node
}

/** Icon-only button; always carries aria-label + title. */
export function iconBtn(name, { label, onClick, active = false, size = 16, class: extra = '', disabled = false, title } = {}) {
  const tip = title || label || name
  const node = h('button', {
    class: 'icobtn' + (active ? ' is-active' : '') + (extra ? ' ' + extra : ''),
    type: 'button',
    'aria-label': label || name,
    title: tip,
    disabled: !!disabled
  }, icon(name, { size }))
  if (onClick) node.addEventListener('click', onClick)
  return node
}

export function field(label, control, { hint = '', error = '', id = '', class: extra = '' } = {}) {
  const labelEl = label ? h('label', { for: id || undefined }, label) : null
  const wrap = h('div', { class: 'field' + (extra ? ' ' + extra : '') }, labelEl, control, hint ? h('div', { class: 'hint' }, hint) : null, error ? h('div', { class: 'error' }, error) : null)
  return wrap
}

export function input(opts = {}) {
  const { value = '', placeholder = '', type = 'text', mono = false, readonly = false, disabled = false, min, max, step, list, id, name, onInput, onChange, onKeyDown, class: extra = '', title = '' } = opts
  const node = h('input', {
    class: 'input' + (mono ? ' mono' : '') + (extra ? ' ' + extra : ''),
    type,
    placeholder,
    value: value ?? '',
    readonly: readonly || undefined,
    disabled: !!disabled,
    min, max, step, list, id, name, title
  })
  if (onInput) node.addEventListener('input', onInput)
  if (onChange) node.addEventListener('change', onChange)
  if (onKeyDown) node.addEventListener('keydown', onKeyDown)
  return node
}

export function select(options, value, { id, name, title, onchange, class: extra = '', ariaLabel = '' } = {}) {
  const node = h('select', { class: 'input' + (extra ? ' ' + extra : ''), id, name, title, 'aria-label': ariaLabel || undefined })
  for (const opt of options) {
    const [v, label] = Array.isArray(opt) ? opt : [opt.value, opt.label]
    node.appendChild(h('option', { value: String(v) }, label))
  }
  if (value !== undefined && value !== null) node.value = String(value)
  if (onchange) node.addEventListener('change', () => onchange(node.value, node))
  return node
}

/** Segmented control. Returned node exposes `.value` and `.setValue()`. */
export function seg(options, value, onChange, { title = '', class: extra = '' } = {}) {
  const wrap = h('div', { class: 'seg' + (extra ? ' ' + extra : ''), role: 'tablist', title })
  let current = value
  const buttons = []
  for (const opt of options) {
    const [v, label] = Array.isArray(opt) ? opt : [opt.value, opt.label]
    const b = h('button', { type: 'button', role: 'tab', 'aria-selected': String(v === current), dataset: { v: String(v) } }, label)
    b.addEventListener('click', () => {
      if (current === v) return
      current = v
      sync()
      onChange?.(v)
    })
    buttons.push([v, b])
    wrap.appendChild(b)
  }
  function sync() {
    for (const [v, b] of buttons) {
      const on = v === current
      b.classList.toggle('active', on)
      b.setAttribute('aria-selected', String(on))
    }
  }
  sync()
  Object.defineProperty(wrap, 'value', { get: () => current, set: (v) => { current = v; sync() } })
  wrap.setValue = (v) => { current = v; sync() }
  return wrap
}

export function toggle(checked, onChange, { label = '', title = '' } = {}) {
  const cb = h('input', { type: 'checkbox', checked: !!checked })
  cb.addEventListener('change', () => onChange?.(cb.checked))
  const wrap = h('label', { class: 'switch', title }, cb, h('span'))
  if (label) wrap.appendChild(h('span', { class: 'muted', style: { fontSize: '11px' } }, label))
  return wrap
}

export function badge(text, kind = '') {
  return h('span', { class: 'badge' + (kind ? ' ' + kind : '') }, text)
}

export function dot(kind = '') {
  return h('span', { class: 'dot' + (kind ? ' ' + kind : '') })
}

/** Deterministic / indeterminate progress. */
export function progress(value = 0, { className = '', title = '' } = {}) {
  const fill = h('i', { style: value === null ? {} : { width: Math.max(0, Math.min(100, value)) + '%' } })
  const el = h('div', { class: 'bar' + (value === null ? ' indeterminate' : '') + (className ? ' ' + className : ''), title }, fill)
  return {
    el,
    set(v) {
      if (v === null || v === undefined || !Number.isFinite(Number(v))) {
        el.classList.add('indeterminate')
        fill.style.width = ''
      } else {
        el.classList.remove('indeterminate')
        fill.style.width = Math.max(0, Math.min(100, Number(v))) + '%'
      }
    },
    state(s) {
      el.classList.remove('ok', 'bad')
      if (s) el.classList.add(s)
    }
  }
}

export function spinner(size = 14) {
  const s = h('span', { class: 'spinner' })
  s.style.width = size + 'px'
  s.style.height = size + 'px'
  return s
}

export function emptyState(title, text = '', action = null, { iconName = 'package-down' } = {}) {
  return h('div', { class: 'empty-state' },
    icon(iconName, { size: 22, class: 'es-icon' }),
    h('div', { class: 'es-title' }, title),
    text ? h('div', { class: 'es-text' }, text) : null,
    action || null
  )
}

export function errorState(title, text = '', action = null) {
  return h('div', { class: 'error-state' },
    icon('warning', { size: 22, class: 'es-icon' }),
    h('div', { class: 'es-title' }, title),
    text ? h('div', { class: 'es-text' }, text) : null,
    action || null
  )
}

/**
 * Scrollable log viewer: monospace, auto-follow bottom (pauses on scroll up),
 * optional line numbers, copy / clear / download toolbar.
 */
export function logViewer({ title = '日志', height = 240, lineNumbers = true, maxLines = 4000, ariaLabel = '日志' } = {}) {
  const body = h('div', { class: 'logview-body', role: 'log', 'aria-label': ariaLabel })
  let follow = true
  let count = 0
  body.addEventListener('scroll', () => {
    const gap = body.scrollHeight - body.scrollTop - body.clientHeight
    follow = gap < 24
  })
  const jump = h('button', { class: 'btn btn-sm log-jump', type: 'button' }, icon('arrow-down', { size: 13 }), '跳到最新')
  jump.style.display = 'none'
  jump.addEventListener('click', () => { follow = true; body.scrollTop = body.scrollHeight; jump.style.display = 'none' })
  body.addEventListener('scroll', () => { jump.style.display = follow ? 'none' : '' })

  const wrap = h('div', { class: 'logview', style: { height: typeof height === 'number' ? height + 'px' : height } })
  const head = h('div', { class: 'logview-head' },
    icon('terminal', { size: 13 }),
    h('span', {}, title),
    h('span', { class: 'spacer' }),
    iconBtn('copy', { size: 13, label: '复制日志', onClick: async () => { const ok = await copyText(body.innerText); toast(ok ? '日志已复制' : '复制失败', ok ? 'ok' : 'err') } }),
    iconBtn('download', { size: 13, label: '下载日志', onClick: () => {
      const blob = new Blob([body.innerText], { type: 'text/plain' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `mc-toolbox-log-${Date.now()}.txt`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    } }),
    iconBtn('trash', { size: 13, label: '清空日志', onClick: () => clearLog() })
  )
  wrap.append(head, body, jump)

  function lineNode(text, kind = '') {
    count++
    return h('div', { class: 'log-line' + (kind ? ' ' + kind : '') },
      lineNumbers ? h('span', { class: 'ln' }, String(count)) : null,
      h('span', {}, text))
  }

  function trim() {
    while (body.childElementCount > maxLines) body.firstElementChild?.remove()
  }

  function append(lines, kind = '') {
    if (lines === null || lines === undefined) return
    const list = Array.isArray(lines) ? lines : String(lines).split('\n')
    const frag = document.createDocumentFragment()
    for (const line of list) frag.appendChild(lineNode(line, kind))
    body.appendChild(frag)
    trim()
    if (follow) body.scrollTop = body.scrollHeight
  }

  function set(lines, kind = '') {
    clearLog()
    append(lines, kind)
  }

  function clearLog() {
    while (body.firstChild) body.removeChild(body.firstChild)
    count = 0
    follow = true
    jump.style.display = 'none'
  }

  return {
    el: wrap,
    body,
    head,
    append,
    set,
    clear: clearLog,
    text: () => body.innerText,
    scrollToEnd: () => { follow = true; body.scrollTop = body.scrollHeight },
    isFollowing: () => follow
  }
}

export async function openPath(path) {
  try {
    const r = await api.post('/api/fs/open', { path })
    if (r && r.error) throw new Error(r.error)
    return true
  } catch (e) {
    toast('无法打开路径：' + e.message, 'err')
    return false
  }
}

export async function openSysPath(which) {
  try {
    const r = await api.post('/api/system/open-path', { which })
    if (r && r.error) throw new Error(r.error)
    return true
  } catch (e) {
    toast('打开失败：' + e.message, 'err')
    return false
  }
}

export { fmtBytes, fmtAgo, copyText }
