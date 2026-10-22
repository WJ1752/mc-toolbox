// 导出整合包：把实例游戏目录打包成 Modrinth（.mrpack）或通用（.zip）整合包。
//
// 约定：
//  - 只读取实例 gameDir；所有中间文件都写在 launcherRoot/cache/export/<jobId>，
//    成功、失败、取消都会删除 staging 与半成品，外部实例目录保持只读。
//  - 模组先算 SHA-1 查询 Modrinth，只有 game_versions / loaders 都匹配当前实例
//    的版本才写入清单 files；未匹配或读取失败的模组复制到 overrides/mods。
//  - 进度来自真实字节数、任务步骤或 packDirectory 的回调；无法计算时使用
//    不确定进度（progress = null + indeterminate = true），不伪造百分比。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { httpFetch } from '../http.js'
import { readZipIndex, packDirectory } from '../pack-converter.js'
import { readJarEntries } from '../zip.js'
import { launcherRoot, findInstance, instancePaths } from './state.js'
import { safeName } from './launch-plan.js'

const MODRINTH_VERSION_FILES = 'https://api.modrinth.com/v2/version_files'
const MODRINTH_BATCH = 100
const MODRINTH_TIMEOUT = 15000
const FINISHED = new Set(['done', 'failed', 'cancelled'])
const LOADERS = new Set(['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'])

// 固定复制的目录 / 文件（存在才复制）
const COPY_DIRS = ['config', 'defaultconfigs', 'kubejs', 'resourcepacks', 'shaderpacks']
const COPY_FILES = ['options.txt', 'servers.dat']
// 这些目录即使位于被复制目录内部也要跳过（缓存、日志等）
const SKIP_DIR_NAMES = new Set(['logs', 'crash-reports', 'cache', '.cache', 'backups', '.git', '.mixin.out'])
// 账户令牌 / 启动器内部文件，任何层级都不导出
const INTERNAL_FILE_RE = /^(?:launcher_.*\.(?:json|bin)|usercache\.json|realms_persistence\.json|servers\.dat_old|\.mc-toolbox.*|.*\.token|.*_token\.json)$/i

export const EXPORT_FORMATS = Object.freeze([
  Object.freeze({ id: 'mrpack', label: 'Modrinth 整合包', ext: '.mrpack' }),
  Object.freeze({ id: 'zip', label: '通用整合包', ext: '.zip' })
])

const jobs = new Map()

/* ------------------------------------------------------------------ */
/* 任务对象                                                            */
/* ------------------------------------------------------------------ */

class ExportJob {
  constructor(opts = {}) {
    this.id = opts.id || crypto.randomUUID()
    this.type = 'export'
    this.status = 'queued'
    this.phase = '准备'
    this.detail = '等待开始…'
    this.progress = 0
    this.indeterminate = false
    // 与 InstallJob / 社区任务保持一致：createdAt 是排队时刻，startedAt 真正开跑时写。
    this.createdAt = Date.now()
    this.startedAt = 0
    this.finishedAt = 0
    this.updatedAt = this.createdAt
    this.error = ''
    this.name = opts.name || ''
    this.instanceId = opts.instanceId || ''
    this.instanceName = opts.instanceName || ''
    this.format = opts.format || 'mrpack'
    this.mc = opts.mc || ''
    this.loader = opts.loader || 'vanilla'
    this.loaderVersion = opts.loaderVersion || ''
    this.output = opts.output || ''
    this.file = ''
    this.size = 0
    this.logs = []
    this.logSeq = 0
    this.controller = new AbortController()
    this.cancelRequested = false
    this.stagingRoot = ''
    this.cleanup = null
  }

  get signal() { return this.controller.signal }

  log(text, kind = '') {
    const line = { seq: ++this.logSeq, t: nowTime(), text: String(text ?? ''), kind }
    this.logs.push(line)
    if (this.logs.length > 1500) this.logs.splice(0, this.logs.length - 1500)
    return line
  }

