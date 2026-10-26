// 已接收文件：一键清除全部接收记录，同时清理默认接收目录里的暂存文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ClientStore } from '../src/server/friends/client-store.js'

function seedConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mctb-friends-received-clear-'))
  const receivedRoot = path.join(dir, 'received')
  const savedDir = path.join(dir, 'saved')
  fs.mkdirSync(path.join(receivedRoot, 'in_a'), { recursive: true })
  fs.mkdirSync(path.join(receivedRoot, 'in_b'), { recursive: true })
  fs.mkdirSync(savedDir, { recursive: true })
  const files = {
    a: path.join(receivedRoot, 'in_a', 'a.jar'),
    b: path.join(receivedRoot, 'in_b', 'b.mrpack'),
    saved: path.join(savedDir, 'a.jar')
  }
  fs.writeFileSync(files.a, 'a')
  fs.writeFileSync(files.b, 'b')
  fs.writeFileSync(files.saved, 'saved copy')
  const config = path.join(dir, 'friends.json')
  fs.writeFileSync(config, JSON.stringify({
    v: 2,
    server: { url: 'https://builtin.example', fingerprint: 'AA:BB', requiresInvite: false },
    session: { token: '', expiresAt: 0, profile: null },
    prefs: {},
    received: [
      {
        id: 'in_a',
        kind: 'mod',
        name: 'a.jar',
        peerName: 'Alice',
        at: Date.now(),
        files: [{ name: 'a.jar', path: files.a, size: 1, sha1: 'a'.repeat(40) }]
      },
      {
        id: 'in_b',
        kind: 'pack',
        name: 'b.mrpack',
        peerName: 'Bob',
        at: Date.now(),
        files: [{ name: 'b.mrpack', path: files.b, size: 1, sha1: 'b'.repeat(40) }]
      },
      {
        // 另存到其它目录的副本不在 receivedRoot 下，清除记录时不能被删。
        id: 'in_saved',
        kind: 'mod',
        name: 'a.jar',
        peerName: 'Alice',
        at: Date.now(),
        files: [{ name: 'a.jar', path: files.saved, size: 11, sha1: 'c'.repeat(40) }]
      }
    ]
  }))
  return { dir, config, receivedRoot, files }
}

test('clearReceived：清空全部记录、删除暂存目录、保留另存文件', async (t) => {
  const seeded = seedConfig()
  const previousConfig = process.env.MC_TOOLBOX_FRIENDS_CONFIG
  const previousRoot = process.env.MC_TOOLBOX_FRIENDS_RECEIVED
  process.env.MC_TOOLBOX_FRIENDS_CONFIG = seeded.config
  process.env.MC_TOOLBOX_FRIENDS_RECEIVED = seeded.receivedRoot
  t.after(() => {
    if (previousConfig === undefined) delete process.env.MC_TOOLBOX_FRIENDS_CONFIG
    else process.env.MC_TOOLBOX_FRIENDS_CONFIG = previousConfig
    if (previousRoot === undefined) delete process.env.MC_TOOLBOX_FRIENDS_RECEIVED
    else process.env.MC_TOOLBOX_FRIENDS_RECEIVED = previousRoot
    fs.rmSync(seeded.dir, { recursive: true, force: true })
  })
  const manager = await import('../src/server/friends/manager.js?received-clear=1')

  const result = await manager.clearReceived()
  assert.deepEqual(result, { ok: true, removed: 3 })
  assert.equal(fs.existsSync(path.join(seeded.receivedRoot, 'in_a')), false, '默认接收目录的暂存文件夹应被删除')
  assert.equal(fs.existsSync(path.join(seeded.receivedRoot, 'in_b')), false)
  assert.equal(fs.existsSync(seeded.files.saved), true, '另存到其它目录的文件不受影响')
  assert.equal(JSON.parse(fs.readFileSync(seeded.config, 'utf8')).received.length, 0, '记录应落盘清空')

  // 再清一次不报错，也不会把文件恢复出来。
  assert.deepEqual(await manager.clearReceived(), { ok: true, removed: 0 })
  await manager.stopFriends()
})

test('removeReceived：单条删除同样不会动另存的副本', async (t) => {
  const seeded = seedConfig()
  const previousConfig = process.env.MC_TOOLBOX_FRIENDS_CONFIG
  const previousRoot = process.env.MC_TOOLBOX_FRIENDS_RECEIVED
  process.env.MC_TOOLBOX_FRIENDS_CONFIG = seeded.config
  process.env.MC_TOOLBOX_FRIENDS_RECEIVED = seeded.receivedRoot
  t.after(() => {
    if (previousConfig === undefined) delete process.env.MC_TOOLBOX_FRIENDS_CONFIG
    else process.env.MC_TOOLBOX_FRIENDS_CONFIG = previousConfig
    if (previousRoot === undefined) delete process.env.MC_TOOLBOX_FRIENDS_RECEIVED
    else process.env.MC_TOOLBOX_FRIENDS_RECEIVED = previousRoot
    fs.rmSync(seeded.dir, { recursive: true, force: true })
  })
  const manager = await import('../src/server/friends/manager.js?received-clear=2')
  assert.equal(await manager.removeReceived('in_saved'), true)
  assert.equal(fs.existsSync(seeded.files.saved), true)
  assert.equal(await manager.removeReceived('in_a'), true)
  assert.equal(fs.existsSync(path.join(seeded.receivedRoot, 'in_a')), false)
  await manager.stopFriends()
  assert.equal(JSON.parse(fs.readFileSync(seeded.config, 'utf8')).received.length, 1)
})

test('ClientStore.clearReceived：只清记录并返回条数', async () => {
  const seeded = seedConfig()
  try {
    const store = new ClientStore(seeded.config, { logger: { warn() {} } })
    assert.equal(store.get().received.length, 3)
    assert.equal(store.clearReceived(), 3)
    assert.equal(store.get().received.length, 0)
    await store.flush()
    assert.equal(JSON.parse(fs.readFileSync(seeded.config, 'utf8')).received.length, 0)
    assert.equal(store.clearReceived(), 0)
  } finally {
    fs.rmSync(seeded.dir, { recursive: true, force: true })
  }
})
