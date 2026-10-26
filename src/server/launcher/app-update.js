// 启动器自身更新（GitHub Releases）。
//
// 流程：检查最新 release → 下载对应的 exe → 退出并交给独立的 PowerShell 脚本
// 替换正在运行的程序 → 重新启动。开发模式（node server.js）只做检查，不替换本体。
//
// 设计约束：
//  - 只在打包版（SEA）且 Windows 上允许替换，开发模式给出可操作的提示；
//  - 下载走 download.js 的 fetchToFile（代理、重试、大小校验、进度都复用）；
//  - 替换脚本先等当前进程退出，再「改名备份 → 复制 → 校验 → 回滚」，失败时仍拉回旧版；
//  - Token 只用于访问私有仓库 / 提高 API 限额，保存在本地 launcher.json，不回传给前端。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { httpFetch } from '../http.js'
import { PRODUCT_VERSION } from '../build-meta.js'
import { isSEA } from '../paths.js'
import { fetchToFile } from './download.js'
import { getSettings, updateSettings } from './state.js'

export const DEFAULT_REPO = 'WJ1752/mc-toolbox'
const API_BASE = String(process.env.MC_TOOLBOX_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '')
const CHECK_TTL = 10 * 60 * 1000
const MAX_ASSET_BYTES = 512 * 1024 * 1024
const REQUEST_TIMEOUT = 20000
const USER_AGENT = `MC-Toolbox/${PRODUCT_VERSION}`

export const UPDATE_DEFAULTS = {
  autoCheck: true,          // 启动器打开时自动检查一次
  includePrerelease: false, // 是否接受预发布版本
  repo: '',                 // 空 = DEFAULT_REPO
  token: '',                // 私有仓库 / 提高限额用；只保存在本地
  skippedVersion: ''        // 用户选择「忽略此版本」后不再提示
}

/* ------------------------------------------------------------------ */
/* 版本号                                                              */
/* ------------------------------------------------------------------ */

/** 解析 `v1.9.2` / `1.9.2-beta.1` 这类标签；无法解析时返回 null。 */
export function parseVersion(text) {
  const source = String(text ?? '').trim().replace(/^v/i, '')
  const m = source.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+]([0-9A-Za-z.-]+))?$/)
  if (!m) return null
  return {
    major: Number(m[1]) || 0,
    minor: Number(m[2]) || 0,
    patch: Number(m[3]) || 0,
    pre: m[4] || ''
  }
}

/** 语义化比较：返回 -1 / 0 / 1；无法解析的一侧按相等处理。 */
export function compareVersions(a, b) {
  const pa = typeof a === 'string' ? parseVersion(a) : a
  const pb = typeof b === 'string' ? parseVersion(b) : b
  if (!pa || !pb) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1
  }
  if (pa.pre === pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  const left = pa.pre.split('.')
  const right = pb.pre.split('.')
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i]
    const y = right[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const dx = Number(x)
      const dy = Number(y)
      if (dx !== dy) return dx > dy ? 1 : -1
    } else if (nx !== ny) {
      return nx ? -1 : 1
    } else if (x !== y) {
      return x > y ? 1 : -1
    }
  }
  return 0
}

/** 从 release 列表里挑版本号最高的一个（过滤草稿 / 可选预发布）。 */
export function pickRelease(releases, { includePrerelease = false } = {}) {
  const list = (Array.isArray(releases) ? releases : [])
    .filter((item) => item && !item.draft)
    .map((item) => ({ release: item, version: parseVersion(item.tag_name) }))
    .filter((item) => item.version && (includePrerelease || !item.release.prerelease))
  list.sort((a, b) => compareVersions(b.version, a.version))
  return list[0] || null
}

/** 选择 Windows 可执行文件资产；优先 `mc-toolbox.exe`，其次其它 exe。 */
export function pickAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const exes = assets.filter((asset) => /\.exe$/i.test(String(asset?.name || '')))
  if (!exes.length) return null
  return exes.find((asset) => /^mc-toolbox\.exe$/i.test(asset.name))
    || exes.find((asset) => /^mc-toolbox/i.test(asset.name))
    || exes[0]
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

function validRepo(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(value || '').trim())
}

