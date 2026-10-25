// 客户端与自签 HTTPS 服务器：指纹探测、固定、登录、上传下载。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createFriendsServer } from '../tools/friends-server.mjs'
import { FriendsServerClient, normalizeFingerprint, probeFriendsServer } from '../src/server/friends/server-client.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CERT = path.join(here, 'fixtures', 'friends-test-cert.pem')
const KEY = path.join(here, 'fixtures', 'friends-test-key.pem')
const UUID_A = 'aaaaaaaa-1111-2222-3333-444444444444'
const UUID_B = 'bbbbbbbb-1111-2222-3333-444444444444'
const quiet = { log() {}, warn() {}, error() {} }

const verifier = async (token) => {
  if (token === 'token-alice') return { uuid: UUID_A, name: 'Alice' }
  if (token === 'token-bob') return { uuid: UUID_B, name: 'Bob' }
  throw new Error('正版令牌无效')
}

function certificateFingerprint() {
  return new crypto.X509Certificate(fs.readFileSync(CERT)).fingerprint256
}

async function startTlsServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mctb-friends-tls-'))
  const server = createFriendsServer({
    dataDir,
    tls: { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) },
    verifyMinecraft: verifier,
    logger: quiet
  })
  await server.ready()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    dataDir,
    url: `https://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mctb-friends-client-'))

test('探测自签服务器并固定指纹', async (t) => {
  const ctx = await startTlsServer()
  t.after(() => ctx.close())
  const result = await probeFriendsServer(ctx.url)
  assert.equal(result.health.name, 'mc-toolbox-friends')
  assert.equal(normalizeFingerprint(result.fingerprint), normalizeFingerprint(certificateFingerprint()))

  const client = new FriendsServerClient({ url: ctx.url, fingerprint: result.fingerprint })
  const health = await client.request('GET', '/api/health')
  assert.equal(health.ok, true)
})

test('指纹不匹配时拒绝请求', async (t) => {
  const ctx = await startTlsServer()
  t.after(() => ctx.close())
  const client = new FriendsServerClient({
    url: ctx.url,
    fingerprint: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
  })
  await assert.rejects(() => client.request('GET', '/api/health'), /证书指纹不匹配/)
})

test('公网 HTTP 被拒绝，localhost 允许（测试/本机）', () => {
  assert.throws(() => new FriendsServerClient({ url: 'http://example.com' }), /必须使用 https/)
  assert.doesNotThrow(() => new FriendsServerClient({ url: 'http://127.0.0.1:8080' }))
})

test('登录、好友与聊天走 HTTPS', async (t) => {
  const ctx = await startTlsServer()
  t.after(() => ctx.close())
  const probe = await probeFriendsServer(ctx.url)
  const a = new FriendsServerClient({ url: ctx.url, fingerprint: probe.fingerprint })
  const b = new FriendsServerClient({ url: ctx.url, fingerprint: probe.fingerprint })
  const loginA = await a.request('POST', '/api/auth/minecraft', { body: { accessToken: 'token-alice' } })
  const loginB = await b.request('POST', '/api/auth/minecraft', { body: { accessToken: 'token-bob' } })
  a.token = loginA.token
  b.token = loginB.token
  assert.equal(loginA.profile.mcName, 'Alice')

  await a.request('POST', '/api/friends/request', { body: { mcName: 'Bob' } })
  await b.request('POST', '/api/friends/respond', { body: { uuid: UUID_A, accept: true } })
  const list = await a.request('GET', '/api/friends')
  assert.equal(list.friends.length, 1)
  assert.equal(list.friends[0].mcName, 'Bob')

  await a.request('POST', '/api/messages', { body: { to: UUID_B, text: '你好', clientId: 'm_abcdefgh' } })
  const inbox = await b.request('GET', `/api/messages?with=${UUID_A}`)
  assert.equal(inbox.items.length, 1)
  assert.equal(inbox.items[0].text, '你好')
})

test('HTTPS 上传与下载文件并按 SHA-1 校验', async (t) => {
  const ctx = await startTlsServer()
  t.after(() => ctx.close())
  const probe = await probeFriendsServer(ctx.url)
  const a = new FriendsServerClient({ url: ctx.url, fingerprint: probe.fingerprint })
  const b = new FriendsServerClient({ url: ctx.url, fingerprint: probe.fingerprint })
  a.token = (await a.request('POST', '/api/auth/minecraft', { body: { accessToken: 'token-alice' } })).token
  b.token = (await b.request('POST', '/api/auth/minecraft', { body: { accessToken: 'token-bob' } })).token
  await a.request('POST', '/api/friends/request', { body: { mcName: 'Bob' } })
  await b.request('POST', '/api/friends/respond', { body: { uuid: UUID_A, accept: true } })

  const source = path.join(tmpdir(), 'pack.mrpack')
  const content = crypto.randomBytes(64 * 1024)
  fs.writeFileSync(source, content)
  const sha1 = crypto.createHash('sha1').update(content).digest('hex')
  const created = await a.request('POST', '/api/files', {
    body: { to: UUID_B, kind: 'pack', name: 'pack.mrpack', size: content.length, sha1 }
  })
  let uploaded = 0
  await a.uploadFile(created.file.id, source, { onProgress: ({ loaded }) => { uploaded = loaded } })
  assert.equal(uploaded, content.length)

  const incoming = await b.request('GET', '/api/files')
  assert.equal(incoming.incoming[0].status, 'ready')
  const target = path.join(tmpdir(), 'downloaded.mrpack')
  let downloaded = 0
  const result = await b.downloadFile(created.file.id, target, { onProgress: ({ loaded }) => { downloaded = loaded } })
  assert.equal(result.sha1, sha1)
  assert.equal(downloaded, content.length)
  assert.deepEqual(await fsp.readFile(target), content)
})
