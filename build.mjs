// MC 工具箱 — 单文件可执行构建脚本
// 产物：dist/mc-toolbox.exe（≈ Node 22 体积 + 内嵌源码 + 内嵌 public.tar.gz）
// 用法：node build.mjs
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { exec, execFile } from 'node:child_process'
import { spawn as spawnProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { collectShellHashes, sha256 } from './src/server/integrity.js'
import { AUTHOR } from './src/server/build-meta.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(here, 'dist')
const BUNDLE = path.join(DIST, '_bundle')
const NODE_EXE = process.execPath
const TARGET_EXE = path.join(DIST, process.env.MC_TOOLBOX_TARGET_EXE || (process.platform === 'win32' ? 'mc-toolbox.exe' : 'mc-toolbox'))
const SEA_BLOB = path.join(BUNDLE, 'sea-prep.blob')
const SEA_CONFIG = path.join(BUNDLE, 'sea-config.json')
const BUNDLE_CJS = path.join(BUNDLE, 'bundle.cjs')
const I18N_SOURCE = path.join(here, 'vendor', 'mc-i18n')

const gunzip = promisify(zlib.gunzip)
const gzip = promisify(zlib.gzip)

// 找 npx 缓存里的 esbuild（不强制用户装本地依赖）
const ESBUILD_BIN = process.env.ESBUILD_BIN
  || findEsbuild()

function findEsbuild() {
  // Windows npm 缓存常见路径
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const cache = path.join(home, 'AppData', 'Local', 'npm-cache', '_npx')
  try {
    for (const d of fs.readdirSync(cache)) {
      // 直接指向 bin/esbuild（无扩展名但内容是 JS shebang 脚本）
      const cand = path.join(cache, d, 'node_modules', 'esbuild', 'bin', 'esbuild')
      if (fs.existsSync(cand)) return cand
    }
  } catch {}
  // 回退：直接 npx
  return 'npx --yes esbuild'
}

function logStep(n, msg) {
  console.log(`\n[${n}/8] ${msg}`)
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true }).catch(() => {})
}

// ---------- 0. 准备工作目录 ----------
async function step0() {
  logStep(0, '准备构建目录')
  await rmrf(DIST)
  await fsp.mkdir(BUNDLE, { recursive: true })
}

// ---------- 1. esbuild 把 server.js 打成 CJS bundle ----------
async function step1() {
  logStep(1, 'esbuild bundle server.js')
  const args = [path.join(here, 'server.js'), '--bundle', '--platform=node', '--target=node22', '--format=cjs', `--outfile=${BUNDLE_CJS}`, '--external:node:*', '--legal-comments=none', '--log-level=warning']
  // esbuild 的真实入口是 bin/esbuild（无扩展名），通过 node 解释执行
  await runCmd(process.execPath, [ESBUILD_BIN, ...args])
  const stat = await fsp.stat(BUNDLE_CJS)
  console.log(`     bundle size: ${(stat.size / 1024).toFixed(1)} KB`)
}

// ---------- 2. public 目录 + WebView2 host 打包 ----------
async function step2() {
  logStep(2, '打包 public/ 为 tar.gz')
  const target = path.join(BUNDLE, 'public.tar.gz')
  // 在 bash 子 shell 内：cd 到 public 内，再用 tar 打包当前目录内容到绝对路径
  // 用绝对路径避免 bash 子 shell cd 与 cwd 冲突
  const publicAbs = path.join(here, 'public').replace(/\\/g, '/')
  const targetAbs = target.replace(/\\/g, '/')
  const cmd = `cd "${publicAbs}" && tar --force-local -czf "${targetAbs}" .`
  await runBash(cmd)
  const stat = await fsp.stat(target)
  console.log(`     packed, ${(stat.size / 1024).toFixed(1)} KB`)

  // mc-i18n 运行时源码（纯 Python 标准库，SEA 运行时解压到 runtime/mc-i18n）
  if (fs.existsSync(path.join(I18N_SOURCE, 'mc_i18n', '__main__.py'))) {
    const i18nAbs = I18N_SOURCE.replace(/\\/g, '/')
    const i18nTarget = path.join(BUNDLE, 'mc-i18n.tar.gz').replace(/\\/g, '/')
    await runBash(`cd "${i18nAbs}" && tar --force-local --exclude=__pycache__ --exclude=*.pyc -czf "${i18nTarget}" .`)
    const i18nStat = await fsp.stat(i18nTarget)
    console.log(`     mc-i18n runtime packed, ${(i18nStat.size / 1024).toFixed(1)} KB`)
  } else {
    console.log('     (未找到 vendor/mc-i18n：跳过翻译运行时打包)')
  }

  await buildWebView2Host()
}

