import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { httpFetch } from './http.js'

const UA = 'mc-toolbox/1.0 (local toolbox)'
const MODRINTH = 'https://api.modrinth.com/v2'
const CURSEFORGE = 'https://api.curseforge.com/v1'

const CF_CLASS_FALLBACK = { mod: 6, modpack: 4471, resourcepack: 12, world: 17 }
const CF_LOADER_FALLBACK = { forge: 1, fabric: 4, quilt: 5, neoforge: 6, liteloader: 3, cauldron: 2 }

let cfClassCache = null
let cfg = { maxConcurrent: 3, threads: 4, speedLimit: 0, nameRule: '{project}-{version}{ext}', subdirByType: false, downloadDir: '' }

/** 由 api.js 在每次请求前同步设置下载相关配置 */
export function configure(next = {}) {
  cfg = { ...cfg, ...next }
  pump()
}

async function getJSON(url, headers = {}) {
  const res = await httpFetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(20000) })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`)
  }
  return res.json()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------- 全局限速（令牌桶，所有任务共享） ----------------
const limiter = {
  tokens: 0,
  last: Date.now(),
  async take(n) {
    const limit = Number(cfg.speedLimit) || 0 // KB/s
    if (limit <= 0) return
    const bytesPerSec = limit * 1024
    // 单次读取可能比每秒配额还大（限速很低时几乎必然如此）：只按配额等待，
    // 否则令牌永远攒不到 n，整个下载队列会永久卡死。
    const need = Math.min(n, bytesPerSec)
    for (;;) {
      const now = Date.now()
      this.tokens = Math.min(bytesPerSec, this.tokens + ((now - this.last) / 1000) * bytesPerSec)
      this.last = now
      if (this.tokens >= need) {
        this.tokens -= need
        return
      }
      const wait = ((need - this.tokens) / bytesPerSec) * 1000
      await sleep(Math.min(200, Math.max(5, wait)))
    }
  }
}

// ---------------- Modrinth ----------------
const MR_TYPE = { mod: 'mod', modpack: 'modpack', datapack: 'datapack', resourcepack: 'resourcepack', shader: 'shader' }

// Modrinth index 合法值（与统一排序项一致）
const MR_INDEX = new Set(['relevance', 'downloads', 'follows', 'newest', 'updated'])

export async function modrinthSearch({ query = '', type, gameVersion, loader, limit = 20, offset = 0, sort = 'relevance' }) {
  const facets = []
  if (type && MR_TYPE[type]) facets.push([`project_type:${MR_TYPE[type]}`])
  if (gameVersion) facets.push([`versions:${gameVersion}`])
  if (loader) facets.push([`categories:${loader}`])
  const params = new URLSearchParams({ query: query || '', limit: String(limit), offset: String(offset), index: MR_INDEX.has(sort) ? sort : 'relevance' })
  if (facets.length) params.set('facets', JSON.stringify(facets))
  const j = await getJSON(`${MODRINTH}/search?${params}`)
  return {
    source: 'modrinth',
    total: j.total_hits ?? j.hits?.length ?? 0,
    offset: j.offset ?? offset,
    items: (j.hits || []).map(normalizeModrinthHit)
  }
}

function normalizeModrinthHit(h) {
  const categories = Array.isArray(h.categories) ? h.categories : []
  return {
    source: 'modrinth',
    id: h.project_id || h.slug,
    slug: h.slug,
    type: h.project_type,
    title: h.title,
    author: h.author,
    summary: h.description,
    icon: h.icon_url || null,
    downloads: h.downloads ?? 0,
    follows: h.follows ?? 0,
    updated: h.date_modified || h.date_created,
    categories,
    gameVersions: Array.isArray(h.versions) ? h.versions : [],
    loaders: categories.filter((c) => ['fabric', 'forge', 'neoforge', 'quilt'].includes(String(c).toLowerCase())),
    url: `https://modrinth.com/${h.project_type}/${h.slug}`
  }
}

