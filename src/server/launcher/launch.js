// 启动实例：账户 → 版本 → Java → 文件 → natives → 进程 → 窗口。
//
// 对外行为：
//   - startInstance 立即返回 session snapshot（准备期间 status='starting'），
//     真正的准备 / 拉起进程在后台进行，前端通过 launchStatus().launch 看阶段进度。
//   - prepareLaunch 仍返回完整启动计划供预览（不 spawn）。
//   - 所有失败都转换成 createLaunchError 的中文结构化错误（code/detail/missing/paths/actions）。
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
  isInstalled
} from './state.js'
import { loadVersionChain, readAssetIndex } from './meta.js'
import {
  buildLaunchPlan,
  previewCommand,
  requiredJavaMajor,
  javaCompatible,
  analyzeCrash
} from './launch-plan.js'
import { javaForInstance, discoverJava } from './java.js'
import { looksLikeWindowReady, watchProcessWindow } from './game-window.js'
import { getSelectedAccount, ensureFreshAccount, ensureAuthlibInjector } from './accounts.js'
import {
  LAUNCH_PHASES,
  createLaunchError,
  publicLaunchState,
  phaseLabel
} from './launch-phases.js'

const sessions = new Map()
const launchStates = new Map()
const MAX_LINES = 6000
const PHASE_ORDER = LAUNCH_PHASES.map((item) => item.id)

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
  if (session.streamEnded) return
  try { session.stream?.write(`[${clock()}] ${kind ? `[${kind}] ` : ''}${text}\n`) } catch {}
}

function endSessionStream(session) {
  if (!session || !session.stream || session.streamEnded) return
  session.streamEnded = true
  try { session.stream.end() } catch {}
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

/* ------------------------------------------------------------------ */
/* Launch state helpers                                                */
/* ------------------------------------------------------------------ */

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'ABORTED'
}

function errorPaths(inst, paths, extra = {}) {
  const p = paths || (inst ? instancePaths(inst) : {})
  return {
    gameDir: p.gameDir || '',
    logsDir: p.logsDir || '',
    versionJson: p.versionJson || '',
    baseDir: p.baseDir || '',
    ...(extra.clientJar ? { clientJar: extra.clientJar } : {})
  }
}

function setPhase(state, id, detail, progress = null) {
  const changed = state.phase !== id
  const index = PHASE_ORDER.indexOf(id)
  state.phase = id
  state.phaseLabel = phaseLabel(id)
  state.step = index >= 0 ? index + 1 : state.step
  state.total = LAUNCH_PHASES.length
  if (detail !== undefined) state.detail = detail
  state.progress = progress === null ? null : Math.max(0, Math.min(100, Math.round(Number(progress) || 0)))
  state.indeterminate = state.progress === null
  state.updatedAt = Date.now()
  if (changed && state.session) pushLine(state.session, `[准备] ${phaseLabel(id)}`)
}

function setProgress(state, progress, detail) {
  state.progress = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)))
  state.indeterminate = false
  if (detail) state.detail = detail
  state.updatedAt = Date.now()
}

function updateState(state, patch = {}) {
  Object.assign(state, patch)
  state.updatedAt = Date.now()
}

/** 返回可公开的启动状态（去掉 proc / controller / session）。 */
export function getLaunchState(instanceId) {
  return publicLaunchState(launchStates.get(instanceId))
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length)
  let cursor = 0
  const size = Math.max(1, Math.min(Number(limit) || 8, items.length || 1))
  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      out[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return out
}

async function fileExists(file) {
  if (!file) return false
  try {
    const stat = await fsp.stat(file)
    return stat.isFile()
  } catch { return false }
}

/* ------------------------------------------------------------------ */
/* Error classifiers (exported for tests / previews)                   */
/* ------------------------------------------------------------------ */

export function classifyJava({ required = 0, discovered = [], paths = {} } = {}) {
  const req = Number(required) || 0
  const list = Array.isArray(discovered) ? discovered : []
  const compatible = list.filter((item) => javaCompatible(req, Number(item?.major) || 0))
  if (compatible.length) return null
  if (list.length) {
    const found = list.slice(0, 10).map((item) => {
      const version = item.version ? ` (${item.version})` : ''
      const where = item.path ? ` — ${item.path}` : ''
      return `Java ${item.major || '?'}${version}${where}`
    }).join('\n')
    return createLaunchError('JAVA_TOO_OLD', {
      message: `未找到兼容的 Java ${req}（本机 Java 版本过旧）。`,
      detail: `游戏需要 Java ${req}，本机发现的运行时都低于要求：\n${found}\n\n请在启动器设置中下载 Java ${req}，或在实例设置里手动选择兼容的 java.exe。`,
      paths
    })
  }
  return createLaunchError('NO_JAVA', {
    message: `未找到可用的 64 位 Java ${req}。`,
    detail: `游戏需要 64 位 Java ${req}，但启动器在本机没有发现任何可用的 Java 运行时。请在设置中下载 Java，或在实例设置里手动选择 java.exe。`,
    paths
  })
}

