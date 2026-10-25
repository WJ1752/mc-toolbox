// 内置好友服务器：默认值、开发覆盖与锁定行为。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BUILTIN_FRIENDS_SERVER, resolveFriendsServer, sameFriendsServer } from '../src/server/friends/config.js'

test('发布版默认使用内置地址与指纹', () => {
  const server = resolveFriendsServer({})
  assert.equal(server.url, 'https://139.224.132.80')
  assert.equal(server.fingerprint, BUILTIN_FRIENDS_SERVER.fingerprint)
  assert.equal(server.locked, true)
  assert.equal(server.requiresInvite, true)
})

test('开发环境变量只用于临时覆盖，并规范化末尾斜杠', () => {
  const server = resolveFriendsServer({
    MC_TOOLBOX_FRIENDS_SERVER: 'http://127.0.0.1:8898/',
    MC_TOOLBOX_FRIENDS_FINGERPRINT: '',
    MC_TOOLBOX_FRIENDS_INVITE_REQUIRED: '0'
  })
  assert.equal(server.url, 'http://127.0.0.1:8898')
  assert.equal(server.fingerprint, '')
  assert.equal(server.requiresInvite, false)
})

test('服务器比较会归一化指纹并区分邀请码设置', () => {
  const a = { url: 'https://example.com', fingerprint: 'AA:BB:CC', requiresInvite: true }
  assert.equal(sameFriendsServer(a, { ...a, fingerprint: 'aa bb cc' }), true)
  assert.equal(sameFriendsServer(a, { ...a, url: 'https://other.example' }), false)
  assert.equal(sameFriendsServer(a, { ...a, requiresInvite: false }), false)
})

test('管理器会用内置值覆盖旧配置里的自定义服务器', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mctb-friends-lock-'))
  const config = path.join(dir, 'friends.json')
  fs.writeFileSync(config, JSON.stringify({
    v: 2,
    server: { url: 'https://evil.example', fingerprint: '00:11:22', requiresInvite: false },
    session: { token: 'stale-token', expiresAt: Date.now() + 86400000, profile: { mcName: 'Stale' } },
    prefs: {}, received: []
  }))
  const previous = {
    config: process.env.MC_TOOLBOX_FRIENDS_CONFIG,
    server: process.env.MC_TOOLBOX_FRIENDS_SERVER,
    fingerprint: process.env.MC_TOOLBOX_FRIENDS_FINGERPRINT
  }
  process.env.MC_TOOLBOX_FRIENDS_CONFIG = config
  process.env.MC_TOOLBOX_FRIENDS_SERVER = 'https://builtin.example'
  process.env.MC_TOOLBOX_FRIENDS_FINGERPRINT = 'AA:BB:CC'
  t.after(() => {
    for (const [key, value] of [['MC_TOOLBOX_FRIENDS_CONFIG', previous.config], ['MC_TOOLBOX_FRIENDS_SERVER', previous.server], ['MC_TOOLBOX_FRIENDS_FINGERPRINT', previous.fingerprint]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const manager = await import('../src/server/friends/manager.js')
  const snap = await manager.snapshot()
  assert.equal(snap.server.locked, true)
  assert.equal(snap.server.label, '官方服务器')
  assert.equal('url' in snap.server, false)
  assert.equal('fingerprint' in snap.server, false)
  assert.equal(snap.loggedIn, false)
  await manager.stopFriends()
  const saved = JSON.parse(fs.readFileSync(config, 'utf8'))
  assert.equal(saved.server.url, 'https://builtin.example')
  assert.equal(saved.server.fingerprint, 'AA:BB:CC')
  assert.equal(saved.server.requiresInvite, true)
  assert.equal(saved.session.token, '')
})
