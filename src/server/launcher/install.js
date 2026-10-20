// 安装任务：原版 / Fabric / Quilt / Forge / NeoForge 客户端与整合包。
//
// 所有任务都可取消；进度来自真实字节数或安装器输出，期间无法确定的阶段
// 使用不确定进度条，不伪造百分比。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { getProxy } from '../http.js'
import { readJarEntries } from '../zip.js'
import { store } from '../store.js'
import {
  getSettings,
  launcherRoot,
  createInstance,
  findInstance,
  updateInstance,
  instancePaths,
  ensureInstanceDirs,
  publicInstance
} from './state.js'
import {
  getVersionMeta,
  saveVersionJson,
  loadVersionChain,
  readJsonFile,
  assetIndexInfo,
  versionJarName,
  getModLoaderProfile,
  customVersionId,
  forgeInstaller,
  readInstallerVersion,
  listLoaderVersions,
  candidateUrls,
  assetObjectUrls,
  BMCL_MAVEN
} from './meta.js'
import { collectLibraries, normalizeOs, requiredJavaMajor } from './launch-plan.js'
import { downloadFromMirrors, runPool } from './download.js'
import { pickJava } from './java.js'
import { readZipIndex, extractZip } from '../pack-converter.js'
import { hydrateCurseForgeFiles } from '../curseforge-pack.js'

const jobs = new Map()
const FINISHED = new Set(['done', 'failed', 'cancelled'])

function newId() {
  return crypto.randomUUID()
}

function nowTime() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0))
}

class InstallJob {
  constructor(opts) {
    this.id = newId()
    this.type = opts.type || 'install'
    this.status = 'queued'
    this.phase = '准备'
    this.detail = '等待开始…'
    this.progress = 0
    this.indeterminate = false
    this.received = 0
    this.total = 0
    this.startedAt = Date.now()
    this.finishedAt = 0
    this.error = ''
    this.instanceId = opts.instanceId || ''
    this.name = opts.name || ''
    this.mc = opts.mc || ''
    this.loader = opts.loader || 'vanilla'
    this.loaderVersion = opts.loaderVersion || ''
    this.logs = []
    this.logSeq = 0
    this.controller = new AbortController()
    this.cancelRequested = false
    this.child = null
  }

  get signal() { return this.controller.signal }

  log(text, kind = '') {
    const line = { seq: ++this.logSeq, t: nowTime(), text: String(text ?? ''), kind }
    this.logs.push(line)
    if (this.logs.length > 1500) this.logs.splice(0, this.logs.length - 1500)
    return line
  }

  phaseLabel(phase, detail) {
    this.phase = phase
    if (detail) this.detail = detail
  }

  set(progress, detail, { indeterminate = false } = {}) {
    if (this.controller.signal.aborted) return
    if (indeterminate) {
      this.indeterminate = true
      this.progress = null
    } else if (progress !== null && progress !== undefined) {
      this.indeterminate = false
      this.progress = clamp(progress)
    }
    if (detail !== undefined) this.detail = detail
  }

  bytes(received, total) {
    this.received = Math.max(0, Math.round(Number(received) || 0))
    if (total !== undefined) this.total = Math.max(0, Math.round(Number(total) || 0))
  }

  public({ includeLogs = true } = {}) {
    return {
      id: this.id,
      type: this.type,
      status: this.status,
      phase: this.phase,
      detail: this.detail,
      progress: this.progress,
      indeterminate: this.indeterminate,
      received: this.received,
      total: this.total,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      error: this.error,
      instanceId: this.instanceId,
      name: this.name,
      mc: this.mc,
      loader: this.loader,
      loaderVersion: this.loaderVersion,
      logSeq: this.logSeq,
      logs: includeLogs ? this.logs.slice(-200) : undefined
    }
  }
}

function finishJob(job, status, error = '') {
  if (job.finishedAt) return
  job.finishedAt = Date.now()
  job.status = status
  job.error = error || ''
  job.controller = new AbortController()
  job.child = null
}

function killChild(child) {
  if (!child) return
  try { child.kill() } catch {}
  if (process.platform === 'win32' && child.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
  }
}

function runJob(job, task) {
  jobs.set(job.id, job)
  const old = [...jobs.values()].filter((item) => FINISHED.has(item.status)).sort((a, b) => a.finishedAt - b.finishedAt)
  while (jobs.size > 50 && old.length) jobs.delete(old.shift().id)
  setImmediate(async () => {
    if (job.cancelRequested) {
      finishJob(job, 'cancelled')
      return
    }
    job.status = 'running'
    job.log('任务开始')
    try {
      await task(job)
      if (job.controller.signal.aborted || job.cancelRequested) {
        finishJob(job, 'cancelled')
        job.log('任务已取消', 'warn')
        return
      }
      job.progress = 100
      job.indeterminate = false
      job.detail = job.type === 'pack' ? '整合包安装完成' : job.type === 'update' ? '模组更新完成' : '安装完成'
      job.log(job.detail, 'ok')
      finishJob(job, 'done')
    } catch (e) {
      if (job.controller.signal.aborted || job.cancelRequested) {
        finishJob(job, 'cancelled')
        job.log('任务已取消', 'warn')
      } else {
        finishJob(job, 'failed', e.message)
        job.log('安装失败：' + e.message, 'err')
      }
    } finally {
      try { await job.cleanup?.() } catch {}
      if (job.instanceId) {
        try { updateInstance(job.instanceId, { installing: false }) } catch {}
      }
    }
  })
  return job
}

export function getJob(id) {
  const job = jobs.get(id)
  return job ? job.public() : null
}

export function getJobDelta(id, after = 0) {
  const job = jobs.get(id)
  if (!job) return null
  return { ...job.public({ includeLogs: false }), logs: job.logs.filter((line) => line.seq > Number(after || 0)) }
}

