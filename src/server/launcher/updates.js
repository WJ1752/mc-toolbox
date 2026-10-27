// 模组更新检查与缺失前置解析。
//
// 更新判断以 Modrinth 的文件哈希（SHA-1）为准：本地 JAR 的哈希能唯一定位到
// 作者发布的版本，避免仅凭文件名/模组 ID 猜测。CurseForge 独占的模组无法通过
// 公开接口反查，会在结果里明确列为“未收录”，而不是伪造“已是最新”。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { httpFetch } from '../http.js'
import { DATA_DIR } from '../paths.js'
import { scanModsDir } from '../mods.js'
import { instancePaths } from './state.js'
import { listMods } from './content.js'

const MODRINTH = 'https://api.modrinth.com/v2'
const UA = 'MC-Toolbox/1.12.7 (local launcher)'
const HASH_TTL = 24 * 60 * 60 * 1000
const UPDATE_TTL = 5 * 60 * 1000
const DEP_TTL = 10 * 60 * 1000
const REQUEST_TIMEOUT = 20000
const BATCH_SIZE = 100
// 331 个模组的 SHA-1 全部算完后，用两个批量接口就能完成检查：
// 旧实现是每个模组 1 次哈希查询 + 1 次版本列表，662 个请求排着队跑。
function diskHashesPath() {
  // DATA_DIR 可能在运行时被「更换存储目录」切换；缓存路径必须现取，不能在模块加载时固化。
  return path.join(DATA_DIR, 'cache', 'mod-sha1.json')
}
const HASH_CACHE_MAX = 5000

const hashCache = new Map()
const updateCache = new Map()
const dependencyCache = new Map()
let diskHashes = null
let diskSaveTimer = null

function now() { return Date.now() }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function requestJson(url, { signal, timeout = REQUEST_TIMEOUT, method = 'GET', body = null, fetcher = httpFetch } = {}) {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(600 * attempt)
    signal?.throwIfAborted()
    try {
      const headers = { 'User-Agent': UA, Accept: 'application/json' }
      if (body !== null) headers['Content-Type'] = 'application/json'
      const res = await fetcher(url, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
        redirect: 'follow'
      })
      if (res.status === 404) return { __notFound: true }
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`)
        continue
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}${text ? ' ' + text.slice(0, 120) : ''}`)
      }
      return await res.json()
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
    }
  }
  throw lastError || new Error('请求失败')
}

function fileKey(file, stat) {
  return `${path.resolve(file)}|${stat.size}|${Math.round(stat.mtimeMs)}`
}

function loadDiskHashes() {
  if (diskHashes) return diskHashes
  diskHashes = new Map()
  try {
    const raw = JSON.parse(fs.readFileSync(diskHashesPath(), 'utf8'))
    for (const [key, value] of Object.entries(raw?.items || {})) {
      if (typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value)) diskHashes.set(key, value)
    }
  } catch { /* 第一次运行 / 缓存损坏：重新计算即可 */ }
  return diskHashes
}

function scheduleDiskHashSave() {
  if (diskSaveTimer) return
  diskSaveTimer = setTimeout(() => {
    diskSaveTimer = null
    const entries = [...loadDiskHashes().entries()].slice(-HASH_CACHE_MAX)
    const items = Object.fromEntries(entries)
    const file = diskHashesPath()
    fsp.mkdir(path.dirname(file), { recursive: true })
      .then(() => fsp.writeFile(file + '.tmp', JSON.stringify({ version: 1, items }), 'utf8'))
      .then(() => fsp.rename(file + '.tmp', file))
      .catch(() => {})
  }, 1500)
  diskSaveTimer.unref?.()
}

export function clearHashCache() {
  hashCache.clear()
  diskHashes = new Map()
  if (diskSaveTimer) clearTimeout(diskSaveTimer)
  diskSaveTimer = null
}

/** SHA-1 of a mod JAR, cached by path/size/mtime so repeated checks are cheap. */
export async function sha1OfFile(file, { signal } = {}) {
  const stat = await fsp.stat(file)
  const key = fileKey(file, stat)
  const hit = hashCache.get(key)
  if (hit && now() - hit.at < HASH_TTL) return hit.hash
  const persisted = loadDiskHashes().get(key)
  if (persisted) {
    hashCache.set(key, { at: now(), hash: persisted })
    return persisted
  }
  signal?.throwIfAborted()
  const digest = crypto.createHash('sha1')
  for await (const chunk of fs.createReadStream(file)) {
    signal?.throwIfAborted()
    digest.update(chunk)
  }
  const hash = digest.digest('hex')
  if (hashCache.size > 2000) hashCache.clear()
  hashCache.set(key, { at: now(), hash })
  loadDiskHashes().set(key, hash)
  scheduleDiskHashSave()
  return hash
}

function modrinthLoader(loader) {
  const value = String(loader || '').toLowerCase()
  return ['fabric', 'quilt', 'forge', 'neoforge'].includes(value) ? value : ''
}

