// 启动器状态：全局设置、实例清单、目录布局与实例 CRUD。
//
// 实例只保存元数据；游戏文件放在 launcher root（默认 data/minecraft）下，
// libraries / assets / versions 由所有实例共享，启动日志和 natives 按实例隔离。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { DATA_DIR } from '../paths.js'
import { store } from '../store.js'
import { safeName } from './launch-plan.js'

export const STORE_KEY = 'launcher'

export const LOADERS = [
  { id: 'vanilla', label: '原版', hint: 'Mojang 官方客户端' },
  { id: 'fabric', label: 'Fabric', hint: '轻量、更新快' },
  { id: 'quilt', label: 'Quilt', hint: 'Fabric 的衍生加载器' },
  { id: 'forge', label: 'Forge', hint: '经典模组加载器' },
  { id: 'neoforge', label: 'NeoForge', hint: 'Forge 的现代分支' }
]

export const DEFAULT_LAUNCHER_SETTINGS = {
  root: '',
  source: 'auto',              // auto | official | bmclapi
  concurrency: 8,              // 并发下载数
  retries: 3,
  verify: true,                // 复用文件时校验 sha1
  defaultMemory: 4096,         // 最大堆内存 MB
  defaultMinMemory: 1024,
  defaultJava: '',
  jvmArgs: '',
  gameArgs: '',
  closeOnLaunch: false,        // 启动游戏后关闭启动器（本窗口）
  showLog: true,
  msClientId: '',
  downloadAssets: true,
  defaultWidth: 1280,
  defaultHeight: 720,
  defaultGroup: ''
}

function randomId() {
  return crypto.randomBytes(8).toString('hex')
}

export function defaultRoot() {
  return path.join(DATA_DIR, 'minecraft')
}

function mergeDefaults(value) {
  const out = { ...DEFAULT_LAUNCHER_SETTINGS, ...(value || {}) }
  for (const key of ['concurrency', 'retries', 'defaultMemory', 'defaultMinMemory', 'defaultWidth', 'defaultHeight']) {
    const n = Number(out[key])
    if (Number.isFinite(n)) out[key] = n
  }
  out.concurrency = Math.max(1, Math.min(32, out.concurrency || 8))
  out.retries = Math.max(0, Math.min(10, out.retries ?? 3))
  out.verify = out.verify !== false
  out.downloadAssets = out.downloadAssets !== false
  out.source = ['auto', 'official', 'bmclapi'].includes(out.source) ? out.source : 'auto'
  return out
}

export function getState() {
  const data = store.get(STORE_KEY, { version: 1, settings: { ...DEFAULT_LAUNCHER_SETTINGS }, instances: [], selectedInstance: '' })
  let dirty = false
  if (!data.settings) { data.settings = { ...DEFAULT_LAUNCHER_SETTINGS }; dirty = true }
  const merged = mergeDefaults(data.settings)
  if (JSON.stringify(merged) !== JSON.stringify(data.settings)) { data.settings = merged; dirty = true }
  if (!Array.isArray(data.instances)) { data.instances = []; dirty = true }
  if (dirty) store.set(STORE_KEY, data)
  return data
}

export function saveState(data) {
  store.set(STORE_KEY, data)
  return data
}

export function getSettings() {
  const data = getState()
  if (!data.settings.root) {
    data.settings.root = defaultRoot()
    saveState(data)
  }
  return data.settings
}

export function updateSettings(patch = {}) {
  const data = getState()
  const next = mergeDefaults({ ...data.settings, ...patch })
  if (patch.root !== undefined) {
    const root = String(patch.root || '').trim()
    if (root && !path.isAbsolute(root)) throw new Error('游戏目录必须是绝对路径')
    next.root = root ? path.resolve(root) : defaultRoot()
    fs.mkdirSync(next.root, { recursive: true })
  }
  data.settings = next
  saveState(data)
  return next
}

export function launcherRoot() {
  return path.resolve(getSettings().root || defaultRoot())
}

/* ------------------------------------------------------------------ */
/* Instance paths                                                      */
/* ------------------------------------------------------------------ */

export function instanceDir(id) {
  return path.join(launcherRoot(), 'instances', id)
}

/**
 * Effective file-system layout for an instance.
 * Imported instances may point at an existing .minecraft (baseDir); shared
 * versions/libraries/assets are read from there, while our logs/natives stay
 * inside the launcher root.
 */
