// 实例内容：模组、资源包、光影、世界、截图、服务器列表、日志与崩溃报告。
import { receiveUpload, removeTempPack } from '../upload.js'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { instancePaths, findInstance } from './state.js'
import { scanModsDir } from '../mods.js'
import { readJarEntries } from '../zip.js'
import { analyzeCrash } from './launch-plan.js'
import { groupModDuplicates, analyzeModDuplicates, cleanupDuplicateMods } from './mod-dedupe.js'
import { listWorlds } from '../saveeditor.js'
import { inspectCrash } from './launch.js'
import { parse as nbtParse, write as nbtWrite, NbtNum } from '../nbt.js'
import { dirSize } from './download.js'

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i
const ICON_MAX_BYTES = 2 * 1024 * 1024
const ICON_CACHE_LIMIT = 600
const iconCache = new Map()
const resourcePackLocks = new Map()

const ICON_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

function pathIn(base, rel) {
  const raw = String(rel || '').replace(/\\/g, '/')
  if (!raw || raw.split('/').some((part) => part === '..' || part === '')) throw new Error('非法路径')
  const target = path.resolve(base, ...raw.split('/'))
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('路径超出目录')
  return target
}

function extType(name) {
  return path.extname(String(name || '')).toLowerCase()
}

async function listEntries(dir, { exts = null, dirs = true } = {}) {
  let entries = []
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    const isDir = entry.isDirectory()
    if (isDir && !dirs) continue
    if (!isDir && exts && !exts.includes(extType(entry.name))) continue
    if (entry.name.startsWith('.')) continue
    const stat = await fsp.stat(full).catch(() => null)
    out.push({
      name: entry.name,
      isDir,
      size: stat?.size || 0,
      mtime: stat?.mtimeMs || 0
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function readOptionLines(text) {
  const map = new Map()
  for (const line of String(text || '').split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    map.set(line.slice(0, idx), line.slice(idx + 1))
  }
  return map
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'))
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch { return [] }
}

async function readOptions(gameDir) {
  const file = path.join(gameDir, 'options.txt')
  let text
  try { text = await fsp.readFile(file, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') text = ''; else throw error }
  const map = readOptionLines(text)
  let resourcePacks = []
  if (map.has('resourcePacks')) {
    try {
      const parsed = JSON.parse(map.get('resourcePacks'))
      if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) throw new Error()
      resourcePacks = parsed
    } catch { throw new Error('options.txt 的 resourcePacks 格式无效，已停止修改') }
  }
  return {
    file,
    text,
    map,
    resourcePacks,
    incompatiblePacks: parseJsonArray(map.get('incompatibleResourcePacks'))
  }
}

/* ------------------------------------------------------------------ */
/* Mods                                                                */
/* ------------------------------------------------------------------ */

function dependencyId(value) {
  // Forge/Fabric 的 ID 大小写不敏感；yumi-commons-core 与 yumi_commons_core
  // 是同一个模组，不能因为分隔符不同就报「缺少前置」。
  return String(value || '').trim().toLowerCase().replace(/-/g, '_')
}

function modLoaderMatches(instanceLoader, modLoader) {
  if (!modLoader) return true
  const instance = String(instanceLoader || 'vanilla').toLowerCase()
  const mod = String(modLoader || '').toLowerCase()
  if (instance === 'vanilla') return false
  if (instance === 'forge') return mod === 'forge' || mod === 'legacy-forge'
  // NeoForge 1.20.1 与 Forge 生态接近；Quilt 也能加载 Fabric 模组。
  if (instance === 'neoforge') return mod === 'neoforge' || mod === 'forge' || mod === 'legacy-forge'
  if (instance === 'cleanroom') return mod === 'cleanroom' || mod === 'forge' || mod === 'legacy-forge'
  if (instance === 'quilt') return mod === 'quilt' || mod === 'fabric'
  return mod === instance
}

export async function listMods(inst, { signal } = {}) {
  const paths = instancePaths(inst)
  const items = await scanModsDir(paths.modsDir, {
    recursive: true,
    includeDisabled: true,
    gameDir: paths.gameDir,
    runtime: { mc: inst.mc, loader: inst.loader, loaderVersion: inst.loaderVersion },
    signal
  })
  const provided = new Set()
  const platform = new Set(['minecraft', 'forge', 'neoforge', 'fabricloader', 'fabric', 'quilt_loader', 'quilt', 'java']
    .map((id) => dependencyId(id)))
  for (const item of items) {
    const instanceLoader = String(inst.loader || 'vanilla').toLowerCase()
    const compatibleHints = new Set(instanceLoader === 'neoforge' ? ['forge', 'neoforge'] : [instanceLoader])
    const hinted = (item.loaderHints || []).some((hint) => compatibleHints.has(String(hint).toLowerCase()))
    // 旧 Forge 模组常用 FMLCorePlugin / TweakClass / ModLauncher Service 加载，
    // 没有 mods.toml；不能因为只看到 fabric.mod.json 就判成 Fabric 模组。
    item.loaderMismatch = !modLoaderMatches(inst.loader, item.loader) && !hinted
    if (item.disabled || item.loaderMismatch) continue
    for (const id of [...(item.providedModIds || []), ...Object.keys(item.providedVersions || {})]) {
      if (id) provided.add(dependencyId(id))
    }
  }
  for (const item of items) {
    const missing = []
    // 共用的解析器也为服务端转换工作，此处按客户端声明选择 side / mandatory。
    item.dependencies = (item.dependencies || []).filter(dep => dep.side !== 'SERVER')
      .map(dep => dep.clientOptional === undefined ? dep : { ...dep, optional: dep.clientOptional, required: !dep.clientOptional })
    if (!item.disabled && !item.loaderMismatch) {
      for (const dep of item.dependencies || []) {
        if (!dep || typeof dep !== 'object') continue
        const id = dependencyId(dep.id || dep.modid)
        if (!id || platform.has(id) || dep.optional === true || dep.mandatory === false) continue
        if (!provided.has(id)) missing.push(dep.id || dep.modid)
      }
    }
    if (missing.length) item.missingDependencies = missing
  }
  // 重复模组：同一 modId / 同内容 / 无元数据时同文件名归为一组。
  // 列表页只需要组标记（不算哈希，避免每次刷新都读整包），完整报告由 mods/duplicates 提供。
  const duplicateGroups = groupModDuplicates(items)
  const byRel = new Map()
  for (const group of duplicateGroups) {
    for (const member of group.items) byRel.set(member.relPath, { group, member })
  }
  return {
    dir: paths.modsDir,
    total: items.length,
    enabled: items.filter((item) => !item.disabled).length,
    disabled: items.filter((item) => item.disabled).length,
    missingDependencies: [...new Set(items.flatMap((item) => item.missingDependencies || []))],
    duplicateGroups: duplicateGroups.length,
    duplicateItems: duplicateGroups.reduce((sum, group) => sum + group.items.length - 1, 0),
    items: items.map((item) => {
      const hit = byRel.get(item.relPath)
      return {
        file: item.file,
        relPath: item.relPath,
        size: item.size,
        mtime: item.mtime,
        disabled: item.disabled,
        modid: item.modid,
        modids: item.modids || [],
        topLevelModIds: item.topLevelModIds || [],
        nestedModIds: item.nestedModIds || [],
        modIdHints: item.modIdHints || [],
        providedModIds: item.providedModIds || [],
        providedVersions: item.providedVersions || {},
        dependencies: item.dependencies || [],
        conflicts: item.conflicts || [],
        metadataSource: item.metadataSource || '',
        name: item.name,
        version: item.version,
        loader: item.loader,
        loaderHints: item.loaderHints || [],
        loaderMismatch: item.loaderMismatch === true,
        environment: item.environment,
        hasMeta: item.hasMeta,
        icon: item.icon || '',
        duplicateGroup: hit?.group.id || '',
        duplicateKeep: hit?.member.keep === true,
        duplicateOf: hit && !hit.member.keep ? hit.group.keep : '',
        missingDependencies: item.missingDependencies || []
      }
    })
  }
}

/** 完整扫描并计算重复模组报告（含同大小文件的内容哈希）。 */
export async function findDuplicateMods(inst, { signal } = {}) {
  const paths = instancePaths(inst)
  const items = await scanModsDir(paths.modsDir, {
    recursive: true,
    includeDisabled: true,
    gameDir: paths.gameDir,
    runtime: { mc: inst.mc, loader: inst.loader, loaderVersion: inst.loaderVersion },
    signal
  })
  const report = await analyzeModDuplicates(items)
  return { dir: paths.modsDir, ...report }
}

/** 按前端确认的保留/删除计划清理重复模组；mode=disable 只改名，不做不可逆删除。 */
export async function cleanDuplicateMods(inst, { mode = 'delete', groups = [] } = {}) {
  const paths = instancePaths(inst)
  return await cleanupDuplicateMods(paths.modsDir, { mode, groups })
}

export async function setModEnabled(inst, relPath, enabled) {
  const paths = instancePaths(inst)
  const file = pathIn(paths.modsDir, relPath)
  if (!fs.existsSync(file)) throw new Error('模组文件不存在')
  if (enabled) {
    if (!file.toLowerCase().endsWith('.disabled')) return { file, enabled: true }
    const target = file.slice(0, -'.disabled'.length)
    if (fs.existsSync(target)) throw new Error('目标文件已存在，无法启用：' + path.basename(target))
    await fsp.rename(file, target)
    return { file: target, enabled: true }
  }
  if (file.toLowerCase().endsWith('.disabled')) return { file, enabled: false }
  const target = file + '.disabled'
  if (fs.existsSync(target)) throw new Error('已存在同名禁用文件：' + path.basename(target))
  await fsp.rename(file, target)
  return { file: target, enabled: false }
}

export async function deleteMod(inst, relPath) {
  const paths = instancePaths(inst)
  const file = pathIn(paths.modsDir, relPath)
  if (!fs.existsSync(file)) throw new Error('文件不存在')
  await fsp.rm(file, { recursive: false, force: true })
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/* Content icons                                                       */
/* ------------------------------------------------------------------ */

/** 图标条目只接受 jar/zip 内的相对路径；远程地址和 ../ 一律丢弃。 */
function cleanIconEntry(value) {
  const text = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  if (!text || text.includes('..') || /^[a-z][a-z0-9+.-]*:/i.test(text) || !IMAGE_EXT.test(text)) return ''
  return text
}

function iconMime(entry, data = null) {
  // 很多模组把 JPEG 存成 logo.png。X-Content-Type-Options: nosniff 下
  // 按扩展名返回 image/png 会让浏览器直接拒绝显示，所以优先看文件头。
  if (Buffer.isBuffer(data)) {
    if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
    if (data.length >= 6 && data.toString('ascii', 0, 4) === 'GIF8') return 'image/gif'
    if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  }
  return ICON_MIME[extType(entry)] || 'application/octet-stream'
}

function rememberIcon(key, value) {
  if (iconCache.size >= ICON_CACHE_LIMIT) {
    let drop = Math.max(1, Math.floor(ICON_CACHE_LIMIT / 10))
    for (const old of iconCache.keys()) {
      iconCache.delete(old)
      if (--drop <= 0) break
    }
  }
  iconCache.set(key, { at: Date.now(), value })
  return value
}

/**
 * 读取实例内容的封面图。
 * - 模组：优先 metadata 里的 icon/logoFile，再尝试常见文件名；
 * - 资源包：pack.png；
 * - 光影：shaderpack.png / pack.png 等（不同光影包约定不一）。
 * 找不到返回 null，由前端回退到类型图标，不影响列表本身。
 */
export async function readContentIcon(inst, type, name, { entry = '', modid = '' } = {}) {
  const paths = instancePaths(inst)
  const dirs = {
    mods: paths.modsDir,
    resourcepacks: paths.resourcePacksDir,
    shaderpacks: paths.shaderPacksDir
  }
  const dir = dirs[type]
  if (!dir) throw new Error('不支持的内容类型')
  let target
  try { target = pathIn(dir, name) } catch { return null }
  const stat = await fsp.stat(target).catch(() => null)
  if (!stat) return null
  const safeModid = String(modid || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '')
  const preferred = cleanIconEntry(entry)
  const candidates = []
  if (preferred) candidates.push(preferred)
  if (type === 'mods') {
    if (safeModid) {
      candidates.push(`assets/${safeModid}/icon.png`, `assets/${safeModid}/logo.png`)
    }
    candidates.push('icon.png', 'logo.png', 'pack.png')
  } else if (type === 'resourcepacks') {
    candidates.push('pack.png')
  } else {
    candidates.push('shaderpack.png', 'pack.png', 'icon.png', 'logo.png', 'shaders/shaderpack.png')
  }
  const unique = [...new Set(candidates.filter(Boolean))]
  if (!unique.length) return null

  const key = `${process.platform === 'win32' ? target.toLowerCase() : target}|${stat.size}|${stat.mtimeMs}|${type}|${unique.join('|')}`
  const hit = iconCache.get(key)
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value

  if (stat.isDirectory()) {
    for (const candidate of unique) {
      try {
        const file = pathIn(target, candidate)
        const fileStat = await fsp.stat(file).catch(() => null)
        if (!fileStat?.isFile() || fileStat.size > ICON_MAX_BYTES) continue
        const data = await fsp.readFile(file)
        return rememberIcon(key, { data, mime: iconMime(candidate, data), entry: candidate })
      } catch { /* 尝试下一个候选名称 */ }
    }
    return rememberIcon(key, null)
  }

  const found = await readJarEntries(target, unique, { maxBytes: ICON_MAX_BYTES * 2, maxEntries: unique.length })
  for (const candidate of unique) {
    const data = found[candidate]
    if (data?.length) return rememberIcon(key, { data, mime: iconMime(candidate, data), entry: candidate })
  }
  return rememberIcon(key, null)
}

export async function writeUpload(inst, type, filename, req, commit = (write) => write()) {
  const paths = instancePaths(inst)
  const dirs = {
    mods: paths.modsDir,
    resourcepacks: paths.resourcePacksDir,
    shaderpacks: paths.shaderPacksDir
  }
  const dir = dirs[type]
  if (!dir) throw new Error('不支持的上传类型：' + type)
  const base = path.basename(String(filename || '')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  if (!base) throw new Error('缺少文件名')
  const ext = extType(base)
  const allowed = type === 'mods' ? ['.jar', '.zip'] : ['.zip', '.jar']
  if (!allowed.includes(ext)) throw new Error(`不能把 ${ext || '无扩展名'} 文件放入 ${type} 目录`)
  await fsp.mkdir(dir, { recursive: true })
  const staged = await receiveUpload(req, 'payload', {
    parent: dir, maxBytes: 512 * 1024 ** 2, limitMessage: '上传文件超过 512 MiB'
  })
  try {
    return await commit(async () => {
      const stem = base.slice(0, -ext.length)
      for (let index = 0; ; index++) {
        const name = index ? `${stem} (${index})${ext}` : base
        const target = path.join(dir, name)
        // 独占预留文件名，再在同一卷发布完整文件。
        let reservation
        try { reservation = await fsp.open(target, 'wx') }
        catch (error) { if (error.code === 'EEXIST') continue; throw error }
        try {
          await reservation.close()
          await fsp.rename(staged.file, target)
        } catch (error) {
          await fsp.rm(target, { force: true })
          throw error
        }
        return { file: name, dir, size: staged.size }
      }
    })
  } finally {
    await removeTempPack(staged.dir)
  }
}

/* ------------------------------------------------------------------ */
/* Resource packs / shaders                                            */
/* ------------------------------------------------------------------ */

export async function listResourcePacks(inst) {
  const paths = instancePaths(inst)
  const options = await readOptions(paths.gameDir)
  const entries = await listEntries(paths.resourcePacksDir, { exts: ['.zip', '.jar'] })
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  const ordered = []
  const enabledNames = new Set()
  for (let index = options.resourcePacks.length - 1; index >= 0; index--) {
    const value = options.resourcePacks[index]
    const name = resourcePackLocalName(value)
    const entry = byName.get(name)
    if (entry && !enabledNames.has(name)) { ordered.push(entry); enabledNames.add(name) }
  }
  const priorities = new Map([...enabledNames].map((name, index) => [name, index]))
  for (const entry of entries) if (!enabledNames.has(entry.name)) ordered.push(entry)
  return {
    dir: paths.resourcePacksDir,
    optionsFile: options.file,
    revision: resourcePackRevision(options.text),
    items: ordered.map((entry) => ({
      ...entry,
      enabled: enabledNames.has(entry.name),
      priority: priorities.get(entry.name) ?? null
    }))
  }
}

function resourcePackLocalName(value) {
  if (value === 'vanilla') return null
  return value.startsWith('file/') ? value.slice(5) : value
}

export async function setResourcePackEnabled(inst, name, enabled) {
  const paths = instancePaths(inst)
  return withResourcePackLock(paths.gameDir, async () => {
    const options = await readOptions(paths.gameDir)
    const target = String(name || '')
    if (!target || path.basename(target) !== target || /[\\/\0]/.test(target)) throw new Error('非法资源包名称')
    const existing = await listEntries(paths.resourcePacksDir, { exts: ['.zip', '.jar'] })
    if (enabled && !existing.some((entry) => entry.name === target)) throw new Error('资源包不存在')
    const variants = target === 'vanilla' ? new Set([`file/${target}`]) : new Set([target, `file/${target}`])
    const list = options.resourcePacks.filter((item) => !variants.has(item))
    if (enabled) list.push(`file/${target}`)
    options.map.set('resourcePacks', JSON.stringify(list))
    await writeResourcePackOptions(options)
    return { enabled, name: target, revision: resourcePackRevision(await fsp.readFile(options.file, 'utf8')) }
  })
}

function resourcePackRevision(text) { return createHash('sha256').update(String(text)).digest('hex') }

async function withResourcePackLock(key, action) {
  const prior = resourcePackLocks.get(key) || Promise.resolve()
  let release
  const current = new Promise((resolve) => { release = resolve })
  const queued = prior.then(() => current)
  resourcePackLocks.set(key, queued)
  await prior
  try { return await action() } finally {
    release()
    if (resourcePackLocks.get(key) === queued) resourcePackLocks.delete(key)
  }
}

async function writeResourcePackOptions(options) {
  let latest
  try { latest = await fsp.readFile(options.file, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') latest = ''; else throw error }
  if (latest !== options.text) throw new Error('options.txt 已变化，请刷新后重试')
  const lines = options.text.split(/(\r?\n)/)
  let found = false
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i]
    const idx = line.indexOf(':')
    if (idx > 0 && line.slice(0, idx) === 'resourcePacks') {
      if (found) throw new Error('options.txt 中存在重复 resourcePacks 项，已停止写入')
      lines[i] = `resourcePacks:${options.map.get('resourcePacks')}`
      found = true
    }
  }
  const newline = options.text.includes('\r\n') ? '\r\n' : '\n'
  const text = found ? lines.join('') : `${options.text}${options.text && !options.text.endsWith('\n') ? newline : ''}resourcePacks:${options.map.get('resourcePacks')}${options.text.endsWith('\r\n') ? '\r\n' : options.text.endsWith('\n') ? '\n' : ''}`
  await fsp.mkdir(path.dirname(options.file), { recursive: true })
  const temp = `${options.file}.resourcepacks-${randomUUID()}.tmp`
  try {
    await fsp.writeFile(temp, text, { encoding: 'utf8', flag: 'wx' })
    let latest
    try { latest = await fsp.readFile(options.file, 'utf8') }
    catch (error) { if (error.code === 'ENOENT') latest = ''; else throw error }
    if (latest !== options.text) throw new Error('options.txt 已变化，请刷新后重试')
    await fsp.rename(temp, options.file)
  } finally { await fsp.rm(temp, { force: true }).catch(() => {}) }
}

export async function setResourcePackOrder(inst, names, expectedRevision) {
  const paths = instancePaths(inst)
  return withResourcePackLock(paths.gameDir, async () => {
    const options = await readOptions(paths.gameDir)
    if (!expectedRevision || expectedRevision !== resourcePackRevision(options.text)) throw new Error('资源包列表已变化，请刷新后重试')
    if (!Array.isArray(names)) throw new Error('资源包排序数据无效')
    const entries = await listEntries(paths.resourcePacksDir, { exts: ['.zip', '.jar'] })
    const valid = new Set(entries.map((entry) => entry.name))
    const tokenByName = new Map()
    for (const value of options.resourcePacks) {
      const name = resourcePackLocalName(value)
      if (!valid.has(name)) continue
      if (tokenByName.has(name)) throw new Error('资源包启用项有重复或旧格式/新格式并存，请先切换一次启用状态后再排序')
      tokenByName.set(name, value)
    }
    const enabled = new Set(tokenByName.keys())
    if (new Set(names).size !== names.length || names.some((name) => typeof name !== 'string' || !enabled.has(name)) || names.length !== enabled.size) throw new Error('资源包排序与当前启用列表不一致')
    let cursor = names.length - 1
    const next = options.resourcePacks.map((value) => {
      const name = resourcePackLocalName(value)
      if (!valid.has(name)) return value
      const replacement = names[cursor--]
      return tokenByName.get(replacement)
    })
    options.map.set('resourcePacks', JSON.stringify(next))
    await writeResourcePackOptions(options)
    return { revision: resourcePackRevision(await fsp.readFile(options.file, 'utf8')), order: [...names] }
  })
}

function safePackEntry(name) {
  const normalized = String(name || '').replace(/\\/g, '/')
  return normalized && !normalized.startsWith('/') && !/^[a-zA-Z]:/.test(normalized) && !normalized.split('/').some((part) => part === '..' || part === '.') && !normalized.includes('\0')
}

async function packResourceNames(entry, baseDir) {
  const root = path.join(baseDir, entry.name)
  const rootStat = await fsp.lstat(root)
  if (rootStat.isSymbolicLink()) throw new Error(`已跳过符号链接：${entry.name}`)
  if (entry.isDir) {
    const names = []
    const metadata = path.join(root, 'pack.mcmeta')
    const metadataStat = await fsp.lstat(metadata).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
    const hasMetadata = !!metadataStat?.isFile() && !metadataStat.isSymbolicLink()
    let visited = 0
    const walk = async (dir, rel = 'assets') => {
      for (const child of await fsp.readdir(dir, { withFileTypes: true })) {
        if (++visited > 50000) throw new Error(`目录条目过多，已停止预览：${entry.name}`)
        if (child.isSymbolicLink()) continue
        const childRel = rel ? `${rel}/${child.name}` : child.name
        if (!safePackEntry(childRel)) continue
        if (child.isDirectory()) await walk(path.join(dir, child.name), childRel)
        else if (child.isFile()) names.push(childRel)
        if (names.length > 20000) throw new Error('资源包条目过多，已停止预览')
      }
    }
    const assetsRoot = path.join(root, 'assets')
    const assetsStat = await fsp.lstat(assetsRoot).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (assetsStat?.isDirectory() && !assetsStat.isSymbolicLink()) await walk(assetsRoot)
    return { names, hasMetadata }
  }
  const stats = {}
  await readJarEntries(root, [], { stats, includeDirectory: true, maxEntries: 50000 })
  if (!stats.zip || !stats.directory) throw new Error(`无法读取压缩包：${entry.name}`)
  if (stats.entries > 50000) throw new Error(`压缩包条目超过预览上限：${entry.name}`)
  const names = [...stats.directory.keys()].filter((name) => safePackEntry(name) && name.startsWith('assets/') && !name.endsWith('/'))
  return { names, hasMetadata: stats.directory.has('pack.mcmeta') }
}

export async function previewResourcePackConflicts(inst) {
  const paths = instancePaths(inst)
  const data = await listResourcePacks(inst)
  const active = data.items.filter((item) => item.enabled)
  const owners = new Map()
  const warnings = []
  let scanned = 0
  for (const item of active) {
    try {
      const pack = await packResourceNames(item, paths.resourcePacksDir)
      if (!pack.hasMetadata) { warnings.push(`缺少根目录 pack.mcmeta，跳过：${item.name}`); continue }
      const names = pack.names
      const remaining = Math.max(0, 100000 - scanned)
      const limitedNames = names.slice(0, remaining)
      scanned += limitedNames.length
      if (limitedNames.length < names.length) warnings.push('资源总数达到预览上限，后续条目未扫描')
      for (const name of limitedNames) {
        const list = owners.get(name) || []
        list.push(item.name)
        owners.set(name, list)
      }
      if (limitedNames.length < names.length) break
    } catch (error) { warnings.push(error.message) }
  }
  const conflicts = [...owners].filter(([, packs]) => packs.length > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 300)
    .map(([pathName, packs]) => ({ path: pathName, highestPrioritySource: packs[0], sources: packs }))
  const latest = await listResourcePacks(inst)
  const activeSignature = active.map(({ name, size, mtime }) => `${name}\0${size}\0${mtime}`).join('\n')
  const latestSignature = latest.items.filter((item) => item.enabled).map(({ name, size, mtime }) => `${name}\0${size}\0${mtime}`).join('\n')
  return {
    revision: data.revision,
    stale: latest.revision !== data.revision || latestSignature !== activeSignature,
    priorityRule: '按 Minecraft Java options.txt 的 resourcePacks 逆序显示；列表顶部优先级最高。此处列出静态同路径来源及其中优先级最高者；语言包合并、overlays、filters 等规则可能改变最终呈现。',
    enabled: active.length,
    scanned,
    conflictCount: [...owners.values()].filter((packs) => packs.length > 1).length,
    conflicts,
    truncated: [...owners.values()].filter((packs) => packs.length > 1).length > conflicts.length,
    warnings
  }
}

export async function listShaderPacks(inst) {
  const paths = instancePaths(inst)
  const entries = await listEntries(paths.shaderPacksDir, { exts: ['.zip', '.jar'] })
  return { dir: paths.shaderPacksDir, items: entries }
}

export async function deleteContent(inst, type, name) {
  const paths = instancePaths(inst)
  const dirs = {
    resourcepacks: paths.resourcePacksDir,
    shaderpacks: paths.shaderPacksDir,
    worlds: paths.savesDir,
    screenshots: paths.screenshotsDir
  }
  const dir = dirs[type]
  if (!dir) throw new Error('不支持的内容类型')
  const target = pathIn(dir, name)
  if (!fs.existsSync(target)) throw new Error('文件不存在')
  await fsp.rm(target, { recursive: true, force: true })
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/* Worlds / screenshots                                                */
/* ------------------------------------------------------------------ */

export async function listInstanceWorlds(inst) {
  const paths = instancePaths(inst)
  if (!fs.existsSync(paths.savesDir)) return { savesDir: paths.savesDir, worlds: [] }
  const data = await listWorlds(paths.gameDir)
  const worlds = []
  for (const world of data.worlds || []) {
    const size = await dirSize(world.path, { maxFiles: 5000 }).catch(() => ({ bytes: 0, files: 0 }))
    worlds.push({ ...world, size: size.bytes, files: size.files })
  }
  return { savesDir: paths.savesDir, worlds }
}

export async function listScreenshots(inst) {
  const paths = instancePaths(inst)
  const entries = await listEntries(paths.screenshotsDir, { exts: ['.png', '.jpg', '.jpeg', '.webp', '.gif'], dirs: false })
  return {
    dir: paths.screenshotsDir,
    items: entries.map((entry) => ({
      ...entry,
      url: `/api/launcher/instances/${encodeURIComponent(inst.id)}/file?scope=screenshots&path=${encodeURIComponent(entry.name)}`
    }))
  }
}

export function screenshotPath(inst, name) {
  const paths = instancePaths(inst)
  return pathIn(paths.screenshotsDir, name)
}

/* ------------------------------------------------------------------ */
/* servers.dat                                                         */
/* ------------------------------------------------------------------ */

function valueOf(node) {
  if (node instanceof NbtNum) return node.value
  if (typeof node === 'bigint') return Number(node)
  return node
}

function serverListFromNbt(root) {
  const raw = root?.value?.servers
  if (!Array.isArray(raw)) return []
  return raw.map((item) => ({
    name: String(valueOf(item?.name) ?? ''),
    ip: String(valueOf(item?.ip) ?? ''),
    icon: String(valueOf(item?.icon) ?? ''),
    acceptTextures: !!valueOf(item?.acceptTextures)
  })).filter((item) => item.ip)
}

export async function readServers(inst) {
  const paths = instancePaths(inst)
  const file = path.join(paths.gameDir, 'servers.dat')
  if (!fs.existsSync(file)) return { file, items: [] }
  try {
    const root = nbtParse(await fsp.readFile(file))
    return { file, items: serverListFromNbt(root) }
  } catch (e) {
    return { file, items: [], error: '读取 servers.dat 失败：' + e.message }
  }
}

async function writeServers(inst, mutate) {
  const paths = instancePaths(inst)
  const file = path.join(paths.gameDir, 'servers.dat')
  let root
  let existing = []
  if (fs.existsSync(file)) {
    try {
      root = nbtParse(await fsp.readFile(file))
      existing = serverListFromNbt(root)
    } catch { root = null }
  }
  if (!root || typeof root !== 'object') {
    root = { name: '', value: {} }
  }
  if (!root.value || typeof root.value !== 'object') root.value = {}
  const next = mutate([...existing])
  const compound = next.map((item) => ({
    name: String(item.name || item.ip || ''),
    ip: String(item.ip || ''),
    ...(item.icon ? { icon: String(item.icon) } : {}),
    acceptTextures: new NbtNum(1, item.acceptTextures === false ? 0 : 1)
  }))
  root.value.servers = compound
  // Keep a single backup of the previous file.
  if (fs.existsSync(file)) await fsp.copyFile(file, file + '.bak').catch(() => {})
  await fsp.mkdir(paths.gameDir, { recursive: true })
  await fsp.writeFile(file, nbtWrite(root))
  return { file, items: compound.map((item) => ({ ...item, acceptTextures: valueOf(item.acceptTextures) })) }
}

export async function addServer(inst, { name, ip }) {
  const address = String(ip || '').trim()
  if (!address) throw new Error('缺少服务器地址')
  return await writeServers(inst, (list) => {
    if (list.some((item) => item.ip.toLowerCase() === address.toLowerCase())) throw new Error('该服务器已在列表中')
    list.push({ name: String(name || address), ip: address, acceptTextures: true })
    return list
  })
}

export async function updateServer(inst, index, { name, ip }) {
  return await writeServers(inst, (list) => {
    const item = list[Number(index)]
    if (!item) throw new Error('服务器不存在')
    if (ip) item.ip = String(ip).trim()
    if (name !== undefined) item.name = String(name)
    return list
  })
}

export async function deleteServer(inst, index) {
  return await writeServers(inst, (list) => {
    if (!list[Number(index)]) throw new Error('服务器不存在')
    list.splice(Number(index), 1)
    return list
  })
}

/* ------------------------------------------------------------------ */
/* Logs / crashes                                                      */
/* ------------------------------------------------------------------ */

async function filesIn(dir, predicate = () => true) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
  const items = []
  for (const entry of entries) {
    if (!entry.isFile() || !predicate(entry.name)) continue
    const full = path.join(dir, entry.name)
    const stat = await fsp.stat(full).catch(() => null)
    if (!stat) continue
    items.push({ name: entry.name, path: full, size: stat.size, mtime: stat.mtimeMs })
  }
  return items.sort((a, b) => b.mtime - a.mtime)
}

export async function listLogs(inst) {
  const paths = instancePaths(inst)
  const launcherLogs = await filesIn(paths.logsDir, (name) => /\.log$/i.test(name))
  const gameLogs = []
  const gameLogDir = path.join(paths.gameDir, 'logs')
  for (const name of ['latest.log', 'debug.log']) {
    const file = path.join(gameLogDir, name)
    const stat = await fsp.stat(file).catch(() => null)
    if (stat) gameLogs.push({ name, path: file, size: stat.size, mtime: stat.mtimeMs, source: 'game' })
  }
  const crashes = (await filesIn(paths.crashDir, (name) => /^crash-.*\.txt$/i.test(name))).slice(0, 20)
  return {
    logsDir: paths.logsDir,
    gameLogDir,
    crashDir: paths.crashDir,
    items: [
      ...gameLogs,
      ...launcherLogs.map((item) => ({ ...item, source: 'launcher' }))
    ].sort((a, b) => b.mtime - a.mtime),
    crashes: crashes.map((item) => ({ name: item.name, size: item.size, mtime: item.mtime }))
  }
}

export async function readLogFile(inst, source, name) {
  const paths = instancePaths(inst)
  let file = ''
  if (source === 'game') {
    if (!['latest.log', 'debug.log'].includes(String(name))) throw new Error('不支持的日志文件')
    file = path.join(paths.gameDir, 'logs', String(name))
  } else {
    file = pathIn(paths.logsDir, name)
  }
  if (!fs.existsSync(file)) throw new Error('日志文件不存在')
  const text = await fsp.readFile(file, 'utf8')
  return {
    file,
    name: path.basename(file),
    text: text.split(/\r?\n/).slice(-4000).join('\n'),
    size: fs.statSync(file).size,
    mtime: fs.statSync(file).mtimeMs
  }
}

export async function readCrashReport(inst, name = '') {
  const paths = instancePaths(inst)
  if (!name) return await inspectCrash(inst)
  const file = pathIn(paths.crashDir, name)
  const fullText = await fsp.readFile(file, 'utf8')
  const text = fullText.slice(0, 512 * 1024)
  return {
    file,
    name: path.basename(file),
    text,
    mtime: fs.statSync(file).mtimeMs,
    hints: analyzeCrash(text, { mc: inst.mc, memory: inst.memory?.max || 0, sourceFile: file })
  }
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

export async function instanceContentSummary(inst) {
  const paths = instancePaths(inst)
  const countFiles = async (dir, exts) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    return entries.filter((entry) => entry.isFile() && (!exts || exts.includes(extType(entry.name)))).length
  }
  const countDirs = async (dir) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    return entries.filter((entry) => entry.isDirectory()).length
  }
  const [modsJar, modsDisabled, packs, shaders, worlds, shots, servers, logs, packMeta] = await Promise.all([
    countFiles(paths.modsDir, ['.jar']),
    fsp.readdir(paths.modsDir).then((list) => list.filter((name) => name.toLowerCase().endsWith('.jar.disabled')).length).catch(() => 0),
    countFiles(paths.resourcePacksDir, ['.zip', '.jar']),
    countFiles(paths.shaderPacksDir, ['.zip', '.jar']),
    countDirs(paths.savesDir),
    countFiles(paths.screenshotsDir, ['.png', '.jpg', '.jpeg', '.webp']),
    readServers(inst).then((data) => data.items.length).catch(() => 0),
    listLogs(inst),
    fsp.readFile(path.join(paths.gameDir, '.mc-toolbox-pack.json'), 'utf8').then((text) => { try { return JSON.parse(text) } catch { return null } }).catch(() => null)
  ])
  return {
    gameDir: paths.gameDir,
    mods: { total: modsJar + modsDisabled, enabled: modsJar, disabled: modsDisabled },
    resourcePacks: packs,
    shaderPacks: shaders,
    worlds,
    screenshots: shots,
    servers,
    logs: logs.items.length,
    crashes: logs.crashes.length,
    pack: packMeta,
    optionsFile: paths.optionsFile
  }
}
