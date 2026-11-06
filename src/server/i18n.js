import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ROOT, RUNTIME_DIR } from './paths.js'

const START_TIMEOUT = 20000

let child = null
let childPort = 0
let childUrl = ''
let starting = null
let startAttempt = null
let lastError = ''
let outputTail = ''

function sourceDir() {
  const candidates = [
    path.join(ROOT, 'vendor', 'mc-i18n'),
    path.join(RUNTIME_DIR, 'mc-i18n')
  ]
  return candidates.find((p) => fs.existsSync(path.join(p, 'mc_i18n', '__main__.py'))) || ''
}

function bundledExe() {
  const base = sourceDir()
  if (!base) return ''
  const candidates = [
    path.join(base, 'mc-i18n.exe'),
    path.join(base, 'dist', 'mc-i18n.exe')
  ]
  return candidates.find((p) => fs.existsSync(p)) || ''
}

function configuredPython(settings = {}) {
  const value = String(settings?.i18n?.pythonPath || '').trim()
  return value || process.env.MC_TOOLBOX_PYTHON || 'python'
}

export function parseBoundPort(output) {
  // Require a complete banner line; a pipe may split both UTF-8 characters
  // and the port digits across chunks.
  const matches = [...String(output || '').matchAll(/(?:^|\n)[\t ]*图形界面地址[：:][\t ]*http:\/\/127\.0\.0\.1:(\d{1,5})[\t ]*\r?\n/g)]
  const port = Number(matches.at(-1)?.[1])
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0
}

function appendOutput(proc, chunk) {
  if (child !== proc) return
  outputTail = (outputTail + String(chunk)).slice(-4000)
  const port = parseBoundPort(outputTail)
  if (port) childPort = port
}

async function reserveLoopbackPort() {
  const server = net.createServer()
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address()?.port || 0
    if (!port) throw new Error('无法分配翻译工作台端口')
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    return port
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(() => resolve()))
  }
}

async function waitForServer(proc, attempt, requestedPort) {
  const started = Date.now()
  while (Date.now() - started < START_TIMEOUT) {
    if (attempt.cancelled) throw new Error('翻译工作台启动已取消')
    if (child !== proc || proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(lastError || '翻译引擎进程已退出')
    }
    if (lastError) throw new Error(lastError)
    // 只探测由本子进程打印的 bind 地址。扫默认端口会把其他本机服务
    // 暴露的同名 API 误认成翻译引擎，随后把错误 URL 返回给前端。
    const ports = [...new Set([requestedPort, childPort].filter(Boolean))]
    for (const port of ports) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(500) })
        const serverHeader = String(res.headers.get('server') || '')
        if (res.ok && serverHeader.startsWith('mc-i18n-webui/')) {
          const data = await res.json().catch(() => null)
          if (data && typeof data === 'object' && Object.hasOwn(data, 'job') && typeof data.version === 'string') {
            if (attempt.cancelled) throw new Error('翻译工作台启动已取消')
            if (child !== proc || proc.exitCode !== null || proc.signalCode !== null) {
              throw new Error(lastError || '翻译引擎进程已退出')
            }
            childPort = port
            childUrl = `http://127.0.0.1:${port}`
            return getStatus()
          }
        }
      } catch (error) {
        if (attempt.cancelled || child !== proc || proc.exitCode !== null || proc.signalCode !== null || lastError) {
          throw new Error(lastError || error?.message || '翻译引擎进程已退出')
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('翻译引擎启动超时' + (outputTail ? `：${outputTail.slice(-500)}` : ''))
}

function cleanupChild(expected = null) {
  if (expected && child !== expected) return
  child = null
  childPort = 0
  childUrl = ''
}

export function getStatus() {
  const base = sourceDir()
  return {
    available: !!base,
    sourceDir: base,
    bundled: !!bundledExe(),
    running: !!child && child.exitCode === null && !!childUrl,
    starting: !!starting,
    port: childPort || null,
    url: childUrl || null,
    error: lastError || null
  }
}

export async function start(settings = {}) {
  if (child && child.exitCode === null && childUrl) return getStatus()
  if (starting) return starting

  const base = sourceDir()
  if (!base) throw new Error('未找到内置 mc-i18n 运行时')
  lastError = ''
  outputTail = ''
  const exe = bundledExe()
  const command = exe || configuredPython(settings)
  const attempt = { cancelled: false }

  const task = (async () => {
    let proc = null
    try {
      // An older optional PyInstaller EXE may buffer its URL banner. Give it a
      // known free loopback port so readiness does not depend on that output.
      const requestedPort = exe ? await reserveLoopbackPort() : 0
      if (attempt.cancelled) return { ...getStatus(), starting: false }
      if (requestedPort) childPort = requestedPort
      const args = ['gui', '--port', String(requestedPort), '--no-browser']
      const commandArgs = exe ? args : ['-u', '-m', 'mc_i18n', ...args]
      proc = spawn(command, commandArgs, {
        cwd: base,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      child = proc
      proc.stdout?.setEncoding('utf8')
      proc.stderr?.setEncoding('utf8')
      proc.stdout?.on('data', (d) => appendOutput(proc, d))
      proc.stderr?.on('data', (d) => appendOutput(proc, d))
      proc.on('error', (e) => { if (child === proc) lastError = e.message })
      proc.on('exit', (code, signal) => {
        if (child === proc && code && !lastError) lastError = `翻译引擎退出（${code}${signal ? `/${signal}` : ''}）`
        cleanupChild(proc)
      })
      const status = await waitForServer(proc, attempt, requestedPort)
      // waitForServer 返回时进程已经可访问，但 finally 尚未执行；返回给 API
      // 的快照应反映可直接使用的状态，避免前端收到 running=true/starting=true。
      return { ...status, starting: false }
    } catch (e) {
      if (attempt.cancelled) {
        try { proc?.kill() } catch {}
        cleanupChild(proc)
        return { ...getStatus(), starting: false }
      }
      if (!proc || child === proc) lastError = e.message
      try { proc?.kill() } catch {}
      cleanupChild(proc)
      throw e
    }
  })()
  starting = task
  startAttempt = attempt
  try {
    return await task
  } finally {
    if (starting === task) starting = null
    if (startAttempt === attempt) startAttempt = null
  }
}

export async function stop() {
  const p = child
  const attempt = startAttempt
  const pendingStart = starting
  if (attempt) attempt.cancelled = true
  if (!p) {
    await pendingStart?.catch(() => {})
    return getStatus()
  }
  try { p.kill() } catch {}
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 1500)
    p.once('exit', () => { clearTimeout(t); resolve() })
  })
  cleanupChild(p)
  await pendingStart?.catch(() => {})
  return getStatus()
}

export function stopSync() {
  if (startAttempt) startAttempt.cancelled = true
  if (!child) return
  try { child.kill() } catch {}
  cleanupChild()
}
