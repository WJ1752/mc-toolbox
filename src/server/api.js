import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { PUBLIC_DIR, FEATURES_DIR, DATA_DIR, CONFIG_DIR, CLIENT_MODS_DIR, ROOT, safeJoin } from './paths.js'
import { store } from './store.js'
import { DEFAULT_SETTINGS, DEFAULT_CLIENT_MODS } from './defaults.js'
import { scanFeatures, removeFeature } from './features.js'
import { pingServer } from './mc-ping.js'
import * as monitor from './monitor.js'
import { scanModsDir, listDir, moveModsToBackup, deleteMods, disableMods, enableMods, defaultBackupDir, guessModsDirs } from './mods.js'
import * as community from './community.js'
import * as servercore from './servercore.js'
import { setProxy } from './http.js'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' })
  res.end(body)
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base }
  if (!patch || typeof patch !== 'object') return out
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 20 * 1024 * 1024) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

const routes = []
const on = (method, pattern, handler) => routes.push({ method, pattern, handler })

// 客户端心跳状态 —— server.js 用它判断「应用窗口是否还开着」。
// 为什么不用 Edge 子进程的 exit 事件：Edge/Chrome 多进程架构下，spawn 出来的
// msedge.exe 会把 URL 转交给已存在的主进程后立即自行退出（exit 0），
// 此时窗口其实还开着，若据此关服务就会「窗口在、后端死」，页面全部 failed to fetch。
export const clientHeartbeat = { last: 0, shutdown: false }

on('POST', '/api/heartbeat', async () => {
  clientHeartbeat.last = Date.now()
  return { ok: true }
})

// 前端 beforeunload 用 sendBeacon 调用（Content-Type 是 text/plain，readBody 会兜底为 {}）
on('POST', '/api/shutdown', async () => {
  clientHeartbeat.shutdown = true
  return { ok: true }
})

function match(pattern, url) {
  const p = pattern.split('/').filter(Boolean)
  const u = url.split('/').filter(Boolean)
  if (p.length !== u.length) return null
  const params = {}
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(u[i])
    else if (p[i] !== u[i]) return null
  }
  return params
}

// ---------------- 启动信息 ----------------
on('GET', '/api/bootstrap', async () => {
  const settings = deepMerge(DEFAULT_SETTINGS, store.get('settings', DEFAULT_SETTINGS))
  const features = await scanFeatures()
  return { settings, features }
})

// ---------------- 设置 ----------------
on('GET', '/api/settings', async () => deepMerge(DEFAULT_SETTINGS, store.get('settings', DEFAULT_SETTINGS)))
on('PUT', '/api/settings', async (req) => {
  const body = await readBody(req)
  const current = deepMerge(DEFAULT_SETTINGS, store.get('settings', DEFAULT_SETTINGS))
  const next = deepMerge(current, body)
  next.version = DEFAULT_SETTINGS.version
  await store.set('settings', next)
  return next
})
on('POST', '/api/settings/reset', async () => {
  await store.set('settings', JSON.parse(JSON.stringify(DEFAULT_SETTINGS)))
  return store.get('settings')
})

// ---------------- 功能（磁贴） ----------------
on('GET', '/api/features', async () => ({ items: await scanFeatures() }))
on('POST', '/api/features/reload', async () => ({ items: await scanFeatures() }))
on('PUT', '/api/features/:id', async (req, params) => {
  const body = await readBody(req)
  const s = deepMerge(DEFAULT_SETTINGS, store.get('settings', DEFAULT_SETTINGS))
  s.features = s.features || {}
  s.features[params.id] = { ...(s.features[params.id] || {}), ...body }
  await store.set('settings', s)
  return { items: await scanFeatures() }
})
on('DELETE', '/api/features/:id', async (_req, params) => {
  const res = await removeFeature(params.id)
  return res.ok ? { items: await scanFeatures() } : res
})

// ---------------- 服务器探测 ----------------
on('POST', '/api/ping', async (req) => {
  const body = await readBody(req)
  const s = deepMerge(DEFAULT_SETTINGS, store.get('settings', DEFAULT_SETTINGS))
  if (!body.host) return { ok: false, error: '缺少主机地址' }
  const r = await pingServer({ ...body, settings: s.network })
  return r
})

