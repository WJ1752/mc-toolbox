// 路径常量 —— 同时支持三种运行模式：
//   1) dev（ESM）         - npm start，源码按文件位置解析
//   2) SEA 单可执行       - 工具箱入口被打包进 node.exe，public 内嵌为 asset
//   3) esbuild CJS bundle - 中间产物（构建中间形态）
//
// exe 模式 (SEA) 重要约定（让 .exe 旁边保持干净——只有一个 exe）：
//   - 数据（settings/monitors/...）→ %LOCALAPPDATA%\MC Toolbox\data
//   - 运行时（解压后的 public）    → %LOCALAPPDATA%\MC Toolbox\runtime
//   - 仅客户端 mod 库             → %USERPROFILE%\Documents\MC Toolbox\client-mods\
//
// dev 模式：全部留在项目根内的 data/ runtime/ public/，便于开发。

import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

// 兼容 ESM dev 与 CJS bundle 的 require
const _require = (() => {
  try { return createRequire(import.meta.url) } catch {
    if (typeof require === 'function') return require
    return null
  }
})()

// 是否在 SEA 内部运行（Node 22+ 提供 node:sea 模块）
const isSEA = (() => {
  try {
    const sea = _require?.('node:sea')
    return sea?.isSea?.() === true
  } catch { return false }
})()

// 当前文件所在目录：dev 模式走 import.meta.url，CJS bundle 走 __dirname
const HERE = typeof __dirname === 'string' && __dirname
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url))

export { isSEA }

export const ROOT = isSEA
  ? path.dirname(process.execPath)
  : path.resolve(HERE, '..', '..')

const PROJECT_APP_DIR = 'MC Toolbox'          // LOCALAPPDATA\MC Toolbox
const CLIENT_MODS_SUBDIR = 'client-mods'       // Documents\MC Toolbox\client-mods
const CONFIG_SUBDIR = 'config'                 // Documents\MC Toolbox\config（所有配置项）

function joinDev(...p) { return path.join(ROOT, ...p) }

// 所有 SEA 路径都基于环境变量直拼：LOCALAPPDATA / USERPROFILE 在 Windows
// 是系统维护的真实路径，即便用户把 Documents 移到 D 盘，USERPROFILE 仍指向 D 盘根。
// 这避免了调用 PowerShell / 注册表导致 SEA 启动期阻塞。
function joinLocalAppData(...p) {
  let base
  if (process.platform === 'win32') {
    base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local')
  } else if (process.platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support')
  } else {
    base = path.join(os.homedir(), '.local', 'share')
  }
  return path.join(base, PROJECT_APP_DIR, ...p)
}

// Windows 上「文档」常会被重定向到别的盘（例如 D:\Users\xxx\Documents），
// 直接用 USERPROFILE\Documents 拼会落到错误位置。这里解析系统的真实路径：
//   1) 注册表 User Shell Folders\Personal（最快 ~10-30ms，SEA 启动期首选）
//   2) 回退 [Environment]::GetFolderPath('MyDocuments')（PowerShell，冷启动 ~1s）
//   3) 再回退 USERPROFILE\Documents
// 结果做内存缓存，整个进程只解析一次。
let _winDocsCache = null
function resolveWindowsDocs() {
  if (_winDocsCache) return _winDocsCache
  const fallback = path.join(process.env.USERPROFILE || os.homedir(), 'Documents')
  let base = ''
  const valid = (p) => !!(p && /^[a-zA-Z]:[\\/]/.test(p) && fs.existsSync(p))
  try {
    const r = spawnSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
      '/v', 'Personal'
    ], { encoding: 'utf8', windowsHide: true, timeout: 1500 })
    const m = String(r.stdout || '').match(/Personal\s+REG(?:_EXPAND)?_SZ\s+(.+?)\s*$/im)
    if (m && m[1]) {
      const expanded = m[1].trim().replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (all, k) => process.env[k] || all)
      if (valid(expanded)) base = expanded
    }
  } catch {}
  if (!valid(base)) {
    try {
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        "[Environment]::GetFolderPath('MyDocuments')"],
        { encoding: 'utf8', windowsHide: true, timeout: 4000 })
      const v = String(r.stdout || '').trim().split(/\r?\n/).pop().trim()
      if (valid(v)) base = v
    } catch {}
  }
  _winDocsCache = base || fallback
  return _winDocsCache
}