export function classifyMissingFiles({
  missing = [],
  missingCount,
  external = false,
  gameDirWritable = true,
  paths = {}
} = {}) {
  const list = Array.isArray(missing) ? missing.map((item) => String(item ?? '')).filter(Boolean) : []
  const total = Number(missingCount) > 0 ? Number(missingCount) : list.length
  if (external && gameDirWritable === false) {
    return createLaunchError('EXTERNAL_DIR_UNWRITABLE', {
      detail: `外部游戏目录不存在或不可写：${paths.gameDir || '(未提供)'}\n游戏需要在该目录写入 options.txt、logs 与存档。请检查目录权限，或在实例设置中改用启动器隔离目录。`,
      paths
    })
  }
  return createLaunchError('MISSING_FILES', {
    missing: list.slice(0, 20),
    missingCount: total,
    detail: `共缺少 ${total} 个游戏文件，例如：\n${list.slice(0, 8).join('\n') || '(未提供明细)'}\n\n请执行“检查并修复文件”补齐后再启动。`,
    paths
  })
}

/* ------------------------------------------------------------------ */
/* Preparation stages                                                  */
/* ------------------------------------------------------------------ */

async function resolveAccount(inst, { accountId = '', account = null } = {}) {
  const paths = errorPaths(inst)
  let selected = account
  if (!selected) {
    try {
      selected = getSelectedAccount(accountId)
    } catch (e) {
      if (isAbortError(e)) throw e
      throw createLaunchError('NO_ACCOUNT', {
        detail: `读取账户失败：${e.message}`,
        cause: e,
        paths
      })
    }
  }
  if (!selected) throw createLaunchError('NO_ACCOUNT', { paths })
  if (account) return account
  try {
    return (await ensureFreshAccount(selected)) || selected
  } catch (e) {
    if (isAbortError(e)) throw e
    const name = selected.name || selected.id || ''
    throw createLaunchError('NO_ACCOUNT', {
      message: '账户校验或刷新失败，请重新登录。',
      detail: `账户「${name}」刷新失败：${e.message}`,
      cause: e,
      paths
    })
  }
}

async function resolveVersion(inst, paths) {
  try {
    return await loadVersionChain(paths.baseDir, inst.versionId)
  } catch (e) {
    if (isAbortError(e)) throw e
    throw createLaunchError('VERSION_JSON_MISSING', {
      detail: `无法加载版本「${inst.versionId || inst.mc || '未知'}」：${e.message}\n版本 JSON：${paths.versionJson}\n版本目录：${paths.versionDir}`,
      cause: e,
      paths: errorPaths(inst, paths)
    })
  }
}

async function resolveJavaRuntime(inst, version, paths, { java = null } = {}) {
  const javaMajor = requiredJavaMajor(version, inst.mc)
  if (java) return { java, javaMajor }
  let picked = null
  try {
    // 实例没指定 Java 时用设置里的「默认 Java」，而不是直接按版本号挑一个。
    picked = await javaForInstance(inst, { required: javaMajor, preferred: getSettings().defaultJava || '' })
  } catch (e) {
    if (isAbortError(e)) throw e
  }
  if (!picked) {
    let discovered = []
    try { discovered = await discoverJava() } catch {}
    throw classifyJava({ required: javaMajor, discovered, paths: errorPaths(inst, paths) })
  }
  return { java: picked, javaMajor }
}

function versionJarFor(version, rootId) {
  return version.jar || version.clientVersion || rootId || version.id
}

/** 依次尝试版本 JSON 命名、实例 jarVersion / versionId / mc 候选。 */
function resolveClientJar(paths, versionName) {
  const candidates = []
  if (versionName) candidates.push(path.join(paths.baseDir, 'versions', versionName, `${versionName}.jar`))
  for (const file of paths.clientJarCandidates || []) candidates.push(file)
  const unique = [...new Set(candidates.filter(Boolean))]
  for (const file of unique) {
    if (fs.existsSync(file)) return file
  }
  return unique[0] || ''
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

async function assemblePlan(inst, paths, versionInfo, java, javaMajor, launchAccount, signal) {
  const { version, chain, rootId } = versionInfo
  const clientJarVersion = versionJarFor(version, rootId)
  const clientJar = resolveClientJar(paths, clientJarVersion)
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
  plan.clientJarVersion = clientJarVersion
  plan.serverVersion = rootId
  plan.version = version
  plan.chain = chain
  plan.rootId = rootId
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
    if (!fs.existsSync(entry)) missing.push(path.relative(paths.baseDir, entry))
  }
  return missing
}

