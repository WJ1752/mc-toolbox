// 启动器共享 UI 片段：材质槽图标、皮肤头像、加载器徽章、卡片与标签。
import { h, fmtBytes, fmtAgo, fmtDuration, fmtDateTime } from '../core/dom.js'
import { icon } from '../ui/icons.js'

export const LOADER_STYLE = {
  vanilla: { label: '原版', short: 'VAN', color: '#63c77e', icon: 'cube' },
  fabric: { label: 'Fabric', short: 'FAB', color: '#d8b26a', icon: 'bolt' },
  quilt: { label: 'Quilt', short: 'QLT', color: '#b58cd8', icon: 'grid' },
  forge: { label: 'Forge', short: 'FRG', color: '#d98a4a', icon: 'shield' },
  neoforge: { label: 'NeoForge', short: 'NEO', color: '#e0a35b', icon: 'shield' }
}

export function loaderInfo(loader) {
  return LOADER_STYLE[loader] || LOADER_STYLE.vanilla
}

export function loaderLabel(inst = {}) {
  const info = loaderInfo(inst.loader)
  return inst.loader === 'vanilla' ? '原版' : `${info.label}${inst.loaderVersion ? ' ' + inst.loaderVersion : ''}`
}

export function instanceSubtitle(inst = {}) {
  const loader = loaderInfo(inst.loader)
  const parts = [inst.mc || '未知版本']
  if (inst.loader && inst.loader !== 'vanilla') parts.push(`${loader.label}${inst.loaderVersion ? ' ' + inst.loaderVersion : ''}`)
  return parts.join(' · ')
}

/** Square hardware-slot icon: loader glyph + version, tinted per loader. */
export function instanceIcon(inst = {}, { size = 44, running = false } = {}) {
  const loader = loaderInfo(inst.loader)
  const wrap = h('span', {
    class: 'lp-inst-icon' + (running ? ' running' : ''),
    style: { width: size + 'px', height: size + 'px' },
    'aria-hidden': 'true'
  })
  wrap.style.setProperty('--lp-color', loader.color)
  wrap.appendChild(h('span', { class: 'lp-ic-glyph' }, icon(loader.icon, { size: Math.round(size * 0.38) })))
  wrap.appendChild(h('span', { class: 'lp-ic-ver' }, String(inst.mc || '?')))
  wrap.appendChild(h('span', { class: 'lp-ic-tag' }, loader.short))
  return wrap
}