export async function modrinthProject(id) {
  const p = await getJSON(`${MODRINTH}/project/${encodeURIComponent(id)}`)
  return {
    source: 'modrinth',
    id: p.id,
    slug: p.slug,
    type: p.project_type,
    title: p.title,
    author: p.author || null,
    summary: p.description,
    body: p.body || '',
    icon: p.icon_url || null,
    downloads: p.downloads ?? 0,
    follows: p.followers ?? 0,
    updated: p.updated,
    categories: p.categories || [],
    loaders: p.loaders || [],
    gameVersions: p.game_versions || [],
    license: p.license ? `${p.license.name || p.license.id}` : null,
    links: { site: p.source_url || null, wiki: p.wiki_url || null, issues: p.issues_url || null, discord: p.discord_url || null },
    url: `https://modrinth.com/${p.project_type}/${p.slug}`,
    gallery: p.gallery || []
  }
}

export async function modrinthVersions(id, { loader, gameVersion } = {}) {
  const params = new URLSearchParams()
  if (loader) params.set('loaders', JSON.stringify([loader]))
  if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]))
  const list = await getJSON(`${MODRINTH}/project/${encodeURIComponent(id)}/version?${params}`)
  return (list || []).map((v) => ({
    id: v.id,
    name: v.name || v.version_number,
    number: v.version_number,
    type: v.version_type,
    date: v.date_published,
    downloads: v.downloads,
    gameVersions: v.game_versions || [],
    loaders: v.loaders || [],
    changelog: v.changelog || '',
    files: (v.files || []).map((f) => ({ name: f.filename, url: f.url, size: f.size || 0, primary: !!f.primary }))
  }))
}

// ---------------- CurseForge ----------------
async function cfClassIds(key) {
  if (cfClassCache) return cfClassCache
  const map = { ...CF_CLASS_FALLBACK }
  try {
    const j = await getJSON(`${CURSEFORGE}/categories?gameId=432`, { 'x-api-key': key })
    for (const c of j.data || []) {
      if (!c.isClass) continue
      const n = String(c.name || '').toLowerCase()
      if (n.includes('modpack')) map.modpack = c.id
      else if (n.includes('shader')) map.shader = c.id
      else if (n.includes('data pack') || n.includes('datapack')) map.datapack = c.id
      else if (n.includes('resource pack')) map.resourcepack = c.id
      else if (n === 'mods') map.mod = c.id
      else if (n.includes('world')) map.world = c.id
    }
    cfClassCache = map
  } catch {
    /* 用内置值兜底 */
  }
  return map
}

// CurseForge 排序映射（sortField：1=Featured 2=Popularity 3=LastUpdated 4=Name 6=TotalDownloads；sortOrder：2=降序）
// 统一排序项：relevance 相关性 / downloads 下载量 / follows 点赞 / updated 最近更新 / newest 最新发布
const CF_SORT = {
  relevance: { sortField: '1' },              // Featured ≈ 默认相关
  downloads: { sortField: '6', sortOrder: '2' }, // TotalDownloads 降序
  follows:   { sortField: '2', sortOrder: '2' }, // Popularity 降序（近似点赞）
  updated:   { sortField: '3', sortOrder: '2' }, // LastUpdated 降序
  newest:    { sortField: '3', sortOrder: '2' }  // CF 无发布时间排序，用最近更新近似
}

