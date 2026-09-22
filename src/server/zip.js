import fsp from 'node:fs/promises'
import zlib from 'node:zlib'

// 最小 ZIP 读取器：只解析中央目录 + 按需读取指定条目，避免把整个 jar 读进内存
function parseCentralDirectory(buf, baseOffset) {
  let eocd = -1
  const min = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null

  let count = buf.readUInt16LE(eocd + 10)
  let cdOffset = buf.readUInt32LE(eocd + 16)

  // Zip64
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20
    if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
      const z64Offset = Number(buf.readBigUInt64LE(loc + 8))
      const rel = z64Offset - baseOffset
      if (rel >= 0 && rel < buf.length && buf.readUInt32LE(rel) === 0x06064b50) {
        count = Number(buf.readBigUInt64LE(rel + 32))
        cdOffset = Number(buf.readBigUInt64LE(rel + 48))
      }
    }
  }

  const rel = cdOffset - baseOffset
  if (rel < 0 || rel >= buf.length) return null

  const map = new Map()
  let p = rel
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    let compSize = buf.readUInt32LE(p + 20)
    let size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    let offset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)

    // Zip64 扩展字段
    if (size === 0xffffffff || compSize === 0xffffffff || offset === 0xffffffff) {
      let ep = p + 46 + nameLen
      const end = ep + extraLen
      while (ep + 4 <= end) {
        const hid = buf.readUInt16LE(ep)
        const hsize = buf.readUInt16LE(ep + 2)
        if (hid === 0x0001) {
          let d = ep + 4
          if (size === 0xffffffff && d + 8 <= end) {
            size = Number(buf.readBigUInt64LE(d))
            d += 8
          }
          if (compSize === 0xffffffff && d + 8 <= end) {
            compSize = Number(buf.readBigUInt64LE(d))
            d += 8
          }
          if (offset === 0xffffffff && d + 8 <= end) {
            offset = Number(buf.readBigUInt64LE(d))
          }
          break
        }
        ep += 4 + hsize
      }
    }

    map.set(name, { method, compSize, size, offset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return map
}

/**
 * 从 jar 中读取若干条目的文本内容
 * @returns {Object.<string, Buffer|null>}
 */
export async function readJarEntries(filePath, wanted, options = {}) {
  const out = {}
  for (const w of wanted) out[w] = null
  let fh
  try {
    fh = await fsp.open(filePath, 'r')
    const { size } = await fh.stat()
    if (size < 22) return out
    const tailLen = Math.min(size, 2 * 1024 * 1024)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    const base = size - tailLen
    const map = parseCentralDirectory(tail, base)
    if (!map) return out

    const wildcard = wanted.filter((name) => name.includes('*'))
    const names = [...new Set([
      ...wanted.filter((name) => !name.includes('*')),
      ...[...map.keys()].filter((name) => wildcard.some((pattern) => {
        const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
        return new RegExp(`^${escaped}$`, 'i').test(name)
      }))
    ])]
    let readBytes = 0
    let readEntries = 0
    const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : Infinity
    const maxEntries = Number(options.maxEntries) > 0 ? Number(options.maxEntries) : Infinity
    for (const name of names) {
      if (readEntries >= maxEntries || readBytes >= maxBytes) break
      const entry = map.get(name)
      if (!entry || entry.compSize === 0) continue
      if (entry.compSize > 32 * 1024 * 1024) continue
      if (readBytes + entry.compSize > maxBytes) break
      try {
        const head = Buffer.alloc(30)
        await fh.read(head, 0, 30, entry.offset)
        if (head.readUInt32LE(0) !== 0x04034b50) continue
        const nameLen = head.readUInt16LE(26)
        const extraLen = head.readUInt16LE(28)
        const start = entry.offset + 30 + nameLen + extraLen
        const raw = Buffer.alloc(entry.compSize)
        await fh.read(raw, 0, entry.compSize, start)
        out[name] = entry.method === 0 ? raw : entry.method === 8 ? zlib.inflateRawSync(raw) : null
        if (out[name]) {
          readBytes += entry.compSize
          readEntries++
        }
      } catch {
        out[name] = null
      }
    }
  } catch {
    /* 读取失败：返回已获得的内容 */
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
  return out
}
