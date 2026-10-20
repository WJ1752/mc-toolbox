// Page heartbeat — lets the backend know the application window is still open.
// The server's window watchdog relies on this: closing the window stops the
// local HTTP server. A failed beat is surfaced after three consecutive misses.
import { bus } from './bus.js'

const INTERVAL = 10000
const FAIL_THRESHOLD = 3

let banner = null
let failCount = 0
let beats = 0
let lastOkAt = null
let started = false

function state() {
  const level = failCount >= FAIL_THRESHOLD ? 'red' : failCount > 0 ? 'amber' : 'green'
  return { level, failCount, beats, lastOkAt }
}

function emit() {
  bus.emit('heartbeat:state', state())
}

function showDisconnected() {
  if (banner || !document.body) return
  banner = document.createElement('div')
  banner.className = 'conn-banner'
  banner.setAttribute('role', 'alert')
  banner.textContent = '本地服务已停止，所有功能暂时不可用。请关闭本窗口并重新启动 MC 工具箱。'
  document.body.appendChild(banner)
}

function hideDisconnected() {
  if (!banner) return
  banner.remove()
  banner = null
}

export function startHeartbeat() {
  if (started) return
  started = true

  const beat = () => {
    try {
      fetch('/api/heartbeat', { method: 'POST', keepalive: true })
        .then((r) => {
          if (!r.ok) throw new Error('bad status')
          failCount = 0
          beats++
          lastOkAt = Date.now()
          hideDisconnected()
          emit()
        })
        .catch(() => {
          failCount++
          if (failCount >= FAIL_THRESHOLD) showDisconnected()
          emit()
        })
    } catch {
      failCount++
      if (failCount >= FAIL_THRESHOLD) showDisconnected()
      emit()
    }
  }

  beat()
  setInterval(beat, INTERVAL)
  emit()

  const bye = () => {
    try { navigator.sendBeacon('/api/shutdown') } catch {}
  }
  window.addEventListener('beforeunload', bye)
  window.addEventListener('pagehide', bye)
}

export function getHeartbeatState() {
  return state()
}
