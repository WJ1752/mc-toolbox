import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { DATA_DIR } from './paths.js'
import { extractZip } from './pack-converter.js'
import { inspectServer, resolveServerJava, splitArguments } from './server-inspection.js'
import { validateMemory } from './server-launch.js'

const preparations = new Map(), sessions = new Map(), locks = new Set(), portLocks = new Set()
let closing = false
const live = session => ['starting', 'running', 'stopping'].includes(session.status)
const exists = async file => (await fs.stat(file).catch(() => null))?.isFile()
export function getPreparation(id) {
  const item = preparations.get(id)
  if (!item) return null
  const { controller, completion, ...publicItem } = item
  return publicItem
}
export function cancelPreparation(id) {
  const item = preparations.get(id)
  if (item && ['queued', 'running'].includes(item.status)) { item.controller.abort(); item.detail = '正在中止并清理未完成的导入…'; return true }
  return false
}
export function prepareServer({ source, destination = '', name = '', uploaded = false, cleanup, corePath = '' }) {
  if (closing) throw new Error('工具箱正在关闭')
  const id = crypto.randomUUID()
  const job = { id, status: 'queued', progress: null, detail: '等待识别服务端', result: null, controller: new AbortController() }
  preparations.set(id, job)
  job.completion = (async () => {
    let created = ''
    try {
      job.status = 'running'
      let root = path.resolve(source)
      const stat = await fs.stat(root)
      if (stat.isFile() && !/\.jar$/i.test(root)) {
        if (!/\.(zip|mrpack)$/i.test(root)) throw new Error('支持 ZIP、.mrpack、服务端核心 JAR 或已解压的文件夹')
        const base = path.resolve(destination || path.join(DATA_DIR, 'servers'))
        await fs.mkdir(base, { recursive: true })
        const stem = (name || path.basename(root, path.extname(root))).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'server'
        created = await fs.mkdtemp(path.join(base, stem + '-'))
        await extractZip(root, created, (ratio, file) => { job.progress = ratio * 100; job.detail = '解压：' + file }, job.controller.signal)
        root = created
      } else if (uploaded && stat.isFile()) {
        const base = path.resolve(destination || path.join(DATA_DIR, 'servers'))
        await fs.mkdir(base, { recursive: true })
        created = await fs.mkdtemp(path.join(base, 'server-'))
        const target = path.join(created, path.basename(name || 'server.jar'))
        await fs.copyFile(root, target); root = target
      }
      job.controller.signal.throwIfAborted()
      job.progress = null; job.detail = '正在识别核心、版本和启动配置…'
      job.result = await inspectServer(root, corePath)
      const saved = await fs.readFile(path.join(job.result.root, '.mc-toolbox-server.json'), 'utf8').catch(() => '')
      try { job.result.settings = JSON.parse(saved) } catch {}
      job.controller.signal.throwIfAborted()
      job.status = 'done'; job.progress = 100; job.detail = '识别完成，请核对参数后启动'
    } catch (e) {
      if (created) await fs.rm(created, { recursive: true, force: true })
      job.status = job.controller.signal.aborted ? 'cancelled' : 'failed'
      job.detail = job.controller.signal.aborted ? '已中止导入，临时目录已清理' : e.message
      job.error = job.controller.signal.aborted ? null : e.message
    } finally { if (typeof cleanup === 'function') await cleanup() }
  })()
  return getPreparation(id)
}