export function listJobs() {
  return [...jobs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((job) => job.public({ includeLogs: false }))
}

export function activeJobs() {
  return [...jobs.values()].filter((job) => !FINISHED.has(job.status))
}

export function cancelJob(id) {
  const job = jobs.get(id)
  if (!job || FINISHED.has(job.status) || job.status === 'cancelling') return false
  job.cancelRequested = true
  job.status = 'cancelling'
  job.detail = '正在取消并清理…'
  job.log('收到取消请求，正在停止下载 / 安装器…', 'warn')
  try { job.controller.abort(new Error('已取消')) } catch {}
  killChild(job.child)
  return true
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function osInfo() {
  return normalizeOs({ platform: process.platform, arch: process.arch, release: os.release() })
}

function progressIn(job, from, to, ratio, detail) {
  if (detail !== undefined) job.detail = detail
  const value = clamp(from + (to - from) * Math.max(0, Math.min(1, Number(ratio) || 0)))
  job.progress = value
  job.indeterminate = false
}

function artifactUrls(artifact, source) {
  if (artifact?.url) return candidateUrls(artifact.url, { source })
  if (!artifact?.path) return []
  const rel = String(artifact.path).replace(/\\/g, '/')
  return [
    ...candidateUrls(`https://libraries.minecraft.net/${rel}`, { source }),
    `https://maven.minecraftforge.net/${rel}`,
    `https://maven.fabricmc.net/${rel}`
  ]
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')) } catch { return fallback }
}

async function writeLauncherProfiles(root, versionId) {
  const file = path.join(root, 'launcher_profiles.json')
  const data = await readJson(file, null) || { profiles: {}, settings: {}, version: 3 }
  data.profiles = data.profiles || {}
  data.profiles['mc-toolbox'] = {
    name: 'MC Toolbox',
    type: 'custom',
    lastVersionId: versionId,
    created: new Date().toISOString(),
    lastUsed: new Date().toISOString()
  }
  data.selectedProfile = data.selectedProfile || 'mc-toolbox'
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
}

function proxyJvmArgs() {
  const proxy = getProxy()
  if (!proxy) return []
  const args = []
  if (proxy.protocol === 'socks5') {
    args.push(`-DsocksProxyHost=${proxy.host}`, `-DsocksProxyPort=${proxy.port}`)
  } else {
    args.push(
      `-Dhttp.proxyHost=${proxy.host}`, `-Dhttp.proxyPort=${proxy.port}`,
      `-Dhttps.proxyHost=${proxy.host}`, `-Dhttps.proxyPort=${proxy.port}`
    )
    if (proxy.auth) {
      const [user, password] = String(proxy.auth).split(':')
      args.push(`-Dhttp.proxyUser=${user}`, `-Dhttp.proxyPassword=${password}`, `-Dhttps.proxyUser=${user}`, `-Dhttps.proxyPassword=${password}`)
    }
  }
  return args
}

/** Convert a Maven coordinate (`g:a:v[:classifier][@ext]`) to a repository path. */
function mavenRelativePath(coordinate, defaultExt = 'jar') {
  let raw = String(coordinate || '').trim()
  if (!raw) return ''
  let ext = defaultExt
  const bracket = /^\[(.+)\](?:@(\w+))?$/.exec(raw)
  if (bracket) {
    raw = bracket[1]
    if (bracket[2]) ext = bracket[2]
  }
  const at = raw.lastIndexOf('@')
  if (at > 0) {
    ext = raw.slice(at + 1) || ext
    raw = raw.slice(0, at)
  }
  if (raw.includes('[') || raw.includes(']')) return ''
  const [group, artifact, version, classifier] = raw.split(':')
  if (!group || !artifact || !version) return ''
  const suffix = classifier ? `-${classifier}` : ''
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${suffix}.${ext}`
}

function looksLikeZip(file) {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(4)
      const read = fs.readSync(fd, buf, 0, 4, 0)
      return read === 4 && buf[0] === 0x50 && buf[1] === 0x4b
    } finally { fs.closeSync(fd) }
  } catch { return false }
}

/**
 * Forge/NeoForge installers always fetch their own libraries from
 * maven.minecraftforge.net / maven.neoforged.net. Those hosts are frequently
 * unreachable from mainland China, so when a mirror source is active we
 * pre-fetch every install-profile artifact from BMCLAPI. The installer then
 * verifies and reuses them instead of timing out.
 *
 * Modern Forge also downloads a separate processor classpath (jopt-simple,
 * srgutils, ASM, installertools) and the mappings/binpatches referenced from
 * `data`. Those are not part of `libraries`, so they must be pre-fetched too or
 * the installer will stall on the same blocked Maven host.
 */
async function prefillInstallerLibraries(job, installerFile, root, { source }) {
  if (source === 'official') return
  let profiles = []
  try {
    const entries = await readJarEntries(installerFile, ['install_profile.json', 'version.json'], { maxBytes: 16 * 1024 * 1024 })
    for (const name of ['install_profile.json', 'version.json']) {
      if (!entries[name]) continue
      try { profiles.push(JSON.parse(entries[name].toString('utf8'))) } catch {}
    }
  } catch {
    return
  }
  const unique = new Map()
  const addArtifact = (relative, artifact = {}) => {
    if (!relative || unique.has(relative)) return
    unique.set(relative, {
      path: relative,
      url: artifact.url || '',
      sha1: artifact.sha1 || '',
      size: Number(artifact.size) || 0
    })
  }
  const coordinates = new Set()
  for (const profile of profiles) {
    for (const lib of profile?.libraries || []) {
      const artifact = lib?.downloads?.artifact
      if (artifact?.path) addArtifact(String(artifact.path), artifact)
    }
    for (const processor of profile?.processors || []) {
      for (const coord of [processor?.jar, ...(processor?.classpath || [])]) {
        if (coord) coordinates.add(String(coord))
      }
    }
    for (const value of Object.values(profile?.data || {})) {
      const spec = value && typeof value === 'object' ? value.client : value
      if (typeof spec === 'string' && /^\[.+/.test(spec.trim())) coordinates.add(spec.trim())
    }
  }
  for (const coord of coordinates) {
    const relative = mavenRelativePath(coord)
    if (relative) addArtifact(relative)
  }
  const missing = [...unique.values()].filter((artifact) => {
    const dest = path.join(root, 'libraries', ...String(artifact.path).split('/'))
    try {
      if (!fs.existsSync(dest)) return true
      const stat = fs.statSync(dest)
      if (!stat.size) return true
      if (artifact.size && stat.size !== Number(artifact.size)) return true
      if (dest.toLowerCase().endsWith('.jar') && !looksLikeZip(dest)) return true
      return false
    } catch { return true }
  })
  if (!missing.length) {
    job.log('安装器依赖已就绪，无需重复下载')
    return
  }
  job.phaseLabel('准备安装器依赖', `通过镜像预取 ${missing.length} 个安装器库`)
  let done = 0
  let failed = 0
  await runPool(missing, async (artifact) => {
    const dest = path.join(root, 'libraries', ...String(artifact.path).split('/'))
    const urls = [
      `${BMCL_MAVEN}/${artifact.path}`,
      artifact.url,
      `https://maven.minecraftforge.net/${artifact.path}`,
      `https://maven.neoforged.net/releases/${artifact.path}`
    ].filter(Boolean)
    try {
      await downloadFromMirrors(urls, dest, {
        sha1: artifact.sha1 || '',
        size: Number(artifact.size) || 0,
        signal: job.signal,
        verify: true,
        retries: Number(getSettings().retries) || 0
      })
      if (dest.toLowerCase().endsWith('.jar') && !looksLikeZip(dest)) {
        await fsp.rm(dest, { force: true }).catch(() => {})
        throw new Error('下载内容不是有效的 JAR')
      }
    } catch (e) {
      if (job.signal.aborted) throw e
      failed++
      await fsp.rm(dest, { force: true }).catch(() => {})
      job.log(`预取失败（交给安装器重试）：${artifact.path} · ${e.message}`, 'warn')
    }
    done++
    if (done === missing.length || done % 10 === 0) job.log(`安装器依赖 ${done}/${missing.length}`)
  }, Math.min(6, Math.max(1, Number(getSettings().concurrency) || 8)), job.signal)
  job.log(`安装器依赖准备完成（${missing.length - failed} 个成功${failed ? `，${failed} 个交给安装器重试` : ''}）`, 'ok')
}

