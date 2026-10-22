// 导入已有的 .minecraft / PCL / HMCL 版本（引用原目录，不复制游戏文件）。
//
// 只读取版本 JSON 与名称，不修改原目录；启动时才写入日志（日志仍保存在
// 工具箱自己的实例目录里），游戏目录则使用原 .minecraft。
// PCL2 的自定义版本 id 常是实例名（M1182rebirth），扫描时只把它当作版本的
// 文件夹名，真实 MC 版本由 version-detect.js 按继承链/字段/本地目录推断。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createInstance, getState, launcherRoot } from './state.js'
import { inferRuntime, isMinecraftVersion, readVersionJson } from './version-detect.js'

function appData() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
}

export function defaultMinecraftDirs() {
  const roots = [path.join(appData(), '.minecraft')]
  // Microsoft Store / 官方启动器的新路径（存在才加入）。
  const storeRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'game')
  roots.push(storeRoot)
  return [...new Set(roots.filter((dir) => fs.existsSync(path.join(dir, 'versions'))))]
}

function detectSource(root) {
  if (fs.existsSync(path.join(root, 'PCL.ini'))) return 'PCL2'
  if (fs.existsSync(path.join(root, '.hmcl'))) return 'HMCL'
  if (fs.existsSync(path.join(root, 'launcher_accounts.json'))) return '官方启动器'
  return '本地 .minecraft'
}

/** 版本目录里是否真的存在可用的客户端 JAR。 */
function hasClientJar(versionsDir, versionDir, versionId, clientJarVersion) {
  const candidates = []
  if (clientJarVersion) candidates.push(path.join(versionsDir, clientJarVersion, `${clientJarVersion}.jar`))
  if (versionId) candidates.push(path.join(versionDir, `${versionId}.jar`))
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return true
    } catch {}
  }
  // 少数启动器会把 JAR 改成自定义文件名，直接看版本目录里有没有 .jar。
  try {
    return fs.readdirSync(versionDir, { withFileTypes: true })
      .some((entry) => entry.isFile() && /\.jar$/i.test(entry.name))
  } catch {
    return false
  }
}

/**
 * 扫描单个 .minecraft 根目录下的 versions/。
 * @param {string} root .minecraft 根目录
 * @param {{importedKeys?: Set<string>}} options 已导入版本 key 集合
 */
