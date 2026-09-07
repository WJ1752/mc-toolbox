import net from 'node:net'
import dgram from 'node:dgram'
import dns from 'node:dns/promises'

// ---------------- VarInt / 缓冲区工具 ----------------
function writeVarInt(value) {
  const out = []
  let v = value < 0 ? value + 0x100000000 : value
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v !== 0) b |= 0x80
    out.push(b)
  } while (v !== 0)
  return Buffer.from(out)
}

function writeString(str) {
  const body = Buffer.from(str, 'utf8')
  return Buffer.concat([writeVarInt(body.length), body])
}

function readVarInt(buf, offset) {
  let value = 0
  let position = 0
  let byte
  do {
    if (offset + position >= buf.length) throw new Error('数据包不完整')
    byte = buf[offset + position]
    value |= (byte & 0x7f) << (position * 7)
    position++
    if (position > 5) throw new Error('VarInt 过长')
  } while ((byte & 0x80) !== 0)
  return { value: value > 0x7fffffff ? value - 0x100000000 : value, length: position }
}

function readString(buf, offset) {
  const { value: len, length } = readVarInt(buf, offset)
  const start = offset + length
  if (start + len > buf.length) throw new Error('字符串不完整')
  return { value: buf.toString('utf8', start, start + len), length: length + len }
}

export function parseAddress(input, fallbackPort) {
  let host = String(input || '').trim()
  let port = fallbackPort
  // 支持 [ipv6]:port
  const v6 = host.match(/^\[(.+)\]:(\d+)$/)
  if (v6) {
    host = v6[1]
    port = Number(v6[2])
  } else if (host.includes(':') && host.lastIndexOf(':') > host.indexOf(':')) {
    // ipv6 裸地址
    port = fallbackPort
  } else {
    const idx = host.lastIndexOf(':')
    if (idx > -1) {
      const maybePort = Number(host.slice(idx + 1))
      if (Number.isInteger(maybePort) && maybePort > 0 && maybePort < 65536) {
        port = maybePort
        host = host.slice(0, idx)
      }
    }
  }
  return { host: host.replace(/^https?:\/\//, '').replace(/\/+$/, ''), port }
}

async function resolveSrv(host, port) {
  try {
    const records = await dns.resolveSrv('_minecraft._tcp.' + host)
    if (records && records.length) {
      const r = records.sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0]
      return { host: r.name.replace(/\.$/, ''), port: r.port, viaSrv: true }
    }
  } catch {
    /* 没有 SRV 记录，忽略 */
  }
  return { host, port, viaSrv: false }
}

async function resolveHost(host) {
  // 直接返回即可，net.connect 会自行解析；这里额外处理 A/AAAA 便于显示 IP
  try {
    const res = await dns.lookup(host)
    return res.address
  } catch {
    return null
  }
}

// ---------------- Java 版：Server List Ping (TCP) ----------------
export function pingJava(opts) {
  const { host, port = 25565, timeout = 5000, protocol = -1 } = opts
  return new Promise((resolve) => {
    const started = process.hrtime.bigint()
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve({
        edition: 'java',
        ok: !!result.ok,
        error: result.error || null,
        latency: result.latency ?? Number(Number(process.hrtime.bigint() - started) / 1e6).toFixed(1) * 1,
        data: result.data || null,
        raw: result.raw || null
      })
    }

    const socket = new net.Socket()
    socket.setNoDelay(true)
    const timer = setTimeout(() => finish({ ok: false, error: '连接超时' }), timeout)

    socket.on('error', (err) => finish({ ok: false, error: friendlyError(err) }))
    socket.on('close', () => finish({ ok: false, error: '连接被关闭（可能不是 Java 版服务器）' }))

    socket.connect(port, host, () => {
      const t0 = process.hrtime.bigint()
      const handshake = Buffer.concat([
        writeVarInt(0x00),
        writeVarInt(protocol),
        writeString(host),
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        writeVarInt(1)
      ])
      const handshakePacket = Buffer.concat([writeVarInt(handshake.length), handshake])
      const statusRequest = Buffer.from([0x01, 0x00])

      socket.write(handshakePacket)
      socket.write(statusRequest)

      let buf = Buffer.alloc(0)
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk])
        try {
          const { value: packetLen, length: lenSize } = readVarInt(buf, 0)
          if (buf.length < lenSize + packetLen) return
          const payload = buf.subarray(lenSize, lenSize + packetLen)
          const { value: packetId, length: idSize } = readVarInt(payload, 0)
          if (packetId !== 0x00) throw new Error('未知响应包 ' + packetId)
          const { value: json } = readString(payload, idSize)
          const latency = Number(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1) * 1
          let obj
          try {
            obj = JSON.parse(json)
          } catch {
            throw new Error('响应不是合法 JSON')
          }
          socket.removeListener('data', onData)
          finish({
            ok: true,
            latency,
            raw: obj,
            data: normalizeJava(obj)
          })
        } catch (e) {
          if (buf.length > 5) {
            socket.removeListener('data', onData)
            finish({ ok: false, error: e.message })
          }
        }
      }
      socket.on('data', onData)
    })
  })
}