async function runInstaller(job, javaPath, installerFile, root) {  const args = [...proxyJvmArgs(), '-jar', installerFile, '--installClient', root]
  job.phaseLabel('安装加载器', '正在运行官方安装器（下载并处理 libraries）…')
  job.set(null, '安装器正在工作…（此阶段耗时取决于网络）', { indeterminate: true })
  job.log(`执行安装器：${path.basename(installerFile)}`)
  await new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(javaPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      reject(new Error('无法启动安装器：' + e.message))
      return
    }
    job.child = child
    let output = ''
    let pending = ''
    const onData = (chunk, kind) => {
      pending += chunk.toString('utf8')
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        output += line + '\n'
        job.log(line, kind)
        if (output.length > 4 * 1024 * 1024) output = output.slice(-2 * 1024 * 1024)
        if (/downloading|installing|patching|extracting|processing/i.test(line)) job.detail = line.slice(0, 180)
      }
    }
    child.stdout.on('data', (chunk) => onData(chunk, 'out'))
    child.stderr.on('data', (chunk) => onData(chunk, 'err'))
    const timer = setTimeout(() => {
      job.log('安装器超过 30 分钟未完成，已终止', 'err')
      killChild(child)
      reject(new Error('安装器超时'))
    }, 30 * 60 * 1000)
    const onAbort = () => {
      clearTimeout(timer)
      killChild(child)
      reject(new Error('已取消'))
    }
    job.signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (e) => {
      clearTimeout(timer)
      job.signal.removeEventListener('abort', onAbort)
      reject(new Error('安装器进程错误：' + e.message))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      job.signal.removeEventListener('abort', onAbort)
      job.child = null
      if (pending) job.log(pending)
      if (job.signal.aborted) reject(new Error('已取消'))
      else if (code !== 0) reject(new Error(`安装器退出码 ${code}；请查看日志中的报错行`))
      else resolve()
    })
  })
}

/* ------------------------------------------------------------------ */
/* Downloads                                                           */
/* ------------------------------------------------------------------ */

async function downloadOne(job, artifact, dest, { source, from, to, baseDone, baseTotal, label }) {
  const urls = artifactUrls(artifact, source)
  if (!urls.length) throw new Error('缺少下载地址：' + artifact.path)
  let last = 0
  await downloadFromMirrors(urls, dest, {
    sha1: artifact.sha1 || '',
    size: artifact.size || 0,
    signal: job.signal,
    verify: getSettings().verify !== false,
    retries: Number(getSettings().retries) || 0,
    onProgress: ({ received, total, cached }) => {
      const delta = Math.max(0, Number(received) - last)
      last = Number(received) || 0
      baseDone.received += delta
      if (baseTotal.total > 0) {
        progressIn(job, from, to, baseDone.received / baseTotal.total, `${label} · ${Math.round((baseDone.received / 1048576) * 10) / 10} / ${Math.round((baseTotal.total / 1048576) * 10) / 10} MB`)
      }
      job.bytes(baseDone.received, baseTotal.total)
      if (cached && delta > 0) { /* cached files still count as complete */ }
    }
  })
}

async function downloadLibraries(job, effective, paths, { source, from, to }) {
  const collected = collectLibraries(effective, { os: osInfo() })
  const all = [...collected.classpath, ...collected.natives]
  const unique = new Map()
  for (const artifact of all) if (artifact?.path && !unique.has(artifact.path)) unique.set(artifact.path, artifact)
  const list = [...unique.values()]
  if (!list.length) return
  const total = list.reduce((sum, item) => sum + (Number(item.size) || 0), 0)
  const counter = { received: 0 }
  let done = 0
  job.phaseLabel('下载依赖库', `共有 ${list.length} 个库文件`)
  await runPool(list, async (artifact) => {
    const dest = path.join(paths.librariesDir, ...String(artifact.path).split('/'))
    await downloadOne(job, artifact, dest, { source, from, to, baseDone: counter, baseTotal: { total }, label: '依赖库' })
    done++
    if (done % 40 === 0 || done === list.length) job.log(`依赖库 ${done}/${list.length}`)
    if (!total) progressIn(job, from, to, done / list.length, `依赖库 ${done}/${list.length}`)
  }, getSettings().concurrency, job.signal)
  job.log(`依赖库准备完成（${list.length} 个）`, 'ok')
}

async function linkOrCopy(source, target, signal) {
  signal?.throwIfAborted()
  await fsp.mkdir(path.dirname(target), { recursive: true })
  try {
    await fsp.link(source, target)
  } catch {
    await fsp.copyFile(source, target)
  }
}