export async function curseforgeSearch({ query = '', type, gameVersion, loader, limit = 20, offset = 0, key, sort = 'relevance' }) {
  if (!key) throw new Error('未配置 CurseForge API Key（设置 → 社区资源 → CurseForge API Key）')
  const classIds = await cfClassIds(key)
  const classId = type ? classIds[type] : undefined
  if (type && !classId) throw new Error('当前 Key 无法解析该类型在 CurseForge 的分类，可切换到 Modrinth 或选择「全部」')
  const cfSort = CF_SORT[sort] || CF_SORT.relevance
  const params = new URLSearchParams({
    gameId: '432',
    searchFilter: query || '',
    index: String(offset),
    pageSize: String(limit),
    sortField: cfSort.sortField
  })
  if (cfSort.sortOrder) params.set('sortOrder', cfSort.sortOrder)
  if (classId) params.set('classId', String(classId))
  if (gameVersion) params.set('gameVersion', gameVersion)
  if (loader && CF_LOADER_FALLBACK[loader]) params.set('modLoaderType', String(CF_LOADER_FALLBACK[loader]))
  const j = await getJSON(`${CURSEFORGE}/mods/search?${params}`, { 'x-api-key': key })
  return {
    source: 'curseforge',
    total: j.pagination?.totalCount ?? (j.data || []).length,
    offset: Number(j.pagination?.index ?? offset),
    items: (j.data || []).map(normalizeCfHit)
  }
}

const CF_MOD_LOADER_NAMES = { 1: 'forge', 2: 'cauldron', 3: 'liteloader', 4: 'fabric', 5: 'quilt', 6: 'neoforge' }
const CF_LOADER_NAMES = new Set(['forge', 'fabric', 'quilt', 'neoforge', 'liteloader', 'cauldron'])

function cfLoaderName(value) {
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (!text) return ''
    if (/^\d+$/.test(text)) return CF_MOD_LOADER_NAMES[Number(text)] || ''
    return CF_LOADER_NAMES.has(text) ? text : ''
  }
  return CF_MOD_LOADER_NAMES[Number(value)] || ''
}

function cfLoadersFromGameVersions(values) {
  const out = []
  for (const value of Array.isArray(values) ? values : []) {
    const name = String(value || '').toLowerCase()
    if (CF_LOADER_NAMES.has(name) && !out.includes(name)) out.push(name)
  }
  return out
}

function normalizeCfHit(m) {
  const indexes = Array.isArray(m.latestFilesIndexes) ? m.latestFilesIndexes : []
  const gameVersions = [...new Set(indexes.map((f) => f?.gameVersion).filter(Boolean))]
  const loaders = [...new Set(indexes.map((f) => cfLoaderName(f?.modLoader)).filter(Boolean))]
  return {
    source: 'curseforge',
    id: String(m.id),
    slug: m.slug,
    title: m.name,
    author: (m.authors || []).map((a) => a.name).join(', '),
    summary: m.summary,
    icon: m.logo?.url || m.logo?.thumbnailUrl || null,
    downloads: m.downloadCount ?? 0,
    follows: m.thumbsUpCount ?? 0,
    updated: m.dateModified,
    categories: (m.categories || []).map((c) => c.slug || c.name),
    gameVersions,
    loaders,
    url: m.links?.websiteUrl || `https://www.curseforge.com/minecraft/mc-mods/${m.slug}`
  }
}

export async function curseforgeProject(id, key) {
  if (!key) throw new Error('未配置 CurseForge API Key')
  const j = await getJSON(`${CURSEFORGE}/mods/${id}`, { 'x-api-key': key })
  const m = j.data || {}
  return {
    source: 'curseforge',
    id: String(m.id),
    slug: m.slug,
    title: m.name,
    author: (m.authors || []).map((a) => a.name).join(', '),
    summary: m.summary,
    body: '',
    icon: m.logo?.url || null,
    downloads: m.downloadCount ?? 0,
    follows: m.thumbsUpCount ?? 0,
    updated: m.dateModified,
    categories: (m.categories || []).map((c) => c.slug || c.name),
    loaders: (m.latestFilesIndexes || []).map((f) => f.modLoader).filter(Boolean),
    gameVersions: m.latestFiles ? [...new Set(m.latestFiles.flatMap((f) => f.gameVersions || []))] : [],
    links: { site: m.links?.websiteUrl || null, wiki: m.links?.wikiUrl || null, issues: m.links?.issuesUrl || null, discord: null },
    url: m.links?.websiteUrl || `https://www.curseforge.com/minecraft/mc-mods/${m.slug}`,
    gallery: (m.screenshots || []).map((s) => s.url).filter(Boolean)
  }
}

