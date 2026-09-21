import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { scanModsDir } from './mods.js'

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_UNPACK_BYTES = 8 * 1024 * 1024 * 1024
const MAX_ENTRIES = 200000

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function safeRelativeName(name) {
  const normalized = String(name || '').replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return ''
  const parts = normalized.split('/').filter(Boolean)
  if (parts.some((part) => part === '..' || part.includes('\0'))) throw new Error('压缩包包含非法路径：' + name)
  return parts.join('/')
}

function findEndOfCentralDirectory(buf) {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

async function readZipIndex(filePath) {
  const stat = await fsp.stat(filePath)
  if (!stat.isFile()) throw new Error('整合包不是文件：' + filePath)
  if (stat.size > MAX_ARCHIVE_BYTES) throw new Error('整合包超过 2 GB，拒绝处理')
  const fh = await fsp.open(filePath, 'r')
  try {
    const tailSize = Math.min(stat.size, 22 + 65535)
    const tail = Buffer.alloc(tailSize)
    await fh.read(tail, 0, tailSize, stat.size - tailSize)
    const eocd = findEndOfCentralDirectory(tail)
    if (eocd < 0) throw new Error('不是有效的 ZIP 整合包')
    const count = tail.readUInt16LE(eocd + 10)
    const centralSize = tail.readUInt32LE(eocd + 12)
    const centralOffset = tail.readUInt32LE(eocd + 16)
    if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 整合包')
    }
    if (count > MAX_ENTRIES || centralSize > 256 * 1024 * 1024) throw new Error('整合包目录过大')
    const central = Buffer.alloc(centralSize)
    await fh.read(central, 0, centralSize, centralOffset)
    const entries = []
    let parsedCount = 0
    let cursor = 0
    while (cursor + 46 <= central.length && entries.length < count) {
      if (central.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 中央目录损坏')
      const flags = central.readUInt16LE(cursor + 8)
      const method = central.readUInt16LE(cursor + 10)
      const crc = central.readUInt32LE(cursor + 16)
      const compressedSize = central.readUInt32LE(cursor + 20)
      const size = central.readUInt32LE(cursor + 24)
      const nameLen = central.readUInt16LE(cursor + 28)
      const extraLen = central.readUInt16LE(cursor + 30)
      const commentLen = central.readUInt16LE(cursor + 32)
      const offset = central.readUInt32LE(cursor + 42)
      const rawName = central.toString('utf8', cursor + 46, cursor + 46 + nameLen)
      const name = safeRelativeName(rawName)
      parsedCount++
      if (name) entries.push({ name, flags, method, crc, compressedSize, size, offset, directory: /\/$/.test(rawName) })
      cursor += 46 + nameLen + extraLen + commentLen
    }
    if (parsedCount !== count) throw new Error('ZIP 中央目录条目数量不完整')
    return { filePath, entries, size: stat.size }
  } finally {
    await fh.close()
  }
}

async function extractZip(filePath, targetDir) {
  const index = await readZipIndex(filePath)
  const fh = await fsp.open(filePath, 'r')
  let unpacked = 0
  try {
    for (const entry of index.entries) {
      if (entry.directory) {
        await fsp.mkdir(path.join(targetDir, ...entry.name.split('/')), { recursive: true })
        continue
      }
      if (entry.size > MAX_UNPACK_BYTES || unpacked + entry.size > MAX_UNPACK_BYTES) throw new Error('解压后文件超过 8 GB，拒绝处理')
      const header = Buffer.alloc(30)
      await fh.read(header, 0, 30, entry.offset)
      if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP 本地文件头损坏：' + entry.name)
      const nameLen = header.readUInt16LE(26)
      const extraLen = header.readUInt16LE(28)
      const data = Buffer.alloc(entry.compressedSize)
      await fh.read(data, 0, entry.compressedSize, entry.offset + 30 + nameLen + extraLen)
      let out
      if (entry.method === 0) out = data
      else if (entry.method === 8) out = zlib.inflateRawSync(data)
      else throw new Error(`不支持的压缩方式（${entry.method}）：${entry.name}`)
      if (out.length !== entry.size) throw new Error('ZIP 条目大小校验失败：' + entry.name)
      const target = path.join(targetDir, ...entry.name.split('/'))
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.writeFile(target, out)
      unpacked += out.length
    }
  } finally {
    await fh.close()
  }
  return { index, unpacked }
}

async function listFiles(dir, rel = '') {
  const out = []
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    const next = rel ? path.join(rel, ent.name) : ent.name
    if (ent.isDirectory()) out.push(...await listFiles(full, next))
    else if (ent.isFile()) out.push({ full, rel: next.replace(/\\/g, '/') })
  }
  return out
}

