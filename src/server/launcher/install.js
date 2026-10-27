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
  listInstances,
  updateInstance,
  deleteInstance,
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
import { downloadFromMirrors, fetchToFile, pickFastestSource, runPool, sha1File } from './download.js'
import { hostOf } from './source-select.js'
import { nextSpeed } from './speed-meter.js'
import { pickJava } from './java.js'
import {
  isSeedableMojmapsProfile, patchJarEntry, patchMojmapsProcessor, readJarJson, resolveMojmapsCoordinate
} from './jar-patch.js'
import { readZipIndex, extractZip } from '../pack-converter.js'
import { hydrateCurseForgeFiles } from '../curseforge-pack.js'
import { resolveOnlinePack } from './pack-online.js'

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

function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0)
  if (n >= 1024 ** 3) return `${Math.round((n / 1024 ** 3) * 10) / 10} GB`
  if (n >= 1024 ** 2) return `${Math.round((n / 1024 ** 2) * 10) / 10} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

async function sha512File(file, signal) {
  const hash = crypto.createHash('sha512')
  for await (const chunk of fs.createReadStream(file)) {
    signal?.throwIfAborted()
    hash.update(chunk)
  }
  return hash.digest('hex')
}

/** 在线整合包文件名只取 basename，避免接口返回的路径逃出缓存目录。 */
function safePackFilename(name, fallback = 'pack.mrpack') {
  const base = path.basename(String(name || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()
  if (!base || base === '.' || base === '..') return fallback
  return base
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
    // createdAt 是排队时刻，startedAt 只在 runJob 真正开跑时写入：
    // 排队时间不能算进「已进行」，否则界面会出现「已进行 9.7 小时」。
    this.createdAt = Date.now()
    this.startedAt = 0
    this.finishedAt = 0
    this.updatedAt = this.createdAt
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
    this.openWhenDone = opts.openWhenDone === true
    this.lockedPhase = ''
    // 逻辑阶段（锁定顶层阶段时仍随内部子阶段变化），用于判断何时清零字节。
    this.phaseKey = this.phase
    // 实时下载速度（B/s）：由 startSpeedMeter 每 500ms 采样 received 得出。
    // 前端 core/jobs.js 的 jobSpeedText 直接读这个字段。
    this.speed = 0
    this.speedTimer = null
    // 完成文案补充（例如整合包缺光影）与「失败也保留实例」标记。
    this.completionNote = ''
    this.keepOnFailure = false
  }

  get signal() { return this.controller.signal }

  /**
   * 开始速度采样。字节计数由各下载阶段写入 received，这里只做差分与平滑，
   * 因此整合包 / 原版安装共用同一套速度口径。
   */
  startSpeedMeter(interval = 500) {
    this.stopSpeedMeter()
    let lastBytes = this.received
    let lastAt = Date.now()
    this.speedTimer = setInterval(() => {
      const now = Date.now()
      const dt = Math.max(0.1, (now - lastAt) / 1000)
      const delta = this.received - lastBytes
      lastBytes = this.received
      lastAt = now
      // 阶段切换时 received 会被清零：这一拍只重置基线，不能算成负速度。
      this.speed = delta < 0 ? 0 : nextSpeed(this.speed, delta, dt)
      if (this.finishedAt) this.stopSpeedMeter()
    }, interval)
    // 采样定时器不能阻止进程退出（测试 / 关闭启动器时立即结束）。
    this.speedTimer.unref?.()
  }

  stopSpeedMeter() {
    if (this.speedTimer) clearInterval(this.speedTimer)
    this.speedTimer = null
    this.speed = 0
  }

  log(text, kind = '') {
    const line = { seq: ++this.logSeq, t: nowTime(), text: String(text ?? ''), kind }
    this.logs.push(line)
    if (this.logs.length > 1500) this.logs.splice(0, this.logs.length - 1500)
    // 安装器输出 / 日志同样算「有进展」，避免长阶段被误判为无响应。
    // 任务结束后不再改写 updatedAt，保持「最后活动时间 = finishedAt」。
    if (!this.finishedAt) this.updatedAt = Date.now()
    return line
  }

  phaseLabel(phase, detail) {
    // 在线整合包把「安装加载器」作为固定顶层阶段，期间内部细分只更新 detail。
    // phaseKey 始终记录真正的阶段：顶层阶段变化，或锁定阶段内切换到
    // 「下载依赖库 / 下载资源文件」等子阶段时，必须清零字节，避免上一阶段
    // 的 60 MB 整合包残留到下一阶段，出现详情 599 MB、字节 60 MB 的错位。
    const next = String(phase ?? '')
    const changed = next !== this.phaseKey
    this.phaseKey = next
    if (!this.lockedPhase) this.phase = next
    if (changed) this.resetBytes()
    if (detail) this.detail = detail
    this.updatedAt = Date.now()
  }

  /** 阶段切换时重置本阶段字节计数。 */
  resetBytes() {
    this.received = 0
    this.total = 0
    this.updatedAt = Date.now()
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
    this.updatedAt = Date.now()
  }

  bytes(received, total) {
    this.received = Math.max(0, Math.round(Number(received) || 0))
    // total 未知（undefined / null / 0）时归零，不能沿用上一阶段的总量，
    // 否则 received 属于新阶段、total 还停在旧阶段，百分比就会失真。
    this.total = Math.max(0, Math.round(Number(total) || 0))
    this.updatedAt = Date.now()
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
      speed: this.speed,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      updatedAt: this.updatedAt,
      error: this.error,
      instanceId: this.instanceId,
      name: this.name,
      mc: this.mc,
      loader: this.loader,
      loaderVersion: this.loaderVersion,
      openWhenDone: this.openWhenDone === true,
      logSeq: this.logSeq,
      // 供前端在再次拖入同一个整合包时先做本地判断，避免重新上传 1 GB 才被拒绝。
      packKey: this.packKey || '',
      logs: includeLogs ? this.logs.slice(-200) : undefined
    }
  }
}

function finishJob(job, status, error = '') {
  if (job.finishedAt) return
  job.finishedAt = Date.now()
  job.updatedAt = job.finishedAt
  job.status = status
  job.error = error || ''
  job.stopSpeedMeter?.()
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
      try { await job.cleanup?.() } catch {}
      if (job.createdInstanceId && job.createdInstanceId === job.instanceId) {
        try {
          deleteInstance(job.instanceId)
          job.log('已清理未完成的实例，可直接重新安装', 'warn')
          job.instanceId = ''
        } catch {}
      } else if (job.instanceId) {
        try { updateInstance(job.instanceId, { installing: false }) } catch {}
      }
      return
    }
    job.status = 'running'
    // 只有真正开始执行才写 startedAt；排队等待通过 createdAt 展示。
    job.startedAt = Date.now()
    job.updatedAt = job.startedAt
    job.startSpeedMeter()
    job.log('任务开始')
    try {
      await task(job)
      // 任务体已经写完实例（例如整合包在收尾清理缓存）时，取消请求不能再
      // 把它算成「取消」，否则 finally 会把一个装好的实例删掉。
      if (!job.committed && (job.controller.signal.aborted || job.cancelRequested)) {
        finishJob(job, 'cancelled')
        job.log('任务已取消', 'warn')
        return
      }
      if (job.committed && job.cancelRequested) job.log('安装已完成，忽略取消请求', 'warn')
      job.progress = 100
      job.indeterminate = false
      job.detail = job.type === 'pack'
        ? (job.completionNote || '整合包安装完成')
        : job.type === 'update' ? '模组更新完成' : '安装完成'
      job.log(job.detail, 'ok')
      finishJob(job, 'done')
      // 整个任务成功后才让实例进列表：整合包装加载器只算完成一半。
      if (job.instanceId) {
        try { updateInstance(job.instanceId, { installing: false, installedAt: Date.now() }) } catch {}
      }
    } catch (e) {
      if (job.committed) {
        // 收尾阶段的失败（多为清理缓存）不影响已经装好的实例。
        finishJob(job, 'done')
        job.log('收尾清理失败，但安装内容已完成：' + e.message, 'warn')
      } else if (job.controller.signal.aborted || job.cancelRequested) {
        finishJob(job, 'cancelled')
        job.log('任务已取消', 'warn')
      } else {
        finishJob(job, 'failed', e.message)
        job.log('安装失败：' + e.message, 'err')
      }
    } finally {
      try { await job.cleanup?.() } catch {}
      // 整合包安装失败 / 取消时，本次任务刚创建的实例没有任何可用文件，
      // 留在列表里只会变成「点不动的重复实例」。连同目录一起删掉，方便直接重装。
      // 例外：CurseForge 受限文件失败时已经下好大量内容，保留实例等用户补齐。
      const unfinished = ['failed', 'cancelled'].includes(job.status) && !job.committed && !job.keepOnFailure
      if (unfinished && job.createdInstanceId && job.createdInstanceId === job.instanceId) {
        try {
          deleteInstance(job.instanceId)
          job.log('已清理未完成的实例，可直接重新安装', 'warn')
          job.instanceId = ''
        } catch {}
      } else if (job.instanceId) {
        try { updateInstance(job.instanceId, { installing: false }) } catch {}
      }
    }
  })
  return job
}

/**
 * 启动时恢复：上一次进程被杀掉时留下的「安装中」实例已经没有任务在跑，
 * 也不会再完成。只把标记复位，让它在列表里以「需要修复」出现，交给用户决定
 * 删除或重装 —— 多开时另一个进程可能正在安装同一个实例，直接删目录会丢数据。
 */
export function pruneUnfinishedInstances() {
  const live = new Set(
    [...jobs.values()]
      .filter((job) => !FINISHED.has(job.status))
      .map((job) => job.instanceId)
      .filter(Boolean)
  )
  let recovered = 0
  for (const inst of listInstances({ includeInstalling: true, includePaths: false })) {
    if (!inst.installing || live.has(inst.id)) continue
    try {
      updateInstance(inst.id, { installing: false })
      recovered++
    } catch {}
  }
  return recovered
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
    .sort((a, b) => (b.startedAt || b.createdAt) - (a.startedAt || a.createdAt))
    .map((job) => job.public({ includeLogs: false }))
}

export function activeJobs() {
  return [...jobs.values()].filter((job) => !FINISHED.has(job.status))
}

/* ------------------------------------------------------------------ */
/* 导入去重与同目录串行化                                             */
/* ------------------------------------------------------------------ */

/**
 * 整合包导入的稳定标识：上传时前端给出「文件名 + 大小 + 修改时间」，本地路径
 * 安装用解析后的绝对路径。上一次导入还没结束就再次拖入同一个包时直接拒绝，
 * 避免两个安装器同时改写 libraries / versions 与 patched jar。
 */
export function packImportKey(source, packKey = '') {
  const explicit = String(packKey || '').trim()
  if (explicit) return explicit
  const file = path.resolve(String(source || ''))
  return 'path:' + (process.platform === 'win32' ? file.toLowerCase() : file)
}

export function findActivePackJob(items, key) {
  if (!key) return null
  return (Array.isArray(items) ? items : []).find((job) =>
    job && job.type === 'pack' && job.packKey === key && !FINISHED.has(job.status)
  ) || null
}

const rootInstallLocks = new Map()

/**
 * 同一个游戏目录的安装共用 libraries / versions / launcher_profiles.json 与
 * cache/installers 里的 patched jar：并发运行时安装器会互相覆盖文件，直接以
 * 「A problem installing was detected」退出。这里按 root 串行化安装阶段；
 * 后来的任务保持 running 并显示「等待同目录安装任务完成…」。
 */
export async function withRootInstallLock(root, job, task) {
  const key = String(root || '').toLowerCase() || '.'
  const previous = rootInstallLocks.get(key) || null
  let release
  const gate = new Promise((resolve) => { release = () => resolve() })
  const tail = (previous || Promise.resolve()).catch(() => {}).then(() => gate)
  rootInstallLocks.set(key, tail)
  const done = () => {
    release()
    if (rootInstallLocks.get(key) === tail) rootInstallLocks.delete(key)
  }
  if (previous) {
    job?.log?.('同一游戏目录已有安装任务，等待其完成后再安装…', 'warn')
    job?.phaseLabel?.(job?.phaseKey || '准备安装', '等待同目录安装任务完成…')
    try {
      await new Promise((resolve, reject) => {
        const signal = job?.signal
        if (!signal) { previous.catch(() => {}).then(resolve); return }
        if (signal.aborted) { reject(new Error('已取消')); return }
        const onAbort = () => reject(new Error('已取消'))
        signal.addEventListener('abort', onAbort, { once: true })
        previous.catch(() => {}).then(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        })
      })
    } catch (e) {
      done()
      throw e
    }
  }
  try {
    job?.signal?.throwIfAborted?.()
    return await task()
  } finally {
    done()
  }
}

export function cancelJob(id) {
  const job = jobs.get(id)
  if (!job || FINISHED.has(job.status) || job.status === 'cancelling') return false
  job.cancelRequested = true
  job.status = 'cancelling'
  job.detail = '正在取消并清理…'
  job.updatedAt = Date.now()
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
  job.updatedAt = Date.now()
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

// Forge/NeoForge install_profile 中由 processor 生成、不能从 Maven 预取的 data 键。
const GENERATED_PROFILE_DATA = new Set([
  'MOJMAPS', 'MAPPINGS', 'MERGED_MAPPINGS', 'MC_UNPACKED', 'MC_SLIM',
  'MC_EXTRA', 'MC_SRG', 'PATCHED', 'BINPATCH'
])

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
    // data 里混着两类值：真实 Maven 坐标（如 mcp_config）和安装器自己生成的
    // 产物（MOJMAPS / MERGED_MAPPINGS / MC_UNPACKED / PATCHED…）。后者在
    // Maven 上不存在，预取只会得到 404 或超时；它们必须由 processor 生成。
    for (const [key, value] of Object.entries(profile?.data || {})) {
      if (GENERATED_PROFILE_DATA.has(key)) continue
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
        ...netOptions(),
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

const INSTALLER_ATTEMPTS = 3
const TRANSIENT_INSTALLER_ERROR = /SocketException|Connect timed out|Connection reset|Read timed out|timed out|Temporary failure|Broken pipe|SSLException|EOFException|HTTP (?:5\d\d|429)/i

/** 安装器输出是否属于可重试的网络错误（TLS 重置、连接超时、CDN 5xx）。 */
export function isTransientInstallerError(output) {
  return TRANSIENT_INSTALLER_ERROR.test(String(output || ''))
}

// Forge 安装器把异常吞掉后只留下这一句，用户因此看不到任何具体原因。
const INSTALLER_SILENT_ABORT = /A problem installing was detected/i

/**
 * 安装器失败的可见原因：优先给出网络判断和最后一条错误行，而不是只报退出码。
 * 只有网络类失败才建议换下载源 —— 签名校验、Java 版本、磁盘权限这类失败换源
 * 没有任何帮助，旧文案一律让用户「切换为 BMCLAPI」只会让人以为换源无效。
 */
export function installerFailureMessage(code, output, attempts = 1) {
  const text = String(output || '')
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  // 优先取真正的异常行；安装器最后总会补一句 "There was an error during
  // installation"，没有信息量，不能让它覆盖 Connection reset 这类原因。
  const last = [...lines].reverse().find((line) =>
    /(Exception|Error:|Failed to run processor|Unable to|Could not|Unsupported|错误|失败)/i.test(line)) || ''
  const network = isTransientInstallerError(text)
  const retried = attempts > 1 ? `，已自动重试 ${attempts - 1} 次` : ''
  const detail = last ? `：${last.slice(0, 220)}` : ''
  if (network) {
    return `安装器访问 Mojang / Forge 服务器时网络中断（退出码 ${code}）${retried}${detail}。请检查网络后重试；国内线路可在设置里把下载源切换为 BMCLAPI 镜像。`
  }
  if (INSTALLER_SILENT_ABORT.test(text)) {
    return `安装器在启动阶段中止，没有给出具体异常（退出码 ${code}）${retried}。` +
      'Forge 安装器会吞掉这里的原因，多半是安装器 JAR 被改动后签名校验失败，或 Java 版本不匹配；' +
      '与下载源无关，换源不会有帮助。请重试；仍失败请把任务日志发给作者。'
  }
  return `安装器返回非零退出码（退出码 ${code}）${retried}${detail}。请查看任务日志里的安装器输出后重试。`
}

/**
 * 官方安装器的 DOWNLOAD_MOJMAPS 会直连 Mojang 下载 client mappings，不受启动器
 * 下载源设置影响。国内线路常见 Connection reset，导致安装器退出码 1。
 *
 * 这里先用启动器的镜像链预取 mappings，再给安装器 profile 打上 --skipIfExists，
 * 生成一个只改了一个条目的 patched JAR；安装器便会跳过那次直连下载。
 * 返回 patched JAR 路径；任何一步失败都回退到原始安装器。
 */
async function prepareInstallerMappings(job, installerFile, root, meta, { source }) {
  let profile = null
  try { profile = await readJarJson(installerFile, 'install_profile.json') } catch (e) {
    job.log('读取安装器配置失败，跳过映射预取：' + e.message, 'warn')
    return ''
  }
  if (!profile) return ''
  if (!isSeedableMojmapsProfile(profile)) {
    job.log('安装器会改写映射表格式，跳过预取（交给安装器自行下载）', 'warn')
    return ''
  }
  const coordinate = resolveMojmapsCoordinate(profile, 'client')
  if (!coordinate) return ''
  const relative = mavenRelativePath(coordinate)
  if (!relative) return ''
  const mappings = meta?.downloads?.client_mappings
  if (!mappings?.url) {
    job.log('版本清单没有 client_mappings，交给安装器自行下载', 'warn')
    return ''
  }
  const dest = path.join(root, 'libraries', ...relative.replace(/\\/g, '/').split('/'))
  const expectedSize = Number(mappings.size) || 0
  const expectedSha1 = String(mappings.sha1 || '').toLowerCase()
  const existing = await fsp.stat(dest).catch(() => null)
  let valid = !!existing?.isFile() && existing.size > 0
    && (!expectedSize || existing.size === expectedSize)
  if (valid && expectedSha1) valid = (await sha1File(dest).catch(() => '')) === expectedSha1
  if (!valid) {
    job.log('预取 Mojang 映射表（安装器直连 Mojang 经常被重置）…')
    await downloadFromMirrors(candidateUrls(mappings.url, { source }), dest, {
      ...netOptions(source),
      sha1: mappings.sha1 || '',
      size: expectedSize,
      signal: job.signal,
      verify: true,
      retries: Math.max(2, Number(getSettings().retries) || 0)
    })
    job.log('Mojang 映射表已就绪', 'ok')
  } else {
    job.log('复用已校验的 Mojang 映射表')
  }
  if (!patchMojmapsProcessor(profile)) return ''
  // 每个任务独立文件：即使有别的进程/旧任务还在使用同一个安装器，也不会把
  // 彼此正在运行的 patched jar 覆盖成半截文件。
  const patched = `${installerFile}.${job.id}.patched.jar`
  const result = await patchJarEntry(installerFile, 'install_profile.json', (raw) => {
    let next = null
    try { next = JSON.parse(raw.toString('utf8')) } catch { return null }
    if (!patchMojmapsProcessor(next)) return null
    return Buffer.from(JSON.stringify(next))
  }, patched)
  if (!result.changed) return ''
  if (result.signatureRemoved) {
    // 新版 Forge 安装器是签名 JAR：改过 install_profile.json 后 Java 会以
    // 「SHA-384 digest error」拒绝读取，安装器随后只说一句「A problem installing
    // was detected」就退出。补丁必然破坏签名，因此把签名文件一并移除。
    job.log(`安装器带 JAR 签名，已移除签名文件（${result.removedSignatures.join('、')}）`, 'warn')
  }
  job.log('安装器已配置为复用预取的映射表，跳过 DOWNLOAD_MOJMAPS 直连', 'ok')
  return patched
}

async function runInstallerOnce(job, javaPath, installerFile, root) {
  const args = [
    ...proxyJvmArgs(),
    // Windows 上 Java 的 stdout 默认是 GBK，中文路径/中文报错会在任务日志里
    // 变成乱码；强制安装器用 UTF-8 输出（17 用 sun.*，18+ 用 stdout.*）。
    '-Dfile.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dstderr.encoding=UTF-8',
    '-Dsun.stdout.encoding=UTF-8',
    '-Dsun.stderr.encoding=UTF-8',
    '-jar', installerFile, '--installClient', root
  ]
  job.phaseLabel('安装加载器', '正在运行官方安装器（下载并处理 libraries）…')
  job.set(null, '安装器正在工作…（此阶段耗时取决于网络）', { indeterminate: true })
  job.log(`执行安装器：${path.basename(installerFile)}`)
  return await new Promise((resolve, reject) => {
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
      else resolve({ code: Number.isFinite(code) ? code : 1, output })
    })
  })
}

async function runInstaller(job, javaPath, installerFile, root) {
  let last = null
  let attempts = 0
  for (let attempt = 1; attempt <= INSTALLER_ATTEMPTS; attempt++) {
    attempts = attempt
    if (attempt > 1) {
      job.log(`安装器网络请求失败，正在重试（${attempt}/${INSTALLER_ATTEMPTS}）…`, 'warn')
      job.phaseLabel('安装加载器', `安装器重试 ${attempt}/${INSTALLER_ATTEMPTS}`)
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt - 1)))
      job.signal.throwIfAborted()
    }
    last = await runInstallerOnce(job, javaPath, installerFile, root)
    if (last.code === 0) return last.output
    // 只有网络类错误才值得原样重跑；Java 版本 / profile 错误重试也不会变好。
    if (!isTransientInstallerError(last.output)) break
  }
  throw new Error(installerFailureMessage(last?.code ?? 1, last?.output || '', attempts))
}

/* ------------------------------------------------------------------ */
/* Downloads                                                           */
/* ------------------------------------------------------------------ */

/**
 * 下载参数：自动源先测速再选线路；显式选择官方 / BMCL 时保持用户给的顺序。
 * threads 来自启动器设置（大文件分段线程数），小文件会自动退化为单连接。
 */
function netOptions(source) {
  const settings = getSettings()
  return {
    threads: Math.max(1, Math.min(16, Number(settings.threads) || 1)),
    rankBySpeed: (source || settings.source) === 'auto'
  }
}

async function downloadOne(job, artifact, dest, { source, from, to, baseDone, baseTotal, label }) {
  const urls = artifactUrls(artifact, source)
  if (!urls.length) throw new Error('缺少下载地址：' + artifact.path)
  let last = 0
  await downloadFromMirrors(urls, dest, {
    ...netOptions(source),
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
  }, Math.max(8, Math.min(32, (Number(getSettings().concurrency) || 8) * 2)), job.signal)
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

/**
 * 素材下载前先测速：小文件的探测样本只反映延迟，这里拿最大的一个音频
 * （通常几 MB）同时探测 BMCL 与官方，选快的线路；日志写明结果，
 * 用户不用再猜「为什么一开始那么慢」。
 */
async function probeAssetSource(job, entries, { source }) {
  if ((source || getSettings().source) !== 'auto') return
  const biggest = entries
    .filter(([, value]) => Number(value?.size) >= 1024 * 1024)
    .sort((a, b) => Number(b[1].size) - Number(a[1].size))[0]
  const hash = String(biggest?.[1]?.hash || '')
  if (!hash) return
  const urls = assetObjectUrls(hash, { source })
  if (urls.length < 2) return
  try {
    const result = await pickFastestSource(urls, { signal: job.signal })
    if (!result.url) return
    const speeds = result.speeds
      .map(({ url, bps }) => `${hostOf(url)} ${bps > 0 ? formatBytes(bps) + '/s' : '未测出'}`)
      .join(' · ')
    job.log(`线路测速：${speeds}；资源优先走 ${hostOf(result.url)}`)
  } catch (e) {
    if (job.signal.aborted) throw e
    job.log('线路测速失败，继续按默认顺序下载：' + e.message, 'warn')
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
      ...netOptions(source),
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
  // 素材大多是几十 KB 的小文件，瓶颈是请求延迟而不是单连接带宽：
  // 并发开到 16–64，大文件再叠加分段线程，才能跑满线路。
  const concurrency = Math.max(16, Math.min(64, (Number(getSettings().concurrency) || 8) * 4))
  await probeAssetSource(job, entries, { source })
  await runPool(entries, async ([name, value]) => {
    const hash = String(value.hash || '')
    const dest = path.join(root, 'assets', 'objects', hash.slice(0, 2), hash)
    let last = 0
    await downloadFromMirrors(assetObjectUrls(hash, { source }), dest, {
      ...netOptions(source),
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
    ...netOptions(source),
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

  const libFrom = from + (to - from) * 0.02
  const clientJar = path.join(root, 'versions', jarVersion, `${jarVersion}.jar`)
  if (!fs.existsSync(clientJar)) {
    // Very old versions or imported instances may need the client jar.
    const meta = await getVersionMeta(jarVersion, { source, signal: job.signal })
    const info = meta?.downloads?.client
    if (!info?.url) throw new Error('缺少客户端 JAR，且该版本没有下载地址')
    job.log('补下载客户端 JAR：' + jarVersion)
    // 与其它下载阶段使用同一套计数：detail、received/total 都来自本次下载。
    job.phaseLabel('下载客户端 JAR', jarVersion)
    await downloadFromMirrors(candidateUrls(info.url, { source }), clientJar, {
      ...netOptions(source),
      sha1: info.sha1, size: info.size, signal: job.signal,
      verify: getSettings().verify !== false, retries: getSettings().retries || 0,
      onProgress: ({ received, total }) => {
        const totalBytes = Number(total) || 0
        if (totalBytes > 0) {
          progressIn(job, from, libFrom, received / totalBytes, `客户端 JAR · ${formatBytes(received)} / ${formatBytes(totalBytes)}`)
        }
        job.bytes(received, totalBytes)
      }
    })
  }

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
  // 只记录版本文件已就绪；installing 留到整个任务结束（runJob）再清，
  // 否则整合包还在下载模组时实例就提前出现在侧栏了。
  updateInstance(instId, { versionId, jarVersion })
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
    ...netOptions(source),
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
  // 缓存只按大小判断会把「镜像错误页 / 被截断 / 被安全软件替换」的坏 jar 一直复用，
  // 于是每次安装都稳定失败。这里先校验 ZIP 魔数，坏了就删掉重下。
  let cachedInstaller = false
  if (fs.existsSync(installerFile)) {
    const stat = await fsp.stat(installerFile).catch(() => null)
    cachedInstaller = !!stat && stat.size >= 1024 && looksLikeZip(installerFile)
    if (!cachedInstaller) await fsp.rm(installerFile, { force: true }).catch(() => {})
  }
  if (!cachedInstaller) {
    job.log('下载官方安装器：' + info.filename)
    const urls = source === 'official'
      ? [info.url]
      : [...new Set([info.mirrorUrl, info.url].filter(Boolean))]
    await downloadFromMirrors(urls, installerFile, {
      ...netOptions(source),
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
  // 优先使用最接近要求的 Java（1.20.1 要求 17 就用 17）。旧实现 preferHighest
  // 会挑到官方启动器附带的 Java 25：Forge 1.20.1 安装器/游戏都不支持 25，
  // 而且安装器进程和后续启动会给出完全无关的报错。
  const java = await pickJava({ required, preferred: inst.javaPath })
  if (!java) throw new Error(`安装 ${loader} 需要至少 64 位 Java ${required}，但没有找到。请先在“Java 运行时”里下载或指定。`)
  job.log(`使用 Java ${java.version || java.major}（${java.path}）运行安装器`)

  // 预取 Mojang mappings 并给安装器打补丁；失败不阻断安装，安装器会走原流程。
  let runFile = installerFile
  let patchedFile = ''
  try {
    const patched = await prepareInstallerMappings(job, installerFile, root, meta, { source })
    if (patched) { runFile = patched; patchedFile = patched }
  } catch (e) {
    if (job.signal.aborted) throw e
    job.log('映射表预取失败，继续使用原始安装器：' + e.message, 'warn')
  }

  const started = Date.now()
  try {
    await runInstaller(job, java.path, runFile, root)
  } finally {
    // 任务专属的 patched jar 用完即删，缓存目录只留官方安装器本体。
    if (patchedFile) await fsp.rm(patchedFile, { force: true }).catch(() => {})
  }
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

async function installInstanceCore(job, instId, options = {}) {
  const inst = findInstance(instId)
  if (!inst) throw new Error('实例不存在')
  const root = inst.root ? path.resolve(inst.root) : launcherRoot()
  return withRootInstallLock(root, job, () => installInstanceCoreUnlocked(job, instId, options))
}

async function installInstanceCoreUnlocked(job, instId, { from = 0, to = 100, source } = {}) {
  const inst = findInstance(instId)
  if (!inst) throw new Error('实例不存在')
  const root = inst.root ? path.resolve(inst.root) : launcherRoot()
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
  // 这里不写 installing：修复已有实例时它不是「新安装」，写 true 会让实例
  // 从侧栏消失。新安装的 installing 由 createInstance 负责。
  updateInstance(instId, {
    versionId,
    loader,
    loaderVersion,
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
  job.createdInstanceId = inst.id
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
        ...netOptions(),
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
          // 下载中心需要 received/total 才能显示真实字节进度；与其它阶段共用同一字段。
          job.bytes(doneBytes, total)
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
  // 修复的是已有实例，不要置 installing：那会让它在修复期间从侧栏消失。
  const job = new InstallJob({ type: 'repair', instanceId, name: inst.name, mc: inst.mc, loader: inst.loader, loaderVersion: inst.loaderVersion })
  runJob(job, async () => {
    job.log('开始检查并修复文件')
    await installVersionFiles(job, instanceId, inst.baseDir || inst.root || launcherRoot(), inst.versionId, {
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

function packKindLabel(kind) {
  if (kind === 'modrinth') return 'Modrinth'
  if (kind === 'curseforge') return 'CurseForge'
  if (kind === 'toolbox') return 'MC Toolbox'
  return '未知'
}

function parsePackJson(text, name) {
  // Windows 记事本/部分打包工具会写入 UTF-8 BOM，JSON.parse 会直接失败。
  try {
    const value = JSON.parse(String(text || '').replace(/^\uFEFF/, ''))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('内容不是对象')
    return value
  } catch {
    throw new Error(`${name} 无法解析，整合包可能已损坏`)
  }
}

export async function readPackMeta(file) {
  const source = String(file || '')
  if (!source) throw new Error('缺少整合包文件路径')
  if (!fs.existsSync(source)) throw new Error('整合包文件不存在：' + source)
  if (!looksLikeZip(source)) throw new Error('整合包不是有效的 ZIP 文件，可能已损坏')
  let entries = {}
  const stats = {}
  try { entries = await readJarEntries(source, ['modrinth.index.json', 'manifest.json'], { maxBytes: 24 * 1024 * 1024, stats }) } catch {}
  if (entries['modrinth.index.json']) {
    const index = parsePackJson(entries['modrinth.index.json'].toString('utf8'), 'modrinth.index.json')
    // 清单来自不可信压缩包：files 必须是数组，否则后面会抛出原生 TypeError。
    if (index.files !== undefined && !Array.isArray(index.files)) {
      throw new Error('modrinth.index.json 的 files 字段格式无效')
    }
    const deps = index.dependencies || {}
    const loader = loaderFromDependencies(deps)
    return {
      kind: 'modrinth',
      index,
      name: index.name || path.basename(source, path.extname(source)),
      mc: String(deps.minecraft || ''),
      ...loader
    }
  }
  if (entries['manifest.json']) {
    const manifest = parsePackJson(entries['manifest.json'].toString('utf8'), 'manifest.json')
    if (manifest.manifestType === 'mc-toolbox') {
      // MC Toolbox 导出的通用 ZIP：用 manifest.minecraft / manifest.files 还原
      // 一份与 mrpack 等价的 index，后续下载 / 覆盖文件流程可以直接复用。
      const minecraft = manifest.minecraft && typeof manifest.minecraft === 'object' ? manifest.minecraft : {}
      const runtime = loaderFromCurseForge({
        minecraft: { ...minecraft, version: String(minecraft.version || '') }
      })
      const files = Array.isArray(manifest.files) ? manifest.files : []
      const dependencies = { minecraft: String(runtime.mc || '') }
      if (runtime.loader !== 'vanilla' && runtime.loaderVersion) {
        const dependencyKey = runtime.loader === 'fabric'
          ? 'fabric-loader'
          : runtime.loader === 'quilt' ? 'quilt-loader' : runtime.loader
        dependencies[dependencyKey] = runtime.loaderVersion
      }
      const index = {
        formatVersion: Number(manifest.formatVersion) || 1,
        game: 'minecraft',
        versionId: String(manifest.versionId || runtime.mc || ''),
        name: String(manifest.name || ''),
        summary: String(manifest.summary || ''),
        files,
        dependencies
      }
      return {
        kind: 'toolbox',
        manifest,
        index,
        name: manifest.name || path.basename(file, path.extname(file)),
        mc: String(runtime.mc || ''),
        loader: runtime.loader,
        loaderVersion: runtime.loaderVersion,
        overrides: String(manifest.overrides || 'overrides') || 'overrides'
      }
    }
    if (manifest.manifestType !== 'minecraftModpack') {
      throw new Error('不是受支持的整合包：manifest.json 的类型不是 minecraftModpack / mc-toolbox')
    }
    const runtime = loaderFromCurseForge(manifest)
    return {
      kind: 'curseforge',
      manifest,
      name: manifest.name || path.basename(file, path.extname(file)),
      // CurseForge 允许自定义覆盖目录名，不读这个字段会导致配置/资源包不生效。
      overrides: String(manifest.overrides || 'overrides') || 'overrides',
      ...runtime
    }
  }
  if (!stats.zip) throw new Error('无法读取整合包目录：文件可能未下载完整或已损坏')
  throw new Error('无法识别整合包：缺少 modrinth.index.json 或 manifest.json')
}

export async function copyPackOverrides(tempDir, gameDir, kind, job, { overrides = 'overrides' } = {}) {
  const metadata = new Set(['manifest.json', 'modlist.html', 'modrinth.index.json'])
  // 客户端实例只解压 overrides / client-overrides；server-overrides 属于服务端，
  // 装进客户端会让服务端专用模组/配置污染实例。
  const dirs = [...new Set(['overrides', 'client-overrides', normalizeOverridesDir(overrides)].filter(Boolean))]
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
    const full = path.resolve(tempDir, dir)
    if (!insideDir(tempDir, full)) continue
    if (fs.existsSync(full)) {
      foundOverride = true
      await copyEntry(full, gameDir)
    }
  }
  // CurseForge 有时把内容直接放在压缩包根目录；Modrinth / mc-toolbox 的根目录
  // 只有 README、图标等杂项，不能复制进实例。
  if (kind !== 'curseforge' || foundOverride) return copied
  for (const name of await fsp.readdir(tempDir)) {
    if (dirs.includes(name) || metadata.has(name)) continue
    await copyEntry(path.join(tempDir, name), path.join(gameDir, name))
  }
  return copied
}

/** 清单里的 overrides 目录名来自压缩包，只接受安全的相对子目录。 */
function normalizeOverridesDir(name) {
  const raw = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (!raw) return 'overrides'
  const parts = raw.split('/').filter(Boolean)
  if (!parts.length || parts.some((part) => part === '..' || part === '.' || /:/.test(part))) return 'overrides'
  return parts.join('/')
}

async function downloadModrinthPackFiles(job, index, gameDir, { from, to, phase = '下载整合包文件', noun = '整合包文件' } = {}) {
  const files = (index.files || []).filter((item) => item?.env?.client !== 'unsupported')
  job.phaseLabel(phase, `${files.length} 个文件`)
  if (!files.length) {
    job.log(`${noun}清单为空，无需下载`)
    return 0
  }
  const total = files.reduce((sum, item) => sum + (Number(item.fileSize) || 0), 0)
  let done = 0
  let bytes = 0
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
    // fetchToFile 不认 sha512，这里下载完自己再算一次，sha1 也走同一套逻辑，
    // 保证任何算法下都以哈希为准。
    const targetTemp = target
    let lastError = null
    for (const url of urls) {
      // 同一地址最多试两次：第一次内容不符（旧缓存/覆盖文件）时删掉再下一次。
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          // 这里不传 size：清单里的 fileSize 只用来显示进度。真实校验交给
          // 下面的 sha1/sha512，否则清单大小与 CDN 文件差几个字节会误报失败。
          await fetchToFile(url, targetTemp, {
            // fileSize 只用于「要不要分段」和显示进度，不参与长度校验：
            // 真实一致性由下面的 sha1 / sha512 决定。
            expectedSize: Number(item.fileSize) || 0,
            threads: Math.max(1, Math.min(16, Number(getSettings().threads) || 1)),
            signal: job.signal,
            verify: false,
            retries: getSettings().retries || 0,
            onProgress: ({ received }) => {
              const delta = Math.max(0, received - last)
              last = received
              bytes += delta
              if (total) progressIn(job, from, to, bytes / total, `${noun} ${done + 1}/${files.length} · ${path.basename(rel)}`)
              job.bytes(bytes, total)
            }
          })
          const digest = crypto.createHash(algorithm)
          for await (const chunk of fs.createReadStream(targetTemp)) digest.update(chunk)
          if (digest.digest('hex').toLowerCase() !== String(hash).toLowerCase()) {
            // 删掉坏文件（可能是覆盖文件或旧缓存），同一地址再下一次；
            // 单地址整合包不会因此一次就判死。
            await fsp.rm(targetTemp, { force: true }).catch(() => {})
            throw new Error('哈希校验失败')
          }
          lastError = null
          break
        } catch (e) {
          if (job.signal.aborted) throw e
          lastError = e
          // 只有"文件内容不对"值得在同一地址重试；网络/404 直接换下一个镜像。
          if (!/哈希校验失败/.test(e.message) || attempt >= 2) break
        }
      }
      if (!lastError) break
    }
    if (lastError) throw new Error(`整合包文件 ${rel} 下载失败：${lastError.message}`)
    done++
    if (done % 10 === 0 || done === files.length) job.log(`${noun} ${done}/${files.length}`)
  }, getSettings().concurrency, job.signal)
  job.log(`${noun}下载完成（${files.length} 个）`, 'ok')
  return done
}

/** 把需要手动补齐的文件写进实例目录，重启后任务日志没了也还能查。 */
async function writeMissingFilesList(gameDir, blocked) {
  if (!Array.isArray(blocked) || !blocked.length) return
  const file = path.join(gameDir, '.mc-toolbox-missing-files.txt')
  const lines = [
    '# 作者禁止第三方启动器自动下载的文件；补齐后可以删除本文件。',
    '# 文件名\t目录\t项目/文件编号\t网页地址',
    ...blocked.map((item) => `${item.fileName}\t${item.folder}\t${item.id}${item.url ? `\t${item.url}` : ''}`)
  ]
  await fsp.writeFile(file, lines.join('\n') + '\n', 'utf8').catch(() => {})
}

function logBlockedFiles(job, blocked) {
  job.log(`以下 ${blocked.length} 个文件被作者禁止第三方启动器自动下载，需要手动补齐：`, 'warn')
  for (const item of blocked) {
    job.log(`  ${item.id}  ${item.fileName}${item.url ? `  → ${item.url}` : ''}`, 'warn')
  }
}

async function downloadCurseForgePackFiles(job, meta, paths, { from, to, phase = '补齐 CurseForge 文件', apiKey = '' }) {
  job.phaseLabel(phase, '通过清单文件 ID 下载')
  job.set(from + (to - from) * 0.1, '正在按清单补齐 CurseForge 文件…')
  const manifestFile = path.join(paths.gameDir, 'manifest.json')
  let manifestInstalled = false
  try {
    // hydrateCurseForgeFiles expects the manifest at its root; keep it out of
    // the game directory afterwards so the instance stays clean.
    if (!fs.existsSync(manifestFile)) {
      await fsp.writeFile(manifestFile, JSON.stringify(meta.manifest, null, 2), 'utf8')
      manifestInstalled = true
    }
    const result = await hydrateCurseForgeFiles(paths.gameDir, ({ progress, detail }) => {
      const raw = Number(progress)
      const ratio = Number.isFinite(raw) ? Math.max(0, Math.min(1, (raw - 28) / 15)) : null
      if (ratio !== null) progressIn(job, from, to, ratio, detail || '正在补齐 CurseForge 文件…')
      else job.set(null, detail || '正在补齐 CurseForge 文件…', { indeterminate: true })
    }, job.signal, {
      apiKey: apiKey || store.get('settings', {})?.community?.cfApiKey || ''
    })
    // 只缺光影 / 资源包时安装继续：把清单写进实例目录并在完成文案里点出来。
    if (Array.isArray(result?.blocked) && result.blocked.length) {
      logBlockedFiles(job, result.blocked)
      await writeMissingFilesList(paths.gameDir, result.blocked)
      job.completionNote = `整合包安装完成（缺 ${result.blocked.length} 个光影/资源包，清单见实例目录 .mc-toolbox-missing-files.txt）`
      job.log(`已跳过 ${result.blocked.length} 个无法自动下载的光影/资源包；缺失清单已写入实例目录`, 'warn')
    }
  } catch (e) {
    // 缺 mod 时不能继续装：保留实例与已下载文件，用户补齐后可直接复用，不白下一次。
    if (Array.isArray(e?.blocked) && e.blocked.length) {
      job.keepOnFailure = true
      logBlockedFiles(job, e.blocked)
      await writeMissingFilesList(paths.gameDir, e.blocked)
      job.log('已保留实例与已下载文件；补齐上面这些文件后可重新安装，不会重复下载', 'warn')
    }
    throw e
  } finally {
    if (manifestInstalled) await fsp.rm(manifestFile, { force: true }).catch(() => {})
  }
}

async function extractPackOverrides(job, file, tempRoot, paths, meta, { from, to, phase = '解压整合包覆盖文件' }) {
  job.phaseLabel(phase, '正在解压 overrides')
  job.set(from, `${phase}…`, { indeterminate: false })
  await extractZip(file, tempRoot, (ratio) => progressIn(job, from, to, ratio, phase), job.signal)
  const copied = await copyPackOverrides(tempRoot, paths.gameDir, meta.kind, job, { overrides: meta.overrides })
  job.log(`覆盖文件已复制（${copied} 个）`)
}

/**
 * 整合包安装公共流程：识别清单 → 创建实例 → 安装加载器 → 下载清单文件 /
 * 解压覆盖文件 → 写入完成标记。startPackInstall 与 startOnlinePackInstall
 * 都走这里，只是准备文件的阶段和进度区间不同。
 */
async function runPackInstall(job, options = {}) {
  const settings = getSettings()
  const {
    prepare,
    file: initialFile = '',
    name = '',
    memory = {},
    minMemory,
    javaPath = '',
    group = '',
    tempRoot = path.join(launcherRoot(), 'cache', 'packs', job.id),
    source = settings.source,
    cfApiKey = '',
    ranges = {},
    order = 'extract-first',
    labels = {},
    finalPhase = '',
    lockInstallPhase = false
  } = options

  const installRange = Array.isArray(ranges.install) ? ranges.install : [0, 62]
  const downloadRange = Array.isArray(ranges.download) ? ranges.download : [72, 96]
  const extractRange = Array.isArray(ranges.extract) ? ranges.extract : [62, 72]
  const finishProgress = Number(ranges.finish) || 98

  let file = String(initialFile || '')
  let meta = null
  if (typeof prepare === 'function') {
    const prepared = await prepare(job)
    file = String(prepared?.file || file)
    meta = prepared?.meta || null
  }
  if (!file) throw new Error('缺少整合包文件')
  if (!fs.existsSync(file)) throw new Error('整合包文件不存在：' + file)
  if (!meta) {
    job.log('读取整合包：' + path.basename(file))
    meta = await readPackMeta(file)
  }
  job.log(`识别为 ${packKindLabel(meta.kind)} 整合包 · ${meta.name}`)
  if (!meta.mc) throw new Error('整合包没有声明 Minecraft 版本')
  const instName = String(name || meta.name || '整合包').trim()
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
  job.createdInstanceId = inst.id
  job.log(`已创建实例：${inst.name}（${meta.mc} · ${meta.loader}${meta.loaderVersion ? ' ' + meta.loaderVersion : ''}）`)
  try {
    await fsp.mkdir(tempRoot, { recursive: true })
  } catch (e) {
    throw new Error('无法创建整合包临时目录：' + e.message)
  }

  // 安装加载器与基础版本文件。
  const installPhase = labels.install || ''
  if (installPhase) job.phaseLabel(installPhase, `${meta.mc} · ${meta.loader}`)
  if (lockInstallPhase) job.lockedPhase = installPhase || '安装加载器'
  try {
    await installInstanceCore(job, inst.id, { from: installRange[0], to: installRange[1], source: source || settings.source })
  } finally {
    if (lockInstallPhase) job.lockedPhase = ''
  }
  job.signal.throwIfAborted()
  if (installPhase) job.phaseLabel(installPhase, '加载器与基础文件已就绪')
  progressIn(job, installRange[1], installRange[1], 1, '加载器安装完成')

  const current = findInstance(inst.id)
  if (!current) throw new Error('实例已不存在，整合包安装中止')
  const paths = instancePaths(current)
  await fsp.mkdir(paths.gameDir, { recursive: true })

  const downloadContents = async () => {
    if (meta.kind === 'modrinth' || meta.kind === 'toolbox') {
      await downloadModrinthPackFiles(job, meta.index, paths.gameDir, {
        from: downloadRange[0],
        to: downloadRange[1],
        phase: labels.download || '下载整合包文件',
        noun: labels.downloadNoun || '整合包文件'
      })
    } else {
      await downloadCurseForgePackFiles(job, meta, paths, {
        from: downloadRange[0],
        to: downloadRange[1],
        phase: labels.download || '补齐 CurseForge 文件',
        apiKey: cfApiKey
      })
    }
  }
  const extractOverrides = async () => {
    await extractPackOverrides(job, file, tempRoot, paths, meta, {
      from: extractRange[0],
      to: extractRange[1],
      phase: labels.extract || '解压整合包覆盖文件'
    })
  }

  if (order === 'download-first') {
    await downloadContents()
    job.signal.throwIfAborted()
    await extractOverrides()
  } else {
    await extractOverrides()
    job.signal.throwIfAborted()
    await downloadContents()
  }

  await fsp.writeFile(path.join(paths.gameDir, '.mc-toolbox-pack.json'), JSON.stringify({
    name: instName,
    kind: meta.kind,
    mc: meta.mc,
    loader: meta.loader,
    loaderVersion: meta.loaderVersion,
    installedAt: Date.now()
  }, null, 2), 'utf8')
  job.set(finishProgress, '整合包安装完成，正在收尾…')
  if (finalPhase) job.phaseLabel(finalPhase, '整合包安装完成')
  job.log('整合包内容安装完成', 'ok')
  updateInstance(inst.id, { installing: false, installedAt: Date.now() })
  // 从这里开始只剩清理缓存：之后的取消/失败都不能再删这个已经装好的实例。
  job.committed = true
  job.log('完成的实例：' + inst.name, 'ok')
}

export function startPackInstall({ source, name = '', memory = {}, minMemory, javaPath = '', group = '', uploaded = false, packKey = '' }) {
  if (!source) throw new Error('缺少整合包路径')
  const importKey = packImportKey(source, packKey)
  const active = findActivePackJob(activeJobs(), importKey)
  if (active) {
    throw new Error(`该整合包正在安装中${active.name ? '：' + active.name : ''}，请等待完成后再试；进度可在「下载中心」查看。`)
  }
  const job = new InstallJob({ type: 'pack', name: name || path.basename(source), mc: '', loader: 'vanilla' })
  job.packKey = importKey
  const tempRoot = path.join(launcherRoot(), 'cache', 'packs', job.id)
  job.cleanup = async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
    if (uploaded) await fsp.rm(path.dirname(source), { recursive: true, force: true }).catch(() => {})
  }
  runJob(job, async () => {
    await runPackInstall(job, {
      file: source,
      name,
      memory,
      minMemory,
      javaPath,
      group,
      tempRoot,
      source: getSettings().source,
      // 先按清单下载、再解压 overrides：覆盖文件必须最后落地，否则清单里与
      // overrides 同路径的文件会被判定「哈希校验失败」，安装直接失败。
      ranges: { install: [0, 62], download: [62, 90], extract: [90, 96], finish: 98 },
      order: 'download-first'
    })
  })
  return { job: job.public() }
}

/**
 * 在线整合包安装：先解析并下载到 <launcherRoot>/cache/packs/<jobId>/，
 * 校验后再交给 runPackInstall 走本地整合包相同的安装流程。
 *
 * 固定阶段：下载整合包 → 校验整合包 → 解析清单 → 安装加载器 →
 * 下载模组 → 解压覆盖文件 → 完成。
 * 下载阶段进度来自真实字节数，映射到 0–28%。
 */
export function startOnlinePackInstall({
  source,
  projectId,
  versionId = '',
  name = '',
  memory = {},
  minMemory,
  javaPath = '',
  group = '',
  openWhenDone = false,
  apiKey = '',
  fetcher = null
} = {}) {
  const packSource = String(source || '').trim().toLowerCase()
  if (packSource !== 'modrinth' && packSource !== 'curseforge') {
    throw new Error('不支持的整合包来源：' + (source || '（空），请选择 Modrinth 或 CurseForge'))
  }
  const project = String(projectId || '').trim()
  if (!project) throw new Error('缺少整合包项目 ID')
  const settings = getSettings()
  const resolvedApiKey = String(apiKey || store.get('settings', {})?.community?.cfApiKey || '').trim()
  if (packSource === 'curseforge' && !resolvedApiKey) {
    const error = new Error('未配置 CurseForge API Key。请在「设置 → 社区资源」填写 Eternal API Key，或改用 Modrinth 搜索整合包。')
    error.code = 'CURSEFORGE_API_KEY'
    throw error
  }

  const job = new InstallJob({ type: 'pack', name: name || '在线整合包', mc: '', loader: 'vanilla', openWhenDone })
  job.openWhenDone = openWhenDone === true
  job.phaseLabel('下载整合包', '等待开始…')
  job.set(null, '等待开始…', { indeterminate: true })
  const cacheRoot = path.join(launcherRoot(), 'cache', 'packs', job.id)
  job.cleanup = async () => {
    await fsp.rm(cacheRoot, { recursive: true, force: true }).catch(() => {})
  }
  const fetchImpl = typeof fetcher === 'function' ? fetcher : undefined

  runJob(job, async () => {
    try {
      await runPackInstall(job, {
        name,
        memory,
        minMemory,
        javaPath,
        group,
        // 下载的整合包本体留在 <jobId>/<filename>，解压到独立子目录，避免把整包文件复制进游戏目录。
        tempRoot: path.join(cacheRoot, 'unpacked'),
        source: settings.source,
        cfApiKey: resolvedApiKey,
        ranges: { install: [28, 76], download: [76, 92], extract: [92, 98], finish: 98 },
        order: 'download-first',
        labels: {
          install: '安装加载器',
          download: '下载模组',
          downloadNoun: '模组',
          extract: '解压覆盖文件'
        },
        finalPhase: '完成',
        lockInstallPhase: true,
        prepare: async (task) => {
          task.phaseLabel('下载整合包', '正在解析整合包信息…')
          task.set(null, '正在获取整合包下载信息…', { indeterminate: true })
          const pack = await resolveOnlinePack({
            source: packSource,
            projectId: project,
            versionId,
            apiKey: resolvedApiKey,
            fetcher: fetchImpl,
            signal: task.signal
          })
          task.signal.throwIfAborted()
          const filename = safePackFilename(pack.filename)
          task.log(`已解析在线整合包：${pack.project.title || pack.project.slug || project} · ${pack.version.name || pack.version.number || versionId || ''}`)
          task.log('下载地址：' + pack.url)
          try {
            await fsp.mkdir(cacheRoot, { recursive: true })
          } catch (e) {
            throw new Error('无法创建整合包缓存目录：' + e.message)
          }
          const file = path.join(cacheRoot, filename)
          const size = Number(pack.size) || 0
          task.phaseLabel('下载整合包', `${filename}${size ? ' · ' + formatBytes(size) : ''}`)
          task.set(0, '开始下载整合包…')
          await downloadFromMirrors([pack.url], file, {
            threads: Math.max(1, Math.min(16, Number(settings.threads) || 1)),
            size,
            sha1: pack.hashes?.sha1 || '',
            signal: task.signal,
            verify: !!pack.hashes?.sha1,
            retries: settings.retries || 0,
            onProgress: ({ received, total }) => {
              const totalBytes = size || Number(total) || 0
              if (totalBytes > 0) {
                progressIn(task, 0, 28, received / totalBytes, `下载整合包 · ${formatBytes(received)} / ${formatBytes(totalBytes)}`)
              } else {
                task.set(null, `下载整合包 · ${formatBytes(received)}`, { indeterminate: true })
              }
              task.bytes(received, totalBytes)
            }
          })
          const downloadedSize = (await fsp.stat(file)).size
          task.log(`整合包下载完成：${formatBytes(downloadedSize)}`, 'ok')

          task.phaseLabel('校验整合包', '正在校验整合包完整性…')
          task.set(null, pack.hashes?.sha512 ? '正在校验 SHA-512…' : '正在校验文件大小…', { indeterminate: true })
          if (pack.hashes?.sha512) {
            const digest = await sha512File(file, task.signal)
            if (digest.toLowerCase() !== String(pack.hashes.sha512).toLowerCase()) {
              throw new Error('整合包 SHA-512 校验失败，文件可能下载不完整，请重试或更换下载源')
            }
            task.log('SHA-512 校验通过', 'ok')
          } else if (pack.hashes?.sha1) {
            task.log('下载阶段已校验 SHA-1（接口未提供 SHA-512）', 'warn')
          } else {
            if (size > 0 && downloadedSize !== size) throw new Error(`整合包大小校验失败（${downloadedSize} / ${size} 字节）`)
            task.log('整合包未提供哈希值，仅校验文件大小', 'warn')
          }
          task.signal.throwIfAborted()

          task.phaseLabel('解析清单', '正在解析整合包清单…')
          task.set(null, '正在读取整合包清单…', { indeterminate: true })
          let meta
          try {
            meta = await readPackMeta(file)
          } catch (e) {
            throw new Error('解析整合包清单失败：' + (e.message || '文件格式不正确'))
          }
          if (!meta.mc) throw new Error('整合包没有声明 Minecraft 版本')
          task.signal.throwIfAborted()
          task.log(`清单解析完成：${meta.mc} · ${meta.loader}${meta.loaderVersion ? ' ' + meta.loaderVersion : ''}`, 'ok')
          return { file, meta }
        }
      })
    } finally {
      // 在任务进入 done / failed / cancelled 之前完成缓存清理，状态与目录保持一致。
      try { await job.cleanup() } catch {}
    }
  })
  return { job: job.public() }
}

export function readPackSummary(file) {
  return readPackMeta(file)
}