async function downloadAssets(job, root, inst, effective, { source, from, to }) {
  const info = assetIndexInfo(effective)
  if (!info) {
    job.log('该版本没有资源索引，跳过 assets')
    return
  }
  if (getSettings().downloadAssets === false) {
    job.log('已按设置跳过资源文件下载；游戏可能缺少声音/语言资源', 'warn')
    return
  }
  const indexFile = path.join(root, 'assets', 'indexes', `${info.id}.json`)
  const local = await readJson(indexFile, null)
  if (!local) {
    job.phaseLabel('下载资源索引', info.id)
    const urls = candidateUrls(info.url, { source })
    if (!urls.length) throw new Error('资源索引缺少下载地址')
    await downloadFromMirrors(urls, indexFile, {
      sha1: info.sha1 || '',
      size: info.size || 0,
      signal: job.signal,
      verify: getSettings().verify !== false,
      retries: getSettings().retries || 0
    })
    job.log('资源索引已下载：' + info.id)
  }
  const index = await readJson(indexFile, null)
  if (!index?.objects) throw new Error('资源索引格式无效')
  const entries = Object.entries(index.objects)
  const total = entries.reduce((sum, [, value]) => sum + (Number(value.size) || 0), 0)
  const counter = { received: 0 }
  let done = 0
  let lastLog = 0
  job.phaseLabel('下载资源文件', `${entries.length} 个资源，约 ${Math.round(total / 1048576)} MB`)
  const concurrency = Math.max(4, Math.min(24, Number(getSettings().concurrency) || 8))
  await runPool(entries, async ([name, value]) => {
    const hash = String(value.hash || '')
    const dest = path.join(root, 'assets', 'objects', hash.slice(0, 2), hash)
    let last = 0
    await downloadFromMirrors(assetObjectUrls(hash, { source }), dest, {
      sha1: hash,
      size: Number(value.size) || 0,
      signal: job.signal,
      verify: getSettings().verify !== false,
      retries: getSettings().retries || 0,
      onProgress: ({ received }) => {
        const delta = Math.max(0, Number(received) - last)
        last = Number(received) || 0
        counter.received += delta
        if (total) progressIn(job, from, to, counter.received / total, `资源文件 ${done + 1}/${entries.length} · ${Math.round(counter.received / 1048576)} / ${Math.round(total / 1048576)} MB`)
        job.bytes(counter.received, total)
      }
    }).catch((e) => { throw new Error(`资源 ${name}：${e.message}`) })
    done++
    const now = Date.now()
    if (now - lastLog > 1500 || done === entries.length) {
      lastLog = now
      job.log(`资源文件 ${done}/${entries.length}`)
    }
  }, concurrency, job.signal)
  job.log(`资源文件准备完成（${entries.length} 个）`, 'ok')

  // Legacy asset layouts.
  if (index.virtual || index.map_to_resources) {
    const virtualRoot = index.map_to_resources
      ? path.join(instancePaths(inst).gameDir, 'resources')
      : path.join(root, 'assets', 'virtual', info.id)
    job.log(`正在整理旧版资源目录：${virtualRoot}`)
    let built = 0
    for (const [name, value] of entries) {
      job.signal.throwIfAborted()
      const sourceFile = path.join(root, 'assets', 'objects', String(value.hash).slice(0, 2), String(value.hash))
      const target = path.join(virtualRoot, ...name.split('/'))
      await linkOrCopy(sourceFile, target, job.signal)
      built++
    }
    job.log(`旧版资源目录完成（${built} 个）`, 'ok')
  }
}

async function downloadLogging(job, root, version, { source }) {
  const file = version?.logging?.client?.file
  if (!file?.url || !file?.id) return ''
  const dest = path.join(root, 'assets', 'log_configs', file.id)
  if (fs.existsSync(dest) && (!file.sha1 || !getSettings().verify)) return dest
  job.log('下载日志配置：' + file.id)
  await downloadFromMirrors(candidateUrls(file.url, { source }), dest, {
    sha1: file.sha1 || '',
    size: Number(file.size) || 0,
    signal: job.signal,
    verify: getSettings().verify !== false,
    retries: getSettings().retries || 0
  })
  return dest
}

async function installVersionFiles(job, instId, root, versionId, { source, from, to }) {
  const inst = findInstance(instId)
  if (!inst) throw new Error('实例不存在')
  job.phaseLabel('校验版本', versionId)
  const chain = await loadVersionChain(root, versionId)
  const effective = chain.version
  const jarVersion = versionJarName(effective) || chain.rootId
  updateInstance(instId, { versionId, jarVersion })
  const paths = ensureInstanceDirs(findInstance(instId))

  const clientJar = path.join(root, 'versions', jarVersion, `${jarVersion}.jar`)
  if (!fs.existsSync(clientJar)) {
    // Very old versions or imported instances may need the client jar.
    const meta = await getVersionMeta(jarVersion, { source, signal: job.signal })
    const info = meta?.downloads?.client
    if (!info?.url) throw new Error('缺少客户端 JAR，且该版本没有下载地址')
    job.log('补下载客户端 JAR：' + jarVersion)
    await downloadFromMirrors(candidateUrls(info.url, { source }), clientJar, {
      sha1: info.sha1, size: info.size, signal: job.signal,
      verify: getSettings().verify !== false, retries: getSettings().retries || 0
    })
  }

  const libFrom = from + (to - from) * 0.02
  const libTo = from + (to - from) * (getSettings().downloadAssets === false ? 0.92 : 0.38)
  await downloadLibraries(job, effective, paths, { source, from: libFrom, to: libTo })
  await downloadLogging(job, root, effective, { source })

  if (getSettings().downloadAssets !== false) {
    await downloadAssets(job, root, findInstance(instId), effective, {
      source,
      from: from + (to - from) * 0.38,
      to: from + (to - from) * 0.98
    })
  } else {
    await downloadAssets(job, root, findInstance(instId), effective, {
      source,
      from: from + (to - from) * 0.38,
      to: from + (to - from) * 0.98
    })
  }

  const stampDir = path.join(root, 'versions', versionId)
  await fsp.mkdir(stampDir, { recursive: true })
  await fsp.writeFile(path.join(stampDir, '.mc-toolbox-installed'), JSON.stringify({
    versionId,
    mc: inst.mc,
    loader: inst.loader,
    loaderVersion: inst.loaderVersion,
    jarVersion,
    installedAt: Date.now()
  }, null, 2), 'utf8')
  updateInstance(instId, { installedAt: Date.now(), versionId, jarVersion, installing: false })
  progressIn(job, from + (to - from) * 0.98, to, 1, '文件校验完成')
  job.log('版本文件准备完成', 'ok')
  return { versionId, jarVersion, effective }
}