/** 当前更新配置（合并默认值；repo 非法时回退到官方仓库）。 */
export function readUpdateConfig() {
  const raw = getSettings()?.update || {}
  const repo = validRepo(raw.repo) ? String(raw.repo).trim() : DEFAULT_REPO
  return {
    autoCheck: raw.autoCheck !== false,
    includePrerelease: raw.includePrerelease === true,
    repo,
    token: String(raw.token || '').trim(),
    skippedVersion: String(raw.skippedVersion || '').trim()
  }
}

/** 给前端看的配置：Token 只回传「是否已设置」。 */
export function publicUpdateConfig() {
  const cfg = readUpdateConfig()
  return {
    autoCheck: cfg.autoCheck,
    includePrerelease: cfg.includePrerelease,
    repo: cfg.repo,
    tokenSet: !!cfg.token,
    skippedVersion: cfg.skippedVersion
  }
}

export function currentVersion() {
  return PRODUCT_VERSION
}

/* ------------------------------------------------------------------ */
/* GitHub API                                                          */
/* ------------------------------------------------------------------ */

async function githubJson(route, { token, repo }) {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  if (token) headers.Authorization = `Bearer ${token}`
  let res
  try {
    res = await httpFetch(API_BASE + route, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT)
    })
  } catch (e) {
    const code = e?.cause?.code || e?.code || ''
    const reason = e?.name === 'TimeoutError' ? '请求超时' : (code || e?.message || '网络错误')
    throw new Error(`连接 GitHub 失败（${reason}）。请检查网络或在设置里配置下载代理。`)
  }
  let data = null
  try { data = await res.json() } catch {}
  if (res.ok) return data
  if (res.status === 404) {
    throw new Error(`找不到仓库或发布：${repo}。如果仓库还是私有，请在「设置 → 启动器 → 更新」里填写 GitHub Token。`)
  }
  if (res.status === 401) throw new Error('GitHub Token 无效或已过期，请重新填写。')
  if (res.status === 403) {
    const message = String(data?.message || '')
    if (/rate limit/i.test(message)) throw new Error('GitHub API 请求过于频繁（未登录限额为每小时 60 次），请稍后再试或填写 Token。')
    throw new Error('GitHub 拒绝了请求：' + (message || 'HTTP 403'))
  }
  throw new Error(`GitHub 接口返回 HTTP ${res.status}${data?.message ? '：' + data.message : ''}`)
}

/* ------------------------------------------------------------------ */
/* 检查更新                                                             */
/* ------------------------------------------------------------------ */

let checkCache = null

/**
 * 检查是否有新版本。
 * @param {{force?: boolean}} [options]
 * @returns {Promise<object>} 结果对象（含 updateAvailable / release / asset）
 */
export async function checkForUpdate({ force = false } = {}) {
  const cfg = readUpdateConfig()
  const cacheKey = `${cfg.repo}|${cfg.includePrerelease ? 'pre' : 'stable'}|${cfg.token ? 'auth' : 'anon'}`
  if (!force && checkCache && checkCache.key === cacheKey && Date.now() - checkCache.at < CHECK_TTL) {
    return checkCache.value
  }

  const releases = await githubJson(`/repos/${cfg.repo}/releases?per_page=30`, cfg)
  const picked = pickRelease(releases, { includePrerelease: cfg.includePrerelease })
  const current = currentVersion()

  if (!picked) {
    const value = {
      ok: true,
      repo: cfg.repo,
      current,
      latest: '',
      updateAvailable: false,
      skipped: false,
      release: null,
      asset: null,
      checkedAt: Date.now(),
      message: '仓库里还没有发布版本'
    }
    checkCache = { key: cacheKey, at: Date.now(), value }
    return value
  }

  const release = picked.release
  const asset = pickAsset(release)
  const latest = String(release.tag_name || '').replace(/^v/i, '')
  const updateAvailable = compareVersions(latest, current) > 0
  const value = {
    ok: true,
    repo: cfg.repo,
    current,
    latest,
    updateAvailable,
    skipped: !!latest && cfg.skippedVersion === latest,
    release: {
      tag: release.tag_name || '',
      name: release.name || release.tag_name || '',
      notes: String(release.body || '').slice(0, 20000),
      publishedAt: release.published_at || '',
      htmlUrl: release.html_url || `https://github.com/${cfg.repo}/releases`,
      prerelease: release.prerelease === true,
      browserUrl: release.html_url || `https://github.com/${cfg.repo}/releases`
    },
    asset: asset ? {
      name: asset.name,
      size: Number(asset.size) || 0,
      digest: String(asset.digest || ''),
      downloadUrl: asset.browser_download_url || '',
      apiUrl: asset.url || ''
    } : null,
    checkedAt: Date.now()
  }
  if (updateAvailable && !asset) {
    value.message = '新版本没有附带可执行文件，请到发布页手动下载'
  }
  checkCache = { key: cacheKey, at: Date.now(), value }
  return value
}

