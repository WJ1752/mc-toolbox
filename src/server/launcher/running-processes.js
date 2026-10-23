// 接管「启动器之外」仍在运行的 Minecraft 客户端。
//
// 场景：启动器退出/更新后游戏还在跑，再次打开启动器时内存里的 session 已经没了。
// 这个模块定期读取系统进程表，按命令行里的 --gameDir 把 java.exe / javaw.exe
// 对应回实例列表；只读命令行，不把命令行（可能含 --accessToken）返回给前端。
//
// 同时提供按 PID 关闭进程的底层能力：先发关闭请求，超时后再强制结束。所有操作
// 都会在动作前重新扫描并校验 PID + gameDir，避免 PID 复用误杀其它进程。
import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'

const DEFAULT_TTL_MS = 4000
const DEFAULT_ERROR_TTL_MS = 12000
const POWERSHELL_TIMEOUT_MS = 7000
const MAX_BUFFER = 8 * 1024 * 1024

const POWERSHELL_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$items = @()',
  'try {',
  '  $items = Get-CimInstance Win32_Process -Filter "Name=\'java.exe\' OR Name=\'javaw.exe\'"',
  '} catch {',
  '  $items = Get-WmiObject Win32_Process -Filter "Name=\'java.exe\' OR Name=\'javaw.exe\'"',
  '}',
  'if ($items) {',
  "  $items | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine, @{n='StartedAt';e={ if ($_.CreationDate -is [datetime]) { $_.CreationDate.ToUniversalTime().ToString('o') } elseif ($_.CreationDate) { [string]$_.CreationDate } else { '' } }} | ConvertTo-Json -Compress",
  '}'
].join('\n')

function decodeOutput(buffer) {
  if (!buffer) return ''
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer))
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return data.toString('utf16le', 2)
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    const swapped = Buffer.from(data.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  return data.toString('utf8').replace(/^\uFEFF/, '')
}

function runFile(file, args, { timeout = POWERSHELL_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      windowsHide: true,
      timeout,
      maxBuffer: MAX_BUFFER,
      encoding: 'buffer'
    }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(decodeOutput(stdout))
    })
  })
}

function powershellPath() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const candidate = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return fs.existsSync(candidate) ? candidate : 'powershell.exe'
}

/**
 * 从命令行里取一个启动参数，支持 `--name value` / `--name=value` 与引号路径。
 * 只做参数级解析，不把整条命令行外传。
 */
