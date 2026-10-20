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
import { scanModsDir } from '../mods.js'
import { instancePaths } from './state.js'
import { listMods } from './content.js'

const MODRINTH = 'https://api.modrinth.com/v2'
const UA = 'MC-Toolbox/1.8.0 (local launcher)'
const HASH_TTL = 30 * 60 * 1000
const UPDATE_TTL = 5 * 60 * 1000
const DEP_TTL = 10 * 60 * 1000
const REQUEST_TIMEOUT = 15000

const hashCache = new Map()
const updateCache = new Map()
const dependencyCache = new Map()

function now() { return Date.now() }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function requestJson(url, { signal, timeout = REQUEST_TIMEOUT } = {}) {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(500 * attempt)
    signal?.throwIfAborted()
    try {
      const res = await httpFetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
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

/** SHA-1 of a mod JAR, cached by path/size/mtime so repeated checks are cheap. */
export async function sha1OfFile(file, { signal } = {}) {
  const stat = await fsp.stat(file)
  const key = `${path.resolve(file)}|${stat.size}|${Math.round(stat.mtimeMs)}`
  const hit = hashCache.get(key)
  if (hit && now() - hit.at < HASH_TTL) return hit.hash
  signal?.throwIfAborted()
  const digest = crypto.createHash('sha1')
  for await (const chunk of fs.createReadStream(file)) {
    signal?.throwIfAborted()
    digest.update(chunk)
  }
  const hash = digest.digest('hex')
  if (hashCache.size > 2000) hashCache.clear()
  hashCache.set(key, { at: now(), hash })
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

/**
 * Check every installed mod against Modrinth's file-hash lookup.
 * @returns {Promise<{checkedAt:number,total:number,updates:Array,unknown:Array,items:Array}>}
 */
export async function findModUpdates(inst, { force = false, signal } = {}) {
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
  const updates = []
  const unknown = []
  const checked = []
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      if (signal?.aborted) throw signal.reason || new Error('已取消')
      const item = items[cursor++]
      const relPath = item.relPath
      try {
        const hash = await sha1OfFile(item.path, { signal })
        const installed = await requestJson(`${MODRINTH}/version_file/${hash}?algorithm=sha1`, { signal })
        if (installed?.__notFound) {
          unknown.push({ relPath, file: item.file, name: item.name || item.file, reason: 'modrinth-not-found' })
          continue
        }
        const params = new URLSearchParams()
        if (inst.mc) params.set('game_versions', JSON.stringify([inst.mc]))
        if (loader) params.set('loaders', JSON.stringify([loader]))
        const versions = await requestJson(
          `${MODRINTH}/project/${encodeURIComponent(installed.project_id)}/version?${params}`,
          { signal }
        )
        const latest = pickLatest(Array.isArray(versions) ? versions : [])
        if (!latest) {
          unknown.push({ relPath, file: item.file, name: item.name || item.file, reason: 'no-compatible-version' })
          continue
        }
        const current = publicVersion(installed)
        const next = publicVersion(latest)
        checked.push({
          relPath,
          file: item.file,
          name: item.name || item.file,
          modid: item.modid || '',
          disabled: item.disabled === true,
          projectId: installed.project_id,
          current,
          latest: { ...next, file: versionFile(latest) }
        })
        const newer = latest.id !== installed.id &&
          Date.parse(latest.date_published || 0) > Date.parse(installed.date_published || 0)
        if (newer) {
          updates.push({
            relPath,
            file: item.file,
            name: item.name || item.file,
            modid: item.modid || '',
            disabled: item.disabled === true,
            projectId: installed.project_id,
            current,
            latest: { ...next, file: versionFile(latest) }
          })
        }
      } catch (error) {
        if (signal?.aborted) throw error
        unknown.push({
          relPath,
          file: item.file,
          name: item.name || item.file,
          reason: 'error',
          message: error.message
        })
      }
    }
  }
  const concurrency = Math.max(1, Math.min(5, items.length))
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  const value = {
    checkedAt: now(),
    total: items.length,
    updates,
    unknown,
    items: checked
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
