// 代理 A：版本识别与导入测试。
//
// 全部使用系统临时目录，不读写真实的 .minecraft；启动器状态在测试结束后
// 恢复（老版本 paths.js 不认 MC_TOOLBOX_DATA_DIR，只能先备份再还原）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  isMinecraftVersion,
  readVersionJson,
  detectLoader,
  inferRuntime
} from '../src/server/launcher/version-detect.js'
import { scanRoot, scanExisting, importExisting } from '../src/server/launcher/import.js'
import { listMinecraftVersionIds, validateGameVersion } from '../src/server/mc-versions.js'

let tmpBase = ''
// 记录 createInstance 的输入，避免测试写真实 launcher.json（并行测试会互相覆盖）。
const recordInstance = (payload) => ({ ...payload, id: 'test-instance' })

test.before(async () => {
  tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-import-'))
  // 启动器 root 指向临时目录；不触碰用户配置。
  process.env.MC_TOOLBOX_LAUNCHER_ROOT = path.join(tmpBase, 'launcher-root')
})

test.after(async () => {
  delete process.env.MC_TOOLBOX_LAUNCHER_ROOT
  if (tmpBase) await fsp.rm(tmpBase, { recursive: true, force: true })
})

/** 在临时根目录下写一个版本目录与 JSON。 */
async function writeVersion(root, id, json = {}, { jar = false } = {}) {
  const dir = path.join(root, 'versions', id)
  await fsp.mkdir(dir, { recursive: true })
  const data = { id, ...json }
  await fsp.writeFile(path.join(dir, `${id}.json`), JSON.stringify(data, null, 2), 'utf8')
  if (jar) await fsp.writeFile(path.join(dir, `${id}.jar`), Buffer.alloc(0))
  return dir
}

test('isMinecraftVersion 只接受合法 MC 版本号', () => {
  for (const value of ['1.20.1', '1.21', '26.3', '1.20.1-pre1', '1.20.1-rc1', '24w14a', '1.21.8']) {
    assert.equal(isMinecraftVersion(value), true, `应接受 ${value}`)
  }
  for (const value of ['', 'M1182rebirth', 'Minecraft 1.21', '1.21.8.1', '1.20-pre', '24w14', '1.21 beta', null, undefined]) {
    assert.equal(isMinecraftVersion(value), false, `应拒绝 ${String(value)}`)
  }
})

test('readVersionJson 读取版本 JSON，非法 id 返回 null', async () => {
  const root = path.join(tmpBase, 'read-json')
  await writeVersion(root, '1.21.8', { type: 'release' })
  const versionsDir = path.join(root, 'versions')
  const json = await readVersionJson(versionsDir, '1.21.8')
  assert.equal(json.id, '1.21.8')
  assert.equal(await readVersionJson(versionsDir, '不存在的版本'), null)
  assert.equal(await readVersionJson(versionsDir, '../evil'), null)
})

test('detectLoader 从库名与版本 id 识别加载器版本', () => {
  assert.deepEqual(
    detectLoader({
      mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.9' }]
    }, '1.21.1-fabric-0.16.9'),
    { loader: 'fabric', loaderVersion: '0.16.9' }
  )
  assert.deepEqual(
    detectLoader({ libraries: [{ name: 'net.minecraftforge:forge:1.20.1-47.4.0' }] }, '1.20.1-forge-47.4.0'),
    { loader: 'forge', loaderVersion: '47.4.0' }
  )
  assert.deepEqual(
    detectLoader({ libraries: [{ name: 'net.neoforged:neoforge:21.1.80' }] }, '1.21.1-neoforge-21.1.80'),
    { loader: 'neoforge', loaderVersion: '21.1.80' }
  )
  // NeoForge 1.20.1 的旧坐标 net.neoforged:forge。
  assert.deepEqual(
    detectLoader({ libraries: [{ name: 'net.neoforged:forge:1.20.1-47.1.106' }] }, '1.20.1-forge-47.1.106'),
    { loader: 'neoforge', loaderVersion: '47.1.106' }
  )
  assert.deepEqual(detectLoader({ id: '1.21.8' }, '1.21.8'), { loader: 'vanilla', loaderVersion: '' })
})

