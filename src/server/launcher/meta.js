// Minecraft 元数据：版本清单、版本 JSON、资源索引、加载器版本与安装器地址。
//
// 所有 Mojang 资源都可以走 BMCLAPI 镜像；非 Mojang maven（Forge / Fabric）
// 保持原始地址，避免镜像缺文件时误判。auto 模式先镜像、失败自动回退官方。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { httpFetch } from '../http.js'
import { readJarEntries } from '../zip.js'
import * as servercore from '../servercore.js'
import { getSettings } from './state.js'
import { combineVersions } from './launch-plan.js'

export const OFFICIAL_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
export const BMCL_MANIFEST = 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'
export const FABRIC_META = 'https://meta.fabricmc.net/v2'
export const QUILT_META = 'https://meta.quiltmc.org/v3'
export const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge'
export const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge'
export const BMCL_MAVEN = 'https://bmclapi2.bangbang93.com/maven'
const UA = 'MC-Toolbox/1.8.0 (local launcher)'
const JSON_TIMEOUT = 25000

const cache = new Map()
function cached(key, ttl, loader) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < ttl) return hit.value
  const value = loader()
  cache.set(key, { at: Date.now(), value })
  return value
}

function sourceMode(source) {
  if (source) return source
  const settings = getSettings()
  return settings.source || 'auto'
}

/** Translate a Mojang URL to the BMCLAPI equivalent, if one is known. */
export function mirrorUrl(url) {
  const raw = String(url || '')
  const base = 'https://bmclapi2.bangbang93.com'
  let m
  if ((m = /^https?:\/\/(?:piston-meta|launchermeta)\.mojang\.com\/mc\/game\/version_manifest(?:_v2)?\.json(?:\?.*)?$/.exec(raw))) {
    return base + '/mc/game/version_manifest_v2.json'
  }
  if ((m = /^https?:\/\/piston-meta\.mojang\.com\/v1\/packages\/([^/]+)\/[^/]+\.json(?:\?.*)?$/.exec(raw))) {
    return `${base}/version/${encodeURIComponent(m[1])}/json`
  }
  if ((m = /^https?:\/\/piston-(?:meta|data)\.mojang\.com\/v1\/objects\/([0-9a-f]{40})(?:\?.*)?$/i.exec(raw))) {
    return `${base}/assets/${m[1].slice(0, 2)}/${m[1]}`
  }
  if ((m = /^https?:\/\/resources\.download\.minecraft\.net\/([0-9a-f]{2})\/([0-9a-f]{40})(?:\?.*)?$/i.exec(raw))) {
    return `${base}/assets/${m[1].toLowerCase()}/${m[2].toLowerCase()}`
  }
  if ((m = /^https?:\/\/libraries\.minecraft\.net\/(.+)$/.exec(raw))) {
    return `${base}/maven/${m[1]}`
  }
  // Forge / NeoForge 的 maven 在中国大陆经常不可达；BMCLAPI 提供同内容镜像。
  if ((m = /^https?:\/\/maven\.(?:neoforged\.net|minecraftforge\.net)\/(?:releases\/)?(.+)$/.exec(raw))) {
    return `${base}/maven/${m[1]}`
  }
  return ''
}

export function candidateUrls(url, { source } = {}) {
  const mode = sourceMode(source)
  const original = String(url || '')
  if (!original) return []
  if (mode === 'official') return [original]
  const mirrored = mirrorUrl(original)
  if (mode === 'bmclapi') return [mirrored || original]
  return [...new Set([mirrored, original].filter(Boolean))]
}