// ---------- 2b. WebView2 无边框窗口宿主 ----------
const HOST_CS = path.join(here, 'host', 'host.cs')
const WV2_LIB = path.join(here, 'host', 'lib')

async function buildWebView2Host() {
  if (process.platform !== 'win32') {
    console.log('     (非 Windows：跳过 host 构建，回退 Edge 窗口)')
    return
  }
  if (!fs.existsSync(HOST_CS)) {
    console.log('     (未找到 host/host.cs：跳过 host，将回退 Edge 窗口)')
    return
  }
  const hostDir = path.join(BUNDLE, 'host')
  await rmrf(hostDir)
  await fsp.mkdir(hostDir, { recursive: true })

  const libDir = await ensureWebView2Lib()
  const coreDll = path.join(libDir, 'Core.dll')
  const winDll = path.join(libDir, 'WinForms.dll')
  const loader = path.join(libDir, 'Loader.dll')

  await fsp.copyFile(coreDll, path.join(hostDir, 'Microsoft.Web.WebView2.Core.dll'))
  await fsp.copyFile(winDll, path.join(hostDir, 'Microsoft.Web.WebView2.WinForms.dll'))
  await fsp.copyFile(loader, path.join(hostDir, 'WebView2Loader.dll'))

  const csc = findCsc()
  if (!csc) {
    console.log('     (未找到 .NET Framework csc.exe：跳过 host 编译，将回退 Edge 窗口)')
    return
  }
  const icoPath = path.join(hostDir, 'app.ico')
  await writeAppIcon(icoPath)
  const hostExe = path.join(hostDir, 'host.exe')
  await runCmd(csc, [
    '/nologo', '/target:winexe', '/platform:anycpu',
    `/out:${hostExe}`,
    `/win32icon:${icoPath}`,
    `/r:${coreDll}`, `/r:${winDll}`,
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    HOST_CS
  ])

  const hostAbs = hostDir.replace(/\\/g, '/')
  const tarAbs = path.join(BUNDLE, 'host.tar.gz').replace(/\\/g, '/')
  await runBash(`cd "${hostAbs}" && tar --force-local -czf "${tarAbs}" .`)
  const st = await fsp.stat(path.join(BUNDLE, 'host.tar.gz'))
  console.log(`     WebView2 host 构建完成（host.exe + Core.dll + WinForms.dll + WebView2Loader.dll → ${(st.size / 1024).toFixed(1)} KB）`)
}

function findCsc() {
  const cands = [
    'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
    'C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe'
  ]
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch {} }
  return null
}

async function ensureWebView2Lib() {
  await fsp.mkdir(WV2_LIB, { recursive: true })
  const marker = path.join(WV2_LIB, '.ver')
  if (fs.existsSync(marker)) {
    const ver = fs.readFileSync(marker, 'utf8').trim()
    const dir = path.join(WV2_LIB, ver)
    if (fs.existsSync(path.join(dir, 'Core.dll')) &&
        fs.existsSync(path.join(dir, 'WinForms.dll')) &&
        fs.existsSync(path.join(dir, 'Loader.dll'))) {
      console.log(`     WebView2 SDK 使用缓存版本 ${ver}`)
      return dir
    }
  }
  console.log('     下载 Microsoft.Web.WebView2 SDK（首次需要，之后走 host/lib 缓存）…')
  const idxUrl = 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/index.json'
  const idx = await fetch(idxUrl).then((r) => r.json())
    .catch((e) => { throw new Error('拉取 WebView2 SDK 版本列表失败：' + e.message) })
  const stable = (idx.versions || []).filter((v) => /^\d+(\.\d+){2,3}$/.test(v))
    .sort((a, b) => {
      const pa = a.split('.').map(Number)
      const pb = b.split('.').map(Number)
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0
        const y = pb[i] || 0
        if (x !== y) return x - y
      }
      return 0
    })
  const ver = stable[stable.length - 1]
  if (!ver) throw new Error('WebView2 SDK 没有可用稳定版本')
  const pkgUrl = `https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${ver}/microsoft.web.webview2.${ver}.nupkg`
  const buf = Buffer.from(await fetch(pkgUrl).then((r) => r.arrayBuffer())
    .catch((e) => { throw new Error('下载 WebView2 SDK 失败：' + e.message) }))
  const dir = path.join(WV2_LIB, ver)
  await fsp.mkdir(dir, { recursive: true })
  extractZip(buf, (name) => {
    if (name.endsWith('lib/net462/Microsoft.Web.WebView2.Core.dll')) return 'Core.dll'
    if (name.endsWith('lib/net462/Microsoft.Web.WebView2.WinForms.dll')) return 'WinForms.dll'
    if (name.endsWith('runtimes/win-x64/native/WebView2Loader.dll')) return 'Loader.dll'
    return null
  }, dir)
  await fsp.writeFile(marker, ver, 'utf8')
  console.log(`     WebView2 SDK ${ver} 就绪`)
  return dir
}

