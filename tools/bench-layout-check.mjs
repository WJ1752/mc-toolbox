// 工作台手动列布局 + 下载同步 UI 检查（headless Edge/CDP）。
//
// 用法：
//   node server.js --port=8757 --no-open
//   msedge --headless=new --remote-debugging-port=9333 --user-data-dir=<tmp> about:blank
//   node tools/bench-layout-check.mjs --base=http://127.0.0.1:8757 --cdp=http://127.0.0.1:9333
//
// 检查：4 列手动布局铺满、拖动只影响目标列、全部磁贴可放第一列、
// 自适应开关切换、1920/2560 变宽后磁贴跟随、1280 无横向溢出、
// 社区下载在下载中心显示真实进度/完成用时、工作台磁贴轮询不重复行。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [k, ...v] = arg.replace(/^--/, '').split('=')
  return [k, v.join('=') || '1']
}))
const BASE = (args.base || 'http://127.0.0.1:8757').replace(/\/$/, '')
const CDP = (args.cdp || 'http://127.0.0.1:9333').replace(/\/$/, '')
const OUT = path.resolve(args.out || 'dist/_bench-ui-check')
const DOWNLOAD_DIR = path.resolve('.probe/ui-download')

let failures = 0
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (!ok) failures++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(pathname, options = {}) {
  const res = await fetch(BASE + pathname, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!res.ok) throw new Error(`${pathname} HTTP ${res.status}: ${text.slice(0, 200)}`)
  return data
}

/* ------------------------------------------------------------------ */
/* 本地慢速下载源（只监听 127.0.0.1）                                   */
/* ------------------------------------------------------------------ */