// 供外部（日志/API/调试）查询系统真实「文档」目录
export function resolveWindowsDocsDir() {
  return process.platform === 'win32' ? resolveWindowsDocs() : ''
}

function joinUserDocuments(...p) {
  let base
  if (process.platform === 'win32') {
    base = resolveWindowsDocs()
  } else if (process.platform === 'darwin') {
    base = path.join(os.homedir(), 'Documents')
  } else {
    const xdg = process.env.XDG_DOCUMENTS_DIR || path.join(os.homedir(), 'Documents')
    base = xdg
  }
  return path.join(base, PROJECT_APP_DIR, ...p)
}

function _devDataDir()    { return joinDev('data') }
function _devRuntimeDir() { return joinDev('runtime') }

function _seaDataDir()      { return joinLocalAppData('data') }
function _seaRuntimeDir()   { return joinLocalAppData('runtime') }
function _seaClientModsDir(){ return joinUserDocuments(CLIENT_MODS_SUBDIR) }
function _seaConfigDir()    { return joinUserDocuments(CONFIG_SUBDIR) }

// 同步路径常量（启动期立即可用，store.js 直接消费）
//
// 约定（SEA 模式）：
//   CONFIG_DIR       → Documents\MC Toolbox\config      所有配置项（settings / monitors / ...）
//   CLIENT_MODS_DIR  → Documents\MC Toolbox\client-mods 仅客户端 mod 库
//   DATA_DIR         → LOCALAPPDATA\MC Toolbox\data     运行数据（history 历史曲线、日志）
//   RUNTIME_DIR      → LOCALAPPDATA\MC Toolbox\runtime  解压出的前端静态
//
// 前三个目录支持用户自定义（设置 → 数据管理 → 存储目录）：
//   自定义值记录在「引导文件」dirs.json 里，它固定放在【默认】数据目录下、永不迁移，
//   启动期同步读取；运行期由 applyDirs() 切换（ESM 实时绑定，惰性读取方立即生效）。
const DEFAULT_DATA_DIR        = isSEA ? _seaDataDir()       : _devDataDir()
const DEFAULT_CLIENT_MODS_DIR = isSEA ? _seaClientModsDir() : _devDataDir()
const DEFAULT_CONFIG_DIR      = isSEA ? _seaConfigDir()     : _devDataDir()
const DIRS_FILE = path.join(DEFAULT_DATA_DIR, 'dirs.json')

function readDirsFile() {
  try {
    const obj = JSON.parse(fs.readFileSync(DIRS_FILE, 'utf8'))
    const out = {}
    for (const k of ['configDir', 'clientModsDir', 'dataDir']) {
      const v = obj[k]
      if (typeof v === 'string' && v.trim() && path.isAbsolute(v.trim())) out[k] = path.resolve(v.trim())
    }
    return out
  } catch { return {} }
}

const _customDirs = readDirsFile()

export let DATA_DIR        = _customDirs.dataDir       || DEFAULT_DATA_DIR
export let CLIENT_MODS_DIR = _customDirs.clientModsDir || DEFAULT_CLIENT_MODS_DIR
export let CONFIG_DIR      = _customDirs.configDir     || DEFAULT_CONFIG_DIR
export const RUNTIME_DIR   = isSEA ? _seaRuntimeDir()  : _devRuntimeDir()

