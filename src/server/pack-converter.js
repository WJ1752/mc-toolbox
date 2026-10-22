import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { scanModsDir } from './mods.js'
import { hydrateCurseForgeFiles } from './curseforge-pack.js'
import { applyServerCompatibility, serverRemovalReason } from './server-compatibility.js'
import { resolveDownload, listLoaderVersions } from './servercore.js'
import * as community from './community.js'
import { downloadVerified } from './verified-download.js'
import { detectPackRuntime, mergeRuntime, findPackRoot } from './pack-runtime.js'
export { detectPackRuntime } from './pack-runtime.js'
import { promisify } from 'node:util'
import { resolveJava, validateMemory, writeLaunchFiles, bundleJavaRuntime } from './server-launch.js'
const inflateRaw = promisify(zlib.inflateRaw)
const deflateRaw = promisify(zlib.deflateRaw)

const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024
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

export async function readZipIndex(filePath) {
  const stat = await fsp.stat(filePath)
  if (!stat.isFile()) throw new Error('整合包不是文件：' + filePath)
  if (stat.size > MAX_ARCHIVE_BYTES) throw new Error('整合包超过 4 GB，请解压后选择实例文件夹')
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

export async function extractZip(filePath, targetDir, onProgress, signal) {
  const index = await readZipIndex(filePath)
  const fh = await fsp.open(filePath, 'r')
  let unpacked = 0
  try {
    let done = 0
    const fileCount = index.entries.filter(e => !e.directory).length
    for (const entry of index.entries) {
      signal?.throwIfAborted()
      if (entry.flags & 1) throw new Error('不支持加密 ZIP，请先解压')
      if (entry.compressedSize > 512 * 1024 ** 2 || entry.size > 512 * 1024 ** 2) throw new Error('ZIP 单文件超过 512 MB：' + entry.name)
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
      else if (entry.method === 8) out = await inflateRaw(data, { maxOutputLength: Math.max(1, entry.size) })
      else throw new Error(`不支持的压缩方式（${entry.method}）：${entry.name}`)
      if (crc32(out) !== entry.crc) throw new Error('ZIP 条目 CRC 校验失败：' + entry.name)
      if (out.length !== entry.size) throw new Error('ZIP 条目大小校验失败：' + entry.name)
      const target = path.join(targetDir, ...entry.name.split('/'))
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.writeFile(target, out, { signal })
      unpacked += out.length
      done++
      onProgress?.(done / Math.max(1, fileCount), entry.name)
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

export async function packDirectory(sourceDir, outputFile, onProgress, signal) {
  const files = await listFiles(sourceDir)
  if (files.length >= 65535) throw new Error('服务端包超过 65534 个文件，暂不支持生成 ZIP64；请清理客户端缓存后重试')
  await fsp.mkdir(path.dirname(outputFile), { recursive: true })
  const output = await fsp.open(outputFile, 'w')
  try {
  const centrals = []
  let offset = 0
  for (let index = 0; index < files.length; index++) {
    signal?.throwIfAborted()
    const file = files[index]
    const name = Buffer.from(file.rel, 'utf8')
    if ((await fsp.stat(file.full)).size > 512 * 1024 ** 2) throw new Error('单文件超过 512 MB：' + file.rel + '，请检查是否包含客户端缓存或不需要的文件')
    const input = await fsp.readFile(file.full)
    const compressed = input.length ? await deflateRaw(input, { level: 6 }) : input
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
    await output.writeFile(local)
    await output.writeFile(compressed)

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
    if (offset >= 0xffffffff) throw new Error('服务端 ZIP 超过 4 GB，暂不支持生成 ZIP64')
    onProgress?.((index + 1) / Math.max(1, files.length), file.rel)
  }
  const centralDir = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  signal?.throwIfAborted()
  await output.writeFile(centralDir)
  await output.writeFile(eocd)
  } finally { await output.close() }
  return { files: files.length, bytes: (await fsp.stat(outputFile)).size }
}

function report(onProgress, stage, progress, detail = '') {
  if (typeof onProgress === 'function') onProgress({ stage, progress: progress == null ? null : Math.max(0, Math.min(100, progress)), detail })
}

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')) } catch { return null }
}

async function copyTreeContents(source, target, signal) {
  for (const ent of await fsp.readdir(source, { withFileTypes: true })) {
    signal?.throwIfAborted()
    const from = path.join(source, ent.name)
    const to = path.join(target, ent.name)
    await fsp.mkdir(path.dirname(to), { recursive: true })
    if (ent.isDirectory()) await fsp.cp(from, to, { recursive: true, force: true, filter: () => { signal?.throwIfAborted(); return true } })
    else await fsp.copyFile(from, to)
  }
}

async function normalizePackLayout(root, signal) {
  const manifest = await readJson(path.join(root, 'manifest.json'))
  const custom = manifest?.overrides ? safeRelativeName(manifest.overrides) : 'overrides'
  if (!custom || ['mods', 'config', 'scripts', 'libraries', 'runtime', '.'].includes(custom)) throw new Error('清单 overrides 目录无效')
  for (const name of [...new Set([custom, 'server-overrides'])]) {
    signal?.throwIfAborted()
    const dir = path.join(root, name)
    if (fs.existsSync(dir) && (await fsp.stat(dir)).isDirectory()) {
      await copyTreeContents(dir, root, signal)
      await fsp.rm(dir, { recursive: true, force: true })
    }
  }
  await fsp.rm(path.join(root, 'client-overrides'), { recursive: true, force: true })
  const entries = await fsp.readdir(root, { withFileTypes: true })
  for (const ent of entries) {
    if (!ent.isFile()) continue
    if (/^(?:start|run|launch|install).*\.(?:bat|cmd|sh)$/i.test(ent.name)) {
      await fsp.rm(path.join(root, ent.name), { force: true })
    }
  }
  for (const metadata of ['manifest.json', 'modrinth.index.json', 'instance.cfg', 'mmc-pack.json']) {
    await fsp.rm(path.join(root, metadata), { force: true })
  }
}

async function hydrateModrinthFiles(root, onProgress, signal) {
  const indexPath = path.join(root, 'modrinth.index.json')
  const index = await readJson(indexPath)
  if (!index || !Array.isArray(index.files) || !index.files.length) return { downloaded: 0, skipped: 0 }
  let downloaded = 0
  let skipped = 0
  for (let i = 0; i < index.files.length; i++) {
    signal?.throwIfAborted()
    const item = index.files[i]
    if (item.env?.server === 'unsupported') { skipped++; continue }
    const rel = safeRelativeName(item.path)
    if (!rel) throw new Error(`Modrinth 索引包含非法文件路径：${item.path}`)
    const target = path.join(root, ...rel.split('/'))
    const hashes = item.hashes || {}
    const algorithm = ['sha512', 'sha1'].find(a => hashes[a])
    if (!algorithm) throw new Error(`Modrinth 索引缺少文件校验值：${rel}`)
    if (fs.existsSync(target)) {
      const digest = crypto.createHash(algorithm)
      for await (const chunk of fs.createReadStream(target)) { signal?.throwIfAborted(); digest.update(chunk) }
      if (digest.digest('hex').toLowerCase() === String(hashes[algorithm]).toLowerCase()) { skipped++; continue }
    }
    const urls = Array.isArray(item.downloads) ? item.downloads : []
    if (!urls.length) throw new Error(`Modrinth 索引缺少下载地址：${rel}`)
    let complete = false
    let lastError = null
    for (const url of urls) {
      try {
        await downloadVerified(url, target, { signal, size: item.fileSize, hash: hashes[algorithm], algorithm, maxBytes: 512 * 1024 ** 2,
          onProgress: ({ received, total }) => report(onProgress, 'mods-download', 28 + i / index.files.length * 15,
            `Modrinth ${i + 1}/${index.files.length}：${path.basename(rel)} · 已下载 ${Math.round(received / 1024)} KB${total ? ` / ${Math.round(total / 1024)} KB` : ''}`) })
        complete = true; break
      } catch (e) { signal?.throwIfAborted(); lastError = e }
    }
    if (!complete) throw new Error(`下载 Modrinth 文件失败：${rel}${lastError ? `（${lastError.message}）` : ''}`)
    downloaded++
    report(onProgress, 'mods-download', 28 + ((i + 1) / index.files.length) * 15, `正在下载 mod ${i + 1}/${index.files.length}：${path.basename(rel)}`)
  }
  return { downloaded, skipped }
}

async function findFile(root, predicate, depth = 0) {
  if (depth > 4) return null
  for (const ent of await fsp.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, ent.name)
    if (ent.isFile() && predicate(ent.name, full)) return full
    if (ent.isDirectory()) {
      const hit = await findFile(full, predicate, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

export async function writeServerScripts(root, runtime, info, options = {}) {
  if (runtime.cleanroom || runtime.loader === 'cleanroom') {
    const names = await fsp.readdir(root)
    const name = names.find(n => /^cleanroom-[0-9].*\.jar$/i.test(n) && !/-(installer|sources|universal)\.jar$/i.test(n))
    if (!name) throw new Error('Cleanroom 安装器没有生成服务端核心')
    const launch = await writeLaunchFiles(root, runtime, ['-jar', name, 'nogui'], options)
    return { jar: name, mode: 'jar', ...launch }
  }
  let jar = info.launchJar ? await findFile(root, (name) => name === info.launchJar) : null
  const installerScript = (runtime.loader === 'forge' || runtime.loader === 'neoforge') && fs.existsSync(path.join(root, 'run.bat'))
  if (!jar && !installerScript && (runtime.loader === 'forge' || runtime.loader === 'neoforge')) {
    jar = await findFile(root, (name) => /^(?:forge|neoforge)-.*(?:-server)?\.jar$/i.test(name) && !/-installer\.jar$/i.test(name))
  }
  if (jar) {
    const rel = path.relative(root, jar).replace(/\\/g, '/')
    const launch = await writeLaunchFiles(root, runtime, ['-jar', rel, 'nogui'], options)
    return { jar: rel, mode: 'jar', ...launch }
  }

  // 新版 Forge/NeoForge 安装器生成 run.bat/run.sh，使用 libraries 中的参数文件。
  const runBat = path.join(root, 'run.bat')
  if ((runtime.loader === 'forge' || runtime.loader === 'neoforge') && fs.existsSync(runBat)) {
    const bat = await fsp.readFile(runBat, 'utf8')
    const jarRef = /-jar\s+["']?([^\s"']+\.jar)/i.exec(bat)?.[1]
    if (jarRef && !fs.existsSync(path.resolve(root, jarRef))) throw new Error(`安装器生成的启动脚本引用了不存在的核心：${jarRef}`)
    const argsFiles = [...bat.matchAll(/@([^\s"']+\.txt)/gi)].map((m) => m[1].replace(/%[^%]+%/g, ''))
    for (const ref of argsFiles) {
      if (!fs.existsSync(path.resolve(root, ref))) throw new Error(`安装器生成的启动脚本缺少参数文件：${ref}`)
    }
    const winArgs = argsFiles.find(ref => /win_args\.txt$/i.test(ref))
    if (!winArgs) throw new Error('安装器启动脚本缺少 win_args.txt，无法安全生成启动参数')
    const unixArgs = winArgs.replace(/win_args\.txt$/i, 'unix_args.txt')
    // Remove installer defaults that could override the user's requested heap.
    const userArgs = path.join(root, 'user_jvm_args.txt')
    if (fs.existsSync(userArgs)) {
      const existing = await fsp.readFile(userArgs, 'utf8')
      await fsp.writeFile(userArgs, existing.replace(/^[ \t]*-Xm[sx]\S+[^\r\n]*$/gm, ''))
    }
    const extra = fs.existsSync(userArgs) ? ['@user_jvm_args.txt'] : []
    const launch = await writeLaunchFiles(root, runtime, [...extra, '@' + winArgs, 'nogui'], options)
    if (fs.existsSync(path.join(root, unixArgs))) {
      const sh = await fsp.readFile(path.join(root, 'start.sh'), 'utf8')
      await fsp.writeFile(path.join(root, 'start.sh'), sh.replace('@' + winArgs, '@' + unixArgs))
    } else throw new Error('安装器缺少 unix_args.txt，无法生成跨平台启动脚本')
    return { mode: 'installer-script', ...launch }
  }
  throw new Error(`服务端核心安装完成但未找到可启动文件（${runtime.loader} ${runtime.mc} ${runtime.loaderVersion}）`)
}

async function installCoreForPack(root, runtime, onProgress, options, signal) {
  report(onProgress, 'core-resolve', 50, `正在解析 ${runtime.loader} ${runtime.mc}`)
  const info = await resolveDownload({ ...runtime, signal })
  signal?.throwIfAborted()
  const job = await community.startDownload({
    url: info.url,
    // Forge/NeoForge 官方 maven 在国内经常不可达，服务端核心下载支持镜像回退。
    mirrors: Array.isArray(info.mirrors) ? info.mirrors : [],
    filename: info.filename,
    dir: root,
    title: `${runtime.loader} ${runtime.mc}`,
    postCommand: info.postCommand ? [options.javaPath, ...info.postCommand.slice(1)] : undefined,
    extraFiles: info.extraFiles,
    preserveName: true,
    exactDir: true,
    meta: { type: 'servercore', source: 'pack-converter' }
  })
  try {
    let current = job
    while (current && !['done', 'failed', 'cancelled'].includes(current.status)) {
      if (signal?.aborted) {
        await community.cancelJobAndWait(job.id)
        throw new Error('转换已中止')
      }
      if (current.status === 'installing') {
        const p = typeof current.installProgress === 'number' ? current.installProgress : null
        report(onProgress, 'core-install', p == null ? null : 70 + p * 0.16, current.installLog || '正在执行服务端安装器（未提供总进度）')
      } else {
        const p = current.total ? current.received / current.total : null
        report(onProgress, 'core-download', p == null ? null : 50 + p * 20,
          `正在下载服务端核心${p == null ? ` · 已下载 ${Math.round((current.received || 0) / 1024)} KB` : ` ${Math.round(p * 100)}%`}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
      current = community.getJob(job.id)
    }
    if (!current || current.status !== 'done') throw new Error(current?.error || '服务端核心安装失败')
    signal?.throwIfAborted()
    report(onProgress, 'core-verify', 88, '正在校验服务端核心和启动文件')
    for (const ent of await fsp.readdir(root, { withFileTypes: true })) {
      if (ent.isFile() && /^(?:fabric|quilt|forge|neoforge|cleanroom)-.*installer(?:[-_.].*)?\.jar$/i.test(ent.name)) await fsp.rm(path.join(root, ent.name), { force: true })
    }
    let bundledJava = null
    if (options.bundleJava) {
      report(onProgress, 'java-bundle', 88, '正在将兼容 Java 复制到服务端包…')
      bundledJava = await bundleJavaRuntime(root, options.javaPath, signal, ({ copied, total, file }) => report(onProgress, 'java-bundle', 88 + (total ? copied / total : 1), `复制 Java：${Math.round(copied / 1024 / 1024)} / ${Math.round(total / 1024 / 1024)} MB · ${file}`))
    }
    const launch = await writeServerScripts(root, runtime, info, { ...options, javaPath: bundledJava?.path || options.javaPath })
    return { ...launch, bundledJava }
  } finally {
    if (signal?.aborted) await community.cancelJobAndWait(job.id)
  }
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

async function findModsDirs(root, signal, runtime, onProgress) {
  const found = []
  const walk = async (dir, depth) => {
    signal?.throwIfAborted()
    if (depth > 8) return
    for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
      if (!ent.isDirectory() || ['.git', '.mc-i18n', 'node_modules'].includes(ent.name)) continue
      const full = path.join(dir, ent.name)
      if (ent.name.toLowerCase() === 'mods') {
        const jars = await scanModsDir(full, { recursive: true, includeDisabled: true, signal, runtime, onProgress: ({ done, file }) => report(onProgress, 'mod-scan', null, `读取模组元数据和内嵌依赖：已扫描 ${done} 个 · ${file}`) })
        if (jars.length) found.push({ dir: full, items: jars })
        continue
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

function compareModVersions(a, b) {
  const left = String(a || '').trim().toLowerCase().replace(/^v/, '')
  const right = String(b || '').trim().toLowerCase().replace(/^v/, '')
  if (!left || !right) return null
  const parse = (value) => value.split(/[.+\-]/).map((part) => {
    const match = /^(\d+)/.exec(part)
    return match ? Number(match[1]) : part
  })
  const av = parse(left)
  const bv = parse(right)
  const length = Math.max(av.length, bv.length)
  for (let i = 0; i < length; i++) {
    const x = av[i] ?? 0
    const y = bv[i] ?? 0
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1
    } else if (String(x) !== String(y)) return String(x).localeCompare(String(y))
  }
  return 0
}

function satisfiesVersionRange(version, range) {
  const rule = String(range || '').trim()
  if (!rule || /^any$/i.test(rule) || !version) return true
  // Forge's common Maven-style ranges: [min,), (,max], [min,max).
  const bracket = /^([[(])\s*([^,\]]*)\s*(?:,\s*([^\])]*))?\s*([)\]])$/.exec(rule)
  if (bracket) {
    const [, left, min, max, right] = bracket
    if (min) {
      const cmp = compareModVersions(version, min)
      if (cmp !== null && (cmp < 0 || (cmp === 0 && left === '('))) return false
    }
    if (max) {
      const cmp = compareModVersions(version, max)
      if (cmp !== null && (cmp > 0 || (cmp === 0 && right === ')'))) return false
    }
    return true
  }
  if (/^(?:[<>=!]=?|~\s*)/.test(rule)) {
    const m = /^(>=|<=|>|<|=|==|!=|~)\s*(.+)$/.exec(rule)
    if (!m) return true
    const cmp = compareModVersions(version, m[2])
    if (cmp === null) return true
    if (m[1] === '>' || m[1] === '>=') return cmp > 0 || (m[1] === '>=' && cmp === 0)
    if (m[1] === '<' || m[1] === '<=') return cmp < 0 || (m[1] === '<=' && cmp === 0)
    if (m[1] === '!=' ) return cmp !== 0
    return cmp === 0
  }
  // A bare version is treated as an exact requirement when it is clearly
  // numeric. Unknown loader-specific expressions remain permissive.
  if (/^\d[\w.+\-]*$/.test(rule)) return compareModVersions(version, rule) === 0
  return true
}

function dependencyProvider(index, id) {
  const list = index.get(String(id || '').toLowerCase()) || []
  return list.find((item) => !item.disabled) || null
}

export function planModRemoval(modsDirs, clientModIds, autoDetectEnv, runtime = {}) {
  const all = modsDirs.flatMap((group) => group.items)
  const ids = new Set(clientModIds.map((id) => String(id).trim().toLowerCase()).filter(Boolean))
  const remove = new Set()
  const matched = []
  for (const mod of all) {
    const byLibrary = (mod.modids || [mod.modid]).some(id => ids.has(String(id).toLowerCase()))
    const byEnvironment = autoDetectEnv && mod.environment === 'client'
    const compatibilityReason = autoDetectEnv && serverRemovalReason(mod, runtime)
    if (byLibrary || byEnvironment || compatibilityReason) {
      remove.add(mod.path)
      matched.push({ ...mod, rule: compatibilityReason || (byLibrary ? 'modid 库' : 'environment=client') })
    }
  }

  const providers = new Map()
  for (const mod of all) {
    const modids = Array.isArray(mod.modids) && mod.modids.length ? mod.modids : (mod.modid ? [mod.modid] : [])
    for (const modid of modids) {
      const key = String(modid).toLowerCase()
      const list = providers.get(key) || []
      list.push(mod)
      providers.set(key, list)
    }
  }

  // A server-side mod may depend on a library that the client-only list would
  // otherwise remove (JEI and The One Probe are common 1.12 examples). Walk
  // the retained graph and protect those providers before deleting anything.
  const retained = all.filter((mod) => !remove.has(mod.path) && !mod.disabled)
  const queued = [...retained]
  const visited = new Set()
  const missing = [], versionWarnings = []
  while (queued.length) {
    const mod = queued.shift()
    if (visited.has(mod.path)) continue
    visited.add(mod.path)
    for (const dep of (mod.dependencies || [])) {
      if (dep.optional === true || dep.required === false) continue
      if ((runtime.cleanroom || runtime.loader === 'cleanroom') && ['mixinbooter', 'configanytime', 'cleanroom'].includes(dep.id.toLowerCase())) continue
      const provider = dependencyProvider(providers, dep.id)
      if (!provider) {
        missing.push({ mod, dep, reason: 'missing' })
        continue
      }
      const version = provider.providedVersions?.[dep.id.toLowerCase()] || provider.version
      if (!satisfiesVersionRange(version, dep.range)) {
        versionWarnings.push(`${mod.modid || mod.file} 需要 ${dep.id} ${dep.range}，检测到 ${version}；分支模组和运行时补丁可能重写版本，请以加载器启动校验为准。`)
      }
      if (remove.has(provider.path)) {
        remove.delete(provider.path)
        const record = matched.find((item) => item.path === provider.path)
        if (record) record.protectedBy = mod.modid || mod.name
        queued.push(provider)
      }
    }
  }
  const dedupedMissing = []
  const seenMissing = new Set()
  for (const item of missing) {
    const key = `${item.mod.path}|${item.dep.id}|${item.dep.range}|${item.reason}`
    if (!seenMissing.has(key)) { seenMissing.add(key); dedupedMissing.push(item) }
  }
  if (dedupedMissing.length) {
    const lines = dedupedMissing.slice(0, 30).map(({ mod, dep, provider, reason }) => {
      const source = mod.modid || mod.name || path.basename(mod.path)
      const requirement = dep.range || '任意版本'
      if (reason === 'version') return `- ${source} 需要 ${dep.id} ${requirement}，当前为 ${provider?.version || '未知版本'}`
      return `- ${source} 需要 ${dep.id} ${requirement}`
    })
    if (dedupedMissing.length > lines.length) lines.push(`- 还有 ${dedupedMissing.length - lines.length} 项依赖未列出`)
    throw new Error(`无法生成可启动服务端：检测到 ${dedupedMissing.length} 项必需模组依赖缺失或版本不符合。\n${lines.join('\n')}\n\n可能是客户端模组被误删、整合包本身缺文件，或该整合包需要官方服务端专用文件。请补齐依赖后重试。`)
  }
  return { remove, matched, total: all.length, versionWarnings }
}

export async function convertPack({ source, outputDir = '', outputName = '', clientModIds = [], autoDetectEnv = true, uploaded = false, installServerCore = false, runtime = null, memory = '4G', minMemory = '1G', javaPath = '', bundleJava = false, curseForgeApiKey = '', worldPreset = '', onProgress, signal }) {
  signal?.throwIfAborted()
  worldPreset = String(worldPreset).trim()
  if (worldPreset && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(worldPreset)) throw new Error('世界预设 UUID 格式不正确；不使用 Default World Generator 的整合包请留空')
  const launchOptions = { ...validateMemory(memory, minMemory), bundleJava }
  const input = path.resolve(String(source || ''))
  if (!input || !fs.existsSync(input)) throw new Error('客户端整合包或目录不存在')
  const sourceStat = await fsp.stat(input)
  const isDir = sourceStat.isDirectory()
  if (!isDir && !/\.(zip|mrpack)$/i.test(input)) throw new Error('只支持整合包目录、.zip 或 .mrpack 文件')

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-convert-'))
  let staging = path.join(tempRoot, 'pack')
  await fsp.mkdir(staging)
  let sourceInfo = { unpacked: false, entries: 0 }
  try {
    report(onProgress, 'extract', isDir ? null : 2, isDir ? '正在复制整合包目录' : '正在解压整合包')
    if (isDir) {
      let copied = 0, last = 0
      await fsp.cp(input, staging, { recursive: true, force: true, filter: file => {
        signal?.throwIfAborted(); copied++
        if (Date.now() - last > 250) { last = Date.now(); report(onProgress, 'extract', null, `复制整合包：已处理 ${copied} 项 · ${path.basename(file)}`) }
        return true
      } })
    }
    else {
      const result = await extractZip(input, staging, (p, name) => report(onProgress, 'extract', 2 + p * 23, name), signal)
      sourceInfo = { unpacked: true, entries: result.index.entries.length, bytes: result.unpacked }
    }
    report(onProgress, 'scan', 28, '正在识别整合包版本和加载器')
    const completeManual = runtime?.mc && runtime?.loader && (runtime.loader === 'vanilla' || runtime.loaderVersion)
    const detectedRuntime = await detectPackRuntime(staging, { signal }).catch(e => { if (completeManual && !signal?.aborted) return null; throw e })
    const selectedRuntime = mergeRuntime(detectedRuntime, runtime || {})
    if (selectedRuntime.loader === 'cleanroom' && !selectedRuntime.loaderVersion) selectedRuntime.loaderVersion = (await listLoaderVersions('cleanroom', '1.12.2'))[0]?.version || ''
    staging = await findPackRoot(staging, detectedRuntime, signal)
    if (installServerCore && (!selectedRuntime?.mc || !selectedRuntime?.loader || (selectedRuntime.loader !== 'vanilla' && !selectedRuntime.loaderVersion))) {
      const missing = [!selectedRuntime.mc && 'MC 版本', !selectedRuntime.loader && '加载器', selectedRuntime.loader !== 'vanilla' && !selectedRuntime.loaderVersion && '加载器版本'].filter(Boolean)
      throw new Error('无法确定：' + missing.join('、') + '。请选择包含版本文件的完整实例目录，或手动补全；仅选择 Forge 还不足以确定版本。')
    }
    report(onProgress, 'scan', 28, selectedRuntime.mc ? `已识别 ${selectedRuntime.mc} / ${selectedRuntime.loader} ${selectedRuntime.loaderVersion || ''}（${detectedRuntime?.source || '手动填写'}）` : '正在扫描 mod')
    if (installServerCore) {
      const java = await resolveJava(selectedRuntime, javaPath)
      launchOptions.javaPath = java.path
      report(onProgress, 'scan', 28, `Java ${java.major}（64 位）· 初始 ${launchOptions.minMemory} / 最大 ${launchOptions.memory}`)
    }
    const curseforge = await hydrateCurseForgeFiles(staging, onProgress, signal, { apiKey: curseForgeApiKey })
    const indexed = await hydrateModrinthFiles(staging, onProgress, signal)
    await normalizePackLayout(staging, signal)
    if (worldPreset) {
      const properties = path.join(staging, 'server.properties')
      const old = await fsp.readFile(properties, 'utf8').catch(() => '')
      await fsp.writeFile(properties, old.replace(/^defaultworldgenerator-port=.*\r?\n?/gm, '') + `\ndefaultworldgenerator-port=${worldPreset}\n`)
    }
    const modsDirs = await findModsDirs(staging, signal, selectedRuntime, onProgress)
    const { remove, matched, total, versionWarnings } = planModRemoval(modsDirs, clientModIds, autoDetectEnv, selectedRuntime)
    const compatibility = await applyServerCompatibility(staging, modsDirs.flatMap(group => group.items), remove, signal)
    for (const file of remove) { signal?.throwIfAborted(); await fsp.unlink(file) }
    const protectedCount = matched.filter((item) => item.protectedBy).length
    report(onProgress, 'mods', 45, `已扫描 ${total} 个 mod，移除 ${matched.length - protectedCount} 个客户端 mod，保留 ${protectedCount} 个依赖库`)

    let core = null
    if (installServerCore) core = await installCoreForPack(staging, selectedRuntime, onProgress, launchOptions, signal)

    const conversionReport = {
      runtime: selectedRuntime, totalMods: total,
      removed: matched.filter(m => !m.protectedBy).map(m => ({ file: m.file, modid: m.modid, rule: m.rule })),
      protected: matched.filter(m => m.protectedBy).map(m => ({ file: m.file, requiredBy: m.protectedBy })),
      compatibility, warnings: versionWarnings, curseforge, worldPreset,
      validation: '已检查依赖、核心安装和启动入口；此转换任务未进行世界加载或玩家联机测试。请在开服管理中实际启动并查看日志。'
    }
    await fsp.writeFile(path.join(staging, 'toolbox-conversion-report.json'), JSON.stringify(conversionReport, null, 2))

    const dir = String(outputDir || '').trim()
      ? path.resolve(outputDir)
      : (isDir ? path.dirname(input) : (uploaded ? defaultDownloadsDir() : path.dirname(input)))
    await fsp.mkdir(dir, { recursive: true })
    const base = outputName || `${path.basename(input, path.extname(input))}-server.zip`
    const output = await uniqueOutput(dir, base.toLowerCase().endsWith('.zip') ? base : base + '.zip')
    report(onProgress, 'pack', 90, '正在生成服务端压缩包')
    const partial = path.join(tempRoot, 'output.zip')
    const packed = await packDirectory(staging, partial, (p, name) => report(onProgress, 'pack', 90 + p * 9, name), signal)
    signal?.throwIfAborted()
    const pendingOutput = output + '.part-' + crypto.randomUUID()
    try {
      await fsp.copyFile(partial, pendingOutput)
      signal?.throwIfAborted()
      report(onProgress, 'publishing', 99, '正在保存最终压缩包…')
      await fsp.rename(pendingOutput, output)
    } finally { await fsp.rm(pendingOutput, { force: true }) }
    const warnings = [...versionWarnings]
    if (!outputDir) warnings.push(uploaded ? '未选择输出目录，拖入的文件已输出到系统下载目录。' : '未选择输出目录，已输出到客户端原文件所在目录。')
    report(onProgress, 'done', 100, '服务端包已生成')
    return {
      source: input,
      output,
      outputDir: dir,
      sourceInfo,
      indexedFiles: indexed,
      curseforge,
      modsDirs: modsDirs.map((x) => x.dir),
      totalMods: total,
      removed: matched,
      removedCount: matched.filter((item) => !item.protectedBy).length,
      packed,
      runtime: selectedRuntime || null,
      core,
      compatibility,
      validation: conversionReport.validation,
      warnings
    }
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

const convertJobs = new Map()
let convertJobSeq = 1

function publicConvertJob(job) {
  const { cleanup, controller, ...rest } = job
  return rest
}

export function getConvertJob(id) {
  const job = convertJobs.get(id)
  return job ? publicConvertJob(job) : null
}

export function cancelConvertJob(id) {
  const job = convertJobs.get(id)
  if (!job || job.stage === 'publishing' || ['done', 'failed', 'cancelled'].includes(job.status)) return false
  job.status = 'cancelling'
  job.detail = '正在中止转换并清理临时文件…'
  job.controller.abort()
  return true
}

export function startConvertJob(options) {
  const id = 'convert_' + convertJobSeq++
  const job = { id, status: 'queued', progress: 0, stage: 'queued', detail: '等待转换任务', result: null, error: null, startedAt: Date.now(), finishedAt: null, cleanup: options.cleanup, controller: new AbortController() }
  convertJobs.set(id, job)
  setImmediate(async () => {
    let terminal = 'done'
    job.status = 'running'
    job.startedAt = Date.now()
    try {
      job.result = await convertPack({ ...options, signal: job.controller.signal, onProgress: (p) => { if (job.controller.signal.aborted) throw new Error('转换已中止'); Object.assign(job, p) } })
      job.progress = 100
      job.stage = 'done'
      job.detail = '服务端包已生成'
    } catch (e) {
      const cancelled = job.controller.signal.aborted || e.message === '转换已中止'
      terminal = cancelled ? 'cancelled' : 'failed'
      job.stage = cancelled ? 'cancelled' : 'failed'
      job.error = cancelled ? null : e.message
      job.detail = cancelled ? '转换已中止，临时文件已清理' : e.message
    } finally {
      if (typeof job.cleanup === 'function') await Promise.resolve(job.cleanup()).catch(() => {})
      job.cleanup = null
      job.status = terminal
      job.finishedAt = Date.now()
    }
  })
  return publicConvertJob(job)
}

export async function writeUploadedPack(buffer, name) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('未收到整合包文件')
  if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error('整合包超过 4 GB，请解压后选择实例文件夹')
  const ext = /\.(mrpack|zip)$/i.exec(String(name || ''))?.[1] || 'zip'
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-upload-'))
  const file = path.join(dir, `client-pack.${ext.toLowerCase()}`)
  await fsp.writeFile(file, buffer)
  return { dir, file }
}

// Stream browser uploads to disk; aborting the HTTP request removes the partial file.
export async function receiveUploadedPack(req, name, { allowJar = false } = {}) {
  if (Number(req.headers['content-length']) > MAX_ARCHIVE_BYTES) throw new Error('整合包超过 4 GB；请解压后使用“选择文件夹”')
  const ext = (allowJar ? /\.(mrpack|zip|jar)$/i : /\.(mrpack|zip)$/i).exec(name)?.[1]
  if (!ext) throw new Error('仅支持 ZIP 或 .mrpack')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-upload-'))
  const file = path.join(dir, 'client-pack.' + ext.toLowerCase())
  let handle
  try {
    handle = await fsp.open(file, 'w')
    let total = 0
    for await (const chunk of req) {
      total += chunk.length
      if (total > MAX_ARCHIVE_BYTES) throw new Error('整合包超过 4 GB；请解压后使用“选择文件夹”')
      await handle.writeFile(chunk)
    }
    if (!total || req.aborted) throw new Error('上传中止或文件为空')
    await handle.close()
    return { dir, file }
  } catch (e) {
    await handle?.close().catch(() => {})
    await removeTempPack(dir)
    throw e
  }
}

export async function removeTempPack(dir) {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
}
