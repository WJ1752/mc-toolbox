import { store } from './store.js'
import { pingServer, parseAddress } from './mc-ping.js'
import { DEFAULT_SETTINGS } from './defaults.js'

const monitors = () => store.get('monitors', { items: [] })
const runtime = new Map() // id -> { history, current, fails, streakFails, lastAttempt, checking, totalChecks, totalOk }

let tickTimer = null
let running = false

function settingsNow() {
  return store.get('settings', DEFAULT_SETTINGS)
}

const METRICS = ['latency', 'players', 'loss']
function pickMetric(...vals) {
  for (const v of vals) if (METRICS.includes(v)) return v
  return 'latency'
}

function ensureRuntime(id) {
  if (!runtime.has(id)) {
    runtime.set(id, {
      history: [],
      current: null,
      fails: 0,
      streakFails: 0,
      lastAttempt: 0,
      checking: false,
      totalChecks: 0,
      totalOk: 0
    })
  }
  return runtime.get(id)
}

function loadHistory() {
  const h = store.get('history', { byId: {} })
  for (const [id, arr] of Object.entries(h.byId || {})) {
    const r = ensureRuntime(id)
    r.history = Array.isArray(arr) ? arr.slice(-Math.max(60, settingsNow().monitor.historyPoints)) : []
  }
}

function persistHistory(force = false) {
  const byId = {}
  for (const [id, r] of runtime.entries()) byId[id] = r.history
  store.set('history', { byId, updatedAt: Date.now() })
  if (!force) store.schedule('history', 15000)
}

export function statsOf(r) {
  const h = r.history
  const okPoints = h.filter((p) => p.ok)
  const lat = okPoints.map((p) => p.ms).filter((n) => typeof n === 'number')
  const total = h.length || 1
  const recent = h.slice(-60)
  const recentOk = recent.filter((p) => p.ok).length
  return {
    total: h.length,
    uptime: h.length ? +((okPoints.length / total) * 100).toFixed(2) : null,
    uptimeRecent: recent.length ? +((recentOk / recent.length) * 100).toFixed(2) : null,
    avg: lat.length ? +(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(1) : null,
    min: lat.length ? +Math.min(...lat).toFixed(1) : null,
    max: lat.length ? +Math.max(...lat).toFixed(1) : null,
    jitter: lat.length > 1 ? +(Math.max(...lat) - Math.min(...lat)).toFixed(1) : null,
    loss: h.length ? +(((h.length - okPoints.length) / total) * 100).toFixed(2) : 0,
    streakFails: r.streakFails,
    totalChecks: r.totalChecks,
    totalOk: r.totalOk
  }
}

async function runCheck(mon) {
  const r = ensureRuntime(mon.id)
  if (r.checking) return
  r.checking = true
  r.lastAttempt = Date.now()
  const s = settingsNow()
  let result
  try {
    result = await pingServer({
      host: mon.host,
      port: mon.port,
      type: mon.type || 'auto',
      timeout: s.network.timeout,
      retries: s.network.retries,
      settings: s.network
    })
  } catch (e) {
    result = { ok: false, error: e.message, latency: null, data: null }
  }
  r.totalChecks++
  const point = {
    t: Date.now(),
    ok: result.ok ? 1 : 0,
    ms: result.ok && result.latency != null ? Number(result.latency) : null,
    players: result.data?.players?.online ?? null
  }
  if (result.ok) {
    r.totalOk++
    r.streakFails = 0
  } else {
    r.streakFails++
  }
  r.current = {
    ok: !!result.ok,
    offline: r.streakFails >= (s.monitor.offlineAfter || 2),
    latency: point.ms,
    edition: result.edition || null,
    error: result.ok ? null : result.error || '请求失败',
    players: result.data?.players || null,
    version: result.data?.version || null,
    motd: result.data?.motd || null,
    checkedAt: point.t,
    resolved: { host: result.resolvedHost, port: result.resolvedPort, ip: result.ip, viaSrv: result.viaSrv }
  }
  r.history.push(point)
  const cap = Math.max(60, s.monitor.historyPoints)
  if (r.history.length > cap) r.history.splice(0, r.history.length - cap)
  r.checking = false
  store.schedule('history', 15000)
}

async function tick() {
  if (!running) return
  const s = settingsNow()
  const items = monitors().items.filter((m) => m.paused !== true)
  const now = Date.now()
  const due = items.filter((m) => {
    const r = ensureRuntime(m.id)
    if (r.checking) return false
    const interval = Math.max(5, m.interval || s.monitor.defaultInterval) * 1000
    return now - r.lastAttempt >= interval
  })
  const limit = Math.max(1, s.network.concurrency || 8)
  const batch = due.slice(0, limit)
  await Promise.all(batch.map((m) => runCheck(m).catch(() => {})))
}

export function startEngine() {
  loadHistory()
  running = settingsNow().monitor.autoStart === true
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
  if (running) {
    tickTimer = setInterval(tick, 1000)
    tickTimer.unref?.()
    setTimeout(tick, 500)
  }
}

export function stopEngine() {
  running = false
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null }
  persistHistory(true)
}