/* ------------------------------------------------------------------ */
/* Base + loader                                                       */
/* ------------------------------------------------------------------ */

async function prepareVanilla(job, root, mc, { source, from, to }) {
  job.phaseLabel('下载版本信息', 'Minecraft ' + mc)
  const meta = await getVersionMeta(mc, { source, signal: job.signal })
  await saveVersionJson(root, mc, meta)
  job.log('版本清单已就绪：' + mc)

  const client = meta.downloads?.client
  if (!client?.url) throw new Error('该版本没有可下载的官方客户端')
  const jar = path.join(root, 'versions', mc, `${mc}.jar`)
  let last = 0
  job.phaseLabel('下载客户端', `${mc} · ${Math.round((client.size || 0) / 1048576)} MB`)
  await downloadFromMirrors(candidateUrls(client.url, { source }), jar, {
    sha1: client.sha1,
    size: client.size,
    signal: job.signal,
    verify: getSettings().verify !== false,
    retries: getSettings().retries || 0,
    onProgress: ({ received, total }) => {
      const delta = Math.max(0, Number(received) - last)
      last = Number(received) || 0
      if (total) progressIn(job, from, to, received / total, `客户端 JAR · ${Math.round(received / 1048576)} / ${Math.round(total / 1048576)} MB`)
      job.bytes(received, total)
    }
  })
  await downloadLogging(job, root, meta, { source })
  job.log('客户端 JAR 已下载', 'ok')
  return meta
}

async function installFabricLike(job, inst, loader, mc, loaderVersion, root, { source }) {
  job.phaseLabel('获取加载器配置', `${loader} ${loaderVersion}`)
  const profile = await getModLoaderProfile(loader, mc, loaderVersion, { signal: job.signal })
  const versionId = customVersionId(loader, mc, loaderVersion)
  profile.id = versionId
  profile.inheritsFrom = mc
  profile.type = 'release'
  await saveVersionJson(root, versionId, profile)
  job.log(`加载器 profile 已写入：${versionId}`)
  return versionId
}

async function installForgeLike(job, inst, loader, mc, loaderVersion, root, { source }) {
  const info = forgeInstaller(loader, mc, loaderVersion)
  const cacheDir = path.join(root, 'cache', 'installers')
  await fsp.mkdir(cacheDir, { recursive: true })
  const installerFile = path.join(cacheDir, info.filename)
  job.phaseLabel('下载安装器', info.filename)
  if (!fs.existsSync(installerFile) || (await fsp.stat(installerFile)).size < 1024) {
    job.log('下载官方安装器：' + info.filename)
    const urls = source === 'official'
      ? [info.url]
      : [...new Set([info.mirrorUrl, info.url].filter(Boolean))]
    await downloadFromMirrors(urls, installerFile, {
      signal: job.signal,
      retries: getSettings().retries || 0,
      onProgress: ({ received, total }) => {
        if (total) job.set(null, `安装器 ${Math.round(received / 1048576)} / ${Math.round(total / 1048576)} MB`, { indeterminate: true })
      }
    })
  } else {
    job.log('复用已缓存的安装器')
  }
  const versionInfo = await readInstallerVersion(installerFile)
  const expectedId = versionInfo?.id || info.expectedId
  job.log(`安装器目标版本：${expectedId}`)
  await prefillInstallerLibraries(job, installerFile, root, { source })

  // Minecraft itself and launcher_profiles.json must exist before the installer runs.
  await writeLauncherProfiles(root, expectedId)

  const meta = await getVersionMeta(mc, { source, signal: job.signal })
  const required = requiredJavaMajor(meta, mc)
  // Installers perform their own TLS downloads; newer Java versions are more
  // reliable with modern CDNs than the exact runtime the game itself needs.
  const java = await pickJava({ required, preferred: inst.javaPath, preferHighest: true })
  if (!java) throw new Error(`安装 ${loader} 需要至少 64 位 Java ${required}，但没有找到。请先在“Java 运行时”里下载或指定。`)
  job.log(`使用 Java ${java.version || java.major}（${java.path}）运行安装器`)

  const started = Date.now()
  await runInstaller(job, java.path, installerFile, root)
  job.signal.throwIfAborted()

  let versionId = expectedId
  let jsonFile = path.join(root, 'versions', versionId, `${versionId}.json`)
  if (!fs.existsSync(jsonFile)) {
    // Fall back to scanning newly-created version JSONs that inherit this MC.
    const versionsDir = path.join(root, 'versions')
    const entries = await fsp.readdir(versionsDir, { withFileTypes: true }).catch(() => [])
    const found = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === mc) continue
      const file = path.join(versionsDir, entry.name, `${entry.name}.json`)
      const stat = await fsp.stat(file).catch(() => null)
      if (!stat || stat.mtimeMs < started - 2000) continue
      const json = await readJson(file)
      if (json && (!json.inheritsFrom || json.inheritsFrom === mc)) found.push({ id: entry.name, mtime: stat.mtimeMs })
    }
    found.sort((a, b) => b.mtime - a.mtime)
    if (!found.length) throw new Error('安装器已退出，但没有生成版本文件。请查看日志；可尝试提高 Java 版本或检查网络。')
    versionId = found[0].id
    jsonFile = path.join(versionsDir, versionId, `${versionId}.json`)
  }
  const json = await readJson(jsonFile)
  job.log(`加载器安装完成：${versionId}（${json?.mainClass || '未知主类'}）`, 'ok')
  return versionId
}

/* ------------------------------------------------------------------ */
/* Instance installation                                               */
/* ------------------------------------------------------------------ */

