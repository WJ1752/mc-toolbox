// 轻量 Canvas 折线图（延迟监测用）
export function drawLatencyChart(canvas, points, opts = {}) {
  const css = getComputedStyle(document.documentElement)
  const accent = (opts.accent || css.getPropertyValue('--accent').trim() || '#5ec96a')
  const danger = '#ff5f56'
  const gridColor = css.getPropertyValue('--line').trim() || '#333'
  const textColor = css.getPropertyValue('--text-mute').trim() || '#888'
  const warnAt = opts.warnAt || 200

  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth || 600
  const hgt = canvas.clientHeight || 200
  canvas.width = Math.floor(w * dpr)
  canvas.height = Math.floor(hgt * dpr)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, hgt)

  const padL = 38
  const padR = 8
  const padT = 10
  const padB = 20
  const iw = Math.max(10, w - padL - padR)
  const ih = Math.max(10, hgt - padT - padB)

  if (!points || !points.length) {
    ctx.fillStyle = textColor
    ctx.font = '12px system-ui'
    ctx.textAlign = 'center'
    ctx.fillText('暂无数据', w / 2, hgt / 2)
    return
  }

  const vals = points.map((p) => (p.ok ? p.ms : null)).filter((v) => typeof v === 'number')
  const maxV = Math.max(warnAt * 1.5, ...(vals.length ? vals : [50]))
  const top = Math.ceil(maxV / 50) * 50

  // 网格
  ctx.strokeStyle = gridColor
  ctx.fillStyle = textColor
  ctx.font = '10px system-ui'
  ctx.textAlign = 'right'
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const y = padT + (ih * i) / 4
    ctx.beginPath()
    ctx.moveTo(padL, y + 0.5)
    ctx.lineTo(padL + iw, y + 0.5)
    ctx.stroke()
    ctx.fillText(String(Math.round((top * (4 - i)) / 4)), padL - 6, y + 3)
  }

  // 告警线
  if (warnAt < top) {
    const y = padT + ih - (warnAt / top) * ih
    ctx.strokeStyle = 'rgba(255,189,46,.45)'
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(padL, y)
    ctx.lineTo(padL + iw, y)
    ctx.stroke()
    ctx.setLineDash([])
  }

  const n = points.length
  const xAt = (i) => padL + (n === 1 ? iw / 2 : (iw * i) / (n - 1))
  const yAt = (v) => padT + ih - (Math.min(v, top) / top) * ih

  // 离线区间
  ctx.fillStyle = 'rgba(255,95,86,.22)'
  for (let i = 0; i < n; i++) {
    if (!points[i].ok) {
      const x0 = xAt(i) - (n === 1 ? 20 : iw / (n - 1) / 2)
      ctx.fillRect(x0, padT, Math.max(2, (n === 1 ? 40 : iw / (n - 1))), ih)
    }
  }

  // 折线
  ctx.strokeStyle = accent
  ctx.lineWidth = 1.8
  ctx.lineJoin = 'round'
  ctx.beginPath()
  let started = false
  points.forEach((p, i) => {
    if (!p.ok || typeof p.ms !== 'number') {
      started = false
      return
    }
    const x = xAt(i)
    const y = yAt(p.ms)
    if (!started) {
      ctx.moveTo(x, y)
      started = true
    } else ctx.lineTo(x, y)
  })
  ctx.stroke()

  // 超阈值点标红
  ctx.fillStyle = danger
  points.forEach((p, i) => {
    if (p.ok && typeof p.ms === 'number' && p.ms > warnAt) {
      ctx.beginPath()
      ctx.arc(xAt(i), yAt(p.ms), 2.6, 0, Math.PI * 2)
      ctx.fill()
    }
  })

  // 时间轴
  ctx.fillStyle = textColor
  ctx.textAlign = 'center'
  const fmt = (t) => {
    const d = new Date(t)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  ctx.fillText(fmt(points[0].t), padL + 12, hgt - 6)
  if (n > 1) ctx.fillText(fmt(points[n - 1].t), padL + iw - 12, hgt - 6)
}