/**
 * Build (but do not spawn) a launch plan. Used by the API preview and by start.
 * Optional `account` / `java` allow tests to inject a fake identity and runtime;
 * optional `instance` lets tests exercise the version check without touching
 * the shared launcher store.
 */
export async function prepareLaunch(instanceId, { accountId = '', signal, account = null, java = null, instance = null } = {}) {
  const inst = instance || findInstance(instanceId)
  if (!inst) throw new Error('实例不存在')
  const knownPaths = instancePaths(inst)
  // 版本 JSON 缺失优先于“安装未完成”，方便前端直接提示具体原因。
  if (!fs.existsSync(knownPaths.versionJson)) {
    throw createLaunchError('VERSION_JSON_MISSING', {
      detail: `版本 JSON 不存在：${knownPaths.versionJson}\n请确认实例版本目录是否被移动或删除，然后执行“检查并修复文件”或重新安装。`,
      paths: errorPaths(inst, knownPaths)
    })
  }
  if (!isInstalled(inst)) {
    throw new Error('实例尚未安装完成，请先等待安装或执行“检查并修复文件”')
  }
  const paths = ensureInstanceDirs(inst)
  const launchAccount = await resolveAccount(inst, { accountId, account })
  const versionInfo = await resolveVersion(inst, paths)
  const { java: pickedJava, javaMajor } = await resolveJavaRuntime(inst, versionInfo.version, paths, { java })
  const plan = await assemblePlan(inst, paths, versionInfo, pickedJava, javaMajor, launchAccount, signal)
  plan.missing = missingFiles(inst, plan, paths)
  return plan
}

async function collectMissingFiles(plan, paths, { signal } = {}) {
  const fixed = []
  const seen = new Set()
  const addFixed = (file, label) => {
    const key = path.resolve(file || label)
    if (seen.has(key)) return
    seen.add(key)
    fixed.push({ file, label })
  }

  const clientJar = plan.clientJar || ''
  addFixed(clientJar, `客户端 JAR：${clientJar || '未解析'}`)
  for (const entry of plan.classpath || []) {
    if (clientJar && path.resolve(entry) === path.resolve(clientJar)) continue
    addFixed(entry, `库文件：${path.relative(paths.baseDir, entry).replace(/\\/g, '/')}`)
  }
  for (const native of plan.nativeJars || []) {
    const file = path.join(paths.librariesDir, ...String(native.path || '').split('/'))
    addFixed(file, `natives JAR：${native.path || path.basename(file)}`)
  }

  let missingCount = 0
  const missing = []
  const fixedResults = await mapLimit(fixed, 16, async (item) => ({ ...item, ok: await fileExists(item.file) }))
  for (const item of fixedResults) {
    if (item.ok) continue
    missingCount++
    if (missing.length < 20) missing.push(item.label)
  }

  const assetId = plan.version?.assetIndex?.id || plan.version?.assets || ''
  if (assetId) {
    signal?.throwIfAborted()
    let info = null
    try { info = await readAssetIndex(paths.baseDir, plan.version) } catch { info = null }
    const indexPath = info?.file || path.join(paths.baseDir, 'assets', 'indexes', `${assetId}.json`)
    if (!info?.index) {
      missingCount++
      if (missing.length < 20) missing.push(`资源索引：${path.relative(paths.baseDir, indexPath).replace(/\\/g, '/')}`)
    } else if (!info.index.objects || typeof info.index.objects !== 'object') {
      missingCount++
      if (missing.length < 20) missing.push(`资源索引格式无效：${path.basename(indexPath)}`)
    } else {
      const entries = Object.entries(info.index.objects)
      const results = await mapLimit(entries, 16, async ([name, value]) => {
        signal?.throwIfAborted()
        const hash = String(value?.hash || '')
        if (!/^[0-9a-f]{40}$/i.test(hash)) return { name, ok: false }
        const file = path.join(paths.baseDir, 'assets', 'objects', hash.slice(0, 2), hash)
        return { name, ok: await fileExists(file) }
      })
      for (const result of results) {
        if (result.ok) continue
        missingCount++
        if (missing.length < 20) missing.push(`资源对象：${result.name}`)
      }
    }
  }
  return { missing, missingCount }
}