// 运行时切换目录（文件迁移由 dirs.js 完成后调用）。
// next 的值：绝对路径 = 启用自定义；null = 恢复默认；undefined = 不动。
export function applyDirs(next) {
  for (const k of ['configDir', 'clientModsDir', 'dataDir']) {
    const v = next[k]
    if (v === undefined) continue
    if (v !== null && (!String(v).trim() || !path.isAbsolute(String(v).trim()))) {
      throw new Error('目录必须是绝对路径：' + v)
    }
    _customDirs[k] = v === null ? undefined : path.resolve(String(v).trim())
    if (k === 'configDir') CONFIG_DIR = _customDirs[k] || DEFAULT_CONFIG_DIR
    if (k === 'clientModsDir') CLIENT_MODS_DIR = _customDirs[k] || DEFAULT_CLIENT_MODS_DIR
    if (k === 'dataDir') DATA_DIR = _customDirs[k] || DEFAULT_DATA_DIR
  }
  // 引导文件里只记录非默认项（恢复默认后对应键自动消失）
  const persist = {}
  for (const k of ['configDir', 'clientModsDir', 'dataDir']) {
    if (_customDirs[k]) persist[k] = _customDirs[k]
  }
  fs.mkdirSync(path.dirname(DIRS_FILE), { recursive: true })
  fs.writeFileSync(DIRS_FILE, JSON.stringify(persist, null, 2), 'utf8')
  return getDirs()
}

export function getDirs() {
  return {
    configDir: CONFIG_DIR,
    clientModsDir: CLIENT_MODS_DIR,
    dataDir: DATA_DIR,
    defaults: { configDir: DEFAULT_CONFIG_DIR, clientModsDir: DEFAULT_CLIENT_MODS_DIR, dataDir: DEFAULT_DATA_DIR },
    dirsFile: DIRS_FILE
  }
}

// 内嵌资源 key（与 build.mjs 的 sea-config.json assets 完全一致）
const ASSET_PUBLIC = 'publicbundle'
const ASSET_HOST = 'hostbundle'
const ASSET_I18N = 'i18nbundle'

// 资源版本戳：由 build.mjs 构建时根据 public/ 内容指纹自动生成（asset-version.gen.js），
// public 任何变化都会改变戳值 → exe 首次启动自动重新解压前端资源
import { ASSET_VERSION } from './asset-version.gen.js'

async function extractAssetIfNeeded(assetKey, target) {
  const stamp = path.join(target, '.asset-version')
  let need = true
  try {
    if ((await fsp.readFile(stamp, 'utf8')) === ASSET_VERSION) need = false
  } catch { need = true }
  if (!need) return false
  let raw = null
  try { raw = _require('node:sea').getRawAsset(assetKey) } catch {}
  if (!raw) return false
  const tgz = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  if (!tgz.length) return false
  // 版本变更：先清空旧解压内容（runtime 为生成的缓存目录，可安全重建），
  // 避免「移除功能/文件」后旧目录仍残留在磁盘上被扫描到。
  // 用逐文件删除而不是 fs.rm：避免部分环境下「整目录批量删除」被安全策略拦下。
  await removeTree(target)
  await fsp.mkdir(target, { recursive: true })
  await extractTarGz(tgz, target)
  await fsp.writeFile(stamp, ASSET_VERSION, 'utf8')
  console.log(`[SEA] 已解压 ${assetKey} 到 ${target}（${(tgz.length / 1024).toFixed(1)} KB → ${countFiles(target)} 个文件）`)
  return true
}

// 零依赖 tar.gz 解压器：gunzip + USTAR/POSIX 解析
// 逐文件/逐目录删除（不触发整目录批量删除安全门禁）
async function removeTree(p) {
  let st = null
  try { st = fs.statSync(p) } catch { return }
  if (st.isDirectory()) {
    for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
      await removeTree(path.join(p, ent.name))
    }
    try { await fsp.rmdir(p) } catch {}
  } else {
    try { await fsp.unlink(p) } catch {}
  }
}