export async function curseforgeVersions(id, { gameVersion, loader, key, pageSize = 50 }) {
  if (!key) throw new Error('未配置 CurseForge API Key')
  const params = new URLSearchParams({ index: '0', pageSize: String(pageSize) })
  if (gameVersion) params.set('gameVersion', gameVersion)
  if (loader && CF_LOADER_FALLBACK[loader]) params.set('modLoaderType', String(CF_LOADER_FALLBACK[loader]))
  const j = await getJSON(`${CURSEFORGE}/mods/${id}/files?${params}`, { 'x-api-key': key })
  return (j.data || []).map((f) => ({
    id: String(f.id),
    name: f.displayName || f.fileName,
    number: f.displayName || f.fileName,
    type: ['release', 'beta', 'alpha'][f.releaseType] || 'release',
    date: f.fileDate,
    downloads: f.downloadCount ?? 0,
    gameVersions: f.gameVersions || [],
    loaders: cfLoadersFromGameVersions(f.gameVersions),
    changelog: '',
    files: f.downloadUrl ? [{ name: f.fileName, url: f.downloadUrl, size: f.fileLength || 0, primary: true }] : []
  }))
}

// ---------------- 命名规则 ----------------
export const NAME_VARS = ['project', 'name', 'version', 'loader', 'gameversion', 'mcversion', 'type', 'source', 'date', 'time', 'filename', 'ext']

export function applyNameRule(rule, meta = {}) {
  const rawName = meta.filename || 'download.jar'
  const ext = path.extname(rawName) || '.jar'
  const base = rawName.slice(0, rawName.length - ext.length)
  const d = new Date()
  const p2 = (n) => String(n).padStart(2, '0')
  const vars = {
    project: meta.project || base,
    name: meta.name || meta.project || base,
    version: meta.version || '',
    loader: meta.loader || '',
    gameversion: meta.gameVersion || meta.mcVersion || '',
    mcversion: meta.gameVersion || meta.mcVersion || '',
    type: meta.type || '',
    source: meta.source || '',
    date: `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`,
    time: `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`,
    filename: rawName,
    ext
  }
  let out = String(rule || '{filename}')
    .replace(/\{(\w+)\}/g, (m, k) => (k.toLowerCase() in vars ? String(vars[k.toLowerCase()]) : m))
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  if (!out) out = rawName
  if (!path.extname(out)) out += ext
  return out.slice(0, 150)
}

function safeName(name) {
  return String(name || 'download').replace(/[\\/:*?"<>|]/g, '_').slice(0, 150)
}

// ---------------- 下载队列 ----------------
const jobs = new Map()
let jobSeq = 1

function clampProgress(value) {
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100))
}

/**
 * 统一的 0–100 进度（或 null = 未知）。
 * 优先：完成 100 → 安装百分比 → 已下载字节比例。
 */
function jobProgress(j) {
  if (!j) return null
  if (j.status === 'done') return 100
  if (j.status === 'installing') {
    if (j.installProgress === null || j.installProgress === undefined) return null
    const install = Number(j.installProgress)
    return Number.isFinite(install) ? clampProgress(install) : null
  }
  const total = Number(j.total)
  if (!Number.isFinite(total) || total <= 0) return null
  return clampProgress((Math.max(0, Number(j.received) || 0) / total) * 100)
}

/** 对外的任务快照：附带派生字段，不泄漏 controller / completion。 */
function publicJob(j) {
  const { controller, completion, ...rest } = j
  return { ...rest, progress: jobProgress(j) }
}

/** 统一写终态：finishedAt 只写一次，终态不再保留速度。 */
function markFinished(job, status, error) {
  job.status = status
  if (error !== undefined && error !== null) job.error = String(error)
  if (!job.finishedAt) job.finishedAt = Date.now()
  job.updatedAt = job.finishedAt
  job.speed = 0
}

export function listJobs() {
  return Array.from(jobs.values()).map(publicJob).reverse()
}

