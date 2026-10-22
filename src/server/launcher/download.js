// 启动器下载器 —— 校验、镜像回退、并发池、取消。
//
// 关键点：
//  - 先写临时文件，校验 SHA-1 / 长度通过后才改名，断电不会留下半个 JAR；
//  - 已存在的文件在 verify 开启时重新算 SHA-1，避免用户手动替换成坏文件；
//  - 自动镜像（BMCLAPI）失败会回退到 Mojang 原始地址；
//  - 30 秒没有收到数据即中止并重试，避免“卡在 0%”的假死。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { httpFetch } from '../http.js'

const STALL_MS = 30000

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

/**
 * Download one URL to a file with hash/size verification.
 * @returns {Promise<{cached:boolean,size:number}>}
 */
export async function fetchToFile(url, target, {
  sha1 = '',
  size = 0,
  signal,
  verify = true,
  retries = 0,
  maxBytes = 2 * 1024 ** 3,
  onProgress,
  headers = {}
} = {}) {
  const existing = await reuseExisting(target, { sha1, size, verify })
  if (existing) {
    onProgress?.({ received: existing.size, total: size || existing.size, cached: true })
    return { cached: true, size: existing.size }
  }

  await fsp.mkdir(path.dirname(target), { recursive: true })
  let lastError = null
  for (let attempt = 0; attempt <= Math.max(0, Number(retries) || 0); attempt++) {
    signal?.throwIfAborted()
    // 逐次拉长等待：跨境线路的短暂重置通常 1–3 秒内恢复，固定 350ms 太短。
    if (attempt > 0) await sleep(Math.min(10000, 700 * 2 ** (attempt - 1)), signal)
    const partial = `${target}.part-${crypto.randomUUID()}`
    let handle = null
    let controller = null
    let stallTimer = null
    try {
      controller = new AbortController()
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      const resetStall = () => {
        clearTimeout(stallTimer)
        stallTimer = setTimeout(() => controller.abort(new Error('下载超时：30 秒没有收到数据')), STALL_MS)
      }
      resetStall()
      const response = await httpFetch(url, { signal: combined, headers, redirect: 'follow' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const declared = Number(size || response.headers.get('content-length')) || 0
      if (declared > maxBytes) throw new Error('文件超过允许的大小')
      handle = await fsp.open(partial, 'wx')
      const digest = crypto.createHash('sha1')
      let received = 0
      for await (const chunk of response.body) {
        signal?.throwIfAborted()
        resetStall()
        received += chunk.length
        if (received > maxBytes) throw new Error('文件超过允许的大小')
        digest.update(chunk)
        await handle.writeFile(chunk)
        onProgress?.({ received, total: declared || Number(size) || 0 })
      }
      clearTimeout(stallTimer)
      stallTimer = null
      // 有 SHA-1 时以哈希为准：清单里的 size 可能来自另一次上传，差几个字节
      // 并不代表内容不对。没有哈希可用时才退回长度校验。
      if (sha1) {
        if (digest.digest('hex').toLowerCase() !== String(sha1).toLowerCase()) throw new Error('SHA-1 校验失败')
      } else if (size > 0 && received !== size) {
        throw new Error(`长度校验失败（${received} / ${size} 字节）`)
      }
      await handle.close(); handle = null
      signal?.throwIfAborted()
      await fsp.rename(partial, target)
      return { cached: false, size: received }
    } catch (e) {
      clearTimeout(stallTimer)
      lastError = e
      if (signal?.aborted) throw signal.reason || new Error('已取消')
      // 404/403 is not worth retrying the same URL.
      if (/HTTP 40[134]/.test(e.message)) break
    } finally {
      clearTimeout(stallTimer)
      if (handle) await handle.close().catch(() => {})
      await fsp.rm(partial, { force: true }).catch(() => {})
    }
  }
  throw lastError || new Error('下载失败')
}

/** Try a list of mirrors in order; each URL gets its own retry budget. */
export async function downloadFromMirrors(urls, target, options = {}) {
  const list = [...new Set((Array.isArray(urls) ? urls : [urls]).filter(Boolean))]
  if (!list.length) throw new Error('没有可用的下载地址')
  let lastError = null
  for (let i = 0; i < list.length; i++) {
    try {
      return await fetchToFile(list[i], target, { ...options, retries: i === 0 ? (options.retries ?? 2) : 1 })
    } catch (e) {
      if (options.signal?.aborted) throw e
      lastError = e
    }
  }
  const name = path.basename(target)
  throw new Error(`${name} 下载失败：${lastError?.message || '未知错误'}`)
}

/**
 * Run a worker over items with bounded concurrency.
 * The first error aborts the pool (workers stop pulling new items).
 */
export async function runPool(items, worker, concurrency = 8, signal) {
  const list = Array.isArray(items) ? items : [...items]
  const limit = Math.max(1, Math.min(32, Number(concurrency) || 8))
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
