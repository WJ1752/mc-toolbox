// 在线整合包解析：把 Modrinth / CurseForge 的项目与版本信息转成统一的下载描述。
//
// 本模块只请求元数据，不下载整合包本体；所有请求都走 httpFetch（代理设置生效），
// 超时 20 秒，错误统一为中文，方便前端直接展示。
import path from 'node:path'
import { httpFetch } from '../http.js'

const MODRINTH = 'https://api.modrinth.com/v2'
const CURSEFORGE = 'https://api.curseforge.com/v1'
const REQUEST_TIMEOUT = 20000
const USER_AGENT = 'mc-toolbox/1.0 (launcher)'

export const CURSEFORGE_API_KEY_MESSAGE = '未配置 CurseForge API Key。请在「设置 → 社区资源」填写 Eternal API Key，或改用 Modrinth 搜索整合包。'

const CF_MOD_LOADER_NAMES = { 1: 'forge', 2: 'cauldron', 3: 'liteloader', 4: 'fabric', 5: 'quilt', 6: 'neoforge' }
const CF_RELEASE_TYPES = ['release', 'beta', 'alpha']
const CF_LOADER_NAMES = new Set(['forge', 'fabric', 'quilt', 'neoforge', 'liteloader', 'cauldron'])

/** 组合「外部取消信号」与「请求超时」，Node 18.17+ 支持 AbortSignal.any。 */
function requestSignal(signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT)
  if (!signal) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout])
  return signal
}

function httpUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    return /^https?:$/.test(parsed.protocol) ? parsed.toString() : ''
  } catch {
    return ''
  }
}

async function requestJson(fetcher, url, { headers = {}, label = '接口', signal } = {}) {
  let response
  try {
    response = await fetcher(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal: requestSignal(signal) })
  } catch (e) {
    if (signal?.aborted) throw signal.reason || new Error('已取消')
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new Error(`${label}请求超时（${REQUEST_TIMEOUT / 1000} 秒），请检查网络或代理设置`)
    }
    throw new Error(`${label}请求失败：${e?.message || '网络错误'}`)
  }
  if (!response?.ok) {
    const status = Number(response?.status) || 0
    let message
    if (status === 404) message = `未找到${label}（HTTP 404），可能已下架或链接有误`
    else if (status === 401 || status === 403) message = `${label}鉴权失败（HTTP ${status}），请检查 API Key 是否有效`
    else message = `${label}请求失败（HTTP ${status || '未知'}）`
    const error = new Error(message)
    error.status = status
    throw error
  }
  try {
    return await response.json()
  } catch {
    throw new Error(`${label}返回了无法解析的数据`)
  }
}

function cfLoadersFromGameVersions(gameVersions) {
  const out = []
  for (const value of Array.isArray(gameVersions) ? gameVersions : []) {
    const name = String(value || '').toLowerCase()
    if (CF_LOADER_NAMES.has(name) && !out.includes(name)) out.push(name)
  }
  return out
}

function pickModrinthVersion(list) {
  const versions = Array.isArray(list) ? list : []
  const hasPackFile = (v) => (Array.isArray(v?.files) ? v.files : []).some((f) => /\.(mrpack|zip)$/i.test(String(f?.filename || '')))
  return versions.find((v) => v?.version_type === 'release' && hasPackFile(v)) || versions.find(hasPackFile) || versions[0] || null
}

function pickModrinthFile(version) {
  const files = Array.isArray(version?.files) ? version.files : []
  const usable = files.filter((file) => httpUrl(file?.url) && String(file?.filename || '').trim())
  const packs = usable.filter((file) => /\.(mrpack|zip)$/i.test(String(file.filename || '')))
  return packs.find((file) => file.primary) || packs[0] || usable.find((file) => file.primary) || usable[0] || null
}

