// 中心好友服务器：MC 令牌校验、好友、离线聊天、临时文件中转与模组清单。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createFriendsServer } from '../tools/friends-server.mjs'

const quiet = { log() {}, warn() {}, error() {} }
const UUID_A = 'aaaaaaaa-1111-2222-3333-444444444444'
const UUID_B = 'bbbbbbbb-1111-2222-3333-444444444444'
const UUID_C = 'cccccccc-1111-2222-3333-444444444444'

const verifier = async (token) => {
  if (token === 'token-alice') return { uuid: UUID_A, name: 'Alice' }
  if (token === 'token-bob') return { uuid: UUID_B, name: 'Bob' }
  if (token === 'token-carol') return { uuid: UUID_C, name: 'Carol' }
  const error = new Error('正版令牌无效或已过期，请重新登录微软账户')
  error.code = 'MC_AUTH_FAILED'
  throw error
}

async function startServer(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mctb-friends-srv-'))
  const server = createFriendsServer({
    dataDir,
    http: true,
    verifyMinecraft: verifier,
    logger: quiet,
    ...overrides
  })
  await server.ready()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    server,
    dataDir,
    base,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    store: server.store
  }
}

async function api(base, method, pathname, { token = '', body, raw, headers = {} } = {}) {
  const init = { method, headers: { ...headers } }
  if (token) init.headers.Authorization = 'Bearer ' + token
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  if (raw) init.body = raw
  const response = await fetch(base + pathname, init)
  const type = response.headers.get('content-type') || ''
  if (type.includes('application/json')) {
    const data = await response.json()
    return { status: response.status, data }
  }
  return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()) }
}

async function login(base, token, extra = {}) {
  const result = await api(base, 'POST', '/api/auth/minecraft', { body: { accessToken: token, ...extra } })
  assert.equal(result.status, 200, result.data?.error)
  return result.data
}

async function waitFor(check, timeout = 2000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}

test('健康检查与 MC 令牌校验登录', async (t) => {
  const ctx = await startServer()
  t.after(() => ctx.close())
  const health = await api(ctx.base, 'GET', '/api/health')
  assert.equal(health.status, 200)
  assert.equal(health.data.ok, true)
  assert.equal(health.data.name, 'mc-toolbox-friends')

  const bad = await api(ctx.base, 'POST', '/api/auth/minecraft', { body: { accessToken: 'bad' } })
  assert.equal(bad.status, 401)
  assert.match(bad.data.error, /正版令牌/)

  const loginA = await login(ctx.base, 'token-alice')
  assert.equal(loginA.profile.mcName, 'Alice')
  assert.equal(loginA.profile.nickname, 'Alice')
  assert.ok(loginA.token.length > 20)
  assert.ok(loginA.expiresAt > Date.now())

  const me = await api(ctx.base, 'GET', '/api/friends', { token: loginA.token })
  assert.equal(me.status, 200)
  assert.equal(me.data.profile.mcName, 'Alice')
  assert.deepEqual(me.data.friends, [])
})

test('邀请码只限制新账户，已注册账户可直接登录', async (t) => {
  const ctx = await startServer({ invite: 'open-sesame' })
  t.after(() => ctx.close())
  const denied = await api(ctx.base, 'POST', '/api/auth/minecraft', { body: { accessToken: 'token-alice' } })
  assert.equal(denied.status, 403)
  assert.equal(denied.data.code, 'INVITE_REQUIRED')

  const ok = await api(ctx.base, 'POST', '/api/auth/minecraft', { body: { accessToken: 'token-alice', invite: 'open-sesame' } })
  assert.equal(ok.status, 200)
  const again = await api(ctx.base, 'POST', '/api/auth/minecraft', { body: { accessToken: 'token-alice' } })
  assert.equal(again.status, 200)
})