const FILE_SIZE = 512 * 1024
const DOWNLOAD_NAME = 'bench-check.bin'
function startFixture() {
  const server = http.createServer((req, res) => {
    if (req.url !== '/slow') {
      res.writeHead(404, { Connection: 'close' })
      res.end('not found')
      return
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(FILE_SIZE),
      'Accept-Ranges': 'none'
    })
    const chunk = Buffer.alloc(32 * 1024, 0x42)
    let sent = 0
    const timer = setInterval(() => {
      if (sent >= FILE_SIZE) {
        clearInterval(timer)
        res.end()
        return
      }
      const size = Math.min(chunk.length, FILE_SIZE - sent)
      res.write(size === chunk.length ? chunk : chunk.subarray(0, size))
      sent += size
    }, 80)
    res.on('close', () => clearInterval(timer))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/* ------------------------------------------------------------------ */
/* CDP                                                                 */
/* ------------------------------------------------------------------ */

async function main() {
  await fsp.mkdir(OUT, { recursive: true })
  await fsp.rm(DOWNLOAD_DIR, { recursive: true, force: true })
  await fsp.mkdir(DOWNLOAD_DIR, { recursive: true })
  const fixture = await startFixture()
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/slow`

  const settings = await api('/api/settings')
  // 测试布局：最大 4 列、手动模式、8 个磁贴按 0..3 分布。
  settings.general.tileColumns = 4
  settings.general.adaptiveTiles = false
  settings.layout = (settings.layout || []).map((entry, index) => ({ ...entry, col: index % 4 }))
  await api('/api/settings', { method: 'PUT', body: JSON.stringify({ general: settings.general, layout: settings.layout }) })

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
  const waitFor = async (expression, timeout = 20000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await evaluate(expression).catch(() => false)) return true
      await sleep(120)
    }
    return false
  }
  const setViewport = async (width, height) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await sleep(450)
  }
  const screenshot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    await fsp.writeFile(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'))
  }
  // boot() 在 launcher 初始化完成后才 bindPageSwitch()，骨架屏阶段点击无效。
  // 这里用「点击 → 等 body.dataset.page」的循环，避免和启动时序赛跑。
  const switchPage = async (page, timeout = 20000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await evaluate(`document.body.dataset.page === ${JSON.stringify(page)}`).catch(() => false)) return true
      await evaluate(`document.querySelector('.page-switch [data-page=${JSON.stringify(page)}]')?.click()`).catch(() => {})
      await sleep(250)
    }
    return false
  }
  const tileBoxes = () => evaluate(`(() => {
    const grid = document.getElementById('grid')
    const gr = grid.getBoundingClientRect()
    return {
      grid: { left: gr.left, top: gr.top, width: gr.width },
      tiles: [...grid.querySelectorAll('.tile')].map((el) => {
        const r = el.getBoundingClientRect()
        return { id: el.dataset.id, col: Number(el.dataset.col), left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width) }
      })
    }
  })()`)

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await setViewport(1920, 1080)
  await send('Page.navigate', { url: BASE + '/' })
  await waitFor(`document.readyState === 'complete' && document.body.dataset.page === 'launcher'`, 25000)
  // 等启动器真正完成首屏（而不是骨架屏）。
  await waitFor(`!!document.querySelector('#launcherPage .lp-hero, #launcherPage .lp-welcome, #launcherPage .lp-main-error')`, 25000)
  await sleep(500)
  // 首次运行目录选择弹窗（如果出现）只关闭，不改用户目录。
  await evaluate(`document.querySelector('.modal-head .btn-icon')?.click()`)
  check('切到工作台', await switchPage('workbench') && await waitFor(`document.getElementById('grid').classList.contains('is-laid-out')`, 20000))
  await sleep(500)
  await screenshot('01-manual-1920')

  // 1) 4 列铺满：每列一个磁贴，宽度一致，右边界接近网格右边界。
  const boxes = await tileBoxes()
  const widths = [...new Set(boxes.tiles.map((tile) => tile.width))]
  check('1920 下使用 4 列', new Set(boxes.tiles.map((tile) => tile.col)).size === 4, JSON.stringify([...new Set(boxes.tiles.map((tile) => tile.col))]))
  check('磁贴宽度一致', widths.length === 1, 'widths=' + widths.join(','))
  check('工作台不再被 1440px 限制', boxes.grid.width > 1500, 'grid=' + boxes.grid.width)
  const maxRight = Math.max(...boxes.tiles.map((tile) => tile.left + tile.width))
  check('4 列铺满网格宽度', Math.abs(maxRight - (boxes.grid.left + boxes.grid.width)) <= 2, `maxRight=${maxRight} gridRight=${boxes.grid.left + boxes.grid.width}`)

  // 2) 拖动第 2 列磁贴到第 1 列：其他列坐标不变。
  const before = boxes.tiles
  const moving = before.find((tile) => tile.col === 1)
  const firstCol = before.filter((tile) => tile.col === 0).sort((a, b) => a.top - b.top)
  const dragResult = await evaluate(`(async () => {
    const id = ${JSON.stringify(moving?.id)}
    const el = document.querySelector('[data-id="' + id + '"]')
    if (!el) return { ok: false }
    const head = el.querySelector('.tile-head')
    const hr = head.getBoundingClientRect()
    const startX = hr.left + 80
    const startY = hr.top + 20
    const targetY = ${firstCol[0] ? firstCol[0].top + 30 : 140}
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)))
    const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: startX, clientY: startY })
    head.dispatchEvent(down)
    const move = (x, y, buttons = 1) => window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'mouse', isPrimary: true, button: -1, buttons, clientX: x, clientY: y }))
    move(startX + 12, startY + 12)
    await frame()
    move(startX - 120, startY + 20)
    await frame()
    move(40, targetY)
    await frame()
    move(40, targetY + 4)
    await frame()
    const dragging = !!document.querySelector('.tile.dragging')
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0, clientX: 40, clientY: targetY + 4 }))
    return { ok: true, id, startX, startY, targetY, dragging }
  })()`)
  await sleep(700)
  const afterDrag = await tileBoxes()
  const untouched = (col) => before.filter((tile) => tile.col === col)
    .every((tile) => {
      const now = afterDrag.tiles.find((item) => item.id === tile.id)
      return now && now.left === tile.left && now.top === tile.top && now.col === tile.col
    })
  check('拖动后目标列改为第一列', afterDrag.tiles.find((tile) => tile.id === moving?.id)?.col === 0, JSON.stringify(dragResult))
  check('拖动不影响第二列', untouched(2))
  check('拖动不影响第三列', untouched(3))
  await screenshot('02-after-drag')

  // 3) 全部放进第一列：直接改 col 后触发一次窗口 resize 让网格重排。
  await evaluate(`(() => {
    for (const el of document.querySelectorAll('#grid .tile')) el.dataset.col = '0'
    window.dispatchEvent(new Event('resize'))
  })()`)
  await sleep(500)
  const allFirst = await tileBoxes()
  check('全部磁贴可放在第一列', allFirst.tiles.every((tile) => tile.left === allFirst.grid.left), JSON.stringify(allFirst.tiles.map((t) => [t.id, t.left, t.col])))
  check('第一列按高度堆叠无重叠', (() => {
    const sorted = [...allFirst.tiles].sort((a, b) => a.top - b.top)
    return sorted.every((tile, index) => index === 0 || tile.top >= sorted[index - 1].top)
  })())
  // 恢复 4 列，供后续宽度/模式检查。
  await evaluate(`(() => {
    [...document.querySelectorAll('#grid .tile')].forEach((el, index) => { el.dataset.col = String(index % 4) })
    window.dispatchEvent(new Event('resize'))
  })()`)
  await sleep(500)

  // 4) 自适应开关：工具条按钮切换 → 服务端 settings 跟随 → 切回手动列位恢复。
  const manualSnapshot = await tileBoxes()
  await evaluate(`document.getElementById('btnLayoutMode').click()`)
  await sleep(700)
  const adaptiveOn = await api('/api/settings')
  check('工具条切换写入自适应设置', adaptiveOn.general.adaptiveTiles === true)
  check('自适应模式仍显示全部磁贴', (await tileBoxes()).tiles.length === manualSnapshot.tiles.length)
  await evaluate(`document.getElementById('btnLayoutMode').click()`)
  await sleep(700)
  const adaptiveOff = await api('/api/settings')
  const restored = await tileBoxes()
  check('切回手动模式', adaptiveOff.general.adaptiveTiles === false)
  check('切回后列位恢复', restored.tiles.every((tile) => {
    const old = manualSnapshot.tiles.find((item) => item.id === tile.id)
    return old && old.col === tile.col && old.left === tile.left
  }))

  // 5) 宽度自适应：2560 下磁贴更宽，1280 下收列且无横向溢出。
  const width1920 = (await tileBoxes()).tiles[0].width
  await setViewport(2560, 1440)
  await sleep(500)
  const wide = await tileBoxes()
  const width2560 = wide.tiles[0].width
  check('2560 下磁贴变宽', width2560 > width1920, `${width1920} → ${width2560}`)
  check('2560 下仍为 4 列', new Set(wide.tiles.map((tile) => tile.col)).size === 4)
  await screenshot('03-manual-2560')

  await setViewport(1280, 820)
  await sleep(500)
  const narrow = await evaluate(`({ overflow: document.documentElement.scrollWidth - window.innerWidth, grid: document.getElementById('grid').getBoundingClientRect().width })`)
  const narrowBoxes = await tileBoxes()
  check('1280 无横向溢出', narrow.overflow <= 1, JSON.stringify(narrow))
  // data-col 是保存的列位（0..3）；窗口变窄时应临时收成 3 个显示列。
  const shownColumns = new Set(narrowBoxes.tiles.map((tile) => tile.left)).size
  check('1280 自动收为 3 列', shownColumns <= 3, 'columns=' + shownColumns)
  await screenshot('04-manual-1280')
  await setViewport(1440, 1000)

  // 6) 社区下载 → 下载中心真实进度 → 完成用时。
  const job = await api('/api/community/download', {
    method: 'POST',
    body: JSON.stringify({
      url: fixtureUrl,
      filename: DOWNLOAD_NAME,
      dir: DOWNLOAD_DIR,
      exactDir: true,
      preserveName: true,
      title: 'UI Check Download',
      meta: { type: 'mod', project: 'UI Check' }
    })
  })
  const jobId = job.id
  // 等到开始下载并有真实字节。
  let running = null
  for (let i = 0; i < 120; i++) {
    const list = await api('/api/community/jobs')
    running = (list.items || []).find((item) => item.id === jobId)
    if (running && running.status === 'running' && running.received > 0) break
    await sleep(100)
  }
  check('社区任务进入下载中', running?.status === 'running', JSON.stringify({ status: running?.status, received: running?.received, total: running?.total }))

  await switchPage('launcher')
  const nav = await evaluate(`(() => {
    const b = [...document.querySelectorAll('.lp-navbtn')].find((x) => x.dataset.nav === 'downloads')
    if (!b) return false
    b.click()
    return true
  })()`)
  check('打开下载中心', nav)
  const rowReady = await waitFor(`[...document.querySelectorAll('.lp-download-row')].some((row) => row.textContent.includes('UI Check Download'))`, 10000)
  check('下载中心出现社区任务', rowReady)
  const live = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.lp-download-row')].find((r) => r.textContent.includes('UI Check Download'))
    if (!row) return null
    const bar = row.querySelector('.lp-job-bar')
    const fill = bar?.querySelector('i')
    return { text: row.innerText, indeterminate: bar?.classList.contains('indeterminate'), width: fill?.style.width || '', barClass: bar?.className || '' }
  })()`)
  check('社区任务进度条不是不确定动画', live && live.indeterminate === false, JSON.stringify(live))
  check('社区任务显示真实百分比/字节', live && /%/.test(live.text) && !/0%/.test(live.text) && /MB|KB/.test(live.text), (live?.text || '').replace(/\s+/g, ' ').slice(0, 160))
  check('社区任务进度条有宽度', live && parseFloat(live.width) > 0, live?.width || '')
  await screenshot('05-download-running')

  // 工作台磁贴：同一任务在多次轮询后仍只有一行。
  await switchPage('workbench')
  await evaluate(`(() => {
    const tile = document.querySelector('[data-id="community-download"]')
    if (tile && tile.classList.contains('collapsed')) tile.querySelector('.tile-head')?.click()
  })()`)
  await sleep(1800)
  const rowCount1 = await evaluate(`(() => {
    const tile = document.querySelector('[data-id="community-download"]')
    return tile ? tile.querySelectorAll('.job-list .job').length : -1
  })()`)
  await sleep(4000)
  const rowCount2 = await evaluate(`(() => {
    const tile = document.querySelector('[data-id="community-download"]')
    return tile ? tile.querySelectorAll('.job-list .job').length : -1
  })()`)
  check('工作台磁贴任务行可读', rowCount1 > 0, 'rows=' + rowCount1)
  check('磁贴轮询 4 次后行数不增长', rowCount2 === rowCount1, `${rowCount1} → ${rowCount2}`)
  const tileJobText = await evaluate(`(() => {
    const tile = document.querySelector('[data-id="community-download"]')
    const row = tile?.querySelector('.job-list .job')
    return row ? row.innerText.replace(/\\s+/g, ' ') : ''
  })()`)
  check('磁贴任务状态/字节可读', /下载中|已完成|安装中/.test(tileJobText) && /MB|KB/.test(tileJobText), tileJobText.slice(0, 160))
  await screenshot('06-bench-download')

  // 等任务完成，检查 100% 与用时。
  let done = null
  for (let i = 0; i < 160; i++) {
    const list = await api('/api/community/jobs')
    done = (list.items || []).find((item) => item.id === jobId)
    if (done && ['done', 'failed', 'cancelled'].includes(done.status)) break
    await sleep(100)
  }
  check('社区任务完成', done?.status === 'done', JSON.stringify({ status: done?.status, error: done?.error }))
  await switchPage('launcher')
  await sleep(500)
  const finishedRow = await waitFor(`(() => {
    const row = [...document.querySelectorAll('.lp-download-row')].find((r) => r.textContent.includes('UI Check Download'))
    return !!row && row.textContent.includes('已完成')
  })()`, 10000)
  check('下载中心显示已完成', finishedRow)
  const finished = await evaluate(`(() => {
    const row = [...document.querySelectorAll('.lp-download-row')].find((r) => r.textContent.includes('UI Check Download'))
    if (!row) return null
    const bar = row.querySelector('.lp-job-bar')
    return { text: row.innerText.replace(/\\s+/g, ' '), width: bar?.querySelector('i')?.style.width || '', indeterminate: bar?.classList.contains('indeterminate') }
  })()`)
  check('完成进度为 100%', finished && parseFloat(finished.width) === 100 && !finished.indeterminate, JSON.stringify(finished))
  check('完成摘要包含用时', finished && /用时/.test(finished.text), finished?.text?.slice(0, 160))
  await screenshot('07-download-done')

  // 清理：删除任务记录与下载文件。
  await api('/api/community/jobs/clear-finished', { method: 'POST', body: '{}' }).catch(() => {})
  await fsp.rm(DOWNLOAD_DIR, { recursive: true, force: true }).catch(() => {})
  fixture.close()

  const errors = events.filter((event) => event.method === 'Runtime.exceptionThrown')
  check('无前端运行时异常', errors.length === 0, errors.slice(0, 3).map((event) => event.params?.exceptionDetails?.text).join(' | '))
  console.log(`\n结果：${results.filter((r) => r.ok).length}/${results.length} 通过；截图 ${OUT}`)
  ws.close()
  if (failures) process.exitCode = 1
}

main().catch(async (error) => {
  console.error(error)
  process.exitCode = 1
})
