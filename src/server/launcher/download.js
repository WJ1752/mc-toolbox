// 启动器下载器 —— 校验、镜像回退、测速选源、多线程分段、并发池、取消。
//
// 关键点：
//  - 先写临时文件，校验 SHA-1 / 长度通过后才改名，断电不会留下半个 JAR；
//  - 已存在的文件在 verify 开启时重新算 SHA-1，避免用户手动替换成坏文件；
//  - 自动模式下先测速，再决定走 BMCLAPI 还是官方源（失败自动回退另一个）；
//  - ≥4 MB 的文件用 Range 分段并发下载，和 PCL / HMCL 一样吃满带宽；
//  - 30 秒没有收到数据即中止并重试，避免“卡在 0%”的假死。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { httpFetch } from '../http.js'
import { knownSpeed, markRateLimited, pickFastestSource as pickFastestSourceRaw, rankCandidates, recordSample } from './source-select.js'

const STALL_MS = 30000
// 小于这个大小的文件分段反而更慢（建立连接的成本高于并行收益）。
const SEGMENT_MIN_BYTES = 4 * 1024 * 1024
const CHUNK_MIN = 1024 * 1024
const CHUNK_MAX = 8 * 1024 * 1024
const MAX_THREADS = 16
const PROBE_BYTES = 256 * 1024
const PROBE_TIMEOUT = 6000
const RANGE_PROBE_TIMEOUT = 15000

export async function sha1File(file) {
  const hash = crypto.createHash('sha1')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function fileExists(file) {
  try { return (await fsp.stat(file)).isFile() } catch { return false }
}

async function reuseExisting(target, { sha1 = '', size = 0, verify = true } = {}) {
  let stat
  try { stat = await fsp.stat(target) } catch { return null }
  if (!stat.isFile()) return null
  if (size > 0 && stat.size !== size) return null
  if (sha1) {
    if (!verify) return { size: stat.size }
    const digest = await sha1File(target)
    if (digest.toLowerCase() !== String(sha1).toLowerCase()) return null
  }
  return { size: stat.size }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('已取消'))
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(signal.reason || new Error('已取消')) }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** 分段下载时服务器忽略了 Range（返回 200）——退化成单连接重下。 */
class RangeUnsupported extends Error {}

/** HTTP 429：并发太高 / 触发镜像限流。单连接重试通常还能继续。 */
class RateLimited extends Error {
  constructor(message = 'HTTP 429（请求过于频繁，已自动降速）') {
    super(message)
    this.rateLimited = true
    this.status = 429
  }
}

/**
 * 测速：读取最多 `bytes` 字节就断开，按「收到字节 / 耗时」估算这条线路的吞吐。
 * 探测本身就是一次真实请求，所以对不支持 Range 的服务器也不会误判。
 */
export async function probeUrl(url, { signal, bytes = PROBE_BYTES, timeout = PROBE_TIMEOUT } = {}) {
  const limit = Math.max(1, Number(bytes) || PROBE_BYTES)
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let reader = null
  let received = 0
  try {
    const response = await httpFetch(url, {
      headers: { Range: `bytes=0-${limit - 1}` },
      signal: combined,
      redirect: 'follow'
    })
    if (!response.ok && response.status !== 206) {
      await response.body?.cancel?.().catch(() => {})
      return null
    }
    reader = response.body?.getReader?.() || null
    if (!reader) return null
    while (received < limit) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
    }
    return { bytes: received, ms: Math.max(1, Date.now() - started) }
  } catch {
    // 超时也保留已经收到的字节：0.2 MB/s 的线路本来就跑不完 256 KB。
    return received > 0 ? { bytes: received, ms: Math.max(1, Date.now() - started) } : null
  } finally {
    clearTimeout(timer)
    try { await reader?.cancel?.() } catch {}
  }
}

/** `Range: bytes=0-0` 探测：总长度 + 是否支持分段。只用于确实需要分段的大文件。 */
async function probeRange(url, { signal, headers = {}, timeout = RANGE_PROBE_TIMEOUT } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  try {
    const response = await httpFetch(url, {
      headers: { ...headers, Range: 'bytes=0-0' },
      signal: combined,
      redirect: 'follow'
    })
    const match = /bytes\s+\d+-\d+\/(\d+)/i.exec(response.headers.get('content-range') || '')
    const total = match ? Number(match[1]) : Number(response.headers.get('content-length')) || 0
    const ranges = response.status === 206 && Boolean(match)
    const ok = response.ok || response.status === 206
    await response.body?.cancel?.().catch(() => {})
    return { ok, ranges, total: Number.isFinite(total) ? total : 0 }
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error
    return { ok: false, ranges: false, total: 0 }
  } finally {
    clearTimeout(timer)
  }
}