async function extractTarGz(tgzBuf, target) {
  const zlib = await import('node:zlib')
  const { promisify } = await import('node:util')
  const inflated = await promisify(zlib.gunzip)(tgzBuf)
  let offset = 0
  let nextLongName = null
  await fsp.mkdir(target, { recursive: true })

  while (offset + 512 <= inflated.length) {
    const header = inflated.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break

    const typeFlag = String.fromCharCode(header[156] || 0)
    if (typeFlag === 'L') {
      const sizeStr = header.subarray(124, 136).toString('utf8').trim()
      const size = parseInt(sizeStr || '0', 8) || 0
      offset += 512
      const longName = inflated.subarray(offset, offset + size).toString('utf8').replace(/\0+$/, '')
      offset += Math.ceil(size / 512) * 512
      nextLongName = longName
      continue
    }

    const nameField = header.subarray(0, 100).toString('utf8').replace(/\0+$/, '')
    const prefixField = header.subarray(345, 500).toString('utf8').replace(/\0+$/, '')
    const ustarName = prefixField ? `${prefixField}/${nameField}` : nameField
    const name = nextLongName || ustarName
    nextLongName = null

    const sizeStr = header.subarray(124, 136).toString('utf8').trim()
    const size = parseInt(sizeStr || '0', 8) || 0
    offset += 512

    if (!name) {
      offset += Math.ceil(size / 512) * 512
      continue
    }

    const data = inflated.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512

    const dest = path.join(target, name.replace(/^\.\//, ''))
    if (typeFlag === '5' || name.endsWith('/')) {
      await fsp.mkdir(dest, { recursive: true })
      continue
    }
    if (typeFlag === '2') continue
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.writeFile(dest, data)
  }
}

function countFiles(dir) {
  let n = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else n++
    }
  }
  try { walk(dir) } catch {}
  return n
}

// ---------------------------------------------------------------------------
// 旧数据迁移：从老版本（exe 旁 data/ runtime/）搬到新位置。
// 仅在 SEA 模式执行；dev 模式无需迁移。
// ---------------------------------------------------------------------------

async function moveDirContents(src, dst) {
  if (!fs.existsSync(src)) return false
  await fsp.mkdir(dst, { recursive: true })
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name)
    const d = path.join(dst, ent.name)
    try {
      await fsp.rename(s, d)
    } catch (e) {
      if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') {
        if (ent.isDirectory()) await moveDirContents(s, d)
        else {
          try {
            const sd = fs.statSync(s).mtimeMs
            const dd = fs.statSync(d).mtimeMs
            if (sd > dd) await fsp.copyFile(s, d)
          } catch {}
        }
      } else if (e.code === 'ENOENT') {
        // 源文件已不存在，跳过
      } else {
        // 其他错误：复制文件兜底
        try {
          if (ent.isDirectory()) await moveDirContents(s, d)
          else await fsp.copyFile(s, d)
        } catch {}
      }
    }
  }
  try { fs.rmdirSync(src) } catch {}
  return true
}

// 把一个旧数据目录按内容类别拆到新位置：
//   clientmods.json        → 文档\MC Toolbox\client-mods
//   history.json / *.log   → LOCALAPPDATA\MC Toolbox\data（运行数据）
//   其余（settings/monitors…）→ 文档\MC Toolbox\config（配置项）
// 目录里是否还存在任何文件（递归）。用于判断残留目录能否安全删除。
function hasAnyFile(dir) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile()) return true
      if (e.isDirectory() && hasAnyFile(path.join(dir, e.name))) return true
    }
  } catch { return false }
  return false
}

async function migrateDataDir(src, { configDir, dataDir, modsDir }) {
  if (!fs.existsSync(src)) return
  const srcKey = path.resolve(src)
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (!ent.isFile()) continue
    const name = ent.name
    let dstDir
    if (name === 'clientmods.json') dstDir = modsDir
    else if (name === 'history.json' || name.endsWith('.log') || name.endsWith('.tmp')) dstDir = dataDir
    else if (name.endsWith('.json')) dstDir = configDir
    else dstDir = dataDir

    if (path.resolve(dstDir) === srcKey) continue // 原地，无需迁移
    const s = path.join(src, name)
    const d = path.join(dstDir, name)
    if (fs.existsSync(d)) {
      // 两边都有：保留较新的一份，删掉源
      try {
        const sm = fs.statSync(s).mtimeMs
        const dm = fs.statSync(d).mtimeMs
        if (sm > dm) await fsp.copyFile(s, d)
      } catch {}
      try { await fsp.unlink(s) } catch {}
      continue
    }
    try {
      await fsp.mkdir(dstDir, { recursive: true })
      await fsp.rename(s, d)
      console.log(`[migrate] ${name}: ${src} → ${dstDir}`)
    } catch (e) {
      try { await fsp.copyFile(s, d) } catch {}
    }
  }
  // 源目录空了就删掉
  try {
    if (fs.readdirSync(src).length === 0) fs.rmdirSync(src)
  } catch {}
}