async function packDirectory(sourceDir, outputFile) {
  const files = await listFiles(sourceDir)
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.rel, 'utf8')
    const input = await fsp.readFile(file.full)
    const compressed = input.length ? zlib.deflateRawSync(input, { level: 6 }) : input
    const method = input.length ? 8 : 0
    const crc = crc32(input)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(input.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    locals.push(local, compressed)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(input.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length + compressed.length
  }
  const centralDir = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  await fsp.mkdir(path.dirname(outputFile), { recursive: true })
  await fsp.writeFile(outputFile, Buffer.concat([...locals, centralDir, eocd]))
  return { files: files.length, bytes: (await fsp.stat(outputFile)).size }
}

async function uniqueOutput(dir, name) {
  const safe = String(name || 'server-pack.zip').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  const ext = path.extname(safe) || '.zip'
  const stem = path.basename(safe, ext)
  let candidate = path.join(dir, safe)
  let i = 1
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${stem} (${i++})${ext}`)
  return candidate
}

async function findModsDirs(root) {
  const found = []
  const walk = async (dir, depth) => {
    if (depth > 8) return
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      if (!ent.isDirectory() || ['.git', '.mc-i18n', 'node_modules'].includes(ent.name)) continue
      const full = path.join(dir, ent.name)
      if (ent.name.toLowerCase() === 'mods') {
        const jars = await scanModsDir(full, { recursive: false, includeDisabled: true }).catch(() => [])
        if (jars.length) found.push({ dir: full, items: jars })
      }
      await walk(full, depth + 1)
    }
  }
  await walk(root, 0)
  return found
}

function defaultDownloadsDir() {
  return process.platform === 'win32'
    ? path.join(process.env.USERPROFILE || os.homedir(), 'Downloads')
    : path.join(os.homedir(), 'Downloads')
}

export async function convertPack({ source, outputDir = '', outputName = '', clientModIds = [], autoDetectEnv = true, uploaded = false }) {
  const input = path.resolve(String(source || ''))
  if (!input || !fs.existsSync(input)) throw new Error('客户端整合包或目录不存在')
  const sourceStat = await fsp.stat(input)
  const isDir = sourceStat.isDirectory()
  if (!isDir && !/\.(zip|mrpack)$/i.test(input)) throw new Error('只支持整合包目录、.zip 或 .mrpack 文件')

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-convert-'))
  const staging = path.join(tempRoot, 'pack')
  await fsp.mkdir(staging)
  let sourceInfo = { unpacked: false, entries: 0 }
  try {
    if (isDir) await fsp.cp(input, staging, { recursive: true, force: true })
    else {
      const result = await extractZip(input, staging)
      sourceInfo = { unpacked: true, entries: result.index.entries.length, bytes: result.unpacked }
    }
    const modsDirs = await findModsDirs(staging)
    if (!modsDirs.length) throw new Error('没有找到 mods 目录或目录中没有 jar 文件')
    const ids = new Set(clientModIds.map((id) => String(id).trim().toLowerCase()).filter(Boolean))
    const remove = new Set()
    const matched = []
    let total = 0
    for (const group of modsDirs) {
      total += group.items.length
      for (const mod of group.items) {
        const byLibrary = mod.modid && ids.has(String(mod.modid).toLowerCase())
        const byEnvironment = autoDetectEnv && mod.environment === 'client'
        if (byLibrary || byEnvironment) {
          remove.add(mod.path)
          matched.push({ ...mod, rule: byLibrary ? 'modid 库' : 'environment=client' })
        }
      }
    }
    for (const file of remove) await fsp.unlink(file).catch(() => {})

    const dir = String(outputDir || '').trim()
      ? path.resolve(outputDir)
      : (isDir ? path.dirname(input) : (uploaded ? defaultDownloadsDir() : path.dirname(input)))
    await fsp.mkdir(dir, { recursive: true })
    const base = outputName || `${path.basename(input, path.extname(input))}-server.zip`
    const output = await uniqueOutput(dir, base.toLowerCase().endsWith('.zip') ? base : base + '.zip')
    const packed = await packDirectory(staging, output)
    const warnings = []
    if (!outputDir) warnings.push(uploaded ? '未选择输出目录，拖入的文件已输出到系统下载目录。' : '未选择输出目录，已输出到客户端原文件所在目录。')
    if (/\.mrpack$/i.test(input)) warnings.push('.mrpack 可能只包含索引和 overrides，未下载索引中缺失的 mod。')
    return {
      source: input,
      output,
      outputDir: dir,
      sourceInfo,
      modsDirs: modsDirs.map((x) => x.dir),
      totalMods: total,
      removed: matched,
      removedCount: matched.length,
      packed,
      warnings
    }
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

export async function writeUploadedPack(buffer, name) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('未收到整合包文件')
  if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error('整合包超过 2 GB，拒绝处理')
  const ext = /\.(mrpack|zip)$/i.exec(String(name || ''))?.[1] || 'zip'
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-upload-'))
  const file = path.join(dir, `client-pack.${ext.toLowerCase()}`)
  await fsp.writeFile(file, buffer)
  return { dir, file }
}

export async function removeTempPack(dir) {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
}