// ---------------- 延迟监测 ----------------
on('GET', '/api/monitors', async () => monitor.snapshot())
on('POST', '/api/monitors', async (req) => {
  const body = await readBody(req)
  if (!body.host) return { error: '缺少主机地址' }
  return monitor.addMonitor(body)
})
on('POST', '/api/monitors/reorder', async (req) => {
  const body = await readBody(req)
  return { items: monitor.reorderMonitors(body.ids) }
})
// 一键把全部监测项的主显示指标统一为 latency | players | loss
on('POST', '/api/monitors/metric', async (req) => {
  const body = await readBody(req)
  if (!['latency', 'players', 'loss'].includes(body.metric)) return { error: '无效的指标：' + body.metric }
  return { ok: true, updated: monitor.setAllMetric(body.metric) }
})
on('PUT', '/api/monitors/:id', async (req, params) => {
  const body = await readBody(req)
  return monitor.updateMonitor(params.id, body)
})
on('DELETE', '/api/monitors/:id', async (_req, params) => ({ ok: monitor.removeMonitor(params.id) }))
on('POST', '/api/monitors/:id/check', async (_req, params) => ({ item: await monitor.checkNow(params.id) }))
on('POST', '/api/monitors/engine', async (req) => {
  const body = await readBody(req)
  return { running: monitor.setRunning(body.running !== false) }
})
on('DELETE', '/api/monitors/history', async (req, params, query) => {
  return { ok: monitor.clearHistory(query.id) }
})

// ---------------- 客户端转服务端 ----------------
on('GET', '/api/mods/client-list', async () => {
  const db = store.get('clientmods', { items: DEFAULT_CLIENT_MODS })
  return { items: db.items }
})
on('POST', '/api/mods/client-list', async (req) => {
  const body = await readBody(req)
  if (!body.modid) return { error: '缺少 modid' }
  const db = store.get('clientmods', { items: DEFAULT_CLIENT_MODS })
  const exists = db.items.find((x) => x.modid.toLowerCase() === String(body.modid).toLowerCase())
  if (exists) return { error: '该 modid 已存在', item: exists }
  const item = {
    id: 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    modid: String(body.modid).trim(),
    name: body.name || body.modid,
    note: body.note || '',
    source: 'user',
    createdAt: Date.now()
  }
  db.items.push(item)
  await store.set('clientmods', db)
  return { item, items: db.items }
})
on('PUT', '/api/mods/client-list/:id', async (req, params) => {
  const body = await readBody(req)
  const db = store.get('clientmods', { items: DEFAULT_CLIENT_MODS })
  const it = db.items.find((x) => x.id === params.id)
  if (!it) return { error: '记录不存在' }
  for (const k of ['modid', 'name', 'note']) if (body[k] !== undefined) it[k] = body[k]
  await store.set('clientmods', db)
  return { items: db.items }
})
on('DELETE', '/api/mods/client-list/:id', async (_req, params) => {
  const db = store.get('clientmods', { items: DEFAULT_CLIENT_MODS })
  db.items = db.items.filter((x) => x.id !== params.id)
  await store.set('clientmods', db)
  return { items: db.items }
})
on('POST', '/api/mods/scan', async (req) => {
  const body = await readBody(req)
  const s = deepMerge(DEFAULT_SETTINGS, store.get('settings', DEFAULT_SETTINGS))
  const dir = body.dir || s.client2server.modsDir
  if (!dir) return { error: '未指定 mods 目录' }
  const items = await scanModsDir(dir, {
    recursive: s.client2server.scanSubdir,
    includeDisabled: s.client2server.includeDisabled
  })
  return { dir, items }
})
on('POST', '/api/mods/apply', async (req) => {
  const body = await readBody(req)
  const s = deepMerge(DEFAULT_SETTINGS, store.get('settings', DEFAULT_SETTINGS))
  const files = Array.isArray(body.files) ? body.files : []
  if (!files.length) return { error: '没有选中任何文件' }
  if (body.mode === 'delete') {
    const r = await deleteMods(files)
    return { mode: 'delete', ...r }
  }
  if (body.mode === 'disable') {
    const r = await disableMods(files)
    return { mode: 'disable', ...r }
  }
  if (body.mode === 'enable') {
    const r = await enableMods(files)
    return { mode: 'enable', ...r }
  }
  const backupDir = body.backupDir || s.client2server.backupDir || defaultBackupDir(body.dir || s.client2server.modsDir)
  const r = await moveModsToBackup(files, backupDir)
  return { mode: 'backup', backupDir, ...r }
})

// ---------------- 社区资源（Modrinth / CurseForge） ----------------
const cfKey = () => (deepMerge(DEFAULT_SETTINGS, store.get('settings', DEFAULT_SETTINGS)).community || {}).cfApiKey || ''