async function installInstanceCore(job, instId, { from = 0, to = 100, source } = {}) {
  const inst = findInstance(instId)
  if (!inst) throw new Error('实例不存在')
  const root = launcherRoot()
  const settings = getSettings()
  const sourceMode = source || settings.source
  const mc = inst.mc
  const loader = inst.loader
  let loaderVersion = inst.loaderVersion
  if (!mc) throw new Error('实例缺少 Minecraft 版本')
  if (!['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'].includes(loader)) throw new Error('不支持的加载器：' + loader)

  await fsp.mkdir(root, { recursive: true })
  await fsp.mkdir(path.join(root, 'versions'), { recursive: true })
  await fsp.mkdir(path.join(root, 'libraries'), { recursive: true })
  await fsp.mkdir(path.join(root, 'assets'), { recursive: true })
  ensureInstanceDirs(inst)

  job.instanceId = instId
  job.mc = mc
  job.loader = loader
  job.phaseLabel('准备安装', `${mc} · ${loader === 'vanilla' ? '原版' : loader}`)
  job.log(`开始安装：${inst.name} · Minecraft ${mc} · ${loader}${loaderVersion ? ' ' + loaderVersion : ''}`)
  job.log('游戏根目录：' + root)

  if (loader !== 'vanilla' && !loaderVersion) {
    const versions = await listLoaderVersions(loader, mc, { signal: job.signal })
    const candidate = versions.find((item) => item.stable) || versions[0]
    if (!candidate) throw new Error(`${loader} 没有适用于 ${mc} 的版本`)
    loaderVersion = candidate.version
    updateInstance(instId, { loaderVersion })
    job.loaderVersion = loaderVersion
    job.log(`未指定加载器版本，已选择 ${loaderVersion}`)
  }

  progressIn(job, from, from + (to - from) * 0.02, 0, '准备版本清单')
  await prepareVanilla(job, root, mc, {
    source: sourceMode,
    from: from + (to - from) * 0.03,
    to: from + (to - from) * 0.15
  })

  let versionId = mc
  if (loader === 'vanilla') {
    versionId = mc
  } else if (loader === 'fabric' || loader === 'quilt') {
    versionId = await installFabricLike(job, inst, loader, mc, loaderVersion, root, { source: sourceMode })
  } else {
    versionId = await installForgeLike(job, inst, loader, mc, loaderVersion, root, { source: sourceMode })
  }

  const current = findInstance(instId)
  updateInstance(instId, {
    versionId,
    loader,
    loaderVersion,
    installing: true,
    installedAt: current?.installedAt || 0
  })
  job.log('版本 ID：' + versionId)
  const result = await installVersionFiles(job, instId, root, versionId, {
    source: sourceMode,
    from: from + (to - from) * 0.15,
    to: to - (to - from) * 0.01
  })
  const updated = findInstance(instId)
  job.name = updated?.name || job.name
  job.progress = 100
  job.detail = '安装完成'
  return result
}

export function startInstall({ name = '', mc, loader = 'vanilla', loaderVersion = '', memory = {}, minMemory, javaPath = '', group = '', jvmArgs = '' }) {
  if (!mc) throw new Error('请选择 Minecraft 版本')
  const settings = getSettings()
  const inst = createInstance({
    name: name || `${mc} ${loader === 'vanilla' ? '' : loader}`.trim(),
    mc,
    loader,
    loaderVersion,
    memory: {
      min: Number(memory.min ?? minMemory) || settings.defaultMinMemory,
      max: Number(memory.max) || settings.defaultMemory
    },
    javaPath,
    jvmArgs: String(jvmArgs || ''),
    group,
    versionId: mc,
    installing: true
  })
  const job = new InstallJob({
    type: 'install',
    instanceId: inst.id,
    name: inst.name,
    mc,
    loader,
    loaderVersion
  })
  runJob(job, async () => {
    await installInstanceCore(job, inst.id, { from: 0, to: 100 })
  })
  return { job: job.public(), instance: publicInstance(findInstance(inst.id)) }
}