export function getJob(id) {
  const j = jobs.get(id)
  return j ? publicJob(j) : null
}

/** 启动所有能启动的排队任务（受并发数限制） */
function pump() {
  const max = Math.max(1, Number(cfg.maxConcurrent) || 1)
  let running = 0
  for (const j of jobs.values()) if (['running', 'installing'].includes(j.status)) running++
  if (running >= max) return
  for (const j of jobs.values()) {
    if (running >= max) break
    if (j.status !== 'queued') continue
    running++
    j.completion = runDownload(j).catch((e) => {
      // runDownload 已处理任务内错误；这里只兜底，且不能覆盖已取消的终态。
      if (j.status !== 'cancelled') markFinished(j, 'failed', e?.message || String(e))
      pump()
    }).finally(() => {
      pump()
    })
  }
}

export async function startDownload({ url, mirrors, dir, filename, title, meta, postCommand, startScript, extraFiles, preserveName, exactDir = false }) {
  if (!url) throw new Error('缺少下载地址')
  const baseDir = dir && dir.trim() ? dir.trim() : cfg.downloadDir || path.join(os.homedir(), 'Downloads')
  let target = baseDir
  if (!exactDir && cfg.subdirByType && meta?.type) target = path.join(baseDir, safeName(meta.type))
  await fsp.mkdir(target, { recursive: true })

  // preserveName：服务端核心等场景保留原生文件名，不套用命名规则
  const finalName = preserveName
    ? safeName(filename || 'download.jar')
    : applyNameRule(cfg.nameRule, { ...(meta || {}), filename: filename || 'download.jar' })
  let dest = path.join(target, finalName)
  let i = 1
  while (fs.existsSync(dest) || fs.existsSync(dest + '.part')) {
    const ext = path.extname(finalName)
    dest = path.join(target, finalName.slice(0, finalName.length - ext.length) + ` (${i++})` + ext)
  }

  const id = 'job_' + jobSeq++
  // 安装命令占位符替换：{jar} = 下载到的文件名，{dir} = 目标目录
  const resolvedPost = Array.isArray(postCommand)
    ? postCommand.map((a) => String(a).replaceAll('{jar}', path.basename(dest)).replaceAll('{dir}', target))
    : null
  const job = {
    id,
    title: title || finalName,
    filename: path.basename(dest),
    dir: target,
    path: dest,
    url,
    // 备用下载源（如 BMCLAPI 镜像）：主地址不可达时按顺序回退
    mirrors: (Array.isArray(mirrors) ? mirrors : []).filter((item) => typeof item === 'string' && item),
    status: 'queued',
    received: 0,
    total: 0,
    threads: 0,
    speed: 0,
    installProgress: null,
    installLog: '',
    error: null,
    // createdAt = 排队时刻；startedAt 由 runDownload 真正开跑时写入，
    // 排队等待不能算进「已进行」。
    createdAt: Date.now(),
    startedAt: 0,
    updatedAt: Date.now(),
    finishedAt: null,
    meta: meta || {},
    postCommand: resolvedPost,
    startScript: startScript || null,
    extraFiles: (Array.isArray(extraFiles) ? extraFiles : []).map((f) => ({ url: f.url, filename: safeName(f.filename || 'file') })),
    controller: new AbortController()
  }
  jobs.set(id, job)
  pump()
  return publicJob(job)
}

async function probe(url, signal) {
  // 用 GET + Range: bytes=0-0 探测，比 HEAD 更可靠（规避某些 CDN 对 HEAD 的 307 重定向问题）
  try {
    const res = await httpFetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Range: 'bytes=0-0' },
      signal,
      redirect: 'follow'
    })
    const cr = res.headers.get('content-range') || ''
    if (res.status === 206 && cr) {
      const m = /\/(\d+)$/.exec(cr)
      if (m) {
        await res.body?.cancel?.().catch(() => {})
        return { len: Number(m[1]), ranges: true, ok: true }
      }
    }
    if (res.ok) {
      const len = Number(res.headers.get('content-length')) || 0
      const ranges = (res.headers.get('accept-ranges') || '').toLowerCase() === 'bytes'
      await res.body?.cancel?.().catch(() => {})
      return { len, ranges, ok: true }
    }
    await res.body?.cancel?.().catch(() => {})
  } catch {
    /* 忽略，走单线程 */
  }
  return { len: 0, ranges: false, ok: false }
}