async function loadModrinthVersion({ projectId, versionId, fetcher, signal }) {
  const id = String(projectId || '').trim()
  if (versionId) {
    try {
      return await requestJson(fetcher, `${MODRINTH}/project/${encodeURIComponent(id)}/version/${encodeURIComponent(versionId)}`, {
        label: 'Modrinth 版本信息',
        signal
      })
    } catch (e) {
      if (signal?.aborted) throw e
      if (e.status !== 404) throw e
      // 兼容旧前端把版本号当版本 ID 传入：回退到版本列表按 id / version_number 匹配。
      const list = await requestJson(fetcher, `${MODRINTH}/project/${encodeURIComponent(id)}/version`, {
        label: 'Modrinth 版本列表',
        signal
      })
      const matched = (Array.isArray(list) ? list : []).find((v) => String(v?.id) === String(versionId) || String(v?.version_number) === String(versionId))
      if (matched) return matched
      throw e
    }
  }
  const list = await requestJson(fetcher, `${MODRINTH}/project/${encodeURIComponent(id)}/version`, {
    label: 'Modrinth 版本列表',
    signal
  })
  const version = pickModrinthVersion(list)
  if (!version) throw new Error('该 Modrinth 项目没有可下载的整合包版本')
  return version
}

async function resolveModrinth({ projectId, versionId, fetcher, signal }) {
  const id = String(projectId || '').trim()
  if (!id) throw new Error('缺少 Modrinth 项目 ID')
  const version = await loadModrinthVersion({ projectId: id, versionId, fetcher, signal })
  if (!version || typeof version !== 'object' || Array.isArray(version)) throw new Error('Modrinth 版本信息格式无效')
  const file = pickModrinthFile(version)
  if (!file) throw new Error('Modrinth 整合包版本没有可下载的文件')
  const filename = String(file.filename || '').trim()
  if (!filename) throw new Error('Modrinth 整合包文件缺少文件名')
  const size = Number(file.size) || 0
  if (size <= 0) throw new Error('Modrinth 整合包文件缺少大小信息')
  const hashes = {}
  if (file.hashes?.sha1) hashes.sha1 = String(file.hashes.sha1)
  if (file.hashes?.sha512) hashes.sha512 = String(file.hashes.sha512)
  if (!Object.keys(hashes).length) throw new Error('Modrinth 整合包文件缺少哈希校验值')

  // 项目页信息（标题 / 图标 / 链接）不是下载必需，失败时退回版本信息。
  let project = {}
  const realProjectId = String(version.project_id || id)
  try {
    const data = await requestJson(fetcher, `${MODRINTH}/project/${encodeURIComponent(realProjectId)}`, {
      label: 'Modrinth 项目信息',
      signal
    })
    if (data && typeof data === 'object' && !Array.isArray(data)) project = data
  } catch (e) {
    if (signal?.aborted) throw e
    project = {}
  }

  const slug = String(project.slug || id)
  const projectType = String(project.project_type || 'modpack')
  return {
    source: 'modrinth',
    format: /\.mrpack$/i.test(filename) ? 'mrpack' : 'zip',
    url: httpUrl(file.url),
    filename,
    size,
    hashes,
    project: {
      id: realProjectId,
      title: String(project.title || version.name || id),
      slug,
      icon: project.icon_url || null,
      author: String(project.author || ''),
      url: `https://modrinth.com/${projectType}/${slug}`
    },
    version: {
      id: String(version.id || versionId || ''),
      name: String(version.name || version.version_number || ''),
      number: String(version.version_number || version.name || ''),
      type: String(version.version_type || 'release'),
      date: String(version.date_published || ''),
      gameVersions: Array.isArray(version.game_versions) ? version.game_versions : [],
      loaders: Array.isArray(version.loaders) ? version.loaders : []
    }
  }
}

function cfEdgeUrl(fileId, fileName) {
  const id = String(fileId || '').replace(/\D/g, '')
  if (!id) return ''
  const first = id.padStart(4, '0').slice(0, 4)
  const last = id.padStart(3, '0').slice(-3)
  return `https://edge.forgecdn.net/files/${first}/${last}/${fileName}`
}

function pickCfFile(files) {
  const list = Array.isArray(files) ? files : []
  return list.find((file) => Number(file?.releaseType) === 1) || list[0] || null
}

