import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { httpFetch } from './http.js'

export async function downloadVerified(url, target, { signal, size, hash, algorithm = 'sha256', onProgress, maxBytes = 1024 ** 3 } = {}) {
  const partial = target + '.part-' + crypto.randomUUID()
  await fs.mkdir(path.dirname(target), { recursive: true })
  let handle
  try {
    const response = await httpFetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000), redirect: 'follow' })
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    const total = Number(size || response.headers.get('content-length')) || 0
    if (total > maxBytes) throw new Error('下载文件过大')
    handle = await fs.open(partial, 'wx')
    const digest = crypto.createHash(algorithm)
    let received = 0
    for await (const chunk of response.body) {
      signal?.throwIfAborted()
      received += chunk.length
      if (received > maxBytes) throw new Error('下载文件超过大小限制')
      digest.update(chunk)
      await handle.writeFile(chunk)
      onProgress?.({ received, total })
    }
    if (total && received !== total) throw new Error('下载长度校验失败')
    if (hash && digest.digest('hex').toLowerCase() !== hash.toLowerCase()) throw new Error('下载文件哈希校验失败')
    await handle.close(); handle = null
    signal?.throwIfAborted()
    await fs.rename(partial, target)
    return target
  } finally {
    await handle?.close().catch(() => {})
    await fs.rm(partial, { force: true }).catch(() => {})
  }
}