/** 下载单个文件到目标路径（支持分段 + 限速），进度累加到 job.received / job.total */
async function downloadToFile(url, dest, job, signal) {
  const { len, ranges } = await probe(url, signal)
  const threads = Math.max(1, Math.min(8, Number(cfg.threads) || 1))
  const canSplit = ranges && len > 1024 * 1024 && threads > 1
  const tmp = dest + '.part'
  try {
    if (canSplit) {
      job.threads = threads
      job.total += len
      const fh = await fsp.open(tmp, 'w')
      // 任一分片失败时必须立刻中止其他分片，并等它们全部退出后再回滚字节；
      // 否则残留的 reader 会在 runDownload 回滚之后继续累加 received。
      const partController = new AbortController()
      const combined = signal ? AbortSignal.any([signal, partController.signal]) : partController.signal
      try {
        const chunk = Math.ceil(len / threads)
        const parts = []
        for (let i = 0; i < threads; i++) {
          const start = i * chunk
          const end = i === threads - 1 ? len - 1 : Math.min(len - 1, start + chunk - 1)
          if (start > end) continue
          parts.push({ start, end })
        }
        const settled = await Promise.allSettled(parts.map(async ({ start, end }) => {
          try {
            const res = await httpFetch(url, { headers: { 'User-Agent': UA, Range: `bytes=${start}-${end}` }, signal: combined, redirect: 'follow' })
            if (!res.ok && res.status !== 206) throw new Error(`分段下载失败 HTTP ${res.status}`)
            const reader = res.body.getReader()
            let pos = start
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              if (combined.aborted) throw combined.reason || new Error('已取消')
              await limiter.take(value.length)
              await fh.write(value, 0, value.length, pos)
              pos += value.length
              job.received += value.length
              job.updatedAt = Date.now()
            }
          } catch (e) {
            partController.abort(e)
            throw e
          }
        }))
        const failed = settled.find((item) => item.status === 'rejected')
        if (failed) throw failed.reason
      } finally {
        await fh.close()
      }
    } else {
      job.threads = 1
      const res = await httpFetch(url, { headers: { 'User-Agent': UA }, signal, redirect: 'follow' })
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
      const size = Number(res.headers.get('content-length')) || len || 0
      job.total += size
      const fh = await fsp.open(tmp, 'w')
      try {
        if (res.body && typeof res.body.getReader === 'function') {
          const reader = res.body.getReader()
          let pos = 0
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            await limiter.take(value.length)
            await fh.write(value, 0, value.length, pos)
            pos += value.length
            job.received += value.length
            job.updatedAt = Date.now()
          }
        } else {
          const buf = Buffer.from(await res.arrayBuffer())
          await limiter.take(buf.length)
          await fh.write(buf)
          job.received += buf.length
          job.updatedAt = Date.now()
        }
      } finally {
        await fh.close()
      }
    }
    await fsp.rename(tmp, dest)
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {})
    throw e
  }
}