export function assetObjectUrls(hash, { source } = {}) {
  const clean = String(hash || '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(clean)) return []
  return candidateUrls(`https://resources.download.minecraft.net/${clean.slice(0, 2)}/${clean}`, { source })
}

export function libraryUrls(download, { source } = {}) {
  if (!download?.url) return []
  return candidateUrls(download.url, { source })
}

export async function fetchJson(url, { source, signal, timeout = JSON_TIMEOUT } = {}) {
  const urls = candidateUrls(url, { source })
  let lastError = null
  for (const target of urls) {
    try {
      const response = await httpFetch(target, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
        redirect: 'follow'
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (e) {
      if (signal?.aborted) throw e
      lastError = e
    }
  }
  throw new Error(`获取元数据失败：${lastError?.message || url}`)
}

export async function fetchText(url, { source, signal, timeout = JSON_TIMEOUT } = {}) {
  const urls = candidateUrls(url, { source })
  let lastError = null
  for (const target of urls) {
    try {
      const response = await httpFetch(target, {
        headers: { 'User-Agent': UA },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
        redirect: 'follow'
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.text()
    } catch (e) {
      if (signal?.aborted) throw e
      lastError = e
    }
  }
  throw new Error(`请求失败：${lastError?.message || url}`)
}

/* ------------------------------------------------------------------ */
/* Versions                                                            */
/* ------------------------------------------------------------------ */

export async function getManifest({ source, signal, force = false } = {}) {
  const mode = sourceMode(source)
  const key = `manifest:${mode}`
  if (force) cache.delete(key)
  return cached(key, 10 * 60 * 1000, async () => {
    return await fetchJson(OFFICIAL_MANIFEST, { source: mode, signal })
  })
}

export async function listGameVersions({ source, signal } = {}) {
  const manifest = await getManifest({ source, signal })
  return {
    latest: manifest.latest || {},
    versions: (manifest.versions || []).map((item) => ({
      id: item.id,
      type: item.type,
      releaseTime: item.releaseTime,
      url: item.url
    }))
  }
}

export async function getVersionEntry(id, { source, signal } = {}) {
  const manifest = await getManifest({ source, signal })
  const entry = (manifest.versions || []).find((item) => item.id === id)
  if (!entry) throw new Error('未找到 Minecraft 版本：' + id)
  return entry
}

export async function getVersionMeta(id, { source, signal } = {}) {
  const key = `version:${sourceMode(source)}:${id}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.value
  const entry = await getVersionEntry(id, { source, signal })
  const json = await fetchJson(entry.url, { source, signal })
  cache.set(key, { at: Date.now(), value: json })
  return json
}

export async function saveVersionJson(root, id, json) {
  const dir = path.join(root, 'versions', id)
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${id}.json`)
  await fsp.writeFile(file, JSON.stringify(json, null, 2), 'utf8')
  return file
}

export async function readJsonFile(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')) } catch { return null }
}

/**
 * Load a version JSON plus its whole `inheritsFrom` chain and merge it.
 * @returns {Promise<{version:object, chain:object[], rootId:string}>}
 */
export async function loadVersionChain(root, versionId) {
  const chain = []
  const seen = new Set()
  let current = versionId
  while (current) {
    if (seen.has(current)) throw new Error(`版本继承出现循环：${current}`)
    seen.add(current)
    const file = path.join(root, 'versions', current, `${current}.json`)
    const json = await readJsonFile(file)
    if (!json) {
      throw new Error(current === versionId
        ? `版本文件不存在：${file}`
        : `版本 ${versionId} 继承的 ${current} 不存在（${file}）`)
    }
    chain.push(json)
    current = json.inheritsFrom || ''
    if (chain.length > 12) throw new Error('版本继承层级过深')
  }

  let merged = chain[chain.length - 1]
  for (let i = chain.length - 2; i >= 0; i--) merged = combineVersions(chain[i], merged)
  const rootEntry = chain[chain.length - 1]
  return { version: merged, chain, rootId: rootEntry.id }
}

/* ------------------------------------------------------------------ */
/* Assets                                                              */
/* ------------------------------------------------------------------ */

export async function readAssetIndex(root, version) {
  const id = version?.assetIndex?.id || version?.assets
  if (!id) throw new Error('版本没有 assetIndex')
  const file = path.join(root, 'assets', 'indexes', `${id}.json`)
  const local = await readJsonFile(file)
  if (local) return { id, file, index: local }
  return { id, file, index: null }
}

/** Asset index URL from the version JSON (inherited field included). */
export function assetIndexInfo(version) {
  const info = version?.assetIndex
  if (!info) return null
  return {
    id: info.id,
    url: info.url,
    sha1: info.sha1,
    size: Number(info.size) || 0,
    totalSize: Number(info.totalSize) || 0
  }
}

export function versionJarName(version) {
  return version?.jar || version?.clientVersion || version?.id
}

/* ------------------------------------------------------------------ */
/* Loaders                                                             */
/* ------------------------------------------------------------------ */

const LAUNCHER_LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge']

export function supportedLoaders() {
  return LAUNCHER_LOADERS
}

export async function listLoaderVersions(loader, mc, { signal } = {}) {
  if (!LAUNCHER_LOADERS.includes(loader)) throw new Error('不支持的加载器：' + loader)
  if (!mc) throw new Error('缺少 Minecraft 版本')
  if (loader === 'vanilla') return [{ version: 'official', stable: true, label: '官方' }]
  const key = `loader:${loader}:${mc}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.value
  const items = await servercore.listLoaderVersions(loader, mc)
  const normalized = (items || []).map((item) => ({
    version: String(item.version),
    stable: item.stable !== false,
    label: item.label || ''
  })).filter((item) => item.version)
  cache.set(key, { at: Date.now(), value: normalized })
  return normalized
}

/** Fabric / Quilt profile JSON, adapted to our custom version id. */
export async function getModLoaderProfile(loader, mc, loaderVersion, { signal } = {}) {
  let url = ''
  if (loader === 'fabric') {
    url = `${FABRIC_META}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loaderVersion)}/profile/json`
  } else if (loader === 'quilt') {
    url = `${QUILT_META}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loaderVersion)}/profile/json`
  } else {
    throw new Error('该加载器不使用 profile JSON')
  }
  return await fetchJson(url, { source: 'official', signal })
}

export function customVersionId(loader, mc, loaderVersion) {
  const safe = String(loaderVersion || '').replace(/[^a-zA-Z0-9._-]/g, '_')
  return `${mc}-${loader}-${safe}`
}

/**
 * Resolve the Maven coordinates used by a Forge-family installer.
 * NeoForge 1.20.1 was published under `net.neoforged:forge` using Forge-style
 * version ids (`1.20.1-47.1.106`); 1.20.2+ moved to `net.neoforged:neoforge`.
 */
export function forgeInstaller(loader, mc, loaderVersion) {
  if (loader === 'forge') {
    const full = `${mc}-${loaderVersion}`
    return {
      url: `${FORGE_MAVEN}/${encodeURIComponent(full)}/forge-${encodeURIComponent(full)}-installer.jar`,
      mirrorUrl: `${BMCL_MAVEN}/net/minecraftforge/forge/${encodeURIComponent(full)}/forge-${encodeURIComponent(full)}-installer.jar`,
      filename: `forge-${full}-installer.jar`,
      expectedId: `${mc}-forge-${loaderVersion}`
    }
  }
  if (loader === 'neoforge') {
    const legacy = mc === '1.20.1'
    const group = legacy ? 'forge' : 'neoforge'
    const version = legacy ? `${mc}-${loaderVersion}` : String(loaderVersion)
    const artifact = legacy ? `forge-${version}` : `neoforge-${version}`
    const expectedId = legacy ? `${mc}-forge-${loaderVersion}` : `neoforge-${loaderVersion}`
    return {
      url: `https://maven.neoforged.net/releases/net/neoforged/${group}/${encodeURIComponent(version)}/${artifact}-installer.jar`,
      mirrorUrl: `${BMCL_MAVEN}/net/neoforged/${group}/${encodeURIComponent(version)}/${artifact}-installer.jar`,
      filename: `${artifact}-installer.jar`,
      expectedId
    }
  }
  throw new Error('不是 Forge 系加载器')
}

/** Read `version.json` from an installer JAR to know the installed version id. */
export async function readInstallerVersion(file) {
  try {
    const entries = await readJarEntries(file, ['version.json', 'install_profile.json'], { maxBytes: 4 * 1024 * 1024 })
    const raw = entries['version.json']
    if (!raw) return null
    const json = JSON.parse(raw.toString('utf8'))
    return { id: json.id || '', inheritsFrom: json.inheritsFrom || '', json }
  } catch { return null }
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

export function clearMetaCache() {
  cache.clear()
}