  set(progress, detail, { indeterminate = false } = {}) {
    if (this.controller.signal.aborted) return
    if (indeterminate || progress === null || progress === undefined) {
      this.indeterminate = true
      this.progress = null
    } else {
      this.indeterminate = false
      this.progress = clamp(progress)
    }
    if (detail !== undefined) this.detail = detail
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
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      updatedAt: this.updatedAt,
      error: this.error,
      name: this.name,
      instanceId: this.instanceId,
      instanceName: this.instanceName,
      format: this.format,
      output: this.output,
      file: this.file,
      size: this.size,
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
  job.updatedAt = job.finishedAt
  job.status = status
  job.error = error || ''
  // 终态不再保留「不确定进度」动画；已知进度保留，未知按 0 收尾。
  job.indeterminate = false
  if (job.progress === null || job.progress === undefined) job.progress = status === 'done' ? 100 : 0
  job.controller = new AbortController()
}

function runExportJob(job, task) {
  jobs.set(job.id, job)
  const old = [...jobs.values()].filter((item) => FINISHED.has(item.status)).sort((a, b) => a.finishedAt - b.finishedAt)
  while (jobs.size > 50 && old.length) jobs.delete(old.shift().id)
  setImmediate(async () => {
    if (job.cancelRequested) {
      finishJob(job, 'cancelled')
      return
    }
    job.status = 'running'
    // 真正开始执行才写 startedAt；排队时间用 createdAt 单独展示。
    job.startedAt = Date.now()
    job.updatedAt = job.startedAt
    job.log('开始导出整合包')
    try {
      await task(job)
      if (job.controller.signal.aborted || job.cancelRequested) {
        finishJob(job, 'cancelled')
        job.log('任务已取消', 'warn')
        return
      }
      job.progress = 100
      job.indeterminate = false
      job.phase = '完成'
      if (!job.detail || job.detail === '等待开始…') job.detail = '导出完成'
      job.log(job.detail, 'ok')
      finishJob(job, 'done')
    } catch (e) {
      if (job.controller.signal.aborted || job.cancelRequested) {
        finishJob(job, 'cancelled')
        job.log('任务已取消', 'warn')
      } else {
        const message = (e && e.message) || '未知错误'
        finishJob(job, 'failed', message)
        job.log('导出失败：' + message, 'err')
      }
    } finally {
      try { await job.cleanup?.() } catch {}
    }
  })
  return job
}

/* ------------------------------------------------------------------ */
/* 导出任务 API                                                        */
/* ------------------------------------------------------------------ */

/** 默认导出目录：<launcherRoot>/exports */
export function defaultExportDir() {
  return path.join(launcherRoot(), 'exports')
}

/** 最近的导出任务（按开始时间倒序，不附带日志）。 */
export function listExportJobs() {
  return [...jobs.values()]
    .sort((a, b) => (b.startedAt || b.createdAt) - (a.startedAt || a.createdAt))
    .map((job) => job.public({ includeLogs: false }))
}

/** 读取导出任务；after 之后的新日志作为增量返回。 */
export function getExportJob(id, after = 0) {
  const job = jobs.get(id)
  if (!job) return null
  return {
    ...job.public({ includeLogs: false }),
    logs: job.logs.filter((line) => line.seq > Number(after || 0))
  }
}

/** 取消导出任务；任务已完成 / 正在取消 / 不存在时返回 false。 */
export function cancelExport(id) {
  const job = jobs.get(id)
  if (!job || FINISHED.has(job.status) || job.status === 'cancelling') return false
  job.cancelRequested = true
  job.status = 'cancelling'
  job.detail = '正在取消并清理…'
  job.log('收到取消请求，正在停止导出并清理临时文件…', 'warn')
  try { job.controller.abort(new Error('已取消')) } catch {}
  return true
}

/**
 * 新建导出任务（异步执行，立即返回任务快照）。
 * @param {string} instanceId
 * @param {{format?:string,includeSaves?:boolean,includeScreenshots?:boolean,outputDir?:string,name?:string}} [options]
 */
export function startPackExport(instanceId, options = {}) {
  const inst = findInstance(String(instanceId || ''))
  if (!inst) throw new Error('实例不存在')
  const format = normalizeFormat(options.format)
  if (!inst.mc) {
    const error = new Error('无法导出：实例缺少 Minecraft 版本，请先在实例设置中填写 MC 版本')
    error.code = 'MC_VERSION_REQUIRED'
    throw error
  }
  const paths = instancePaths(inst)
  if (!fs.existsSync(paths.gameDir)) throw new Error('实例游戏目录不存在：' + paths.gameDir)
  const outputDir = resolveOutputDir(options.outputDir)
  // 外部实例的游戏目录通常整个 .minecraft；默认导出目录正好落在里面时
  // （启动器根就是它）仍然允许：只有显式指定到游戏目录里才拒绝。
  if (inst.external && isInsideOrSame(outputDir, paths.baseDir) && (options.outputDir || isInsideOrSame(outputDir, paths.gameDir))) {
    throw new Error('外部实例目录是只读的，导出目录不能放在游戏目录内：' + paths.baseDir)
  }
  const job = new ExportJob({
    name: String(options.name || '').trim() || inst.name || '整合包',
    instanceId: inst.id,
    instanceName: inst.name,
    format,
    output: outputDir,
    mc: inst.mc,
    loader: inst.loader,
    loaderVersion: inst.loaderVersion
  })
  // 启动器根与实例游戏目录重合时（外部实例导入的就是启动器根），固定放在
  // <root>/cache 的临时目录会被判成「位于游戏目录内」，改用系统临时目录。
  let stagingRoot = path.join(launcherRoot(), 'cache', 'export', job.id)
  if (isInsideOrSame(stagingRoot, paths.gameDir) || isInsideOrSame(paths.gameDir, stagingRoot)) {
    stagingRoot = path.join(os.tmpdir(), 'mc-toolbox-export', job.id)
  }
  job.stagingRoot = stagingRoot
  job.cleanup = async () => {
    await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
  }
  runExportJob(job, async () => {
    job.log(`导出「${inst.name}」 · Minecraft ${inst.mc}${inst.loader !== 'vanilla' ? ` · ${inst.loader}${inst.loaderVersion ? ' ' + inst.loaderVersion : ''}` : ''}`)
    const result = await exportInstanceToPack({
      name: job.name,
      mc: inst.mc,
      loader: inst.loader,
      loaderVersion: inst.loaderVersion,
      gameDir: paths.gameDir,
      outputDir,
      format,
      includeSaves: options.includeSaves === true,
      includeScreenshots: options.includeScreenshots === true,
      stagingRoot,
      jobId: job.id,
      modrinthFetcher: options.modrinthFetcher,
      now: options.now,
      signal: job.signal,
      log: (text, kind) => job.log(text, kind),
      onProgress: ({ phase, detail, progress, indeterminate }) => {
        if (phase) job.phase = phase
        job.set(progress, detail, { indeterminate: Boolean(indeterminate) || progress === null || progress === undefined })
      }
    })
    job.file = result.file
    job.size = result.bytes
    job.output = outputDir
    job.phase = '完成'
    job.detail = `导出完成 · ${result.files} 个模组 · ${result.overrides} 个覆盖文件`
    job.log(`已生成：${result.file}（${formatBytes(result.bytes)}）`, 'ok')
  })
  return { job: job.public() }
}

/* ------------------------------------------------------------------ */
/* 直接导出（可注入参数，供测试 / 其他模块调用）                        */
/* ------------------------------------------------------------------ */

/**
 * 把一个游戏目录导出为整合包。
 * @param {{
 *   name?:string, mc:string, loader?:string, loaderVersion?:string,
 *   gameDir:string, outputDir?:string, format?:string,
 *   includeSaves?:boolean, includeScreenshots?:boolean,
 *   stagingRoot?:string, jobId?:string,
 *   onProgress?:Function, signal?:AbortSignal, log?:Function,
 *   modrinthFetcher?:Function, now?:number|Date|Function
 * }} options
 * @returns {Promise<{file:string, format:string, bytes:number, files:number, overrides:number}>}
 */
export async function exportInstanceToPack(options = {}) {
  const signal = options.signal
  const log = typeof options.log === 'function' ? options.log : () => {}
  const format = normalizeFormat(options.format)
  const name = String(options.name || '').trim() || '整合包'
  const mc = String(options.mc || '').trim()
  if (!mc) {
    const error = new Error('无法导出：缺少 Minecraft 版本')
    error.code = 'MC_VERSION_REQUIRED'
    throw error
  }
  const rawLoader = String(options.loader || 'vanilla').trim().toLowerCase()
  const loader = LOADERS.has(rawLoader) ? rawLoader : 'vanilla'
  if (rawLoader && rawLoader !== loader) log(`未知加载器「${options.loader}」，按原版导出`, 'warn')
  const loaderVersion = String(options.loaderVersion || '').trim()
  if (loader !== 'vanilla' && !loaderVersion) log('实例缺少加载器版本，导出包只声明 Minecraft 版本', 'warn')

  const gameDir = path.resolve(String(options.gameDir || ''))
  const outputDir = resolveOutputDir(options.outputDir)
  const stagingRoot = path.resolve(options.stagingRoot || path.join(launcherRoot(), 'cache', 'export', options.jobId || crypto.randomUUID()))
  if (isInsideOrSame(stagingRoot, gameDir) || isInsideOrSame(gameDir, stagingRoot)) {
    throw new Error('导出临时目录不能位于实例游戏目录内：' + stagingRoot)
  }
  const includeSaves = options.includeSaves === true
  const includeScreenshots = options.includeScreenshots === true
  const date = resolveDate(options.now)
  const stamp = formatTimestamp(date)
  const formatInfo = EXPORT_FORMATS.find((item) => item.id === format)
  const report = makeReporter(options.onProgress)
  const fetcher = typeof options.modrinthFetcher === 'function' ? options.modrinthFetcher : httpFetch

  let gameStat
  try { gameStat = await fsp.stat(gameDir) } catch {
    throw new Error('实例游戏目录不存在或无法访问：' + gameDir)
  }
  if (!gameStat.isDirectory()) throw new Error('实例游戏目录不是文件夹：' + gameDir)

  await ensureOutputDir(outputDir)
  const base = buildOutputBase(name, mc, loader, stamp)
  const outputFile = uniqueOutputPath(outputDir, base, formatInfo.ext)
  const tempFile = `${outputFile}.part-${crypto.randomBytes(4).toString('hex')}`
  let published = false
  let stagingReady = false
  let overrideCount = 0

  try {
    signal?.throwIfAborted()
    report('准备', 0, '正在扫描实例文件…', false)
    await prepareStagingRoot(stagingRoot)
    stagingReady = true
    const overridesDir = path.join(stagingRoot, 'overrides')
    await fsp.mkdir(overridesDir, { recursive: true })

    // 1) 模组：计算哈希并尝试匹配 Modrinth（0 - 18%）
    const scan = await scanMods(gameDir)
    const hashResult = await hashMods(scan.matchable, { signal, log, report })
    const matchResult = await matchMods(hashResult.hashed, {
      mc,
      loader,
      signal,
      log,
      report,
      fetcher
    })

    // 2) 其余内容复制到 overrides（30 - 55%）
    const modOverrides = [
      ...scan.overrides,
      ...hashResult.failed,
      ...matchResult.unmatched
    ].map((item) => ({
      name: item.name,
      full: item.full,
      directory: item.directory === true,
      link: item.link === true
    })).sort((a, b) => a.name.localeCompare(b.name))

    const copyTasks = []
    if (modOverrides.length) {
      copyTasks.push({
        label: `mods（${modOverrides.length} 项）`,
        run: async (ctx) => {
          const target = path.join(overridesDir, 'mods')
          for (const item of modOverrides) {
            signal?.throwIfAborted()
            if (item.link) {
              ctx.onSkipped(`mods/${item.name}`, '符号链接')
              continue
            }
            if (item.directory) {
              overrideCount += await copyTree(item.full, path.join(target, item.name), ctx, `mods/${item.name}`)
            } else {
              overrideCount += await copyFileTo(item.full, path.join(target, item.name), ctx, `mods/${item.name}`)
            }
          }
        }
      })
    }
    for (const dir of COPY_DIRS) {
      const source = path.join(gameDir, dir)
      if (!isDirectory(source)) continue
      copyTasks.push({
        label: dir,
        run: async (ctx) => {
          overrideCount += await copyTree(source, path.join(overridesDir, dir), ctx, dir)
        }
      })
    }
    const rootFiles = COPY_FILES.filter((file) => isFile(path.join(gameDir, file)))
    if (rootFiles.length) {
      copyTasks.push({
        label: '根目录配置',
        run: async (ctx) => {
          for (const file of rootFiles) {
            overrideCount += await copyFileTo(path.join(gameDir, file), path.join(overridesDir, file), ctx, file)
          }
        }
      })
    }
    if (includeSaves && isDirectory(path.join(gameDir, 'saves'))) {
      copyTasks.push({
        label: 'saves',
        run: async (ctx) => {
          overrideCount += await copyTree(path.join(gameDir, 'saves'), path.join(overridesDir, 'saves'), ctx, 'saves')
        }
      })
    }
    if (includeScreenshots && isDirectory(path.join(gameDir, 'screenshots'))) {
      copyTasks.push({
        label: 'screenshots',
        run: async (ctx) => {
          overrideCount += await copyTree(path.join(gameDir, 'screenshots'), path.join(overridesDir, 'screenshots'), ctx, 'screenshots')
        }
      })
    }

    const skipped = new Set()
    let copyProgress = 30
    const ctx = {
      signal,
      log,
      onCopied: (rel) => report('收集文件', copyProgress, `正在复制 ${rel}`, false),
      onSkipped: (rel, reason) => {
        if (skipped.size >= 20) return
        const key = path.basename(rel)
        if (skipped.has(key)) return
        skipped.add(key)
        log(`已排除${reason}：${rel}`, 'warn')
      }
    }
    if (copyTasks.length) {
      for (let index = 0; index < copyTasks.length; index++) {
        signal?.throwIfAborted()
        copyProgress = 30 + (25 * index) / copyTasks.length
        report('收集文件', copyProgress, `正在收集 ${copyTasks[index].label}…`, false)
        await copyTasks[index].run(ctx)
        copyProgress = 30 + (25 * (index + 1)) / copyTasks.length
        report('收集文件', copyProgress, `已收集 ${copyTasks[index].label}`, false)
      }
    }
    report('收集文件', 55, '实例内容收集完成', false)
    log(`覆盖文件收集完成（${overrideCount} 个）`)
    signal?.throwIfAborted()

    // 3) 写清单
    const metadata = buildMetadata({
      format,
      name,
      mc,
      loader,
      loaderVersion,
      stamp,
      files: matchResult.entries
    })
    const metadataName = format === 'mrpack' ? 'modrinth.index.json' : 'manifest.json'
    await fsp.writeFile(path.join(stagingRoot, metadataName), JSON.stringify(metadata, null, 2), 'utf8')
    log(`已写入清单：${metadataName}（${matchResult.entries.length} 个 Modrinth 文件）`)

    // 4) 打包（55 - 92%）
    report('打包', 55, `正在生成 ${formatInfo.label}…`, false)
    let packed
    try {
      packed = await packDirectory(stagingRoot, tempFile, (ratio, entry) => {
        report('打包', 55 + 37 * Math.max(0, Math.min(1, Number(ratio) || 0)), `正在写入：${entry}`, false)
      }, signal)
    } catch (e) {
      if (signal?.aborted) throw abortError(signal)
      throw new Error(`生成整合包失败：${describeError(e, outputDir)}`)
    }
    if (!packed || !Number.isFinite(packed.files)) throw new Error('生成整合包失败：没有产生任何文件')
    if (packed.files !== overrideCount + 1) {
      throw new Error(`导出校验失败：文件数量不一致（清单 ${overrideCount} 个覆盖文件，压缩包 ${packed.files} 个文件）`)
    }
    signal?.throwIfAborted()

    // 5) 校验清单与 overrides（92 - 100%）
    report('校验', null, '正在校验导出结果…', true)
    await verifyArchive(tempFile, {
      format,
      expectedFiles: matchResult.entries.map((item) => item.path),
      overrideCount
    })
    report('校验', 97, '校验通过，正在保存…', false)
    signal?.throwIfAborted()

    try {
      await fsp.rename(tempFile, outputFile)
    } catch (e) {
      throw new Error(`写入导出文件失败：${describeError(e, outputDir)}`)
    }
    published = true
    const stat = await fsp.stat(outputFile)
    report('完成', 100, '导出完成', false)
    log(`导出完成：${outputFile}`, 'ok')
    return {
      file: outputFile,
      format,
      bytes: stat.size,
      files: matchResult.entries.length,
      overrides: overrideCount
    }
  } finally {
    if (stagingReady) await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
    if (!published) await fsp.rm(tempFile, { force: true }).catch(() => {})
  }
}

/* ------------------------------------------------------------------ */
/* 模组扫描 / 哈希 / Modrinth 匹配                                      */
/* ------------------------------------------------------------------ */

async function scanMods(gameDir) {
  const modsDir = path.join(gameDir, 'mods')
  let stat
  try {
    stat = await fsp.stat(modsDir)
  } catch (e) {
    if (e && e.code === 'ENOENT') return { matchable: [], overrides: [] }
    throw new Error(`无法读取模组目录：${modsDir}（${e.message}）`)
  }
  if (!stat.isDirectory()) throw new Error(`实例的 mods 路径不是文件夹，无法导出：${modsDir}`)
  let entries
  try {
    entries = await fsp.readdir(modsDir, { withFileTypes: true })
  } catch (e) {
    throw new Error(`无法读取模组目录：${modsDir}（${e.message}）`)
  }
  const matchable = []
  const overrides = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(modsDir, entry.name)
    if (entry.isSymbolicLink()) {
      overrides.push({ name: entry.name, full, directory: false, link: true })
      continue
    }
    if (entry.isDirectory()) {
      overrides.push({ name: entry.name, full, directory: true, link: false })
      continue
    }
    if (!entry.isFile()) continue
    if (/\.jar$/i.test(entry.name)) {
      let fileStat
      try { fileStat = await fsp.stat(full) } catch { fileStat = null }
      if (!fileStat) {
        overrides.push({ name: entry.name, full, directory: false, link: false })
        continue
      }
      matchable.push({ name: entry.name, full, size: fileStat.size, sha1: '', sha512: '' })
    } else {
      overrides.push({ name: entry.name, full, directory: false, link: false })
    }
  }
  return { matchable, overrides }
}

