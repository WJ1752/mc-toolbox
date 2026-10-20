// 启动实例：解析版本链、准备 natives、拼装参数、拉起 Java 进程并收集日志。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  findInstance,
  instancePaths,
  ensureInstanceDirs,
  getSettings,
  markPlayed,
  updateInstance,
  isInstalled
} from './state.js'
import { loadVersionChain, readAssetIndex } from './meta.js'
import { collectLibraries, buildLaunchPlan, previewCommand, requiredJavaMajor, analyzeCrash } from './launch-plan.js'
import { javaForInstance } from './java.js'
import { getSelectedAccount, ensureFreshAccount, ensureAuthlibInjector } from './accounts.js'

const sessions = new Map()
const MAX_LINES = 6000

function nowStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

function clock(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}

function sessionSnapshot(session) {
  if (!session) return null
  const now = Date.now()
  return {
    instanceId: session.instanceId,
    instanceName: session.instanceName,
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt || 0,
    elapsed: session.endedAt ? session.endedAt - session.startedAt : now - session.startedAt,
    pid: session.proc?.pid || session.pid || 0,
    exitCode: session.exitCode,
    javaPath: session.javaPath,
    javaMajor: session.javaMajor,
    command: session.command,
    logFile: session.logFile,
    error: session.error || '',
    crash: session.crash || null,
    seq: session.lines.length ? session.lines[session.lines.length - 1].seq : 0,
    stopping: session.stopping === true
  }
}

function pushLine(session, line, kind = '') {
  const seq = ++session.seq
  const text = String(line ?? '')
  const entry = { seq, t: clock(), text, kind }
  session.lines.push(entry)
  if (session.lines.length > MAX_LINES) session.lines.splice(0, session.lines.length - MAX_LINES)
  try { session.stream?.write(`[${clock()}] ${kind ? `[${kind}] ` : ''}${text}\n`) } catch {}
}

/**
 * Vanilla 1.12+ writes log4j XML to stdout when a log4j2 config is supplied.
 * Turn that stream into readable lines for the in-app console, while the game's
 * own latest.log remains the canonical file for crash analysis.
 */
function prettyGameLine(raw, session) {
  const text = String(raw ?? '')
  const event = /<log4j:Event\b[^>]*logger="([^"]*)"[^>]*level="([^"]*)"[^>]*thread="([^"]*)"/.exec(text)
  if (event) {
    session.xmlLevel = event[2]
    session.xmlLogger = event[1]
    session.xmlThread = event[3]
    return null
  }
  if (/^\s*<\/log4j:Event>/.test(text)) return null
  const message = /<log4j:Message><!\[CDATA\[([\s\S]*?)\]\]><\/log4j:Message>/.exec(text)
  if (message) {
    const level = session.xmlLevel && session.xmlLevel !== 'INFO' ? `[${session.xmlLevel}] ` : ''
    return level + message[1]
  }
  const throwable = /<log4j:Throwable><!\[CDATA\[([\s\S]*?)\]\]><\/log4j:Throwable>/.exec(text)
  if (throwable) return throwable[1]
  if (/^\s*<(?:log4j|!)/.test(text)) return null
  return text
}

function splitChunk(buffer, session, kind) {
  session.pending[kind] = (session.pending[kind] || '') + buffer
  const parts = session.pending[kind].split(/\r?\n/)
  session.pending[kind] = parts.pop() || ''
  for (const line of parts) {
    if (line === '') continue
    const pretty = prettyGameLine(line, session)
    if (pretty !== null && pretty !== '') pushLine(session, pretty, kind)
  }
}

export function getSession(instanceId) {
  return sessions.get(instanceId) || null
}

export function getSessionSnapshot(instanceId) {
  return sessionSnapshot(sessions.get(instanceId))
}

export function listSessions() {
  return [...sessions.values()].map(sessionSnapshot)
}

export function readLog(instanceId, after = 0) {
  const session = sessions.get(instanceId)
  if (!session) return { lines: [], seq: 0, running: false }
  const seq = Number(after) || 0
  return {
    lines: session.lines.filter((line) => line.seq > seq),
    seq: session.seq,
    running: session.status === 'running' || session.status === 'starting',
    status: session.status
  }
}