on('GET', '/api/community/search', async (_req, _p, q) => {
  const s = deepMerge(DEFAULT_SETTINGS, store.get('settings', DEFAULT_SETTINGS))
  const args = {
    query: q.query || '',
    type: q.type || '',
    gameVersion: q.gameVersion || s.community.defaultGameVersion || '',
    loader: q.loader || s.community.defaultLoader || '',
    limit: Number(q.limit) || s.community.pageSize || 20,
    offset: Number(q.offset) || 0,
    sort: q.sort || 'relevance'
  }
  return q.source === 'curseforge'
    ? community.curseforgeSearch({ ...args, key: cfKey() })
    : community.modrinthSearch(args)
})

on('GET', '/api/community/project', async (_req, _p, q) => {
  if (!q.id) return { error: '缺少项目 ID' }
  return q.source === 'curseforge' ? community.curseforgeProject(q.id, cfKey()) : community.modrinthProject(q.id)
})

on('GET', '/api/community/versions', async (_req, _p, q) => {
  if (!q.id) return { error: '缺少项目 ID' }
  const opt = { gameVersion: q.gameVersion || '', loader: q.loader || '' }
  return q.source === 'curseforge'
    ? community.curseforgeVersions(q.id, { ...opt, key: cfKey() })
    : community.modrinthVersions(q.id, opt)
})

on('POST', '/api/community/download', async (req) => {
  const body = await readBody(req)
  const s = deepMerge(DEFAULT_SETTINGS, store.get('settings', DEFAULT_SETTINGS))
  community.configure(s.community)
  return community.startDownload({
    url: body.url,
    filename: body.filename,
    dir: body.dir,
    title: body.title,
    meta: body.meta || {}
  })
})

on('POST', '/api/community/preview-name', async (req) => {
  const body = await readBody(req)
  return { filename: community.applyNameRule(body.rule, { ...(body.meta || {}), filename: body.filename || 'download.jar' }) }
})

on('GET', '/api/community/jobs', async () => {
  const s = deepMerge(DEFAULT_SETTINGS, store.get('settings', DEFAULT_SETTINGS))
  community.configure(s.community)
  return {
    items: community.listJobs(),
    maxConcurrent: s.community.maxConcurrent,
    speedLimit: s.community.speedLimit,
    threads: s.community.threads
  }
})
on('POST', '/api/community/jobs/cancel', async (req) => {
  const body = await readBody(req)
  return { ok: community.cancelJob(body.id) }
})
on('DELETE', '/api/community/jobs', async (_req, _p, q) => {
  const scope = String((q && q.scope) || '')
  return { ok: community.clearJobs(scope || undefined) }
})

// ---------------- 服务端核心下载 ----------------
on('GET', '/api/servercore/loaders', async () => ({ items: servercore.LOADERS }))

on('GET', '/api/servercore/gameversions', async () => {
  try {
    return { items: await servercore.listGameVersions() }
  } catch (e) {
    return { error: '获取版本列表失败：' + e.message, items: [] }
  }
})

on('GET', '/api/servercore/loaderversions', async (_req, _p, q) => {
  try {
    return { items: await servercore.listLoaderVersions(q.loader, q.mc) }
  } catch (e) {
    return { error: e.message, items: [] }
  }
})

on('POST', '/api/servercore/download', async (req) => {
  const body = await readBody(req)
  const s = deepMerge(DEFAULT_SETTINGS, store.get('settings', DEFAULT_SETTINGS))
  const info = await servercore.resolveDownload(body)
  community.configure(s.community)
  const startScript = info.launchJar ? { jar: info.launchJar, mem: s.servercore?.memory || '2G' } : null
  const job = await community.startDownload({
    url: info.url,
    filename: info.filename,
    dir: body.dir || s.community.downloadDir,
    title: `${body.loader} ${body.mc}`,
    postCommand: info.postCommand,
    startScript,
    extraFiles: info.extraFiles,
    preserveName: true,
    meta: {
      project: body.loader,
      version: body.loaderVersion || body.mc,
      loader: body.loader,
      gameversion: body.mc,
      type: 'servercore',
      source: 'servercore'
    }
  })
  return { ...job, note: info.note }
})

