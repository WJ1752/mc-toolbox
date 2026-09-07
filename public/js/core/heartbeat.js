// 页面心跳：让后端知道「应用窗口还开着」
//
// 后端（server.js 的 startWindowWatchdog）靠这个判断窗口是否真的关闭了，
// 从而决定什么时候停止服务。之所以需要这个：Edge/Chrome 是多进程架构，
// spawn 出来的 msedge.exe 把 URL 转交给主进程后会立刻自行退出，
// 后端不能靠子进程的 exit 事件判断窗口关闭（那样会「窗口还在、服务已死」）。
//
// 关窗/刷新时主动 sendBeacon 通知后端，做到「关窗即停服务」。
// 连续心跳失败时，在页面上给出明确提示，避免用户只看到一片 failed to fetch。

const INTERVAL = 10000 // 10 秒一跳
const FAIL_THRESHOLD = 3 // 连续失败 3 次（约 30 秒）才提示

let banner = null
let failCount = 0

function showDisconnected() {
  if (banner) return
  banner = document.createElement('div')
  banner.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
    'background:#c0392b', 'color:#fff', 'padding:10px 14px',
    'font-size:13px', 'text-align:center', 'box-shadow:0 2px 8px rgba(0,0,0,.3)'
  ].join(';')
  banner.textContent = '⚠ 本地服务已停止，所有功能暂时不可用。请关闭本窗口并重新启动 MC 工具箱。'
  document.body.appendChild(banner)
}

function hideDisconnected() {
  if (!banner) return
  banner.remove()
  banner = null
}

export function startHeartbeat() {
  const beat = () => {
    try {
      fetch('/api/heartbeat', { method: 'POST', keepalive: true })
        .then((r) => {
          if (!r.ok) throw new Error('bad status')
          failCount = 0
          hideDisconnected()
        })
        .catch(() => {
          failCount++
          if (failCount >= FAIL_THRESHOLD) showDisconnected()
        })
    } catch {
      failCount++
      if (failCount >= FAIL_THRESHOLD) showDisconnected()
    }
  }

  // 立即发一次，让后端尽快确认页面已连上（避免误触发 fallback / 退出）
  beat()
  setInterval(beat, INTERVAL)

  const bye = () => {
    try { navigator.sendBeacon('/api/shutdown') } catch {}
  }
  window.addEventListener('beforeunload', bye)
  window.addEventListener('pagehide', bye)
}
