// 好友下载目录 / 另存为 / 通知计数：不依赖好友服务器，只覆盖管理器本地逻辑。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function seedConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mctb-friends-dl-'))
  const config = path.join(dir, 'friends.json')
  const receivedDir = path.join(dir, 'received')
  fs.mkdirSync(receivedDir, { recursive: true })
  const receivedFile = path.join(receivedDir, 'pack.mrpack')
  fs.writeFileSync(receivedFile, 'hello')
  fs.writeFileSync(config, JSON.stringify({
    v: 2,
    server: { url: 'https://builtin.example', fingerprint: 'AA:BB', requiresInvite: false },
    session: { token: '', expiresAt: 0, profile: null },
    prefs: {},
    received: [{
      id: 'in_test',
      kind: 'mod',
      name: 'example.jar',
      peerName: 'Alice',
      at: Date.now(),
      files: [{ name: 'example.jar', path: receivedFile, size: 5, sha1: 'a'.repeat(40) }]
    }]
  }))
  return { dir, config, receivedFile }
}

test('prefs 只接受绝对下载目录，相对路径被丢弃', async (t) => {
  const seeded = seedConfig()
  const previous = process.env.MC_TOOLBOX_FRIENDS_CONFIG
  process.env.MC_TOOLBOX_FRIENDS_CONFIG = seeded.config
  t.after(() => {
    if (previous === undefined) delete process.env.MC_TOOLBOX_FRIENDS_CONFIG
    else process.env.MC_TOOLBOX_FRIENDS_CONFIG = previous
  })
  const manager = await import('../src/server/friends/manager.js')

  const abs = path.join(seeded.dir, 'downloads')
  fs.mkdirSync(abs)
  const saved = await manager.saveSelf({ downloadDir: abs })
  assert.equal(saved.prefs.downloadDir, abs)

  const relative = await manager.saveSelf({ downloadDir: 'relative/downloads' })
  assert.equal(relative.prefs.downloadDir, '')

  const disabled = await manager.saveSelf({ autoApplyMods: false })
  assert.equal(disabled.prefs.autoApplyMods, false)
})

test('另存为会把文件复制到指定目录，原文件保留', async (t) => {
  const seeded = seedConfig()
  const previous = process.env.MC_TOOLBOX_FRIENDS_CONFIG
  process.env.MC_TOOLBOX_FRIENDS_CONFIG = seeded.config
  t.after(() => {
    if (previous === undefined) delete process.env.MC_TOOLBOX_FRIENDS_CONFIG
    else process.env.MC_TOOLBOX_FRIENDS_CONFIG = previous
  })
  const manager = await import('../src/server/friends/manager.js')

  const target = path.join(seeded.dir, 'save-as')
  fs.mkdirSync(target)
  const result = await manager.saveReceivedAs('in_test', { dir: target, name: 'renamed.jar' })
  assert.equal(result.name, 'renamed.jar')
  assert.equal(fs.readFileSync(result.path, 'utf8'), 'hello')
  assert.equal(fs.existsSync(seeded.receivedFile), true, '原文件不应被移动')
})

test('另存为目录不存在时给出可读错误', async (t) => {
  const seeded = seedConfig()
  const previous = process.env.MC_TOOLBOX_FRIENDS_CONFIG
  process.env.MC_TOOLBOX_FRIENDS_CONFIG = seeded.config
  t.after(() => {
    if (previous === undefined) delete process.env.MC_TOOLBOX_FRIENDS_CONFIG
    else process.env.MC_TOOLBOX_FRIENDS_CONFIG = previous
  })
  const manager = await import('../src/server/friends/manager.js')
  await assert.rejects(
    () => manager.saveReceivedAs('in_test', { dir: path.join(seeded.dir, 'missing'), name: 'x.jar' }),
    /目录不存在/
  )
  await assert.rejects(() => manager.saveReceivedAs('nope', { dir: seeded.dir }), /接收记录不存在/)
})

test('未登录时通知计数归零，清理已完成传输不报错', async (t) => {
  const seeded = seedConfig()
  const previous = process.env.MC_TOOLBOX_FRIENDS_CONFIG
  process.env.MC_TOOLBOX_FRIENDS_CONFIG = seeded.config
  t.after(() => {
    if (previous === undefined) delete process.env.MC_TOOLBOX_FRIENDS_CONFIG
    else process.env.MC_TOOLBOX_FRIENDS_CONFIG = previous
  })
  const manager = await import('../src/server/friends/manager.js')
  const notify = await manager.notifications()
  assert.equal(notify.loggedIn, false)
  assert.equal(notify.requests, 0)
  assert.equal(notify.unread, 0)
  assert.equal(notify.incoming, 0)

  assert.deepEqual(manager.clearFinishedTransfers(), { ok: true, removed: 0 })
})

test('模组接收记录在本地配置里保留 kind 与实例信息', async (t) => {
  const seeded = seedConfig()
  const { ClientStore } = await import('../src/server/friends/client-store.js')
  const store = new ClientStore(seeded.config, { logger: { warn() {} } })
  const state = store.get()
  assert.equal(state.received[0].kind, 'mod')
  assert.equal(state.prefs.downloadDir, '')

  store.addReceived({ ...state.received[0], instanceId: 'inst_1', instanceName: '示例实例' })
  // 同 id 覆盖，不产生重复记录。
  assert.equal(store.get().received.length, 1)
  assert.equal(store.get().received[0].instanceName, '示例实例')
})