async function hashMods(mods, { signal, log, report }) {
  if (!mods.length) return { hashed: [], failed: [] }
  const totalBytes = mods.reduce((sum, mod) => sum + (Number(mod.size) || 0), 0) || 1
  let readBytes = 0
  const hashed = []
  const failed = []
  for (const mod of mods) {
    signal?.throwIfAborted()
    try {
      const hashes = await hashFile(mod.full, {
        signal,
        onBytes: (count) => {
          readBytes += count
          report('扫描模组', Math.min(18, (readBytes / totalBytes) * 18), `正在计算模组哈希：${mod.name}`, false)
        }
      })
      hashed.push({ ...mod, sha1: hashes.sha1, sha512: hashes.sha512 })
    } catch (e) {
      if (signal?.aborted) throw abortError(signal)
      log(`无法读取模组 ${mod.name}，将直接复制到 overrides：${e.message}`, 'warn')
      failed.push(mod)
    }
  }
  report('扫描模组', 18, `已扫描 ${mods.length} 个模组`, false)
  return { hashed, failed }
}

async function hashFile(file, { signal, onBytes } = {}) {
  const sha1 = crypto.createHash('sha1')
  const sha512 = crypto.createHash('sha512')
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 256 * 1024 })) {
    signal?.throwIfAborted()
    sha1.update(chunk)
    sha512.update(chunk)
    onBytes?.(chunk.length)
  }
  return { sha1: sha1.digest('hex'), sha512: sha512.digest('hex') }
}

