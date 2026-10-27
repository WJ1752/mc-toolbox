// 模组列表加速 + 真实封面：一次扫描能拿到 icon 字段，封面直接从 JAR/ZIP 读取。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { makeZip } from './helpers/zip.mjs'
import { scanModsDir, clearModMetaCache } from '../src/server/mods.js'
import { readContentIcon } from '../src/server/launcher/content.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lure0wAAAABJRU5ErkJggg==', 'base64')

test('scanModsDir 读取 Fabric / Forge 元数据里的封面字段，第二次扫描走缓存', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-scan-icon-'))
  const mods = path.join(root, 'mods')
  try {
    await fs.mkdir(mods, { recursive: true })
    const fabric = makeZip([
      ['fabric.mod.json', JSON.stringify({ id: 'fabric_demo', name: 'Fabric Demo', version: '1.0.0', icon: 'assets/fabric_demo/icon.png' })],
      ['assets/fabric_demo/icon.png', PNG]
    ])
    const forge = makeZip([
      ['META-INF/mods.toml', 'modLoader="javafml"\n[[mods]]\nmodId="forge_demo"\ndisplayName="Forge Demo"\nversion="2.0.0"\nlogoFile="logo.png"\n'],
      ['logo.png', PNG]
    ])
    await fs.writeFile(path.join(mods, 'fabric-demo.jar'), fabric)
    await fs.writeFile(path.join(mods, 'forge-demo.jar'), forge)

    clearModMetaCache()
    const first = await scanModsDir(mods, { runtime: { mc: '1.20.1', loader: 'fabric' } })
    assert.equal(first.length, 2)
    const fabricItem = first.find((item) => item.modid === 'fabric_demo')
    const forgeItem = first.find((item) => item.modid === 'forge_demo')
    assert.equal(fabricItem.icon, 'assets/fabric_demo/icon.png')
    assert.equal(forgeItem.icon, 'logo.png')

    // 同样的文件第二次扫描应直接命中内存缓存；结果必须与首次一致。
    const second = await scanModsDir(mods, { runtime: { mc: '1.20.1', loader: 'fabric' } })
    assert.deepEqual(second.map((item) => item.icon), first.map((item) => item.icon))
    assert.equal(second.length, 2)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('readContentIcon 从模组 / 资源包 / 光影包读取真实封面，找不到时返回 null', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-content-icon-'))
  const gameDir = path.join(root, 'game')
  const assets = path.join(gameDir, 'assets')
  try {
    await fs.mkdir(path.join(gameDir, 'mods'), { recursive: true })
    await fs.mkdir(path.join(gameDir, 'resourcepacks'), { recursive: true })
    await fs.mkdir(path.join(gameDir, 'shaderpacks'), { recursive: true })
    const iconEntry = 'assets/demo/icon.png'
    await fs.writeFile(path.join(gameDir, 'mods', 'demo.jar'), makeZip([
      ['fabric.mod.json', JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0', icon: iconEntry })],
      ['assets/demo/icon.png', PNG]
    ]))
    await fs.writeFile(path.join(gameDir, 'resourcepacks', 'pack.zip'), makeZip([['pack.png', PNG]]))
    await fs.writeFile(path.join(gameDir, 'shaderpacks', 'shader.zip'), makeZip([['shaderpack.png', PNG]]))
    await fs.writeFile(path.join(gameDir, 'shaderpacks', 'plain.zip'), makeZip([['shaders/README.txt', 'none']]))
    await fs.mkdir(path.join(gameDir, 'resourcepacks', 'folder-pack'), { recursive: true })
    await fs.writeFile(path.join(gameDir, 'resourcepacks', 'folder-pack', 'pack.png'), PNG)

    const inst = { id: 'i1', gameDir, root }
    const mod = await readContentIcon(inst, 'mods', 'demo.jar', { entry: iconEntry, modid: 'demo' })
    assert.equal(mod.mime, 'image/png')
    assert.deepEqual(mod.data, PNG)
    const pack = await readContentIcon(inst, 'resourcepacks', 'pack.zip')
    assert.deepEqual(pack.data, PNG)
    const shader = await readContentIcon(inst, 'shaderpacks', 'shader.zip')
    assert.deepEqual(shader.data, PNG)
    const folder = await readContentIcon(inst, 'resourcepacks', 'folder-pack')
    assert.deepEqual(folder.data, PNG)
    assert.equal(await readContentIcon(inst, 'shaderpacks', 'plain.zip'), null)
    assert.equal(await readContentIcon(inst, 'mods', '../outside.jar'), null)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
