// 判定「游戏窗口真的出现了」。
//
// 旧实现只要 Java 进程吐出第一行日志、甚至 1.5 秒没有输出，就当作窗口就绪，
// 于是 hero 卡片会在游戏还没画出来时就显示「运行中」。这里改用两个真实信号：
//   1. Windows：轮询该 PID 的主窗口句柄（GLFW 窗口创建后 MainWindowHandle != 0）
//   2. 全平台兜底：日志里出现只有窗口创建后才会打印的标记
// 两者任一命中即视为就绪；进程退出 / 用户取消由调用方结束等待。
import { spawn } from 'node:child_process'

// 这些行都来自 LWJGL 窗口创建之后的初始化代码（Render thread 在窗口建好后启动），
// 因此可以作为「窗口已经出现」的跨平台兜底判据。
const WINDOW_MARKERS = [
  /Backend library:\s*LWJGL/i,
  /OpenGL Vendor:/i,
  /Setting user:/i,
  /\[Render thread\/(?:INFO|WARN)\]/i,
  /\bLWJGL Version\b/i
]

export function looksLikeWindowReady(line) {
  const text = String(line || '')
  if (!text) return false
  return WINDOW_MARKERS.some((re) => re.test(text))
}

// 单条 PowerShell 常驻轮询：只回传 READY / GONE，避免 Node 端每 300ms 起一次进程。
function pollScript(pid) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$deadline = (Get-Date).AddHours(2)',
    'while ((Get-Date) -lt $deadline) {',
    `  $p = Get-Process -Id ${Number(pid)}`,
    "  if (-not $p) { 'GONE'; break }",
    "  if ($p.MainWindowHandle -ne 0) { 'READY'; break }",
    '  Start-Sleep -Milliseconds 300',
    '}'
  ].join('\n')
}

/**
 * 监听指定 PID 是否出现主窗口。
 * @returns {() => void} 停止监听的函数（必须调用，避免残留 powershell 进程）
 */
export function watchProcessWindow(pid, onSignal) {
  const id = Number(pid)
  if (!Number.isFinite(id) || id <= 0) return () => {}
  if (process.platform !== 'win32') return () => {}

  let child = null
  let stopped = false
  try {
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', pollScript(id)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return () => {}
  }

  let buffer = ''
  child.stdout?.on('data', (chunk) => {
    if (stopped) return
    buffer += chunk.toString('utf8')
    if (buffer.includes('READY')) {
      stopped = true
      onSignal?.('window')
    } else if (buffer.includes('GONE')) {
      stopped = true
      onSignal?.('gone')
    }
  })
  child.on('error', () => {})

  return () => {
    stopped = true
    try { child?.stdout?.destroy() } catch {}
    try { child?.kill() } catch {}
  }
}