function safeModFileName(name, fallback = 'mod-update.jar') {
  const base = path.basename(String(name || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()
  return base || fallback
}

function insideDir(base, target) {
  const dir = path.resolve(base)
  const file = path.resolve(target)
  return file === dir || file.startsWith(dir + path.sep)
}

/**
 * Download one or more mod updates and replace the previous JARs atomically.
 * The old file is removed only after the new download passed hash validation.
 */
export function startModUpdates(instanceId, items = []) {
  const inst = findInstance(instanceId)
  if (!inst) throw new Error('实例不存在')
  const list = (Array.isArray(items) ? items : []).filter((item) => item && item.relPath && item.url)
  if (!list.length) throw new Error('没有可更新的模组')
  const paths = ensureInstanceDirs(inst)
  const label = list.length === 1
    ? `更新 ${safeModFileName(list[0].name || list[0].filename, '模组')}`
    : `更新 ${list.length} 个模组`
  const job = new InstallJob({
    type: 'update',
    instanceId,
    name: label,
    mc: inst.mc,
    loader: inst.loader,
    loaderVersion: inst.loaderVersion
  })
  runJob(job, async () => {
    const total = list.reduce((sum, item) => sum + (Number(item.size) || 0), 0)
    let doneBytes = 0
    let done = 0
    job.log(`开始更新 ${list.length} 个模组`)
    for (const item of list) {
      job.signal.throwIfAborted()
      let url
      try { url = new URL(String(item.url || '')) } catch { throw new Error('更新地址无效：' + item.relPath) }
      if (!/^https?:$/.test(url.protocol)) throw new Error('更新地址必须是 HTTP(S)：' + item.relPath)
      const oldPath = path.resolve(paths.modsDir, ...String(item.relPath).replace(/\\/g, '/').split('/'))
      if (!insideDir(paths.modsDir, oldPath)) throw new Error('更新路径超出 mods 目录：' + item.relPath)
      const sha1 = String(item.sha1 || '').toLowerCase()
      if (!/^[0-9a-f]{40}$/.test(sha1)) throw new Error('更新缺少有效的 SHA-1 校验值：' + item.relPath)
      const disabled = /\.disabled$/i.test(oldPath)
      const filename = safeModFileName(item.filename || path.basename(oldPath))
      const target = path.join(paths.modsDir, filename + (disabled ? '.disabled' : ''))
      if (!insideDir(paths.modsDir, target)) throw new Error('更新文件名非法：' + filename)
      job.phaseLabel('下载更新', `${item.name || filename} · ${Math.round((Number(item.size) || 0) / 1048576 * 10) / 10} MB`)
      let last = 0
      await downloadFromMirrors([url.toString()], target, {
        sha1,
        size: Number(item.size) || 0,
        signal: job.signal,
        verify: true,
        retries: Number(getSettings().retries) || 0,
        onProgress: ({ received }) => {
          const delta = Math.max(0, Number(received) - last)
          last = Number(received) || 0
          doneBytes += delta
          if (total) progressIn(job, 0, 99, doneBytes / total, `下载更新 · ${Math.round(doneBytes / 1048576 * 10) / 10} / ${Math.round(total / 1048576 * 10) / 10} MB`)
          else progressIn(job, 0, 99, done / list.length, `下载更新 ${done + 1}/${list.length}`)
        }
      })
      if (oldPath !== target && fs.existsSync(oldPath)) await fsp.rm(oldPath, { force: true })
      done++
      job.log(`已更新：${path.basename(oldPath)} → ${path.basename(target)}`, 'ok')
      if (done === list.length) progressIn(job, 0, 100, 1, '更新完成')
      else progressIn(job, 0, 99, Math.max(done / list.length, total ? doneBytes / total : 0), `已完成 ${done}/${list.length}`)
    }
  })
  return { job: job.public(), instance: publicInstance(findInstance(instanceId)) }
}

export function clearFinishedJobs() {
  let removed = 0
  for (const [id, job] of jobs) {
    if (!FINISHED.has(job.status)) continue
    jobs.delete(id)
    removed++
  }
  return removed
}

export function startRepair(instanceId) {
  const inst = findInstance(instanceId)
  if (!inst) throw new Error('实例不存在')
  if (!inst.versionId) throw new Error('实例没有版本 ID')
  updateInstance(instanceId, { installing: true })
  const job = new InstallJob({ type: 'repair', instanceId, name: inst.name, mc: inst.mc, loader: inst.loader, loaderVersion: inst.loaderVersion })
  runJob(job, async () => {
    job.log('开始检查并修复文件')
    await installVersionFiles(job, instanceId, inst.baseDir || launcherRoot(), inst.versionId, {
      source: getSettings().source,
      from: 0,
      to: 100
    })
  })
  return { job: job.public(), instance: publicInstance(findInstance(instanceId)) }
}

/* ------------------------------------------------------------------ */
/* Modpacks                                                           */
/* ------------------------------------------------------------------ */

function loaderFromDependencies(dependencies = {}) {
  for (const [key, value] of Object.entries(dependencies)) {
    if (key === 'minecraft') continue
    if (/fabric/i.test(key)) return { loader: 'fabric', loaderVersion: String(value) }
    if (/quilt/i.test(key)) return { loader: 'quilt', loaderVersion: String(value) }
    if (/neoforge/i.test(key)) return { loader: 'neoforge', loaderVersion: String(value) }
    if (/forge/i.test(key)) return { loader: 'forge', loaderVersion: String(value) }
  }
  return { loader: 'vanilla', loaderVersion: '' }
}

function loaderFromCurseForge(manifest) {
  const mc = manifest?.minecraft?.version || ''
  const modLoaders = Array.isArray(manifest?.minecraft?.modLoaders) ? manifest.minecraft.modLoaders : []
  const primary = modLoaders.find((item) => item.primary) || modLoaders[0]
  if (!primary?.id) return { mc, loader: 'vanilla', loaderVersion: '' }
  const match = /^(forge|fabric|neoforge|quilt)-(.+)$/i.exec(primary.id)
  if (!match) return { mc, loader: 'vanilla', loaderVersion: '' }
  return { mc, loader: match[1].toLowerCase(), loaderVersion: match[2] }
}

async function readPackMeta(file) {
  let entries = {}
  try { entries = await readJarEntries(file, ['modrinth.index.json', 'manifest.json'], { maxBytes: 24 * 1024 * 1024 }) } catch {}
  if (entries['modrinth.index.json']) {
    const index = JSON.parse(entries['modrinth.index.json'].toString('utf8'))
    const deps = index.dependencies || {}
    const loader = loaderFromDependencies(deps)
    return {
      kind: 'modrinth',
      index,
      name: index.name || path.basename(file, path.extname(file)),
      mc: String(deps.minecraft || ''),
      ...loader
    }
  }
  if (entries['manifest.json']) {
    const manifest = JSON.parse(entries['manifest.json'].toString('utf8'))
    if (manifest.manifestType !== 'minecraftModpack') throw new Error('不是受支持的 CurseForge 整合包')
    const runtime = loaderFromCurseForge(manifest)
    return {
      kind: 'curseforge',
      manifest,
      name: manifest.name || path.basename(file, path.extname(file)),
      ...runtime
    }
  }
  throw new Error('无法识别整合包：缺少 modrinth.index.json 或 manifest.json')
}

async function copyPackOverrides(tempDir, gameDir, kind, job) {
  const metadata = new Set(['manifest.json', 'modlist.html', 'modrinth.index.json'])
  const dirs = ['overrides', 'client-overrides', 'server-overrides']
  let copied = 0
  const copyEntry = async (source, target) => {
    job.signal.throwIfAborted()
    const stat = await fsp.stat(source)
    if (stat.isDirectory()) {
      await fsp.mkdir(target, { recursive: true })
      for (const name of await fsp.readdir(source)) await copyEntry(path.join(source, name), path.join(target, name))
    } else if (stat.isFile()) {
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.copyFile(source, target)
      copied++
    }
  }
  let foundOverride = false
  for (const dir of dirs) {
    const full = path.join(tempDir, dir)
    if (fs.existsSync(full)) {
      foundOverride = true
      await copyEntry(full, gameDir)
    }
  }
  // CurseForge exports sometimes put content at the archive root.
  for (const name of await fsp.readdir(tempDir)) {
    if (dirs.includes(name) || metadata.has(name)) continue
    if (kind === 'modrinth' && !foundOverride) continue
    await copyEntry(path.join(tempDir, name), path.join(gameDir, name))
  }
  return copied
}

async function downloadModrinthPackFiles(job, index, gameDir, { from, to }) {
  const files = (index.files || []).filter((item) => item?.env?.client !== 'unsupported')
  if (!files.length) return 0
  const total = files.reduce((sum, item) => sum + (Number(item.fileSize) || 0), 0)
  let done = 0
  let bytes = 0
  job.phaseLabel('下载整合包文件', `${files.length} 个文件`)
  await runPool(files, async (item) => {
    job.signal.throwIfAborted()
    const rel = String(item.path || '').replace(/\\/g, '/').replace(/^\/+/, '')
    if (!rel || rel.split('/').some((part) => part === '..')) throw new Error('整合包包含非法路径：' + item.path)
    const target = path.join(gameDir, ...rel.split('/'))
    const hashes = item.hashes || {}
    const algorithm = hashes.sha512 ? 'sha512' : hashes.sha1 ? 'sha1' : ''
    if (!algorithm) throw new Error('整合包文件缺少校验值：' + rel)
    const urls = Array.isArray(item.downloads) ? item.downloads : []
    if (!urls.length) throw new Error('整合包文件缺少下载地址：' + rel)
    let last = 0
    const hash = hashes[algorithm]
    // downloadFromMirrors verifies sha1 only; verify sha512 ourselves afterwards.
    const targetTemp = target
    let lastError = null
    for (const url of urls) {
      try {
        await downloadFromMirrors([url], targetTemp, {
          size: Number(item.fileSize) || 0,
          signal: job.signal,
          verify: false,
          retries: getSettings().retries || 0,
          onProgress: ({ received }) => {
            const delta = Math.max(0, received - last)
            last = received
            bytes += delta
            if (total) progressIn(job, from, to, bytes / total, `整合包文件 ${done + 1}/${files.length} · ${path.basename(rel)}`)
            job.bytes(bytes, total)
          }
        })
        const digest = crypto.createHash(algorithm)
        for await (const chunk of fs.createReadStream(targetTemp)) digest.update(chunk)
        if (digest.digest('hex').toLowerCase() !== String(hash).toLowerCase()) throw new Error('哈希校验失败')
        lastError = null
        break
      } catch (e) {
        if (job.signal.aborted) throw e
        lastError = e
      }
    }
    if (lastError) throw new Error(`整合包文件 ${rel} 下载失败：${lastError.message}`)
    done++
    if (done % 10 === 0 || done === files.length) job.log(`整合包文件 ${done}/${files.length}`)
  }, getSettings().concurrency, job.signal)
  job.log(`整合包文件下载完成（${files.length} 个）`, 'ok')
  return done
}

export function startPackInstall({ source, name = '', memory = {}, minMemory, javaPath = '', group = '', uploaded = false }) {
  if (!source) throw new Error('缺少整合包路径')
  const job = new InstallJob({ type: 'pack', name: name || path.basename(source), mc: '', loader: 'vanilla' })
  const tempRoot = path.join(launcherRoot(), 'cache', 'packs', job.id)
  job.cleanup = async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
    if (uploaded) await fsp.rm(path.dirname(source), { recursive: true, force: true }).catch(() => {})
  }
  runJob(job, async () => {
    const file = source
    if (!fs.existsSync(file)) throw new Error('整合包文件不存在：' + file)
    job.log('读取整合包：' + path.basename(file))
    const meta = await readPackMeta(file)
    job.log(`识别为 ${meta.kind === 'modrinth' ? 'Modrinth' : 'CurseForge'} 整合包 · ${meta.name}`)
    if (!meta.mc) throw new Error('整合包没有声明 Minecraft 版本')
    const instName = String(name || meta.name || '整合包').trim()
    const settings = getSettings()
    job.mc = meta.mc
    job.loader = meta.loader
    job.loaderVersion = meta.loaderVersion
    job.name = instName
    const inst = createInstance({
      name: instName,
      mc: meta.mc,
      loader: meta.loader,
      loaderVersion: meta.loaderVersion,
      memory: {
        min: Number(memory.min ?? minMemory) || settings.defaultMinMemory,
        max: Number(memory.max) || settings.defaultMemory
      },
      javaPath,
      group,
      versionId: meta.mc,
      installing: true
    })
    job.instanceId = inst.id
    job.log(`已创建实例：${inst.name}（${meta.mc} · ${meta.loader}${meta.loaderVersion ? ' ' + meta.loaderVersion : ''}）`)
    await fsp.mkdir(tempRoot, { recursive: true })

    // Install the loader/version first.
    await installInstanceCore(job, inst.id, { from: 0, to: 62, source: settings.source })
    job.signal.throwIfAborted()

    const current = findInstance(inst.id)
    const paths = instancePaths(current)
    await fsp.mkdir(paths.gameDir, { recursive: true })

    job.phaseLabel('解压整合包覆盖文件', '正在解压 overrides')
    job.set(64, '解压整合包覆盖文件…', { indeterminate: false })
    await extractZip(file, tempRoot, (ratio) => progressIn(job, 62, 72, ratio, '解压整合包覆盖文件'), job.signal)
    const copied = await copyPackOverrides(tempRoot, paths.gameDir, meta.kind, job)
    job.log(`覆盖文件已复制（${copied} 个）`)

    if (meta.kind === 'modrinth') {
      await downloadModrinthPackFiles(job, meta.index, paths.gameDir, { from: 72, to: 96 })
    } else {
      job.phaseLabel('补齐 CurseForge 文件', '通过清单文件 ID 下载')
      job.set(76, '正在按清单补齐 CurseForge 文件…')
      const manifestFile = path.join(paths.gameDir, 'manifest.json')
      let manifestInstalled = false
      try {
        // hydrateCurseForgeFiles expects the manifest at its root; keep it out of
        // the game directory afterwards so the instance stays clean.
        if (!fs.existsSync(manifestFile)) {
          await fsp.writeFile(manifestFile, JSON.stringify(meta.manifest, null, 2), 'utf8')
          manifestInstalled = true
        }
        await hydrateCurseForgeFiles(paths.gameDir, ({ progress, detail }) => {
          const raw = Number(progress)
          const ratio = Number.isFinite(raw) ? Math.max(0, Math.min(1, (raw - 28) / 15)) : null
          if (ratio !== null) progressIn(job, 72, 96, ratio, detail || '正在补齐 CurseForge 文件…')
          else job.set(null, detail || '正在补齐 CurseForge 文件…', { indeterminate: true })
        }, job.signal, {
          apiKey: store.get('settings', {}).community?.cfApiKey || ''
        })
      } finally {
        if (manifestInstalled) await fsp.rm(manifestFile, { force: true }).catch(() => {})
      }
    }

    await fsp.writeFile(path.join(paths.gameDir, '.mc-toolbox-pack.json'), JSON.stringify({
      name: instName,
      kind: meta.kind,
      mc: meta.mc,
      loader: meta.loader,
      loaderVersion: meta.loaderVersion,
      installedAt: Date.now()
    }, null, 2), 'utf8')
    job.set(98, '整合包安装完成，正在收尾…')
    job.log('整合包内容安装完成', 'ok')
    updateInstance(inst.id, { installing: false, installedAt: Date.now() })
    job.log('完成的实例：' + inst.name, 'ok')
  })
  return { job: job.public() }
}

export function readPackSummary(file) {
  return readPackMeta(file)
}