async function prepareNatives(inst, plan, paths, signal, onProgress) {
  await fsp.mkdir(paths.nativesDir, { recursive: true })
  if (!plan.nativeJars.length) {
    onProgress?.(1, '该版本无需解压 natives')
    return
  }
  const signature = plan.nativeJars.map((item) => `${item.path}:${item.size || 0}`).join('|')
  const stampFile = path.join(paths.nativesDir, '.mc-toolbox-natives')
  const existing = await fsp.readFile(stampFile, 'utf8').catch(() => '')
  if (existing === signature) {
    onProgress?.(1, 'natives 已是最新，无需解压')
    return
  }
  // Rebuild to avoid stale DLLs from a different Java/mod version.
  await fsp.rm(paths.nativesDir, { recursive: true, force: true })
  await fsp.mkdir(paths.nativesDir, { recursive: true })
  const { extractZip } = await import('../pack-converter.js')
  const total = plan.nativeJars.length
  for (let i = 0; i < total; i++) {
    signal?.throwIfAborted()
    const native = plan.nativeJars[i]
    const jar = path.join(paths.librariesDir, ...String(native.path).split('/'))
    if (!fs.existsSync(jar)) {
      throw createLaunchError('MISSING_FILES', {
        missing: [`natives：${native.path}`],
        missingCount: 1,
        detail: `缺少 natives 库：${jar}\n请执行“检查并修复文件”补齐后再启动。`,
        paths: errorPaths(inst, paths)
      })
    }
    await extractZip(
      jar,
      paths.nativesDir,
      (ratio, name) => onProgress?.((i + ratio) / total, `正在解压 natives：${name || native.path}`),
      signal
    )
    onProgress?.(
      (i + 1) / total,
      `已解压 ${i + 1}/${total} 个 natives 库`
    )
  }
  await fsp.writeFile(stampFile, signature, 'utf8')
}

/* ------------------------------------------------------------------ */
/* Process / session lifecycle                                         */
/* ------------------------------------------------------------------ */

async function ensureSessionLog(session) {
  if (session.stream || session.streamEnded || !session.logFile) return
  try {
    await fsp.mkdir(path.dirname(session.logFile), { recursive: true })
    const stream = fs.createWriteStream(session.logFile, { flags: 'a' })
    stream.on('error', () => {})
    session.stream = stream
    for (const line of session.lines) {
      try { stream.write(`[${line.t}] ${line.kind ? `[${line.kind}] ` : ''}${line.text}\n`) } catch {}
    }
  } catch (e) {
    pushLine(session, '无法写入启动日志：' + e.message, 'err')
  }
}

async function spawnGame(session, plan, paths) {
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
    throw createLaunchError('SPAWN_FAILED', {
      detail: `系统未能创建 Java 进程：${e.message}\n命令：${plan.preview}`,
      cause: e,
      paths: errorPaths(plan.inst, paths, { clientJar: plan.clientJar })
    })
  }

  // 从 spawn 返回的那一刻就接管 stdout/stderr/exit，避免“进程已启动但还没
  // 等到 spawn 事件”的窗口期丢日志或丢退出事件。
  session.proc = child
  session.pid = child.pid || 0
  child.stdout?.on('data', (chunk) => {
    session.gotOutput = true
    splitChunk(chunk.toString('utf8'), session, 'out')
  })
  child.stderr?.on('data', (chunk) => {
    session.gotOutput = true
    splitChunk(chunk.toString('utf8'), session, 'err')
  })

  return await new Promise((resolve, reject) => {
    let settled = false
    let spawned = false
    const settleOk = () => {
      if (settled) return
      settled = true
      resolve(child)
    }
    const settleError = (e) => {
      if (settled) return
      settled = true
      session.proc = null
      session.pid = 0
      reject(e)
    }

    child.once('spawn', () => {
      spawned = true
      settleOk()
    })
    child.on('error', (e) => {
      if (!settled) {
        settleError(createLaunchError('SPAWN_FAILED', {
          detail: `Java 进程启动失败：${e.message}\n命令：${plan.preview}`,
          cause: e,
          paths: errorPaths(plan.inst, paths, { clientJar: plan.clientJar })
        }))
        return
      }
      if (session.exited) return
      session.status = 'failed'
      session.error = '进程错误：' + e.message
      pushLine(session, '进程错误：' + e.message, 'err')
      const state = launchStates.get(session.instanceId)
      if (state && (state.status === 'preparing' || state.status === 'spawning')) {
        failLaunch(state, session, createLaunchError('SPAWN_FAILED', {
          detail: `Java 进程运行中发生错误：${e.message}`,
          cause: e,
          paths: errorPaths(plan.inst, paths, { clientJar: plan.clientJar })
        }))
        try { child.kill() } catch {}
      }
    })
    child.on('exit', (code, signal) => {
      if (!spawned) {
        settleError(createLaunchError('SPAWN_FAILED', {
          detail: `Java 进程在启动完成前退出：code=${code}${signal ? ` signal=${signal}` : ''}\n命令：${plan.preview}`,
          paths: errorPaths(plan.inst, paths, { clientJar: plan.clientJar })
        }))
        return
      }
      void handleGameExit(session, code, signal)
    })
  })
}
/**
 * 等待游戏窗口真正出现，返回 'window' | 'exit' | 'abort'。
 *
 * 判据（任一命中即就绪）：
 *   - Windows 上该 PID 的主窗口句柄变为非 0（GLFW 窗口已创建）
 *   - 日志里出现窗口创建之后才会有的标记（Render thread / LWJGL / OpenGL …）
 *
 * 没有“等 N 毫秒就算成功”的兜底：那样会让卡片在游戏还没画出来时显示运行中。
 * 等待期间用 onTick 上报已等待秒数，供前端展示真实进度文案。
 */