/* ------------------------------------------------------------------ */
/* 下载                                                                */
/* ------------------------------------------------------------------ */

function updateRoot() {
  return path.join(os.tmpdir(), 'mc-toolbox-update')
}

function safeDirName(text) {
  return String(text || '').replace(/[^0-9A-Za-z._-]/g, '_') || 'latest'
}

let downloadState = {
  status: 'idle',   // idle | downloading | ready | applying | error
  version: '',
  received: 0,
  total: 0,
  error: '',
  file: '',
  startedAt: 0,
  finishedAt: 0
}

export function getDownloadState() {
  return { ...downloadState }
}

function resetDownload(extra = {}) {
  downloadState = {
    status: 'idle',
    version: '',
    received: 0,
    total: 0,
    error: '',
    file: '',
    startedAt: 0,
    finishedAt: 0,
    ...extra
  }
  return downloadState
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadAsset(info) {
  const cfg = readUpdateConfig()
  const asset = info.asset
  if (!asset) throw new Error('发布里没有可下载的 exe')
  const dir = path.join(updateRoot(), safeDirName(info.latest))
  await fsp.mkdir(dir, { recursive: true })
  const target = path.join(dir, 'mc-toolbox.exe')

  // 有 Token 时走 API 资产地址（私有仓库必须），否则直接用公开下载地址。
  const useApi = !!cfg.token && !!asset.apiUrl
  const url = useApi ? asset.apiUrl : asset.downloadUrl
  if (!url) throw new Error('发布资产缺少下载地址')
  const headers = useApi ? { Accept: 'application/octet-stream', Authorization: `Bearer ${cfg.token}` } : {}

  await fetchToFile(url, target, {
    size: asset.size || 0,
    maxBytes: MAX_ASSET_BYTES,
    retries: 2,
    // 自更新包几十 MB，GitHub 资产支持 Range：和其它大文件一样用分段下载。
    threads: Math.max(1, Math.min(16, Number(getSettings().threads) || 4)),
    headers,
    onProgress: ({ received, total }) => {
      downloadState.received = received
      downloadState.total = total || asset.size || 0
    }
  })

  if (asset.digest) {
    const algo = String(asset.digest).split(':')[0]
    if (algo === 'sha256') {
      const expected = String(asset.digest).split(':')[1] || ''
      const actual = await sha256File(target)
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        await fsp.rm(target, { force: true })
        throw new Error('更新包 SHA-256 校验失败')
      }
    }
  }
  const stat = await fsp.stat(target)
  if (!stat.size) throw new Error('下载到的更新包是空文件')
  if (asset.size && stat.size !== asset.size) {
    await fsp.rm(target, { force: true })
    throw new Error(`更新包大小不一致（${stat.size} / ${asset.size} 字节）`)
  }
  return target
}

/**
 * 启动下载（立即返回，进度通过 getDownloadState 轮询）。
 * 重复调用不会开第二个任务。
 */
export function startDownload() {
  if (downloadState.status === 'downloading') return getDownloadState()
  if (downloadState.status === 'ready' && downloadState.file) return getDownloadState()
  resetDownload({ status: 'downloading', startedAt: Date.now() })
  ;(async () => {
    try {
      const info = await checkForUpdate({ force: true })
      if (!info.updateAvailable) throw new Error('当前已经是最新版本')
      if (!info.asset) throw new Error(info.message || '发布里没有可下载的 exe')
      downloadState.version = info.latest
      downloadState.total = info.asset.size || 0
      const file = await downloadAsset(info)
      downloadState.file = file
      downloadState.status = 'ready'
      downloadState.finishedAt = Date.now()
    } catch (e) {
      downloadState.status = 'error'
      downloadState.error = e?.message || String(e)
      downloadState.finishedAt = Date.now()
    }
  })()
  return getDownloadState()
}