test('好友请求、接受、昵称与在线状态', async (t) => {
  const ctx = await startServer()
  t.after(() => ctx.close())
  const a = await login(ctx.base, 'token-alice')
  const b = await login(ctx.base, 'token-bob')

  const missing = await api(ctx.base, 'POST', '/api/friends/request', { token: a.token, body: { mcName: 'Nobody' } })
  assert.equal(missing.status, 404)

  const request = await api(ctx.base, 'POST', '/api/friends/request', { token: a.token, body: { mcName: 'bob' } })
  assert.equal(request.status, 200)

  const bFriends = await api(ctx.base, 'GET', '/api/friends', { token: b.token })
  assert.equal(bFriends.data.incoming.length, 1)
  assert.equal(bFriends.data.incoming[0].mcName, 'Alice')
  assert.equal(bFriends.data.incoming[0].online, true)

  const respond = await api(ctx.base, 'POST', '/api/friends/respond', { token: b.token, body: { uuid: UUID_A, accept: true } })
  assert.equal(respond.status, 200)

  const aList = await api(ctx.base, 'GET', '/api/friends', { token: a.token })
  assert.equal(aList.data.friends.length, 1)
  assert.equal(aList.data.friends[0].mcName, 'Bob')
  assert.equal(aList.data.friends[0].online, true)

  const renamed = await api(ctx.base, 'PUT', '/api/me', { token: a.token, body: { nickname: '爱丽丝' } })
  assert.equal(renamed.status, 200)
  const bAgain = await api(ctx.base, 'GET', '/api/friends', { token: b.token })
  assert.equal(bAgain.data.friends[0].nickname, '爱丽丝')
  assert.equal(bAgain.data.friends[0].mcName, 'Alice')

  const remove = await api(ctx.base, 'DELETE', '/api/friends/' + UUID_B, { token: a.token })
  assert.equal(remove.status, 200)
  const empty = await api(ctx.base, 'GET', '/api/friends', { token: a.token })
  assert.equal(empty.data.friends.length, 0)
})

test('聊天：离线消息、未读、已读与好友校验', async (t) => {
  const ctx = await startServer()
  t.after(() => ctx.close())
  const a = await login(ctx.base, 'token-alice')
  const b = await login(ctx.base, 'token-bob')
  await api(ctx.base, 'POST', '/api/friends/request', { token: a.token, body: { mcName: 'Bob' } })
  await api(ctx.base, 'POST', '/api/friends/respond', { token: b.token, body: { uuid: UUID_A, accept: true } })

  const sent = await api(ctx.base, 'POST', '/api/messages', { token: a.token, body: { to: UUID_B, text: '晚上八点开服？', clientId: 'm_abcdefgh' } })
  assert.equal(sent.status, 200)
  assert.equal(sent.data.message.text, '晚上八点开服？')

  const dup = await api(ctx.base, 'POST', '/api/messages', { token: a.token, body: { to: UUID_B, text: '重复', clientId: 'm_abcdefgh' } })
  assert.equal(dup.status, 200)
  assert.equal(dup.data.message.text, '晚上八点开服？')

  const inbox = await api(ctx.base, 'GET', `/api/messages?with=${UUID_A}`, { token: b.token })
  assert.equal(inbox.data.items.length, 1)
  assert.equal(inbox.data.unread, 1)
  assert.equal(inbox.data.peer.mcName, 'Alice')

  await api(ctx.base, 'POST', '/api/read', { token: b.token, body: { with: UUID_A, upTo: Date.now() } })
  const read = await api(ctx.base, 'GET', `/api/messages?with=${UUID_A}`, { token: b.token })
  assert.equal(read.data.unread, 0)

  const reply = await api(ctx.base, 'POST', '/api/messages', { token: b.token, body: { to: UUID_A, text: '好，我来' } })
  assert.equal(reply.status, 200)
  const aInbox = await api(ctx.base, 'GET', `/api/messages?with=${UUID_B}&after=${sent.data.message.at}`, { token: a.token })
  assert.equal(aInbox.data.items.length, 1)
  assert.equal(aInbox.data.items[0].text, '好，我来')

  const stranger = await api(ctx.base, 'POST', '/api/messages', { token: a.token, body: { to: 'cccccccc-1111-2222-3333-444444444444', text: 'hi' } })
  assert.equal(stranger.status, 404)
})