function normalizeJava(obj) {
  const players = obj.players || {}
  const version = obj.version || {}
  const desc = obj.description ?? obj.motd ?? ''
  const motd = typeof desc === 'string' ? desc : flattenMotd(desc)
  const sample = Array.isArray(players.sample) ? players.sample : []
  return {
    motd,
    version: version.name || '未知',
    protocol: version.protocol ?? null,
    players: {
      online: players.online ?? null,
      max: players.max ?? null,
      sample: sample.slice(0, 24).map((p) => ({
        name: stripColor(p.name || ''),
        id: p.id || null
      }))
    },
    favicon: obj.favicon && String(obj.favicon).startsWith('data:image') ? obj.favicon : null,
    modded: !!(obj.modinfo || obj.forgeData || (obj.version && obj.version.name && /forge|fabric|quilt|neoforge/i.test(obj.version.name)))
  }
}

function flattenMotd(node) {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(flattenMotd).join('')
  if (typeof node === 'object') {
    let out = node.text || ''
    if (node.translate) out += node.translate
    if (Array.isArray(node.extra)) out += node.extra.map(flattenMotd).join('')
    if (Array.isArray(node.with)) out += node.with.map(flattenMotd).join('')
    return out
  }
  return String(node)
}

export function stripColor(text) {
  return String(text).replace(/§[0-9a-fk-orA-FK-OR]/g, '').replace(/&[0-9a-fk-orA-FK-OR]/g, '')
}

function friendlyError(err) {
  const code = err?.code
  if (code === 'ENOTFOUND') return '域名解析失败'
  if (code === 'ECONNREFUSED') return '连接被拒绝（端口未开放）'
  if (code === 'ETIMEDOUT') return '连接超时'
  if (code === 'EHOSTUNREACH') return '主机不可达'
  return err?.message || '未知错误'
}

// ---------------- 基岩版：RakNet Unconnected Ping (UDP) ----------------
const RAKNET_MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex')

export function pingBedrock(opts) {
  const { host, port = 19132, timeout = 5000 } = opts
  return new Promise((resolve) => {
    let done = false
    let sentAt = process.hrtime.bigint()
    const socket = dgram.createSocket('udp4')
    const finish = (res) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {}
      resolve(res)
    }
    const timer = setTimeout(() => finish({ edition: 'bedrock', ok: false, error: '请求超时', data: null, raw: null }), timeout)

    socket.on('error', (err) => finish({ edition: 'bedrock', ok: false, error: friendlyError(err), data: null, raw: null }))

    socket.on('message', (msg) => {
      try {
        if (msg[0] !== 0x1c) return
        const strLen = msg.readUInt16BE(33)
        const payload = msg.toString('utf8', 35, 35 + strLen)
        const parts = payload.split(';')
        if (parts[0] !== 'MCPE' && !/MCPE/i.test(parts[0] || '')) return
        finish({
          edition: 'bedrock',
          ok: true,
          latency: Number(Number(process.hrtime.bigint() - sentAt) / 1e6).toFixed(1) * 1,
          raw: { payload, parts },
          data: {
            motd: [parts[1], parts[7]].filter(Boolean).join(' / ') || '',
            version: parts[3] || '未知',
            protocol: Number(parts[2]) || null,
            players: { online: Number(parts[4]) || 0, max: Number(parts[5]) || 0, sample: [] },
            favicon: null,
            modded: false
          }
        })
      } catch (e) {
        finish({ edition: 'bedrock', ok: false, error: e.message, data: null, raw: null })
      }
    })

    const ping = Buffer.alloc(1 + 8 + 16 + 8)
    ping[0] = 0x01
    ping.writeBigInt64BE(BigInt(Date.now()), 1)
    RAKNET_MAGIC.copy(ping, 9)
    ping.writeBigInt64BE(BigInt('0x' + '0123456789abcdef'), 25)

    socket.bind(0, () => {
      sentAt = process.hrtime.bigint()
      socket.send(ping, 0, ping.length, port, host, (err) => {
        if (err) finish({ edition: 'bedrock', ok: false, error: friendlyError(err), data: null, raw: null })
      })
    })
  })
}

// ---------------- 统一入口 ----------------
export async function pingServer(input) {
  const settings = input.settings || {}
  const timeout = input.timeout ?? settings.timeout ?? 5000
  const retries = input.retries ?? settings.retries ?? 0
  const parsed = parseAddress(input.host, input.port || (input.type === 'bedrock' ? settings.bedrockPort || 19132 : settings.javaPort || 25565))
  let target = { host: parsed.host, port: parsed.port }

  if ((input.type === 'java' || input.type === 'auto') && settings.resolveSrv !== false && !net.isIP(parsed.host)) {
    const srv = await resolveSrv(parsed.host, parsed.port)
    target = { host: srv.host, port: srv.port }
    var viaSrv = srv.viaSrv
  }

  const ip = await resolveHost(target.host)
  const base = { host: parsed.host, port: parsed.port, resolvedHost: target.host, resolvedPort: target.port, ip, viaSrv: !!viaSrv }

  async function attempt(type) {
    if (type === 'bedrock') {
      const r = await pingBedrock({ host: target.host, port: target.port, timeout })
      return { ...base, ...r, edition: 'bedrock' }
    }
    const r = await pingJava({ host: target.host, port: target.port, timeout })
    return { ...base, ...r, edition: 'java' }
  }

  if (input.type === 'java' || input.type === 'bedrock') {
    let last = null
    for (let i = 0; i <= retries; i++) {
      last = await attempt(input.type)
      if (last.ok) return last
    }
    return last
  }

  // auto：先 Java，失败再基岩
  for (let i = 0; i <= retries; i++) {
    const r = await attempt('java')
    if (r.ok) return r
  }
  const be = await attempt('bedrock')
  if (be.ok) return be
  // 都失败，返回 Java 的错误（信息更具体）
  const ja = await attempt('java')
  return ja
}