// ---------- 应用图标：生成多尺寸 .ico（草方块风格，与品牌 logo 一致） ----------
function drawIconRgba(size) {
  const px = Buffer.alloc(size * size * 4)
  const lerp = (a, b, t) => Math.round(a + (b - a) * t)
  const c1 = [0x7e, 0xdd, 0x8f] // 上左浅绿
  const c2 = [0x2e, 0x9e, 0x45] // 下右深绿
  // favicon 同款：斜向渐变 + 两个深色像素块
  const squares = []
  const sq = (x0, y0, w) => squares.push({ x0, y0, x1: x0 + w, y1: y0 + w })
  sq(0.15, 0.15, 0.30)
  sq(0.55, 0.55, 0.30)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = Math.min(1, (x + y) / (2 * (size - 1)))
      let r = lerp(c1[0], c2[0], t)
      let g = lerp(c1[1], c2[1], t)
      let b = lerp(c1[2], c2[2], t)
      const fx = x / size
      const fy = y / size
      for (const s of squares) {
        if (fx >= s.x0 && fx < s.x1 && fy >= s.y0 && fy < s.y1) {
          r = Math.round(r * 0.55)
          g = Math.round(g * 0.55)
          b = Math.round(b * 0.55)
          break
        }
      }
      // 外围 1px 描边让浅色任务栏上更清晰
      const edge = x === 0 || y === 0 || x === size - 1 || y === size - 1
      if (edge) { r *= 0.8; g *= 0.8; b *= 0.8 }
      const o = (y * size + x) * 4
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255
    }
  }
  return px
}

function encodePng(size, rgba) {
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  // Node zlib 不直接提供 crc32；自己实现查表法
  const crcTable = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })()
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const mk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    mk('IHDR', ihdr), mk('IDAT', idat), mk('IEND', Buffer.alloc(0))])
}

async function writeAppIcon(icoPath) {
  const sizes = [16, 24, 32, 48, 64]
  const pngs = sizes.map((s) => ({ size: s, data: encodePng(s, drawIconRgba(s)) }))
  const head = Buffer.alloc(6 + 16 * pngs.length)
  head.writeUInt16LE(0, 0) // reserved
  head.writeUInt16LE(1, 2) // type icon
  head.writeUInt16LE(pngs.length, 4)
  let offset = head.length
  pngs.forEach((p, i) => {
    const e = 6 + 16 * i
    head[e] = p.size >= 256 ? 0 : p.size
    head[e + 1] = p.size >= 256 ? 0 : p.size
    head[e + 2] = 0 // palette
    head[e + 3] = 0
    head.writeUInt16LE(1, e + 4)   // planes
    head.writeUInt16LE(32, e + 6)  // bpp
    head.writeUInt32LE(p.data.length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += p.data.length
  })
  await fsp.writeFile(icoPath, Buffer.concat([head, ...pngs.map((p) => p.data)]))
  console.log(`     app.ico 已生成（${sizes.join('/')}px，${(offset / 1024).toFixed(1)} KB）`)
}

// 极简 zip 提取（只解出命中的条目；nupkg 为标准 zip，无 zip64）
function extractZip(buf, pick, destDir) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('无效的 zip（找不到 EOCD）')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const hits = []
  for (let k = 0; k < count; k++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    const out = pick(name)
    if (out) hits.push({ localOff, method, compSize, out })
    off += 46 + nameLen + extraLen + commentLen
  }
  for (const h of hits) {
    const ln = buf.readUInt16LE(h.localOff + 26)
    const ex = buf.readUInt16LE(h.localOff + 28)
    const start = h.localOff + 30 + ln + ex
    const data = buf.subarray(start, start + h.compSize)
    const raw = h.method === 8 ? zlib.inflateRawSync(data) : data
    fs.writeFileSync(path.join(destDir, h.out), raw)
  }
}