// ---------------- 文件系统 ----------------
on('POST', '/api/fs/open', async (req) => {
  const body = await readBody(req)
  const target = body.path
  if (!target || !fs.existsSync(target)) return { error: '路径不存在' }
  // 是文件就选中它，目录则直接打开；统一走 openInFileManager（含置前与回退）
  const isFile = fs.statSync(target).isFile()
  const r = await openInFileManager(isFile ? path.dirname(target) : target, { selectFile: isFile ? target : '' })
  return r.ok ? { ok: true } : { error: r.error }
})
on('GET', '/api/fs/list', async (_req, _params, query) => {
  try {
    const exts = String(query.exts || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
    const data = await listDir(query.path, exts.length ? exts : null)
    return { ...data, presets: guessModsDirs() }
  } catch (e) {
    return { error: e.message }
  }
})

// 运行一个启动脚本（.bat/.cmd/.sh），用于「绑定启动脚本」功能：
// 在新控制台窗口里运行，不依赖本工具箱的存活；只做「已拉起」确认。
on('POST', '/api/scripts/run', async (req) => {
  const { spawn } = await import('node:child_process')
  const body = await readBody(req)
  const target = String(body.path || '').trim()
  if (!target) return { error: '缺少脚本路径' }
  if (!fs.existsSync(target)) return { error: '脚本不存在：' + target }
  if (!fs.statSync(target).isFile()) return { error: '不是文件：' + target }
  const lower = target.toLowerCase()
  const isBat = /\.(bat|cmd)$/.test(lower)
  const isSh = /\.sh$/.test(lower)
  if (!isBat && !isSh) return { error: '仅支持 .bat / .cmd / .sh 脚本' }
  const dir = path.dirname(target)
  try {
    if (process.platform === 'win32') {
      if (isBat) {
        // Start-Process：ShellExecute 方式，脚本在自己独立控制台窗口运行、与本进程解耦
        const esc = (s) => String(s).replace(/'/g, "''")
        const ps = `Start-Process -FilePath '${esc(target)}' -WorkingDirectory '${esc(dir)}'`
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
          windowsHide: true,
          stdio: 'ignore'
        })
        child.unref()
        return { ok: true, method: 'Start-Process', pid: child.pid }
      }
      // .sh：找 Git Bash / WSL bash
      const candidates = [
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : '',
        process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe') : '',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe')
      ].filter(Boolean)
      let bash = candidates.find((p) => fs.existsSync(p))
      if (!bash) return { error: '未找到 Git Bash，无法运行 .sh 脚本' }
      const child = spawn(bash, [target], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: false })
      child.unref()
      return { ok: true, method: 'bash', pid: child.pid }
    }
    const child = spawn('sh', [target], { cwd: dir, detached: true, stdio: 'ignore' })
    child.unref()
    return { ok: true, method: 'sh', pid: child.pid }
  } catch (e) {
    return { error: '启动失败：' + e.message }
  }
})
// Windows 下解析桌面/下载/文档的「真实」路径（注册表 Known Folder，可能被重定向到非 C 盘），带缓存
let winSpecialCache = null
async function getWinSpecialDirs() {
  if (winSpecialCache) return winSpecialCache
  if (process.platform !== 'win32') return {}
  const { execFile } = await import('node:child_process')
  const ps = [
    "$desktop=[Environment]::GetFolderPath('Desktop')",
    "$docs=[Environment]::GetFolderPath('MyDocuments')",
    "$dl=(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders' -Name '{374DE290-123F-4565-9164-39C4925E467B}' -ErrorAction SilentlyContinue).'{374DE290-123F-4565-9164-39C4925E467B}'",
    "[ordered]@{Desktop=$desktop;Downloads=$dl;Documents=$docs}|ConvertTo-Json -Compress"
  ].join(';')
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 8000 }, (err, out) => (err ? reject(err) : resolve(out)))
    })
    const obj = JSON.parse(String(stdout).trim())
    const expand = (p) => String(p || '').replace(/%([^%]+)%/g, (_, n) => process.env[n] || '')
    winSpecialCache = { Desktop: expand(obj.Desktop), Downloads: expand(obj.Downloads), Documents: expand(obj.Documents) }
  } catch {
    winSpecialCache = {}
  }
  return winSpecialCache
}

