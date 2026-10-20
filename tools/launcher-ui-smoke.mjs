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
  check('默认页为启动器', await evaluate(`document.body.dataset.page === 'launcher'`))
  const hero = await evaluate(`(() => { const el = document.querySelector('#launcherPage .lp-hero, #launcherPage .lp-welcome'); return el ? el.innerText.slice(0, 200) : '' })()`)
  check('实例/欢迎区内容非空', hero.length > 0, hero.replace(/\s+/g, ' ').slice(0, 80))
  await screenshot('01-launcher')

  // 页面切换
  await evaluate(`document.querySelector('.page-switch [data-page="workbench"]').click()`)
  check('切换到工作台', await waitFor(`document.body.dataset.page === 'workbench' && !document.getElementById('workspace').hidden`))
  check('工作台磁贴可见', await evaluate(`document.querySelectorAll('#workspace .tile, #workspace [data-id]').length >= 0`))
  await screenshot('02-workbench')
  await evaluate(`document.querySelector('.page-switch [data-page="launcher"]').click()`)
  check('切回启动器', await waitFor(`document.body.dataset.page === 'launcher' && !document.getElementById('launcherPage').hidden`))

  // 启动器设置读取
  await evaluate(`document.querySelector('.lp-navbtn[data-nav="settings"]').click()`)
  const modalOk = await waitFor(`[...document.querySelectorAll('.modal')].some(m => m.innerText.includes('启动器设置'))`, 10000)
  check('启动器设置弹窗打开', modalOk)
  if (modalOk) {
    const values = await evaluate(`(() => {
      const m = [...document.querySelectorAll('.modal')].find(x => x.innerText.includes('启动器设置'))
      const nums = [...m.querySelectorAll('input')].map(i => i.value).filter(Boolean)
      return { text: m.innerText, nums }
    })()`)
    check('设置读取到默认内存 4096', values.text.includes('4096') || values.nums.includes('4096'), values.nums.slice(0, 8).join(','))
    check('设置含 Microsoft OAuth 客户端 ID 字段', values.text.includes('OAuth 客户端 ID') || values.text.includes('Client ID'))
    await screenshot('03-settings')
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(300)
  }

  // 下载中心（独立视图，验证任务列表与社区下载模块可加载）
  await evaluate(`document.querySelector('.lp-navbtn[data-nav="downloads"]')?.click()`)
  const downloadsOk = await waitFor(`!!document.querySelector('#launcherPage .lp-view-downloads')`, 15000)
  check('下载中心可打开', downloadsOk)
  if (downloadsOk) {
    const text = await evaluate(`document.querySelector('#launcherPage .lp-view-downloads').innerText.slice(0, 300)`)
    check('下载中心内容非空', text.length > 0, text.replace(/\s+/g, ' ').slice(0, 80))
    await screenshot('04b-downloads')
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
