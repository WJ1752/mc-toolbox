// The Bench icon set — 20×20 two-tone pixel geometry.
// No emoji, no external icon fonts. Every glyph is drawn from square-cap paths.

const NS = 'http://www.w3.org/2000/svg'

// '#' = secondary (dimmed), '~' = filled with currentColor
const PATHS = {
  workspace: ['M3 3h6v6H3z', 'M11 3h6v6h-6z', 'M3 11h6v6H3z', '~M11 11h6v6h-6z'],
  home: ['M2.5 9.5L10 3l7.5 6.5', 'M4.5 9v8h11V9', '#M8 17v-4h4v4'],
  add: ['M10 4v12', 'M4 10h12'],
  minus: ['M4 10h12'],
  collapse: ['M8 3v5H3', 'M17 8h-5V3', 'M12 17v-5h5', 'M3 12h5v5'],
  expand: ['M3 8V3h5', 'M12 3h5v5', 'M17 12v5h-5', 'M8 17H3v-5'],
  more: ['~M5 9h2v2H5z', '~M9 9h2v2H9z', '~M13 9h2v2h-2z'],
  settings: [
    'M10 2.5v2', 'M10 15.5v2', 'M2.5 10h2', 'M15.5 10h2',
    'M4.7 4.7l1.4 1.4', 'M13.9 13.9l1.4 1.4', 'M4.7 15.3l1.4-1.4', 'M13.9 6.1l1.4-1.4',
    'M10 6.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z'
  ],
  refresh: ['M16 10a6 6 0 1 1-1.8-4.3', 'M16.5 2.5V6h-3.5'],
  play: ['~M6 4l10 6-10 6z'],
  pause: ['~M6 4h3v12H6z', '~M11 4h3v12h-3z'],
  stop: ['~M5 5h10v10H5z'],
  download: ['M10 3v9.5', 'M6.2 9l3.8 3.8L13.8 9', 'M4 17h12'],
  upload: ['M10 16V6.5', 'M6.2 10.4L10 6.6l3.8 3.8', 'M4 3h12'],
  folder: ['M2.5 5.5h5l2 2h8v9h-15z', '#M2.5 8h15'],
  'folder-open': ['M2.5 6h6l2 2h7v2h-13z', 'M2.5 10h15l-2 6.5h-13z'],
  file: ['M5 2.5h7l3 3v12H5z', '#M12 2.5v3.5h3'],
  search: ['M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z', 'M13 13l4 4'],
  copy: ['M7 7h9v10H7z', 'M4 3h9v2', 'M4 3v10h2'],
  trash: ['M3 5h14', 'M7 5V3h6v2', 'M5 5l1 12h8l1-12', '#M8 8v6', '#M12 8v6'],
  warning: ['M10 2.5l8 14.5H2z', 'M10 7v5.5', '~M9.2 14.4h1.6v1.6H9.2z'],
  check: ['M4 10.5l4 4 8-9'],
  'check-circle': ['M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z', 'M6.5 10l2.5 2.5 4.5-5'],
  'x-circle': ['M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z', 'M7 7l6 6', 'M13 7l-6 6'],
  info: ['M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z', 'M10 9v5', '~M9.2 6.2h1.6v1.6H9.2z'],
  close: ['M5 5l10 10', 'M15 5L5 15'],
  'chevron-down': ['M5 8l5 5 5-5'],
  'chevron-right': ['M8 5l5 5-5 5'],
  'chevron-left': ['M12 5l-5 5 5 5'],
  'arrow-right': ['M3 10h13', 'M12 6l4 4-4 4'],
  'arrow-left': ['M17 10H4', 'M8 6l-4 4 4 4'],
  'arrow-down': ['M10 3v13', 'M6 12l4 4 4-4'],
  external: ['M11 3h6v6', 'M17 3l-8 8', 'M15 11v5H4V5h5'],
  terminal: ['M2.5 4h15v12h-15z', '#M2.5 7h15', 'M5.5 10l2.5 2-2.5 2', 'M10 14h4'],
  command: ['M7 5H5.5a2 2 0 1 0 2 2V5z', 'M13 5h1.5a2 2 0 1 1-2 2V5z', 'M7 15H5.5a2 2 0 1 1 2-2v2z', 'M13 15h1.5a2 2 0 1 0-2-2v2z', 'M7 7h6v6H7z'],
  edit: ['M3 17l1-4L14 3l3 3L7 16l-4 1z', '#M12 5l3 3'],
  save: ['M3 3h11l3 3v11H3z', '#M6 3v5h7V3', 'M6 11h8v6H6z'],
  eye: ['M1.5 10S4.8 4.5 10 4.5 18.5 10 18.5 10 15.2 15.5 10 15.5 1.5 10 1.5 10z', 'M10 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
  'eye-off': ['M3 3l14 14', 'M6 6.2C3.6 7.7 1.5 10 1.5 10S4.8 15.5 10 15.5c1.7 0 3.2-.5 4.5-1.2', 'M9 5.6c.3 0 .7-.1 1-.1 5.2 0 8.5 4.5 8.5 4.5s-.8 1.2-2.2 2.6'],
  filter: ['M2.5 4h15l-6 7v5l-3 1.5V11z'],
  link: ['M8 12l4-4', 'M6.8 9.2L5 11a3 3 0 0 0 4.2 4.2l1.8-1.8', 'M13.2 10.8L15 9a3 3 0 0 0-4.2-4.2L9 6.6'],
  clock: ['M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z', 'M10 6v4.5l3 2'],
  chart: ['M3 3v14h14', '#M3 13h3', '#M3 9h3', '#M3 5h3', 'M6 13l4-4 3 3 4-6'],
  server: ['M3 4h14v5H3z', 'M3 11h14v5H3z', '~M5.5 6h1.5v1.5H5.5z', '~M5.5 13h1.5v1.5H5.5z', '#M13 6.2h1.5', '#M13 13.2h1.5'],
  signal: ['~M3 14h2.5v3H3z', '~M7 11h2.5v6H7z', '~M11 7.5h2.5v9.5H11z', '~M15 3.5h2.5v13.5H15z'],
  pulse: ['M2 11h3.5l2-6.5 3 11 2.5-6.5H18', '#M2 16h16'],
  swap: ['M3 7h12', 'M12 4l3 3-3 3', 'M17 13H5', 'M8 10l-3 3 3 3'],
  'package-down': ['M10 2.5l7.5 4v7L10 17l-7.5-3.5v-7z', '#M2.5 6.5L10 10l7.5-3.5', '#M10 10v7', 'M10 11.5v3.5', 'M7.8 13l2.2 2.2L12.2 13'],
  chip: ['M5.5 5.5h9v9h-9z', '#M8.5 8.5h3v3h-3z', 'M8 2.5v3', 'M12 2.5v3', 'M8 14.5v3', 'M12 14.5v3', 'M2.5 8h3', 'M2.5 12h3', 'M14.5 8h3', 'M14.5 12h3'],
  language: ['M2.5 5.5h8', 'M6.5 3v2.5', 'M4 9.5c1.5 3 4 5 6.5 6', '#M9.5 5.5c-.4 3.4-2.2 6-5.5 8', 'M10.5 17l3.5-9 3.5 9', 'M11.8 14h4.4'],
  cube: ['M10 2.2l7.2 4.1v8L10 18.4l-7.2-4.1v-8z', '#M2.8 6.3L10 10.4l7.2-4.1', '#M10 10.4v8', '#M6.4 4.2l7.2 4.1'],
  'cube-scan': ['M10 2.2l7.2 4.1v8L10 18.4l-7.2-4.1v-8z', '#M2.8 6.3L10 10.4l7.2-4.1', 'M10 13.5v3', 'M8.5 15l1.5 1.5 1.5-1.5'],
  grid: ['M3 3h14v14H3z', '#M3 8.7h14', '#M3 13.4h14', '#M8.7 3v14', '#M13.4 3v14'],
  map: ['M2.5 5l5-2 5 2 5-2v12l-5 2-5-2-5 2z', '#M7.5 3v12', '#M12.5 5v12'],
  sliders: ['M3 5h14', 'M3 10h14', 'M3 15h14', '~M7 3.5h2v3H7z', '~M12 8.5h2v3h-2z', '~M6 13.5h2v3H6z'],
  user: ['M10 3a3.2 3.2 0 1 0 0 6.4A3.2 3.2 0 0 0 10 3z', 'M3.5 17c.6-3.3 3.2-5.2 6.5-5.2s5.9 1.9 6.5 5.2'],
  shield: ['M10 2.5l6 2v5.5c0 3.5-2.3 6-6 7.5-3.7-1.5-6-4-6-7.5V4.5z', '#M7 9.8l2.2 2.2L13.5 7.5'],
  bolt: ['~M11.5 2L4 11h5l-1 7 8-10h-5z'],
  pin: ['M10 18s5.5-5.2 5.5-9A5.5 5.5 0 0 0 10 3.5 5.5 5.5 0 0 0 4.5 9c0 3.8 5.5 9 5.5 9z', '#M10 6.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
  sort: ['M6 4v12', 'M3 13l3 3 3-3', '#M11 6h6', '#M11 10h4', '#M11 14h2'],
  list: ['M4 5h12', 'M4 10h12', 'M4 15h12'],
  'dots-vertical': ['~M9 4h2v2H9z', '~M9 9h2v2H9z', '~M9 14h2v2H9z'],
  'window-min': ['M4 10h12'],
  'window-max': ['M4 4h12v12H4z'],
  'window-close': ['M5 5l10 10', 'M15 5L5 15'],
  puzzle: ['M3 3h5v2.2a1.8 1.8 0 1 0 4 0V3h5v5h-2.2a1.8 1.8 0 1 0 0 4H17v5h-5v-2.2a1.8 1.8 0 1 0-4 0V17H3v-5h2.2a1.8 1.8 0 1 0 0-4H3z'],
  java: ['M4 9h9v5.5A3.5 3.5 0 0 1 9.5 18h-2A3.5 3.5 0 0 1 4 14.5z', 'M13 10h1.5a2 2 0 0 1 0 4H13', '#M7 5c0-1 1-1 1-2', '#M10 5c0-1 1-1 1-2'],
  archive: ['M3 3h14v4H3z', 'M4.5 7h11v10h-11z', '#M3 3l1.5 4', '#M17 3l-1.5 4', '~M8 10h4'],
  wand: ['M4 16L14 6', 'M14 3v3', 'M17 6h-3', 'M16 12v2', 'M15 13h2'],
  globe: ['M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15z', '#M2.5 10h15', '#M10 2.5c2 2.2 3 4.7 3 7.5s-1 5.3-3 7.5', '#M10 2.5c-2 2.2-3 4.7-3 7.5s1 5.3 3 7.5'],
  bell: ['M5 14V9a5 5 0 0 1 10 0v5l1.5 1.5h-13z', 'M8.5 17.5h3'],
  lock: ['M4.5 9h11v8h-11z', 'M7 9V6.5a3 3 0 0 1 6 0V9', '#M10 12v2.5']
}

const FEATURE_ICONS = {
  'server-status': 'signal',
  'latency-monitor': 'pulse',
  'client2server': 'swap',
  'community-download': 'package-down',
  'server-core': 'chip',
  'i18n': 'language',
  'save-editor': 'cube',
  'server-manager': 'terminal'
}

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/u

export function hasIcon(name) {
  return !!PATHS[name]
}

/**
 * Build an SVG icon element.
 * @param {string} name
 * @param {{size?:number, title?:string, class?:string, strokeWidth?:number}} [opts]
 */
export function icon(name, { size = 20, title = '', class: cls = '', strokeWidth = 1.35 } = {}) {
  const paths = PATHS[name] || PATHS.puzzle
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', '0 0 20 20')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', String(strokeWidth))
  svg.setAttribute('stroke-linecap', 'square')
  svg.setAttribute('stroke-linejoin', 'miter')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.classList.add('ico-svg')
  if (cls) svg.setAttribute('class', 'ico-svg ' + cls)
  for (const d of paths) {
    const p = document.createElementNS(NS, 'path')
    let dd = d
    let fill = false
    let secondary = false
    if (dd.startsWith('~')) { fill = true; dd = dd.slice(1) }
    if (dd.startsWith('#')) { secondary = true; dd = dd.slice(1) }
    p.setAttribute('d', dd)
    if (fill) {
      p.setAttribute('fill', 'currentColor')
      p.setAttribute('stroke', 'none')
    }
    if (secondary) p.setAttribute('opacity', '.42')
    svg.appendChild(p)
  }
  if (title) {
    svg.setAttribute('role', 'img')
    svg.removeAttribute('aria-hidden')
    const t = document.createElementNS(NS, 'title')
    t.textContent = title
    svg.appendChild(t)
  }
  return svg
}

/** Feature glyph: mapped icon, else non-emoji manifest glyph, else puzzle. */
export function featureIcon(feature, opts = {}) {
  const id = typeof feature === 'string' ? feature : feature?.id
  const mapped = FEATURE_ICONS[id]
  if (mapped) return icon(mapped, opts)
  const raw = typeof feature === 'object' ? feature?.icon : ''
  if (raw && raw.length <= 2 && !EMOJI_RE.test(raw)) {
    const span = document.createElement('span')
    span.className = 'glyph-text'
    span.textContent = raw
    span.style.fontSize = Math.round((opts.size || 20) * 0.72) + 'px'
    span.style.fontWeight = '600'
    return span
  }
  return icon('puzzle', opts)
}

export function isEmoji(text) {
  return EMOJI_RE.test(String(text || ''))
}

export { FEATURE_ICONS }