/** 单连接下载：写到临时文件的当前位置，边下边报进度。 */
async function downloadSingle({ url, partial, signal, headers = {}, size = 0, onProgress, maxBytes }) {
  const controller = new AbortController()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let lastAt = Date.now()
  const watchdog = setInterval(() => {
    if (Date.now() - lastAt > STALL_MS) controller.abort(new Error('下载超时：30 秒没有收到数据'))
  }, 1000)
  let handle = null
  try {
    const response = await httpFetch(url, { signal: combined, headers, redirect: 'follow' })
    if (!response.ok) {
      const error = response.status === 429 ? new RateLimited() : new Error(`HTTP ${response.status}`)
      error.status = response.status
      await response.body?.cancel?.().catch(() => {})
      throw error
    }
    const declared = Number(size || response.headers.get('content-length')) || 0
    if (declared > maxBytes) throw new Error('文件超过允许的大小')
    handle = await fsp.open(partial, 'w')
    let received = 0
    if (response.body) {
      for await (const chunk of response.body) {
        if (combined.aborted) throw combined.reason || new Error('已取消')
        lastAt = Date.now()
        received += chunk.length
        if (received > maxBytes) throw new Error('文件超过允许的大小')
        await handle.writeFile(chunk)
        onProgress?.({ received, total: declared || Number(size) || 0 })
      }
    }
    return { received, total: declared || Number(size) || received }
  } catch (error) {
    if (error?.status) recordSample(url, { failed: true, status: error.status })
    else if (!signal?.aborted) recordSample(url, { failed: true })
    throw error
  } finally {
    clearInterval(watchdog)
    if (handle) await handle.close().catch(() => {})
  }
}

/** 把一块数据完整写到文件指定偏移：write() 理论上可能只写一部分。 */
async function writeAll(handle, buffer, position) {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset)
    if (!bytesWritten) throw new Error('写入磁盘失败')
    offset += bytesWritten
  }
}

/**
 * 分段下载：把文件切成 1–8 MB 的块，用 N 个连接并行取块并写入指定偏移。
 * 块是动态领取的（谁先完成谁拿下一块），慢连接不会拖住整条尾巴。
 */
async function downloadRanged({ url, partial, total, threads, signal, headers = {}, onProgress, maxBytes }) {
  const chunkSize = Math.max(CHUNK_MIN, Math.min(CHUNK_MAX, Math.ceil(total / (threads * 2))))
  const chunks = []
  for (let start = 0; start < total; start += chunkSize) {
    chunks.push({ start, end: Math.min(total - 1, start + chunkSize - 1) })
  }
  const handle = await fsp.open(partial, 'w')
  const abort = new AbortController()
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
  let received = 0
  let lastAt = Date.now()
  let nextIndex = 0
  const watchdog = setInterval(() => {
    if (Date.now() - lastAt > STALL_MS) abort.abort(new Error('下载超时：30 秒没有收到数据'))
  }, 1000)
  const worker = async () => {
    for (;;) {
      if (combined.aborted) throw combined.reason || new Error('已取消')
      const index = nextIndex++
      if (index >= chunks.length) return
      const { start, end } = chunks[index]
      const expected = end - start + 1
      const response = await httpFetch(url, {
        headers: { ...headers, Range: `bytes=${start}-${end}` },
        signal: combined,
        redirect: 'follow'
      })
      if (response.status === 200) {
        await response.body?.cancel?.().catch(() => {})
        throw new RangeUnsupported('服务器不支持分段下载')
      }
      if (!response.ok && response.status !== 206) {
        const error = response.status === 429 ? new RateLimited() : new Error(`HTTP ${response.status}`)
        error.status = response.status
        await response.body?.cancel?.().catch(() => {})
        throw error
      }
      const reader = response.body?.getReader?.()
      if (!reader) throw new Error('下载流不可用')
      let pos = start
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (pos + value.length > end + 1) throw new Error('分段返回的数据超过请求范围')
        await writeAll(handle, value, pos)
        pos += value.length
        received += value.length
        lastAt = Date.now()
        if (received > maxBytes) throw new Error('文件超过允许的大小')
        onProgress?.({ received, total })
      }
      if (pos !== end + 1) throw new Error(`分段下载不完整（${pos - start} / ${expected} 字节）`)
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(threads, chunks.length) }, () => worker()))
    if (received !== total) throw new Error(`分段下载不完整（${received} / ${total} 字节）`)
    return received
  } catch (error) {
    abort.abort(error)
    if (error?.status) recordSample(url, { failed: true, status: error.status })
    else if (!(error instanceof RangeUnsupported) && !signal?.aborted) recordSample(url, { failed: true })
    throw error
  } finally {
    clearInterval(watchdog)
    await handle.close().catch(() => {})
  }
}