function waitForWindow(session, child, { signal, onTick } = {}) {
  return new Promise((resolve) => {
    if (session.exited || child.exitCode !== null) return resolve('exit')
    if (signal?.aborted) return resolve('abort')

    let done = false
    let cursor = Number(session.seq) || 0
    let timer = null
    let stopPoll = () => {}
    const startedAt = Date.now()

    const scanNewLines = () => {
      const lines = session.lines || []
      if (!lines.length) return false
      let hit = false
      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = lines[i]
        if (!entry || Number(entry.seq) <= cursor) break
        if (looksLikeWindowReady(entry.text)) hit = true
      }
      cursor = Number(session.seq) || cursor
      return hit
    }

    const finish = (reason) => {
      if (done) return
      done = true
      clearInterval(timer)
      stopPoll()
      child.removeListener('exit', onExit)
      try { signal?.removeEventListener?.('abort', onAbort) } catch {}
      resolve(reason)
    }
    const onExit = () => finish('exit')
    const onAbort = () => finish('abort')

    child.once('exit', onExit)
    try { signal?.addEventListener?.('abort', onAbort, { once: true }) } catch {}

    const stopPollWatch = watchProcessWindow(session.pid || child.pid, (kind) => {
      if (kind === 'window') finish('window')
      else if (kind === 'gone') finish('exit')
    })
    stopPoll = stopPollWatch

    timer = setInterval(() => {
      if (scanNewLines()) return finish('window')
      if (session.exited || child.exitCode !== null) return finish('exit')
      if (signal?.aborted) return finish('abort')
      try { onTick?.(Math.max(0, Math.round((Date.now() - startedAt) / 1000))) } catch {}
    }, 1000)
  })
}

function flushPendingLines(session) {
  for (const kind of ['out', 'err']) {
    if (!session.pending[kind]) continue
    const pretty = prettyGameLine(session.pending[kind], session)
    if (pretty) pushLine(session, pretty, kind)
    session.pending[kind] = ''
  }
}

function exitDetail(code, signal, crash) {
  const lines = [`退出码：${code}${signal ? `，信号：${signal}` : ''}`]
  if (crash?.description) lines.push(`崩溃原因：${crash.description}`)
  if (crash?.hints?.length) {
    for (const hint of crash.hints.slice(0, 6)) lines.push(`[诊断] ${hint.title}：${hint.suggestion}`)
  }
  if (crash?.file) lines.push(`崩溃报告：${crash.file}`)
  else lines.push('未找到崩溃报告，请打开日志查看最后的错误输出。')
  return lines.join('\n')
}

async function handleGameExit(session, code, signal) {
  if (session.exited) return
  session.exited = true
  session.exitCode = code
  session.endedAt = Date.now()
  const stoppedByUser = session.stopping === true
  session.status = stoppedByUser ? 'stopped' : code === 0 ? 'exited' : 'failed'
  session.proc = null
  pushLine(session, stoppedByUser
    ? '游戏已停止'
    : `游戏进程退出：code=${code}${signal ? ' signal=' + signal : ''}`, code === 0 || stoppedByUser ? 'ok' : 'err')
  const playSeconds = Math.max(0, Math.round((session.endedAt - session.startedAt) / 1000))
  try { markPlayed(session.instanceId, { playSeconds, countLaunch: false }) } catch {}
  flushPendingLines(session)

  const state = launchStates.get(session.instanceId)
  if (state) {
    state.proc = null
    state.pid = session.pid || 0
    state.logFile = session.logFile || ''
    state.cancellable = false
    state.updatedAt = Date.now()
  }

  if (stoppedByUser) {
    if (state) {
      updateState(state, { status: 'idle', detail: '游戏已停止', error: null, progress: null, indeterminate: true })
    }
    endSessionStream(session)
    return
  }
  if (code === 0) {
    if (state) {
      updateState(state, { status: 'exited', detail: '游戏已正常退出', error: null, progress: null, indeterminate: true })
    }
    endSessionStream(session)
    return
  }

  const inst = session.inst || findInstance(session.instanceId)
  // A user-requested stop is not a crash; do not surface a stale report.
  let crash = null
  try {
    crash = inst ? await inspectCrash(inst, session) : null
  } catch {}
  if (crash) {
    session.crash = crash
    pushLine(session, `检测到崩溃报告：${crash.file}`, 'err')
    for (const hint of crash.hints) pushLine(session, `[诊断] ${hint.title}：${hint.suggestion}`, 'err')
  }
  const launchError = createLaunchError(crash ? 'GAME_CRASHED' : 'GAME_EXITED', {
    exitCode: code,
    crash,
    detail: exitDetail(code, signal, crash),
    paths: inst ? errorPaths(inst, session.paths || undefined, { clientJar: state?.clientJar || '' }) : {}
  })
  session.error = launchError.message
  if (state) {
    updateState(state, {
      status: 'failed',
      detail: launchError.message,
      error: launchError,
      progress: null,
      indeterminate: true,
      pid: session.pid || 0,
      logFile: session.logFile || ''
    })
  }
  endSessionStream(session)
}

