// Canvas charts — DPR-aware, theme-driven, with hover readouts.
// Public exports are part of the feature SDK contract.

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

function themeColors() {
  return {
    accent: cssVar('--accent', '#c07a4a'),
    line: cssVar('--line', '#2e3540'),
    text: cssVar('--mute', '#6e7783'),
    dim: cssVar('--dim', '#a3acb8'),
    danger: cssVar('--redstone', '#d9584c'),
    warn: cssVar('--gold', '#e3b341'),
    ok: cssVar('--emerald', '#63c77e'),
    bg: cssVar('--surface-2', '#21262e')
  }
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, canvas.clientWidth || 600)
  const h = Math.max(1, canvas.clientHeight || 200)
  canvas.width = Math.floor(w * dpr)
  canvas.height = Math.floor(h * dpr)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  return { ctx, w, h, dpr }
}

// Charts follow the 24h/12h preference from 设置 → 通用 → 时间格式.
// Reading it once from a module flag keeps every draw call (axis labels, hover
// tooltips, sparks) consistent without threading an option through each one.
let timeFormat12h = false

export function setChartTimeFormat(value) {
  timeFormat12h = value === true || value === '12h'
}

function timeLabel(t) {
  const d = new Date(t)
  if (timeFormat12h) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: true })
  }
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function playerCount(p) {
  if (!p || !p.ok) return null
  const v = p.players
  if (typeof v === 'number' && !Number.isNaN(v)) return v
  if (v && typeof v.online === 'number') return v.online
  return null
}

const LOSS_WIN = 12
function lossAt(points, i) {
  const s = Math.max(0, i - LOSS_WIN + 1)
  let fails = 0
  for (let j = s; j <= i; j++) if (!points[j].ok) fails++
  return +((fails / (i - s + 1)) * 100).toFixed(1)
}

/* ---------------- hover overlay ---------------- */
const hoverState = new WeakMap()

function ensureHover(canvas) {
  let state = hoverState.get(canvas)
  if (state) return state
  const parent = canvas.parentElement
  if (!parent) return null
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative'
  const tip = document.createElement('div')
  tip.className = 'chart-hover'
  tip.hidden = true
  parent.appendChild(tip)
  const line = document.createElement('div')
  line.style.cssText = 'position:absolute;top:0;bottom:0;width:1px;background:currentColor;opacity:.18;pointer-events:none;display:none'
  parent.appendChild(line)
  state = { tip, line, data: null }
  hoverState.set(canvas, state)

  canvas.addEventListener('pointermove', (e) => {
    const d = state.data
    if (!d || !d.n) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    if (x < d.padL - 4 || x > d.padL + d.iw + 4) { hide(); return }
    const rel = (x - d.padL) / Math.max(1, d.iw)
    const idx = Math.max(0, Math.min(d.n - 1, Math.round(rel * (d.n - 1))))
    const p = d.points[idx]
    const v = d.getY(p, idx, d.points)
    if (v === null || v === undefined) { hide(); return }
    const px = d.xAt(idx)
    const py = d.yAt(v)
    tip.hidden = false
    tip.textContent = `${timeLabel(p.t)} · ${d.format ? d.format(v) : v}${d.unit ? ' ' + d.unit : ''}`
    tip.style.left = Math.max(20, Math.min(d.w - 20, px)) + 'px'
    tip.style.top = Math.max(18, py - 8) + 'px'
    line.hidden = false
    line.style.left = px + 'px'
    line.style.color = d.color
  })
  canvas.addEventListener('pointerleave', hide)
  function hide() {
    tip.hidden = true
    line.hidden = true
  }
  return state
}

