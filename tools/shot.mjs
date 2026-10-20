// Dev-only screenshot helper: drives headless Edge over CDP without deps.
// usage: node tools/shot.mjs --url http://127.0.0.1:8757 --out docs/screenshots/x.png [--width 1440] [--height 900] [--delay 1200] [--eval "js"] [--full]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const args = process.argv.slice(2)
function arg(name, def = '') {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : def
}
const url = arg('url', 'http://127.0.0.1:8757')
const out = arg('out', 'docs/screenshots/shot.png')
const width = Number(arg('width', '1440'))
const height = Number(arg('height', '900'))
const delay = Number(arg('delay', '1400'))
const evalJs = arg('eval', '')
const full = args.includes('--full')
const keep = args.includes('--keep')
const port = 9222 + Math.floor(Math.random() * 400)

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-shot-'))
const edge = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--hide-scrollbars',
  `--window-size=${width},${height}`,
  '--force-device-scale-factor=1',
  'about:blank'
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(u, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(u)
      if (r.ok) return await r.json()
    } catch {}
    await sleep(150)
  }
  throw new Error('CDP not reachable: ' + u)
}

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.events = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      } else if (msg.method) {
        this.events.push(msg)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error('CDP timeout: ' + method))
        }
      }, 30000)
    })
  }
}

let code = 0
try {
  const ver = await getJson(`http://127.0.0.1:${port}/json/version`)
  const ws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
    setTimeout(() => rej(new Error('ws timeout')), 10000)
  })
  const browser = new CDP(ws)
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  const send = async (method, params = {}) => {
    const id = ++browser.id
    return new Promise((resolve, reject) => {
      browser.pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params, sessionId }))
      setTimeout(() => {
        if (browser.pending.has(id)) {
          browser.pending.delete(id)
          reject(new Error('CDP timeout: ' + method))
        }
      }, 30000)
    })
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Network.enable')
  const block = arg('block', '')
  if (block) {
    await send('Network.setBlockedURLs', { urls: block.split(',') })
    await send('Network.setCacheDisabled', { cacheDisabled: true })
  }
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url })
  await sleep(900)
  // Headless teardown must not tell the real dev server to shut down.
  await send('Runtime.evaluate', { expression: "navigator.sendBeacon = () => true; 'beacon-patched'" }).catch(() => {})
  if (evalJs) {
    const r = await send('Runtime.evaluate', { expression: evalJs, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) console.error('EVAL ERROR:', r.exceptionDetails.text, r.exceptionDetails.exception?.description)
    else if (r.result?.value !== undefined) console.log('EVAL:', JSON.stringify(r.result.value))
  }
  await sleep(delay)
  const errors = []
  for (const ev of browser.events) {
    if (ev.method === 'Runtime.exceptionThrown') {
      errors.push(ev.params.exceptionDetails?.exception?.description || ev.params.exceptionDetails?.text)
    } else if (ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error') {
      errors.push(ev.params.entry.text)
    } else if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
      errors.push(ev.params.args.map((a) => a.value ?? a.description).join(' '))
    }
  }
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full })
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('saved', out, fs.statSync(out).size + 'B')
  if (errors.length) {
    console.log('PAGE ERRORS:')
    for (const e of [...new Set(errors)]) console.log(' -', e)
    code = 2
  }
  if (!keep) {
    await browser.send('Target.closeTarget', { targetId }).catch(() => {})
    ws.close()
  }
} catch (e) {
  console.error('SHOT FAILED:', e.message)
  code = 1
} finally {
  edge.kill()
  setTimeout(() => {
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
    process.exit(code)
  }, 500)
}
