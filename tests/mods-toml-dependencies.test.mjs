// Forge / NeoForge 的 mods.toml 依赖解析：只从 [[mods]] 取宿主 modid，
// 并正确跳过 optional / incompatible / 仅客户端依赖，避免误报「必需依赖缺失」。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { readModMeta, scanModsDir } from '../src/server/mods.js'
import { listMods } from '../src/server/launcher/content.js'
import { makeZip } from './helpers/zip.mjs'

let dir = ''

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-mods-toml-'))
})

test.after(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

async function makeJar(name, toml) {
  const file = path.join(dir, name)
  await fs.writeFile(file, makeZip([['META-INF/neoforge.mods.toml', toml]]))
  return file
}

test('宿主 modid 只来自 [[mods]]，依赖块排在前面也不会认错', async () => {
  const toml = [
    '[[dependencies.realfoo]]',
    'modId="neededapi"',
    'mandatory=true',
    'versionRange="[1,)"',
    '',
    '[[mods]]',
    'modId="realfoo"',
    'displayName="Real Foo"',
    'version="1.2.3"'
  ].join('\n')
  const file = await makeJar('foo.jar', toml)
  const meta = await readModMeta(file, { mc: '1.21.1', loader: 'neoforge' })
  assert.equal(meta.modid, 'realfoo')
  assert.deepEqual(meta.modids, ['realfoo'])
  // 依赖块里的 modId 不是宿主，不能被当成依赖自己
  assert.deepEqual(meta.dependencies.map((d) => d.id), ['neededapi'])
})

test('optional / incompatible / side=CLIENT 的依赖不要求存在', async () => {
  const toml = [
    '[[mods]]',
    'modId="realfoo"',
    'version="1.0.0"',
    '',
    '[[dependencies.realfoo]]',
    'modId="requiredlib"',
    'type="required"',
    'versionRange="[1,)"',
    '',
    '[[dependencies.realfoo]]',
    'modId="optionallib"',
    'type="optional"',
    '',
    '[[dependencies.realfoo]]',
    'modId="badlib"',
    'type="incompatible"',
    '',
    '[[dependencies.realfoo]]',
    'modId="clientonlylib"',
    'type="required"',
    'side="CLIENT"'
  ].join('\n')
  const file = await makeJar('deps.jar', toml)
  const meta = await readModMeta(file, { mc: '1.21.1', loader: 'neoforge' })
  const required = meta.dependencies.filter((d) => !d.optional).map((d) => d.id)
  assert.deepEqual(required, ['requiredlib'])
  assert.ok(!meta.dependencies.some((d) => d.id === 'badlib'), 'incompatible 依赖不应参与校验')
})

test('TOML displayName 双引号内的单引号不被截断', async () => {
  const file = await makeJar('xaero-name.jar', [
    '[[mods]]',
    'modId="xaerominimap"',
    'displayName="Xaero\'s Minimap"',
    'version="26.4.2"'
  ].join('\n'))
  const meta = await readModMeta(file, { mc: '1.20.1', loader: 'neoforge' })
  assert.equal(meta.name, "Xaero's Minimap")
})

test('Forge 实例优先读 mods.toml，不被同 jar 的 fabric.mod.json 假依赖污染', async () => {
  const toml = [
    '[[mods]]',
    'modId="dualmod"',
    'displayName="Dual Mod (NeoForge port)"',
    'version="1.0.0"',
    '',
    '[[dependencies.dualmod]]',
    'modId="creativecore"',
    'mandatory=true'
  ].join('\n')
  const fabric = JSON.stringify({
    schemaVersion: 1,
    id: 'dualmod',
    version: '1.0.0',
    depends: { fabricloader: '>=0.14', 'fabric-api': '*', creativecore: '>=2.0' }
  })
  const file = path.join(dir, 'dual.jar')
  await fs.writeFile(file, makeZip([
    ['META-INF/mods.toml', toml],
    ['fabric.mod.json', fabric]
  ]))
  const forge = await readModMeta(file, { mc: '1.20.1', loader: 'forge' })
  assert.equal(forge.loader, 'forge')
  assert.deepEqual(forge.dependencies.map((d) => d.id), ['creativecore'])
  const fabricMeta = await readModMeta(file, { mc: '1.20.1', loader: 'fabric' })
  assert.equal(fabricMeta.loader, 'fabric')
  assert.ok(fabricMeta.dependencies.some((d) => d.id === 'fabric-api'))
})

test('Forge jar-in-jar：嵌套 xaerolib 被识别为已提供，未知 owner 的依赖块被忽略', async () => {
  const nested = makeZip([[
    'META-INF/mods.toml',
    ['[[mods]]', 'modId="xaerolib"', 'version="1.7.1"'].join('\n')
  ]])
  const parent = makeZip([
    ['META-INF/mods.toml', [
      '[[mods]]',
      'modId="xaerominimap"',
      'displayName="Xaero\'s Minimap"',
      'version="26.4.2"',
      '',
      '[[dependencies.xaerominimap]]',
      'modId="xaerolib"',
      'mandatory=true',
      'versionRange="[1.0,)"',
      '',
      '[[dependencies.xaerobetterpvp]]',
      'modId="ghostlib"',
      'mandatory=true'
    ].join('\n')],
    ['META-INF/jarjar/metadata.json', JSON.stringify({
      jars: [{ path: 'META-INF/jarjar/xaerolib.jar' }]
    })],
    ['META-INF/jarjar/xaerolib.jar', nested]
  ])
  const file = path.join(dir, 'xaerominimap.jar')
  await fs.writeFile(file, parent)
  const meta = await readModMeta(file, { mc: '1.20.1', loader: 'forge' })
  assert.equal(meta.modid, 'xaerominimap')
  assert.ok(meta.modids.includes('xaerolib'))
  assert.ok(meta.nestedModIds.includes('xaerolib'))
  assert.equal(meta.providedVersions.xaerolib, '1.7.1')
  assert.deepEqual(meta.dependencies.map((d) => d.id), ['xaerolib'])
  assert.ok(!meta.dependencies.some((d) => d.id === 'ghostlib'), '没有对应 [[mods]] 的 owner 不能算到宿主头上')

  const scan = await scanModsDir(dir, { runtime: { mc: '1.20.1', loader: 'forge' } })
  const item = scan.find((entry) => entry.file === 'xaerominimap.jar')
  assert.ok(item.providedModIds.includes('xaerolib'))
  assert.ok(item.modid === 'xaerominimap')
})

test('fat jar 没有主元数据时从 jar-in-jar 子模组识别真实 modid', async () => {
  const child = makeZip([[
    'META-INF/mods.toml',
    ['[[mods]]', 'modId="kotlinforforge"', 'version="4.12.0"', 'displayName="Kotlin For Forge"'].join('\n')
  ]])
  const file = path.join(dir, 'kotlinforforge-all.jar')
  await fs.writeFile(file, makeZip([
    ['META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\nFMLModType: LIBRARY\n'],
    ['META-INF/jarjar/metadata.json', JSON.stringify({ jars: [{ path: 'META-INF/jarjar/kotlinforforge.jar' }] })],
    ['META-INF/jarjar/kotlinforforge.jar', child]
  ]))
  const meta = await readModMeta(file, { mc: '1.20.1', loader: 'forge' })
  assert.equal(meta.modid, 'kotlinforforge')
  assert.equal(meta.version, '4.12.0')
  assert.equal(meta.loader, 'forge')
  assert.ok(meta.loaderHints.includes('forge'))
})

test('mods.toml 正文提到 NeoForge 不会被误判为 NeoForge 模组', async () => {
  const file = path.join(dir, 'forge-with-neo-text.jar')
  await fs.writeFile(file, makeZip([[
    'META-INF/mods.toml',
    ['[[mods]]', 'modId="notneo"', 'displayName="A NeoForge port of something"', 'description="NeoForge and Forge"'].join('\n')
  ]]))
  const meta = await readModMeta(file, { mc: '1.20.1', loader: 'forge' })
  assert.equal(meta.loader, 'forge')

  const neoFile = path.join(dir, 'real-neo.jar')
  await fs.writeFile(neoFile, makeZip([['META-INF/neoforge.mods.toml', ['[[mods]]', 'modId="realneo"'].join('\n')]]))
  const neo = await readModMeta(neoFile, { mc: '1.21.1', loader: 'neoforge' })
  assert.equal(neo.loader, 'neoforge')
})

test('listMods：Xaero 内嵌前置、yumi ID 分隔符与加载器不匹配都能正确处理', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-modlist-real-'))
  const modsDir = path.join(root, 'versions', 'Test', 'mods')
  await fs.mkdir(modsDir, { recursive: true })
  try {
    const xaeroLib = makeZip([['META-INF/mods.toml', ['[[mods]]', 'modId="xaerolib"', 'version="1.7.1"'].join('\n')]])
    await fs.writeFile(path.join(modsDir, 'xaerominimap-forge-1.20.1-26.4.2.jar'), makeZip([
      ['META-INF/mods.toml', [
        '[[mods]]', 'modId="xaerominimap"', 'version="26.4.2"',
        '[[dependencies.xaerominimap]]', 'modId="xaerolib"', 'mandatory=true'
      ].join('\n')],
      ['META-INF/jarjar/metadata.json', JSON.stringify({ jars: [{ path: 'META-INF/jarjar/xaerolib.jar' }] })],
      ['META-INF/jarjar/xaerolib.jar', xaeroLib]
    ]))

    await fs.writeFile(path.join(modsDir, 'yumi-core.jar'), makeZip([
      ['META-INF/mods.toml', ['[[mods]]', 'modId="yumi_commons_core"', 'version="1.0.0"'].join('\n')]
    ]))
    await fs.writeFile(path.join(modsDir, 'needs-yumi.jar'), makeZip([
      ['META-INF/mods.toml', [
        '[[mods]]', 'modId="needsyumi"', 'version="1.0.0"',
        '[[dependencies.needsyumi]]', 'modId="yumi-commons-core"', 'mandatory=true'
      ].join('\n')]
    ]))
    await fs.writeFile(path.join(modsDir, 'fabric-mod.jar'), makeZip([
      ['fabric.mod.json', JSON.stringify({ schemaVersion: 1, id: 'fabricmod', version: '1.0.0', depends: { 'fabric-api': '*' } })]
    ]))

    const inst = {
      id: 'probe',
      name: 'Test',
      mc: '1.20.1',
      loader: 'forge',
      loaderVersion: '47.4.22',
      root,
      folder: 'Test'
    }
    const data = await listMods(inst)
    assert.deepEqual(data.missingDependencies, [], '内嵌 xaerolib、yumi 分隔符与不兼容 Fabric 模组都不应产生缺失依赖')
    const xaero = data.items.find((item) => item.file.startsWith('xaerominimap'))
    assert.ok(xaero.providedModIds.includes('xaerolib'))
    assert.equal(xaero.modid, 'xaerominimap')
    const fabric = data.items.find((item) => item.file === 'fabric-mod.jar')
    assert.equal(fabric.loaderMismatch, true)
    assert.deepEqual(fabric.missingDependencies, [])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