async function matchMods(mods, { mc, loader, signal, log, report, fetcher }) {
  const entries = []
  if (!mods.length) return { entries, unmatched: [] }
  if (loader === 'vanilla') {
    log('原版实例不查询 Modrinth，模组将放入 overrides', 'warn')
    return { entries, unmatched: mods }
  }
  report('匹配 Modrinth', null, '正在向 Modrinth 查询模组版本…', true)
  const versions = new Map()
  const hashes = [...new Set(mods.map((mod) => mod.sha1).filter(Boolean))]
  for (let index = 0; index < hashes.length; index += MODRINTH_BATCH) {
    signal?.throwIfAborted()
    const batch = hashes.slice(index, index + MODRINTH_BATCH)
    try {
      const data = await postModrinth(fetcher, { hashes: batch, algorithm: 'sha1' }, signal)
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('返回内容不是版本映射')
      for (const [hash, version] of Object.entries(data)) {
        if (version && typeof version === 'object') versions.set(String(hash).toLowerCase(), version)
      }
    } catch (e) {
      if (signal?.aborted) throw abortError(signal)
      log(`查询 Modrinth 失败（${e.message}），未查询的模组将放入 overrides`, 'warn')
      break
    }
  }
  const unmatched = []
  const usedPaths = new Set()
  for (const mod of mods) {
    const version = versions.get(String(mod.sha1).toLowerCase())
    if (!version || !versionSupports(version, mc, loader)) {
      unmatched.push(mod)
      continue
    }
    const file = pickVersionFile(version, mod.sha1)
    if (!file) {
      log(`模组 ${mod.name} 的 Modrinth 版本缺少匹配文件，已放入 overrides`, 'warn')
      unmatched.push(mod)
      continue
    }
    const fileName = safeEntryName(file.filename, mod.name)
    const entryPath = `mods/${fileName}`
    if (usedPaths.has(entryPath)) {
      log(`模组 ${mod.name} 与已匹配文件同名（${fileName}），已放入 overrides`, 'warn')
      unmatched.push(mod)
      continue
    }
    usedPaths.add(entryPath)
    const sha512 = /^[a-f0-9]{128}$/i.test(String(file.hashes?.sha512 || ''))
      ? String(file.hashes.sha512).toLowerCase()
      : mod.sha512
    entries.push({
      path: entryPath,
      hashes: { sha1: mod.sha1, sha512 },
      env: { client: 'required', server: 'optional' },
      downloads: [String(file.url)],
      fileSize: Number(file.size) > 0 ? Number(file.size) : mod.size
    })
  }
  report('匹配 Modrinth', 28, `Modrinth 匹配完成（${entries.length} 个）`, false)
  if (unmatched.length) log(`有 ${unmatched.length} 个模组未匹配 Modrinth，已放入 overrides/mods`, 'warn')
  return { entries, unmatched }
}