function runBash(cmdline, opts = {}) {
  return new Promise((resolve, reject) => {
    const home = process.env.USERPROFILE || process.env.HOME || ''
    const candidates = [
      path.join(home, '.workbuddy', 'binaries', 'PortableGit', 'versions', '1.2.0', 'bin', 'bash.exe'),
      path.join(home, 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe'),
      'C:\\Program Files\\Git\\bin\\bash.exe',
      '/usr/bin/bash',
      '/bin/bash'
    ]
    let bash
    for (const c of candidates) {
      try { if (fs.existsSync(c)) { bash = c; break } } catch {}
    }
    if (!bash) return reject(new Error('找不到 bash.exe，请安装 Git for Windows 或将 tar 命令改成 PowerShell/Node'))
    const child = spawnProcess(bash, ['-c', cmdline], { windowsHide: true, cwd: opts.cwd || process.cwd(), ...opts })
    let out = '', err = ''
    if (!opts.silent) {
      child.stdout?.on('data', (d) => process.stdout.write(d))
      child.stderr?.on('data', (d) => process.stderr.write(d))
    } else {
      child.stdout?.on('data', (d) => out += d.toString())
      child.stderr?.on('data', (d) => err += d.toString())
    }
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 || opts.ignoreError) resolve({ stdout: out, stderr: err })
      else reject(new Error(`bash exit ${code}: ${err.trim()}`))
    })
  })
}

// ---------- 3. 写 sea-config.json ----------
async function step3() {
  logStep(3, '写 sea-config.json')
  const assets = { 'publicbundle': path.join(BUNDLE, 'public.tar.gz') }
  const i18nTar = path.join(BUNDLE, 'mc-i18n.tar.gz')
  if (fs.existsSync(i18nTar)) assets['i18nbundle'] = i18nTar
  const hostTar = path.join(BUNDLE, 'host.tar.gz')
  if (fs.existsSync(hostTar)) assets['hostbundle'] = hostTar
  const cfg = {
    main: BUNDLE_CJS,  // 必须是绝对路径（SEA 不解析相对路径）
    output: SEA_BLOB,
    disableExperimentalSEAWarning: true,
    assets
  }
  await fsp.writeFile(SEA_CONFIG, JSON.stringify(cfg, null, 2))
}

// ---------- 4. 生成 sea-prep.blob ----------
async function step4() {
  logStep(4, 'node --experimental-sea-config 生成 blob')
  await runCmd(NODE_EXE, ['--experimental-sea-config', SEA_CONFIG])
  const stat = await fsp.stat(SEA_BLOB)
  console.log(`     blob size: ${(stat.size / 1024).toFixed(1)} KB`)
}

// ---------- 5. 复制 node.exe → mc-toolbox.exe ----------
async function step5() {
  logStep(5, `复制 node.exe → ${path.basename(TARGET_EXE)}`)
  await fsp.copyFile(NODE_EXE, TARGET_EXE)
}

// ---------- 6. postject 注入 blob ----------
async function step6() {
  logStep(6, 'postject 注入 SEA blob')
  const postject = findPostject()
  const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
  const args = [TARGET_EXE, 'NODE_SEA_BLOB', SEA_BLOB, '--sentinel-fuse', fuse, '--overwrite']
  if (postject.endsWith('.js')) {
    await runCmd(process.execPath, [postject, ...args])
  } else if (postject.includes(' ')) {
    await runCmd(postject.split(' ')[0], postject.split(' ').slice(1).concat(args))
  } else {
    await runCmd(postject, args)
  }
}

function findPostject() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const cache = path.join(home, 'AppData', 'Local', 'npm-cache', '_npx')
  try {
    for (const d of fs.readdirSync(cache)) {
      const cand = path.join(cache, d, 'node_modules', 'postject', 'dist', 'cli.js')
      if (fs.existsSync(cand)) return cand
    }
  } catch {}
  return 'npx --yes postject'
}

// ---------- 7. Windows: 把 exe 从 CONSOLE 子系统改为 GUI 子系统 ----------
async function step7() {
  if (process.platform !== 'win32') {
    logStep(7, '跳过 PE 子系统修改（非 Windows）')
    return
  }
  logStep(7, '修改 PE 子系统为 GUI（隐藏控制台窗口）')
  setWindowsSubsystem(TARGET_EXE)
}

