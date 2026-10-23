// 实例内容：模组、资源包、光影、世界、截图、服务器列表、日志与崩溃报告。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { instancePaths, findInstance } from './state.js'
import { scanModsDir } from '../mods.js'
import { listWorlds } from '../saveeditor.js'
import { inspectCrash } from './launch.js'
import { parse as nbtParse, write as nbtWrite, NbtNum } from '../nbt.js'
import { dirSize } from './download.js'

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i

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
  const text = await fsp.readFile(file, 'utf8').catch(() => '')
  const map = readOptionLines(text)
  return {
    file,
    text,
    map,
    resourcePacks: parseJsonArray(map.get('resourcePacks')),
    incompatiblePacks: parseJsonArray(map.get('incompatibleResourcePacks'))
  }
}

function serializeOptions(original, map) {
  const lines = String(original || '').split(/\r?\n/).filter((line, index, arr) => !(index === arr.length - 1 && line === ''))
  const seen = new Set()
  const out = lines.map((line) => {
    const idx = line.indexOf(':')
    if (idx <= 0) return line
    const key = line.slice(0, idx)
    if (map.has(key)) {
      seen.add(key)
      return `${key}:${map.get(key)}`
    }
    return line
  })
  for (const [key, value] of map) if (!seen.has(key)) out.push(`${key}:${value}`)
  return out.join('\n') + '\n'
}

/* ------------------------------------------------------------------ */
/* Mods                                                                */
/* ------------------------------------------------------------------ */

function dependencyId(value) {
  // Forge/Fabric 的 ID 大小写不敏感；yumi-commons-core 与 yumi_commons_core
  // 是同一个模组，不能因为分隔符不同就报「缺少前置」。
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
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
  await fsp.mkdir(paths.modsDir, { recursive: true })
  const items = await scanModsDir(paths.modsDir, {
    recursive: true,
    includeDisabled: true,
    runtime: { mc: inst.mc, loader: inst.loader, loaderVersion: inst.loaderVersion },
    signal
  })
  const provided = new Set()
  for (const item of items) {
    const ids = item.providedModIds || [item.modid, ...(item.modids || []), ...(item.nestedModIds || [])]
    for (const id of ids) if (id) provided.add(dependencyId(id))
    for (const id of Object.keys(item.providedVersions || {})) provided.add(dependencyId(id))
  }
  const seen = new Map()
  const platform = new Set(['minecraft', 'forge', 'neoforge', 'fabricloader', 'fabric', 'quilt_loader', 'quilt', 'java']
    .map((id) => dependencyId(id)))
  for (const item of items) {
    const key = String(item.modid || item.modids?.[0] || item.relPath).toLowerCase()
    if (seen.has(key)) item.duplicateOf = seen.get(key)
    else seen.set(key, item.relPath)
    const instanceLoader = String(inst.loader || 'vanilla').toLowerCase()
    const compatibleHints = new Set(instanceLoader === 'neoforge' ? ['forge', 'neoforge'] : [instanceLoader])
    const hinted = (item.loaderHints || []).some((hint) => compatibleHints.has(String(hint).toLowerCase()))
    // 旧 Forge 模组常用 FMLCorePlugin / TweakClass / ModLauncher Service 加载，
    // 没有 mods.toml；不能因为只看到 fabric.mod.json 就判成 Fabric 模组。
    item.loaderMismatch = !modLoaderMatches(inst.loader, item.loader) && !hinted
    const missing = []
    if (!item.loaderMismatch) {
      for (const dep of item.dependencies || []) {
        if (!dep || typeof dep !== 'object') continue
        const id = dependencyId(dep.id || dep.modid)
        if (!id || platform.has(id) || dep.optional === true || dep.mandatory === false) continue
        if (!provided.has(id)) missing.push(dep.id || dep.modid)
      }
    }
    if (missing.length) item.missingDependencies = missing
  }
  return {
    dir: paths.modsDir,
    total: items.length,
    enabled: items.filter((item) => !item.disabled).length,
    disabled: items.filter((item) => item.disabled).length,
    missingDependencies: [...new Set(items.flatMap((item) => item.missingDependencies || []))],
    items: items.map((item) => ({
      file: item.file,
      relPath: item.relPath,
      size: item.size,
      mtime: item.mtime,
      disabled: item.disabled,
      modid: item.modid,
      modids: item.modids || [],
      nestedModIds: item.nestedModIds || [],
      modIdHints: item.modIdHints || [],
      providedModIds: item.providedModIds || [],
      name: item.name,
      version: item.version,
      loader: item.loader,
      loaderHints: item.loaderHints || [],
      loaderMismatch: item.loaderMismatch === true,
      environment: item.environment,
      hasMeta: item.hasMeta,
      duplicateOf: item.duplicateOf || '',
      missingDependencies: item.missingDependencies || []
    }))
  }
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

export async function writeUpload(inst, type, filename, buffer) {
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
  const stem = path.basename(base, ext)
  let target = path.join(dir, base)
  let index = 1
  while (fs.existsSync(target)) target = path.join(dir, `${stem} (${index++})${ext}`)
  await fsp.writeFile(target, buffer)
  return { file: path.basename(target), dir, size: buffer.length }
}

/* ------------------------------------------------------------------ */
/* Resource packs / shaders                                            */
/* ------------------------------------------------------------------ */

export async function listResourcePacks(inst) {
  const paths = instancePaths(inst)
  const options = await readOptions(paths.gameDir)
  const entries = await listEntries(paths.resourcePacksDir, { exts: ['.zip', '.jar'] })
  const enabledSet = new Set(options.resourcePacks)
  return {
    dir: paths.resourcePacksDir,
    optionsFile: options.file,
    items: entries.map((entry) => ({
      ...entry,
      enabled: enabledSet.has(entry.name) || enabledSet.has(`file/${entry.name}`)
    }))
  }
}

export async function setResourcePackEnabled(inst, name, enabled) {
  const paths = instancePaths(inst)
  const options = await readOptions(paths.gameDir)
  const target = path.basename(String(name || ''))
  if (!target) throw new Error('缺少资源包名称')
  const variants = new Set([target, `file/${target}`])
  let list = options.resourcePacks.filter((item) => !variants.has(item))
  if (enabled) list.push(`file/${target}`)
  options.map.set('resourcePacks', JSON.stringify(list))
  const text = serializeOptions(options.text, options.map)
  await fsp.mkdir(paths.gameDir, { recursive: true })
  await fsp.writeFile(options.file, text, 'utf8')
  return { enabled, name: target }
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
  const text = await fsp.readFile(file, 'utf8')
  return { file, name: path.basename(file), text: text.slice(0, 512 * 1024), mtime: fs.statSync(file).mtimeMs }
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
