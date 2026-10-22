import fsp from 'node:fs/promises'
import zlib from 'node:zlib'

// 最小 ZIP 读取器：只解析中央目录 + 按需读取指定条目，避免把整个 jar 读进内存。
//
// 中央目录必须按 EOCD 里记录的偏移单独读取，不能只看文件末尾的一段：
// 整合包 overrides 里文件一多（本例 24818 个条目），中央目录就有 3 MB 左右，
// 只扫末尾 2 MiB 会漏掉目录开头，所有条目都变成 null，
// 上层于是误报“缺少 modrinth.index.json 或 manifest.json”。
const EOCD_BYTES = 22
const EOCD_SEARCH_BYTES = EOCD_BYTES + 0xffff
const ZIP64_LOCATOR_BYTES = 20
const ZIP64_RECORD_BYTES = 56
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 1e6

async function readRange(fh, position, length) {
  if (!(length > 0) || position < 0) return Buffer.alloc(0)
  const buf = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await fh.read(buf, filled, length - filled, position + filled)
    if (bytesRead <= 0) break
    filled += bytesRead
  }
  return filled === length ? buf : buf.subarray(0, filled)
}

// 找到 EOCD（末尾最多 64 KiB 注释 + 22 字节固定区），必要时跟随 Zip64 记录。
async function readEndRecord(fh, size) {
  const tailLength = Math.min(size, EOCD_SEARCH_BYTES)
  if (tailLength < EOCD_BYTES) return null
  const base = size - tailLength
  const tail = await readRange(fh, base, tailLength)
  if (tail.length < EOCD_BYTES) return null
  let end = -1
  for (let i = tail.length - EOCD_BYTES; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { end = i; break }
  }
  if (end < 0) return null
  const record = {
    eocdOffset: base + end,
    count: tail.readUInt16LE(end + 10),
    size: tail.readUInt32LE(end + 12),
    offset: tail.readUInt32LE(end + 16)
  }
  if (record.count !== 0xffff && record.size !== 0xffffffff && record.offset !== 0xffffffff) return record

  const locatorOffset = record.eocdOffset - ZIP64_LOCATOR_BYTES
  if (locatorOffset < 0) return record
  const locator = await readRange(fh, locatorOffset, ZIP64_LOCATOR_BYTES)
  if (locator.length !== ZIP64_LOCATOR_BYTES || locator.readUInt32LE(0) !== 0x07064b50) return record
  const zip64Offset = Number(locator.readBigUInt64LE(8))
  const zip64 = await readRange(fh, zip64Offset, ZIP64_RECORD_BYTES)
  if (zip64.length !== ZIP64_RECORD_BYTES || zip64.readUInt32LE(0) !== 0x06064b50) return record
  return {
    eocdOffset: record.eocdOffset,
    count: Number(zip64.readBigUInt64LE(32)),
    size: Number(zip64.readBigUInt64LE(40)),
    offset: Number(zip64.readBigUInt64LE(48))
  }
}

function parseCentralDirectory(buf, count) {
  const map = new Map()
  const limit = Number.isFinite(count) && count > 0 ? Math.min(count, MAX_ENTRIES) : MAX_ENTRIES
  let p = 0
  for (let i = 0; i < limit && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    let compSize = buf.readUInt32LE(p + 20)
    let size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    let offset = buf.readUInt32LE(p + 42)
    if (p + 46 + nameLen > buf.length) break
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)

    // Zip64 扩展字段：只有对应字段为 0xffffffff 时才存在，按 size / compSize / offset 顺序排列。
    if (size === 0xffffffff || compSize === 0xffffffff || offset === 0xffffffff) {
      let ep = p + 46 + nameLen
      const end = Math.min(ep + extraLen, buf.length)
      while (ep + 4 <= end) {
        const hid = buf.readUInt16LE(ep)
        const hsize = buf.readUInt16LE(ep + 2)
        if (hid === 0x0001) {
          let d = ep + 4
          const fieldEnd = Math.min(d + hsize, end)
          if (size === 0xffffffff && d + 8 <= fieldEnd) {
            size = Number(buf.readBigUInt64LE(d))
            d += 8
          }
          if (compSize === 0xffffffff && d + 8 <= fieldEnd) {
            compSize = Number(buf.readBigUInt64LE(d))
            d += 8
          }
          if (offset === 0xffffffff && d + 8 <= fieldEnd) {
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
  return map.size ? map : null
}

// 读取中央目录。返回 map 以及“记录偏移 → 实际偏移”的修正量：
// 自解压包 / 拼接在其它数据后面的 ZIP，条目偏移整体前移了同样的字节数。
async function readCentralDirectory(fh, size, end) {
  if (!(end.size > 0) || end.size > MAX_CENTRAL_DIRECTORY_BYTES) return null
  const candidates = [end.offset]
  const shifted = end.eocdOffset - end.size
  if (shifted >= 0 && shifted !== end.offset) candidates.push(shifted)
  for (const at of candidates) {
    if (at < 0 || at + 4 > size) continue
    const signature = await readRange(fh, at, 4)
    if (signature.length !== 4 || signature.readUInt32LE(0) !== 0x02014b50) continue
    const buf = await readRange(fh, at, Math.min(end.size, size - at))
    const map = parseCentralDirectory(buf, end.count)
    if (map) return { map, shift: at - end.offset }
  }
  return null
}

/**
 * 从 jar / 整合包中读取若干条目的内容
 * @param {string} filePath
 * @param {string[]} wanted 精确名字，或含 `*` 的通配模式
 * @param {{maxBytes?: number, maxEntries?: number, stats?: object}} [options]
 *   `stats` 会被写入 { zip, entries }：是否解析到中央目录、目录条目数，
 *   供调用方区分“读不出目录”和“目录里确实没有这个文件”。
 * @returns {Promise<Object.<string, Buffer|null>>}
 */
export async function readJarEntries(filePath, wanted, options = {}) {
  const out = {}
  for (const w of wanted) out[w] = null
  const stats = options.stats && typeof options.stats === 'object' ? options.stats : null
  if (stats) {
    stats.zip = false
    stats.entries = 0
  }
  let fh
  try {
    fh = await fsp.open(filePath, 'r')
    const { size } = await fh.stat()
    if (size < EOCD_BYTES) return out
    const end = await readEndRecord(fh, size)
    if (!end) return out
    const directory = await readCentralDirectory(fh, size, end)
    if (!directory) return out
    const { map, shift } = directory
    if (stats) {
      stats.zip = true
      stats.entries = map.size
    }

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
      if (entry.compSize > MAX_ENTRY_BYTES || entry.size > MAX_ENTRY_BYTES) continue
      if (readBytes + entry.size > maxBytes) break
      const localOffset = entry.offset + shift
      if (localOffset < 0 || localOffset + 30 > size) continue
      try {
        const head = await readRange(fh, localOffset, 30)
        if (head.length !== 30 || head.readUInt32LE(0) !== 0x04034b50) continue
        const nameLen = head.readUInt16LE(26)
        const extraLen = head.readUInt16LE(28)
        const start = localOffset + 30 + nameLen + extraLen
        const raw = await readRange(fh, start, entry.compSize)
        if (raw.length !== entry.compSize) continue
        out[name] = entry.method === 0 ? raw : entry.method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) }) : null
        if (out[name]?.length !== entry.size) out[name] = null
        if (out[name]) {
          readBytes += out[name].length
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