test('临时文件中转：创建、上传、下载后删除', async (t) => {
  const ctx = await startServer()
  t.after(() => ctx.close())
  const a = await login(ctx.base, 'token-alice')
  const b = await login(ctx.base, 'token-bob')
  await api(ctx.base, 'POST', '/api/friends/request', { token: a.token, body: { mcName: 'Bob' } })
  await api(ctx.base, 'POST', '/api/friends/respond', { token: b.token, body: { uuid: UUID_A, accept: true } })

  const content = Buffer.from('fake mrpack bytes')
  const sha1 = crypto.createHash('sha1').update(content).digest('hex')
  const created = await api(ctx.base, 'POST', '/api/files', {
    token: a.token,
    body: { to: UUID_B, kind: 'pack', name: '测试包.mrpack', size: content.length, sha1 }
  })
  assert.equal(created.status, 201)
  const fileId = created.data.file.id

  const upload = await api(ctx.base, 'PUT', '/api/files/' + fileId, {
    token: a.token,
    raw: content,
    headers: { 'Content-Length': String(content.length) }
  })
  assert.equal(upload.status, 200, upload.data?.error)

  const incoming = await api(ctx.base, 'GET', '/api/files', { token: b.token })
  assert.equal(incoming.data.incoming.length, 1)
  assert.equal(incoming.data.incoming[0].status, 'ready')
  assert.equal(incoming.data.incoming[0].name, '测试包.mrpack')

  const download = await api(ctx.base, 'GET', `/api/files/${fileId}/download`, { token: b.token })
  assert.equal(download.status, 200)
  assert.deepEqual(download.buffer, content)

  const after = await api(ctx.base, 'GET', '/api/files', { token: b.token })
  assert.equal(after.data.incoming[0].status, 'delivered')

  // 模拟传输完成后的清理时间到达。
  const record = ctx.store.files.get(fileId)
  assert.ok(record)
  record.deleteAt = Date.now() - 1
  await ctx.store.cleanup()
  assert.equal(ctx.store.files.has(fileId), false)
  assert.equal(fs.existsSync(path.join(ctx.dataDir, 'files', fileId + '.bin')), false)
})

test('上传校验：哈希不符或越权取消都会被拒绝', async (t) => {
  const ctx = await startServer()
  t.after(() => ctx.close())
  const a = await login(ctx.base, 'token-alice')
  const b = await login(ctx.base, 'token-bob')
  await api(ctx.base, 'POST', '/api/friends/request', { token: a.token, body: { mcName: 'Bob' } })
  await api(ctx.base, 'POST', '/api/friends/respond', { token: b.token, body: { uuid: UUID_A, accept: true } })
  const content = Buffer.from('abc')
  const sha1 = crypto.createHash('sha1').update(content).digest('hex')
  const created = await api(ctx.base, 'POST', '/api/files', {
    token: a.token,
    body: { to: UUID_B, kind: 'mod', name: 'a.jar', size: content.length, sha1 }
  })
  const fileId = created.data.file.id
  const bad = await api(ctx.base, 'PUT', '/api/files/' + fileId, {
    token: a.token,
    raw: Buffer.from('abd'),
    headers: { 'Content-Length': '3' }
  })
  assert.equal(bad.status, 400)
  assert.equal(ctx.store.files.has(fileId), false)

  const created2 = await api(ctx.base, 'POST', '/api/files', {
    token: a.token,
    body: { to: UUID_B, kind: 'mod', name: 'a.jar', size: 3, sha1 }
  })
  const deny = await api(ctx.base, 'DELETE', '/api/files/' + created2.data.file.id, { token: b.token })
  assert.equal(deny.status, 404)
})

test('配额限制与文件名消毒：超限时删除自己的旧文件', async (t) => {
  const ctx = await startServer({ quotaPerUser: 100, globalQuota: 1000 })
  t.after(() => ctx.close())
  const a = await login(ctx.base, 'token-alice')
  const b = await login(ctx.base, 'token-bob')
  await api(ctx.base, 'POST', '/api/friends/request', { token: a.token, body: { mcName: 'Bob' } })
  await api(ctx.base, 'POST', '/api/friends/respond', { token: b.token, body: { uuid: UUID_A, accept: true } })
  const sha1 = 'a'.repeat(40)
  const first = await api(ctx.base, 'POST', '/api/files', {
    token: a.token,
    body: { to: UUID_B, kind: 'pack', name: '../../evil.mrpack', size: 80, sha1 }
  })
  assert.equal(first.status, 201)
  assert.equal(first.data.file.name, 'evil.mrpack')
  const firstId = first.data.file.id
  const second = await api(ctx.base, 'POST', '/api/files', {
    token: a.token,
    body: { to: UUID_B, kind: 'pack', name: 'b', size: 40, sha1 }
  })
  // 新文件放得下：旧的 80 字节文件被自动清掉，而不是直接报配额已满。
  assert.equal(second.status, 201)
  assert.equal(ctx.store.files.has(firstId), false)
  assert.equal(fs.existsSync(path.join(ctx.dataDir, 'files', firstId + '.bin')), false)
})