test('inheritsFrom 链根识别为真实 MC 版本（PCL2 自定义 id 不作为版本）', async () => {
  const root = path.join(tmpBase, 'pcl2')
  await writeVersion(root, '1.21.8', { type: 'release' }, { jar: true })
  await writeVersion(root, 'M1182rebirth', {
    inheritsFrom: '1.21.8',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.9' }]
  })
  const versionsDir = path.join(root, 'versions')
  const json = await readVersionJson(versionsDir, 'M1182rebirth')
  const runtime = await inferRuntime(json, { versionsDir, versionId: 'M1182rebirth' })
  assert.equal(runtime.mc, '1.21.8')
  assert.equal(runtime.mcSource, 'inheritsFrom')
  assert.equal(runtime.needsMc, false)
  assert.deepEqual(runtime.chain, ['M1182rebirth', '1.21.8'])
  assert.equal(runtime.loader, 'fabric')
  assert.equal(runtime.loaderVersion, '0.16.9')
  assert.equal(runtime.clientJarVersion, '1.21.8')
  assert.ok(runtime.mcCandidates.includes('1.21.8'))
  assert.equal(runtime.mcCandidates.includes('M1182rebirth'), false)

  const items = await scanRoot(root)
  const custom = items.find((item) => item.versionId === 'M1182rebirth')
  assert.equal(custom.mc, '1.21.8')
  assert.equal(custom.mcSource, 'inheritsFrom')
  assert.equal(custom.needsMc, false)
  assert.equal(custom.clientJarVersion, '1.21.8')
  assert.equal(custom.hasJar, true)
  assert.equal(custom.versionJson, path.join(versionsDir, 'M1182rebirth', 'M1182rebirth.json'))
  assert.equal(custom.gameDir, root)
  assert.equal(custom.isolated, false)
})

test('jar / clientVersion 字段兜底识别 MC 版本', async () => {
  const root = path.join(tmpBase, 'jar-fields')
  await writeVersion(root, 'CustomJar', { jar: '1.20.1' })
  await writeVersion(root, 'CustomClient', { clientVersion: '1.19.4' })
  const versionsDir = path.join(root, 'versions')

  const jarRuntime = await inferRuntime(await readVersionJson(versionsDir, 'CustomJar'), {
    versionsDir,
    versionId: 'CustomJar'
  })
  assert.equal(jarRuntime.mc, '1.20.1')
  assert.equal(jarRuntime.mcSource, 'jar')
  assert.equal(jarRuntime.clientJarVersion, '1.20.1')

  const clientRuntime = await inferRuntime(await readVersionJson(versionsDir, 'CustomClient'), {
    versionsDir,
    versionId: 'CustomClient'
  })
  assert.equal(clientRuntime.mc, '1.19.4')
  assert.equal(clientRuntime.mcSource, 'clientVersion')
  assert.equal(clientRuntime.clientJarVersion, '1.19.4')
})

test('assetIndex.id / assets 字段兜底识别 MC 版本', async () => {
  const root = path.join(tmpBase, 'assets-fields')
  await writeVersion(root, 'AssetIndexVersion', { assetIndex: { id: '1.18.2' } })
  await writeVersion(root, 'AssetsVersion', { assets: '1.16.5' })
  const versionsDir = path.join(root, 'versions')

  const assetIndex = await inferRuntime(await readVersionJson(versionsDir, 'AssetIndexVersion'), {
    versionsDir,
    versionId: 'AssetIndexVersion'
  })
  assert.equal(assetIndex.mc, '1.18.2')
  assert.equal(assetIndex.mcSource, 'assetIndex')

  const assets = await inferRuntime(await readVersionJson(versionsDir, 'AssetsVersion'), {
    versionsDir,
    versionId: 'AssetsVersion'
  })
  assert.equal(assets.mc, '1.16.5')
  assert.equal(assets.mcSource, 'assets')
})

test('版本目录里存在的原版 JSON 兜底识别 MC 版本', async () => {
  const root = path.join(tmpBase, 'version-dir')
  await writeVersion(root, '1.17.1', { type: 'release' }, { jar: true })
  const versionsDir = path.join(root, 'versions')
  const runtime = await inferRuntime(await readVersionJson(versionsDir, '1.17.1'), {
    versionsDir,
    versionId: '1.17.1'
  })
  assert.equal(runtime.mc, '1.17.1')
  assert.equal(runtime.mcSource, 'versionDir')
  assert.deepEqual(runtime.chain, ['1.17.1'])
  assert.equal(runtime.clientJarVersion, '1.17.1')
  assert.equal(runtime.needsMc, false)
})