/**
 * Download one URL to a file with hash/size verification.
 *
 * @param {object} options
 * @param {number} [options.threads] 大文件分段线程数（1 = 单连接）
 * @param {number} [options.expectedSize] 调用方已知的文件大小（只用于判断是否分段）
 * @returns {Promise<{cached:boolean,size:number}>}
 */
export async function fetchToFile(url, target, {
  sha1 = '',
  size = 0,
  expectedSize = 0,
  signal,
  verify = true,
  retries = 0,
  maxBytes = 2 * 1024 ** 3,
  onProgress,
  headers = {},
  threads = 1
} = {}) {
  const existing = await reuseExisting(target, { sha1, size, verify })
  if (existing) {
    onProgress?.({ received: existing.size, total: size || existing.size, cached: true })
    return { cached: true, size: existing.size }
  }

  await fsp.mkdir(path.dirname(target), { recursive: true })
  const wantThreads = Math.max(1, Math.min(MAX_THREADS, Number(threads) || 1))
  const hint = Math.max(0, Number(expectedSize) || 0)
  let lastError = null
  for (let attempt = 0; attempt <= Math.max(0, Number(retries) || 0); attempt++) {
    signal?.throwIfAborted()
    // 逐次拉长等待：跨境线路的短暂重置通常 1–3 秒内恢复，固定 350ms 太短。
    if (attempt > 0) await sleep(Math.min(10000, 700 * 2 ** (attempt - 1)), signal)
    const partial = `${target}.part-${crypto.randomUUID()}`
    const startedAt = Date.now()
    const downloadOnce = async (modeThreads) => {
      let known = hint || Number(size) || 0
      let outcome = null
      // 只有「已知是大文件」或「大小未知」时才值得多花一次 Range 探测：
      // 素材索引里成百上千的小文件直接单连接，省下探测请求。
      if (modeThreads > 1 && (known === 0 || known >= SEGMENT_MIN_BYTES)) {
        const head = await probeRange(url, { signal, headers })
        if (head.ranges && head.total >= SEGMENT_MIN_BYTES) {
          if (head.total > maxBytes) throw new Error('文件超过允许的大小')
          try {
            const received = await downloadRanged({
              url, partial, total: head.total, threads: modeThreads, signal, headers, onProgress, maxBytes
            })
            outcome = { received, total: head.total }
          } catch (error) {
            if (!(error instanceof RangeUnsupported)) throw error
            // 服务器 / 代理忽略了 Range：删掉半成品，退回单连接。
            await fsp.rm(partial, { force: true }).catch(() => {})
          }
        } else if (head.ok && head.total > 0) {
          known = head.total
        }
      }
      if (!outcome) {
        outcome = await downloadSingle({
          url, partial, signal, headers, size: known, onProgress, maxBytes
        })
      }
      return outcome
    }
    try {
      let outcome
      try {
        outcome = await downloadOnce(wantThreads)
      } catch (error) {
        // 429 通常是「并发太高」：先按单连接再试一次，而不是立刻换源。
        // 单连接仍然 429 时把这条线路短暂排到最后，交给另一个下载源。
        if (error?.rateLimited && wantThreads > 1 && !signal?.aborted) {
          markRateLimited(url)
          await fsp.rm(partial, { force: true }).catch(() => {})
          await sleep(600, signal)
          outcome = await downloadOnce(1)
        } else {
          throw error
        }
      }
      signal?.throwIfAborted()
      // 有 SHA-1 时以哈希为准：清单里的 size 可能来自另一次上传，差几个字节
      // 并不代表内容不对。分段下载必须从磁盘再算一次，顺序与分块无关。
      if (sha1) {
        const digest = await sha1File(partial)
        if (digest.toLowerCase() !== String(sha1).toLowerCase()) throw new Error('SHA-1 校验失败')
      } else if (size > 0 && outcome.received !== size) {
        throw new Error(`长度校验失败（${outcome.received} / ${size} 字节）`)
      }
      await fsp.rename(partial, target)
      recordSample(url, { bytes: outcome.received, ms: Date.now() - startedAt })
      return { cached: false, size: outcome.received }
    } catch (e) {
      lastError = e
      if (signal?.aborted) throw signal.reason || new Error('已取消')
      // 404/403 重试同一个地址没有意义；429 说明要换源或等一会儿，也不能原地重试。
      if (e?.rateLimited || /HTTP 40[134]/.test(e.message)) break
    } finally {
      await fsp.rm(partial, { force: true }).catch(() => {})
    }
  }
  throw lastError || new Error('下载失败')
}

