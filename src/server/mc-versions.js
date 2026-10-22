// Minecraft 版本清单：官方 manifest + BMCLAPI 回退，10 分钟缓存。
//
// 社区接口需要一个「这个 MC 版本是否真实存在」的校验。网络失败时绝不能
// 阻断搜索，只能回退为全部版本并给出中文提示；失败结果只短缓存 30 秒，
// 避免每次搜索都重新等待。这里不依赖 launcher/meta.js，避免形成
// meta → state → ... 的依赖链，也方便单独测试。
import { httpFetch } from './http.js'
import { isMinecraftVersion } from './launcher/version-detect.js'

export const OFFICIAL_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
export const BMCLAPI_MANIFEST_URL = 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'

const UA = 'MC-Toolbox/1.9.0 (local launcher)'
const CACHE_TTL = 10 * 60 * 1000
const FAILURE_TTL = 30 * 1000
const DEFAULT_TIMEOUT = 15000

// at: 最后成功/失败时间；ids: 成功时的版本列表（失败为空）；pending: 复用的并发请求。
let cache = { at: 0, ids: [], pending: null }

/** 把 manifest 响应整理成去重后的版本 id 列表（保持官方顺序）。 */
function normalizeManifestIds(data) {
  const list = Array.isArray(data?.versions) ? data.versions : []
  const ids = []
  const seen = new Set()
  for (const item of list) {
    const id = String(item?.id ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/** 依次尝试官方与 BMCLAPI；全部失败才抛错，由调用方降级。 */
async function fetchManifestIds({ fetcher, timeout }) {
  let lastError = null
  for (const url of [OFFICIAL_MANIFEST_URL, BMCLAPI_MANIFEST_URL]) {
    try {
      const response = await fetcher(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow'
      })
      if (!response || !response.ok) throw new Error(`HTTP ${response?.status ?? '未知'}`)
      const data = await response.json()
      const ids = normalizeManifestIds(data)
      if (!ids.length) throw new Error('版本清单为空')
      return ids
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('无法获取 Minecraft 版本清单')
}

/**
 * 列出 Minecraft 版本 id（含快照）。失败时返回空数组，绝不抛错阻断搜索。
 * @param {{force?: boolean, timeout?: number, fetcher?: Function}} options
 *   force: 跳过缓存重新拉取；fetcher: 测试注入（默认 httpFetch）。
 * @returns {Promise<string[]>}
 */
export async function listMinecraftVersionIds({ force = false, timeout = DEFAULT_TIMEOUT, fetcher = httpFetch } = {}) {
  const now = Date.now()
  if (!force) {
    if (cache.ids.length && now - cache.at < CACHE_TTL) return cache.ids.slice()
    if (!cache.ids.length && cache.at && now - cache.at < FAILURE_TTL) return []
    if (cache.pending) return cache.pending
  }
  const request = fetchManifestIds({ fetcher, timeout })
    .then((ids) => {
      cache = { at: Date.now(), ids, pending: null }
      return ids.slice()
    })
    .catch(() => {
      cache = { at: Date.now(), ids: [], pending: null }
      return []
    })
  cache = { at: cache.at, ids: cache.ids, pending: request }
  return request
}

/**
 * 校验社区资源搜索传入的 MC 版本。未知版本回退到全部版本并给出中文提示，
 * 不阻断搜索。
 * @param {string} value 用户输入 / 选项
 * @param {{fetcher?: Function, ids?: string[]}} options 测试可注入 fetcher 或 ids
 * @returns {Promise<{requested:string, applied:string, valid:boolean, formatValid:boolean, known:boolean, notice:string}>}
 */
export async function validateGameVersion(value, options = {}) {
  const requested = String(value ?? '').trim()
  // 空值或 all 都表示不限制版本。
  if (!requested || /^all$/i.test(requested)) {
    return { requested, applied: '', valid: true, formatValid: true, known: true, notice: '' }
  }

  const formatValid = isMinecraftVersion(requested)
  if (!formatValid) {
    return {
      requested,
      applied: '',
      valid: false,
      formatValid: false,
      known: false,
      notice: `「${requested}」不是有效的 MC 版本号，已按全部版本搜索。`
    }
  }

  let ids
  if (Array.isArray(options.ids)) {
    ids = options.ids.map((id) => String(id ?? '').trim()).filter(Boolean)
  } else {
    try {
      ids = await listMinecraftVersionIds({ fetcher: options.fetcher })
    } catch {
      ids = []
    }
  }

  if (ids.includes(requested)) {
    return { requested, applied: requested, valid: true, formatValid: true, known: true, notice: '' }
  }

  return {
    requested,
    applied: '',
    valid: false,
    formatValid: true,
    known: false,
    notice: ids.length
      ? `未识别 MC 版本「${requested}」，已按全部版本搜索。`
      : `暂时无法获取 Minecraft 版本清单，「${requested}」已按全部版本搜索。`
  }
}