async function runDownload(job) {
  job.status = 'running'
  // 只有真正开始下载才写 startedAt；排队时间用 createdAt 单独展示。
  job.startedAt = Date.now()
  job.updatedAt = job.startedAt
  job.received = 0
  job.total = 0
  const signal = job.controller.signal

  // 速度统计
  let lastBytes = 0
  let lastAt = Date.now()
  const tick = setInterval(() => {
    // 终态（成功 / 失败 / 取消）之后不再更新速度，避免取消后又被定时器写回非 0。
    if (job.finishedAt || job.status === 'cancelled') {
      job.speed = 0
      return
    }
    const now = Date.now()
    const dt = Math.max(0.2, (now - lastAt) / 1000)
    job.speed = (job.received - lastBytes) / dt
    lastBytes = job.received
    lastAt = now
  }, 700)
  const stopTick = () => clearInterval(tick)

  try {
    // 主文件：镜像优先（Forge / NeoForge 的 maven 在国内常被墙），失败再回退官方地址
    const mainUrls = [...new Set([...(job.mirrors || []), job.url].filter(Boolean))]
    let mainError = null
    for (const candidate of mainUrls) {
      if (job.status === 'cancelled' || signal.aborted) break
      // 每次镜像尝试前快照字节：失败尝试（404 / 超时 / 半截连接）不能把
      // 已读字节累计进 job.received/total，否则总进度会虚高。
      const bytesBefore = { received: job.received, total: job.total }
      try {
        await downloadToFile(candidate, job.path, job, signal)
        mainError = null
        break
      } catch (e) {
        job.received = bytesBefore.received
        job.total = bytesBefore.total
        mainError = e
        await fsp.unlink(job.path + '.part').catch(() => {})
        if (job.status === 'cancelled' || signal.aborted) throw e
        job.installLog = `主地址不可用，尝试备用源：${e.message.slice(0, 80)}`
      }
    }
    if (mainError) throw mainError
    job.installLog = ''
    if (job.status === 'cancelled') {
      await fsp.unlink(job.path).catch(() => {})
      return
    }
    // 额外文件（如 Quilt 的原版 server.jar，走引擎下载可代理/多线程/超时）
    for (const f of job.extraFiles || []) {
      if (job.status === 'cancelled') return
      await downloadToFile(f.url, path.join(job.dir, f.filename), job, signal)
    }
    if (job.status === 'cancelled') {
      await fsp.unlink(job.path).catch(() => {})
      return
    }
    if (job.postCommand) {
      await runPostCommand(job)
    } else {
      markFinished(job, 'done')
    }
    // 无论是否有安装步骤，成功后统一生成启动脚本（Paper/Vanilla 直接 jar 也要）
    if (job.status === 'done' && job.startScript) await writeStartScripts(job)
  } catch (e) {
    if (job.status === 'cancelled') return
    markFinished(job, 'failed', e.message)
    await fsp.unlink(job.path + '.part').catch(() => {})
  } finally {
    stopTick()
    job.speed = 0
  }
}

/** 下载完成后执行安装命令（如 java -jar installer.jar ...），并实时解析安装器进度 */
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g

function nextBreak(s) {
  const n = s.indexOf('\n')
  const r = s.indexOf('\r')
  if (n === -1) return r
  if (r === -1) return n
  return Math.min(n, r)
}

/** 解析安装器输出的一行：提取百分比与最新日志（Fabric/Forge/NeoForge/Quilt 输出格式各不相同，做通用解析） */
function parseInstallerLine(job, raw) {
  const line = raw.replace(ANSI_RE, '').replace(/\s+/g, ' ').trim()
  if (!line) return
  job.updatedAt = Date.now()
  job.installLog = line.length > 140 ? line.slice(-140) : line
  // 各种进度写法：45%、[#####-----] 45%、Downloading ... 45.2%
  const pct = line.match(/(\d{1,3}(?:\.\d+)?)\s*%/g)
  if (pct && pct.length) {
    const num = parseFloat(pct[pct.length - 1])
    if (Number.isFinite(num)) job.installProgress = Math.max(0, Math.min(100, num))
  }
}

