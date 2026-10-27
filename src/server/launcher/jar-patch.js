// Forge / NeoForge 安装器的小修补工具。
//
// 官方安装器的 DOWNLOAD_MOJMAPS processor 永远直连 launchermeta.mojang.com /
// piston-data.mojang.com，不读启动器的下载源设置。国内线路经常在 TLS 握手时
// 被重置（Connection reset），安装器随即以退出码 1 结束。启动器已经能通过
// BMCLAPI 镜像下载同一份 client mappings，因此这里做两件事：
//   1. 给安装器的 install_profile.json 里 DOWNLOAD_MOJMAPS 参数补上
//      --skipIfExists；
//   2. 把镜像下载好的 mappings 预置到安装器期望的 Maven 路径，
//      让 processor 直接跳过网络请求。
//
// JAR 重写只替换一个条目，其余条目按原始压缩数据复制，保持顺序与时间戳。
import fsp from 'node:fs/promises'
import zlib from 'node:zlib'

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const EOCD_BYTES = 22
const EOCD_SEARCH = EOCD_BYTES + 0xffff
const ZIP64_MARK = 0xffffffff

// JAR 签名文件：META-INF/XXX.SF + XXX.RSA / .DSA / .EC，或 META-INF/SIG-XXX。
// 新版 Forge 安装器（如 1.20.1-47.4.0）是带签名的，见 stripSignatures 的说明。
const SIGNATURE_ENTRY = /^META-INF\/(?:[^/]+\.(?:SF|RSA|DSA|EC)|SIG-[^/]+)$/i

function isSignatureEntry(name) {
  return SIGNATURE_ENTRY.test(String(name || ''))
}

