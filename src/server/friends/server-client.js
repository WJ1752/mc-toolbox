// 好友服务器客户端：自签证书指纹固定 + JSON API + 文件上传/下载。
//
// 证书校验不依赖系统 CA：连接时先接受握手（rejectUnauthorized:false），拿到
// 对端证书后与本机保存的 SHA-256 指纹逐字比对；不一致立即断开。首次连接由
// 「检测服务器」把指纹展示给用户确认，属于 TOFU。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import crypto from 'node:crypto'
import { URL } from 'node:url'

const MAX_JSON = 4 * 1024 * 1024
const JSON_TIMEOUT = 20000
const IDLE_TIMEOUT = 60000

export function normalizeFingerprint(value) {
  return String(value || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function parseBase(url) {
  let parsed
  try {
    parsed = new URL(String(url || '').trim())
  } catch {
    throw Object.assign(new Error('服务器地址格式不正确'), { code: 'BAD_URL' })
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw Object.assign(new Error('服务器地址必须是 https:// 开头'), { code: 'BAD_URL' })
  }
  if (parsed.protocol === 'http:' && !isLocalHost(parsed.hostname)) {
    throw Object.assign(new Error('公网好友服务器必须使用 https://'), { code: 'BAD_URL' })
  }
  return parsed
}

function fingerprintOf(response) {
  try {
    return response.socket?.getPeerCertificate?.()?.fingerprint256 || ''
  } catch {
    return ''
  }
}

function checkFingerprint(response, expected) {
  if (!response.socket?.encrypted) return ''
  const actual = fingerprintOf(response)
  if (!actual) throw Object.assign(new Error('无法读取服务器证书'), { code: 'TLS_NO_CERT' })
  if (expected && normalizeFingerprint(actual) !== normalizeFingerprint(expected)) {
    throw Object.assign(new Error('服务器证书指纹不匹配，可能被中间人替换或服务器换了证书'), { code: 'TLS_FINGERPRINT_MISMATCH' })
  }
  return actual
}

function requestRaw({ base, method, pathname, headers = {}, body = null, timeoutMs = JSON_TIMEOUT, expectedFingerprint = '', signal = null }) {
  return new Promise((resolve, reject) => {
    const parsed = base instanceof URL ? base : parseBase(base)
    const isHttps = parsed.protocol === 'https:'
    const transport = isHttps ? https : http
    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: pathname,
      method,
      headers: { ...headers },
      rejectUnauthorized: false,
      agent: false
    }
    const req = transport.request(options, (res) => {
      try {
        checkFingerprint(res, expectedFingerprint)
      } catch (error) {
        res.destroy()
        reject(error)
        return
      }
      resolve(res)
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error('服务器响应超时'), { code: 'TIMEOUT' }))
    })
    req.on('error', (error) => reject(Object.assign(error, { code: error.code || 'NETWORK' })))
    if (signal) {
      const abort = () => req.destroy(Object.assign(new Error('已取消'), { code: 'CANCELLED' }))
      if (signal.aborted) return abort()
      signal.addEventListener('abort', abort, { once: true })
      req.on('close', () => signal.removeEventListener('abort', abort))
    }
    if (body) {
      if (Buffer.isBuffer(body) || typeof body === 'string') req.end(body)
      else body.pipe(req)
    } else {
      req.end()
    }
  })
}

async function readJsonResponse(res) {
  const chunks = []
  let total = 0
  for await (const chunk of res) {
    total += chunk.length
    if (total > MAX_JSON) throw Object.assign(new Error('服务器返回内容过大'), { code: 'RESPONSE_TOO_LARGE' })
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    throw Object.assign(new Error('服务器返回的不是 JSON'), { code: 'BAD_RESPONSE' })
  }
  if (res.statusCode === 401) {
    throw Object.assign(new Error(data?.error || '登录已失效，请重新登录'), { code: 'SESSION_EXPIRED', status: 401 })
  }
  if (res.statusCode < 200 || res.statusCode >= 300 || data?.error) {
    throw Object.assign(new Error(data?.error || `服务器返回 HTTP ${res.statusCode}`), {
      code: data?.code || 'SERVER_ERROR',
      status: res.statusCode
    })
  }
  return data
}

export class FriendsServerClient {
  constructor({ url, fingerprint = '', token = '' } = {}) {
    this.base = parseBase(url)
    this.url = this.base.toString().replace(/\/+$/, '')
    this.fingerprint = fingerprint
    this.token = token
  }

