// 代理 fetch 的连接复用：同一目标的连续请求应复用隧道/TLS，不再每次握手。
// 这里只测「明文 HTTP 走 HTTP 代理」这条最通用的路径（大文件下载里也用它）。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { makeProxyFetch, parseProxy } from '../src/server/proxy.js'

let proxyConnections = 0
let targetConnections = 0
let proxyRequests = 0

let proxyServer = null
let targetServer = null
const BODY = 'proxy-keepalive-body'

test.before(async () => {
  targetServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + req.headers.host)
    if (url.pathname === '/redirect') {
      res.writeHead(Number(url.searchParams.get('status')), { location: url.searchParams.get('to') })
      req.resume()
      res.end()
      return
    }
    if (url.pathname === '/echo') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      res.end(JSON.stringify({ method: req.method, headers: req.headers, bytes: Buffer.concat(chunks).toString('base64') }))
      return
    }
    res.writeHead(200, { 'content-length': String(BODY.length) })
    res.end(BODY)
  })
  proxyServer = http.createServer((req, res) => {
    // 绝对 URI 形式的请求（HTTP 代理的标准行为）
    proxyRequests++
    const url = new URL(req.url, `http://${req.headers.host || 'fallback.invalid'}`)
    const upstream = http.request({
      host: url.hostname === 'other.test' ? '127.0.0.1' : url.hostname,
      port: Number(url.port) || 80,
      path: url.pathname + url.search,
      method: req.method,
      headers: req.headers
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers)
      upRes.pipe(res)
    })
    upstream.on('error', (err) => {
      res.writeHead(502, { 'content-length': '0' })
      res.end()
    })
    req.pipe(upstream)
  })
  proxyServer.on('connection', () => proxyConnections++)
  targetServer.on('connection', () => targetConnections++)
  await Promise.all([
    new Promise((resolve) => targetServer.listen(0, '127.0.0.1', resolve)),
    new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve))
  ])
})

test.after(async () => {
  proxyServer?.closeAllConnections?.()
  targetServer?.closeAllConnections?.()
  await Promise.all([
    new Promise((resolve) => proxyServer?.close(resolve)),
    new Promise((resolve) => targetServer?.close(resolve))
  ])
})

test('parseProxy 解析与归一化', () => {
  assert.deepEqual(parseProxy('localhost:7890'), { protocol: 'http', host: 'localhost', port: 7890, auth: null })
  assert.deepEqual(parseProxy('http://127.0.0.1:7890'), { protocol: 'http', host: '127.0.0.1', port: 7890, auth: null })
  assert.equal(parseProxy(''), null)
})

test('连续请求复用同一条代理连接（不重复握手）', async () => {
  const proxy = parseProxy(`http://127.0.0.1:${proxyServer.address().port}`)
  const fetchVia = makeProxyFetch(proxy)
  const target = `http://127.0.0.1:${targetServer.address().port}/file.bin`
  try {
    // 连接事件是异步登记的：每轮请求后等一拍，让计数器真实收敛
    for (let i = 0; i < 3; i++) {
      const res = await fetchVia(target)
      assert.equal(res.status, 200)
      assert.equal(await res.text(), BODY)
      await new Promise((resolve) => setTimeout(resolve, 80))
    }
    assert.equal(proxyRequests, 3)
    assert.equal(proxyConnections, 1, `应复用连接（当前 ${proxyConnections} 条）`)
    assert.equal(targetConnections, 1)
  } finally {
    fetchVia.destroy()
  }
})

test('destroy 后重新建立连接，旧池不复用', async () => {
  const proxy = parseProxy(`http://127.0.0.1:${proxyServer.address().port}`)
  const fetchVia = makeProxyFetch(proxy)
  const target = `http://127.0.0.1:${targetServer.address().port}/file.bin`
  const before = proxyConnections
  await fetchVia(target)
  await new Promise((resolve) => setTimeout(resolve, 80))
  await fetchVia(target)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(proxyConnections, before + 1, `两次请求只应开一条连接（${before} → ${proxyConnections}）`)
  fetchVia.destroy()
  await new Promise((resolve) => setTimeout(resolve, 80))
  const res = await fetchVia(target)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), BODY)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(proxyConnections, before + 2, `destroy 后应新建连接（${before} → ${proxyConnections}）`)
})

test('并发请求内容都正确（响应管道不串流）', async () => {
  const proxy = parseProxy(`http://127.0.0.1:${proxyServer.address().port}`)
  const fetchVia = makeProxyFetch(proxy)
  const target = `http://127.0.0.1:${targetServer.address().port}/concurrent.bin`
  const before = proxyConnections
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () => fetchVia(target)))
    for (const res of results) {
      assert.equal(res.status, 200)
      assert.equal(await res.text(), BODY)
    }
    await new Promise((resolve) => setTimeout(resolve, 80))
    // 并发时每个请求拿到自己的连接；随后完成的空闲连接供后续请求复用。
    const opened = proxyConnections - before
    assert.ok(opened >= 1 && opened <= 12, `新开连接数应为 1–12（${opened}）`)
  } finally {
    fetchVia.destroy()
  }
})

test('代理保留 Modrinth 批量 POST、表单和二进制请求体，并按重定向类型处理凭证', async () => {
  const fetchVia = makeProxyFetch(parseProxy(`127.0.0.1:${proxyServer.address().port}`))
  const base = `http://127.0.0.1:${targetServer.address().port}`
  const payload = JSON.stringify({ algorithm: 'sha1', hashes: ['测试'] })
  const post = { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer test', cookie: 'test=1', 'x-api-key': 'test' }, body: payload }
  try {
    for (const [body, contentType] of [[payload, 'text/plain'], [new URLSearchParams({ a: '空 格' }), 'application/x-www-form-urlencoded'], [new Uint8Array([0, 127, 255]), undefined]]) {
      const init = { method: 'POST', body }
      const result = await (await fetchVia(base + '/echo', init)).json()
      assert.equal(result.bytes, Buffer.from(await new Request(base, init).arrayBuffer()).toString('base64'))
      assert.equal(result.headers['content-type']?.split(';')[0], contentType)
    }
    for (const status of [301, 302, 303, 307, 308]) {
      const crossOrigin = status === 308
      const to = crossOrigin ? base.replace('127.0.0.1', 'other.test') + '/echo' : '/echo'
      const result = await (await fetchVia(base + '/redirect?' + new URLSearchParams({ status, to }), post)).json()
      const kept = status === 307 || status === 308
      assert.equal(result.method, kept ? 'POST' : 'GET')
      assert.equal(result.bytes, kept ? Buffer.from(payload).toString('base64') : '')
      assert.equal(result.headers['content-type'], kept ? 'application/json' : undefined)
      for (const header of ['authorization', 'cookie', 'x-api-key']) assert.equal(result.headers[header], crossOrigin ? undefined : post.headers[header])
    }
  } finally { fetchVia.destroy() }
})