// 丢包率（窗口内失败占比）：history 点没有逐点真实丢包，用「近 N 个探测点里失败比例」近似
const LOSS_WIN = 12
function lossAt(points, i) {
  const s = Math.max(0, i - LOSS_WIN + 1)
  let fails = 0
  for (let j = s; j <= i; j++) if (!points[j].ok) fails++
  return +((fails / (i - s + 1)) * 100).toFixed(1)
}

// 历史点里的 players 是「在线人数数字」（少数老数据为 {online} 对象），统一取值
function playerCount(p) {
  if (!p || !p.ok) return null
  const v = p.players
  if (typeof v === 'number' && !Number.isNaN(v)) return v
  if (v && typeof v.online === 'number') return v.online
  return null
}

// 通用数值折线大图（延迟/人数/丢包共用骨架），风格与延迟图一致
function drawValueChart(canvas, points, { color = '#3ba0ff', getY = null, emptyText = '暂无数据', unit = '' } = {}) {
  const css = getComputedStyle(document.documentElement)
  const stroke = color || css.getPropertyValue('--accent').trim() || '#3ba0ff'
  const gridColor = css.getPropertyValue('--line').trim() || '#333'
  const textColor = css.getPropertyValue('--text-mute').trim() || '#888'

  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth || 600
  const hgt = canvas.clientHeight || 200
  canvas.width = Math.floor(w * dpr)
  canvas.height = Math.floor(hgt * dpr)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, hgt)

  const padL = 38, padR = 8, padT = 10, padB = 20
  const iw = Math.max(10, w - padL - padR)
  const ih = Math.max(10, hgt - padT - padB)

  const pairs = (points || []).map((p, i) => {
    let v = null
    try { if (p && getY) { const raw = getY(p, i, points); if (raw != null && !Number.isNaN(raw)) v = raw } } catch {}
    return { i, v: v < 0 ? null : v }
  })
  const nums = pairs.filter((x) => x.v != null).map((x) => x.v)
  if (!nums.length) {
    ctx.fillStyle = textColor
    ctx.font = '12px system-ui'
    ctx.textAlign = 'center'
    ctx.fillText(emptyText, w / 2, hgt / 2)
    return
  }
  const maxV = Math.max(...nums)
  const step = maxV <= 10 ? 2 : maxV <= 40 ? 10 : maxV <= 100 ? 20 : maxV <= 250 ? 50 : maxV <= 1000 ? 100 : maxV <= 5000 ? 500 : 1000
  const top = Math.max(step, Math.ceil(maxV / step) * step)
  const n = points.length
  const xAt = (i) => padL + (n === 1 ? iw / 2 : (iw * i) / (n - 1))
  const yAt = (v) => padT + ih - (Math.min(v, top) / top) * ih

  // 网格
  ctx.strokeStyle = gridColor
  ctx.fillStyle = textColor
  ctx.font = '10px system-ui'
  ctx.textAlign = 'right'
  ctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const y = padT + (ih * i) / 4
    ctx.beginPath()
    ctx.moveTo(padL, y + 0.5)
    ctx.lineTo(padL + iw, y + 0.5)
    ctx.stroke()
    ctx.fillText(String(Math.round((top * (4 - i)) / 4)) + (unit ? ' ' + unit : ''), padL - 6, y + 3)
  }

  // 折线（离线 / 无数据处断开）
  ctx.lineWidth = 1.6
  ctx.strokeStyle = stroke
  ctx.beginPath()
  let pen = false
  for (const { i, v } of pairs) {
    if (v == null) { pen = false; continue }
    const x = xAt(i)
    const y = yAt(v)
    if (!pen) { ctx.moveTo(x, y); pen = true } else ctx.lineTo(x, y)
  }
  ctx.stroke()

  // 时间轴
  ctx.fillStyle = textColor
  ctx.textAlign = 'center'
  const fmt = (t) => {
    const d = new Date(t)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  ctx.fillText(fmt(points[0].t), padL + 12, hgt - 6)
  if (n > 1) ctx.fillText(fmt(points[n - 1].t), padL + iw - 12, hgt - 6)
}