async function runPostCommand(job) {
  if (job.controller.signal.aborted) return
  job.status = 'installing'
  job.installProgress = null
  job.installLog = ''
  try {
    const { spawn } = await import('node:child_process')
    const cmd = job.postCommand
    await new Promise((resolve, reject) => {
      const child = spawn(cmd[0], cmd.slice(1), {
        cwd: job.dir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const stop = () => child.kill('SIGKILL')
      job.controller.signal.addEventListener('abort', stop, { once: true })
      if (job.controller.signal.aborted) stop()
      let tail = ''
      let lineBuf = ''
      const feed = (s) => {
        tail += s
        if (tail.length > 4000) tail = tail.slice(-4000)
        // 安装器常用 \r 刷新同一行，按 \r / \n 拆分逐段解析
        lineBuf += s
        let i
        while ((i = nextBreak(lineBuf)) >= 0) {
          parseInstallerLine(job, lineBuf.slice(0, i))
          lineBuf = lineBuf.slice(i + 1)
        }
      }
      child.stdout?.on('data', (d) => feed(d.toString()))
      child.stderr?.on('data', (d) => feed(d.toString()))
      child.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? '未找到 Java，请先安装 Java 并加入系统 PATH' : e.message)))
      child.on('close', (code) => {
        job.controller.signal.removeEventListener('abort', stop)
        if (lineBuf.trim()) parseInstallerLine(job, lineBuf)
        if (code === 0) resolve()
        else reject(new Error('安装器退出码 ' + code + (tail ? '：' + tail.slice(-260) : '')))
      })
    })
    if (job.controller.signal.aborted) return
    job.installProgress = 100
    markFinished(job, 'done')
  } catch (e) {
    if (job.controller.signal.aborted) return
    // 失败时保留最后一次解析到的安装百分比（没有则为 null），并写 finishedAt。
    if (job.installProgress === undefined) job.installProgress = null
    markFinished(job, 'failed', e.message)
  }
}

/** 安装完成后生成启动脚本（start.bat / start.sh） */
async function writeStartScripts(job) {
  const sc = job.startScript
  if (sc.runtime) {
    const { writeServerScripts } = await import('./pack-converter.js')
    await writeServerScripts(job.dir, sc.runtime, sc.info, { memory: sc.mem, minMemory: '1G', javaPath: sc.javaPath })
    return
  }
  if (!sc?.jar) return
  const mem = String(sc.mem || '2G').trim()
  const cmd = `java -Xms${mem} -Xmx${mem} -jar ${sc.jar} nogui`
  const bat = `@echo off\r\nchcp 65001 >nul\r\ntitle Minecraft Server\r\n${cmd}\r\npause\r\n`
  const sh = `#!/bin/sh\n${cmd}\n`
  try {
    await fsp.writeFile(path.join(job.dir, 'start.bat'), bat)
    await fsp.writeFile(path.join(job.dir, 'start.sh'), sh)
    if (process.platform !== 'win32') {
      await fsp.chmod(path.join(job.dir, 'start.sh'), 0o755).catch(() => {})
    }
    job.installLog = '已生成启动脚本 start.bat / start.sh'
  } catch (e) {
    job.installLog = `启动脚本生成失败：${e.message}`
  }
}

export function cancelJob(id) {
  const job = jobs.get(id)
  if (!job) return false
  if (job.status === 'done' || job.status === 'failed') return false
  // 取消是终态：立即写 finishedAt 并清零速度，界面不再显示「已进行」。
  markFinished(job, 'cancelled')
  job.controller.abort()
  pump()
  return true
}

export async function cancelJobAndWait(id) {
  const job = jobs.get(id)
  cancelJob(id)
  await job?.completion
}

export function clearJobs(scope) {
  const isServercore = (j) => !!(j.meta && j.meta.type === 'servercore')
  for (const j of Array.from(jobs.values())) {
    // scope='community'：只清社区资源下载的任务，服务端核心下载的留给自己的磁贴
    if (scope === 'community' && isServercore(j)) continue
    if (scope === 'servercore' && !isServercore(j)) continue
    if (['running', 'queued', 'installing'].includes(j.status)) cancelJob(j.id)
    jobs.delete(j.id)
  }
  pump()
  return true
}

/** Remove only finished jobs; active downloads keep running. */
export function clearFinishedJobs() {
  let removed = 0
  for (const [id, job] of jobs) {
    if (['running', 'queued', 'installing'].includes(job.status)) continue
    jobs.delete(id)
    removed++
  }
  return removed
}