test('全部识别失败时返回空版本，绝不返回实例名', async () => {
  const root = path.join(tmpBase, 'all-fail')
  await writeVersion(root, 'M1182rebirth', { mainClass: 'net.minecraft.client.main.Main' })
  const versionsDir = path.join(root, 'versions')
  const runtime = await inferRuntime(await readVersionJson(versionsDir, 'M1182rebirth'), {
    versionsDir,
    versionId: 'M1182rebirth'
  })
  assert.equal(runtime.mc, '')
  assert.equal(runtime.needsMc, true)
  assert.equal(runtime.mcSource, 'unknown')
  assert.equal(runtime.clientJarVersion, '')
  assert.deepEqual(runtime.mcCandidates, [])
  assert.equal(runtime.mc === 'M1182rebirth', false)

  const items = await scanRoot(root)
  assert.equal(items.length, 1)
  assert.equal(items[0].mc, '')
  assert.equal(items[0].needsMc, true)
  assert.equal(items[0].hasJar, false)
})

test('继承链循环与父版本缺失不会崩溃', async () => {
  const root = path.join(tmpBase, 'broken-chain')
  await writeVersion(root, 'CycleA', { inheritsFrom: 'CycleB' })
  await writeVersion(root, 'CycleB', { inheritsFrom: 'CycleA' })
  await writeVersion(root, 'MissingParent', { inheritsFrom: 'NoSuchVersion', jar: '1.20.1' })
  const versionsDir = path.join(root, 'versions')

  const cycle = await inferRuntime(await readVersionJson(versionsDir, 'CycleA'), {
    versionsDir,
    versionId: 'CycleA'
  })
  assert.equal(cycle.mc, '')
  assert.equal(cycle.needsMc, true)
  assert.ok(cycle.chain.length <= 12)

  const missing = await inferRuntime(await readVersionJson(versionsDir, 'MissingParent'), {
    versionsDir,
    versionId: 'MissingParent'
  })
  assert.equal(missing.mc, '1.20.1')
  assert.equal(missing.mcSource, 'jar')
  assert.deepEqual(missing.chain, ['MissingParent'])
})

test('importExisting 无法识别且未手动指定时要求 MC 版本', async () => {
  const root = path.join(tmpBase, 'need-mc')
  await writeVersion(root, 'M1182rebirth')

  await assert.rejects(importExisting({ dir: root, versionId: 'M1182rebirth' }), (error) => {
    assert.equal(error.code, 'MC_VERSION_REQUIRED')
    assert.match(error.message, /无法自动识别/)
    return true
  })

  await assert.rejects(
    importExisting({ dir: root, versionId: 'M1182rebirth', mc: 'Minecraft 1.21', create: recordInstance }),
    (error) => {
      assert.equal(error.code, 'INVALID_MC_VERSION')
      assert.match(error.message, /MC 版本格式不正确/)
      return true
    }
  )

  const { instance, source, mcSource } = await importExisting({
    dir: root,
    versionId: 'M1182rebirth',
    name: '手动指定版本',
    mc: '1.21.8',
    create: recordInstance
  })
  assert.equal(instance.mc, '1.21.8')
  assert.equal(instance.versionId, 'M1182rebirth')
  assert.equal(instance.jarVersion, '1.21.8')
  assert.equal(instance.external, true)
  assert.equal(instance.baseDir, root)
  assert.equal(instance.gameDir, root)
  assert.equal(instance.name, '手动指定版本')
  assert.equal(instance.mcSource, 'manual')
  assert.equal(source, '本地 .minecraft')
  assert.equal(mcSource, 'manual')
})

test('importExisting 自动识别成功并保持隔离目录 gameDir', async () => {
  const root = path.join(tmpBase, 'isolated')
  await writeVersion(root, '1.21.8', { type: 'release' }, { jar: true })
  await fsp.mkdir(path.join(root, 'versions', '1.21.8', 'mods'), { recursive: true })

  const items = await scanRoot(root)
  assert.equal(items.length, 1)
  assert.equal(items[0].mc, '1.21.8')
  assert.equal(items[0].clientJarVersion, '1.21.8')
  assert.equal(items[0].hasJar, true)
  assert.equal(items[0].isolated, true)
  assert.equal(items[0].gameDir, path.join(root, 'versions', '1.21.8'))

  const { instance } = await importExisting({ dir: root, versionId: '1.21.8', create: recordInstance })
  assert.equal(instance.mc, '1.21.8')
  assert.equal(instance.versionId, '1.21.8')
  assert.equal(instance.jarVersion, '1.21.8')
  assert.equal(instance.external, true)
  assert.equal(instance.baseDir, root)
  assert.equal(instance.gameDir, path.join(root, 'versions', '1.21.8'))
  assert.equal(instance.mcSource, 'versionDir')
})

