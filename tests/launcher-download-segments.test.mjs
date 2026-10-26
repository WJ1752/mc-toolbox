// 多线程分段下载：Range 支持 / 不支持 / 假装支持，都要得到与单连接一致的文件，
// 并且进度单调递增、取消后不留半成品。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import crypto from 'node:crypto'

import { fetchToFile } from '../src/server/launcher/download.js'
import { resetSourceStats } from '../src/server/launcher/source-select.js'

const SIZE = 6 * 1024 * 1024
const body = Buffer.alloc(SIZE)
for (let i = 0; i < SIZE; i++) body[i] = (i * 31 + 7) & 0xff
const goodSha1 = crypto.createHash('sha1').update(body).digest('hex')

let dir = ''
let server = null
let base = ''
const requests = []

/** 记录每个请求的 Range；rangeMode: full | none | probe-only */
function handler(rangeMode) {
  return (req, res) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
    requests.push({ url: req.url, range: req.headers.range || '' })
    const allow = rangeMode === 'full' || (rangeMode === 'probe-only' && range && range[1] === '0' && range[2] === '0')
    if (range && allow) {
      const start = Number(range[1])
      const end = range[2] ? Math.min(Number(range[2]), SIZE - 1) : SIZE - 1
      if (start >= SIZE) {
        res.writeHead(416, { 'Content-Range': `bytes */${SIZE}` })
        res.end()
        return
      }
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${SIZE}`,
        'Accept-Ranges': 'bytes'
      })
      res.end(body.subarray(start, end + 1))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(SIZE) })
    res.end(body)
  }
}

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-segments-'))
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/full')) return handler('full')(req, res)
    if (req.url.startsWith('/none')) return handler('none')(req, res)
    if (req.url.startsWith('/probe-only')) return handler('probe-only')(req, res)
    if (req.url.startsWith('/truncated')) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
      const start = Number(range?.[1] || 0)
      const end = Number(range?.[2] || SIZE - 1)
      res.writeHead(206, {
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${SIZE}`
      })
      res.end(body.subarray(start, Math.floor((start + end) / 2)))
      return
    }
    res.writeHead(404)
    res.end('nope')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

test.after(async () => {
  server?.closeAllConnections?.()
  await new Promise((resolve) => server?.close(resolve))
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

test.beforeEach(() => {
  requests.length = 0
  resetSourceStats()
})

test('支持 Range：6 MB 文件用 4 条连接分段下载，内容与哈希一致', async () => {
  const target = path.join(dir, 'full', 'client.jar')
  const seen = []
  const result = await fetchToFile(`${base}/full/client.jar`, target, {
    sha1: goodSha1,
    size: SIZE,
    threads: 4,
    onProgress: ({ received }) => seen.push(received)
  })
  assert.equal(result.cached, false)
  assert.equal(result.size, SIZE)
  assert.deepEqual(await fs.readFile(target), body)
  // 至少有一个真正的分段请求（起点不是 0），说明不是退化成单连接。
  assert.ok(requests.some((item) => /^bytes=(?!0-)/.test(item.range)), '应发出分段请求')
  assert.ok(seen.length > 4, '分段下载应持续上报进度')
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], '进度不能回退')
  assert.equal(seen.at(-1), SIZE)
})

test('不支持 Range：自动退化为单连接，文件仍然正确', async () => {
  const target = path.join(dir, 'none', 'client.jar')
  const result = await fetchToFile(`${base}/none/client.jar`, target, {
    sha1: goodSha1,
    size: SIZE,
    threads: 4
  })
  assert.equal(result.size, SIZE)
  assert.deepEqual(await fs.readFile(target), body)
  assert.equal(requests.filter((item) => /^bytes=(?!0-0)/.test(item.range)).length, 0)
})

