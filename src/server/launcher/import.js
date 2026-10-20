// 导入已有的 .minecraft / PCL / HMCL 版本（引用原目录，不复制游戏文件）。
//
// 只读取版本 JSON 与名称，不修改原目录；启动时才写入日志（日志仍保存在
// 工具箱自己的实例目录里），游戏目录则使用原 .minecraft。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createInstance, findInstance, getState, launcherRoot } from './state.js'
import { readJsonFile } from './meta.js'

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

function libraryHints(json) {
  const text = [
    json.mainClass || '',
    json.id || '',
    ...(json.libraries || []).map((lib) => lib.name || '')
  ].join(' ').toLowerCase()
  return text
}

function inferRuntime(json) {
  const id = String(json.id || '')
  const hints = libraryHints(json)
  const mc = String(json.inheritsFrom || id)
  let loader = 'vanilla'
  let loaderVersion = ''
  if (/fabric/.test(hints)) {
    loader = 'fabric'
    loaderVersion = /fabric-loader-([^-]+)/i.exec(id)?.[1]
      || /net\.fabricmc:fabric-loader:([^:\s]+)/i.exec(hints)?.[1]
      || ''
  } else if (/quilt/.test(hints)) {
    loader = 'quilt'
    loaderVersion = /quilt-loader-([^-]+)/i.exec(id)?.[1]
      || /org\.quiltmc:quilt-loader:([^:\s]+)/i.exec(hints)?.[1]
      || ''
  } else if (/neoforge/.test(hints)) {
    loader = 'neoforge'
    loaderVersion = /neoforge-([^-\s]+)/i.exec(id)?.[1] || ''
  } else if (/forge/.test(hints)) {
    loader = 'forge'
    loaderVersion = /forge-([^-\s]+)/i.exec(id)?.[1]
      || /net\.minecraftforge:forge:([^:\s]+)/i.exec(hints)?.[1]?.split('-').slice(1).join('-')
      || ''
  }
  return { mc, loader, loaderVersion }
}

async function scanRoot(root, { importedKeys }) {
  const versionsDir = path.join(root, 'versions')
  let entries = []
  try { entries = await fsp.readdir(versionsDir, { withFileTypes: true }) } catch { return [] }
  const source = detectSource(root)
  const items = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const versionId = entry.name
    const jsonFile = path.join(versionsDir, versionId, `${versionId}.json`)
    const json = await readJsonFile(jsonFile)
    if (!json) continue
    const runtime = inferRuntime(json)
    // HMCL style version isolation: a mods/saves folder inside versions/<id>.
    const isolated = fs.existsSync(path.join(versionsDir, versionId, 'mods')) || fs.existsSync(path.join(versionsDir, versionId, 'saves'))
    const gameDir = isolated ? path.join(versionsDir, versionId) : root
    const key = `${path.resolve(root).toLowerCase()}|${versionId.toLowerCase()}`
    items.push({
      id: `${path.resolve(root)}|${versionId}`,
      root,
      versionId,
      name: json.name || versionId,
      source,
      mc: runtime.mc,
      loader: runtime.loader,
      loaderVersion: runtime.loaderVersion,
      gameDir,
      isolated,
      hasJar: fs.existsSync(path.join(versionsDir, versionId, `${versionId}.jar`)) || fs.existsSync(path.join(versionsDir, runtime.mc, `${runtime.mc}.jar`)),
      imported: importedKeys.has(key),
      lastModified: fs.statSync(jsonFile).mtimeMs,
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

export async function importExisting({ dir, versionId, name = '', group = '' }) {
  const scan = await scanExisting({ dir })
  const item = scan.items.find((entry) => entry.root === path.resolve(String(dir)) && entry.versionId === versionId)
    || scan.items.find((entry) => entry.versionId === versionId)
  if (!item) throw new Error('未找到要导入的版本')
  if (item.imported) throw new Error('该版本已经导入过了')
  const inst = createInstance({
    name: name || `${item.name}${item.source ? ' · ' + item.source : ''}`,
    group,
    mc: item.mc,
    loader: item.loader,
    loaderVersion: item.loaderVersion,
    versionId: item.versionId,
    jarVersion: item.mc,
    baseDir: item.root,
    gameDir: item.gameDir,
    installedAt: Date.now(),
    external: true
  })
  return { instance: inst, source: item.source }
}
