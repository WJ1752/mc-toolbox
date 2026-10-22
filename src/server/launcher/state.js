// 启动器状态：全局设置、实例清单、目录布局与实例 CRUD。
//
// 实例只保存元数据；游戏文件放在 launcher root（默认 <启动器目录>/.minecraft）下，
// libraries / assets / versions 由所有实例共享，启动日志和 natives 按实例隔离。
// 实例会记录创建时的 root，切换游戏目录不会让已有实例“消失”或指向新目录。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { DATA_DIR, ROOT } from '../paths.js'
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
  // root 为空表示还没选过游戏目录：启动器会先用默认位置（exe 同级 .minecraft）跑起来，
  // 并在首次进入启动器时让用户确认。rootConfigured 记录用户是否已经确认过。
  root: '',
  rootConfigured: false,
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
  defaultGroup: '',
  // 启动器自身更新（GitHub Releases）。token 只保存在本地，用于私有仓库 / 提高 API 限额。
  update: {
    autoCheck: true,
    includePrerelease: false,
    repo: '',
    token: '',
    skippedVersion: ''
  }
}

function normalizeUpdate(value) {
  const raw = value && typeof value === 'object' ? value : {}
  const repo = String(raw.repo || '').trim()
  return {
    autoCheck: raw.autoCheck !== false,
    includePrerelease: raw.includePrerelease === true,
    repo: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : '',
    token: String(raw.token || '').trim(),
    skippedVersion: String(raw.skippedVersion || '').trim()
  }
}

function randomId() {
  return crypto.randomBytes(8).toString('hex')
}

/** 默认游戏目录：与 PCL / HMCL 一致，放在启动器旁边（dev 为项目根）。 */
export function defaultRoot() {
  return path.join(ROOT, '.minecraft')
}

/**
 * 旧版默认目录（<data>/minecraft）。升级时如果 root 还停在这里，说明用户从没主动选过，
 * 需要重新走一次「选择游戏目录」；已有实例会各自记住旧 root，不会丢。
 */
export function legacyDefaultRoot() {
  return path.join(DATA_DIR, 'minecraft')
}