export function isRunning() {
  return running
}

export function setRunning(v) {
  running = !!v
  if (running && !tickTimer) {
    tickTimer = setInterval(tick, 1000)
    tickTimer.unref?.()
    setTimeout(tick, 50)
  } else if (!running && tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  return running
}

export function listMonitors() {
  return monitors().items.map((m) => ({ ...m }))
}

export function addMonitor(data) {
  const s = settingsNow()
  const parsed = parseAddress(data.host, data.port || (data.type === 'bedrock' ? s.network.bedrockPort : s.network.javaPort))
  const mon = {
    id: 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: (data.name || '').trim() || parsed.host + ':' + parsed.port,
    host: parsed.host,
    port: parsed.port,
    type: data.type || 'auto',
    interval: Number(data.interval) || s.monitor.defaultInterval,
    color: data.color || null,
    metric: pickMetric(data.metric, s.monitor.defaultMetric),
    createdAt: Date.now(),
    paused: false
  }
  const db = monitors()
  db.items.push(mon)
  store.set('monitors', db)
  ensureRuntime(mon.id)
  setTimeout(() => runCheck(mon).catch(() => {}), 50)
  return mon
}

export function updateMonitor(id, patch) {
  const db = monitors()
  const idx = db.items.findIndex((m) => m.id === id)
  if (idx < 0) return null
  const allowed = ['name', 'host', 'port', 'type', 'interval', 'color', 'paused', 'metric']
  for (const k of allowed) {
    if (patch[k] === undefined) continue
    if (k === 'metric' && !METRICS.includes(patch[k])) continue
    db.items[idx][k] = patch[k]
  }
  store.set('monitors', db)
  return db.items[idx]
}

// 一键把「所有」监测项的主显示指标统一为某一种
export function setAllMetric(metric) {
  if (!METRICS.includes(metric)) return 0
  const db = monitors()
  let changed = 0
  for (const m of db.items) {
    if ((m.metric || 'latency') !== metric) {
      m.metric = metric
      changed++
    }
  }
  if (changed) store.set('monitors', db)
  return changed
}

export function reorderMonitors(ids) {
  const db = monitors()
  const map = new Map(db.items.map((m) => [m.id, m]))
  const next = []
  for (const id of ids || []) {
    const m = map.get(id)
    if (m) {
      next.push(m)
      map.delete(id)
    }
  }
  for (const m of map.values()) next.push(m)
  db.items = next
  store.set('monitors', db)
  return db.items
}

export function removeMonitor(id) {
  const db = monitors()
  db.items = db.items.filter((m) => m.id !== id)
  store.set('monitors', db)
  runtime.delete(id)
  const h = store.get('history', { byId: {} })
  if (h.byId) delete h.byId[id]
  store.set('history', h)
  return true
}

export async function checkNow(id) {
  const mon = monitors().items.find((m) => m.id === id)
  if (!mon) return null
  await runCheck(mon)
  return snapshotOne(mon)
}

export function snapshotOne(mon) {
  const r = ensureRuntime(mon.id)
  return {
    ...mon,
    status: r.current,
    stats: statsOf(r),
    history: r.history.slice(-Math.max(60, settingsNow().monitor.chartRange || 120))
  }
}

export function snapshot() {
  const items = monitors().items
  return {
    running,
    serverTime: Date.now(),
    items: items.map(snapshotOne)
  }
}

export function clearHistory(id) {
  if (id) {
    const r = runtime.get(id)
    if (r) {
      r.history = []
      r.totalChecks = 0
      r.totalOk = 0
    }
  } else {
    for (const r of runtime.values()) {
      r.history = []
      r.totalChecks = 0
      r.totalOk = 0
    }
  }
  persistHistory(true)
  return true
}

export { persistHistory }
