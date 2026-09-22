import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { scanModsDir } from './mods.js'
import { resolveDownload } from './servercore.js'
import * as community from './community.js'
import { httpFetch } from './http.js'

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

async function extractZip(filePath, targetDir, onProgress) {
  const index = await readZipIndex(filePath)
  const fh = await fsp.open(filePath, 'r')
  let unpacked = 0
  try {
    let done = 0
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
      done++
      onProgress?.(done / Math.max(1, index.entries.length), entry.name)
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

async function packDirectory(sourceDir, outputFile, onProgress) {
  const files = await listFiles(sourceDir)
  const locals = []
  const centrals = []
  let offset = 0
  for (let index = 0; index < files.length; index++) {
    const file = files[index]
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
    onProgress?.((index + 1) / Math.max(1, files.length), file.rel)
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

function report(onProgress, stage, progress, detail = '') {
  if (typeof onProgress === 'function') onProgress({ stage, progress: Math.max(0, Math.min(100, progress)), detail })
}

async function readJson(file) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')) } catch { return null }
}

function loaderFromId(id) {
  const value = String(id || '').toLowerCase()
  const m = /^(fabric-loader|quilt-loader|neoforge|forge)[-_](.+)$/.exec(value)
  if (!m) return null
  return { loader: m[1].replace('-loader', ''), loaderVersion: m[2] }
}

/** 从 CurseForge/Modrinth 清单推断服务端安装所需的版本。 */
export async function detectPackRuntime(root) {
  const candidates = [path.join(root, 'manifest.json'), path.join(root, 'modrinth.index.json')]
  for (const file of candidates) {
    const data = await readJson(file)
    if (!data) continue
    if (data.minecraft?.version && Array.isArray(data.minecraft.modLoaders)) {
      const loader = data.minecraft.modLoaders.map((x) => loaderFromId(x.id)).find(Boolean)
      if (loader) return { mc: data.minecraft.version, ...loader, source: path.basename(file) }
    }
    const deps = data.dependencies || {}
    const mc = deps.minecraft || data.minecraft?.version
    if (mc) {
      for (const key of ['fabric-loader', 'forge', 'neoforge', 'quilt-loader']) {
        if (deps[key]) return { mc, loader: key.replace('-loader', ''), loaderVersion: String(deps[key]), source: path.basename(file) }
      }
    }
  }
  return null
}

async function copyTreeContents(source, target) {
  for (const ent of await fsp.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, ent.name)
    const to = path.join(target, ent.name)
    await fsp.mkdir(path.dirname(to), { recursive: true })
    if (ent.isDirectory()) await fsp.cp(from, to, { recursive: true, force: true })
    else await fsp.copyFile(from, to)
  }
}

async function normalizePackLayout(root) {
  for (const name of ['overrides', 'client-overrides']) {
    const dir = path.join(root, name)
    if (fs.existsSync(dir) && (await fsp.stat(dir)).isDirectory()) {
      await copyTreeContents(dir, root)
      await fsp.rm(dir, { recursive: true, force: true })
    }
  }
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

async function hydrateModrinthFiles(root, onProgress) {
  const indexPath = path.join(root, 'modrinth.index.json')
  const index = await readJson(indexPath)
  if (!index || !Array.isArray(index.files) || !index.files.length) return { downloaded: 0, skipped: 0 }
  let downloaded = 0
  let skipped = 0
  for (let i = 0; i < index.files.length; i++) {
    const item = index.files[i]
    const rel = safeRelativeName(item.path)
    if (!rel) throw new Error(`Modrinth 索引包含非法文件路径：${item.path}`)
    const target = path.join(root, ...rel.split('/'))
    if (fs.existsSync(target)) { skipped++; continue }
    const urls = Array.isArray(item.downloads) ? item.downloads : []
    if (!urls.length) throw new Error(`Modrinth 索引缺少下载地址：${rel}`)
    let response = null
    let lastError = null
    for (const url of urls) {
      try {
        const res = await httpFetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'mc-toolbox/1.0' } })
        if (res.ok) { response = res; break }
        lastError = new Error(`HTTP ${res.status}`)
      } catch (e) { lastError = e }
    }
    if (!response) throw new Error(`下载 Modrinth 文件失败：${rel}${lastError ? `（${lastError.message}）` : ''}`)
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length > MAX_ARCHIVE_BYTES) throw new Error(`Modrinth 文件过大：${rel}`)
    const hashes = item.hashes || {}
    for (const algorithm of ['sha512', 'sha1']) {
      if (!hashes[algorithm]) continue
      const actual = crypto.createHash(algorithm).update(data).digest('hex')
      if (actual.toLowerCase() !== String(hashes[algorithm]).toLowerCase()) throw new Error(`Modrinth 文件校验失败：${rel}`)
      break
    }
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, data)
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