function setWindowsSubsystem(exePath) {
  const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2
  const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3
  const buf = fs.readFileSync(exePath)
  const e_lfanew = buf.readUInt32LE(0x3C)
  if (buf.toString('ascii', e_lfanew, e_lfanew + 4) !== 'PE\0\0') {
    throw new Error('不是有效的 PE 文件')
  }
  const optionalHeaderOffset = e_lfanew + 4 + 20 // COFF header is 20 bytes
  const magic = buf.readUInt16LE(optionalHeaderOffset)
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new Error('未知的 PE magic: 0x' + magic.toString(16))
  }
  const checksumOffset = optionalHeaderOffset + 0x40
  const subsystemOffset = optionalHeaderOffset + 0x44
  const current = buf.readUInt16LE(subsystemOffset)
  if (current === IMAGE_SUBSYSTEM_WINDOWS_GUI) {
    console.log('     PE 子系统已经是 GUI(2)')
    return
  }
  if (current !== IMAGE_SUBSYSTEM_WINDOWS_CUI) {
    console.log(`     PE 子系统为 ${current}，不处理`)
    return
  }
  buf.writeUInt32LE(0, checksumOffset) // 清空 checksum，避免 Windows loader 校验失败
  buf.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_GUI, subsystemOffset)
  fs.writeFileSync(exePath, buf)
  console.log('     PE 子系统已改为 GUI(2)：双击 exe 不再弹出控制台黑框')
}

async function step8() {
  if (process.env.SKIP_SMOKE === '1') {
    console.log('  (已通过 SKIP_SMOKE=1 跳过冒烟测试)')
    return
  }
  logStep(8, '冒烟测试生成的 exe')
  await startAndProbe()
}

async function startAndProbe() {
  // Use isolated runtime/config paths so a running user window cannot lock the smoke host.
  const smokeDir = path.join(DIST, '_smoke')
  await rmrf(smokeDir)
  await fsp.mkdir(smokeDir, { recursive: true })
  const exe = path.join(smokeDir, 'mc-toolbox.exe')
  await fsp.copyFile(TARGET_EXE, exe)
  const localAppData = path.join(smokeDir, 'local')
  const data = path.join(localAppData, 'MC Toolbox', 'data')
  await fsp.mkdir(data, { recursive: true })
  await fsp.writeFile(path.join(data, 'dirs.json'), JSON.stringify({ configDir: path.join(smokeDir, 'config'), clientModsDir: path.join(smokeDir, 'client-mods') }))
  const net = await import('node:net')
  const reservation = net.createServer()
  await new Promise(r => reservation.listen(0, '127.0.0.1', r))
  const port = reservation.address().port
  await new Promise(r => reservation.close(r))
  const child = spawn(exe, ['--no-open', '--port=' + port], {
    cwd: smokeDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LOCALAPPDATA: localAppData, MC_TOOLBOX_PORT: String(port) }
  })
  let log = ''
  let exited = false
  const closed = new Promise(resolve => child.once('close', () => { exited = true; resolve() }))
  child.stdout.on('data', d => { log += d })
  child.stderr.on('data', d => { log += d })
  child.on('error', e => { log += e.message })
  try {
    const deadline = Date.now() + 20000
    while (!log.includes('本地地址:') && !exited && Date.now() < deadline) await new Promise(r => setTimeout(r, 200))
    if (!log.includes('本地地址:')) throw new Error('exe 启动失败：' + log)
    const base = `http://127.0.0.1:${port}`
    const res = await fetch(base + '/api/bootstrap').then(r => r.json())
    if (!res.features?.length) throw new Error('bootstrap 未返回功能')
    const html = await fetch(base + '/').then(r => r.text())
    const info = await fetch(base + '/api/system/info').then(r => r.json())
    if (info.author !== AUTHOR || !html.includes('class="author-watermark" aria-hidden="true">' + AUTHOR)) throw new Error('作者信息或角落水印验证失败')
    console.log('     ✓ 隔离环境：启动、首页、功能列表、作者信息及完整性校验全部通过')
  } finally {
    if (!exited) child.kill()
    await closed
    await rmrf(smokeDir)
  }
}