function publicVersion(version) {
  if (!version) return null
  return {
    id: version.id || '',
    number: version.version_number || '',
    name: version.name || version.version_number || '',
    type: version.version_type || '',
    date: version.date_published || '',
    downloads: Number(version.downloads) || 0
  }
}

function versionFile(version) {
  const files = Array.isArray(version?.files) ? version.files : []
  const file = files.find((item) => item.primary) || files[0]
  if (!file?.url) return null
  return {
    url: file.url,
    filename: file.filename || path.basename(String(file.url).split('?')[0]) || 'download.jar',
    size: Number(file.size) || 0,
    sha1: String(file.hashes?.sha1 || '').toLowerCase(),
    sha512: String(file.hashes?.sha512 || '').toLowerCase()
  }
}

/** Latest compatible version, preferring stable releases. */
function pickLatest(versions) {
  const list = (Array.isArray(versions) ? versions : []).filter((version) => versionFile(version))
  if (!list.length) return null
  const sorted = list.slice().sort((a, b) => Date.parse(b.date_published || 0) - Date.parse(a.date_published || 0))
  return sorted.find((version) => version.version_type === 'release') || sorted[0]
}

/** 小并发映射；用于在本地磁盘上同时计算多个 JAR 的 SHA-1。 */
async function mapLimited(items, limit, worker) {
  const list = Array.isArray(items) ? items : [...items]
  const out = new Array(list.length)
  let next = 0
  const run = async () => {
    for (;;) {
      const index = next++
      if (index >= list.length) return
      out[index] = await worker(list[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(list.length || 1, limit)) }, run))
  return out
}

/** 批量查询哈希对应的已安装版本 / 最新兼容版本；每批 100 个。 */
async function postVersionFiles(pathname, hashes, extra, { signal, fetcher } = {}) {
  const out = {}
  const parts = []
  for (let i = 0; i < hashes.length; i += BATCH_SIZE) parts.push(hashes.slice(i, i + BATCH_SIZE))
  // 每批互相独立：331 个模组拆成 4 批并发，耗时从 4 个来回降到约 1 个。
  const results = await Promise.all(parts.map(async (part) => {
    signal?.throwIfAborted()
    return await requestJson(`${MODRINTH}${pathname}`, {
      method: 'POST',
      body: { hashes: part, algorithm: 'sha1', ...extra },
      signal,
      fetcher
    })
  }))
  for (const data of results) {
    if (data && typeof data === 'object' && !Array.isArray(data)) Object.assign(out, data)
  }
  return out
}

/**
 * Check every installed mod against Modrinth in two batched requests.
 * @returns {Promise<{checkedAt:number,total:number,updates:Array,unknown:Array,items:Array}>}
 */
export async function findModUpdates(inst, { force = false, signal, fetcher } = {}) {
  const cached = updateCache.get(inst.id)
  if (!force && cached && now() - cached.at < UPDATE_TTL) return cached.value
  const paths = instancePaths(inst)
  const items = await scanModsDir(paths.modsDir, {
    recursive: true,
    includeDisabled: true,
    runtime: { mc: inst.mc, loader: inst.loader, loaderVersion: inst.loaderVersion },
    signal
  })
  const loader = modrinthLoader(inst.loader)
  const hashResults = await mapLimited(items, 4, async (item) => {
    try {
      return { hash: await sha1OfFile(item.path, { signal }), error: '' }
    } catch (error) {
      if (signal?.aborted) throw error
      return { hash: '', error: error.message }
    }
  })
  const hashes = [...new Set(hashResults.map((item) => item.hash).filter(Boolean))]
  let installedByHash = {}
  let latestByHash = {}
  let batchError = ''
  if (hashes.length) {
    try {
      const [installed, latest] = await Promise.all([
        postVersionFiles('/version_files', hashes, {}, { signal, fetcher }),
        postVersionFiles('/version_files/update', hashes, {
          loaders: loader ? [loader] : [],
          game_versions: inst.mc ? [inst.mc] : []
        }, { signal, fetcher })
      ])
      installedByHash = installed
      latestByHash = latest
    } catch (error) {
      if (signal?.aborted) throw error
      batchError = error.message
    }
  }

  const updates = []
  const unknown = []
  const checked = []
  items.forEach((item, index) => {
    const relPath = item.relPath
    const hashInfo = hashResults[index] || {}
    const base = { relPath, file: item.file, name: item.name || item.file }
    if (hashInfo.error) {
      unknown.push({ ...base, reason: 'error', message: hashInfo.error })
      return
    }
    if (batchError) {
      unknown.push({ ...base, reason: 'error', message: batchError })
      return
    }
    const installed = installedByHash[hashInfo.hash]
    if (!installed) {
      unknown.push({ ...base, reason: 'modrinth-not-found' })
      return
    }
    const latest = latestByHash[hashInfo.hash]
    if (!latest || !versionFile(latest)) {
      unknown.push({ ...base, reason: 'no-compatible-version' })
      return
    }
    const current = publicVersion(installed)
    const next = publicVersion(latest)
    const entry = {
      relPath,
      file: item.file,
      name: item.name || item.file,
      modid: item.modid || '',
      disabled: item.disabled === true,
      projectId: installed.project_id,
      current,
      latest: { ...next, file: versionFile(latest) }
    }
    checked.push(entry)
    const newer = latest.id !== installed.id &&
      Date.parse(latest.date_published || 0) > Date.parse(installed.date_published || 0)
    if (newer) updates.push(entry)
  })

  const value = {
    checkedAt: now(),
    total: items.length,
    updates,
    unknown,
    items: checked
  }
  // 批量接口整体失败时不能伪装成“这些模组都没收录”，否则用户会以为已经是最新。
  if (batchError && checked.length === 0 && items.length > 0) {
    throw new Error('检查更新失败：' + batchError)
  }
  updateCache.set(inst.id, { at: now(), value })
  if (updateCache.size > 100) updateCache.clear()
  return value
}