async function writeServerScripts(root, runtime, info, memory = '2G') {
  const mem = String(memory || '2G').trim()
  let jar = info.launchJar ? await findFile(root, (name) => name === info.launchJar) : null
  if (!jar && (runtime.loader === 'forge' || runtime.loader === 'neoforge')) {
    jar = await findFile(root, (name) => /^(?:forge|neoforge)-.*(?:-server)?\.jar$/i.test(name) && !/-installer\.jar$/i.test(name))
  }
  if (jar) {
    const rel = path.relative(root, jar).replace(/\\/g, '/')
    const cmd = `java -Xms${mem} -Xmx${mem} -jar "${rel}" nogui`
    await fsp.writeFile(path.join(root, 'start.bat'), `@echo off\r\nchcp 65001 >nul\r\ntitle Minecraft Server\r\n${cmd}\r\npause\r\n`)
    await fsp.writeFile(path.join(root, 'start.sh'), `#!/bin/sh\n${cmd}\n`)
    await fsp.chmod(path.join(root, 'start.sh'), 0o755).catch(() => {})
    return { jar: rel, mode: 'jar' }
  }

  // 新版 Forge/NeoForge 安装器生成 run.bat/run.sh，使用 libraries 中的参数文件。
  const runBat = path.join(root, 'run.bat')
  const runSh = path.join(root, 'run.sh')
  if ((runtime.loader === 'forge' || runtime.loader === 'neoforge') && fs.existsSync(runBat)) {
    const bat = await fsp.readFile(runBat, 'utf8')
    const jarRef = /-jar\s+["']?([^\s"']+\.jar)/i.exec(bat)?.[1]
    if (jarRef && !fs.existsSync(path.resolve(root, jarRef))) throw new Error(`安装器生成的启动脚本引用了不存在的核心：${jarRef}`)
    const argsFiles = [...bat.matchAll(/@([^\s"']+\.txt)/gi)].map((m) => m[1].replace(/%[^%]+%/g, ''))
    for (const ref of argsFiles) {
      if (!fs.existsSync(path.resolve(root, ref))) throw new Error(`安装器生成的启动脚本缺少参数文件：${ref}`)
    }
    await fsp.copyFile(runBat, path.join(root, 'start.bat'))
    if (fs.existsSync(runSh)) await fsp.copyFile(runSh, path.join(root, 'start.sh'))
    else await fsp.writeFile(path.join(root, 'start.sh'), '#!/bin/sh\nsh "$(dirname "$0")/start.bat"\n')
    await fsp.chmod(path.join(root, 'start.sh'), 0o755).catch(() => {})
    return { mode: 'installer-script' }
  }
  throw new Error(`服务端核心安装完成但未找到可启动文件（${runtime.loader} ${runtime.mc} ${runtime.loaderVersion}）`)
}

async function installCoreForPack(root, runtime, onProgress, memory) {
  report(onProgress, 'core-resolve', 50, `正在解析 ${runtime.loader} ${runtime.mc}`)
  const info = await resolveDownload(runtime)
  community.configure({ subdirByType: false })
  const job = await community.startDownload({
    url: info.url,
    filename: info.filename,
    dir: root,
    title: `${runtime.loader} ${runtime.mc}`,
    postCommand: info.postCommand,
    extraFiles: info.extraFiles,
    preserveName: true,
    meta: { type: 'servercore', source: 'pack-converter' }
  })
  let current = job
  while (current && !['done', 'failed', 'cancelled'].includes(current.status)) {
    if (current.status === 'installing') {
      const p = typeof current.installProgress === 'number' ? current.installProgress : 0
      report(onProgress, 'core-install', 70 + p * 0.16, current.installLog || '正在执行服务端安装器')
    } else {
      const p = current.total ? current.received / current.total : 0
      report(onProgress, 'core-download', 50 + p * 20, `正在下载服务端核心 ${Math.round(p * 100)}%`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
    current = community.getJob(job.id)
  }
  if (!current || current.status !== 'done') throw new Error(current?.error || '服务端核心安装失败')
  report(onProgress, 'core-verify', 88, '正在校验服务端核心和启动文件')
  for (const ent of await fsp.readdir(root, { withFileTypes: true })) {
    if (ent.isFile() && /(?:fabric|quilt|forge|neoforge)-installer(?:[-_.].*)?\.jar$/i.test(ent.name)) await fsp.rm(path.join(root, ent.name), { force: true })
  }
  return await writeServerScripts(root, runtime, info, memory)
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

export async function convertPack({ source, outputDir = '', outputName = '', clientModIds = [], autoDetectEnv = true, uploaded = false, installServerCore = false, runtime = null, memory = '2G', onProgress }) {
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
    report(onProgress, 'extract', 2, isDir ? '正在复制整合包目录' : '正在解压整合包')
    if (isDir) await fsp.cp(input, staging, { recursive: true, force: true })
    else {
      const result = await extractZip(input, staging, (p, name) => report(onProgress, 'extract', 2 + p * 23, name))
      sourceInfo = { unpacked: true, entries: result.index.entries.length, bytes: result.unpacked }
    }
    report(onProgress, 'scan', 28, '正在识别整合包版本和加载器')
    const detectedRuntime = await detectPackRuntime(staging)
    const indexed = await hydrateModrinthFiles(staging, onProgress)
    await normalizePackLayout(staging)
    const selectedRuntime = runtime?.mc && runtime?.loader
      ? { mc: String(runtime.mc), loader: String(runtime.loader), loaderVersion: String(runtime.loaderVersion || '') }
      : detectedRuntime
    if (installServerCore && (!selectedRuntime?.mc || !selectedRuntime?.loader || (selectedRuntime.loader !== 'vanilla' && !selectedRuntime.loaderVersion))) {
      throw new Error('无法从整合包识别 MC 版本或加载器版本，请在转换设置中手动指定')
    }
    const modsDirs = await findModsDirs(staging)
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
    report(onProgress, 'mods', 45, `已扫描 ${total} 个 mod，移除 ${matched.length} 个客户端 mod`)

    let core = null
    if (installServerCore) core = await installCoreForPack(staging, selectedRuntime, onProgress, memory)

    const dir = String(outputDir || '').trim()
      ? path.resolve(outputDir)
      : (isDir ? path.dirname(input) : (uploaded ? defaultDownloadsDir() : path.dirname(input)))
    await fsp.mkdir(dir, { recursive: true })
    const base = outputName || `${path.basename(input, path.extname(input))}-server.zip`
    const output = await uniqueOutput(dir, base.toLowerCase().endsWith('.zip') ? base : base + '.zip')
    report(onProgress, 'pack', 90, '正在生成服务端压缩包')
    const packed = await packDirectory(staging, output, (p, name) => report(onProgress, 'pack', 90 + p * 9, name))
    const warnings = []
    if (!outputDir) warnings.push(uploaded ? '未选择输出目录，拖入的文件已输出到系统下载目录。' : '未选择输出目录，已输出到客户端原文件所在目录。')
    if (/\.mrpack$/i.test(input)) warnings.push('.mrpack 只包含索引和 overrides；未下载索引中缺失的 mod。')
    report(onProgress, 'done', 100, '服务端包已生成')
    return {
      source: input,
      output,
      outputDir: dir,
      sourceInfo,
      indexedFiles: indexed,
      modsDirs: modsDirs.map((x) => x.dir),
      totalMods: total,
      removed: matched,
      removedCount: matched.length,
      packed,
      runtime: selectedRuntime || null,
      core,
      warnings
    }
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

const convertJobs = new Map()
let convertJobSeq = 1

function publicConvertJob(job) {
  const { cleanup, ...rest } = job
  return rest
}

export function getConvertJob(id) {
  const job = convertJobs.get(id)
  return job ? publicConvertJob(job) : null
}

export function startConvertJob(options) {
  const id = 'convert_' + convertJobSeq++
  const job = { id, status: 'queued', progress: 0, stage: 'queued', detail: '等待转换任务', result: null, error: null, startedAt: Date.now(), finishedAt: null, cleanup: options.cleanup }
  convertJobs.set(id, job)
  queueMicrotask(async () => {
    job.status = 'running'
    job.startedAt = Date.now()
    try {
      job.result = await convertPack({ ...options, onProgress: (p) => Object.assign(job, p) })
      job.progress = 100
      job.stage = 'done'
      job.detail = '服务端包已生成'
      job.status = 'done'
      job.finishedAt = Date.now()
    } catch (e) {
      job.status = 'failed'
      job.stage = 'failed'
      job.error = e.message
      job.detail = e.message
      job.finishedAt = Date.now()
    } finally {
      if (typeof job.cleanup === 'function') await Promise.resolve(job.cleanup()).catch(() => {})
      job.cleanup = null
    }
  })
  return publicConvertJob(job)
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
