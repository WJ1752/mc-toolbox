import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { makeZip } from './helpers/zip.mjs'
import { listResourcePacks, setResourcePackOrder, previewResourcePackConflicts } from '../src/server/launcher/content.js'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-resourcepacks-'))
  const gameDir = path.join(root, 'game')
  const packDir = path.join(gameDir, 'resourcepacks')
  await fs.mkdir(packDir, { recursive: true })
  const inst = { id: 'packs', root, gameDir, folder: '', mc: '1.21', loader: 'vanilla' }
  return { root, gameDir, packDir, inst }
}

test('资源包列表按 Minecraft 优先级逆序展示且排序保留未知选项', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(path.join(f.packDir, 'high.zip'), makeZip([['pack.mcmeta', '{}'], ['assets/test/a.txt', 'high']]))
    await fs.writeFile(path.join(f.packDir, 'low.zip'), makeZip([['pack.mcmeta', '{}'], ['assets/test/a.txt', 'low']]))
    const original = 'resourcePacks:["vanilla","file/low.zip","unknown-entry","file/high.zip"]\r\nincompatibleResourcePacks:["keep-me"]\r\ngamma:0.5:tail\r\n\r\n'
    await fs.writeFile(path.join(f.gameDir, 'options.txt'), original)
    const before = await listResourcePacks(f.inst)
    assert.deepEqual(before.items.filter((item) => item.enabled).map((item) => item.name), ['high.zip', 'low.zip'])
    assert.equal(before.items.find((item) => item.name === 'high.zip').priority, 0)
    const result = await setResourcePackOrder(f.inst, ['low.zip', 'high.zip'], before.revision)
    assert.ok(result.revision)
    const updated = await fs.readFile(path.join(f.gameDir, 'options.txt'), 'utf8')
    assert.equal(updated, original.replace('file/low.zip","unknown-entry","file/high.zip', 'file/high.zip","unknown-entry","file/low.zip'))
    await assert.rejects(setResourcePackOrder(f.inst, ['high.zip', 'low.zip'], before.revision), /已变化/)
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})

test('覆盖预览检测 ZIP 与目录包的同路径并指出最高优先级来源', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(path.join(f.packDir, 'high.zip'), makeZip([['pack.mcmeta', '{}'], ['assets/test/shared.txt', 'high']]))
    await fs.mkdir(path.join(f.packDir, 'low-folder', 'assets', 'test'), { recursive: true })
    await fs.writeFile(path.join(f.packDir, 'low-folder', 'pack.mcmeta'), '{}')
    await fs.writeFile(path.join(f.packDir, 'low-folder', 'assets', 'test', 'shared.txt'), 'low')
    await fs.writeFile(path.join(f.gameDir, 'options.txt'), 'resourcePacks:["file/low-folder","file/high.zip"]\n')
    const result = await previewResourcePackConflicts(f.inst)
    const conflict = result.conflicts.find((item) => item.path === 'assets/test/shared.txt')
    assert.deepEqual(conflict.sources, ['high.zip', 'low-folder'])
    assert.equal(conflict.highestPrioritySource, 'high.zip')
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})

test('混合 legacy/file token 随各自资源包移动，vanilla 本地同名目录不抢内置项', async () => {
  const f = await fixture()
  try {
    for (const name of ['vanilla', 'legacy', 'modern']) await fs.mkdir(path.join(f.packDir, name))
    await fs.writeFile(path.join(f.gameDir, 'options.txt'), 'resourcePacks:["vanilla","legacy","file/modern"]\n')
    const before = await listResourcePacks(f.inst)
    assert.deepEqual(before.items.filter((item) => item.enabled).map((item) => item.name), ['modern', 'legacy'])
    assert.equal(before.items.find((item) => item.name === 'vanilla').enabled, false)
    await setResourcePackOrder(f.inst, ['legacy', 'modern'], before.revision)
    const updated = await fs.readFile(path.join(f.gameDir, 'options.txt'), 'utf8')
    assert.equal(updated, 'resourcePacks:["vanilla","file/modern","legacy"]\n')
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})

test('排序接受超过 128 个已启用的本地资源包', async () => {
  const f = await fixture()
  try {
    const names = Array.from({ length: 129 }, (_, index) => `pack-${index}`)
    await Promise.all(names.map((name) => fs.mkdir(path.join(f.packDir, name))))
    await fs.writeFile(path.join(f.gameDir, 'options.txt'), `resourcePacks:${JSON.stringify(names)}\n`)
    const before = await listResourcePacks(f.inst)
    assert.equal(before.items.filter((item) => item.enabled).length, 129)
    const result = await setResourcePackOrder(f.inst, before.items.filter((item) => item.enabled).map((item) => item.name), before.revision)
    assert.equal(result.order.length, 129)
  } finally { await fs.rm(f.root, { recursive: true, force: true }) }
})