test('总缓存上限：任何人的旧文件都会被删除以腾出空间', async (t) => {
  const ctx = await startServer({ quotaPerUser: 1000, globalQuota: 100 })
  t.after(() => ctx.close())
  const a = await login(ctx.base, 'token-alice')
  const b = await login(ctx.base, 'token-bob')
  await api(ctx.base, 'POST', '/api/friends/request', { token: a.token, body: { mcName: 'Bob' } })
  await api(ctx.base, 'POST', '/api/friends/respond', { token: b.token, body: { uuid: UUID_A, accept: true } })
  const sha1 = 'a'.repeat(40)
  const first = await api(ctx.base, 'POST', '/api/files', {
    token: a.token,
    body: { to: UUID_B, kind: 'pack', name: 'old.mrpack', size: 80, sha1 }
  })
  assert.equal(first.status, 201)
  const second = await api(ctx.base, 'POST', '/api/files', {
    token: b.token,
    body: { to: UUID_A, kind: 'mod', name: 'new.jar', size: 80, sha1 }
  })
  assert.equal(second.status, 201)
  assert.equal(ctx.store.files.has(first.data.file.id), false)
  assert.equal(ctx.store.usedBytes(), 80)
})

test('文件缓存最长 12 小时，过期后清理', async (t) => {
  const ctx = await startServer()
  t.after(() => ctx.close())
  const a = await login(ctx.base, 'token-alice')
  const b = await login(ctx.base, 'token-bob')
  await api(ctx.base, 'POST', '/api/friends/request', { token: a.token, body: { mcName: 'Bob' } })
  await api(ctx.base, 'POST', '/api/friends/respond', { token: b.token, body: { uuid: UUID_A, accept: true } })
  const created = await api(ctx.base, 'POST', '/api/files', {
    token: a.token,
    body: { to: UUID_B, kind: 'pack', name: 'ttl.mrpack', size: 10, sha1: 'a'.repeat(40) }
  })
  const file = ctx.store.files.get(created.data.file.id)
  assert.ok(file.expiresAt - file.createdAt <= 12 * 60 * 60 * 1000 + 1000)
  file.expiresAt = Date.now() - 1
  await ctx.store.cleanup()
  assert.equal(ctx.store.files.has(file.id), false)
})

test('群聊：创建、拉人、消息、未读与已读', async (t) => {
  const ctx = await startServer()
  t.after(() => ctx.close())
  const a = await login(ctx.base, 'token-alice')
  const b = await login(ctx.base, 'token-bob')
  const c = await login(ctx.base, 'token-carol')
  await api(ctx.base, 'POST', '/api/friends/request', { token: a.token, body: { mcName: 'Bob' } })
  await api(ctx.base, 'POST', '/api/friends/respond', { token: b.token, body: { uuid: UUID_A, accept: true } })
  await api(ctx.base, 'POST', '/api/friends/request', { token: a.token, body: { mcName: 'Carol' } })
  await api(ctx.base, 'POST', '/api/friends/respond', { token: c.token, body: { uuid: UUID_A, accept: true } })

  const created = await api(ctx.base, 'POST', '/api/groups', {
    token: a.token,
    body: { name: '周末开荒', members: [UUID_B, UUID_C] }
  })
  assert.equal(created.status, 200, created.data?.error)
  const groupId = created.data.group.id
  assert.equal(created.data.group.members.length, 3)

  const bGroups = await api(ctx.base, 'GET', '/api/friends', { token: b.token })
  assert.equal(bGroups.data.groups.length, 1)
  assert.equal(bGroups.data.groups[0].unread, 0)

  const sent = await api(ctx.base, 'POST', `/api/groups/${groupId}/messages`, {
    token: a.token,
    body: { text: '晚上八点集合', clientId: 'm_group1' }
  })
  assert.equal(sent.status, 200, sent.data?.error)

  const bList = await api(ctx.base, 'GET', '/api/groups', { token: b.token })
  assert.equal(bList.data.groups[0].unread, 1)
  const bInbox = await api(ctx.base, 'GET', `/api/groups/${groupId}/messages?markRead=1`, { token: b.token })
  assert.equal(bInbox.data.items.length, 1)
  assert.equal(bInbox.data.items[0].text, '晚上八点集合')
  assert.equal(bInbox.data.unread, 0)

  const reply = await api(ctx.base, 'POST', `/api/groups/${groupId}/messages`, { token: b.token, body: { text: '收到' } })
  assert.equal(reply.status, 200)
  const aInbox = await api(ctx.base, 'GET', `/api/groups/${groupId}/messages?after=${sent.data.message.at}`, { token: a.token })
  assert.equal(aInbox.data.items.length, 1)
  assert.equal(aInbox.data.items[0].text, '收到')

  const removed = await api(ctx.base, 'DELETE', `/api/groups/${groupId}/members/${UUID_C}`, { token: a.token })
  assert.equal(removed.status, 200)
  const denied = await api(ctx.base, 'GET', `/api/groups/${groupId}/messages`, { token: c.token })
  assert.equal(denied.status, 404)
})