function failLaunch(state, session, error) {
  let err = error
  if (!(err instanceof Error)) err = new Error(String(error))
  if (!err.code) {
    const inst = session.inst || findInstance(session.instanceId)
    err = createLaunchError('LAUNCH_FAILED', {
      message: `启动失败：${err.message}`,
      detail: err.message,
      cause: err,
      paths: inst ? errorPaths(inst, session.paths || undefined) : {}
    })
  }
  session.status = 'failed'
  session.error = err.message
  session.endedAt = session.endedAt || Date.now()
  session.stopping = false
  pushLine(session, `[错误] ${err.message}`, 'err')
  if (err.detail) pushLine(session, `[原因] ${String(err.detail).split('\n')[0]}`, 'err')
  endSessionStream(session)
  updateState(state, {
    status: 'failed',
    detail: err.message,
    error: err,
    progress: null,
    indeterminate: true,
    cancellable: false,
    pid: session.pid || 0,
    logFile: session.logFile || ''
  })
}

function finalizeCancel(state, session) {
  const now = Date.now()
  if (session && !session.exited) {
    if (session.status !== 'stopped') pushLine(session, '已取消启动')
    session.status = 'stopped'
    session.endedAt = session.endedAt || now
    session.error = ''
    session.stopping = true
    endSessionStream(session)
  }
  updateState(state, {
    status: 'cancelled',
    detail: '已取消启动',
    error: null,
    progress: null,
    indeterminate: true,
    cancellable: false,
    pid: session?.pid || 0,
    logFile: session?.logFile || ''
  })
}

