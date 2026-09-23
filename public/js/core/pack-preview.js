// Random-access ZIP inspection shared by local files and browser File slices.
// Only metadata is read; mod jars and the rest of the pack stay untouched.
export async function readPackMetadata(size, read) {
  if (size > 4 * 1024 ** 3) throw new Error('整合包超过 4 GB，请先解压并选择文件夹')
  const slice = async (offset, length) => {
    if (offset < 0 || length < 0 || offset + length > size) throw new Error('ZIP 文件不完整')
    const bytes = new Uint8Array(await read(offset, length))
    if (bytes.length !== length) throw new Error('ZIP 文件读取不完整')
    return bytes
  }
  const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tail = await slice(Math.max(0, size - 65557), Math.min(size, 65557))
  const t = view(tail)
  let end = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (t.getUint32(i, true) === 0x06054b50 && i + 22 + t.getUint16(i + 20, true) === tail.length) { end = i; break }
  }
  if (end < 0) throw new Error('不是有效的 ZIP 整合包')
  const count = t.getUint16(end + 10, true)
  const length = t.getUint32(end + 12, true)
  const offset = t.getUint32(end + 16, true)
  if (count === 65535 || length === 0xffffffff || offset === 0xffffffff) throw new Error('暂不支持 ZIP64，请先解压并选择文件夹')
  if (t.getUint16(end + 4, true) || t.getUint16(end + 6, true)) throw new Error('不支持分卷 ZIP，请先解压')
  if (length > 32 * 1024 ** 2) throw new Error('ZIP 目录过大，请先解压并选择文件夹')
  const central = await slice(offset, length), c = view(central)
  const records = [], decoder = new TextDecoder()
  const ignored = new Set(['mods', 'assets', 'saves', 'logs', 'config', 'resourcepacks', '.git', 'node_modules', 'libraries', 'runtime', 'addons', 'resources', 'oresources', 'structures', 'scripts'])
  let cursor = 0, total = 0, unpacked = 0
  const summary = { modCount: 0, modBytes: 0 }
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > length || c.getUint32(cursor, true) !== 0x02014b50) throw new Error('ZIP 中央目录损坏')
    const n = c.getUint16(cursor + 28, true), extra = c.getUint16(cursor + 30, true), comment = c.getUint16(cursor + 32, true)
    if (cursor + 46 + n + extra + comment > length) throw new Error('ZIP 中央目录不完整')
    const name = decoder.decode(central.subarray(cursor + 46, cursor + 46 + n)).replace(/\\/g, '/')
    const flags = c.getUint16(cursor + 8, true), method = c.getUint16(cursor + 10, true)
    const compressed = c.getUint32(cursor + 20, true), bytes = c.getUint32(cursor + 24, true), local = c.getUint32(cursor + 42, true)
    cursor += 46 + n + extra + comment
    const parts = name.split('/'), base = parts.at(-1)
    if (parts.some(part => part.toLowerCase() === 'mods') && /\.jar$/i.test(base)) { summary.modCount++; summary.modBytes += bytes }
    const cleanroomConfig = base.toLowerCase() === 'forge_early.cfg'
    if (parts.length > 11 || (!cleanroomConfig && parts.some(p => ignored.has(p.toLowerCase())))) continue
    if (parts.includes('..') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes('\0')) throw new Error('ZIP 包含非法路径')
    if (/^(forge|cleanroom)-.*\.jar$/i.test(base)) { records.push({ name, method: 0, size: 0, data: '' }); continue }
    if ((!cleanroomConfig && !/\.(json|bat|cmd|sh)$/i.test(base)) || bytes > 2 * 1024 ** 2) continue
    total += compressed; unpacked += bytes
    if (total > 8 * 1024 ** 2 || unpacked > 16 * 1024 ** 2 || records.length >= 2000) throw new Error('版本信息过多，请先解压并选择具体实例文件夹')
    if (flags & 1) throw new Error('无法识别加密压缩包，请先解压')
    if (method !== 0 && method !== 8) throw new Error('版本清单压缩方式不支持，请先解压')
    const header = view(await slice(local, 30))
    if (header.getUint32(0, true) !== 0x04034b50) throw new Error('ZIP 本地文件头损坏')
    const data = await slice(local + 30 + header.getUint16(26, true) + header.getUint16(28, true), compressed)
    let binary = ''
    for (let p = 0; p < data.length; p += 8192) binary += String.fromCharCode(...data.subarray(p, p + 8192))
    records.push({ name, method, size: bytes, data: btoa(binary) })
  }
  records.summary = summary
  return records
}

export function recommendPackMemory(summary = {}) {
  const count = Number(summary.modCount) || 0, bytes = Number(summary.modBytes) || 0
  return count >= 350 || bytes >= 800 * 1024 ** 2 ? 8 : count >= 150 || bytes >= 400 * 1024 ** 2 ? 6 : 4
}