function hashString(text) {
  let hash = 2166136261
  for (const char of String(text || '')) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** Deterministic 8×8 pixel face for offline accounts (no external service). */
function generatedFace(name, size) {
  const hash = hashString(name)
  const canvas = document.createElement('canvas')
  canvas.width = 8
  canvas.height = 8
  canvas.className = 'lp-face-canvas'
  canvas.style.width = size + 'px'
  canvas.style.height = size + 'px'
  const ctx = canvas.getContext('2d')
  const skins = ['#d7a179', '#c68c62', '#e2b48d', '#a8704a', '#8a5a3b']
  const hairs = ['#2b1d14', '#4a2f1c', '#6b4a2a', '#1f1a17', '#8a6a3a']
  const shirts = ['#3b7f6a', '#5577aa', '#9a5a4a', '#6a5a9a', '#4a7a4a']
  const skin = skins[hash % skins.length]
  const hair = hairs[(hash >>> 3) % hairs.length]
  const shirt = shirts[(hash >>> 6) % shirts.length]
  ctx.fillStyle = skin
  ctx.fillRect(0, 0, 8, 8)
  ctx.fillStyle = hair
  ctx.fillRect(0, 0, 8, 2)
  ctx.fillRect(0, 2, 1, 2)
  ctx.fillRect(7, 2, 1, 2)
  ctx.fillStyle = '#141820'
  ctx.fillRect(2, 3, 1, 1)
  ctx.fillRect(5, 3, 1, 1)
  ctx.fillStyle = '#7a4a3a'
  ctx.fillRect(3, 5, 2, 1)
  ctx.fillStyle = 'rgba(0,0,0,.12)'
  ctx.fillRect(0, 6, 8, 1)
  ctx.fillStyle = shirt
  ctx.fillRect(0, 7, 8, 1)
  return canvas
}

/** Player head: cropped from the real skin when available, generated otherwise. */
export function playerAvatar(account = {}, { size = 30 } = {}) {
  const wrap = h('span', { class: 'lp-avatar', style: { width: size + 'px', height: size + 'px' }, 'aria-hidden': 'true' })
  wrap.appendChild(generatedFace(account.name || account.uuid || '?', size))
  if (account.skin) {
    const scale = size / 8
    for (const [x, y, cls] of [[8, 8, 'base'], [40, 8, 'overlay']]) {
      wrap.appendChild(h('span', {
        class: 'lp-skin-layer ' + cls,
        style: {
          backgroundImage: `url("${String(account.skin).replace(/"/g, '%22')}")`,
          backgroundSize: `${64 * scale}px ${64 * scale}px`,
          backgroundPosition: `${-x * scale}px ${-y * scale}px`
        }
      }))
    }
  }
  return wrap
}

export function accountTypeLabel(type) {
  return type === 'microsoft' ? '微软' : type === 'authlib' ? '第三方' : '离线'
}

export function accountBadge(account) {
  return h('span', { class: 'badge ' + (account.type === 'microsoft' ? 'info' : account.type === 'authlib' ? 'accent' : '') }, accountTypeLabel(account.type))
}

export function playtime(seconds) {
  return seconds ? fmtDuration(seconds) : '从未游玩'
}

export function lastPlayed(ts) {
  return ts ? fmtAgo(ts) : '尚未启动'
}

export function sectionCard({ title = '', subtitle = '', actions = null, className = '', body = null } = {}) {
  const head = h('div', { class: 'lp-card-head' },
    h('div', { class: 'lp-card-title' }, h('b', {}, title), subtitle ? h('span', {}, subtitle) : null),
    actions ? h('div', { class: 'lp-card-actions' }, actions) : null
  )
  return h('section', { class: 'lp-card ' + className }, title ? head : null, h('div', { class: 'lp-card-body' }, body))
}

export function emptyBlock(title, text = '', action = null, iconName = 'cube') {
  return h('div', { class: 'lp-empty' },
    h('span', { class: 'lp-empty-icon' }, icon(iconName, { size: 22 })),
    h('b', {}, title),
    text ? h('p', {}, text) : null,
    action || null
  )
}

export function tabBar(items, active, onChange) {
  const wrap = h('div', { class: 'lp-tabs', role: 'tablist' })
  for (const item of items) {
    const [id, label, count] = Array.isArray(item) ? item : [item.id, item.label, item.count]
    const button = h('button', {
      class: 'lp-tab' + (id === active ? ' active' : ''),
      type: 'button',
      role: 'tab',
      'aria-selected': String(id === active),
      dataset: { tab: id }
    }, label, count !== undefined && count !== null ? h('span', { class: 'lp-tab-count' }, String(count)) : null)
    button.onclick = () => onChange(id)
    wrap.appendChild(button)
  }
  return wrap
}

export function metric(label, value, sub = '') {
  return h('div', { class: 'lp-metric' },
    h('label', {}, label),
    h('b', { title: String(value) }, value),
    sub ? h('span', {}, sub) : null
  )
}

export function kvRow(label, value) {
  return h('div', { class: 'lp-kv' }, h('span', {}, label), h('b', {}, value))
}

export function statusPill(kind, text) {
  return h('span', { class: 'lp-status ' + kind }, h('i', {}), text)
}

export function progressBar(value, { indeterminate = false, className = '' } = {}) {
  const fill = h('i', { style: indeterminate ? {} : { width: Math.max(0, Math.min(100, Number(value) || 0)) + '%' } })
  const bar = h('div', { class: 'lp-bar' + (indeterminate ? ' indeterminate' : '') + (className ? ' ' + className : '') }, fill)
  return {
    el: bar,
    set(next, indet = false) {
      bar.classList.toggle('indeterminate', indet)
      if (!indet) fill.style.width = Math.max(0, Math.min(100, Number(next) || 0)) + '%'
    }
  }
}

export function formatDate(ts) {
  return ts ? fmtDateTime(ts) : '—'
}

export { fmtBytes, fmtAgo, fmtDuration }
