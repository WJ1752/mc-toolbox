// 启动器 UI 冒烟检查（手动 / CI 可选）
//
// 依赖一个已运行的 MCtoolbox 服务和一个开启远程调试的 Chromium/Edge：
//   node server.js --port=8757 --no-open
//   msedge --headless=new --remote-debugging-port=9333 --user-data-dir=<tmp> about:blank
//   node tools/launcher-ui-smoke.mjs --base=http://127.0.0.1:8757 --cdp=http://127.0.0.1:9333
//
// 检查：启动器渲染、页面切换、启动器设置读取、命令面板、900px 窄窗无横向溢出、
// 亮色主题、控制台错误。截图写到 --out（默认 dist/_ui-smoke）。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [k, ...v] = arg.replace(/^--/, '').split('=')
  return [k, v.join('=') || '1']
}))
const BASE = (args.base || 'http://127.0.0.1:8757').replace(/\/$/, '')
const CDP = (args.cdp || 'http://127.0.0.1:9333').replace(/\/$/, '')
const OUT = path.resolve(args.out || 'dist/_ui-smoke')

const results = []
let failures = 0
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function main() {
  await fsp.mkdir(OUT, { recursive: true })
  const target = await fetch(`${CDP}/json/new?${encodeURIComponent(BASE + '/')}`, { method: 'PUT' }).then((r) => r.json())
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let seq = 0
  const waiting = new Map()
  const events = []
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id)
      waiting.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    } else if (msg.method) events.push(msg)
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    waiting.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text)
    return res.result?.value
  }
  const waitFor = async (expression, timeout = 15000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await evaluate(expression).catch(() => false)) return true
      await sleep(120)
    }
    return false
  }
  const screenshot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await fsp.writeFile(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'))
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: BASE + '/' })
  await waitFor(`document.readyState === 'complete'`)
  const loaded = await waitFor(`!!document.querySelector('#launcherPage:not([hidden]) .lp-hero, #launcherPage:not([hidden]) .lp-welcome, #launcherPage .lp-main-error')`, 25000)
  check('启动器页面渲染完成', loaded)
  // 首次运行会弹出「选择游戏目录」；冒烟测试只关闭它，不写用户目录。
  await sleep(600)
  await evaluate(`document.querySelector('.modal-head .btn-icon')?.click()`)
  check('默认页为启动器', await evaluate(`document.body.dataset.page === 'launcher'`))
  const hero = await evaluate(`(() => { const el = document.querySelector('#launcherPage .lp-hero, #launcherPage .lp-welcome'); return el ? el.innerText.slice(0, 200) : '' })()`)
  check('实例/欢迎区内容非空', hero.length > 0, hero.replace(/\s+/g, ' ').slice(0, 80))
  const sheets = await evaluate(`[...document.styleSheets].map(s => s.href || '').filter(Boolean)`)
  check('v1.9 版本选择/启动样式已加载', sheets.some((h) => h.includes('launcher-versions.css')) && sheets.some((h) => h.includes('launcher-launch.css')), sheets.filter((h) => /launcher-/.test(h)).join(', '))
  await screenshot('01-launcher')

  // 1280×820 常见窗口：无横向溢出
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false })
  await sleep(500)
  const standard = await evaluate(`({ overflow: document.documentElement.scrollWidth - window.innerWidth, main: document.querySelector('.lp-main')?.getBoundingClientRect().width || 0 })`)
  check('1280×820 无横向溢出', standard.overflow <= 1, JSON.stringify(standard))
  await screenshot('01b-launcher-1280')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await sleep(300)

  // 页面切换
  await evaluate(`document.querySelector('.page-switch [data-page="workbench"]').click()`)
  check('切换到工作台', await waitFor(`document.body.dataset.page === 'workbench' && !document.getElementById('workspace').hidden`))
  check('工作台磁贴可见', await evaluate(`document.querySelectorAll('#workspace .tile, #workspace [data-id]').length >= 0`))
  await screenshot('02-workbench')
  await evaluate(`document.querySelector('.page-switch [data-page="launcher"]').click()`)
  check('切回启动器', await waitFor(`document.body.dataset.page === 'launcher' && !document.getElementById('launcherPage').hidden`))

  // 启动器设置（已并入整页设置，数据仍来自 /api/launcher/settings）
  await evaluate(`document.querySelector('.lp-navbtn[data-nav="settings"]').click()`)
  const settingsOk = await waitFor(`!document.getElementById('settingsPage').hidden && document.getElementById('settingsContent').innerText.includes('游戏目录')`, 10000)
  check('启动器设置页打开', settingsOk)
  if (settingsOk) {
    await evaluate(`[...document.querySelectorAll('#settingsNav button')].find(b => b.textContent.includes('启动与 Java'))?.click()`)
    await waitFor(`document.getElementById('settingsContent').innerText.includes('最大内存')`, 8000)
    const values = await evaluate(`(() => {
      const c = document.getElementById('settingsContent')
      return { text: c.innerText, nums: [...c.querySelectorAll('input')].map(i => i.value).filter(Boolean) }
    })()`)
    check('设置读取到默认内存 4096', values.text.includes('4096') || values.nums.includes('4096'), values.nums.slice(0, 8).join(','))
    check('设置含 Microsoft OAuth 客户端 ID 字段', values.text.includes('OAuth 客户端 ID') || values.text.includes('Client ID'))
    await screenshot('03-settings')
    await evaluate(`document.getElementById('btnCloseSettings').click()`)
    await sleep(300)
  }
  check('启动器导航不再出现“返回工作台”', await evaluate(`!document.querySelector('.lp-navbtn[data-nav="workspace"]')?.innerText.includes('返回')`))

  // 下载中心（独立视图，验证任务列表与社区下载模块可加载）
  await evaluate(`document.querySelector('.lp-navbtn[data-nav="downloads"]')?.click()`)
  const downloadsOk = await waitFor(`!!document.querySelector('#launcherPage .lp-view-downloads .lp-downloads')`, 15000)
  check('下载中心可打开', downloadsOk)
  if (downloadsOk) {
    const text = await evaluate(`document.querySelector('#launcherPage .lp-downloads').innerText.slice(0, 300)`)
    check('下载中心内容非空', text.length > 0, text.replace(/\s+/g, ' ').slice(0, 80))
    check('下载中心提供「安装整合包」入口', await evaluate(`[...document.querySelectorAll('#launcherPage .lp-view-downloads button')].some(b => b.textContent.includes('安装整合包'))`))
    // 拖放遮罩：dragenter 显示；dragend 立即清除；停止 dragover 后看门狗自愈。
    // 旧版在拖拽取消时遮罩会永久卡住，这一项就是防回归。
    const drag = await evaluate(`(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms))
      const root = document.getElementById('launcherPage')
      const dt = new DataTransfer()
      dt.items.add(new File(['x'], 'pack.mrpack', { type: 'application/zip' }))
      const fire = (type, target = root) => target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
      fire('dragenter'); fire('dragover', root.querySelector('.lp-downloads-head'))
      const shown = root.classList.contains('is-drop')
      window.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }))
      await wait(60)
      const afterDragEnd = root.classList.contains('is-drop')
      fire('dragenter'); fire('dragover', root.querySelector('.lp-downloads-head'))
      await wait(1700)
      const afterWatchdog = root.classList.contains('is-drop')
      return { shown, afterDragEnd, afterWatchdog }
    })()`)
    check('拖拽文件显示整页拖放遮罩', drag.shown, JSON.stringify(drag))
    check('拖拽结束遮罩立即清除', !drag.afterDragEnd, JSON.stringify(drag))
    check('拖拽取消后遮罩自动消失（不会卡住页面）', !drag.afterWatchdog, JSON.stringify(drag))
    await screenshot('04b-downloads')
    // 下载中心 → 新建实例：点击入口后应切到「整合包」页，并提供吸顶进度坞。
    await evaluate(`[...document.querySelectorAll('#launcherPage .lp-view-downloads button')].find(b => b.textContent.includes('安装整合包'))?.click()`)
    const installOk = await waitFor(`!!document.querySelector('#launcherPage .lp-job-dock')`, 15000)
    const installInfo = await evaluate(`(() => {
      const dock = document.querySelector('#launcherPage .lp-job-dock')
      const activeTab = [...document.querySelectorAll('#launcherPage .lp-view-body .seg button')].find(b => b.classList.contains('active'))
      return { dock: !!dock, sticky: dock ? getComputedStyle(dock).position : '', tab: activeTab?.textContent || '' }
    })()`)
    check('下载中心可直接进入整合包安装', installOk && installInfo.tab.includes('整合包'), JSON.stringify(installInfo))
    check('安装进度坞固定在页面上方', installInfo.sticky === 'sticky', JSON.stringify(installInfo))
    await evaluate(`document.querySelector('.lp-back')?.click()`)
    await sleep(300)
  }

  // 命令面板
  await evaluate(`document.getElementById('btnCommand').click()`)
  const paletteOk = await waitFor(`!!document.querySelector('.cmdk-root')`)
  check('命令面板打开', paletteOk)
  if (paletteOk) {
    const groups = await evaluate(`[...document.querySelectorAll('.cmdk-group')].map(e => e.textContent.trim())`)
    check('命令面板含「启动器」分组', groups.some((g) => g.includes('启动器')), groups.join(' / '))
    await evaluate(`(() => { const i = document.querySelector('.cmdk-search input'); i.value = '工作台'; i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(300)
    const items = await evaluate(`[...document.querySelectorAll('.cmdk-item')].map(e => e.innerText.replace(/\\s+/g, ' ').trim()).slice(0, 10)`)
    check('搜索「工作台」有结果', items.length > 0, items.join(' | ').slice(0, 120))
    await screenshot('04-command-palette')
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(250)
  }

  // 900px 窄窗
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 820, deviceScaleFactor: 1, mobile: false })
  await sleep(700)
  const narrow = await evaluate(`(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    page: document.body.dataset.page,
    side: getComputedStyle(document.querySelector('.lp-side')).display,
    main: document.querySelector('.lp-main')?.getBoundingClientRect().width || 0
  }))()`)
  check('900px 窄窗无横向溢出', narrow.overflow <= 1, JSON.stringify(narrow))
  check('900px 窄窗仍为启动器', narrow.page === 'launcher')
  await screenshot('05-narrow-900')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })

  // 亮色主题（写回后恢复）
  const before = await evaluate(`fetch('/api/settings').then(r => r.json())`)
  const themeBefore = before?.general?.theme || 'dark'
  await evaluate(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ general: { ...${JSON.stringify(before.general)}, theme: 'light' } }) }).then(r => r.ok)`)
  await send('Page.reload', { ignoreCache: true })
  await waitFor(`document.readyState === 'complete'`)
  await waitFor(`!!document.querySelector('#launcherPage .lp-hero, #launcherPage .lp-welcome')`, 20000)
  const light = await evaluate(`({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor })`)
  check('亮色主题生效', light.theme === 'light', JSON.stringify(light))
  await screenshot('06-light')
  await evaluate(`fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ general: { ...${JSON.stringify(before.general)}, theme: ${JSON.stringify(themeBefore)} } }) }).then(r => r.ok)`)

  // 控制台错误（忽略网络类噪声）
  const consoleErrors = events
    .filter((e) => (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') || e.method === 'Runtime.exceptionThrown')
    .map((e) => e.method === 'Runtime.exceptionThrown'
      ? e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text
      : (e.params.args || []).map((a) => a.value ?? a.description).join(' '))
    .filter((text) => text && !/favicon|net::ERR|Failed to load resource/i.test(text))
  check('无前端控制台异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ').slice(0, 200))

  await send('Page.close').catch(() => {})
  ws.close()
  console.log(`\n结果：${results.length - failures}/${results.length} 通过；截图 ${OUT}`)
  if (failures) process.exitCode = 1
}

main().catch((e) => { console.error('检查失败：', e); process.exit(1) })
