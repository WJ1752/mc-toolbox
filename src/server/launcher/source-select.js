// 下载源择优：给 BMCL 镜像与官方源做轻量测速，之后按实测吞吐排序。
//
// 为什么需要它：BMCLAPI 通常由国内线路直连，但它是按连接限速的；官方 CDN
// 在部分线路反而能跑满。把「镜像优先」写死会让一次 600 MB 的素材下载停在
// 0.2 MB/s —— PCL / HMCL 的自动源都是先测速再选线路，这里做同样的事。
//
// 只在「自动」模式生效：用户显式选了 BMCL 或官方时，调用方传 rankBySpeed:false。
const SOURCE_TTL = 10 * 60 * 1000
const PROBE_GAP = 5000
// 429 只封很短时间：BMCLAPI 的短窗口限流通常几秒就恢复，封太久会把用户
// 赶到更慢的线路上。
const RATE_LIMIT_BLOCK = 30 * 1000
// 小于这个字节数的样本只反映延迟，说明不了带宽（例如 1 KB 的图标）。
const STRONG_SAMPLE = 64 * 1024

// host -> { bps, at, failedAt, blockedUntil, lastProbeAt }
const stats = new Map()
// host -> 正在进行的探测；同一批 32 个并发下载不能各自探测一次。
const pending = new Map()

export function hostOf(url) {
  try {
    return new URL(String(url)).host.toLowerCase()
  } catch {
    return ''
  }
}

/** 测试用：清空记忆的线路速度。 */
export function resetSourceStats() {
  stats.clear()
  pending.clear()
}

/**
 * 记录一次实测吞吐。取窗口内的最大值：小文件的样本会被建立连接 / TTFB 主导，
 * 不能盖掉大文件测到的真实带宽；4xx 只代表「这条线路没有这个文件」，不降级。
 */
export function recordSample(url, { bytes = 0, ms = 0, failed = false, status = 0, now = Date.now() } = {}) {
  const host = hostOf(url)
  if (!host) return
  const entry = stats.get(host) || { bps: 0, at: 0, failedAt: 0, blockedUntil: 0, lastProbeAt: 0 }
  if (failed) {
    // 429 是「请求太多，过一会儿再来」，不是线路本身不可用：短封禁即可。
    if (Number(status) === 429) {
      entry.blockedUntil = now + RATE_LIMIT_BLOCK
      entry.failedAt = 0
      stats.set(host, entry)
      return
    }
    // 4xx 是「这个文件在这条线路不存在」，不代表线路本身慢，不能因此降级。
    if (status >= 400 && status < 500) {
      stats.set(host, entry)
      return
    }
    entry.failedAt = now
    stats.set(host, entry)
    return
  }
  const n = Number(bytes)
  const d = Number(ms)
  if (!(n >= STRONG_SAMPLE) || !(d > 0)) return
  const sample = n / (d / 1000)
  const fresh = entry.at > 0 && now - entry.at < SOURCE_TTL
  if (!fresh || sample > entry.bps) {
    entry.bps = sample
    entry.at = now
  }
  entry.failedAt = 0
  entry.blockedUntil = 0
  stats.set(host, entry)
}

/** 记录一次限流（429）：在短窗口内把它排到最后，让下载换条线路。 */
export function markRateLimited(url, { now = Date.now() } = {}) {
  const host = hostOf(url)
  if (!host) return
  const entry = stats.get(host) || { bps: 0, at: 0, failedAt: 0, blockedUntil: 0, lastProbeAt: 0 }
  entry.blockedUntil = now + RATE_LIMIT_BLOCK
  stats.set(host, entry)
}

/** 已知吞吐（B/s）；0 = 最近连接失败或被限流；null = 还没测过。 */
export function knownSpeed(url, now = Date.now()) {
  const entry = stats.get(hostOf(url))
  if (!entry) return null
  if (entry.blockedUntil && entry.blockedUntil > now) return 0
  if (entry.failedAt && now - entry.failedAt < SOURCE_TTL) return 0
  if (entry.bps > 0 && entry.at && now - entry.at < SOURCE_TTL) return entry.bps
  return null
}

/** 按实测吞吐排序；未知线路保持调用方给的顺序，确认失败的排到最后。 */
export function orderByStats(urls, { now = Date.now() } = {}) {
  const scored = (Array.isArray(urls) ? urls : []).map((url, index) => {
    const speed = knownSpeed(url, now)
    return { url, index, score: speed === null ? -1 : speed > 0 ? speed : -2 }
  })
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index))
  return scored.map((item) => item.url)
}

/**
 * 探测每条候选线路（同一 host 去重），返回按速度排好的地址。
 * probe(url, { signal }) 需要返回 { bytes, ms } 或 null。
 */
export async function rankCandidates(urls, { probe, signal, force = false, minBytes = STRONG_SAMPLE } = {}) {
  const list = [...new Set((Array.isArray(urls) ? urls : []).filter(Boolean))]
  if (list.length < 2 || typeof probe !== 'function') return list
  await Promise.all(list.map((url) => probeHost(url, probe, { signal, force, minBytes })))
  return orderByStats(list)
}

async function probeHost(url, probe, { signal, force, minBytes }) {
  const host = hostOf(url)
  if (!host) return
  const now = Date.now()
  const entry = stats.get(host) || {}
  if (!force) {
    if (knownSpeed(url, now) !== null) return
    // 首批小文件会同时触发探测；限流避免每个文件都多一条请求。
    if (entry.lastProbeAt && now - entry.lastProbeAt < PROBE_GAP) return
  } else if (entry.blockedUntil && entry.blockedUntil > now) {
    // 刚被限流的线路不再强制探测，否则探测本身也会 429。
    return
  }
  if (pending.has(host)) return pending.get(host)
  const task = (async () => {
    let result = null
    try {
      result = await probe(url, { signal })
    } catch {
      result = null
    }
    const at = Date.now()
    if (result && result.bytes >= minBytes && result.ms > 0) {
      recordSample(url, { ...result, now: at })
    } else {
      const current = stats.get(host) || {}
      // 样本太小说明不了带宽：只记住「刚探过」，等大文件再测。
      stats.set(host, { ...current, lastProbeAt: at })
    }
  })().finally(() => {
    if (pending.get(host) === task) pending.delete(host)
  })
  pending.set(host, task)
  return task
}

/**
 * 显式测速：拿到一个「足够大」的对象地址（例如素材索引里最大的声音文件），
 * 强制重新测量每条线路，并把结果写回记忆。返回最快的地址（没有候选时返回 ''）。
 */
export async function pickFastestSource(urls, { probe, signal } = {}) {
  const list = [...new Set((Array.isArray(urls) ? urls : [urls]).filter(Boolean))]
  if (!list.length || typeof probe !== 'function') return list[0] || ''
  if (list.length === 1) return list[0]
  const ordered = await rankCandidates(list, { probe, signal, force: true })
  return ordered[0] || ''
}