function samePath(a, b) {
  return !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

function isLegacyDefaultRoot(root) {
  return samePath(root, legacyDefaultRoot())
}

/** 当前进程实际使用的启动器根目录（不读写 settings，供 getState 迁移使用）。 */
function currentRootFor(data) {
  const override = String(process.env.MC_TOOLBOX_LAUNCHER_ROOT || '').trim()
  if (override) return path.resolve(override)
  return path.resolve(data?.settings?.root || defaultRoot())
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
  out.update = normalizeUpdate(out.update)
  // 老配置没有 rootConfigured：只要 root 不是旧版默认值，就视为用户已经选过目录。
  if (value && value.rootConfigured === undefined) {
    out.rootConfigured = !!(out.root && !isLegacyDefaultRoot(out.root))
  } else {
    out.rootConfigured = out.rootConfigured === true
  }
  return out
}

export function getState() {
  const data = store.get(STORE_KEY, { version: 1, settings: { ...DEFAULT_LAUNCHER_SETTINGS }, instances: [], selectedInstance: '' })
  let dirty = false
  if (!data.settings) { data.settings = { ...DEFAULT_LAUNCHER_SETTINGS }; dirty = true }
  const merged = mergeDefaults(data.settings)
  if (JSON.stringify(merged) !== JSON.stringify(data.settings)) { data.settings = merged; dirty = true }
  if (!Array.isArray(data.instances)) { data.instances = []; dirty = true }
  // 给老实例补上创建时的 root：之后切换游戏目录时它们仍然指向原来的文件，
  // 不会被“搬”到新目录（新目录只影响之后创建的实例）。
  const legacyRoot = currentRootFor(data)
  for (const inst of data.instances) {
    if (inst && !inst.root) { inst.root = legacyRoot; dirty = true }
  }
  if (dirty) store.set(STORE_KEY, data)
  return data
}

export function saveState(data) {
  store.set(STORE_KEY, data)
  return data
}

export function getSettings() {
  return getState().settings
}

export function updateSettings(patch = {}) {
  const data = getState()
  const next = mergeDefaults({ ...data.settings, ...patch })
  if (patch.root !== undefined) {
    const root = String(patch.root || '').trim()
    if (root && !path.isAbsolute(root)) throw new Error('游戏目录必须是绝对路径')
    next.root = root ? resolveGameRoot(root) : defaultRoot()
    // 选择目录（哪怕是默认目录）都算完成首次设置。
    next.rootConfigured = true
    fs.mkdirSync(next.root, { recursive: true })
    // 与 PCL / HMCL 一致：选中文件夹后在那里准备标准的 .minecraft 结构。
    for (const dir of ['versions', 'libraries', 'assets', 'instances']) {
      fs.mkdirSync(path.join(next.root, dir), { recursive: true })
    }
  }
  data.settings = next
  saveState(data)
  return next
}

/**
 * 把用户选中的文件夹解析成真正的游戏根目录：
 *   - 本身叫 .minecraft → 直接用
 *   - 已经是游戏根（有 versions / libraries / assets）→ 直接用
 *   - 其他 → 在所选文件夹里创建/使用 .minecraft
 * 这样和 PCL / HMCL 的「选择启动器文件夹」习惯一致。
 */
export function resolveGameRoot(picked) {
  const resolved = path.resolve(String(picked || ''))
  if (path.basename(resolved).toLowerCase() === '.minecraft') return resolved
  const looksLikeRoot = ['versions', 'libraries', 'assets']
    .some((name) => fs.existsSync(path.join(resolved, name)))
  if (looksLikeRoot) return resolved
  return path.join(resolved, '.minecraft')
}

export function launcherRoot() {
  // 测试/便携场景覆盖：不写入用户配置，直接指定本次进程的游戏根目录。
  const override = String(process.env.MC_TOOLBOX_LAUNCHER_ROOT || '').trim()
  if (override) return path.resolve(override)
  return path.resolve(getSettings().root || defaultRoot())
}

/* ------------------------------------------------------------------ */
/* Instance paths                                                      */
/* ------------------------------------------------------------------ */

export function instanceDir(id) {
  const inst = findInstance(id)
  return path.join(inst?.root ? path.resolve(inst.root) : launcherRoot(), 'instances', id)
}

/**
 * Effective file-system layout for an instance.
 * Imported instances may point at an existing .minecraft (baseDir); shared
 * versions/libraries/assets are read from there, while our logs/natives stay
 * inside the instance's own launcher root.
 */
export function instancePaths(inst) {
  const root = inst?.root ? path.resolve(inst.root) : launcherRoot()
  const baseDir = inst?.baseDir ? path.resolve(inst.baseDir) : root
  const ownDir = path.join(root, 'instances', inst.id)
  const external = !!inst?.baseDir
  const gameDir = inst?.gameDir
    ? path.resolve(inst.gameDir)
    : external ? baseDir : path.join(ownDir, 'game')
  const versionId = String(inst?.versionId || inst?.mc || '')
  // jarVersion 只信任实例显式记录的值；缺失时用候选列表兜底，不再静默当成空串。
  const jarVersion = String(inst?.jarVersion || '').trim()
  const jarNames = []
  for (const value of [jarVersion, inst?.clientJarVersion, versionId, inst?.mc]) {
    const name = String(value || '').trim()
    if (name && !jarNames.includes(name)) jarNames.push(name)
  }
  const versionsDir = path.join(baseDir, 'versions')
  const nativeKey = (jarVersion || versionId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_')
  const versionDir = path.join(versionsDir, versionId)
  return {
    root,
    baseDir,
    external,
    ownDir,
    gameDir,
    versionsDir,
    librariesDir: path.join(baseDir, 'libraries'),
    assetsDir: path.join(baseDir, 'assets'),
    nativesDir: path.join(ownDir, 'natives', nativeKey),
    logsDir: path.join(ownDir, 'logs'),
    crashDir: path.join(gameDir, 'crash-reports'),
    versionId,
    versionDir,
    versionJson: path.join(versionDir, `${versionId}.json`),
    jarVersion,
    // 外部版本可能用版本文件夹名 / jarVersion / mc 中的任意一个命名客户端 JAR，
    // 启动时按顺序取第一个实际存在的文件。
    clientJarCandidates: jarNames.map((name) => path.join(versionsDir, name, `${name}.jar`)),
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
  // 外部实例只写启动器自己的目录（natives / logs），绝不在导入的 .minecraft 里
  // 创建 mods、saves、resourcepacks 等目录，避免“只读导入”实际修改外部目录。
  const dirs = p.external
    ? [p.ownDir, p.nativesDir, p.logsDir]
    : [p.gameDir, p.nativesDir, p.logsDir, p.modsDir, p.resourcePacksDir, p.shaderPacksDir, p.savesDir]
  for (const dir of dirs) {
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
    // 外部实例的 MC 版本来源（inheritsFrom / jar / assetIndex ...），由版本识别写入。
    mcSource: String(input.mcSource || ''),
    loader,
    loaderVersion: String(input.loaderVersion || ''),
    versionId: String(input.versionId || input.installedVersionId || mc),
    jarVersion: String(input.jarVersion || ''),
    baseDir: input.baseDir ? path.resolve(String(input.baseDir)) : '',
    gameDir: input.gameDir ? path.resolve(String(input.gameDir)) : '',
    external: !!input.baseDir,
    // 实例记住自己创建时的启动器根目录；切换游戏目录后仍能找回原来的文件。
    root: input.root ? path.resolve(String(input.root)) : launcherRoot(),
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
  const result = {
    ...inst,
    installed,
    paths: {
      baseDir: p.baseDir,
      gameDir: p.gameDir,
      versionDir: p.versionDir,
      versionJson: p.versionJson,
      jarVersion: p.jarVersion,
      clientJarCandidates: p.clientJarCandidates,
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
  if (!result.mcSource) delete result.mcSource
  return result
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