function versionSupports(version, mc, loader) {
  const gameVersions = Array.isArray(version.game_versions) ? version.game_versions : []
  const loaders = Array.isArray(version.loaders) ? version.loaders : []
  const targetMc = String(mc).toLowerCase()
  const targetLoader = String(loader).toLowerCase()
  return gameVersions.some((value) => String(value).toLowerCase() === targetMc) &&
    loaders.some((value) => String(value).toLowerCase() === targetLoader)
}

function pickVersionFile(version, sha1) {
  const files = Array.isArray(version.files) ? version.files : []
  const target = String(sha1 || '').toLowerCase()
  return files.find((file) => {
    if (!file || typeof file !== 'object') return false
    if (!/^https?:\/\//i.test(String(file.url || ''))) return false
    return String(file.hashes?.sha1 || '').toLowerCase() === target
  }) || null
}

async function postModrinth(fetcher, payload, signal) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(abortError(signal))
  let timer = null
  if (signal) {
    if (signal.aborted) throw abortError(signal)
    signal.addEventListener('abort', onAbort, { once: true })
  }
  timer = setTimeout(() => controller.abort(new Error('请求 Modrinth 超时（15 秒）')), MODRINTH_TIMEOUT)
  try {
    let response
    try {
      response = await fetcher(MODRINTH_VERSION_FILES, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'MC-Toolbox/1.9 (pack export)'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      })
    } catch (e) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason
      throw new Error(`无法连接 Modrinth：${e.message}`)
    }
    if (!response || response.ok === false) throw new Error(`Modrinth 返回 HTTP ${response?.status ?? '未知'}`)
    try {
      return await response.json()
    } catch {
      throw new Error('Modrinth 返回内容无法解析')
    }
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/* ------------------------------------------------------------------ */
/* 清单与校验                                                          */
/* ------------------------------------------------------------------ */

