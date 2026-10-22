import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { httpFetch } from './http.js'

const STALL_MS = 60000

export async function downloadVerified(url, target, { signal, size, hash, algorithm = 'sha256', onProgress, maxBytes = 1024 ** 3, idleTimeout = STALL_MS } = {}) {
  const partial = target + '.part-' + crypto.randomUUID()
  await fs.mkdir(path.dirname(target), { recursive: true })
  // 用「无数据超时」而不是总时长超时：大文件在慢速线路上下载十几分钟很正常，
  // 固定 5 分钟会把正常下载腰斩。
  const controller = new AbortController()
  let stallTimer = null
  const resetStall = () => {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      controller.abort(new Error(`下载超时：${Math.round(idleTimeout / 1000)} 秒没有收到数据`))
    }, idleTimeout)
  }
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let handle
  try {
    resetStall()
    const response = await httpFetch(url, { signal: combined, redirect: 'follow' })
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    const total = Number(size || response.headers.get('content-length')) || 0
    if (total > maxBytes) throw new Error('下载文件过大')
    handle = await fs.open(partial, 'wx')
    const digest = crypto.createHash(algorithm)
    let received = 0
    for await (const chunk of response.body) {
      resetStall()
      signal?.throwIfAborted()
      received += chunk.length
      if (received > maxBytes) throw new Error('下载文件超过大小限制')
      digest.update(chunk)
      await handle.writeFile(chunk)
      onProgress?.({ received, total })
    }
    clearTimeout(stallTimer)
    stallTimer = null
    // 有哈希时以哈希为准：调用方传入的 size 来自清单，可能和 CDN 上的文件
    // 差几个字节，不能因此判定下载失败。
    if (hash) {
      if (digest.digest('hex').toLowerCase() !== hash.toLowerCase()) throw new Error('下载文件哈希校验失败')
    } else if (total && received !== total) {
      throw new Error('下载长度校验失败')
    }
    await handle.close(); handle = null
    signal?.throwIfAborted()
    await fs.rename(partial, target)
    return target
  } finally {
    clearTimeout(stallTimer)
    await handle?.close().catch(() => {})
    await fs.rm(partial, { force: true }).catch(() => {})
  }
}