/** 清空下载状态（失败后重试用）。 */
export function resetDownloadState() {
  return resetDownload()
}

/* ------------------------------------------------------------------ */
/* 替换并重启                                                           */
/* ------------------------------------------------------------------ */

function psQuote(value) {
  return "'" + String(value ?? '').replace(/'/g, "''") + "'"
}

/**
 * 生成替换脚本。先等当前进程退出，再改名备份 → 复制新版 → 失败回滚 → 重新启动。
 * 用 PowerShell 而不是 .cmd：中文路径 / 空格路径不需要处理代码页问题。
 */
export function buildUpdaterScript({ source, target, pid, log, workdir = '', args = [] }) {
  const backup = target + '.old'
  const argList = (Array.isArray(args) ? args : []).map((item) => psQuote(item)).join(', ')
  return [
    "$ErrorActionPreference = 'Continue'",
    `$src = ${psQuote(source)}`,
    `$dst = ${psQuote(target)}`,
    `$bak = ${psQuote(backup)}`,
    `$waitPid = ${Number(pid) || 0}`,
    `$log = ${psQuote(log)}`,
    `$workdir = ${psQuote(workdir || path.dirname(target))}`,
    `$argList = @(${argList})`,
    'function Write-Log([string]$line) {',
    '  try { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $line) -Encoding UTF8 } catch { }',
    '}',
    'Write-Log ("update start: pid=" + $waitPid)',
    'Write-Log ("  src=" + $src)',
    'Write-Log ("  dst=" + $dst)',
    '$deadline = (Get-Date).AddSeconds(180)',
    'while ((Get-Date) -lt $deadline) {',
    '  $proc = Get-Process -Id $waitPid -ErrorAction SilentlyContinue',
    '  if ($null -eq $proc) { break }',
    '  Start-Sleep -Milliseconds 400',
    '}',
    '$proc = Get-Process -Id $waitPid -ErrorAction SilentlyContinue',
    'if ($null -ne $proc) {',
    '  Write-Log "launcher still running after 180s; abort without touching files"',
    '  exit 2',
    '}',
    'Start-Sleep -Milliseconds 800',
    'if (-not (Test-Path -LiteralPath $src)) { Write-Log "source missing"; exit 3 }',
    '$ok = $false',
    'try {',
    '  if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force -ErrorAction Stop }',
    '  Move-Item -LiteralPath $dst -Destination $bak -Force -ErrorAction Stop',
    '  Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop',
    '  if (-not (Test-Path -LiteralPath $dst)) { throw "目标文件没有生成" }',
    '  $ok = $true',
    '  Write-Log "replace ok"',
    '} catch {',
    '  Write-Log ("replace failed: " + $_.Exception.Message)',
    '  if ((Test-Path -LiteralPath $bak) -and -not (Test-Path -LiteralPath $dst)) {',
    '    try { Move-Item -LiteralPath $bak -Destination $dst -Force -ErrorAction Stop; Write-Log "rolled back" } catch { Write-Log ("rollback failed: " + $_.Exception.Message) }',
    '  }',
    '}',
    'if (-not $ok) {',
    '  Write-Log "update aborted; relaunching existing launcher"',
    '  if (Test-Path -LiteralPath $dst) {',
    '    try {',
    '      if ($argList.Count -gt 0) { Start-Process -FilePath $dst -ArgumentList $argList -WorkingDirectory $workdir }',
    '      else { Start-Process -FilePath $dst -WorkingDirectory $workdir }',
    '    } catch { }',
    '  }',
    '  exit 1',
    '}',
    'try { Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue } catch { }',
    'Start-Sleep -Milliseconds 400',
    'try {',
    '  if ($argList.Count -gt 0) { Start-Process -FilePath $dst -ArgumentList $argList -WorkingDirectory $workdir }',
    '  else { Start-Process -FilePath $dst -WorkingDirectory $workdir }',
    '  Write-Log "relaunched"',
    '} catch { Write-Log ("relaunch failed: " + $_.Exception.Message) }',
    'exit 0',
    ''
  ].join('\r\n')
}

/**
 * 通过 WMI 启动替换脚本。
 *
 * 为什么不用普通 spawn：Windows 10/11 会把从资源管理器 / start.bat 启动的进程放进
 * 作业对象，作业里的子进程会随父进程退出一起被结束（实测：父进程 taskkill 后脚本
 * 立刻消失，日志停在「等待退出」）。WMI 创建的新进程由 WmiPrvSE 持有，不在这个作业里，
 * 旧启动器退出后仍能继续替换并重启。
 */
function launchUpdaterViaWmi(script) {
  const cmdLine = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${script}"`
  const ps = [
    '$ErrorActionPreference = "Stop"',
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(cmdLine)} }`,
    'if ($r.ReturnValue -eq 0) { Write-Output ("PID=" + $r.ProcessId) } else { Write-Output ("ERR=" + $r.ReturnValue); exit 1 }'
  ].join('; ')
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    timeout: 25000,
    windowsHide: true
  })
  const stdout = String(res.stdout || '')
  const stderr = String(res.stderr || '')
  const match = stdout.match(/PID=(\d+)/)
  if (res.error) return { ok: false, detail: res.error.message }
  if (res.status !== 0) return { ok: false, detail: stderr || stdout || `exit ${res.status}` }
  return match ? { ok: true, pid: Number(match[1]) } : { ok: false, detail: stdout || stderr || '没有返回进程号' }
}

/**
 * 应用已下载的更新：写替换脚本 → 弹独立进程 → 由脚本等本进程退出后替换并重启。
 * 调用方（前端）收到 ok 后应关闭窗口，让服务正常退出。
 */
export async function applyUpdate() {
  if (!isSEA) {
    throw new Error('开发模式运行的是 node server.js，无法替换程序本体。请使用打包版启动器，或从发布页手动下载。')
  }
  if (process.platform !== 'win32') throw new Error('一键更新目前只支持 Windows 打包版。')
  if (downloadState.status !== 'ready' || !downloadState.file) throw new Error('更新包还没有下载完成')

  const source = downloadState.file
  const stat = await fsp.stat(source).catch(() => null)
  if (!stat?.isFile()) throw new Error('更新包已被删除，请重新下载')

  const target = process.execPath
  if (!/\.exe$/i.test(target)) throw new Error('当前程序不是 .exe，无法一键替换')
  try {
    await fsp.access(path.dirname(target), fs.constants.W_OK)
  } catch {
    throw new Error('启动器所在目录没有写入权限，请把它放到可写的文件夹后再更新')
  }

  const dir = path.dirname(source)
  const script = path.join(dir, 'apply-update.ps1')
  const log = path.join(dir, 'apply-update.log')
  await fsp.writeFile(script, '\ufeff' + buildUpdaterScript({
    source,
    target,
    pid: process.pid,
    log,
    workdir: path.dirname(target),
    // 保留启动参数（--port= / --no-open 等），重启后的实例和原来一致。
    args: process.argv.slice(2)
  }), 'utf8')

  // 优先走 WMI（不受作业对象连带结束影响）；WMI 不可用时退回普通子进程。
  // 注意不能加 detached:true：Windows 上 DETACHED_PROCESS 启动的 powershell
  // 会立刻以 0 退出且不执行命令（实测），替换脚本就永远等不到旧进程退出。
  let launched = null
  try {
    launched = launchUpdaterViaWmi(script)
  } catch (e) {
    launched = { ok: false, detail: e.message }
  }
  if (!launched.ok) {
    console.warn('[update] WMI 启动更新脚本失败，退回普通子进程：' + launched.detail)
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass', '-File', script
    ], { stdio: 'ignore', windowsHide: true, cwd: dir })
    child.on('error', (e) => {
      downloadState.status = 'error'
      downloadState.error = '无法启动更新脚本：' + e.message
    })
    child.unref()
  }

  downloadState.status = 'applying'
  // 兜底：前端没能立刻关窗时，也不再拖住替换脚本。
  const timer = setTimeout(() => { try { process.exit(0) } catch {} }, 12000)
  timer.unref?.()

  return { ok: true, restarting: true, log, script }
}

/* ------------------------------------------------------------------ */
/* 忽略版本                                                            */
/* ------------------------------------------------------------------ */

export function markSkipped(version) {
  const current = getSettings()?.update || {}
  updateSettings({ update: { ...current, skippedVersion: String(version || '').trim() } })
  checkCache = null
  return publicUpdateConfig()
}