// 在线人数折线：取每个 ok 探测点的人数（p.players 为数字或 {online}）
export function drawPlayersChart(canvas, points, accent = '#3ba0ff') {
  return drawValueChart(canvas, points, {
    color: accent,
    emptyText: '暂无人数数据',
    getY: (p) => playerCount(p)
  })
}

// 丢包率折线：窗口内失败占比（无逐点真实丢包，用近 12 点失败比例近似）
export function drawLossChart(canvas, points, accent = '#ff8a4c') {
  return drawValueChart(canvas, points, {
    color: accent,
    unit: '%',
    emptyText: '暂无丢包数据',
    getY: (p, i, pts) => lossAt(pts, i)
  })
}

// 迷你 sparkline
export function drawSpark(canvas, points, accent = '#5ec96a') {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth || 200
  const h = canvas.clientHeight || 34
  canvas.width = Math.floor(w * dpr)
  canvas.height = Math.floor(h * dpr)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (!points || !points.length) return
  const vals = points.map((p) => (p.ok ? p.ms : null))
  const max = Math.max(60, ...vals.filter((v) => typeof v === 'number'))
  const n = vals.length
  const xAt = (i) => (n === 1 ? w / 2 : (w * i) / (n - 1))
  const yAt = (v) => h - 2 - (v / max) * (h - 6)

  ctx.fillStyle = 'rgba(255,95,86,.25)'
  for (let i = 0; i < n; i++) {
    if (vals[i] === null) ctx.fillRect(xAt(i) - w / n / 2, 0, Math.max(1.5, w / n), h)
  }
  ctx.strokeStyle = accent
  ctx.lineWidth = 1.4
  ctx.beginPath()
  let started = false
  vals.forEach((v, i) => {
    if (v === null) {
      started = false
      return
    }
    if (!started) {
      ctx.moveTo(xAt(i), yAt(v))
      started = true
    } else ctx.lineTo(xAt(i), yAt(v))
  })
  ctx.stroke()
}

// 迷你折线（磁贴卡片）也跟随「图表指标」：
//   latency → 原延迟 sparkline；players → 在线人数；loss → 近 12 点失败占比（%）
export function drawSparkByMetric(canvas, points, metric, accent = '#3ba0ff') {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth || 200
  const h = canvas.clientHeight || 34
  canvas.width = Math.floor(w * dpr)
  canvas.height = Math.floor(h * dpr)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (!points || !points.length) return

  const m = metric === 'players' || metric === 'loss' ? metric : 'latency'
  const stroke = m === 'loss' ? '#ff8a4c' : accent
  const vals = points.map((p, i, arr) => {
    if (m === 'players') return playerCount(p)
    if (m === 'loss') return lossAt(arr, i)
    return p.ok ? p.ms : null
  })
  const nums = vals.filter((v) => typeof v === 'number')
  const max = Math.max(m === 'latency' ? 60 : 10, ...nums)
  const n = vals.length
  const xAt = (i) => (n === 1 ? w / 2 : (w * i) / (n - 1))
  const yAt = (v) => h - 2 - (v / max) * (h - 6)

  // 离线区间（红底竖条）
  ctx.fillStyle = 'rgba(255,95,86,.25)'
  for (let i = 0; i < n; i++) {
    if (!points[i].ok) ctx.fillRect(xAt(i) - w / n / 2, 0, Math.max(1.5, w / n), h)
  }
  ctx.strokeStyle = stroke
  ctx.lineWidth = 1.4
  ctx.beginPath()
  let started = false
  vals.forEach((v, i) => {
    if (v === null || typeof v !== 'number') {
      started = false
      return
    }
    if (!started) {
      ctx.moveTo(xAt(i), yAt(v))
      started = true
    } else ctx.lineTo(xAt(i), yAt(v))
  })
  ctx.stroke()
}
