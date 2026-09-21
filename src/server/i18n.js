import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ROOT, RUNTIME_DIR } from './paths.js'

const DEFAULT_PORT = 8636
const MAX_PORT_TRIES = 20
const START_TIMEOUT = 20000

let child = null
let childPort = 0
let childUrl = ''
let starting = null
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

function appendOutput(chunk) {
  outputTail = (outputTail + String(chunk)).slice(-4000)
  const m = outputTail.match(/127\.0\.0\.1:(\d+)/g)
  if (m?.length) {
    const n = Number(m[m.length - 1].split(':').pop())
    if (Number.isInteger(n) && n > 0) childPort = n
  }
}

async function waitForServer() {
  const started = Date.now()
  while (Date.now() - started < START_TIMEOUT) {
    if (!child || child.exitCode !== null) throw new Error(lastError || '翻译引擎进程已退出')
    const ports = []
    if (childPort) ports.push(childPort)
    for (let i = 0; i < MAX_PORT_TRIES; i++) {
      const p = DEFAULT_PORT + i
      if (!ports.includes(p)) ports.push(p)
    }
    for (const p of ports) {
      try {
        const res = await fetch(`http://127.0.0.1:${p}/api/status`, { signal: AbortSignal.timeout(500) })
        if (!res.ok) continue
        await res.text()
        childPort = p
        childUrl = `http://127.0.0.1:${p}`
        return getStatus()
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('翻译引擎启动超时' + (outputTail ? `：${outputTail.slice(-500)}` : ''))
}

function cleanupChild() {
  child = null
  childPort = 0
  childUrl = ''
  starting = null
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
  const args = ['gui', '--port', '0', '--no-browser']
  const command = exe || configuredPython(settings)
  const commandArgs = exe ? args : ['-m', 'mc_i18n', ...args]

  starting = (async () => {
    try {
      child = spawn(command, commandArgs, {
        cwd: base,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      child.stdout?.on('data', (d) => appendOutput(d.toString()))
      child.stderr?.on('data', (d) => appendOutput(d.toString()))
      child.on('error', (e) => { lastError = e.message })
      child.on('exit', (code, signal) => {
        if (code && !lastError) lastError = `翻译引擎退出（${code}${signal ? `/${signal}` : ''}）`
        cleanupChild()
      })
      const status = await waitForServer()
      // waitForServer 返回时进程已经可访问，但 finally 尚未执行；返回给 API
      // 的快照应反映可直接使用的状态，避免前端收到 running=true/starting=true。
      return { ...status, starting: false }
    } catch (e) {
      lastError = e.message
      try { child?.kill() } catch {}
      cleanupChild()
      throw e
    } finally {
      starting = null
    }
  })()
  return starting
}

export async function stop() {
  const p = child
  if (!p) return getStatus()
  try { p.kill() } catch {}
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 1500)
    p.once('exit', () => { clearTimeout(t); resolve() })
  })
  cleanupChild()
  return getStatus()
}

export function stopSync() {
  if (!child) return
  try { child.kill() } catch {}
  cleanupChild()
}