export function instancePaths(inst) {
  const root = launcherRoot()
  const baseDir = inst?.baseDir ? path.resolve(inst.baseDir) : root
  const ownDir = path.join(root, 'instances', inst.id)
  const external = !!inst?.baseDir
  const gameDir = inst?.gameDir
    ? path.resolve(inst.gameDir)
    : external ? baseDir : path.join(ownDir, 'game')
  const jarVersion = inst?.jarVersion || inst?.versionId || inst?.mc || ''
  return {
    root,
    baseDir,
    external,
    ownDir,
    gameDir,
    versionsDir: path.join(baseDir, 'versions'),
    librariesDir: path.join(baseDir, 'libraries'),
    assetsDir: path.join(baseDir, 'assets'),
    nativesDir: path.join(ownDir, 'natives', String(jarVersion).replace(/[^a-zA-Z0-9._-]/g, '_')),
    logsDir: path.join(ownDir, 'logs'),
    crashDir: path.join(gameDir, 'crash-reports'),
    versionDir: path.join(baseDir, 'versions', inst?.versionId || inst?.mc || ''),
    versionJson: path.join(baseDir, 'versions', inst?.versionId || inst?.mc || '', `${inst?.versionId || inst?.mc || ''}.json`),
    modsDir: path.join(gameDir, 'mods'),
    resourcePacksDir: path.join(gameDir, 'resourcepacks'),
    shaderPacksDir: path.join(gameDir, 'shaderpacks'),
    savesDir: path.join(gameDir, 'saves'),
    screenshotsDir: path.join(gameDir, 'screenshots'),
    optionsFile: path.join(gameDir, 'options.txt')
  }
}

export function ensureInstanceDirs(inst) {
  const p = instancePaths(inst)
  for (const dir of [p.gameDir, p.nativesDir, p.logsDir, p.modsDir, p.resourcePacksDir, p.shaderPacksDir, p.savesDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return p
}

/* ------------------------------------------------------------------ */
/* Instance records                                                    */
/* ------------------------------------------------------------------ */

function normalizeMemory(memory = {}) {
  const min = Math.max(256, Math.min(262144, Math.round(Number(memory.min ?? memory.minMemory ?? 1024) || 1024)))
  const max = Math.max(min, Math.min(262144, Math.round(Number(memory.max ?? memory.maxMemory ?? 4096) || 4096)))
  return { min, max }
}

export function normalizeInstance(input = {}) {
  const settings = getSettings()
  const loader = LOADERS.some((item) => item.id === input.loader) ? input.loader : 'vanilla'
  const mc = String(input.mc || '').trim()
  return {
    id: input.id || randomId(),
    name: String(input.name || '').trim() || (mc ? `${mc} ${loader === 'vanilla' ? '' : loader}`.trim() : '新实例'),
    group: String(input.group || '').trim(),
    mc,
    loader,
    loaderVersion: String(input.loaderVersion || ''),
    versionId: String(input.versionId || input.installedVersionId || mc),
    jarVersion: String(input.jarVersion || ''),
    baseDir: input.baseDir ? path.resolve(String(input.baseDir)) : '',
    gameDir: input.gameDir ? path.resolve(String(input.gameDir)) : '',
    external: !!input.baseDir,
    created: Number(input.created) || Date.now(),
    updated: Number(input.updated) || Date.now(),
    lastPlayed: Number(input.lastPlayed) || 0,
    playSeconds: Number(input.playSeconds) || 0,
    launches: Number(input.launches) || 0,
    memory: normalizeMemory(input.memory || {
      min: settings.defaultMinMemory,
      max: settings.defaultMemory
    }),
    javaPath: String(input.javaPath || ''),
    jvmArgs: String(input.jvmArgs ?? settings.jvmArgs ?? ''),
    gameArgs: String(input.gameArgs ?? settings.gameArgs ?? ''),
    width: Math.max(0, Math.min(7680, Number(input.width ?? settings.defaultWidth) || 0)),
    height: Math.max(0, Math.min(4320, Number(input.height ?? settings.defaultHeight) || 0)),
    fullscreen: input.fullscreen === true,
    server: String(input.server || ''),
    autoConnect: input.autoConnect === true,
    checkFiles: input.checkFiles !== false,
    installing: input.installing === true,
    notes: String(input.notes || ''),
    icon: String(input.icon || 'cube'),
    installedAt: Number(input.installedAt) || 0
  }
}

export function findInstance(id) {
  const data = getState()
  const inst = (data.instances || []).find((item) => item.id === id)
  return inst ? normalizeInstance(inst) : null
}

export function hasVersionJson(inst) {
  try {
    const p = instancePaths(inst)
    return fs.existsSync(p.versionJson)
  } catch { return false }
}

/** A local instance is only "installed" after the install job writes its marker. */
export function isInstalled(inst) {
  if (!inst) return false
  if (!hasVersionJson(inst)) return false
  if (inst.external) return true
  if (Number(inst.installedAt) > 0) return true
  try {
    const p = instancePaths(inst)
    return fs.existsSync(path.join(path.dirname(p.versionJson), '.mc-toolbox-installed'))
  } catch { return false }
}

export function publicInstance(inst) {
  const p = instancePaths(inst)
  const installed = isInstalled(inst)
  return {
    ...inst,
    installed,
    paths: {
      baseDir: p.baseDir,
      gameDir: p.gameDir,
      versionJson: p.versionJson,
      nativesDir: p.nativesDir,
      logsDir: p.logsDir,
      librariesDir: p.librariesDir,
      assetsDir: p.assetsDir,
      modsDir: p.modsDir,
      resourcePacksDir: p.resourcePacksDir,
      shaderPacksDir: p.shaderPacksDir,
      savesDir: p.savesDir,
      screenshotsDir: p.screenshotsDir
    }
  }
}

export function listInstances({ includePaths = true } = {}) {
  const data = getState()
  return (data.instances || [])
    .map((item) => normalizeInstance(item))
    .sort((a, b) => (b.lastPlayed || b.created) - (a.lastPlayed || a.created))
    .map((item) => includePaths ? publicInstance(item) : item)
}

export function createInstance(input) {
  const data = getState()
  const inst = normalizeInstance(input)
  if (!inst.mc) throw new Error('缺少 Minecraft 版本')
  data.instances = data.instances || []
  data.instances.push(inst)
  if (!data.selectedInstance) data.selectedInstance = inst.id
  saveState(data)
  ensureInstanceDirs(inst)
  return publicInstance(inst)
}

export function updateInstance(id, patch = {}) {
  const data = getState()
  const index = (data.instances || []).findIndex((item) => item.id === id)
  if (index < 0) throw new Error('实例不存在')
  const current = normalizeInstance(data.instances[index])
  const next = normalizeInstance({ ...current, ...patch, id: current.id, created: current.created })
  next.updated = Date.now()
  data.instances[index] = next
  saveState(data)
  return publicInstance(next)
}

export function deleteInstance(id) {
  const data = getState()
  const index = (data.instances || []).findIndex((item) => item.id === id)
  if (index < 0) throw new Error('实例不存在')
  const inst = normalizeInstance(data.instances[index])
  data.instances.splice(index, 1)
  if (data.selectedInstance === id) data.selectedInstance = data.instances[0]?.id || ''
  saveState(data)
  let removed = false
  if (!inst.external) {
    const dir = instancePaths(inst).ownDir
    try {
      if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); removed = true }
    } catch (e) {
      return { ok: true, removed, warning: '实例已从列表移除，但目录删除失败：' + e.message }
    }
  }
  return { ok: true, removed, external: inst.external }
}