/* ------------------------------------------------------------------ */
/* Missing dependencies                                               */
/* ------------------------------------------------------------------ */

function normalizeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function matchScore(dep, hit) {
  const want = normalizeId(dep)
  const base = want.replace(/\d+$/, '')
  const slug = normalizeId(hit.slug)
  const title = normalizeId(hit.title)
  if (!want) return 0
  if (slug === want || title === want) return 100
  if (slug && (slug === base || slug.startsWith(base) || base.startsWith(slug))) return 85
  if (title && (title === base || title.startsWith(base))) return 80
  if (slug && (slug.includes(base) || base.includes(slug))) return 65
  if (title && title.includes(want)) return 60
  return 0
}

async function resolveDependency(inst, dep, { signal } = {}) {
  const key = `${inst.id}|${dep}|${inst.mc}|${inst.loader}`
  const hit = dependencyCache.get(key)
  if (hit && now() - hit.at < DEP_TTL) return hit.value
  const loader = modrinthLoader(inst.loader)
  const facets = [['project_type:mod']]
  if (inst.mc) facets.push([`versions:${inst.mc}`])
  if (loader) facets.push([`categories:${loader}`])
  const params = new URLSearchParams({
    query: String(dep || ''),
    limit: '8',
    index: 'relevance',
    facets: JSON.stringify(facets)
  })
  let value
  try {
    const data = await requestJson(`${MODRINTH}/search?${params}`, { signal })
    const hits = (Array.isArray(data?.hits) ? data.hits : []).map((item) => ({
      id: item.project_id || item.slug,
      slug: item.slug || '',
      title: item.title || item.slug || '',
      author: item.author || '',
      summary: item.description || '',
      icon: item.icon_url || '',
      downloads: Number(item.downloads) || 0,
      updated: item.date_modified || item.date_created || '',
      score: matchScore(dep, item)
    })).sort((a, b) => b.score - a.score || b.downloads - a.downloads)
    const best = hits[0]
    if (!best || best.score <= 0) {
      value = { id: dep, state: 'missing', candidates: hits.slice(0, 5) }
    } else if (best.score >= 80 || hits.length === 1) {
      const versions = await requestJson(`${MODRINTH}/project/${encodeURIComponent(best.id)}/version?` + new URLSearchParams({
        ...(inst.mc ? { game_versions: JSON.stringify([inst.mc]) } : {}),
        ...(loader ? { loaders: JSON.stringify([loader]) } : {})
      }), { signal })
      const latest = pickLatest(versions)
      const file = versionFile(latest)
      value = {
        id: dep,
        state: file ? 'ready' : 'missing',
        project: best,
        version: latest ? { ...publicVersion(latest), file } : null,
        candidates: hits.slice(0, 5)
      }
    } else {
      value = {
        id: dep,
        state: 'ambiguous',
        project: best,
        candidates: hits.slice(0, 5)
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error
    value = { id: dep, state: 'error', message: error.message, candidates: [] }
  }
  dependencyCache.set(key, { at: now(), value })
  if (dependencyCache.size > 500) dependencyCache.clear()
  return value
}

/**
 * Resolve every mandatory dependency that is not satisfied by an installed mod.
 * Results are best-effort: ambiguous names are returned as candidates instead of
 * silently installing a similarly named project.
 */
export async function resolveMissingDependencies(inst, { signal } = {}) {
  const data = await listMods(inst, { signal })
  const missing = [...new Set(data.missingDependencies || [])]
  const items = []
  for (const dep of missing) {
    if (signal?.aborted) throw signal.reason || new Error('已取消')
    items.push(await resolveDependency(inst, dep, { signal }))
  }
  return {
    missing,
    items,
    mods: (data.items || [])
      .filter((item) => (item.missingDependencies || []).length)
      .map((item) => ({ file: item.file, relPath: item.relPath, name: item.name || item.file, missing: item.missingDependencies }))
  }
}
