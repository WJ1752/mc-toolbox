import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { isProcessAlive } from './running-processes.js'

const KEEP_MS = 7 * 24 * 60 * 60 * 1000
const KEY = /^[a-f0-9]{40}-\d+$/

// 硬退出时任务的 finally 没来得及执行。只回收带已退出进程标记的下载临时文件。
export async function cleanDeadPackDownloads(packs) {
  const entries = await fsp.readdir(packs, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.name)) continue
    const dir = path.join(packs, entry.name)
    let removed = false
    for (const item of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const match = /\.part-(\d+)-[a-f0-9-]{36}(?:\.\d+\.chunk)?$/.exec(item.name)
      if (!item.isFile() || !match || isProcessAlive(Number(match[1]))) continue
      await fsp.unlink(path.join(dir, item.name)).catch(() => {})
      removed = true
    }
    if (removed) await fsp.rmdir(dir).catch(() => {})
  }
}

// 完整块以内容标识 + 实际总长度隔离。只发布已写完的块；每个任务的临时文件独立。
export async function openPackResume(root, sha1, total) {
  const key = `${String(sha1).toLowerCase()}-${total}`
  if (!root || !KEY.test(key)) return null
  const dir = path.join(root, key)
  let canSave = true
  try {
    await fsp.mkdir(root, { recursive: true })
    for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !KEY.test(entry.name)) continue
      const candidate = path.join(root, entry.name)
      const stat = await fsp.stat(candidate).catch(() => null)
      if (stat && Date.now() - stat.mtimeMs > KEEP_MS) {
        await fsp.rm(candidate, { recursive: true, force: true }).catch(() => {})
      }
    }
    await fsp.mkdir(dir, { recursive: true })
    const cached = await fsp.readdir(dir)
    let cachedBytes = 0
    for (const name of cached) {
      const match = /^(\d+)-(\d+)$/.exec(name)
      if (!match) continue
      const stat = await fsp.stat(path.join(dir, name)).catch(() => null)
      if (stat?.isFile() && stat.size === Number(match[2]) - Number(match[1]) + 1) cachedBytes += stat.size
    }
    const disk = await fsp.statfs(dir).catch(() => null)
    // 优先为最终文件留出空间；空间紧张时仍读取旧块，跳过新增检查点。
    if (disk) canSave = disk.bavail * disk.bsize >= total + Math.max(0, total - cachedBytes)
  } catch { return null }
  return {
    async restore(partial, start, end, signal) {
      const source = path.join(dir, `${start}-${end}`)
      try {
        if ((await fsp.stat(source)).size !== end - start + 1) return false
        await pipeline(fs.createReadStream(source, { end: end - start }), fs.createWriteStream(partial, { flags: 'r+', start }), { signal })
        return true
      } catch {
        signal.throwIfAborted()
        return false
      }
    },
    async save(partial, start, end, signal) {
      if (!canSave) return
      const staging = `${partial}.${start}.chunk`
      try {
        await pipeline(fs.createReadStream(partial, { start, end }), fs.createWriteStream(staging, { flags: 'wx' }), { signal })
        await fsp.rename(staging, path.join(dir, `${start}-${end}`))
      } catch {
        signal.throwIfAborted()
        // 存储空间不足或另一个任务已清理缓存时，仍允许原下载完成。
      } finally {
        await fsp.rm(staging, { force: true }).catch(() => {})
      }
    },
    clear: () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