  async request(method, pathname, { body = null, timeoutMs = JSON_TIMEOUT } = {}) {
    const headers = { Accept: 'application/json' }
    let payload = null
    if (body !== null && body !== undefined) {
      payload = Buffer.from(JSON.stringify(body), 'utf8')
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = payload.length
    }
    if (this.token) headers.Authorization = 'Bearer ' + this.token
    const res = await requestRaw({
      base: this.base,
      method,
      pathname,
      headers,
      body: payload,
      timeoutMs,
      expectedFingerprint: this.fingerprint
    })
    return await readJsonResponse(res)
  }

  /** 首次连接/重新检测：返回 health 与证书指纹，不要求已保存指纹。 */
  async probe() {
    const res = await requestRaw({
      base: this.base,
      method: 'GET',
      pathname: '/api/health',
      headers: { Accept: 'application/json' },
      expectedFingerprint: '',
      timeoutMs: 8000
    })
    const fingerprint = checkFingerprint(res, '')
    const health = await readJsonResponse(res)
    if (health?.name !== 'mc-toolbox-friends') {
      throw Object.assign(new Error('这个地址不是 MC Toolbox 好友服务器'), { code: 'NOT_FRIENDS_SERVER' })
    }
    return { fingerprint, health, url: this.url }
  }

  async uploadFile(id, filePath, { size, onProgress, signal } = {}) {
    const stat = size ? { size } : await fsp.stat(filePath)
    const length = Number(stat.size) || 0
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': length,
      Authorization: 'Bearer ' + this.token
    }
    let sent = 0
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => {
      sent += chunk.length
      onProgress?.({ loaded: sent, total: length, ratio: length ? sent / length : 0 })
    })
    const res = await requestRaw({
      base: this.base,
      method: 'PUT',
      pathname: `/api/files/${encodeURIComponent(id)}`,
      headers,
      body: stream,
      timeoutMs: 0,
      expectedFingerprint: this.fingerprint,
      signal
    })
    return await readJsonResponse(res)
  }

  async downloadBuffer(id, { limit = 12 * 1024 * 1024 } = {}) {
    const res = await requestRaw({
      base: this.base,
      method: 'GET',
      pathname: `/api/files/${encodeURIComponent(id)}/download`,
      headers: { Accept: '*/*', Authorization: 'Bearer ' + this.token },
      expectedFingerprint: this.fingerprint,
      timeoutMs: 0
    })
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const error = await readJsonResponse(res).catch(() => null)
      throw Object.assign(new Error(error?.error || `服务器返回 HTTP ${res.statusCode}`), { code: 'SERVER_ERROR', status: res.statusCode })
    }
    const chunks = []
    let total = 0
    for await (const chunk of res) {
      total += chunk.length
      if (total > limit) throw Object.assign(new Error('图片超过大小限制'), { code: 'RESPONSE_TOO_LARGE' })
      chunks.push(chunk)
    }
    let name = ''
    try { name = decodeURIComponent(String(res.headers['x-file-name'] || '')) } catch {}
    return {
      buffer: Buffer.concat(chunks, total),
      contentType: String(res.headers['content-type'] || ''),
      name
    }
  }

  async downloadFile(id, targetPath, { onProgress, signal } = {}) {
    const res = await requestRaw({
      base: this.base,
      method: 'GET',
      pathname: `/api/files/${encodeURIComponent(id)}/download`,
      headers: { Accept: 'application/octet-stream', Authorization: 'Bearer ' + this.token },
      expectedFingerprint: this.fingerprint,
      timeoutMs: 0,
      signal
    })
    const total = Number(res.headers['content-length']) || 0
    const expectedSha1 = String(res.headers['x-file-sha1'] || '').toLowerCase()
    const encodedName = String(res.headers['x-file-name'] || '')
    let fileName = ''
    try { fileName = decodeURIComponent(encodedName) } catch { fileName = encodedName }
    await fsp.mkdir(path.dirname(targetPath), { recursive: true })
    const tmp = targetPath + '.part'
    const hash = crypto.createHash('sha1')
    let loaded = 0
    const out = fs.createWriteStream(tmp)
    try {
      for await (const chunk of res) {
        loaded += chunk.length
        hash.update(chunk)
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve))
        onProgress?.({ loaded, total, ratio: total ? loaded / total : 0 })
      }
      await new Promise((resolve, reject) => out.end((error) => error ? reject(error) : resolve()))
      const actual = hash.digest('hex')
      if (expectedSha1 && actual !== expectedSha1) {
        await fsp.rm(tmp, { force: true })
        throw Object.assign(new Error('下载文件 SHA-1 校验失败'), { code: 'HASH_MISMATCH' })
      }
      await fsp.rename(tmp, targetPath)
      return { path: targetPath, size: loaded, sha1: actual, name: fileName }
    } catch (error) {
      try { out.destroy() } catch {}
      await fsp.rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  }
}

export async function probeFriendsServer(url) {
  const client = new FriendsServerClient({ url, fingerprint: '' })
  return await client.probe()
}
