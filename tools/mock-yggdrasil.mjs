// 本地 Yggdrasil / authlib-injector 认证服务器（仅用于启动器联调与验收）。
//
// 用法：
//   node tools/mock-yggdrasil.mjs --port=39123
// 启动器里添加第三方账户：
//   服务器 http://127.0.0.1:39123/api/yggdrasil
//   用户名 TestSkin   密码 secret
//
// 服务器会记录收到的请求（包括游戏客户端取皮肤），方便确认 authlib-injector
// 真的接管了认证与皮肤请求。
import http from 'node:http'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [k, ...v] = arg.replace(/^--/, '').split('=')
  return [k, v.join('=') || '1']
}))
const PORT = Number(args.port || 39123)
const HOST = '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`
const USER = args.user || 'TestSkin'
const PASS = args.pass || 'secret'
const UUID = '11111111222233334444555555555555'
const tokens = new Map()
const requests = []

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

// 64x64 皮肤：透明底 + 一个醒目的青色方块，足以让客户端完成纹理加载。
function makeSkin() {
  const size = 64
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4
      const inside = x >= 8 && x < 56 && y >= 8 && y < 56
      raw[o] = inside ? 40 : 0
      raw[o + 1] = inside ? 200 : 0
      raw[o + 2] = inside ? 210 : 0
      raw[o + 3] = inside ? 255 : 0
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))
  ])
}
const SKIN = makeSkin()

function texturesValue() {
  return Buffer.from(JSON.stringify({
    timestamp: Date.now(),
    profileId: UUID,
    profileName: USER,
    textures: {
      SKIN: { url: `${BASE}/skin.png`, metadata: { model: 'slim' } },
      CAPE: { url: `${BASE}/cape.png` }
    }
  })).toString('base64')
}

function json(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) })
  res.end(data)
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch { resolve({}) } })
  })
}

function issue(clientToken = crypto.randomBytes(16).toString('hex')) {
  const accessToken = crypto.randomBytes(24).toString('hex')
  tokens.set(accessToken, { clientToken, valid: true })
  return { accessToken, clientToken }
}

function selectedProfile() {
  return { id: UUID, name: USER }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE)
  requests.push({ method: req.method, path: url.pathname, at: Date.now() })
  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}`)
  // 真实皮肤站通常挂在 /api/yggdrasil 下；启动器会在服务器地址后追加
  // /authserver/... 与 /sessionserver/...。
  const pathname = url.pathname.replace(/^\/api\/yggdrasil(?=\/|$)/, '') || '/'

  if (pathname === '/skin.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': SKIN.length })
    return res.end(SKIN)
  }
  if (pathname === '/cape.png') {
    res.writeHead(404); return res.end()
  }
  if (pathname === '/' || pathname === '/api/yggdrasil' || pathname === '/api/yggdrasil/') {
    return json(res, 200, {
      meta: { serverName: 'MC Toolbox Mock Yggdrasil', implementationName: 'mock', implementationVersion: '1' },
      skinDomains: [HOST]
    })
  }
  if (pathname === '/authserver/authenticate' && req.method === 'POST') {
    const body = await readBody(req)
    if (body.username !== USER || body.password !== PASS) {
      return json(res, 403, { error: 'ForbiddenOperationException', errorMessage: 'Invalid credentials. Invalid username or password.' })
    }
    const t = issue(body.clientToken)
    return json(res, 200, {
      ...t, availableProfiles: [selectedProfile()], selectedProfile: selectedProfile(),
      user: { id: UUID, properties: [] }
    })
  }
  if (pathname === '/authserver/validate' && req.method === 'POST') {
    const body = await readBody(req)
    const token = tokens.get(body.accessToken)
    if (!token?.valid || token.clientToken !== body.clientToken) {
      return json(res, 403, { error: 'ForbiddenOperationException', errorMessage: 'Invalid token.' })
    }
    res.writeHead(204); return res.end()
  }
  if (pathname === '/authserver/refresh' && req.method === 'POST') {
    const body = await readBody(req)
    const token = tokens.get(body.accessToken)
    if (!token?.valid) {
      return json(res, 403, { error: 'ForbiddenOperationException', errorMessage: 'Invalid token.' })
    }
    tokens.delete(body.accessToken)
    const t = issue(token.clientToken || body.clientToken)
    return json(res, 200, {
      ...t, availableProfiles: [selectedProfile()], selectedProfile: selectedProfile(),
      user: { id: UUID, properties: [] }
    })
  }
  if (pathname === '/authserver/invalidate' && req.method === 'POST') {
    const body = await readBody(req)
    tokens.delete(body.accessToken)
    res.writeHead(204); return res.end()
  }
  if (pathname.startsWith('/sessionserver/session/minecraft/profile/')) {
    const id = pathname.split('/').pop()
    if (id.replace(/-/g, '').toLowerCase() !== UUID) { res.writeHead(204); return res.end() }
    return json(res, 200, {
      id: UUID,
      name: USER,
      properties: [{ name: 'textures', value: texturesValue() }]
    })
  }
  if (args['dump-requests'] === '1' && pathname === '/__requests') {
    return json(res, 200, { items: requests })
  }
  res.writeHead(404); res.end()
})

server.listen(PORT, HOST, () => {
  console.log(`Mock Yggdrasil listening on ${BASE}/api/yggdrasil`)
  console.log(`user=${USER} pass=${PASS} uuid=${UUID}`)
})

function shutdown() { server.close(() => process.exit(0)) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