function buildMetadata({ format, name, mc, loader, loaderVersion, stamp, files }) {
  const summary = `由 MC Toolbox 导出的整合包 · Minecraft ${mc}${loader !== 'vanilla' ? ` · ${loader}${loaderVersion ? ' ' + loaderVersion : ''}` : ''}`
  if (format === 'mrpack') {
    const dependencies = { minecraft: mc }
    if (loader !== 'vanilla') dependencies[loaderDependencyKey(loader)] = loaderVersion
    return {
      formatVersion: 1,
      game: 'minecraft',
      versionId: `${mc}-${stamp}`,
      name,
      summary,
      files,
      dependencies
    }
  }
  const modLoaders = loader !== 'vanilla' && loaderVersion
    ? [{ id: `${loader}-${loaderVersion}`, primary: true }]
    : []
  return {
    formatVersion: 1,
    manifestType: 'mc-toolbox',
    name,
    versionId: `${mc}-${stamp}`,
    summary,
    minecraft: { version: mc, modLoaders },
    files,
    overrides: 'overrides'
  }
}

function loaderDependencyKey(loader) {
  if (loader === 'fabric') return 'fabric-loader'
  if (loader === 'quilt') return 'quilt-loader'
  return loader
}

async function verifyArchive(file, { format, expectedFiles, overrideCount }) {
  let index
  try {
    index = await readZipIndex(file)
  } catch (e) {
    throw new Error(`导出校验失败：${e.message}`)
  }
  const names = new Set(index.entries.filter((entry) => !entry.directory).map((entry) => entry.name))
  const metadataName = format === 'mrpack' ? 'modrinth.index.json' : 'manifest.json'
  if (!names.has(metadataName)) throw new Error(`导出校验失败：压缩包缺少 ${metadataName}`)
  const overrideEntries = [...names].filter((entry) => entry.startsWith('overrides/'))
  if (overrideEntries.length !== overrideCount) {
    throw new Error(`导出校验失败：overrides 文件数量不一致（清单 ${overrideCount}，压缩包 ${overrideEntries.length}）`)
  }
  const wanted = await readJarEntries(file, [metadataName], { maxBytes: 32 * 1024 * 1024 })
  const raw = wanted?.[metadataName]
  if (!raw) throw new Error(`导出校验失败：无法读取 ${metadataName}`)
  let json
  try {
    json = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error(`导出校验失败：${metadataName} 不是合法的 JSON`)
  }
  if (format === 'mrpack') {
    if (json.game !== 'minecraft' || !Array.isArray(json.files)) {
      throw new Error('导出校验失败：modrinth.index.json 缺少 game / files 字段')
    }
  } else if (json.manifestType !== 'mc-toolbox' || !Array.isArray(json.files)) {
    throw new Error('导出校验失败：manifest.json 缺少 manifestType / files 字段')
  }
  if (json.files.length !== expectedFiles.length) {
    throw new Error(`导出校验失败：清单模组数量不一致（预期 ${expectedFiles.length}，实际 ${json.files.length}）`)
  }
  const listed = new Set(json.files.map((item) => String(item?.path || '')))
  for (const rel of expectedFiles) {
    if (!listed.has(rel)) throw new Error(`导出校验失败：清单缺少模组文件 ${rel}`)
  }
  return { index, json }
}