/* ---------------- generic value chart ---------------- */
function drawValueChart(canvas, points, {
  color = '#3ba0ff',
  getY = null,
  unit = '',
  emptyText = '暂无数据',
  warnAt = null,
  offlineBands = false,
  area = false,
  format = null,
  maxTop = null
} = {}) {
  const c = themeColors()
  const { ctx, w, h } = setupCanvas(canvas)
  const stroke = color || c.accent
  const padL = 38
  const padR = 10
  const padT = 10
  const padB = 20
  const iw = Math.max(10, w - padL - padR)
  const ih = Math.max(10, h - padT - padB)
  const pts = Array.isArray(points) ? points : []

  const pairs = pts.map((p, i) => {
    let v = null
    try {
      if (p && getY) {
        const raw = getY(p, i, pts)
        if (raw != null && !Number.isNaN(raw)) v = raw
      }
    } catch {}
    return { i, v: v != null && v >= 0 ? v : null }
  })
  const nums = pairs.filter((x) => x.v != null).map((x) => x.v)

  if (!nums.length) {
    ctx.fillStyle = c.text
    ctx.font = '12px ' + cssVar('--font-sans', 'system-ui')
    ctx.textAlign = 'center'
    ctx.fillText(emptyText, w / 2, h / 2)
    const st = ensureHover(canvas)
    if (st) st.data = null
    return
  }

  const maxV = maxTop != null ? maxTop : Math.max(...nums)
  const step = maxV <= 10 ? 2 : maxV <= 40 ? 10 : maxV <= 100 ? 20 : maxV <= 250 ? 50 : maxV <= 1000 ? 100 : maxV <= 5000 ? 500 : 1000
  const top = Math.max(step, Math.ceil(maxV / step) * step)
  const n = pts.length
  const xAt = (i) => padL + (n === 1 ? iw / 2 : (iw * i) / (n - 1))
  const yAt = (v) => padT + ih - (Math.min(v, top) / top) * ih

  // grid
  ctx.strokeStyle = c.line
  ctx.fillStyle = c.text
  ctx.font = '9.5px ' + cssVar('--font-mono', 'monospace')
  ctx.textAlign = 'right'
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const y = Math.round(padT + (ih * i) / 4) + 0.5
    ctx.beginPath()
    ctx.moveTo(padL, y)
    ctx.lineTo(padL + iw, y)
    ctx.stroke()
    ctx.fillText(String(Math.round((top * (4 - i)) / 4)) + (unit === '%' ? '%' : ''), padL - 6, y + 3)
  }

  // warn threshold
  if (warnAt != null && warnAt > 0 && warnAt < top) {
    const y = padT + ih - (warnAt / top) * ih
    ctx.save()
    ctx.setLineDash([3, 3])
    ctx.strokeStyle = c.warn
    ctx.globalAlpha = 0.5
    ctx.beginPath()
    ctx.moveTo(padL, y + 0.5)
    ctx.lineTo(padL + iw, y + 0.5)
    ctx.stroke()
    ctx.restore()
  }

  // offline bands
  if (offlineBands) {
    ctx.fillStyle = c.danger
    ctx.globalAlpha = 0.12
    const bandW = n === 1 ? iw : iw / (n - 1)
    for (let i = 0; i < n; i++) {
      if (pts[i] && pts[i].ok === false) {
        ctx.fillRect(xAt(i) - bandW / 2, padT, Math.max(2, bandW), ih)
      }
    }
    ctx.globalAlpha = 1
  }

  // area fill
  if (area) {
    const grad = ctx.createLinearGradient(0, padT, 0, padT + ih)
    grad.addColorStop(0, hexToRgba(stroke, 0.18))
    grad.addColorStop(1, hexToRgba(stroke, 0))
    ctx.fillStyle = grad
    ctx.beginPath()
    let started = false
    let firstX = 0
    let lastX = 0
    for (const { i, v } of pairs) {
      if (v == null) continue
      const x = xAt(i)
      const y = yAt(v)
      if (!started) { ctx.moveTo(x, y); firstX = x; started = true } else ctx.lineTo(x, y)
      lastX = x
    }
    if (started) {
      ctx.lineTo(lastX, padT + ih)
      ctx.lineTo(firstX, padT + ih)
      ctx.closePath()
      ctx.fill()
    }
  }

  // line (break on gaps)
  ctx.lineWidth = 1.7
  ctx.strokeStyle = stroke
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  let pen = false
  for (const { i, v } of pairs) {
    if (v == null) { pen = false; continue }
    const x = xAt(i)
    const y = yAt(v)
    if (!pen) { ctx.moveTo(x, y); pen = true } else ctx.lineTo(x, y)
  }
  ctx.stroke()

  // Isolated samples (e.g. a brand-new monitor) would otherwise be invisible.
  ctx.fillStyle = stroke
  for (let k = 0; k < pairs.length; k++) {
    const cur = pairs[k]
    if (cur.v == null) continue
    const prevNull = k === 0 || pairs[k - 1].v == null
    const nextNull = k === pairs.length - 1 || pairs[k + 1].v == null
    if (prevNull && nextNull) {
      ctx.beginPath()
      ctx.arc(xAt(cur.i), yAt(cur.v), 2.6, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // points over threshold
  if (warnAt != null) {
    ctx.fillStyle = c.danger
    for (const { i, v } of pairs) {
      if (v == null) continue
      if (v > warnAt) {
        ctx.beginPath()
        ctx.arc(xAt(i), yAt(v), 2.4, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  // time axis
  ctx.fillStyle = c.text
  ctx.font = '9.5px ' + cssVar('--font-mono', 'monospace')
  ctx.textAlign = 'center'
  if (pts[0]?.t) ctx.fillText(timeLabel(pts[0].t), padL + 16, h - 5)
  if (n > 1 && pts[n - 1]?.t) ctx.fillText(timeLabel(pts[n - 1].t), padL + iw - 16, h - 5)

  const st = ensureHover(canvas)
  if (st) {
    st.data = { points: pts, n, xAt, yAt, padL, iw, w, unit, color: stroke, getY, format }
  }
}

function hexToRgba(color, alpha) {
  if (color.startsWith('#')) {
    const hex = color.slice(1)
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
    const num = parseInt(full.slice(0, 6), 16)
    if (Number.isNaN(num)) return `rgba(192,122,74,${alpha})`
    return `rgba(${(num >> 16) & 255},${(num >> 8) & 255},${num & 255},${alpha})`
  }
  return color
}

/* ---------------- latency ---------------- */
export function drawLatencyChart(canvas, points, opts = {}) {
  const warnAt = opts.warnAt || 200
  return drawValueChart(canvas, points, {
    color: opts.accent || cssVar('--accent', '#c07a4a'),
    unit: 'ms',
    emptyText: '暂无延迟数据',
    warnAt,
    offlineBands: true,
    area: true,
    format: (v) => Math.round(v) + ' ms',
    getY: (p) => (p && p.ok && typeof p.ms === 'number' ? p.ms : null)
  })
}

export function drawPlayersChart(canvas, points, accent) {
  return drawValueChart(canvas, points, {
    color: accent || cssVar('--lapis', '#4a7dbd'),
    unit: '人',
    emptyText: '暂无人数数据',
    getY: (p) => playerCount(p),
    format: (v) => v + ' 人'
  })
}

export function drawLossChart(canvas, points, accent) {
  return drawValueChart(canvas, points, {
    color: accent || cssVar('--gold', '#e3b341'),
    unit: '%',
    emptyText: '暂无丢包数据',
    getY: (p, i, pts) => (pts && pts.length ? lossAt(pts, i) : null),
    format: (v) => v.toFixed(1) + '%',
    maxTop: 100
  })
}

/* ---------------- sparklines ---------------- */
export function drawSpark(canvas, points, accent = '#5ec96a') {
  const c = themeColors()
  const { ctx, w, h } = setupCanvas(canvas)
  if (!points || !points.length) return
  const stroke = accent || c.accent
  const vals = points.map((p) => (p.ok ? p.ms : null))
  const max = Math.max(60, ...vals.filter((v) => typeof v === 'number'))
  const n = vals.length
  const xAt = (i) => (n === 1 ? w / 2 : (w * i) / (n - 1))
  const yAt = (v) => h - 2 - (v / max) * (h - 6)

  ctx.fillStyle = c.danger
  ctx.globalAlpha = 0.18
  for (let i = 0; i < n; i++) {
    if (vals[i] === null) ctx.fillRect(xAt(i) - w / n / 2, 0, Math.max(1.5, w / n), h)
  }
  ctx.globalAlpha = 1
  ctx.strokeStyle = stroke
  ctx.lineWidth = 1.4
  ctx.beginPath()
  let started = false
  vals.forEach((v, i) => {
    if (v === null) { started = false; return }
    if (!started) { ctx.moveTo(xAt(i), yAt(v)); started = true } else ctx.lineTo(xAt(i), yAt(v))
  })
  ctx.stroke()
}

export function drawSparkByMetric(canvas, points, metric, accent = '#3ba0ff') {
  const c = themeColors()
  const { ctx, w, h } = setupCanvas(canvas)
  if (!points || !points.length) return
  const m = metric === 'players' || metric === 'loss' ? metric : 'latency'
  const stroke = m === 'loss' ? c.warn : m === 'players' ? (accent || c.accent) : (accent || c.accent)
  const vals = points.map((p, i, arr) => {
    if (m === 'players') return playerCount(p)
    if (m === 'loss') return lossAt(arr, i)
    return p.ok && typeof p.ms === 'number' ? p.ms : null
  })
  const nums = vals.filter((v) => typeof v === 'number')
  const max = Math.max(m === 'latency' ? 60 : 10, ...nums)
  const n = vals.length
  const xAt = (i) => (n === 1 ? w / 2 : (w * i) / (n - 1))
  const yAt = (v) => h - 2 - (v / max) * (h - 6)

  ctx.fillStyle = c.danger
  ctx.globalAlpha = 0.2
  for (let i = 0; i < n; i++) {
    if (!points[i].ok) ctx.fillRect(xAt(i) - w / n / 2, 0, Math.max(1.5, w / n), h)
  }
  ctx.globalAlpha = 1
  ctx.strokeStyle = stroke
  ctx.lineWidth = 1.4
  ctx.beginPath()
  let started = false
  vals.forEach((v, i) => {
    if (v === null || typeof v !== 'number') { started = false; return }
    if (!started) { ctx.moveTo(xAt(i), yAt(v)); started = true } else ctx.lineTo(xAt(i), yAt(v))
  })
  ctx.stroke()
  // single-sample series need a visible mark
  ctx.fillStyle = stroke
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i]
    if (typeof v !== 'number') continue
    const prevNull = i === 0 || typeof vals[i - 1] !== 'number'
    const nextNull = i === vals.length - 1 || typeof vals[i + 1] !== 'number'
    if (prevNull && nextNull) {
      ctx.beginPath()
      ctx.arc(xAt(i), yAt(v), 2, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}

export { lossAt, playerCount, timeLabel }
