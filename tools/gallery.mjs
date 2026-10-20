// Dev-only screenshot gallery: a single headless Edge session captures the
// workspaces, all eight expanded tiles, and the ten settings sections for one
// theme. Zero dependencies — speaks CDP over WebSocket.
// usage: node tools/gallery.mjs --url http://127.0.0.1:8757 --theme dark
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const args = process.argv.slice(2)
const arg = (name, def = '') => {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : def
}
const url = arg('url', 'http://127.0.0.1:8757')
const theme = arg('theme', 'dark') // dark | light
const outdir = arg('outdir', `docs/screenshots/${theme}`)
const width = Number(arg('width', '1440'))
const height = Number(arg('height', '900'))
const port = 9800 + Math.floor(Math.random() * 300)
fs.mkdirSync(outdir, { recursive: true })

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-gallery-'))
const edge = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  `--window-size=${width},${height}`, '--force-device-scale-factor=1', 'about:blank'
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function json(u, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(u); if (r.ok) return await r.json() } catch {}
    await sleep(150)
  }
  throw new Error('CDP not reachable')
}

let ws
let seq = 0
const pending = new Map()
let sessionId = ''
const errors = []

function send(method, params = {}, session = sessionId) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, sessionId: session }))
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)) }
    }, 40000)
  })
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result?.value
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(outdir, name + '.png')
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('  ·', file)
}

async function reload(wait = 1800) {
  await send('Page.reload', { ignoreCache: false })
  await sleep(wait)
  await send('Runtime.evaluate', { expression: "navigator.sendBeacon = () => true; 'beacon-patched'" }).catch(() => {})
}

async function apiJson(expr) {
  return evaluate(`(async () => { ${expr} })()`)
}

const FEATURES = [
  ['server-status', '服务器在线测试'],
  ['latency-monitor', '服务器延迟监测'],
  ['client2server', '客户端转服务端'],
  ['community-download', '社区资源下载'],
  ['server-core', '服务端核心下载'],
  ['i18n', '整合包翻译'],
  ['save-editor', '存档编辑器'],
  ['server-manager', '开服管理']
]

const SECTIONS = ['general', 'network', 'monitor', 'c2s', 'community', 'servercore', 'i18n', 'features', 'data', 'about']

let code = 0
try {
  const ver = await json(`http://127.0.0.1:${port}/json/version`)
  ws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
    setTimeout(() => rej(new Error('ws timeout')), 10000)
  })
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text)
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '))
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(msg.params.entry.text)
    }
  })

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, '')
  const attached = await send('Target.attachToTarget', { targetId, flatten: true }, '')
  sessionId = attached.sessionId
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url })
  await sleep(2200)
  // Keep the dev server alive when the headless window closes.
  await send('Runtime.evaluate', { expression: "navigator.sendBeacon = () => true; 'beacon-patched'" }).catch(() => {})

  const original = await apiJson(`
    const s = await (await fetch('/api/settings')).json()
    const f = await (await fetch('/api/features')).json()
    return { settings: s, visible: f.items.filter(x => x.visible).map(x => x.id), features: f.items.map(x => ({ id: x.id, enabled: x.enabled, visible: x.visible })) }
  `)
  console.log('original layout:', original.settings.layout?.length || 0, 'visible:', original.visible.length)

  // theme + all-collapsed layout
  const accent = theme === 'light' ? '#a3602f' : '#c07a4a'
  const layout = original.features.map((f, i) => ({
    id: f.id,
    w: 1,
    h: 1,
    collapsed: true
  }))
  await apiJson(`
    await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ general: { theme: '${theme}', accent: '${accent}' }, layout: ${JSON.stringify(layout)} }) })
    const f = await (await fetch('/api/features')).json()
    for (const x of f.items) await fetch('/api/features/' + x.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, visible: true }) })
    return true
  `)
  await reload(2200)

  // ensure tiles all collapsed
  await evaluate(`(() => { for (const t of document.querySelectorAll('.tile')) { if (!t.classList.contains('collapsed')) t.querySelector('.tile-head').click() } })()`)
  await sleep(500)
  await shot('01-workspace-collapsed')

  // expanded feature shots
  let i = 2
  for (const [id, name] of FEATURES) {
    const ok = await evaluate(`(() => {
      const t = document.querySelector('[data-id="${id}"]')
      if (!t) return false
      if (t.classList.contains('collapsed')) t.querySelector('.tile-head').click()
      t.scrollIntoView({ block: 'start', behavior: 'instant' })
      return true
    })()`)
    if (!ok) { console.log('  ! missing tile', id); continue }
    await sleep(id === 'server-manager' || id === 'server-core' ? 2600 : 1800)
    await shot(`${String(i).padStart(2, '0')}-${id}`)
    await evaluate(`(() => { const t = document.querySelector('[data-id="${id}"]'); const h = t.querySelector('.tile-head'); if (!t.classList.contains('collapsed')) h.click(); window.scrollTo(0,0); document.getElementById('workspace').scrollTop = 0 })()`)
    await sleep(400)
    i++
  }

  // settings sections
  await evaluate(`document.getElementById('btnSettings').click()`)
  await sleep(600)
  let j = 10
  for (const sec of SECTIONS) {
    await evaluate(`document.querySelector('.settings-nav button[data-section="${sec}"]').click()`)
    await sleep(sec === 'data' || sec === 'features' || sec === 'about' ? 1100 : 500)
    await shot(`${j}-settings-${sec}`)
    j++
  }
  // close settings
  await evaluate(`document.getElementById('btnCloseSettings').click()`)
  await sleep(500)

  // command palette + task drawer + add tile
  await evaluate(`document.getElementById('btnCommand').click()`)
  await sleep(500)
  await shot('20-command-palette')
  await evaluate(`document.getElementById('cmdkBackdrop').click()`)
  await evaluate(`document.getElementById('sbTasks').click()`)
  await sleep(700)
  await shot('21-task-drawer')
  await evaluate(`document.getElementById('drawerClose').click()`)
  await sleep(300)
  await evaluate(`document.getElementById('btnAddTile').click()`)
  await sleep(600)
  await shot('22-add-tile')
  await evaluate(`document.getElementById('modalClose').click()`)
  await sleep(300)

  // empty workspace
  await apiJson(`
    const f = await (await fetch('/api/features')).json()
    for (const x of f.items) await fetch('/api/features/' + x.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visible: false }) })
    return true
  `)
  await reload(1800)
  await shot('23-empty-workspace')

  // restore original state
  await apiJson(`
    await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ general: { theme: '${original.settings.general.theme}', accent: '${original.settings.general.accent}' }, layout: ${JSON.stringify(original.settings.layout || [])} }) })
    for (const x of ${JSON.stringify(original.features)}) {
      await fetch('/api/features/' + x.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: x.enabled, visible: x.visible }) })
    }
    return true
  `)
  await reload(1600)
  console.log('restored original settings:', JSON.stringify({ theme: original.settings.general.theme, visible: original.visible.length }))

  const uniq = [...new Set(errors.filter(Boolean))]
  if (uniq.length) {
    console.log('PAGE ERRORS:')
    for (const e of uniq) console.log(' -', e)
    code = 2
  }
  console.log('done', theme)
} catch (e) {
  console.error('GALLERY FAILED:', e.message)
  code = 1
} finally {
  try { ws?.close() } catch {}
  edge.kill()
  setTimeout(() => {
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
    process.exit(code)
  }, 600)
}
