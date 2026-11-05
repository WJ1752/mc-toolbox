import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

test('Prism / MultiMC 扫描、预估、重建和取消', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-prism-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const root = path.join(temp, 'toolbox')
  const instances = path.join(temp, 'PrismLauncher', 'instances')
  const source = path.join(instances, 'Fabric')
  const game = path.join(source, '.minecraft')
  const mc = '1.20.1'
  const loaderVersion = '0.16.14'
  const fabricId = mc + '-fabric-' + loaderVersion
  const priorRoot = process.env.MC_TOOLBOX_LAUNCHER_ROOT
  process.env.MC_TOOLBOX_LAUNCHER_ROOT = root
  t.after(() => {
    if (priorRoot === undefined) delete process.env.MC_TOOLBOX_LAUNCHER_ROOT
    else process.env.MC_TOOLBOX_LAUNCHER_ROOT = priorRoot
  })
  // 使用真实安装器，仅替换元数据/客户端 HTTP 响应。
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('version_manifest')) return Response.json({ versions: [{ id: mc, url: 'https://example.invalid/mc.json' }] })
    if (url.endsWith('/mc.json')) return Response.json({ id: mc, mainClass: 'Vanilla',
      downloads: { client: { url: 'https://example.invalid/client.jar', size: 3 } } })
    if (url.endsWith('/client.jar')) return new Response('jar', { headers: { 'Content-Length': '3' } })
    if (url.endsWith('/' + loaderVersion + '/profile/json')) return Response.json({ mainClass: 'Fabric', libraries: [] })
    throw new Error('未预期的联网请求：' + url)
  })
  const { registerPrismMigrationApi } = await import('../src/server/launcher/prism-migration.js')
  const { getJob, cancelJob } = await import('../src/server/launcher/install.js')
  const { store } = await import('../src/server/store.js')
  const state = { layoutVersion: 2, settings: { root, source: 'official' }, instances: [] }
  t.mock.method(store, 'get', (name, fallback) => name === 'launcher' ? state : fallback)
  t.mock.method(store, 'set', () => {})
  const routes = {}
  registerPrismMigrationApi((_verb, name, fn) => { routes[name] = fn }, async (req) => req)
  const scan = (dir) => routes['/api/launcher/import/prism/scan'](null, null, { dir })
  const preview = (dir) => routes['/api/launcher/import/prism/preview'](null, null, { dir })
  const migrate = (dir) => routes['/api/launcher/import/prism']({ dir })
  const wait = async (id) => {
    for (let i = 0; i < 500; i++) {
      const job = getJob(id)
      if (['failed', 'done', 'cancelled'].includes(job.status)) return job
      await sleep(10)
    }
    assert.fail('迁移任务超时')
  }
  async function manifest(dir, components) {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'mmc-pack.json'), JSON.stringify({ formatVersion: 1, components }))
  }
  const vanilla = [{ uid: 'org.lwjgl3', version: '3.3.1' }, { uid: 'net.minecraft', version: mc }]
  await manifest(source, [...vanilla, { uid: 'net.fabricmc.fabric-loader', version: loaderVersion }, { uid: 'net.fabricmc.intermediary', version: mc }])
  const plain = path.join(instances, '原版')
  await manifest(plain, vanilla)
  const unsupported = path.join(instances, '有补丁')
  await manifest(unsupported, [...vanilla, { uid: 'custom.patch', version: '1' }])
  await fs.mkdir(path.join(game, 'saves', 'world'), { recursive: true })
  await fs.writeFile(path.join(source, 'instance.cfg'), '[General]\nname=' + fabricId + '\n')
  await fs.writeFile(path.join(game, 'saves', 'world', 'level.dat'), 'save')
  await fs.writeFile(path.join(game, 'accounts.json'), 'private')
  await fs.writeFile(path.join(game, 'options.txt'), 'options')

  await t.test('列表识别两种加载方式并报告不支持的实例，预检只统计可复制内容', async () => {
    const { items } = await scan(path.dirname(instances))
    assert.equal(items.length, 3)
    assert.equal(items.find((i) => i.dir === source).loaderVersion, loaderVersion)
    assert.equal(items.find((i) => i.dir === plain).loader, 'vanilla')
    assert.match(items.find((i) => i.dir === unsupported).error, /custom.patch/)
    await assert.rejects(migrate(unsupported), /custom.patch/)
    const size = await preview(source)
    assert.equal(size.bytes, 11)
    assert.equal(size.files, 2)
    assert.ok(size.freeBytes === null || size.freeBytes > size.bytes)
    await fs.mkdir(path.join(plain, 'patches'))
    await fs.writeFile(path.join(plain, 'patches', 'net.minecraft.json'), '{}')
    await assert.rejects(migrate(plain), /patches/)
    await fs.unlink(path.join(plain, 'patches', 'net.minecraft.json'))
  })
  await t.test('原版与固定版本 Fabric 重建，共享版本目录与实例目录分离', async () => {
    for (const dir of [source, plain]) {
      const { instance, job } = await migrate(dir)
      const result = await wait(job.id)
      assert.equal(result.status, 'done', result.error)
      if (dir !== source) continue
      assert.notEqual(instance.paths.gameDir, path.join(root, 'versions', fabricId))
      const dest = path.join(instance.paths.savesDir, 'world', 'level.dat')
      assert.equal(await fs.readFile(dest, 'utf8'), 'save')
      await fs.writeFile(dest, 'changed')
      assert.equal(await fs.readFile(path.join(game, 'saves', 'world', 'level.dat'), 'utf8'), 'save')
      await assert.rejects(fs.stat(path.join(instance.paths.gameDir, 'accounts.json')), { code: 'ENOENT' })
      const profile = JSON.parse(await fs.readFile(path.join(root, 'versions', fabricId, fabricId + '.json'), 'utf8'))
      assert.equal(profile.mainClass, 'Fabric')
      assert.equal(profile.inheritsFrom, mc)
    }
  })
  await t.test('取消与复制失败清理半成品，保留源存档', async () => {
    const cancelled = await migrate(source)
    assert.equal(cancelJob(cancelled.job.id), true)
    assert.equal((await wait(cancelled.job.id)).status, 'cancelled')
    await assert.rejects(fs.stat(cancelled.instance.paths.gameDir), { code: 'ENOENT' })

    const external = path.join(temp, 'other')
    await fs.mkdir(external)
    await fs.symlink(external, path.join(game, 'saves', 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(preview(source), /链接/)
    const failed = await migrate(source)
    assert.equal((await wait(failed.job.id)).status, 'failed')
    await assert.rejects(fs.stat(failed.instance.paths.gameDir), { code: 'ENOENT' })
    assert.equal(state.instances.length, 2)
    assert.equal(await fs.readFile(path.join(game, 'saves', 'world', 'level.dat'), 'utf8'), 'save')
  })
})