function publicSession(session, after = 0) {
  const { child, completion, finish, decoders, logStream, ...item } = session
  return { ...item, logs: session.logs.filter(line => line.seq > after), elapsed: (session.endedAt || Date.now()) - session.startedAt }
}
export function listServers() { return [...sessions.values()].map(session => ({ id: session.id, root: session.root, status: session.status, port: session.port, startedAt: session.startedAt })) }
export function getServer(id, after = 0) { const session = sessions.get(id); return session ? publicSession(session, Number(after) || 0) : null }
function appendLog(session, text, channel = 'info') {
  const safe = String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  for (const fragment of safe.match(/.{1,8000}(?:\r?\n|$)/g) || []) {
    const line = fragment.replace(/[\r\n]+$/, '')
    session.logs.push({ seq: ++session.seq, text: line, channel })
    const missing = /MissingModsException:\s+Mod\s+([^\s(]+).*?requires\s+\[([^\]]+)\]/i.exec(line)
    if (missing) {
      session.missingDependencies ||= []
      const value = `${missing[1]} → ${missing[2]}`
      if (!session.missingDependencies.includes(value)) session.missingDependencies.push(value)
    }
    if (session.logs.length > 1500) session.logs.shift()
    if (/Choose A default world type|Type.*defaultworldgenerator-port/i.test(line)) session.inputHint = '整合包正在等待选择世界类型。请查看日志中的编号，在下方控制台输入 defaultworldgenerator-port 编号（例如 1）。'
    if (session.status === 'starting' && /Done \([\d.,]+s\)!|For help, type ["']?help/i.test(line)) { session.status = 'running'; session.inputHint = '' }
  }
}

export function buildJvmArgs({ memory, minMemory, optimization = 'original', jvmArgs = '' }, original = []) {
  const mem = validateMemory(memory, minMemory)
  const custom = splitArguments(jvmArgs)
  if (custom.some(arg => /^-Xm[sx]/.test(arg))) throw new Error('请在内存输入框设置 Xms / Xmx，避免重复参数')
  if (custom.some(arg => ['-jar', '-cp', '-classpath', '--class-path'].includes(arg) || arg.startsWith('@'))) throw new Error('请在“启动入口”选择核心，JVM 参数中不能替换入口或引用额外参数文件')
  if (!['original', 'g1', 'custom'].includes(optimization)) throw new Error('未知启动优化方案')
  let args = original.filter(arg => !/^-Xm[sx]/.test(arg))
  if (optimization === 'g1') {
    args = args.filter(arg => !/^-XX:[+-]Use\w*GC$|^-XX:MaxGCPauseMillis=|^-XX:[+-]ParallelRefProcEnabled$/.test(arg))
    args.push('-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200')
  }
  return [...args, ...custom, '-Xms' + mem.minMemory, '-Xmx' + mem.memory]
}

async function ensurePortFree(port, host) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', e => reject(new Error(e.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请改用其他端口或先停止已有服务端` : e.message)))
    probe.listen({ port, host: host || '0.0.0.0', exclusive: true }, () => probe.close(resolve))
  })
}

async function updateProperties(root, values) {
  const file = path.join(root, 'server.properties')
  let text = await fs.readFile(file, 'utf8').catch(() => '')
  if (text && !(await exists(file + '.mc-toolbox.bak'))) await fs.copyFile(file, file + '.mc-toolbox.bak')
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue
    const regex = new RegExp('^\\s*' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=.*$', 'gm')
    if (regex.test(text)) text = text.replace(regex, () => key + '=' + value)
    else text += (text.endsWith('\n') || !text ? '' : '\n') + key + '=' + value + '\n'
  }
  await fs.writeFile(file, text)
}