on('GET', '/api/fs/roots', async () => {
  const roots = []
  if (process.platform === 'win32') {
    // 扫描 A:–Z: 盘符
    for (let c = 65; c <= 90; c++) {
      const letter = String.fromCharCode(c)
      const p = letter + ':\\'
      if (fs.existsSync(p)) roots.push({ name: letter, path: p, kind: 'drive' })
    }
  } else {
    roots.push({ name: '/', path: '/', kind: 'drive' })
  }
  // 桌面 / 下载 / 文档：优先用系统真实路径（可能被重定向到 D 盘等），回退到 home 拼路径
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const specialDirs = await getWinSpecialDirs()
  const specials = []
  const list = [
    { name: '桌面', key: 'Desktop', icon: '🖥' },
    { name: '下载', key: 'Downloads', icon: '⬇' },
    { name: '文档', key: 'Documents', icon: '📄' }
  ]
  for (const it of list) {
    const p = specialDirs[it.key] || path.join(home, it.key)
    if (p && fs.existsSync(p)) specials.push({ name: it.name, path: p, kind: 'special', icon: it.icon })
  }
  return {
    home,
    cwd: process.cwd(),
    presets: guessModsDirs(),
    specials,
    roots
  }
})
on('POST', '/api/fs/mkdir', async (req) => {
  const body = await readBody(req)
  const target = (body.path || '').trim()
  if (!target) return { error: '缺少路径' }
  // 简单的合法性校验：不允许通配符和换行
  if (/[\r\n\t*?"<>|]/.test(target)) return { error: '路径含非法字符' }
  try {
    await fsp.mkdir(target, { recursive: false })
    return { ok: true, path: target }
  } catch (e) {
    return { error: '创建失败：' + e.message }
  }
})

// ---------------- 数据导入导出 ----------------
on('GET', '/api/data/export', async () => {
  const settings = store.get('settings', DEFAULT_SETTINGS)
  const clientmods = store.get('clientmods', { items: DEFAULT_CLIENT_MODS })
  const monitors = store.get('monitors', { items: [] })
  return { type: 'mc-toolbox-backup', version: 1, exportedAt: Date.now(), settings, clientmods, monitors }
})
on('POST', '/api/data/import', async (req) => {
  const body = await readBody(req)
  if (body.settings) await store.set('settings', deepMerge(DEFAULT_SETTINGS, body.settings))
  if (body.clientmods) await store.set('clientmods', body.clientmods)
  if (body.monitors) await store.set('monitors', body.monitors)
  return { ok: true }
})

// ---------------- 系统 ----------------
on('GET', '/api/system/info', async () => ({
  node: process.version,
  platform: process.platform,
  root: ROOT,
  dataDir: DATA_DIR,
  configDir: CONFIG_DIR,
  clientModsDir: CLIENT_MODS_DIR,
  featuresDir: FEATURES_DIR,
  uptime: process.uptime()
}))

// 把资源管理器窗口置前（AppActivate 尝试多个候选标题）
async function activateWindowByTitle(titles) {
  if (process.platform !== 'win32') return
  const { spawn: cpSpawn } = await import('node:child_process')
  const esc = (s) => String(s).replace(/'/g, "''")
  const script = `$ws = New-Object -ComObject WScript.Shell; foreach ($t in @(${titles.map((t) => `'${esc(t)}'`).join(',')})) { if ($ws.AppActivate($t)) { break } }`
  await new Promise((resolve) => {
    try {
      const p = cpSpawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' })
      p.on('exit', resolve); p.on('error', resolve)
      setTimeout(resolve, 5000)
    } catch { resolve() }
  })
}

// 在文件管理器里打开目录（Windows：explorer；macOS：open；Linux：xdg-open）
//
// 说明：从 GUI 子系统进程直接 spawn explorer 有时会静默失败（窗口不弹出），
// 因此这里做了「主方案 + 回退方案」；打开成功后再尝试把窗口置前，
// 避免窗口被 Edge 应用窗口挡住，看起来像「没打开」。
// 返回 { ok, method, error, attempts, file }。
async function openInFileManager(target, { selectFile = '' } = {}) {
  const { spawnSync: cpSpawnSync } = await import('node:child_process')
  const attempts = []
  let ok = false
  let method = ''
  let lastError = ''

  // 只关心「进程能不能起来」，不关心退出码：
  // explorer.exe 把请求转交给已有资源管理器进程后会立刻退出，退出码并不表示成功与否，
  // 用退出码判定会导致误判失败、进而重复用备用方案打开第二个窗口。
  const run = (cmd, args, opts = {}) => {
    try {
      const r = cpSpawnSync(cmd, args, {
        timeout: 6000,
        windowsHide: false,
        stdio: 'ignore',
        ...opts
      })
      attempts.push(r.error ? `${cmd}:error(${r.error.message})` : `${cmd}:${r.status}`)
      if (r.error) { lastError = r.error.message; return false }
      return true
    } catch (e) { lastError = e.message; attempts.push(`${cmd}:throw(${e.message})`); return false }
  }

  const openTarget = selectFile ? path.dirname(selectFile) : target
  if (process.platform === 'win32') {
    // 方案 1：有文件用 /select 直接选中；否则打开目录
    if (selectFile) ok = run('explorer', ['/select,', selectFile])
    else ok = run('explorer', [openTarget])
    if (ok) method = selectFile ? 'explorer /select' : 'explorer'
    // 方案 2：cmd start（ShellExecute，会激活已有资源管理器窗口）
    if (!ok) {
      const comspec = process.env.ComSpec || 'cmd.exe'
      ok = run(comspec, ['/c', 'start', '""', openTarget], { windowsHide: true })
      if (ok) method = 'cmd start'
    }
    // 方案 3：PowerShell Start-Process
    if (!ok) {
      const t = openTarget.replace(/'/g, "''")
      ok = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${t}'`], { windowsHide: true })
      if (ok) method = 'powershell Start-Process'
    }
  } else if (process.platform === 'darwin') {
    ok = run('open', [openTarget])
    if (ok) method = 'open'
  } else {
    ok = run('xdg-open', [openTarget])
    if (ok) method = 'xdg-open'
  }

  // 置前：等窗口创建后，用目录名（窗口标题）AppActivate
  if (ok) {
    const dirName = path.basename(openTarget)
    await new Promise((r) => setTimeout(r, 350))
    await activateWindowByTitle([dirName, '文件资源管理器', 'File Explorer', 'Windows 资源管理器', 'Windows Explorer'])
  }

  return {
    ok,
    method: ok ? method : '',
    file: selectFile || '',
    error: ok ? '' : `打开失败：${lastError || '文件管理器启动失败'}（路径：${selectFile || openTarget}）`,
    attempts
  }
}

on('POST', '/api/system/open-path', async (req) => {
  const body = await readBody(req)
  const which = String(body.which || '')
  let target = ''
  if (which === 'clientModsDir') target = CLIENT_MODS_DIR
  else if (which === 'configDir') target = CONFIG_DIR
  else if (which === 'dataDir') target = DATA_DIR
  else return { error: '未知目录：' + which }

  try { fs.mkdirSync(target, { recursive: true }) } catch (e) {
    return { error: '目录创建失败：' + e.message, target }
  }

  // 可选：直接选中某个文件（例如 clientmods.json）
  let selectFile = ''
  if (body.file) {
    const p = safeJoin(target, String(body.file))
    if (p && fs.existsSync(p)) selectFile = p
  }
  // clientmods 目录：确保库文件已生成，否则打开空目录会让人以为功能坏了
  if (which === 'clientModsDir' && !selectFile) {
    try {
      store.get('clientmods', DEFAULT_CLIENT_MODS)
      const f = path.join(target, 'clientmods.json')
      if (fs.existsSync(f)) selectFile = f
    } catch {}
  }

  const r = await openInFileManager(target, { selectFile })
  return { target, ...r }
})

// ---------------- 静态资源 ----------------
async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath).replace(/^\/+/, '')
  if (!rel) rel = 'index.html'
  const full = safeJoin(PUBLIC_DIR, rel)
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    // SPA 回退
    const idx = path.join(PUBLIC_DIR, 'index.html')
    if (fs.existsSync(idx)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'] })
      res.end(await fsp.readFile(idx))
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404 Not Found')
    return
  }
  const ext = path.extname(full).toLowerCase()
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  })
  res.end(await fsp.readFile(full))
}

export async function requestHandler(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname
  const query = Object.fromEntries(url.searchParams.entries())

  if (pathname.startsWith('/api/')) {
    try {
      // 每次 API 请求前同步代理配置（供下载引擎/服务端核心的 httpFetch 使用）
      setProxy((store.get('settings', DEFAULT_SETTINGS).network || {}).proxy || '')
      for (const r of routes) {
        if (r.method !== req.method) continue
        const params = match(r.pattern, pathname)
        if (!params) continue
        const data = await r.handler(req, params, query)
        sendJson(res, 200, data)
        return
      }
      sendJson(res, 404, { error: '接口不存在: ' + pathname })
    } catch (e) {
      sendJson(res, 500, { error: e.message })
    }
    return
  }

  try {
    await serveStatic(req, res, pathname)
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('500 ' + e.message)
  }
}