export async function duplicateInstance(id, { name = '' } = {}) {
  const data = getState()
  const source = findInstance(id)
  if (!source) throw new Error('实例不存在')
  const copy = normalizeInstance({
    ...source,
    id: randomId(),
    name: name || `${source.name} 副本`,
    created: Date.now(),
    updated: Date.now(),
    lastPlayed: 0,
    playSeconds: 0,
    launches: 0,
    installedAt: Date.now()
  })
  const sourcePaths = instancePaths(source)
  const copyPaths = instancePaths(copy)
  if (!source.external && fs.existsSync(sourcePaths.gameDir)) {
    await fsp.mkdir(path.dirname(copyPaths.gameDir), { recursive: true })
    await fsp.cp(sourcePaths.gameDir, copyPaths.gameDir, { recursive: true, force: true })
  }
  if (source.external) {
    // External instances cannot be copied safely; share the existing base and
    // give the clone its own isolated game directory instead.
    copy.baseDir = source.baseDir
    copy.external = true
    copy.gameDir = ''
    copy.versionId = source.versionId
    copy.jarVersion = source.jarVersion
    ensureInstanceDirs(copy)
  }
  data.instances.push(copy)
  saveState(data)
  return publicInstance(copy)
}

export function setSelectedInstance(id) {
  const data = getState()
  if (id && !(data.instances || []).some((item) => item.id === id)) throw new Error('实例不存在')
  data.selectedInstance = id || ''
  saveState(data)
  return data.selectedInstance
}

export function getSelectedInstanceId() {
  return getState().selectedInstance || ''
}

export function markPlayed(id, { playSeconds = 0, countLaunch = true } = {}) {
  const data = getState()
  const inst = (data.instances || []).find((item) => item.id === id)
  if (!inst) return
  inst.lastPlayed = Date.now()
  if (countLaunch) inst.launches = (Number(inst.launches) || 0) + 1
  if (playSeconds > 0) inst.playSeconds = (Number(inst.playSeconds) || 0) + Math.round(playSeconds)
  inst.updated = Date.now()
  saveState(data)
}

export function instanceSummary() {
  const list = listInstances()
  return {
    total: list.length,
    installed: list.filter((item) => item.installed).length,
    lastPlayed: list.reduce((max, item) => Math.max(max, item.lastPlayed || 0), 0)
  }
}

/** Guarded path helper for file-related launcher APIs. */
export function safeInstanceFile(inst, relative, allowedDirs = ['game'], mode = 'file') {
  const p = instancePaths(inst)
  const roots = {
    game: p.gameDir,
    mods: p.modsDir,
    resourcepacks: p.resourcePacksDir,
    shaderpacks: p.shaderPacksDir,
    saves: p.savesDir,
    screenshots: p.screenshotsDir,
    logs: p.logsDir,
    natives: p.nativesDir
  }
  const base = roots[allowedDirs[0]] || p.gameDir
  const rel = String(relative || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rel || rel.split('/').some((part) => part === '..' || part === '')) throw new Error('非法路径')
  const target = path.resolve(base, ...rel.split('/'))
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('路径超出游戏目录')
  if (mode === 'file' && !fs.existsSync(target)) throw new Error('文件不存在')
  return target
}

export { safeName }