/* ------------------------------------------------------------------ */
/* 文件复制 / 通用工具                                                  */
/* ------------------------------------------------------------------ */

async function copyFileTo(source, target, ctx, rel) {
  ctx.signal?.throwIfAborted()
  const name = path.basename(source)
  if (INTERNAL_FILE_RE.test(name)) {
    ctx.onSkipped(rel, '账户/启动器内部文件')
    return 0
  }
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.copyFile(source, target)
  } catch (e) {
    throw new Error(`复制文件失败：${rel}（${e.message}）`)
  }
  ctx.onCopied(rel)
  return 1
}

async function copyTree(source, target, ctx, rel = '') {
  ctx.signal?.throwIfAborted()
  let stat
  try {
    stat = await fsp.lstat(source)
  } catch (e) {
    throw new Error(`读取文件失败：${rel || source}（${e.message}）`)
  }
  if (stat.isSymbolicLink()) {
    ctx.onSkipped(rel || path.basename(source), '符号链接')
    return 0
  }
  if (stat.isDirectory()) {
    const dirName = path.basename(source)
    if (rel && (SKIP_DIR_NAMES.has(dirName) || /^natives/i.test(dirName))) {
      ctx.onSkipped(rel, '缓存 / 日志 / natives 目录')
      return 0
    }
    let entries = []
    try {
      entries = await fsp.readdir(source, { withFileTypes: true })
    } catch (e) {
      throw new Error(`读取目录失败：${rel || source}（${e.message}）`)
    }
    let count = 0
    for (const entry of entries) {
      ctx.signal?.throwIfAborted()
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      count += await copyTree(path.join(source, entry.name), path.join(target, entry.name), ctx, childRel)
    }
    return count
  }
  if (stat.isFile()) return copyFileTo(source, target, ctx, rel || path.basename(source))
  return 0
}

