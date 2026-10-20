import { h, clear } from './dom.js'
import { icon } from '../ui/icons.js'

// Modal stack. Each layer is a real dialog element; the previous layer is
// hidden (not destroyed), so directory pickers can sit on top of editors and
// closing only unwinds one level.
const root = () => document.getElementById('modalRoot')
const stack = []
let lastFocus = null

function topLayer() {
  return stack[stack.length - 1] || null
}

function assignLegacyIds(layer) {
  // Old feature modules (and a few integrations) still address these ids.
  for (const el of document.querySelectorAll('#modalTitle, #modalBody, #modalFoot, #modalClose')) {
    el.removeAttribute('id')
  }
  if (!layer) return
  layer.title.id = 'modalTitle'
  layer.body.id = 'modalBody'
  layer.foot.id = 'modalFoot'
  layer.closeBtn.id = 'modalClose'
}

function focusables(panel) {
  return Array.from(panel.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((el) => el.offsetParent !== null || el === document.activeElement)
}

function closeLayer(layer) {
  if (!layer || layer.closed) return
  layer.closed = true
  const idx = stack.indexOf(layer)
  if (idx >= 0) stack.splice(idx, 1)
  layer.panel.remove()
  if (layer.onClose) {
    try { layer.onClose() } catch (e) { console.warn('[modal] onClose', e) }
  }
  const prev = topLayer()
  if (prev) {
    prev.panel.hidden = false
    assignLegacyIds(prev)
    prev.panel.focus?.({ preventScroll: true })
  } else {
    assignLegacyIds(null)
    const r = root()
    if (r) r.hidden = true
    if (lastFocus && document.contains(lastFocus)) {
      try { lastFocus.focus({ preventScroll: true }) } catch {}
    }
    lastFocus = null
  }
}

/**
 * Open a stacked modal.
 * @param {{title?:string, body?:Node|string, size?:'sm'|'md'|'lg'|'xl', buttons?:Array, onClose?:Function, class?:string}} opts
 * @returns {{close:Function, body:HTMLElement, foot:HTMLElement, panel:HTMLElement, setTitle:Function}}
 */
export function openModal(opts = {}) {
  const r = root()
  if (!r) throw new Error('缺少弹窗容器 #modalRoot')
  if (!stack.length) lastFocus = document.activeElement
  const prev = topLayer()
  if (prev) prev.panel.hidden = true

  const title = h('h3', {}, opts.title || '')
  const closeBtn = h('button', {
    class: 'btn btn-icon',
    type: 'button',
    title: '关闭（Esc）',
    'aria-label': '关闭',
    onclick: () => closeLayer(layer)
  }, icon('close', { size: 14 }))
  const head = h('div', { class: 'modal-head' }, title, closeBtn)
  const body = h('div', { class: 'modal-body' })
  const foot = h('div', { class: 'modal-foot' })
  const size = opts.size || 'md'
  const panel = h('div', {
    class: 'modal ' + size + (opts.class ? ' ' + opts.class : ''),
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': opts.title || '对话框',
    tabindex: '-1'
  }, head, body, foot)

  if (typeof opts.body === 'string') body.innerHTML = opts.body
  else if (opts.body) body.appendChild(opts.body)

  const onClose = typeof opts.onClose === 'function' ? opts.onClose : null
  const layer = { panel, body, foot, title, closeBtn, onClose, closed: false }
  stack.push(layer)

  const api = {
    close: () => closeLayer(layer),
    body,
    foot,
    panel,
    setTitle(t) { title.textContent = t }
  }

  for (const b of opts.buttons || []) {
    if (b && b.nodeType === 1) {
      foot.appendChild(b)
      continue
    }
    if (!b || typeof b !== 'object') continue
    const node = h('button', {
      class: 'btn ' + (b.class || ''),
      type: 'button',
      onclick: () => {
        if (b.onClick) b.onClick(api)
        else api.close()
      }
    }, b.label)
    foot.appendChild(node)
  }

  r.appendChild(panel)
  r.hidden = false
  assignLegacyIds(layer)
  requestAnimationFrame(() => {
    const auto = panel.querySelector('[autofocus]')
    if (auto) auto.focus({ preventScroll: true })
    else panel.focus({ preventScroll: true })
  })
  return api
}

export function closeTopModal() {
  const layer = topLayer()
  if (layer) {
    closeLayer(layer)
    return true
  }
  return false
}

export function closeAllModals() {
  while (stack.length) closeLayer(stack[stack.length - 1])
}

export function isModalOpen() {
  return stack.length > 0
}

/**
 * Confirmation dialog. Resolves false when dismissed via Esc / backdrop / cancel.
 */
export function confirmDialog(message, { title = '确认操作', danger = false, okText = '确定', cancelText = '取消' } = {}) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
      api.close()
    }
    const api = openModal({
      title,
      size: 'sm',
      body: h('div', { class: 'confirm-body', style: { fontSize: '12.5px', lineHeight: '1.7', whiteSpace: 'pre-wrap' }, html: message }),
      buttons: [
        { label: cancelText, class: 'btn-ghost', onClick: () => finish(false) },
        { label: okText, class: danger ? 'btn-danger' : 'btn-primary', onClick: () => finish(true) }
      ],
      onClose: () => {
        if (!done) resolve(false)
      }
    })
    api.foot.querySelector('.btn-primary, .btn-danger')?.focus({ preventScroll: true })
  })
}

// Esc unwinds exactly one layer. Capture phase so page-level Esc handlers
// (settings, bench) do not also fire while a dialog is open.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !stack.length) return
  e.preventDefault()
  e.stopImmediatePropagation()
  closeTopModal()
}, true)

// Backdrop click closes the top layer only.
root()?.addEventListener('click', (e) => {
  if (e.target?.classList?.contains('modal-backdrop')) {
    e.preventDefault()
    closeTopModal()
  }
})

// Focus trap for the top dialog.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !stack.length) return
  const layer = topLayer()
  const list = focusables(layer.panel)
  if (!list.length) {
    e.preventDefault()
    layer.panel.focus()
    return
  }
  const first = list[0]
  const last = list[list.length - 1]
  if (e.shiftKey && (document.activeElement === first || document.activeElement === layer.panel)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}, true)