function spawn(cmd, args, opts) {
  return spawnProcess(cmd, args, opts)
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (!opts.silent) {
        if (stdout) process.stdout.write(stdout)
        if (stderr) process.stderr.write(stderr)
      }
      if (err && !opts.ignoreError) reject(err); else resolve({ stdout, stderr })
    })
    if (opts.timeout) {
      setTimeout(() => child.kill(), opts.timeout)
    }
  })
}

// Windows 下执行 .cmd / .bat 需要通过 cmd.exe /c；用 exec 封装
function runShell(cmdline, opts = {}) {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === 'win32'
    const final = isWin ? `cmd.exe /c ${cmdline}` : cmdline
    exec(final, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (!opts.silent) {
        if (stdout) process.stdout.write(stdout)
        if (stderr) process.stderr.write(stderr)
      }
      if (err && !opts.ignoreError) reject(err); else resolve({ stdout: stdout || '', stderr: stderr || '' })
    })
  })
}

// ---------- 0b. 生成 public/ 内容指纹（ASSET_VERSION） ----------
// SEA 运行时靠这个戳判断要不要重新解压前端资源：public 任何文件变化都会改变指纹，
// 下一次构建后 exe 首次启动就会自动重新解压，杜绝「新 exe 带旧前端」的问题。
async function genAssetVersion() {
  const { createHash } = await import('node:crypto')
  const hash = createHash('md5')
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, ent.name)
      const r = rel ? rel + '/' + ent.name : ent.name
      if (ent.isDirectory()) walk(p, r)
      else { hash.update(r); hash.update(fs.readFileSync(p)) }
    }
  }
  walk(path.join(here, 'public'), '')
  if (fs.existsSync(I18N_SOURCE)) walk(I18N_SOURCE, 'vendor/mc-i18n')
  const version = 'pub-' + hash.digest('hex').slice(0, 16)
  const genPath = path.join(here, 'src', 'server', 'asset-version.gen.js')
  const content = `// 由 build.mjs 自动生成：public/ 内容指纹（请勿手改；dev 模式不参与资源解压）\nexport const ASSET_VERSION = ${JSON.stringify(version)}\n`
  const changed = !fs.existsSync(genPath) || fs.readFileSync(genPath, 'utf8') !== content
  fs.writeFileSync(genPath, content)
  console.log(`     ASSET_VERSION = ${version}${changed ? '（已变化，exe 首次启动将重新解压 public）' : '（未变化）'}`)
}

// ---------- main ----------
(async () => {
  const t0 = Date.now()
  try {
    await step0()
    await genAssetVersion()
    const pkg = JSON.parse(await fsp.readFile(path.join(here, 'package.json'), 'utf8'))
    if (pkg.author !== AUTHOR) throw new Error('package.json 作者与运行时作者标识不一致')
    const integrity = { authorHash: sha256(AUTHOR), files: await collectShellHashes(path.join(here, 'public')) }
    await fsp.writeFile(path.join(here, 'src/server/integrity.gen.js'), '// Generated by build.mjs. Embedded in the executable.\nexport const SHELL_INTEGRITY = ' + JSON.stringify(integrity, null, 2) + '\n')
    await step1()
    await step2()
    await step3()
    await step4()
    await step5()
    await step6()
    await step7()
    await step8()
    const stat = await fsp.stat(TARGET_EXE)
    console.log(`\n✓ 构建完成：${path.relative(here, TARGET_EXE)}（${(stat.size / 1024 / 1024).toFixed(1)} MB，${(Date.now() - t0)}ms）`)
    console.log(`\n首次运行会在用户目录创建:`)
    console.log(`  配置     → %USERPROFILE%\\Documents\\MC Toolbox\\config\\       （settings.json / monitors.json …）`)
    console.log(`  mod 库   → %USERPROFILE%\\Documents\\MC Toolbox\\client-mods\\  （clientmods.json）`)
    console.log(`  运行数据 → %LOCALAPPDATA%\\MC Toolbox\\data\\                  （history.json、日志）`)
    console.log(`  前端资源 → %LOCALAPPDATA%\\MC Toolbox\\runtime\\               （解压后的 public）`)
    console.log(`  窗口宿主 → %LOCALAPPDATA%\\MC Toolbox\\runtime\\host\\           （WebView2 无边框窗口）`)
    console.log(`  exe 旁的文件夹已不再生成，目录里只剩这一个 .exe。`)
  } catch (e) {
    console.error('\n✗ 构建失败：', e.message)
    process.exit(1)
  }
})()