async function prepareNatives(inst, plan, paths, signal) {
  await fsp.mkdir(paths.nativesDir, { recursive: true })
  if (!plan.nativeJars.length) return
  const signature = plan.nativeJars.map((item) => `${item.path}:${item.size || 0}`).join('|')
  const stampFile = path.join(paths.nativesDir, '.mc-toolbox-natives')
  const existing = await fsp.readFile(stampFile, 'utf8').catch(() => '')
  if (existing === signature) return
  // Rebuild to avoid stale DLLs from a different Java/mod version.
  await fsp.rm(paths.nativesDir, { recursive: true, force: true })
  await fsp.mkdir(paths.nativesDir, { recursive: true })
  const { extractZip } = await import('../pack-converter.js')
  for (const native of plan.nativeJars) {
    signal?.throwIfAborted()
    const jar = path.join(paths.librariesDir, ...String(native.path).split('/'))
    if (!fs.existsSync(jar)) throw new Error(`缺少 natives 库：${native.path}`)
    await extractZip(jar, paths.nativesDir, null, signal)
  }
  await fsp.writeFile(stampFile, signature, 'utf8')
}

function missingFiles(inst, plan, paths) {
  const missing = []
  const clientJar = plan.clientJar
  if (!clientJar || !fs.existsSync(clientJar)) {
    missing.push(`客户端 JAR：${clientJar || '未解析'}`)
  }
  for (const lib of plan.nativeJars) {
    const file = path.join(paths.librariesDir, ...String(lib.path).split('/'))
    if (!fs.existsSync(file)) missing.push(`natives：${lib.path}`)
  }
  // Every classpath entry except the client jar lives under libraries.
  for (const entry of plan.classpath || []) {
    if (clientJar && entry === clientJar) continue
    if (!fs.existsSync(entry)) missing.push(path.relative(paths.root, entry))
  }
  return missing
}

/**
 * Build (but do not spawn) a launch plan. Used by the API preview and by start.
 */
export async function prepareLaunch(instanceId, { accountId = '', signal } = {}) {
  const inst = findInstance(instanceId)
  if (!inst) throw new Error('实例不存在')
  if (!isInstalled(inst)) throw new Error('实例尚未安装完成，请先等待安装或执行“检查并修复文件”')
  const paths = ensureInstanceDirs(inst)
  const { version, chain, rootId } = await loadVersionChain(paths.baseDir, inst.versionId)
  const javaMajor = requiredJavaMajor(version, inst.mc)
  const java = await javaForInstance(inst, { required: javaMajor })
  if (!java) throw new Error(`未找到兼容的 64 位 Java ${javaMajor}。请在启动器设置或实例设置中选择 / 下载 Java。`)

  const account = await getSelectedAccount(accountId)
  if (!account) throw new Error('还没有选择账户。请先在启动器里添加离线 / 微软 / 第三方账户。')
  const launchAccount = await ensureFreshAccount(account)

  const clientJarVersion = versionJarFor(version, rootId)
  const clientJar = path.join(paths.baseDir, 'versions', clientJarVersion, `${clientJarVersion}.jar`)
  const logConfigFile = await findLogConfig(paths, version)
  const varsPaths = {
    libraries: paths.librariesDir,
    assets: paths.assetsDir,
    assetIndexId: version.assetIndex?.id || version.assets || '',
    gameDir: paths.gameDir,
    nativesDir: paths.nativesDir,
    clientJar,
    versionName: version.id || inst.versionId,
    logConfigFile
  }
  const plan = buildLaunchPlan({
    version,
    paths: varsPaths,
    options: {
      minMemory: inst.memory.min,
      maxMemory: inst.memory.max,
      width: inst.width,
      height: inst.height,
      fullscreen: inst.fullscreen,
      server: inst.autoConnect ? inst.server : '',
      jvmArgs: inst.jvmArgs || getSettings().jvmArgs,
      gameArgs: inst.gameArgs || getSettings().gameArgs,
      mc: inst.mc
    },
    account: launchAccount
  })
  plan.javaMajor = javaMajor
  plan.java = java
  plan.account = launchAccount
  plan.inst = inst
  plan.paths = paths
  plan.clientJar = clientJar
  plan.serverVersion = rootId
  plan.missing = missingFiles(inst, plan, paths)
  plan.preview = previewCommand(plan, java.path)

  if (launchAccount.type === 'authlib' && launchAccount.authlibServer) {
    const authlib = await ensureAuthlibInjector(launchAccount.authlibServer, { signal })
    if (authlib?.jar) {
      plan.jvmArgs.push(`-javaagent:${authlib.jar}=${launchAccount.authlibServer}`, '-Dauthlibinjector.side=client')
      plan.javaagent = authlib.jar
    }
  }
  return plan
}

function versionJarFor(version, rootId) {
  return version.jar || version.clientVersion || rootId || version.id
}

async function findLogConfig(paths, version) {
  const client = version.logging?.client
  if (!client?.file?.id) return ''
  const candidates = [
    path.join(paths.assetsDir, 'log_configs', client.file.id),
    path.join(paths.assetsDir, 'log_configs', client.file.id.replace(/^.*[\\/]/, ''))
  ]
  for (const file of candidates) if (fs.existsSync(file)) return file
  return ''
}