/**
 * Try a list of mirrors in order; each URL gets its own retry budget.
 *
 * `rankBySpeed`（自动源）会先用一次轻量测速决定顺序，失败后再回退到另一个源；
 * 显式选择官方 / BMCL 镜像时传 false，保持用户给的顺序。
 */
export async function downloadFromMirrors(urls, target, options = {}) {
  const list = [...new Set((Array.isArray(urls) ? urls : [urls]).filter(Boolean))]
  if (!list.length) throw new Error('没有可用的下载地址')
  let ordered = list
  if (list.length > 1 && options.rankBySpeed !== false) {
    try {
      ordered = await rankCandidates(list, { probe: probeUrl, signal: options.signal })
    } catch (error) {
      if (options.signal?.aborted) throw error
      ordered = list
    }
  }
  let lastError = null
  for (let i = 0; i < ordered.length; i++) {
    try {
      return await fetchToFile(ordered[i], target, { ...options, retries: i === 0 ? (options.retries ?? 2) : 1 })
    } catch (e) {
      if (options.signal?.aborted) throw e
      lastError = e
    }
  }
  const name = path.basename(target)
  throw new Error(`${name} 下载失败：${lastError?.message || '未知错误'}`)
}

/**
 * 显式测速：用一个足够大的对象（例如素材索引里最大的音频）测出最快线路。
 * 返回 { url, speeds } —— speeds 供日志显示，方便用户理解为什么换了源。
 */
export async function pickFastestSource(urls, { signal } = {}) {
  const list = [...new Set((Array.isArray(urls) ? urls : [urls]).filter(Boolean))]
  if (list.length < 2) return { url: list[0] || '', speeds: [] }
  const best = await pickFastestSourceRaw(list, { probe: probeUrl, signal })
  return {
    url: best,
    speeds: list.map((url) => ({ url, bps: knownSpeed(url) || 0 }))
  }
}

/**
 * Run a worker over items with bounded concurrency.
 * The first error aborts the pool (workers stop pulling new items).
 */
export async function runPool(items, worker, concurrency = 8, signal) {
  const list = Array.isArray(items) ? items : [...items]
  const limit = Math.max(1, Math.min(64, Number(concurrency) || 8))
  let index = 0
  let failed = null
  const run = async () => {
    while (true) {
      if (failed) return
      signal?.throwIfAborted()
      const current = index++
      if (current >= list.length) return
      try {
        await worker(list[current], current)
      } catch (e) {
        failed = e
        throw e
      }
    }
  }
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, list.length || 1) }, run))
  const rejected = settled.find((item) => item.status === 'rejected')
  if (rejected) throw rejected.reason
  if (failed) throw failed
}

/** Best-effort directory size (used for instance summaries). */
export async function dirSize(dir, { signal, maxFiles = 20000 } = {}) {
  let total = 0
  let files = 0
  const walk = async (current) => {
    signal?.throwIfAborted()
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (files >= maxFiles) return
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        const stat = await fsp.stat(full).catch(() => null)
        if (stat) { total += stat.size; files++ }
      }
    }
  }
  await walk(dir)
  return { bytes: total, files }
}
