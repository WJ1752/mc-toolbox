// 零依赖 HTTP(S)/SOCKS5 代理客户端（供下载引擎使用，替代全局 fetch）
// 全局 fetch（undici）不读系统代理，也不支持运行时注入代理，故用内置 net/tls/http 手写。
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { Readable } from 'node:stream'

/** 解析代理地址：支持 http://host:port、socks5://host:port（可带 user:pass@） */
export function parseProxy(raw) {
  if (!raw) return null
  let s = String(raw).trim()
  if (!s) return null
  if (!/:\/\//.test(s)) s = 'http://' + s
  let u
  try { u = new URL(s) } catch { return null }
  const p = u.protocol.replace(':', '')
  if (!['http', 'https', 'socks5', 'socks'].includes(p)) return null
  const host = u.hostname
  if (!host) return null
  const protocol = p === 'socks' ? 'socks5' : p
  const port = Number(u.port) || (protocol === 'socks5' ? 1080 : (p === 'https' ? 443 : 8080))
  const auth = u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}` : null
  return { protocol, host, port, auth }
}

/** HTTP 代理 CONNECT 隧道（用于 HTTPS 目标） */
function httpConnect(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host)
    socket.setNoDelay(true)
    let settled = false
    const fail = (e) => { if (!settled) { settled = true; socket.destroy(); reject(e) } }
    socket.on('connect', () => {
      const auth = proxy.auth ? `Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}\r\n` : ''
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`)
    })
    let buf = ''
    socket.on('data', function onData(d) {
      buf += d.toString('latin1')
      const idx = buf.indexOf('\r\n\r\n')
      if (idx === -1) return
      socket.off('data', onData)
      const statusLine = buf.slice(0, idx).split('\r\n')[0] || ''
      const code = parseInt((statusLine.split(' ')[1] || '0'), 10)
      if (code !== 200) return fail(new Error('代理 CONNECT 失败：' + statusLine))
      const rest = buf.slice(idx + 4)
      if (rest) socket.unshift(Buffer.from(rest, 'latin1'))
      settled = true
      resolve(socket)
    })
    socket.on('error', fail)
    socket.setTimeout(15000, () => fail(new Error('代理连接超时')))
  })
}

/** SOCKS5 CONNECT（用户名密码认证可选） */
function socks5Connect(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host)
    socket.setNoDelay(true)
    let settled = false
    let stage = 0
    let buf = Buffer.alloc(0)
    const fail = (e) => { if (!settled) { settled = true; socket.destroy(); reject(e) } }
    socket.on('connect', () => {
      const methods = proxy.auth ? [0x00, 0x02] : [0x00]
      socket.write(Buffer.from([0x05, methods.length, ...methods]))
    })
    function sendConnect() {
      const hb = Buffer.from(host)
      const pb = Buffer.alloc(2)
      pb.writeUInt16BE(port, 0)
      socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]), hb, pb]))
    }
    socket.on('data', function onData(d) {
      buf = Buffer.concat([buf, d])
      if (stage === 0) {
        if (buf.length < 2) return
        const method = buf[1]
        buf = buf.slice(2)
        if (method === 0x02) { // 用户名密码认证
          stage = 1
          const [u, ...rest] = proxy.auth.split(':')
          const ub = Buffer.from(u)
          const pb2 = Buffer.from(rest.join(':'))
          socket.write(Buffer.concat([Buffer.from([0x01, ub.length]), ub, Buffer.from([pb2.length]), pb2]))
        } else if (method === 0x00) {
          stage = 2
          sendConnect()
        } else fail(new Error('SOCKS5 代理不支持所需认证方式'))
      } else if (stage === 1) {
        if (buf.length < 2) return
        if (buf[1] !== 0) return fail(new Error('SOCKS5 代理认证失败'))
        buf = buf.slice(2)
        stage = 2
        sendConnect()
      } else if (stage === 2) {
        if (buf.length < 4) return
        const atyp = buf[3]
        const need = 4 + (atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : (buf[4] || 0) + 1) + 2
        if (buf.length < need) return
        const rep = buf[1]
        if (rep !== 0) return fail(new Error('SOCKS5 连接失败（code=' + rep + '）'))
        const rest = buf.slice(need)
        socket.off('data', onData)
        if (rest.length) socket.unshift(rest)
        settled = true
        resolve(socket)
      }
    })
    socket.on('error', fail)
    socket.setTimeout(15000, () => fail(new Error('SOCKS5 连接超时')))
  })
}

function buildResponse(res) {
  const headers = new Headers()
  for (const [k, v] of Object.entries(res.headers || {})) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x))
    else if (v !== undefined) headers.append(k, String(v))
  }
  const noBody = res.statusCode === 204 || res.statusCode === 304 || (res.statusCode >= 100 && res.statusCode < 200)
  const body = noBody ? null : Readable.toWeb(res)
  return new Response(body, { status: res.statusCode || 0, headers })
}

/** 生成一个 drop-in 的 fetch 替代（走代理），返回标准 Response */
export function makeProxyFetch(proxy) {
  const isSocks = proxy.protocol === 'socks5'

  function singleRequest(urlStr, init) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr)
      const httpsTarget = url.protocol === 'https:'
      const targetHost = url.hostname
      const targetPort = url.port ? Number(url.port) : (httpsTarget ? 443 : 80)
      const method = (init.method || 'GET').toUpperCase()
      const headers = {}
      if (init.headers) {
        const h = init.headers instanceof Headers ? init.headers : new Headers(init.headers)
        h.forEach((v, k) => { headers[k] = v })
      }

      let req
      const wireSignal = (r) => {
        if (!init.signal) return
        if (init.signal.aborted) { r.destroy(new Error('请求已取消')); return }
        init.signal.addEventListener('abort', () => r.destroy(new Error('请求已取消')), { once: true })
      }

      const runPlain = (socket) => {
        req = http.request({
          createConnection: () => socket,
          host: targetHost,
          port: targetPort,
          method,
          path: url.pathname + url.search,
          headers
        }, (res) => resolve(buildResponse(res)))
        req.on('error', reject)
        wireSignal(req)
        req.end()
      }

      const runTls = (tunnel) => {
        const tlsSock = tls.connect({ socket: tunnel, servername: targetHost })
        tlsSock.once('secureConnect', () => runPlain(tlsSock))
        tlsSock.once('error', reject)
      }

      if (httpsTarget) {
        const tunnelP = isSocks ? socks5Connect(proxy, targetHost, targetPort) : httpConnect(proxy, targetHost, targetPort)
        tunnelP.then(runTls).catch(reject)
      } else if (isSocks) {
        socks5Connect(proxy, targetHost, targetPort).then(runPlain).catch(reject)
      } else {
        // 明文 HTTP 走 HTTP 代理的绝对 URI
        const authHeader = proxy.auth ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(proxy.auth).toString('base64') } : {}
        req = http.request({
          host: proxy.host,
          port: proxy.port,
          method,
          path: urlStr,
          headers: { ...headers, Host: url.host, ...authHeader }
        }, (res) => resolve(buildResponse(res)))
        req.on('error', reject)
        wireSignal(req)
        req.end()
      }
    })
  }

  return async function proxyFetch(input, init = {}) {
    let current = String(input)
    for (let i = 0; i <= 10; i++) {
      const res = await singleRequest(current, init)
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) return res
        await res.body?.cancel?.().catch(() => {})
        current = new URL(loc, current).toString()
        continue
      }
      return res
    }
    throw new Error('重定向次数过多')
  }
}