export async function startServer(options) {
  if (closing) throw new Error('工具箱正在关闭')
  let reservedPort = null
  const root = await fs.realpath(String(options.root || ''))
  const lockKey = process.platform === 'win32' ? root.toLowerCase() : root
  if (locks.has(lockKey) || [...sessions.values()].some(session => live(session) && session.root.toLowerCase() === root.toLowerCase())) throw new Error('这个服务端已经在启动或运行')
  locks.add(lockKey)
  try {
    const inspection = await inspectServer(root, options.corePath || '')
    const plan = inspection.plans.find(item => item.id === options.planId)
    if (!plan) throw new Error('请选择可用的核心或启动入口')
    const runtime = { ...plan.runtime, mc: options.mc || plan.runtime?.mc, loader: plan.runtime?.loader || 'vanilla' }
    const java = await resolveServerJava(root, runtime, options.javaPath || plan.javaPath)
    const port = Number(options.port ?? inspection.properties['server-port'] ?? 25565)
    const host = String(options.host ?? inspection.properties['server-ip'] ?? '').trim()
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口范围为 1–65535')
    if (host && !net.isIP(host)) throw new Error('监听地址请输入 IP 地址，留空监听所有网卡')
    const maxPlayers = Number(options.maxPlayers ?? inspection.properties['max-players'] ?? 20)
    if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 10000) throw new Error('最大玩家数范围为 1–10000')
    const jvm = buildJvmArgs(options, plan.jvm)
    const extra = splitArguments(options.serverArgs || '')
    if (extra.some(arg => /^--?(?:port|host)(?:=|$)/i.test(arg))) throw new Error('请通过端口和监听地址输入框设置地址，避免参数冲突')
    const launch = [...plan.args]
    for (const arg of launch.filter(arg => arg.startsWith('@'))) {
      if (!(await exists(path.resolve(root, arg.slice(1))))) throw new Error('缺少启动参数文件：' + arg)
    }
    const jarIndex = launch.indexOf('-jar')
    if (jarIndex >= 0 && !(await exists(path.resolve(root, launch[jarIndex + 1] || '')))) throw new Error('启动核心不存在')
    // Saved launch plans may include this file. Parse it once so old heap settings cannot override the UI.
    const userIndex = launch.indexOf('@user_jvm_args.txt')
    if (userIndex >= 0) launch.splice(userIndex, 1)
    if (portLocks.has(port) || [...sessions.values()].some(session => live(session) && session.port === port)) throw new Error(`端口 ${port} 已用于工具箱中的另一个服务端`)
    portLocks.add(port); reservedPort = port
    await ensurePortFree(port, host)
    if (!inspection.eulaAccepted && options.acceptEula !== true) throw new Error('请先阅读并勾选同意 Minecraft EULA，或使用已自行接受协议的服务端目录')
    await updateProperties(root, { 'server-port': port, 'server-ip': host, 'max-players': maxPlayers, ...(typeof options.onlineMode === 'boolean' ? { 'online-mode': options.onlineMode } : {}) })
    if (!inspection.eulaAccepted) await fs.writeFile(path.join(root, 'eula.txt'), 'eula=true\n')
    const settings = { planId: plan.id, corePath: options.corePath || '', mc: runtime.mc, javaPath: options.javaPath || '', memory: options.memory, minMemory: options.minMemory, optimization: options.optimization || 'original', jvmArgs: options.jvmArgs || '', serverArgs: options.serverArgs || '', port, host, maxPlayers, onlineMode: options.onlineMode }
    await fs.writeFile(path.join(root, '.mc-toolbox-server.json'), JSON.stringify(settings, null, 2))
    const id = crypto.randomUUID()
    const session = { id, root, port, status: 'starting', startedAt: Date.now(), endedAt: null, java, settings, logs: [], seq: 0, exitCode: null, child: null, stopRequested: false, missingDependencies: [] }
    session.completion = new Promise(resolve => { session.finish = resolve })
    sessions.set(id, session)
    appendLog(session, `Java ${java.major}：${java.path}\n初始 ${options.minMemory} / 最大 ${options.memory}；端口 ${port}\n正在启动，百分比不可预知，请查看实际日志。`)
    if (closing) { sessions.delete(id); session.finish(); throw new Error('工具箱正在关闭') }
    const child = spawn(java.path, [...jvm, ...launch, ...extra], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    session.child = child
    child.stdin.on('error', () => {})
    const bindOutput = (stream, channel) => {
      const decoder = new StringDecoder('utf8'); let pending = ''
      stream.on('data', bytes => {
        pending += decoder.write(bytes)
        const lines = pending.split(/\r?\n/); pending = lines.pop()
        if (lines.length) appendLog(session, lines.join('\n'), channel)
        if (pending.length > 8000) { appendLog(session, pending, channel); pending = '' }
      })
      stream.on('end', () => { pending += decoder.end(); if (pending) appendLog(session, pending, channel) })
    }
    bindOutput(child.stdout, 'stdout'); bindOutput(child.stderr, 'stderr')
    child.on('error', error => { appendLog(session, error.message, 'error'); session.error = error.message })
    child.on('close', code => {
      session.exitCode = code; session.endedAt = Date.now()
      if (session.missingDependencies.length && !session.stopRequested) {
        session.status = 'failed'
        session.error = `启动失败：模组依赖缺失：${session.missingDependencies.join('；')}`
      } else session.status = session.stopRequested || code === 0 ? 'stopped' : 'failed'
      appendLog(session, session.stopRequested ? '服务端进程已停止。' : `服务端已退出，退出码 ${code}。`)
      session.finish()
    })
    return publicSession(session)
  } finally { locks.delete(lockKey); if (reservedPort !== null) portLocks.delete(reservedPort) }
}

export function sendServerCommand(id, command) {
  const session = sessions.get(id)
  if (!session || !live(session) || !session.child?.stdin.writable) throw new Error('服务端未运行')
  if (typeof command !== 'string' || !command.trim() || command.length > 4000 || /[\r\n\0]/.test(command)) throw new Error('请输入一行有效控制台命令')
  if (command.trim() === 'stop') { session.stopRequested = true; session.status = 'stopping' }
  session.child.stdin.write(command.trim() + '\n')
  if (/^\/?defaultworldgenerator-port\s+/i.test(command.trim())) session.inputHint = ''
  appendLog(session, '> ' + command.trim(), 'command')
  return { ok: true }
}
export function stopServer(id, force = false) {
  const session = sessions.get(id)
  if (!session || !live(session)) return { ok: false }
  session.stopRequested = true; session.status = 'stopping'
  if (force) { appendLog(session, '强制停止进程：未保存的世界数据可能丢失。'); session.child.kill('SIGKILL') }
  else { session.child.stdin.write('stop\n'); appendLog(session, '已发送 stop，等待服务端保存世界并退出…') }
  return { ok: true }
}

export async function shutdownServers() {
  closing = true
  for (const job of preparations.values()) if (['queued', 'running'].includes(job.status)) job.controller.abort()
  const active = [...sessions.values()].filter(live)
  for (const session of active) stopServer(session.id)
  await Promise.all(active.map(async session => {
    let timer
    await Promise.race([session.completion, new Promise(resolve => { timer = setTimeout(resolve, 45000) })])
    clearTimeout(timer)
    if (live(session)) { stopServer(session.id, true); await session.completion }
  }))
  await Promise.all([...preparations.values()].map(job => job.completion))
}