function buildOutputBase(name, mc, loader, stamp) {
  const packName = (safeName(name, '整合包').replace(/[. ]+$/g, '').trim() || '整合包').slice(0, 60)
  const mcPart = safeName(mc, 'version').replace(/[. ]+$/g, '').slice(0, 30)
  const loaderPart = loader && loader !== 'vanilla' ? `-${safeName(loader, 'loader')}` : ''
  return `${packName}-${mcPart}${loaderPart}-${stamp}`
}

function uniqueOutputPath(dir, base, ext) {
  for (let index = 0; index < 200; index++) {
    const candidate = path.join(dir, index === 0 ? `${base}${ext}` : `${base}-${index}${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new Error('导出目录中存在过多同名文件，请修改整合包名称后重试')
}

async function ensureOutputDir(dir) {
  try {
    const stat = await fsp.stat(dir).catch(() => null)
    if (stat && !stat.isDirectory()) throw new Error('同名文件已存在')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.access(dir, fs.constants.W_OK)
  } catch (e) {
    throw new Error(`导出目录不可用：${dir}（${e.message}）`)
  }
}

async function prepareStagingRoot(dir) {
  let entries = null
  try {
    entries = await fsp.readdir(dir)
  } catch (e) {
    if (!e || e.code !== 'ENOENT') throw new Error(`无法创建导出临时目录：${dir}（${e.message}）`)
  }
  if (entries && entries.length) throw new Error(`导出临时目录已存在且不为空：${dir}`)
  try {
    await fsp.mkdir(dir, { recursive: true })
  } catch (e) {
    throw new Error(`无法创建导出临时目录：${dir}（${e.message}）`)
  }
}

function resolveOutputDir(value) {
  const text = String(value ?? '').trim()
  if (!text) return defaultExportDir()
  return path.isAbsolute(text) ? path.resolve(text) : path.resolve(launcherRoot(), text)
}

function normalizeFormat(value) {
  const raw = String(value ?? 'mrpack').trim().toLowerCase().replace(/^\./, '')
  const hit = EXPORT_FORMATS.find((item) => item.id === raw)
  if (!hit) {
    throw new Error(`不支持的导出格式「${value}」，可选：${EXPORT_FORMATS.map((item) => `${item.label}（${item.ext}）`).join('、')}`)
  }
  return hit.id
}

function makeReporter(onProgress) {
  if (typeof onProgress !== 'function') return () => {}
  let lastAt = 0
  let lastPhase = ''
  let lastValue = null
  let lastDetail = ''
  return (phase, progress, detail, indeterminate = false) => {
    const value = progress === null || progress === undefined ? null : clamp(progress)
    const now = Date.now()
    if (
      phase === lastPhase &&
      value === lastValue &&
      detail === lastDetail &&
      now - lastAt < 120
    ) return
    lastAt = now
    lastPhase = phase
    lastValue = value
    lastDetail = detail
    onProgress({
      phase,
      detail: String(detail ?? ''),
      progress: value,
      indeterminate: Boolean(indeterminate) || value === null
    })
  }
}

function clamp(value) {
  return Math.max(0, Math.min(100, Number(value) || 0))
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason
  const error = new Error('已取消')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

function describeError(error, dir) {
  const message = (error && error.message) || '未知错误'
  if (['EACCES', 'EPERM', 'EROFS', 'ENOSPC'].includes(error?.code)) {
    return `${dir} 不可写（${message}）`
  }
  return message
}

function safeEntryName(value, fallback) {
  const base = path.posix.basename(String(value || '').replace(/\\/g, '/'))
  const clean = base.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/^[. ]+|[. ]+$/g, '')
  return clean || fallback || 'mod.jar'
}

function nowTime() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function resolveDate(value) {
  if (typeof value === 'function') {
    try { value = value() } catch { value = undefined }
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  const numeric = Number(value)
  if (value !== undefined && value !== null && Number.isFinite(numeric)) return new Date(numeric)
  return new Date()
}

function formatTimestamp(date) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

function isInsideOrSame(child, parent) {
  const c = path.resolve(child)
  const p = path.resolve(parent)
  if (c === p) return true
  const rel = path.relative(p, c)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function isDirectory(target) {
  try { return fs.statSync(target).isDirectory() } catch { return false }
}

function isFile(target) {
  try { return fs.statSync(target).isFile() } catch { return false }
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