export function extractCommandArgument(commandLine, name) {
  const text = String(commandLine || '')
  const key = String(name || '').trim()
  if (!text || !key) return ''
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:^|\\s)${escaped}(?:\\s*=\\s*|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s]+))`, 'i')
  const match = re.exec(text)
  if (!match) return ''
  return String(match[1] ?? match[2] ?? match[3] ?? '').trim()
}

/** 只有带 --gameDir 且具备 Minecraft 启动参数的 Java 进程才会被当成游戏。 */
export function isMinecraftJavaProcess(commandLine) {
  const text = String(commandLine || '')
  if (!text || !/(?:^|\s)--gameDir(?:\s|=)/i.test(text)) return false
  // 不能用 --version 单独判定：部分服务端/普通 Java 程序也会传 --version。
  // 客户端一定有 assets 参数、Mojang/加载器主类或启动器品牌标记之一。
  return /(?:^|\s)--assetIndex(?:\s|=)|(?:^|\s)--assetsDir(?:\s|=)|-Dminecraft\.|net\.minecraft|net\.fabricmc|org\.quiltmc|cpw\.mods|net\.neoforged|org\.multimc/i.test(text)
}

/** 路径比较键：Windows 盘符/分隔符/大小写不敏感，POSIX 保持大小写。 */
export function gameDirKey(value) {
  let text = String(value || '').trim()
  if (!text) return ''
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1)
  }
  const windowsPath = /^[a-zA-Z]:[\\/]/.test(text) || /^\\\\/.test(text)
  let resolved
  try {
    resolved = process.platform === 'win32' || windowsPath ? path.win32.resolve(text) : path.resolve(text)
  } catch {
    resolved = text
  }
  resolved = resolved.replace(/[\\/]+$/, '')
  if (/^[a-zA-Z]:$/.test(resolved)) resolved += '\\'
  return process.platform === 'win32' || windowsPath ? resolved.toLowerCase() : resolved
}

function parseStartedAt(value) {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  const text = String(value).trim()
  const dateLiteral = /\/Date\((\d+)\)\//.exec(text)
  if (dateLiteral) return Number(dateLiteral[1]) || 0
  const numeric = Number(text)
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeProcessRecord(record) {
  if (!record || typeof record !== 'object') return null
  const commandLine = String(record.CommandLine ?? record.commandLine ?? '')
  if (!commandLine) return null
  const pid = Number(record.ProcessId ?? record.pid)
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null
  if (!isMinecraftJavaProcess(commandLine)) return null
  const gameDir = extractCommandArgument(commandLine, '--gameDir')
  if (!gameDir) return null
  const startedAt = parseStartedAt(record.StartedAt ?? record.startedAt)
  return {
    pid,
    ppid: Number(record.ParentProcessId ?? record.ppid) || 0,
    executablePath: String(record.ExecutablePath ?? record.executablePath ?? ''),
    commandLine,
    startedAt,
    gameDir,
    versionId: extractCommandArgument(commandLine, '--version'),
    brand: (/-Dminecraft\.launcher\.brand=("[^"]*"|[^\s"]+)/i.exec(commandLine)?.[1] || '').replace(/^"|"$/g, '')
  }
}

/** 解析 PowerShell 的 CIM 输出；空输出表示没有 Java 进程。 */
export function parseWindowsProcesses(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim()
  if (!raw) return []
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('系统进程列表格式无法解析')
  }
  const list = Array.isArray(data) ? data : [data]
  return list.map(normalizeProcessRecord).filter(Boolean)
}

/**
 * 把进程与实例按 gameDir 精确匹配。
 * @param {Array} processes scan 返回的进程
 * @param {Array<{id:string,name:string,gameDir:string,lastPlayed?:number,paths?:object}>} instances
 * @returns {Map<string, object>} instanceId -> process（含 instance 引用）
 */
export function mapProcessesToInstances(processes, instances) {
  const byDir = new Map()
  const sorted = (Array.isArray(instances) ? instances : [])
    .filter((item) => item && item.id && (item.gameDir || item.paths?.gameDir))
    .slice()
    .sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))
  for (const instance of sorted) {
    const key = gameDirKey(instance.gameDir || instance.paths?.gameDir)
    if (!key) continue
    if (!byDir.has(key)) byDir.set(key, [])
    byDir.get(key).push(instance)
  }

  const mapped = new Map()
  for (const processItem of Array.isArray(processes) ? processes : []) {
    if (!processItem) continue
    const key = gameDirKey(processItem.gameDir)
    if (!key) continue
    const candidates = byDir.get(key)
    if (!candidates?.length) continue
    // 同一个 gameDir 被多个实例引用时优先最近游玩的实例；一个实例只认一个进程。
    const instance = candidates.find((item) => !mapped.has(item.id)) || candidates[0]
    if (!instance || mapped.has(instance.id)) continue
    mapped.set(instance.id, {
      ...processItem,
      instanceId: instance.id,
      instanceName: instance.name || instance.id,
      instance
    })
  }
  return mapped
}

function processFromPid(pid, psLine) {
  // ps 的 command 列可能带前导空格；不在这里拆 JVM 参数，只保留原始文本。
  const text = String(psLine || '').trim()
  return {
    pid,
    ppid: 0,
    executablePath: text.split(/\s+/)[0] || '',
    commandLine: text,
    startedAt: 0,
    gameDir: extractCommandArgument(text, '--gameDir'),
    versionId: extractCommandArgument(text, '--version'),
    brand: ''
  }
}

async function scanUnixProcesses() {
  let text = ''
  let hasElapsed = false
  try {
    text = await runFile('ps', ['-axo', 'pid=,ppid=,etimes=,command='], { timeout: 5000 })
    hasElapsed = true
  } catch {
    text = await runFile('ps', ['-axo', 'pid=,ppid=,command='], { timeout: 5000 })
  }
  const now = Date.now()
  const out = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = hasElapsed
      ? /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)
      : /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    const elapsed = hasElapsed ? Number(match[3]) : 0
    const commandLine = hasElapsed ? match[4] : match[3]
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
    if (!isMinecraftJavaProcess(commandLine)) continue
    const item = processFromPid(pid, commandLine)
    if (!item.gameDir) continue
    item.ppid = ppid
    item.startedAt = hasElapsed && elapsed > 0 ? now - elapsed * 1000 : 0
    out.push(item)
  }
  return out
}

/** 读取系统里真实的 Minecraft Java 进程。失败时抛错，由 tracker 保留上次结果。 */
export async function scanGameProcesses() {
  if (process.platform === 'win32') {
    const text = await runFile(powershellPath(), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_SCRIPT
    ])
    return parseWindowsProcesses(text)
  }
  return await scanUnixProcesses()
}

export function isProcessAlive(pid) {
  const id = Number(pid)
  if (!Number.isInteger(id) || id <= 0) return false
  try {
    process.kill(id, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function runTaskkill(pid, { force = false } = {}) {
  return new Promise((resolve) => {
    const args = ['/PID', String(pid), '/T']
    if (force) args.push('/F')
    let child
    try {
      child = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' })
    } catch (error) {
      resolve({ ok: false, error: error.message })
      return
    }
    child.on('error', (error) => resolve({ ok: false, error: error.message }))
    child.on('exit', (code) => resolve({ ok: code === 0, code }))
  })
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  return !isProcessAlive(pid)
}

/** 先发关闭请求（Windows 为 WM_CLOSE），不等待进程退出。 */
export async function requestProcessClose(pid) {
  const id = Number(pid)
  if (!Number.isInteger(id) || id <= 0 || id === process.pid) return { ok: false, error: '无效的进程 PID' }
  if (process.platform === 'win32') return await runTaskkill(id, { force: false })
  try {
    process.kill(id, 'SIGTERM')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

/** 强制结束进程；Windows 用 taskkill /F /T。 */
export async function forceKillProcess(pid) {
  const id = Number(pid)
  if (!Number.isInteger(id) || id <= 0 || id === process.pid) return { ok: false, error: '无效的进程 PID' }
  if (process.platform === 'win32') return await runTaskkill(id, { force: true })
  try {
    process.kill(id, 'SIGKILL')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}

/** 关闭并等待：先礼后兵，供测试或需要同步结果的调用方使用。 */
export async function terminateProcess(pid, { force = false, timeoutMs = 8000 } = {}) {
  if (!isProcessAlive(pid)) return { ok: true, alreadyExited: true }
  if (force) {
    const result = await forceKillProcess(pid)
    const exited = await waitForExit(pid, 3000)
    return { ...result, ok: exited, forced: true }
  }
  await requestProcessClose(pid)
  const graceful = await waitForExit(pid, timeoutMs)
  if (graceful) return { ok: true, forced: false }
  const result = await forceKillProcess(pid)
  const exited = await waitForExit(pid, 3000)
  return { ...result, ok: exited, forced: true }
}

/**
 * 带 TTL 的进程检测器。扫描失败时保留上一次结果并暴露 error，避免把仍在运行的
 * 游戏误判成“已退出”而允许删除/覆盖实例目录。
 */
export function createRunningGameTracker({
  scan = scanGameProcesses,
  ttlMs = DEFAULT_TTL_MS,
  errorTtlMs = DEFAULT_ERROR_TTL_MS,
  now = () => Date.now()
} = {}) {
  let items = []
  let byInstance = new Map()
  let rawProcesses = []
  let mappedKey = ''
  let at = 0
  let scannedAt = 0
  let error = ''
  let pending = null

  function instanceKey(instances) {
    return (Array.isArray(instances) ? instances : [])
      .map((item) => `${item?.id || ''}\u0000${gameDirKey(item?.gameDir || item?.paths?.gameDir)}`)
      .sort()
      .join('\u0001')
  }

  function apply(processes, instances) {
    rawProcesses = Array.isArray(processes) ? processes : []
    const mapped = mapProcessesToInstances(rawProcesses, instances)
    byInstance = mapped
    items = [...mapped.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
    mappedKey = instanceKey(instances)
  }

  async function refresh({ instances = [], force = false, processes = null } = {}) {
    const stamp = now()
    const ttl = error ? errorTtlMs : ttlMs
    if (!force && !processes && at && stamp - at < ttl) {
      if (mappedKey !== instanceKey(instances)) apply(rawProcesses, instances)
      return { items, scannedAt, error, cached: true }
    }
    if (pending) {
      if (!force && !processes) return pending
      try { await pending } catch {}
    }
    if (processes) {
      apply(processes, instances)
      at = stamp
      scannedAt = stamp
      error = ''
      return { items, scannedAt, error, cached: false }
    }

    pending = (async () => {
      try {
        const scanned = await scan()
        apply(scanned, instances)
        error = ''
        at = now()
        scannedAt = at
      } catch (scanError) {
        error = '实例进程检测失败：' + (scanError?.message || '无法读取系统进程列表')
        at = now()
        scannedAt = at
      } finally {
        pending = null
      }
      return { items, scannedAt, error, cached: false }
    })()
    return await pending
  }

  function list() { return items.slice() }
  function get(instanceId) { return byInstance.get(instanceId) || null }
  function forget(instanceId) {
    if (!byInstance.has(instanceId)) return
    byInstance.delete(instanceId)
    items = items.filter((item) => item.instanceId !== instanceId)
    rawProcesses = rawProcesses.filter((item) => {
      const mapped = [...byInstance.values()].some((entry) => entry.pid === item.pid)
      return mapped
    })
  }
  function status() {
    return {
      scannedAt,
      error,
      stale: !!error && items.length > 0,
      count: items.length
    }
  }
  function clear() {
    items = []
    byInstance = new Map()
    rawProcesses = []
    mappedKey = ''
    at = 0
    scannedAt = 0
    error = ''
    pending = null
  }

  return { refresh, list, get, forget, status, clear }
}

// 生产单例：launch.js 在每次 status/bootstrap 时 refresh。
export const runningGameTracker = createRunningGameTracker()