export async function scanRoot(root, { importedKeys = new Set() } = {}) {
  const rawRoot = String(root ?? '').trim()
  if (!rawRoot) return []
  const rootPath = path.resolve(rawRoot)
  const versionsDir = path.join(rootPath, 'versions')
  let entries = []
  try {
    entries = await fsp.readdir(versionsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const source = detectSource(rootPath)
  const items = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const versionId = entry.name
    const versionDir = path.join(versionsDir, versionId)
    const versionJson = path.join(versionDir, `${versionId}.json`)
    const json = await readVersionJson(versionsDir, versionId)
    if (!json) continue
    const runtime = await inferRuntime(json, { versionsDir, versionId })
    // HMCL / PCL 的版本隔离：versions/<id> 下出现 mods / saves。
    const isolated = fs.existsSync(path.join(versionDir, 'mods'))
      || fs.existsSync(path.join(versionDir, 'saves'))
    const gameDir = isolated ? versionDir : rootPath
    const key = `${rootPath.toLowerCase()}|${versionId.toLowerCase()}`
    let lastModified = 0
    try {
      lastModified = fs.statSync(versionJson).mtimeMs
    } catch {}
    items.push({
      id: `${rootPath}|${versionId}`,
      root: rootPath,
      versionId,
      name: json.name || versionId,
      source,
      mc: runtime.mc,
      mcSource: runtime.mcSource,
      needsMc: runtime.needsMc,
      loader: runtime.loader,
      loaderVersion: runtime.loaderVersion,
      clientJarVersion: runtime.clientJarVersion,
      versionJson,
      gameDir,
      isolated,
      hasJar: hasClientJar(versionsDir, versionDir, versionId, runtime.clientJarVersion),
      imported: importedKeys.has(key),
      lastModified,
      mainClass: json.mainClass || ''
    })
  }
  return items
}

/** Scan the default locations plus an optional user-picked directory. */
export async function scanExisting({ dir = '' } = {}) {
  const roots = new Set(defaultMinecraftDirs())
  if (dir) {
    const clean = path.resolve(String(dir).trim())
    if (fs.existsSync(path.join(clean, 'versions'))) roots.add(clean)
    else if (fs.existsSync(path.join(clean, '.minecraft', 'versions'))) roots.add(path.join(clean, '.minecraft'))
  }
  const state = getState()
  const importedKeys = new Set()
  for (const inst of state.instances || []) {
    if (inst.baseDir && inst.versionId) importedKeys.add(`${path.resolve(inst.baseDir).toLowerCase()}|${String(inst.versionId).toLowerCase()}`)
  }
  const items = []
  const rootInfo = []
  for (const root of roots) {
    const list = await scanRoot(root, { importedKeys })
    rootInfo.push({ dir: root, source: detectSource(root), versions: list.length })
    items.push(...list)
  }
  items.sort((a, b) => b.lastModified - a.lastModified)
  return { roots: rootInfo, items, defaultDirs: defaultMinecraftDirs(), launcherRoot: launcherRoot() }
}

function importError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * 把扫描项整理成 createInstance 的输入（纯函数，便于测试，不写状态）。
 * 自动识别失败且用户没有指定时必须报错，绝不用版本文件夹名冒充 MC 版本。
 */
export function buildImportedInstance(item, { name = '', group = '', mc = '' } = {}) {
  const requestedMc = String(mc ?? '').trim()
  if (requestedMc && !isMinecraftVersion(requestedMc)) {
    throw importError(`MC 版本格式不正确：${requestedMc}（示例：1.21.8）`, 'INVALID_MC_VERSION')
  }
  const detectedMc = item?.mc || ''
  const finalMc = requestedMc || detectedMc
  if (!finalMc) {
    throw importError('无法自动识别该版本的 Minecraft 版本，请手动指定，例如 1.21.8', 'MC_VERSION_REQUIRED')
  }
  const mcSource = requestedMc ? 'manual' : (item.mcSource || 'unknown')
  return {
    name: name || `${item.name}${item.source ? ' · ' + item.source : ''}`,
    group,
    mc: finalMc,
    mcSource,
    loader: item.loader,
    loaderVersion: item.loaderVersion,
    versionId: item.versionId,
    jarVersion: item.clientJarVersion || finalMc,
    baseDir: item.root,
    gameDir: item.gameDir,
    installedAt: Date.now(),
    external: true
  }
}

/**
 * 导入一个已存在的版本。自动识别不到真实 MC 版本时必须让用户手动指定，
 * 绝不拿版本文件夹名（尤其是 PCL2 的实例名）冒充 MC 版本。
 * @param {{dir?: string, versionId?: string, name?: string, group?: string, mc?: string, create?: Function}} options
 */
export async function importExisting({ dir = '', versionId = '', name = '', group = '', mc = '', create = createInstance } = {}) {
  const requestedMc = String(mc ?? '').trim()
  if (requestedMc && !isMinecraftVersion(requestedMc)) {
    throw importError(`MC 版本格式不正确：${requestedMc}（示例：1.21.8）`, 'INVALID_MC_VERSION')
  }

  const scan = await scanExisting({ dir })
  const wantedRoots = new Set()
  if (dir) {
    const clean = path.resolve(String(dir).trim())
    wantedRoots.add(clean)
    // 允许直接传 .minecraft 的上级目录。
    if (fs.existsSync(path.join(clean, '.minecraft', 'versions'))) wantedRoots.add(path.join(clean, '.minecraft'))
  }
  const item = (wantedRoots.size
    ? scan.items.find((entry) => wantedRoots.has(path.resolve(entry.root)) && entry.versionId === versionId)
    : null)
    || scan.items.find((entry) => entry.versionId === versionId)
  if (!item) throw new Error('未找到要导入的版本')
  if (item.imported) throw new Error('该版本已经导入过了')

  const payload = buildImportedInstance(item, { name, group, mc: requestedMc })
  const inst = create(payload)
  return { instance: inst, source: item.source, mcSource: payload.mcSource }
}