test('群发文件：好友与群聊一起发，按收件人分别记录送达', async (t) => {
  const ctx = await startServer()
  t.after(() => ctx.close())
  const a = await login(ctx.base, 'token-alice')
  const b = await login(ctx.base, 'token-bob')
  const c = await login(ctx.base, 'token-carol')
  for (const peer of [{ token: b.token, uuid: UUID_A, name: 'Bob' }, { token: c.token, uuid: UUID_A, name: 'Carol' }]) {
    await api(ctx.base, 'POST', '/api/friends/request', { token: a.token, body: { mcName: peer.name } })
    await api(ctx.base, 'POST', '/api/friends/respond', { token: peer.token, body: { uuid: peer.uuid, accept: true } })
  }
  const group = await api(ctx.base, 'POST', '/api/groups', { token: a.token, body: { name: '开荒组', members: [UUID_B, UUID_C] } })
  const groupId = group.data.group.id
  const content = Buffer.from('broadcast pack')
  const sha1 = crypto.createHash('sha1').update(content).digest('hex')
  const created = await api(ctx.base, 'POST', '/api/files', {
    token: a.token,
    body: {
      targets: [{ type: 'friend', id: UUID_B }, { type: 'group', id: groupId }],
      kind: 'pack',
      name: '群发.mrpack',
      size: content.length,
      sha1
    }
  })
  assert.equal(created.status, 201, created.data?.error)
  const fileId = created.data.file.id
  assert.equal(created.data.file.broadcast, true)
  assert.equal(created.data.file.recipientCount, 2)

  const upload = await api(ctx.base, 'PUT', '/api/files/' + fileId, {
    token: a.token,
    raw: content,
    headers: { 'Content-Length': String(content.length) }
  })
  assert.equal(upload.status, 200)

  const bIncoming = await api(ctx.base, 'GET', '/api/files', { token: b.token })
  assert.equal(bIncoming.data.incoming.length, 1)
  assert.equal(bIncoming.data.incoming[0].broadcast, true)
  assert.equal(bIncoming.data.incoming[0].targets.length, 2)

  const firstDownload = await api(ctx.base, 'GET', `/api/files/${fileId}/download`, { token: b.token })
  assert.deepEqual(firstDownload.buffer, content)
  const cIncoming = await api(ctx.base, 'GET', '/api/files', { token: c.token })
  assert.equal(cIncoming.data.incoming[0].status, 'ready')
  assert.equal(ctx.store.files.get(fileId).deleteAt, undefined)
  const secondDownload = await api(ctx.base, 'GET', `/api/files/${fileId}/download`, { token: c.token })
  assert.deepEqual(secondDownload.buffer, content)
  assert.equal(await waitFor(() => ctx.store.files.get(fileId)?.deleteAt > Date.now()), true)
})