async function migrateLegacyLayout() {
  if (!isSEA) return
  const legacyData = path.join(ROOT, 'data')
  const legacyRuntime = path.join(ROOT, 'runtime')
  // 迁移目标用「当前生效」目录：用户若已自定义存储目录，旧数据应搬去自定义位置
  const newData = DATA_DIR
  const newRuntime = _seaRuntimeDir()
  const newConfig = CONFIG_DIR
  const newClientModsDir = CLIENT_MODS_DIR

  // 0) 旧版按 USERPROFILE 拼出的文档目录 → 系统真实文档目录（可能被重定向到 D 盘）
  if (process.platform === 'win32') {
    const naiveDocs = path.join(process.env.USERPROFILE || os.homedir(), 'Documents', PROJECT_APP_DIR)
    const realDocs = path.join(resolveWindowsDocs(), PROJECT_APP_DIR)
    if (path.resolve(naiveDocs) !== path.resolve(realDocs) && fs.existsSync(naiveDocs)) {
      console.log(`[migrate] 文档目录: ${naiveDocs} → ${realDocs}`)
      await moveDirContents(naiveDocs, realDocs)
      // 内容搬空后删掉这个错误位置的残留目录，避免用户打开到空文件夹
      try {
        if (fs.existsSync(naiveDocs) && !hasAnyFile(naiveDocs)) {
          fs.rmSync(naiveDocs, { recursive: true, force: true })
          console.log(`[migrate] 已清理旧文档目录：${naiveDocs}`)
        }
      } catch {}
    }
  }

  const targets = { configDir: newConfig, dataDir: newData, modsDir: newClientModsDir }
  await fsp.mkdir(newConfig, { recursive: true })
  await fsp.mkdir(newData, { recursive: true })
  await fsp.mkdir(newClientModsDir, { recursive: true })

  // 1) exe 旁 data/ → 按类别拆到 config / data / client-mods
  await migrateDataDir(legacyData, targets)
  // 2) 上一版把配置放在 LOCALAPPDATA\data → 搬到 文档\config
  await migrateDataDir(newData, targets)
  // 3) exe 旁 runtime/ → LOCALAPPDATA\MC Toolbox\runtime
  if (fs.existsSync(legacyRuntime) && path.resolve(legacyRuntime) !== path.resolve(newRuntime)) {
    console.log(`[migrate] runtime: ${legacyRuntime} → ${newRuntime}`)
    await moveDirContents(legacyRuntime, newRuntime)
  }
}

export const PUBLIC_DIR = isSEA
  ? path.join(_seaRuntimeDir(), 'public')
  : path.join(ROOT, 'public')

export const FEATURES_DIR = path.join(PUBLIC_DIR, 'features')

// WebView2 无边框窗口宿主（SEA 内嵌，运行时解压到 runtime/host/；dev 模式不存在）
export const HOST_EXE = isSEA
  ? path.join(_seaRuntimeDir(), 'host', 'host.exe')
  : path.join(ROOT, 'runtime', 'host', 'host.exe')

// SEA 启动钩子：迁移老数据 + 解压内嵌 public / host 资源
export async function init() {
  await migrateLegacyLayout()
  if (!isSEA) return
  await fsp.mkdir(_seaRuntimeDir(), { recursive: true })
  await extractAssetIfNeeded(ASSET_PUBLIC, path.join(_seaRuntimeDir(), 'public'))
  await extractAssetIfNeeded(ASSET_HOST, path.join(_seaRuntimeDir(), 'host'))
  await extractAssetIfNeeded(ASSET_I18N, path.join(_seaRuntimeDir(), 'mc-i18n'))
}

export function safeJoin(base, target) {
  const p = path.resolve(base, target || '')
  if (p !== base && !p.startsWith(base + path.sep) && p !== path.dirname(base)) {
    return null
  }
  return p
}