async function runLaunchPreparation(instanceId, state, session, inst, { accountId = '' } = {}) {
  const signal = state.controller.signal
  try {
    await ensureSessionLog(session)

    // 1. account
    setPhase(state, 'account', '正在校验账户…')
    const launchAccount = await resolveAccount(inst, { accountId })
    signal.throwIfAborted()
    pushLine(session, `[准备] 账户：${launchAccount.name || launchAccount.id || 'Player'}`)

    // 2. version
    const paths = ensureInstanceDirs(inst)
    session.paths = paths
    state.logFile = session.logFile
    setPhase(state, 'version', '正在解析版本与继承链…')
    const versionInfo = await resolveVersion(inst, paths)
    signal.throwIfAborted()
    pushLine(session, `[准备] 版本：${versionInfo.rootId || inst.versionId}（${versionInfo.chain.length} 层继承）`)

    // 3. java
    const javaMajor = requiredJavaMajor(versionInfo.version, inst.mc)
    setPhase(state, 'java', `正在检查并选择 Java（需要 Java ${javaMajor}）…`)
    const javaInfo = await resolveJavaRuntime(inst, versionInfo.version, paths)
    signal.throwIfAborted()
    session.javaPath = javaInfo.java.path
    session.javaMajor = javaInfo.java.major
    pushLine(session, `[准备] Java ${javaInfo.java.version || javaInfo.java.major} · ${javaInfo.java.path}`)

    setPhase(state, 'java', '正在生成启动参数…')
    const plan = await assemblePlan(inst, paths, versionInfo, javaInfo.java, javaInfo.javaMajor, launchAccount, signal)
    signal.throwIfAborted()
    session.command = plan.preview
    state.clientJar = plan.clientJar

    // 4. files
    setPhase(state, 'files', '正在检查客户端文件、库与资源…')
    if (paths.external) {
      let writable = true
      try {
        const stat = await fsp.stat(paths.gameDir)
        if (!stat.isDirectory()) writable = false
        if (writable) await fsp.access(paths.gameDir, fs.constants.W_OK)
      } catch { writable = false }
      if (!writable) throw classifyMissingFiles({
        external: true,
        gameDirWritable: false,
        paths: errorPaths(inst, paths, { clientJar: plan.clientJar })
      })
    }
    const { missing, missingCount } = await collectMissingFiles(plan, paths, { signal })
    if (missingCount > 0) {
      throw classifyMissingFiles({
        missing,
        missingCount,
        external: paths.external,
        gameDirWritable: true,
        paths: errorPaths(inst, paths, { clientJar: plan.clientJar })
      })
    }
    pushLine(session, `[准备] 客户端文件检查完成（${plan.classpath?.length || 0} 个库、${plan.nativeJars.length} 个 natives）`, 'ok')
    signal.throwIfAborted()

    // 5. natives
    setPhase(state, 'natives', '正在解压 natives…')
    let lastPct = -1
    await prepareNatives(inst, plan, paths, signal, (ratio, detail) => {
      const pct = Math.max(0, Math.min(100, Math.round((Number(ratio) || 0) * 100)))
      if (pct === lastPct && !detail) return
      lastPct = pct
      setProgress(state, pct, detail)
    })
    setProgress(state, 100, 'natives 准备完成')
    signal.throwIfAborted()

    // 6. spawn
    setPhase(state, 'spawn', '正在启动 Java 进程…')
    state.status = 'spawning'
    state.cancellable = true
    state.updatedAt = Date.now()
    const child = await spawnGame(session, plan, paths)
    signal.throwIfAborted()
    state.proc = child
    state.pid = child.pid || 0
    // 沿用旧行为：进程成功拉起即记一次启动（窗口阶段异常退出不再重复计数）。
    try { markPlayed(instanceId) } catch {}
    pushLine(session, `进程已启动（PID ${child.pid || 0}）`, 'ok')

    // 7. window —— 只有窗口真的出现才标记「运行中」
    setPhase(state, 'window', '正在等待游戏窗口出现…')
    state.status = 'spawning'
    state.cancellable = true
    state.updatedAt = Date.now()
    const windowWaitStart = Date.now()
    const windowResult = await waitForWindow(session, child, {
      signal,
      onTick: (sec) => {
        if (state.status !== 'spawning') return
        // 30 秒还没出现窗口时补一句提示：多数情况是窗口被别的程序挡住或开在副屏。
        const tip = sec >= 30 ? '，窗口可能被其他程序遮挡' : ''
        updateState(state, { detail: `正在等待游戏窗口出现…（已等待 ${sec}s${tip}）` })
      }
    })
    if (windowResult === 'exit' || session.exited || session.status === 'failed' || child.exitCode !== null) return
    if (windowResult === 'abort' || state.cancelled || state.status === 'failed') {
      if (state.cancelled && session.proc) await stopInstance(instanceId, { force: false })
      return
    }
    signal.throwIfAborted()
    session.status = 'running'
    session.windowReady = true
    const windowWaitSec = Math.max(1, Math.round((Date.now() - windowWaitStart) / 1000))
    updateState(state, {
      status: 'running',
      detail: '游戏运行中',
      progress: null,
      indeterminate: true,
      cancellable: false,
      pid: session.pid || 0,
      logFile: session.logFile || ''
    })
    pushLine(session, `游戏窗口已就绪（等待 ${windowWaitSec}s）`, 'ok')
  } catch (e) {
    if (state.cancelled || isAbortError(e) || signal.aborted) {
      finalizeCancel(state, session)
      return
    }
    failLaunch(state, session, e)
  }
}

/* ------------------------------------------------------------------ */
/* Public lifecycle API                                                */
/* ------------------------------------------------------------------ */

function makeSession(inst, paths) {
  return {
    instanceId: inst.id,
    instanceName: inst.name,
    inst,
    paths,
    status: 'starting',
    startedAt: Date.now(),
    endedAt: 0,
    proc: null,
    pid: 0,
    exitCode: null,
    javaPath: '',
    javaMajor: 0,
    command: '',
    logFile: path.join(paths.logsDir, `launch-${nowStamp()}.log`),
    stream: null,
    streamEnded: false,
    lines: [],
    seq: 0,
    pending: {},
    error: '',
    crash: null,
    stopping: false,
    exited: false,
    gotOutput: false,
    windowReady: false,
    launchState: null
  }
}

/**
 * Spawn the game. Returns a session snapshot immediately: preparation runs in
 * the background and is observable through launchStatus().launch / readLog().
 */