test('聊天图片：附件消息、群成员可看、不因单人下载提前删除', async (t) => {
  const ctx = await startServer()
  t.after(() => ctx.close())
  const a = await login(ctx.base, 'token-alice')
  const b = await login(ctx.base, 'token-bob')
  const c = await login(ctx.base, 'token-carol')
  for (const peer of [{ token: b.token, uuid: UUID_A, name: 'Bob' }, { token: c.token, uuid: UUID_A, name: 'Carol' }]) {
    await api(ctx.base, 'POST', '/api/friends/request', { token: a.token, body: { mcName: peer.name } })
    await api(ctx.base, 'POST', '/api/friends/respond', { token: peer.token, body: { uuid: peer.uuid, accept: true } })
  }
  const group = await api(ctx.base, 'POST', '/api/groups', { token: a.token, body: { name: '截图群', members: [UUID_B, UUID_C] } })
  const groupId = group.data.group.id
  const image = Buffer.from('fake png bytes')
  const sha1 = crypto.createHash('sha1').update(image).digest('hex')
  const created = await api(ctx.base, 'POST', '/api/files', {
    token: a.token,
    body: { targets: [{ type: 'group', id: groupId }], kind: 'image', name: 'steve.png', size: image.length, sha1, width: 320, height: 200 }
  })
  assert.equal(created.status, 201, created.data?.error)
  const imageId = created.data.file.id
  await api(ctx.base, 'PUT', '/api/files/' + imageId, {
    token: a.token,
    raw: image,
    headers: { 'Content-Length': String(image.length) }
  })
  const sent = await api(ctx.base, 'POST', `/api/groups/${groupId}/messages`, {
    token: a.token,
    body: { text: '', image: { id: imageId, name: 'steve.png', width: 320, height: 200, size: image.length } }
  })
  assert.equal(sent.status, 200, sent.data?.error)
  assert.equal(sent.data.message.image.id, imageId)

  const bInbox = await api(ctx.base, 'GET', `/api/groups/${groupId}/messages`, { token: b.token })
  assert.equal(bInbox.data.items.length, 1)
  assert.equal(bInbox.data.items[0].image.width, 320)

  const bImage = await api(ctx.base, 'GET', `/api/files/${imageId}/download`, { token: b.token })
  assert.deepEqual(bImage.buffer, image)
  assert.equal(await waitFor(() => ctx.store.files.get(imageId)?.status === 'ready'), true)
  const record = ctx.store.files.get(imageId)
  assert.equal(record.status, 'ready')
  assert.equal(record.deleteAt, undefined)
  const cImage = await api(ctx.base, 'GET', `/api/files/${imageId}/download`, { token: c.token })
  assert.deepEqual(cImage.buffer, image)
  assert.equal(await waitFor(() => ctx.store.files.get(imageId)?.status === 'ready'), true)
  assert.equal(ctx.store.files.get(imageId).deleteAt, undefined)
})

test('模组清单：自己可写，好友可读，陌生人不可读', async (t) => {
  const ctx = await startServer()
  t.after(() => ctx.close())
  const a = await login(ctx.base, 'token-alice')
  const b = await login(ctx.base, 'token-bob')
  const sha1 = 'b'.repeat(40)
  const put = await api(ctx.base, 'PUT', '/api/mods/inst-1', {
    token: a.token,
    body: {
      instance: { name: 'SkyFactory', mc: '1.20.1', loader: 'fabric' },
      items: [{ file: 'jei.jar', size: 10, sha1, modid: 'jei', name: 'JEI', version: '1', enabled: true }]
    }
  })
  assert.equal(put.status, 200)
  assert.equal(put.data.count, 1)

  const own = await api(ctx.base, 'GET', '/api/mods?uuid=' + UUID_A, { token: a.token })
  assert.equal(own.data.instances['inst-1'].items[0].modid, 'jei')

  const denied = await api(ctx.base, 'GET', '/api/mods?uuid=' + UUID_A, { token: b.token })
  assert.equal(denied.status, 404)

  await api(ctx.base, 'POST', '/api/friends/request', { token: a.token, body: { mcName: 'Bob' } })
  await api(ctx.base, 'POST', '/api/friends/respond', { token: b.token, body: { uuid: UUID_A, accept: true } })
  const allowed = await api(ctx.base, 'GET', '/api/mods?uuid=' + UUID_A, { token: b.token })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.data.instances['inst-1'].items[0].sha1, sha1)
})

test('会话失效与心跳活动', async (t) => {
  const ctx = await startServer()
  t.after(() => ctx.close())
  const a = await login(ctx.base, 'token-alice')
  const unauthorized = await api(ctx.base, 'GET', '/api/friends', { token: 'not-a-token' })
  assert.equal(unauthorized.status, 401)

  const beat = await api(ctx.base, 'POST', '/api/heartbeat', {
    token: a.token,
    body: { activity: { instanceName: 'SkyFactory', mc: '1.20.1', loader: 'fabric', since: 1 } }
  })
  assert.equal(beat.status, 200)
  const me = await api(ctx.base, 'GET', '/api/friends', { token: a.token })
  assert.equal(me.data.profile.activity.instanceName, 'SkyFactory')

  await api(ctx.base, 'POST', '/api/auth/logout', { token: a.token })
  const afterLogout = await api(ctx.base, 'GET', '/api/friends', { token: a.token })
  assert.equal(afterLogout.status, 401)
})
