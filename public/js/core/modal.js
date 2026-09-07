import { h, clear } from './dom.js'

const root = document.getElementById('modalRoot')
const titleEl = document.getElementById('modalTitle')
const bodyEl = document.getElementById('modalBody')
const footEl = document.getElementById('modalFoot')

// 弹窗支持多层叠加（如「详情 → 目录选择器」）：每层记录打开前的状态，
// close() 只关最上层并恢复下一层，避免选择目录后把外层界面清掉。
const stack = [] // { cls, title, bodyKids:[], footKids:[], onClose }

function clearNode(el) {
  while (el.firstChild) el.removeChild(el.firstChild)
}

function close() {
  const top = stack.pop()
  if (!top) return
  clearNode(bodyEl)
  clearNode(footEl)
  if (top.onClose) {
    try { top.onClose() } catch {}
  }
  const prev = stack[stack.length - 1]
  if (!prev) {
    root.hidden = true
    return
  }
  // 恢复上一层
  modalEl().className = prev.cls
  titleEl.textContent = prev.title
  for (const n of prev.bodyKids) bodyEl.appendChild(n)
  for (const n of prev.footKids) footEl.appendChild(n)
  root.hidden = false
}

function modalEl() {
  return root.querySelector('.modal')
}

document.getElementById('modalClose').addEventListener('click', close)
root.querySelector('[data-close]').addEventListener('click', close)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !root.hidden) close()
})

/**
 * 打开弹窗（可叠加）
 * @param {{title:string, body:Node|string, size?:'lg'|'xl', buttons?:Array, onClose?:Function}} opts
 */
export function openModal(opts) {
  const m = modalEl()
  // 保存当前层状态
  stack.push({
    cls: m.className,
    title: titleEl.textContent,
    bodyKids: Array.from(bodyEl.childNodes),
    footKids: Array.from(footEl.childNodes),
    onClose: typeof opts.onClose === 'function' ? opts.onClose : null
  })
  m.className = 'modal' + (opts.size ? ' ' + opts.size : '')
  titleEl.textContent = opts.title || ''
  clearNode(bodyEl)
  clearNode(footEl)
  if (typeof opts.body === 'string') bodyEl.innerHTML = opts.body
  else if (opts.body) bodyEl.appendChild(opts.body)

  const api = { close, body: bodyEl, foot: footEl }
  for (const b of opts.buttons || []) {
    // 允许直接传按钮元素（例如已绑定好 onclick 的「⬇ 下载」）
    if (b && b.nodeType === 1) {
      footEl.appendChild(b)
      continue
    }
    if (!b || typeof b !== 'object') continue
    footEl.appendChild(
      h(
        'button',
        {
          class: 'btn ' + (b.class || ''),
          onclick: () => {
            if (b.onClick) b.onClick(api)
            else close()
          }
        },
        b.label
      )
    )
  }
  root.hidden = false
  return api
}

export function confirmDialog(message, { title = '确认操作', danger = false, okText = '确定' } = {}) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
      close()
    }
    const api = openModal({
      title,
      body: h('div', { style: { fontSize: '13px', lineHeight: '1.7' }, html: message }),
      buttons: [
        { label: '取消', onClick: () => finish(false) },
        { label: okText, class: danger ? 'btn-danger' : 'btn-primary', onClick: () => finish(true) }
      ],
      onClose: () => {
        if (!done) resolve(false)
      }
    })
    api.foot.querySelector('.btn-primary, .btn-danger')?.focus()
  })
}