export async function startInstance(instanceId, { accountId = '' } = {}) {
  const active = launchStates.get(instanceId)
  if (active && ['preparing', 'spawning', 'running'].includes(active.status)) {
    const inst = active.session?.inst || findInstance(instanceId)
    throw createLaunchError('ALREADY_RUNNING', {
      paths: inst ? errorPaths(inst, active.session?.paths || instancePaths(inst)) : {}
    })
  }
  const existing = sessions.get(instanceId)
  if (existing && ['running', 'starting', 'stopping'].includes(existing.status)) {
    const inst = existing.inst || findInstance(instanceId)
    throw createLaunchError('ALREADY_RUNNING', {
      paths: inst ? errorPaths(inst, existing.paths || instancePaths(inst)) : {}
    })
  }
  const inst = findInstance(instanceId)
  if (!inst) {
    const error = new Error('实例不存在')
    error.code = 'NOT_FOUND'
    throw error
  }

  const paths = instancePaths(inst)
  const session = makeSession(inst, paths)
  sessions.set(instanceId, session)

  const state = {
    instanceId,
    instanceName: inst.name,
    status: 'preparing',
    phase: 'account',
    phaseLabel: phaseLabel('account'),
    step: 1,
    total: LAUNCH_PHASES.length,
    detail: '正在校验账户…',
    progress: null,
    indeterminate: true,
    startedAt: session.startedAt,
    updatedAt: Date.now(),
    cancellable: true,
    error: null,
    logFile: session.logFile,
    pid: 0,
    clientJar: '',
    proc: null,
    cancelled: false,
    controller: new AbortController(),
    session
  }
  session.launchState = state
  launchStates.set(instanceId, state)

  pushLine(session, `准备启动 ${inst.name} · Minecraft ${inst.mc || '未知'}`)
  pushLine(session, `[准备] ${phaseLabel('account')}`)
  void runLaunchPreparation(instanceId, state, session, inst, { accountId }).catch((e) => {
    // runLaunchPreparation 内部已兜底；这里只防止极端情况下出现未处理的 Promise 拒绝。
    try {
      if (!state.cancelled && state.status !== 'failed') failLaunch(state, session, e)
    } catch {}
  })
  return sessionSnapshot(session)
}

/**
 * 取消准备中的启动；若进程已经拉起，则等同于停止游戏。
 */
export async function cancelLaunch(instanceId) {
  const state = launchStates.get(instanceId)
  if (!state) return { ok: false, error: '没有正在进行的启动' }
  if (['idle', 'failed', 'exited', 'cancelled'].includes(state.status)) {
    return { ok: false, error: '启动已经结束' }
  }
  const session = state.session
  state.cancellable = false
  state.updatedAt = Date.now()

  if (state.status === 'running') {
    updateState(state, { status: 'cancelled', detail: '正在停止游戏…' })
    const result = await stopInstance(instanceId, { force: false })
    return result?.ok ? { ok: true } : { ok: false, error: result?.error || '停止游戏失败' }
  }

  state.cancelled = true
  updateState(state, { status: 'cancelled', detail: '正在取消启动…' })
  try { state.controller.abort() } catch {}

  if (state.proc || session?.proc) {
    state.detail = '正在停止游戏进程…'
    state.updatedAt = Date.now()
    await stopInstance(instanceId, { force: false })
    return { ok: true }
  }

  finalizeCancel(state, session)
  return { ok: true }
}

export async function stopInstance(instanceId, { force = false } = {}) {
  const session = sessions.get(instanceId)
  const state = launchStates.get(instanceId)
  if (!session || !session.proc) {
    if (state && (state.status === 'preparing' || state.status === 'spawning')) {
      return await cancelLaunch(instanceId)
    }
    return { ok: false, error: '游戏未在运行' }
  }
  session.stopping = true
  session.status = 'stopping'
  if (state) updateState(state, { cancellable: false, detail: force ? '正在强制结束游戏进程…' : '正在结束游戏进程…' })
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
  const launch = getLaunchState(instanceId)
  const inst = findInstance(instanceId)
  if (!inst) return { running: false, launch }
  if (!snapshot) {
    return {
      running: false,
      installed: isInstalled(inst),
      latestLog: await newestLogFile(instancePaths(inst).logsDir),
      crash: await inspectCrash(inst),
      launch
    }
  }
  return {
    running: snapshot.status === 'running' || snapshot.status === 'starting' || snapshot.status === 'stopping',
    session: snapshot,
    installed: isInstalled(inst),
    crash: snapshot.crash || (['failed', 'stopped', 'exited'].includes(snapshot.status) ? await inspectCrash(inst) : null),
    launch
  }
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
  return [...sessions.values()].some((session) => session.status === 'running' || session.status === 'starting') ||
    [...launchStates.values()].some((state) => state.status === 'preparing' || state.status === 'spawning' || state.status === 'running')
}