/**
 * Spawn the game. Returns a session snapshot; callers poll readLog/getSessionSnapshot.
 */
export async function startInstance(instanceId, { accountId = '' } = {}) {
  const existing = sessions.get(instanceId)
  if (existing && (existing.status === 'running' || existing.status === 'starting')) {
    const error = new Error('该实例已经在运行中')
    error.code = 'ALREADY_RUNNING'
    throw error
  }
  const plan = await prepareLaunch(instanceId, { accountId })
  if (plan.missing.length) {
    const error = new Error(`游戏文件不完整，缺少 ${plan.missing.length} 个文件。请执行“检查并修复文件”。`)
    error.code = 'MISSING_FILES'
    error.missing = plan.missing.slice(0, 12)
    throw error
  }
  const inst = plan.inst
  const paths = plan.paths
  await prepareNatives(inst, plan, paths)
  await fsp.mkdir(paths.logsDir, { recursive: true })

  const logFile = path.join(paths.logsDir, `launch-${nowStamp()}.log`)
  const stream = fs.createWriteStream(logFile, { flags: 'a' })
  const session = {
    instanceId,
    instanceName: inst.name,
    status: 'starting',
    startedAt: Date.now(),
    proc: null,
    pid: 0,
    exitCode: null,
    javaPath: plan.java.path,
    javaMajor: plan.java.major,
    command: plan.preview,
    logFile,
    stream,
    lines: [],
    seq: 0,
    pending: {},
    error: '',
    crash: null,
    stopping: false
  }
  sessions.set(instanceId, session)
  pushLine(session, `启动 ${inst.name} · Minecraft ${inst.mc} · ${inst.loader === 'vanilla' ? '原版' : inst.loader + ' ' + inst.loaderVersion}`)
  pushLine(session, `Java ${plan.java.version || plan.java.major} · ${plan.java.path}`)
  pushLine(session, `游戏目录 ${paths.gameDir}`)
  if (plan.javaagent) pushLine(session, `authlib-injector：${plan.javaagent}`)

  let child
  try {
    child = spawn(plan.java.path, [...plan.jvmArgs, plan.mainClass, ...plan.gameArgs], {
      cwd: paths.gameDir,
      env: { ...process.env, MC_TOOLBOX_LAUNCHER: '1' },
      // GUI 子系统进程启动 java.exe（控制台程序）时，false 会额外弹出一个
      // 空白 cmd 窗口；true 让 Windows 使用 CREATE_NO_WINDOW，日志仍通过
      // stdout/stderr 管道回传。
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (e) {
    session.status = 'failed'
    session.error = e.message
    pushLine(session, '启动 Java 失败：' + e.message, 'err')
    try { stream.end() } catch {}
    throw e
  }

  session.proc = child
  session.pid = child.pid
  child.stdout.on('data', (chunk) => splitChunk(chunk.toString('utf8'), session, 'out'))
  child.stderr.on('data', (chunk) => splitChunk(chunk.toString('utf8'), session, 'err'))
  child.on('spawn', () => {
    session.status = 'running'
    markPlayed(instanceId)
    pushLine(session, `进程已启动（PID ${child.pid}）`, 'ok')
  })
  child.on('error', (e) => {
    session.status = 'failed'
    session.error = e.message
    pushLine(session, '进程错误：' + e.message, 'err')
  })
  child.on('exit', async (code, signal) => {
    session.exitCode = code
    session.endedAt = Date.now()
    const stoppedByUser = session.stopping === true
    session.status = stoppedByUser ? 'stopped' : code === 0 ? 'exited' : 'failed'
    session.proc = null
    pushLine(session, stoppedByUser
      ? '游戏已停止'
      : `游戏进程退出：code=${code}${signal ? ' signal=' + signal : ''}`, code === 0 || stoppedByUser ? 'ok' : 'err')
    const playSeconds = Math.max(0, Math.round((session.endedAt - session.startedAt) / 1000))
    try { markPlayed(instanceId, { playSeconds, countLaunch: false }) } catch {}
    // Flush any unterminated line.
    for (const kind of ['out', 'err']) {
      if (session.pending[kind]) {
        const pretty = prettyGameLine(session.pending[kind], session)
        if (pretty) pushLine(session, pretty, kind)
        session.pending[kind] = ''
      }
    }
    // A user-requested stop is not a crash; do not surface a stale report.
    try {
      const crash = stoppedByUser ? null : await inspectCrash(inst, session)
      if (crash) {
        session.crash = crash
        pushLine(session, `检测到崩溃报告：${crash.file}`, 'err')
        for (const hint of crash.hints) pushLine(session, `[诊断] ${hint.title}：${hint.suggestion}`, 'err')
      }
    } catch {}
    try { stream.end() } catch {}
  })

  return sessionSnapshot(session)
}

async function newestFileIn(dir, predicate, since = 0) {
  let items = []
  try { items = await fsp.readdir(dir, { withFileTypes: true }) } catch { return null }
  let best = null
  for (const entry of items) {
    if (!entry.isFile() || !predicate(entry.name)) continue
    const file = path.join(dir, entry.name)
    const stat = await fsp.stat(file).catch(() => null)
    if (!stat || stat.mtimeMs < since) continue
    if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs, size: stat.size, name: entry.name }
  }
  return best
}

export async function inspectCrash(inst, session = null) {
  const paths = instancePaths(inst)
  const cutoff = session?.startedAt ? session.startedAt - 5000 : Date.now() - 7 * 24 * 3600 * 1000
  const crash = await newestFileIn(paths.crashDir, (name) => /^crash-.*\.txt$/i.test(name), cutoff)
  let text = ''
  let file = ''
  let mtime = 0
  if (crash) {
    text = await fsp.readFile(crash.file, 'utf8').catch(() => '')
    file = crash.file
    mtime = crash.mtimeMs
  } else if (session && session.exitCode !== 0) {
    // A normal latest.log often contains harmless connection errors. Only use
    // it for diagnosis after a launch actually failed.
    const latest = path.join(paths.gameDir, 'logs', 'latest.log')
    const stat = await fsp.stat(latest).catch(() => null)
    if (stat) {
      text = (await fsp.readFile(latest, 'utf8').catch(() => '')).slice(-400 * 1024)
      file = latest
      mtime = stat.mtimeMs
    }
  }
  if (!text) return null
  const hints = analyzeCrash(text, {
    javaMajor: session?.javaMajor || 0,
    mc: inst.mc,
    memory: inst.memory?.max || 0
  })
  const description = /Description:\s*(.+)/i.exec(text)?.[1]?.trim() || /The game crashed whilst ([^\n]+)/i.exec(text)?.[1]?.trim() || ''
  if (!hints.length && !description && !crash) return null
  return {
    file,
    name: file ? path.basename(file) : '',
    mtime,
    description,
    hints,
    excerpt: text.split(/\r?\n/).filter((line) => /Description:|Caused by:|Exception|Error|crash/i.test(line)).slice(0, 24)
  }
}

export async function stopInstance(instanceId, { force = false } = {}) {
  const session = sessions.get(instanceId)
  if (!session || !session.proc) return { ok: false, error: '游戏未在运行' }
  session.stopping = true
  session.status = 'stopping'
  pushLine(session, force ? '正在强制结束游戏进程…' : '正在结束游戏进程…')
  const child = session.proc
  try { child.kill() } catch {}
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  for (let i = 0; i < 20; i++) {
    if (!session.proc) return { ok: true }
    await wait(150)
  }
  if (session.proc && process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {}
  } else if (session.proc) {
    try { session.proc.kill('SIGKILL') } catch {}
  }
  return { ok: true }
}

export async function launchStatus(instanceId) {
  const snapshot = getSessionSnapshot(instanceId)
  const inst = findInstance(instanceId)
  if (!inst) return { running: false }
  if (!snapshot) {
    return {
      running: false,
      installed: isInstalled(inst),
      latestLog: await newestLogFile(instancePaths(inst).logsDir),
      crash: await inspectCrash(inst)
    }
  }
  return {
    running: snapshot.status === 'running' || snapshot.status === 'starting' || snapshot.status === 'stopping',
    session: snapshot,
    installed: isInstalled(inst),
    crash: snapshot.crash || (snapshot.status !== 'running' ? await inspectCrash(inst) : null)
  }
}

async function newestLogFile(dir) {
  const file = await newestFileIn(dir, (name) => /\.log$/i.test(name), 0)
  return file ? { path: file.file, name: file.name, mtime: file.mtimeMs, size: file.size } : null
}

export async function readSavedLog(instanceId, file = '') {
  const inst = findInstance(instanceId)
  if (!inst) throw new Error('实例不存在')
  const paths = instancePaths(inst)
  let target = ''
  if (file) {
    const safe = path.basename(String(file))
    target = path.join(paths.logsDir, safe)
  } else {
    const latest = await newestLogFile(paths.logsDir)
    target = latest?.path || ''
  }
  if (!target || !fs.existsSync(target)) return { lines: [], file: '' }
  const text = await fsp.readFile(target, 'utf8')
  const lines = text.split(/\r?\n/).filter(Boolean).slice(-2000)
  return { lines, file: target, name: path.basename(target), mtime: fs.statSync(target).mtimeMs }
}

export function hasRunningGame() {
  return [...sessions.values()].some((session) => session.status === 'running' || session.status === 'starting')
}
