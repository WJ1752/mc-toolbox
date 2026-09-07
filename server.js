import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ROOT, PUBLIC_DIR, DATA_DIR, CLIENT_MODS_DIR, CONFIG_DIR, HOST_EXE, init, isSEA } from './src/server/paths.js'
import { requestHandler, clientHeartbeat } from './src/server/api.js'
import { startEngine, stopEngine, persistHistory } from './src/server/monitor.js'
import { store } from './src/server/store.js'
import { DEFAULT_SETTINGS } from './src/server/defaults.js'

const argPort = (process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]
const START_PORT = Number(process.env.MC_TOOLBOX_PORT || argPort || 8756)
const NO_OPEN = process.argv.includes('--no-open') || process.argv.includes('--no-app')

let appWindowLaunched = false

// Windows SEA 模式下默认隐藏控制台窗口，避免双击 exe 时同时弹出黑框
// 加 --console 可强制保留控制台（调试用）。
// 构建产物已是 GUI 子系统（PE subsystem=2），本身不会出现控制台窗口，
// 这时直接跳过 PowerShell 调用（省一次子进程冷启动，加快出窗口）。
function exeIsGuiSubsystem() {
  try {
    const head = Buffer.alloc(0x1000)
    const fd = fs.openSync(process.execPath, 'r')
    fs.readSync(fd, head, 0, head.length, 0)
    fs.closeSync(fd)
    const pe = head.readUInt32LE(0x3c)
    if (head.toString('ascii', pe, pe + 4) !== 'PE\0\0') return false
    const opt = pe + 4 + 20
    const magic = head.readUInt16LE(opt)
    if (magic !== 0x10b && magic !== 0x20b) return false
    return head.readUInt16LE(opt + 0x44) === 2
  } catch { return false }
}
async function hideConsoleIfNeeded() {
  if (process.platform !== 'win32') return
  if (!isSEA) return
  if (process.argv.includes('--console')) return
  if (exeIsGuiSubsystem()) return // GUI 子系统：本来就没有控制台黑框
  try {
    const ps = `Add-Type -Name Win -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' -Namespace ConsoleUtil; Start-Sleep -Milliseconds 600; [ConsoleUtil.Win]::ShowWindow([ConsoleUtil.Win]::GetConsoleWindow(), 0)`
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      stdio: 'ignore',
      windowsHide: true,
      detached: true
    })
    child.on('error', () => {})
    child.unref()
  } catch {}
}

// 在常见位置查找 Edge / Chrome（用于 --app= 模式启动无浏览器窗口）
function findAppLauncher() {
  if (process.platform === 'win32') {
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    const list = [
      path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ]
    for (const p of list) { try { if (fs.existsSync(p)) return p } catch {} }
  } else if (process.platform === 'darwin') {
    const list = [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ]
    for (const p of list) { try { if (fs.existsSync(p)) return p } catch {} }
  } else {
    const list = ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium']
    for (const p of list) { try { if (fs.existsSync(p)) return p } catch {} }
  }
  return null
}