async function resolveCurseForge({ projectId, versionId, apiKey, fetcher, signal }) {
  const key = String(apiKey || '').trim()
  if (!key) {
    const error = new Error(CURSEFORGE_API_KEY_MESSAGE)
    error.code = 'CURSEFORGE_API_KEY'
    throw error
  }
  const id = String(projectId || '').trim()
  if (!id) throw new Error('缺少 CurseForge 项目 ID')
  const headers = { 'x-api-key': key }

  let project = null
  try {
    const body = await requestJson(fetcher, `${CURSEFORGE}/mods/${encodeURIComponent(id)}`, {
      headers,
      label: 'CurseForge 项目信息',
      signal
    })
    project = body?.data || null
  } catch (e) {
    if (signal?.aborted) throw e
    if (e.status === 401 || e.status === 403) throw e
    project = null
  }

  const fileId = String(versionId || '').trim()
  let file = null
  if (fileId) {
    const body = await requestJson(fetcher, `${CURSEFORGE}/mods/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`, {
      headers,
      label: 'CurseForge 文件信息',
      signal
    })
    file = body?.data || null
  } else {
    const body = await requestJson(fetcher, `${CURSEFORGE}/mods/${encodeURIComponent(id)}/files?pageSize=50`, {
      headers,
      label: 'CurseForge 文件列表',
      signal
    })
    file = pickCfFile(body?.data)
  }
  if (!file) throw new Error('该 CurseForge 项目没有可下载的整合包文件')

  const filename = String(file.fileName || '').trim()
  if (!filename || path.basename(filename) !== filename || /[\\/]/.test(filename)) {
    throw new Error('CurseForge 返回的整合包文件名无效，已停止安装')
  }
  const numericFileId = String(file.id || fileId || '')

  // CurseForge 只提供 download-url 接口；接口异常时使用官方 CDN 直链兜底。
  let url = ''
  if (numericFileId) {
    try {
      const body = await requestJson(fetcher, `${CURSEFORGE}/mods/${encodeURIComponent(id)}/files/${encodeURIComponent(numericFileId)}/download-url`, {
        headers,
        label: 'CurseForge 下载地址',
        signal
      })
      url = httpUrl(body?.data)
    } catch (e) {
      if (signal?.aborted) throw e
      // 下载地址接口在作者关闭第三方分发等情况下会失败，统一交给 CDN 直链兜底。
    }
  }
  if (!url) url = httpUrl(cfEdgeUrl(numericFileId, filename))
  if (!url) throw new Error('无法获取 CurseForge 整合包下载地址')

  const gameVersions = Array.isArray(file.gameVersions) ? file.gameVersions.filter((v) => typeof v === 'string') : []
  const loaders = cfLoadersFromGameVersions(gameVersions)
  const sha1 = (Array.isArray(file.hashes) ? file.hashes : []).find((h) => Number(h?.algo) === 1)?.value
  const hashes = sha1 ? { sha1: String(sha1) } : {}
  const slug = String(project?.slug || '')
  const projectName = String(project?.name || file.displayName || filename)
  const projectUrl = String(project?.links?.websiteUrl || (slug ? `https://www.curseforge.com/minecraft/modpacks/${slug}` : ''))
  const releaseType = CF_RELEASE_TYPES[Number(file.releaseType) - 1] || 'release'

  return {
    source: 'curseforge',
    format: /\.mrpack$/i.test(filename) ? 'mrpack' : 'zip',
    url,
    filename,
    size: Number(file.fileLength) || 0,
    hashes,
    project: {
      id: String(project?.id || id),
      title: projectName,
      slug,
      icon: project?.logo?.url || project?.logo?.thumbnailUrl || null,
      author: (Array.isArray(project?.authors) ? project.authors : []).map((a) => a?.name).filter(Boolean).join(', '),
      url: projectUrl
    },
    version: {
      id: String(file.id || fileId || ''),
      name: String(file.displayName || filename),
      number: String(file.displayName || filename),
      type: releaseType,
      date: String(file.fileDate || ''),
      gameVersions,
      loaders
    }
  }
}

/**
 * 解析在线整合包的下载信息（只解析元数据，不下载本体）。
 * @param {object} options
 * @param {'modrinth'|'curseforge'} options.source
 * @param {string|number} options.projectId
 * @param {string|number} [options.versionId]
 * @param {string} [options.apiKey] CurseForge Eternal API Key
 * @param {Function} [options.fetcher] 依赖注入，默认 httpFetch
 * @param {AbortSignal} [options.signal] 可选取消信号
 */
export async function resolveOnlinePack({
  source,
  projectId,
  versionId = '',
  apiKey = '',
  fetcher = httpFetch,
  signal
} = {}) {
  const kind = String(source || '').trim().toLowerCase()
  if (kind === 'modrinth') return resolveModrinth({ projectId, versionId, fetcher, signal })
  if (kind === 'curseforge') return resolveCurseForge({ projectId, versionId, apiKey, fetcher, signal })
  throw new Error('不支持的整合包来源：' + (source || '（空）'))
}