test('scanExisting 只扫描给定目录并返回新增字段', async () => {
  const root = path.join(tmpBase, 'scan-existing')
  await writeVersion(root, '1.21.4', { type: 'release' }, { jar: true })
  const scan = await scanExisting({ dir: root })
  const item = scan.items.find((entry) => entry.root === root && entry.versionId === '1.21.4')
  assert.ok(item)
  for (const key of ['mc', 'mcSource', 'needsMc', 'clientJarVersion', 'hasJar', 'versionJson']) {
    assert.ok(key in item, `缺少字段 ${key}`)
  }
  assert.equal(item.mc, '1.21.4')
  assert.equal(item.needsMc, false)
  assert.equal(item.versionJson, path.join(root, 'versions', '1.21.4', '1.21.4.json'))
  assert.equal(scan.launcherRoot, path.join(tmpBase, 'launcher-root'))
})

test('listMinecraftVersionIds 复用缓存，失败时返回空数组', async () => {
  let calls = 0
  const fetcher = async () => {
    calls++
    return {
      ok: true,
      json: async () => ({ versions: [{ id: '1.21.8' }, { id: '24w14a' }, { id: '1.21.8' }, { id: '' }] })
    }
  }
  const first = await listMinecraftVersionIds({ force: true, fetcher })
  assert.deepEqual(first, ['1.21.8', '24w14a'])
  const cached = await listMinecraftVersionIds({ fetcher })
  assert.deepEqual(cached, ['1.21.8', '24w14a'])
  assert.equal(calls, 1)

  // 官方 manifest 失败时应自动回退 BMCLAPI。
  const urls = []
  const fallback = await listMinecraftVersionIds({
    force: true,
    fetcher: async (url) => {
      urls.push(url)
      if (urls.length === 1) throw new Error('official down')
      return {
        ok: true,
        json: async () => ({ versions: [{ id: '1.21.8' }, { id: '24w14a' }] })
      }
    }
  })
  assert.deepEqual(fallback, ['1.21.8', '24w14a'])
  assert.match(urls[0], /piston-meta\.mojang\.com/)
  assert.match(urls[1], /bmclapi2\.bangbang93\.com/)

  const failed = await listMinecraftVersionIds({
    force: true,
    fetcher: async () => { throw new Error('offline') }
  })
  assert.deepEqual(failed, [])
})

test('validateGameVersion 支持全部版本、非法格式、未知版本与清单不可用', async () => {
  const all = await validateGameVersion('all')
  assert.deepEqual(all, {
    requested: 'all', applied: '', valid: true, formatValid: true, known: true, notice: ''
  })
  assert.equal((await validateGameVersion('   ')).applied, '')

  const invalid = await validateGameVersion('Minecraft 1.21', { ids: ['1.21.8'] })
  assert.equal(invalid.formatValid, false)
  assert.equal(invalid.valid, false)
  assert.equal(invalid.applied, '')
  assert.match(invalid.notice, /不是有效的 MC 版本号/)
  assert.match(invalid.notice, /已按全部版本搜索/)

  const unknown = await validateGameVersion('1.99', { ids: ['1.21.8', '24w14a'] })
  assert.equal(unknown.formatValid, true)
  assert.equal(unknown.known, false)
  assert.equal(unknown.applied, '')
  assert.equal(unknown.notice, '未识别 MC 版本「1.99」，已按全部版本搜索。')

  const known = await validateGameVersion('1.21.8', { ids: ['1.21.8'] })
  assert.equal(known.valid, true)
  assert.equal(known.applied, '1.21.8')
  assert.equal(known.notice, '')

  const unavailable = await validateGameVersion('1.21.8', { ids: [] })
  assert.equal(unavailable.applied, '')
  assert.match(unavailable.notice, /暂时无法获取 Minecraft 版本清单/)
})
