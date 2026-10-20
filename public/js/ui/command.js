import { h, clear } from '../core/dom.js'
import { icon } from './icons.js'

let provider = null
let selected = 0
let flat = []

function root() { return document.getElementById('cmdkRoot') }

export function initCommandPalette(getItems) {
  provider = getItems
  const input = document.getElementById('cmdkInput')
  const iconHost = document.getElementById('cmdkIcon')
  if (iconHost && !iconHost.firstChild) iconHost.appendChild(icon('search', { size: 16 }))
  input?.addEventListener('input', () => { selected = 0; render() })
  input?.addEventListener('keydown', onKey)
  document.getElementById('cmdkBackdrop')?.addEventListener('click', closeCommandPalette)
  return { open: openCommandPalette, close: closeCommandPalette, toggle: toggleCommandPalette }
}

export function isCommandPaletteOpen() {
  const r = root()
  return !!r && !r.hidden
}

export function openCommandPalette() {
  const r = root()
  if (!r) return
  r.hidden = false
  const input = document.getElementById('cmdkInput')
  if (input) {
    input.value = ''
    input.focus()
  }
  selected = 0
  render()
}

export function closeCommandPalette() {
  const r = root()
  if (!r || r.hidden) return
  r.hidden = true
}

export function toggleCommandPalette() {
  if (isCommandPaletteOpen()) closeCommandPalette()
  else openCommandPalette()
}

function items() {
  try {
    return (provider?.() || []).filter(Boolean)
  } catch (e) {
    console.warn('[command] provider failed', e)
    return []
  }
}

function score(item, q) {
  if (!q) return 1
  const label = String(item.label || '').toLowerCase()
  const hay = (label + ' ' + (item.group || '') + ' ' + (item.keywords || '')).toLowerCase()
  if (label.startsWith(q)) return 4
  if (label.includes(q)) return 3
  if (hay.includes(q)) return 2
  return 0
}

function render() {
  const list = document.getElementById('cmdkList')
  if (!list) return
  const q = (document.getElementById('cmdkInput')?.value || '').trim().toLowerCase()
  const all = items()
    .map((item) => ({ item, s: score(item, q) }))
    .filter((x) => x.s > 0)
    .map((x) => x.item)
  flat = all
  clear(list)
  if (!all.length) {
    list.appendChild(h('div', { class: 'cmdk-empty' }, '没有匹配的功能或动作'))
    return
  }
  if (selected >= all.length) selected = all.length - 1
  let group = ''
  all.forEach((item, i) => {
    if (item.group && item.group !== group) {
      group = item.group
      list.appendChild(h('div', { class: 'cmdk-group' }, group))
    }
    const btn = h('button', {
      class: 'cmdk-item' + (i === selected ? ' sel' : ''),
      type: 'button',
      role: 'option',
      'aria-selected': String(i === selected),
      dataset: { i: String(i) },
      onclick: () => run(i),
      onpointerenter: () => { selected = i; paint() }
    },
      h('span', { class: 'cmdk-icon' }, icon(item.iconName || 'puzzle', { size: 15 })),
      h('span', {}, item.label),
      item.hint ? h('span', { class: 'cmdk-hint' }, item.hint) : null
    )
    list.appendChild(btn)
  })
  paint()
}

function paint() {
  const list = document.getElementById('cmdkList')
  if (!list) return
  const nodes = Array.from(list.querySelectorAll('.cmdk-item'))
  nodes.forEach((n, i) => {
    const on = i === selected
    n.classList.toggle('sel', on)
    n.setAttribute('aria-selected', String(on))
    if (on) n.scrollIntoView({ block: 'nearest' })
  })
}

function run(i) {
  const item = flat[i]
  if (!item) return
  closeCommandPalette()
  setTimeout(() => {
    try { item.run?.() } catch (e) { console.error('[command]', e) }
  }, 0)
}

function onKey(e) {
  if (!isCommandPaletteOpen()) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopImmediatePropagation()
    closeCommandPalette()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    selected = flat.length ? (selected + 1) % flat.length : 0
    paint()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selected = flat.length ? (selected - 1 + flat.length) % flat.length : 0
    paint()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    run(selected)
  }
}

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    toggleCommandPalette()
  }
})