function findEocd(buf) {
  const start = Math.max(0, buf.length - EOCD_SEARCH)
  for (let i = buf.length - EOCD_BYTES; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

function readEntries(buf) {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是有效的 ZIP / JAR 文件')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === ZIP64_MARK || cdSize === ZIP64_MARK) {
    throw new Error('暂不支持 ZIP64 格式的安装器')
  }
  if (cdOffset + cdSize > buf.length) throw new Error('JAR 中央目录越界')

  const entries = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('JAR 中央目录损坏')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const modTime = buf.readUInt16LE(p + 12)
    const modDate = buf.readUInt16LE(p + 14)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const internalAttr = buf.readUInt16LE(p + 36)
    const externalAttr = buf.readUInt32LE(p + 38)
    const localOffset = buf.readUInt32LE(p + 42)
    if (compSize === ZIP64_MARK || size === ZIP64_MARK || localOffset === ZIP64_MARK) {
      throw new Error('暂不支持 ZIP64 格式的安装器')
    }
    if (p + 46 + nameLen + extraLen + commentLen > buf.length) throw new Error('JAR 中央目录损坏')
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen)
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)
    const comment = buf.subarray(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + commentLen)

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error('JAR 条目头损坏')
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    if (dataStart + compSize > buf.length) throw new Error('JAR 条目数据越界')
    entries.push({
      name, flags, method, modTime, modDate, crc, compSize, size,
      internalAttr, externalAttr, extra, comment,
      localExtra: buf.subarray(localOffset + 30 + localNameLen, dataStart),
      data: buf.subarray(dataStart, dataStart + compSize)
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return { entries, count }
}

function decodeEntry(entry) {
  if (entry.method === 0) return Buffer.from(entry.data)
  if (entry.method === 8) return zlib.inflateRawSync(entry.data, { maxOutputLength: Math.max(1, entry.size) })
  throw new Error('不支持的压缩方式：' + entry.method)
}

function makeLocal(entry) {
  const name = Buffer.from(entry.name, 'utf8')
  const head = Buffer.alloc(30)
  head.writeUInt32LE(LOCAL_SIG, 0)
  head.writeUInt16LE(20, 4)
  head.writeUInt16LE(entry.flags & ~0x0008, 6)
  head.writeUInt16LE(entry.method, 8)
  head.writeUInt16LE(entry.modTime, 10)
  head.writeUInt16LE(entry.modDate, 12)
  head.writeUInt32LE(entry.crc >>> 0, 14)
  head.writeUInt32LE(entry.compSize, 18)
  head.writeUInt32LE(entry.size, 22)
  head.writeUInt16LE(name.length, 26)
  head.writeUInt16LE(entry.localExtra.length, 28)
  return Buffer.concat([head, name, entry.localExtra, entry.data])
}

function makeCentral(entry, offset) {
  const name = Buffer.from(entry.name, 'utf8')
  const head = Buffer.alloc(46)
  head.writeUInt32LE(CENTRAL_SIG, 0)
  head.writeUInt16LE(20, 4)
  head.writeUInt16LE(20, 6)
  head.writeUInt16LE(entry.flags & ~0x0008, 8)
  head.writeUInt16LE(entry.method, 10)
  head.writeUInt16LE(entry.modTime, 12)
  head.writeUInt16LE(entry.modDate, 14)
  head.writeUInt32LE(entry.crc >>> 0, 16)
  head.writeUInt32LE(entry.compSize, 20)
  head.writeUInt32LE(entry.size, 24)
  head.writeUInt16LE(name.length, 28)
  head.writeUInt16LE(entry.extra.length, 30)
  head.writeUInt16LE(entry.comment.length, 32)
  head.writeUInt16LE(0, 34)
  head.writeUInt16LE(entry.internalAttr, 36)
  head.writeUInt32LE(entry.externalAttr >>> 0, 38)
  head.writeUInt32LE(offset, 42)
  return Buffer.concat([head, name, entry.extra, entry.comment])
}

function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const local = makeLocal(entry)
    locals.push(local)
    centrals.push(makeCentral(entry, offset))
    offset += local.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(EOCD_BYTES)
  end.writeUInt32LE(EOCD_SIG, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

/**
 * 移除 JAR 签名条目。安装器 JAR 一旦带签名，改动 install_profile.json 就会让
 * Java 在读回该条目时抛 `SecurityException: SHA-384 digest error for
 * install_profile.json`：Forge 的 SimpleInstaller 把异常吞掉，只打印一句
 * 「A problem installing was detected, install cannot continue」然后退出码 1，
 * 表现为「安装器返回非零退出码」，和网络、下载源毫无关系。
 *
 * 补丁必然破坏签名，所以签名为「已失效的装饰」：把 .SF/.RSA 一并去掉，安装器
 * 按普通 JAR 运行。实测（1.20.1-47.4.0）去掉签名后补丁 JAR 可正常安装。
 */
function stripSignatures(entries) {
  const signatures = entries.filter((item) => isSignatureEntry(item.name))
  if (!signatures.length) return { entries, removed: [] }
  return {
    entries: entries.filter((item) => !isSignatureEntry(item.name)),
    removed: signatures.map((item) => item.name)
  }
}

/**
 * 替换 JAR 中的单个文本条目。transform 返回 null / 相同 Buffer 时不写文件。
 * @returns {Promise<{changed:boolean, target?:string, signatureRemoved?:boolean, removedSignatures?:string[]}>}
 */
export async function patchJarEntry(source, entryName, transform, target = source) {
  const buf = await fsp.readFile(source)
  const { entries } = readEntries(buf)
  const entry = entries.find((item) => item.name === entryName)
  if (!entry) return { changed: false }
  const original = decodeEntry(entry)
  const next = transform(Buffer.from(original))
  if (!next || next.equals(original)) return { changed: false }
  // 统一用 deflate 重新压缩被修改的条目；其余条目按原始压缩数据复制。
  entry.method = 8
  entry.size = next.length
  entry.data = zlib.deflateRawSync(next, { level: 9 })
  entry.compSize = entry.data.length
  entry.crc = zlib.crc32(next) >>> 0
  const stripped = stripSignatures(entries)
  const out = buildZip(stripped.entries)
  // 写盘前自检：补丁条目必须能原样读回，且不能残留签名（否则安装器会静默退出）。
  const written = readEntries(out)
  const check = written.entries.find((item) => item.name === entryName)
  if (!check || !decodeEntry(check).equals(next)) {
    throw new Error('安装器 JAR 自检失败：补丁条目无法读回')
  }
  if (written.entries.some((item) => isSignatureEntry(item.name))) {
    throw new Error('安装器 JAR 仍带签名，无法安全打补丁')
  }
  const part = `${target}.part-${process.pid}`
  await fsp.writeFile(part, out)
  await fsp.rm(target, { force: true }).catch(() => {})
  await fsp.rename(part, target)
  return {
    changed: true,
    target,
    signatureRemoved: stripped.removed.length > 0,
    removedSignatures: stripped.removed
  }
}

/** 给安装器 profile 的 DOWNLOAD_MOJMAPS 参数追加 --skipIfExists（原地修改）。 */
export function patchMojmapsProcessor(profile) {
  if (!profile || typeof profile !== 'object') return false
  let changed = false
  const processors = Array.isArray(profile.processors) ? profile.processors : []
  for (const proc of processors) {
    const args = Array.isArray(proc?.args) ? proc.args : []
    if (!args.includes('DOWNLOAD_MOJMAPS')) continue
    if (args.includes('--skipIfExists')) continue
    args.push('--skipIfExists')
    changed = true
  }
  return changed
}

/**
 * 预置的原始 client mappings 只有在安装器原本就按 TSRG 原样复制时才能复用。
 * 带 --sanitize 或非 TSRG 格式的 processor 会改写内容，不能跳过。
 */
export function isSeedableMojmapsProfile(profile) {
  const processors = (Array.isArray(profile?.processors) ? profile.processors : [])
    .filter((proc) => Array.isArray(proc?.args) && proc.args.includes('DOWNLOAD_MOJMAPS'))
  if (processors.length !== 1) return false
  const args = processors[0].args
  if (args.includes('--sanitize')) return false
  const formatAt = args.indexOf('--format')
  if (formatAt >= 0 && String(args[formatAt + 1] || '').toUpperCase() !== 'TSRG') return false
  return true
}

/** 找到 DOWNLOAD_MOJMAPS 的 {MOJMAPS} 坐标，例如 [net.minecraft:client:...:mappings@txt]。 */
export function resolveMojmapsCoordinate(profile, side = 'client') {
  const processors = Array.isArray(profile?.processors) ? profile.processors : []
  for (const proc of processors) {
    const args = Array.isArray(proc?.args) ? proc.args : []
    if (!args.includes('DOWNLOAD_MOJMAPS')) continue
    const at = args.indexOf('--output')
    const raw = at >= 0 ? String(args[at + 1] || '') : ''
    const token = /^\{([A-Za-z0-9_]+)\}$/.exec(raw)
    if (!token) continue
    const spec = profile?.data?.[token[1]]
    const value = spec && typeof spec === 'object' ? (spec[side] ?? spec.client) : spec
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/** 读取 JAR 中的 JSON 条目；不存在或格式错误返回 null。 */
export async function readJarJson(file, entryName) {
  const buf = await fsp.readFile(file)
  const { entries } = readEntries(buf)
  const entry = entries.find((item) => item.name === entryName)
  if (!entry) return null
  try { return JSON.parse(decodeEntry(entry).toString('utf8')) } catch { return null }
}
