import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { makeZip } from './helpers/zip.mjs'

test('隔离整合包升级 API：旧实例绑定、审阅、取消、确认新实例并保留玩家设置', async t => {
  const { createHash } = await import('node:crypto')
  const { setTimeout: sleep } = await import('node:timers/promises')
  const { store } = await import('../src/server/store.js')
  const { createInstance, findInstance, instancePaths } = await import('../src/server/launcher/state.js')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mtb-update-integration-'))
  const state = { layoutVersion: 2, settings: { root, source: 'official', retries: 0 }, instances: [] }
  const oldRoot = process.env.MC_TOOLBOX_LAUNCHER_ROOT
  process.env.MC_TOOLBOX_LAUNCHER_ROOT = root
  t.after(async () => {
    if (oldRoot === undefined) delete process.env.MC_TOOLBOX_LAUNCHER_ROOT
    else process.env.MC_TOOLBOX_LAUNCHER_ROOT = oldRoot
    await fs.rm(root, { recursive: true, force: true })
  })
  t.mock.method(store, 'get', (key, fallback) => key === 'launcher' ? state : fallback)
  t.mock.method(store, 'set', () => {})
  const mc = '1.20.1'
  const archive = makeZip([
    ['modrinth.index.json', JSON.stringify({ name: 'Test', dependencies: { minecraft: mc }, files: [] })],
    ['overrides/mods/new.jar', 'new'], ['overrides/options.txt', 'version:2\nkey_jump:default\n']
  ])
  const hash = createHash('sha1').update(archive).digest('hex')
  const remote = id => ({
    id, project_id: 'project', name: id, version_number: id, version_type: 'release',
    date_published: id === 'old' ? '2026-01-01' : '2026-02-01', game_versions: [mc], loaders: [],
    files: [{ filename: 'test.mrpack', size: archive.length, url: 'https://example.invalid/test.mrpack', hashes: { sha1: hash } }]
  })
  t.mock.method(globalThis, 'fetch', async raw => {
    const url = String(raw)
    if (url.endsWith('/project/project/version')) return Response.json([remote('old'), remote('new')])
    if (url.includes('/project/project/version/')) return Response.json(remote(url.split('/').at(-1)))
    if (url.endsWith('/project/project')) return Response.json({ id: 'project', title: 'Test' })
    if (url.endsWith('/test.mrpack')) return new Response(archive, { headers: { 'Content-Length': String(archive.length) } })
    if (url.includes('version_manifest')) return Response.json({ versions: [{ id: mc, url: 'https://example.invalid/game.json' }] })
    if (url.endsWith('/game.json')) return Response.json({ id: mc, mainClass: 'Vanilla', downloads: { client: { url: 'https://example.invalid/client.jar', size: 3 } } })
    if (url.endsWith('/client.jar')) return new Response('jar', { headers: { 'Content-Length': '3' } })
    throw new Error('未预期请求 ' + url)
  })
  const { registerPackUpdateApi } = await import('../src/server/launcher/pack-update.js')
  const { getJob } = await import('../src/server/launcher/install.js')
  const { writePackMarker, readPackMarker } = await import('../src/server/launcher/pack-baseline.js')
  const old = createInstance({ name: 'test old', mc, loader: 'vanilla', installedAt: 1 })
  const dir = old.paths.gameDir
  await writePackMarker(dir, { kind: 'modrinth', mc, name: old.name })
  await fs.writeFile(path.join(dir, 'options.txt'), 'key_jump:local\n')
  await fs.mkdir(path.join(dir, 'mods'), { recursive: true })
  await fs.writeFile(path.join(dir, 'mods', 'old.jar.disabled'), 'player')
  const routes = new Map()
  registerPackUpdateApi((_verb, name, fn) => routes.set(name.split('/pack-update')[1], fn), { readBody: async req => req })
  const call = (suffix, body = {}) => routes.get(suffix)(body, { id: old.id })
  const wait = async fn => {
    for (let i = 0; i < 500; i++) {
      const value = await fn()
      if (value) return value
      await sleep(10)
    }
    assert.fail('等待任务状态超时')
  }
  const finish = id => wait(() => {
    const job = getJob(id)
    return ['done', 'failed', 'cancelled'].includes(job.status) && job
  })
  assert.equal((await call('')).bindable, true)
  await call('/bind', { source: 'modrinth', projectId: 'project', versionId: 'old' })
  assert.equal((await call('')).available, true)
  for (const approve of [false, true]) {
    const { job } = await call('/prepare', { versionId: 'new' })
    const preview = await wait(async () => {
      const result = await call('/review')
      assert.notEqual(result.job?.status, 'failed', result.job?.error)
      return result.preview
    })
    assert.deepEqual(preview.installedComparison.localOnly, ['mods/old.jar.disabled'])
    assert.deepEqual(preview.installedComparison.targetOnly, ['mods/new.jar'])
    assert.equal(state.instances.length, 1)
    await call(approve ? '/apply' : '/cancel', { jobId: job.id, keepOptions: true })
    const result = await finish(job.id)
    assert.equal(result.status, approve ? 'done' : 'cancelled', result.error)
    if (approve) {
      const copy = instancePaths(findInstance(result.instanceId)).gameDir
      assert.notEqual(copy, dir)
      assert.equal(await fs.readFile(path.join(copy, 'options.txt'), 'utf8'), 'version:2\nkey_jump:local\n')
      assert.equal((await readPackMarker(copy)).origin.versionId, 'new')
    }
  }
  assert.equal(await fs.readFile(path.join(dir, 'mods', 'old.jar.disabled'), 'utf8'), 'player')
  assert.equal(await fs.readFile(path.join(dir, 'options.txt'), 'utf8'), 'key_jump:local\n')
})