test('服务器只对 0-0 返回 206：分段失败后回退单连接，不留下半成品', async () => {
  const target = path.join(dir, 'probe-only', 'client.jar')
  const result = await fetchToFile(`${base}/probe-only/client.jar`, target, {
    sha1: goodSha1,
    size: SIZE,
    threads: 4
  })
  assert.equal(result.size, SIZE)
  assert.deepEqual(await fs.readFile(target), body)
  const leftovers = (await fs.readdir(path.dirname(target))).filter((name) => name.includes('.part-'))
  assert.deepEqual(leftovers, [])
})

test('分段响应被截断时判失败并清理临时文件', async () => {
  const target = path.join(dir, 'truncated', 'client.jar')
  await assert.rejects(
    fetchToFile(`${base}/truncated/client.jar`, target, { sha1: goodSha1, size: SIZE, threads: 4, retries: 0 })
  )
  await assert.rejects(fs.stat(target))
  const leftovers = (await fs.readdir(path.dirname(target)).catch(() => [])).filter((name) => name.includes('.part-'))
  assert.deepEqual(leftovers, [])
})

test('expectedSize 也能触发分段（整合包清单只给提示大小、不做长度校验）', async () => {
  const target = path.join(dir, 'hint', 'mod.jar')
  await fetchToFile(`${base}/full/mod.jar`, target, {
    expectedSize: SIZE,
    threads: 4,
    verify: false
  })
  assert.deepEqual(await fs.readFile(target), body)
  assert.ok(requests.some((item) => /^bytes=(?!0-)/.test(item.range)), '应发出分段请求')
})

test('429 限流：分段请求被拒绝时自动降为单连接，文件仍然下完', async () => {
  let ranged429 = 0
  const limited = http.createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
    if (range && !(range[1] === '0' && range[2] === '0')) {
      ranged429++
      res.writeHead(429, { 'Retry-After': '1' })
      res.end('slow down')
      return
    }
    if (range) {
      res.writeHead(206, {
        'Content-Range': `bytes 0-0/${SIZE}`,
        'Content-Length': '1',
        'Accept-Ranges': 'bytes'
      })
      res.end(body.subarray(0, 1))
      return
    }
    res.writeHead(200, { 'Content-Length': String(SIZE) })
    res.end(body)
  })
  await new Promise((resolve) => limited.listen(0, '127.0.0.1', resolve))
  const limitedBase = `http://127.0.0.1:${limited.address().port}`
  const target = path.join(dir, 'limited', 'client.jar')
  try {
    const result = await fetchToFile(`${limitedBase}/client.jar`, target, {
      sha1: goodSha1,
      size: SIZE,
      threads: 4
    })
    assert.equal(result.size, SIZE)
    assert.deepEqual(await fs.readFile(target), body)
    assert.ok(ranged429 > 0, '应确实触发过限流')
  } finally {
    limited.closeAllConnections?.()
    await new Promise((resolve) => limited.close(resolve))
  }
})

test('取消后中断下载并且不落地目标文件', async () => {
  const slow = http.createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
    const start = Number(range?.[1] || 0)
    const end = Number(range?.[2] || SIZE - 1)
    if (range) {
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${SIZE}`, 'Content-Length': String(end - start + 1) })
    } else {
      res.writeHead(200, { 'Content-Length': String(SIZE) })
    }
    let sent = 0
    const timer = setInterval(() => {
      if (sent >= SIZE) { clearInterval(timer); res.end(); return }
      res.write(body.subarray(sent, sent + 64 * 1024))
      sent += 64 * 1024
    }, 20)
    res.on('close', () => clearInterval(timer))
  })
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve))
  const slowBase = `http://127.0.0.1:${slow.address().port}`
  const target = path.join(dir, 'cancel', 'client.jar')
  const controller = new AbortController()
  try {
    await assert.rejects(
      fetchToFile(`${slowBase}/client.jar`, target, {
        size: SIZE,
        threads: 4,
        signal: controller.signal,
        onProgress: () => controller.abort(new Error('用户取消'))
      }),
      /用户取消|已取消|abort/i
    )
    await assert.rejects(fs.stat(target))
  } finally {
    slow.closeAllConnections?.()
    await new Promise((resolve) => slow.close(resolve))
  }
})