// 启动失败兜底：写错误文件 + 弹消息框（GUI subsystem 下看不到 console）
async function fatal(label, err) {
  const msg = `[${new Date().toISOString()}] [FATAL ${label}] ${err?.stack || err?.message || err}\n`
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(path.join(DATA_DIR, 'startup-error.log'), msg)
  } catch {}
  try { console.error(msg.trim()) } catch {}
  if (isSEA && process.platform === 'win32') {
    try {
      const e = String((err?.message || err) || label).replace(/['"\[\]]/g, ' ')
      const ps = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${label}: ${e}', 'MC Toolbox 启动失败', 'OK', 'Error') > $null`
      spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    } catch {}
  }
}

async function main() {
  // SEA 模式下先隐藏控制台窗口（再解压/监听，避免黑框一闪而过）
  await hideConsoleIfNeeded()

  // SEA 模式：解压内嵌 public 资源（必须先于扫描 features / 监听端口）
  try { await init() } catch (e) { await fatal('init', e); process.exit(1) }

  for (const dir of [DATA_DIR, CONFIG_DIR, CLIENT_MODS_DIR]) {
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }

  // 预热存储（首次运行写入默认配置）
  store.get('settings', DEFAULT_SETTINGS)

  // 一次性迁移：v1 → v2（监测引擎默认改为不自动启动）；v2 → v3（默认处理方式改为「禁用（改后缀名）」）
  {
    const s = store.get('settings', DEFAULT_SETTINGS)
    let migrated = false
    if ((s.version || 1) < 2) {
      if (s.monitor && s.monitor.autoStart === true) s.monitor.autoStart = false
      migrated = true
      console.log('[迁移] 设置已升级到 v2：监测引擎默认不自动启动')
    }
    if ((s.version || 1) < 3) {
      if (s.client2server && s.client2server.defaultAction === 'backup') {
        s.client2server.defaultAction = 'disable'
        console.log('[迁移] 设置已升级到 v3：默认处理方式改为「禁用（改后缀名）」')
      }
      migrated = true
    }
    if (migrated) {
      s.version = 3
      store.set('settings', s)
    }
    // 「账号与启动」功能已移除：清掉旧版残留的 launcher 设置段
    if (s.launcher) {
      delete s.launcher
      store.set('settings', s)
      console.log('[迁移] 已移除「账号与启动」残留设置（launcher）')
    }
  }

  startEngine()

  const server = http.createServer((req, res) => {
    requestHandler(req, res).catch((e) => {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('500 ' + e.message)
    })
  })

  function listen(port) {
    server.once('error', async (err) => {
      await fatal('listen', err)
      if (err.code === 'EADDRINUSE') {
        try {
          console.error('')
          console.error(`  [错误] 端口 ${port} 已被占用`)
          console.error('         可能 Minecraft 工具箱已经在运行。')
          console.error('         请检查任务栏/任务管理器中的旧窗口，关闭后再试。')
          console.error(`         如需多开，请加上 --port=其他端口号`)
          console.error('')
        } catch {}
      } else {
        try { console.error('启动失败：', err.message) } catch {}
      }
      process.exit(1)
    })
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}`
      console.log('')
      console.log('  Minecraft 工具箱已启动')
      console.log('  ------------------------')
      console.log(`  本地地址: ${url}`)
      console.log(`  配置目录: ${CONFIG_DIR}`)
      if (isSEA) console.log(`  mod 库:  ${CLIENT_MODS_DIR}（方便分享/编辑）`)
      console.log(`  运行数据: ${DATA_DIR}`)
      console.log(`  功能目录: ${path.join(PUBLIC_DIR, 'features')}`)
      console.log('')
      if (!NO_OPEN) launchAppWindow(url)
      else console.log('  (已设置 --no-open，应用窗口未自动启动)')
      console.log('')
      console.log('  关闭应用窗口或按 Ctrl+C 即可停止服务')
      console.log('')
    })
  }

  let shuttingDown = false
  let appWindowChild = null
  let edgeLaunched = false

  // 打开应用窗口。
  // SEA 模式优先使用内嵌的 WebView2 无边框宿主（没有系统标题栏，观感最干净）；
  // 宿主缺失 / 运行时不可用 / 启动失败时自动回退到 Edge --app 窗口。
  function launchAppWindow(url) {
    if (appWindowLaunched) return
    appWindowLaunched = true
    // 单一窗口看门狗（只启一次；心跳/关窗/超时逻辑见 startWindowWatchdog）
    startWindowWatchdog(url)

    if (fs.existsSync(HOST_EXE) && spawnHostWindow(url)) return
    launchEdgeWindow(url)
  }

  function spawnHostWindow(url) {
    const hostUrl = url + '?host=webview2'
    let child
    try {
      child = spawn(HOST_EXE, [hostUrl], { stdio: 'ignore', windowsHide: false, detached: false })
    } catch (e) {
      console.log('  [提示] 启动 WebView2 宿主失败：' + e.message + '，回退到 Edge…')
      return false
    }
    appWindowChild = child
    const t0 = Date.now()
    console.log('  [应用窗口] 使用 WebView2 无边框窗口打开（无系统标题栏）')
    console.log('  [应用窗口] 关闭该窗口将自动停止服务')
    child.on('error', () => {
      // spawn 层面失败 → 回退
      if (!shuttingDown && !edgeLaunched) {
        console.log('  [提示] WebView2 宿主启动失败，回退到 Edge…')
        launchEdgeWindow(url)
      }
    })
    child.on('exit', (code) => {
      appWindowChild = null
      if (shuttingDown) return
      // code 3 = WebView2 运行时缺失/初始化失败；启动早期非 0 退出同样回退
      const earlyFail = code === 3 || (code !== 0 && Date.now() - t0 < 10000)
      if (earlyFail && !edgeLaunched) {
        console.log(`  [提示] WebView2 宿主启动失败（exit=${code}），回退到 Edge 窗口…`)
        launchEdgeWindow(url)
      }
      // code 0 说明用户正常关窗：宿主已 POST /api/shutdown，心跳看门狗会结束服务
    })
    return true
  }

  function launchEdgeWindow(url) {
    if (edgeLaunched) return
    edgeLaunched = true
    const exe = findAppLauncher()
    if (!exe) {
      console.log('  [提示] 未检测到 Microsoft Edge / Google Chrome，也未找到 WebView2 宿主')
      console.log('         请手动打开浏览器访问：' + url)
      return
    }
    const name = path.basename(exe)
    const args = [
      '--app=' + url,
      '--new-window',
      '--disable-features=TranslateUI,InfiniteSessionRestore',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,820'
    ]
    try {
      appWindowChild = spawn(exe, args, { stdio: 'ignore', windowsHide: false, detached: false })
    } catch (e) {
      console.log('  [提示] 启动应用窗口失败：' + e.message)
      console.log('         请手动打开浏览器访问：' + url)
      return
    }
    console.log(`  [应用窗口] 使用 ${name} 在「无标签栏窗口」模式打开`)

    // ⚠️ 关键：不要监听 child 的 exit/close 来关闭服务！
    // Edge/Chrome 是多进程架构：spawn 出来的 msedge.exe 会把 URL 转交给已存在的
    // 主进程后立刻自行退出（exit code=0），此时应用窗口其实还开着。
    // 若据此关服务，就会出现「窗口在、后端死、页面全部 failed to fetch」。
    // 正确做法：靠前端心跳判断窗口是否真的还在（见 startWindowWatchdog）。
    appWindowChild.on('error', () => {})
  }

  // 窗口存活看门狗：基于前端心跳判断应用窗口是否还开着
  //  - 前端每 10s POST /api/heartbeat
  //  - 前端关窗时 beforeunload → POST /api/shutdown（sendBeacon）
  //  - 久未收到心跳 → 判定窗口已关，停服务
  function startWindowWatchdog(url) {
    const startedAt = Date.now()
    let fallbackTried = false
    const HB_TIMEOUT = 40000   // 40s 无心跳 → 窗口已关（前端 10s 一跳，容忍 4 次丢失）
    const FIRST_WAIT = 20000   // 20s 还没心跳 → 页面没打开，改用默认浏览器

    const timer = setInterval(() => {
      if (shuttingDown) { clearInterval(timer); return }
      const now = Date.now()

      // 1) 前端主动请求停止（关窗 / 页面卸载）
      if (clientHeartbeat.shutdown) {
        clearInterval(timer)
        console.log('')
        console.log('  [关闭] 应用窗口已关闭（前端通知），正在退出服务…')
        shutdown()
        return
      }

      // 2) 曾经连上过，但超时没心跳 → 窗口关了
      if (clientHeartbeat.last > 0 && now - clientHeartbeat.last > HB_TIMEOUT) {
        clearInterval(timer)
        console.log('')
        console.log(`  [关闭] ${HB_TIMEOUT / 1000} 秒未收到页面心跳，判定窗口已关闭，正在退出服务…`)
        shutdown()
        return
      }

      // 3) 一直连不上 → 改用系统默认浏览器再给一次机会
      if (clientHeartbeat.last === 0 && !fallbackTried && now - startedAt > FIRST_WAIT) {
        fallbackTried = true
        console.log(`  [提示] ${FIRST_WAIT / 1000} 秒内页面未连上，改用系统默认浏览器打开…`)
        try {
          if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
          else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
          else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
        } catch {}
      }
    }, 3000)
    timer.unref?.()
  }

  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    // 注意：不要 kill 浏览器进程 —— 用户可能还有其他 Edge 窗口在跑
    try { stopEngine() } catch {}
    try { await store.flushAll() } catch {}
    forceQuit('shutdown-ok')
  }

  function forceQuit(reason) {
    if (process._forceQuitDone) return
    process._forceQuitDone = true
    try { console.log(`  [退出] process.exit(${reason})`) } catch {}
    process.exit(0)
  }

  process.on('SIGINT',  () => forceQuit('SIGINT'))
  process.on('SIGTERM', () => forceQuit('SIGTERM'))
  process.on('SIGHUP',  () => forceQuit('SIGHUP'))
  process.on('beforeExit', () => persistHistory(true))

  listen(START_PORT)
}

main().catch(async (e) => {
  try { await fatal('main', e) } catch {}
  process.exit(1)
})
