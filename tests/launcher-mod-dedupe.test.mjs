// 重复模组整理：同 modId / 同内容 / 无元数据文件名兜底的分组、保留建议与删除/禁用。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  analyzeModDuplicates,
  cleanupDuplicateMods,
  compareModVersions,
  groupModDuplicates
} from '../src/server/launcher/mod-dedupe.js'
import { listMods, findDuplicateMods, cleanDuplicateMods } from '../src/server/launcher/content.js'
import { makeZip } from './helpers/zip.mjs'

function modJar(id, version, { loader = 'forge' } = {}) {
  const meta = loader === 'fabric'
    ? ['fabric.mod.json', JSON.stringify({ schemaVersion: 1, id, version, name: id })]
    : ['META-INF/mods.toml', [`[[mods]]`, `modId="${id}"`, `displayName="${id}"`, `version="${version}"`].join('\n')]
  return makeZip([meta])
}

async function makeInstance(prefix = 'mc-dedupe-', name = 'Test') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const modsDir = path.join(root, 'versions', name, 'mods')
  await fs.mkdir(modsDir, { recursive: true })
  return { root, modsDir, inst: { id: name, root, folder: name, mc: '1.20.1', loader: 'forge' } }
}

function item(file, extra = {}) {
  return {
    file,
    relPath: file,
    name: file.replace(/\.jar(?:\.disabled)?$/i, ''),
    size: 100,
    mtime: 1000,
    disabled: /\.disabled$/i.test(file),
    modid: null,
    modids: [],
    version: '',
    hasMeta: false,
    ...extra
  }
}

test('版本比较：数字段、hotfix 与预发布', () => {
  assert.ok(compareModVersions('1.2.10', '1.2.9') > 0)
  assert.ok(compareModVersions('1.20.1-1.1.8-hotfix', '1.20.1-1.1.8') > 0)
  assert.ok(compareModVersions('2.0.0', '2.0.0-rc1') > 0)
  assert.ok(compareModVersions('1.0.0-beta', '1.0.0') < 0)
  assert.equal(compareModVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareModVersions('', ''), 0)
})

test('同一 modId 的多个版本归为一组，建议保留最新且启用的一份', () => {
  const groups = groupModDuplicates([
    item('foo-1.0.0.jar', { modid: 'foo', modids: ['foo'], version: '1.0.0', hasMeta: true, size: 11 }),
    item('foo-2.0.0.jar', { modid: 'foo', modids: ['foo'], version: '2.0.0', hasMeta: true, size: 12 }),
    item('bar.jar', { modid: 'bar', modids: ['bar'], version: '1.0.0', hasMeta: true })
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].items.length, 2)
  assert.equal(groups[0].keep, 'foo-2.0.0.jar')
  assert.equal(groups[0].kind, 'version')
  assert.equal(groups[0].reclaimSize, 11)
  assert.equal(groups[0].items.find((entry) => entry.relPath === 'foo-2.0.0.jar').keep, true)
})

test('顶层模组身份保留分隔符，内嵌库和文件名推测不参与 ID 判重', () => {
  const groups = groupModDuplicates([
    item('mod_a.jar', { modid: 'mod_a', modids: ['mod_a', 'shared'], topLevelModIds: ['mod_a'], hasMeta: true }),
    item('mod-a.jar', { modid: 'mod-a', modids: ['mod-a', 'shared'], topLevelModIds: ['mod-a'], hasMeta: true }),
    item('moda.jar', { modid: 'moda', modids: ['moda', 'shared'], topLevelModIds: ['moda'], hasMeta: true }),
    item('shared.jar', { modid: 'shared', modids: ['shared'], topLevelModIds: ['shared'], hasMeta: true }),
    item('unidentified.jar', { modids: ['mod_a'] }),
    item('wrapper.jar', { modid: 'shared', modids: ['shared'], topLevelModIds: [], hasMeta: true })
  ])
  assert.deepEqual(groups, [])
  const legacy = groupModDuplicates([
    item('one.jar', { modid: 'one', modids: ['one', 'shared'], nestedModIds: ['one', 'shared'], hasMeta: true }),
    item('two.jar', { modid: 'two', modids: ['two', 'shared'], nestedModIds: ['two', 'shared'], hasMeta: true })
  ])
  assert.deepEqual(legacy, [])
  const multi = groupModDuplicates([
    item('bundle.jar', { modid: 'first', modids: ['first', 'second'], topLevelModIds: ['first', 'second'], hasMeta: true }),
    item('second.jar', { modid: 'second', topLevelModIds: ['second'], hasMeta: true })
  ])
  assert.equal(multi.length, 1)
})

test('整合包共享内嵌前置不误报，真实的宿主复制品仍被识别', async () => {
  const { root, modsDir, inst } = await makeInstance('mc-dedupe-nested-')
  inst.loader = 'fabric'
  const shared = modJar('shared', '1.0.0', { loader: 'fabric' })
  const host = (id, version) => makeZip([
    ['fabric.mod.json', JSON.stringify({ schemaVersion: 1, id, version, jars: [{ file: 'META-INF/jars/shared.jar' }] })],
    ['META-INF/jars/shared.jar', shared]
  ])
  try {
    await fs.writeFile(path.join(modsDir, 'one-1.jar'), host('one', '1.0.0'))
    await fs.writeFile(path.join(modsDir, 'one-2.jar'), host('one', '2.0.0'))
    await fs.writeFile(path.join(modsDir, 'two.jar'), host('two', '1.0.0'))
    await fs.writeFile(path.join(modsDir, 'shared.jar'), shared)
    const list = await listMods(inst)
    assert.equal(list.duplicateGroups, 1)
    assert.deepEqual(list.items.filter((entry) => entry.duplicateGroup).map((entry) => entry.file).sort(), ['one-1.jar', 'one-2.jar'])
    const report = await findDuplicateMods(inst)
    assert.equal(report.totalGroups, 1)
    assert.equal(report.groups[0].keep, 'one-2.jar')
    assert.deepEqual(report.groups[0].items.map((entry) => entry.file).sort(), ['one-1.jar', 'one-2.jar'])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('启用优先：旧版本启用 + 新版本禁用时保留启用的那份', () => {
  const groups = groupModDuplicates([
    item('foo-1.0.0.jar', { modid: 'foo', modids: ['foo'], version: '1.0.0', hasMeta: true }),
    item('foo-2.0.0.jar.disabled', { modid: 'foo', modids: ['foo'], version: '2.0.0', hasMeta: true })
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].keep, 'foo-1.0.0.jar')
  assert.equal(groups[0].keepReason, '唯一启用')
})

test('内容哈希相同但文件名不同的 jar 也能合并，且标记为内容完全相同', () => {
  const items = [
    item('sodium.jar', { size: 200 }),
    item('sodium - 副本.jar', { size: 200 }),
    item('other.jar', { size: 300 })
  ]
  const hashes = new Map([
    ['sodium.jar', 'aaaa'],
    ['sodium - 副本.jar', 'aaaa'],
    ['other.jar', 'bbbb']
  ])
  const groups = groupModDuplicates(items, { hashes })
  assert.equal(groups.length, 1)
  assert.equal(groups[0].identical, true)
  assert.equal(groups[0].kind, 'identical')
  assert.equal(groups[0].items.length, 2)
})

test('没有元数据时按去掉版本号的文件名兜底', () => {
  const groups = groupModDuplicates([
    item('sodium-fabric-0.5.8.jar', { size: 500 }),
    item('sodium-fabric-0.5.9.jar', { size: 501 }),
    item('lithium-fabric-0.11.jar', { size: 502 })
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].items.length, 2)
  assert.equal(groups[0].keep, 'sodium-fabric-0.5.9.jar')
})

test('analyzeModDuplicates：同大小文件才计算哈希并汇总可回收空间', async () => {
  const { root, modsDir } = await makeInstance('mc-dedupe-analyze-')
  try {
    const bytes = modJar('dupmod', '1.0.0')
    await fs.writeFile(path.join(modsDir, 'dupmod.jar'), bytes)
    await fs.writeFile(path.join(modsDir, 'dupmod (1).jar'), bytes)
    await fs.writeFile(path.join(modsDir, 'other.jar'), modJar('other', '1.0.0'))
    const inst = { id: 'Test', root, folder: 'Test', mc: '1.20.1', loader: 'forge' }
    const data = await findDuplicateMods(inst)
    assert.equal(data.totalGroups, 1)
    assert.equal(data.duplicateItems, 1)
    assert.equal(data.groups[0].identical, true)
    assert.equal(data.reclaimBytes, bytes.length)
    void modsDir
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('listMods 标记整组重复；cleanDuplicateMods 删除多余文件并保留建议项', async () => {
  const { root, modsDir, inst } = await makeInstance('mc-dedupe-list-')
  try {
    await fs.writeFile(path.join(modsDir, 'tacz-1.20.1-1.1.8.jar'), modJar('tacz', '1.20.1-1.1.8'))
    await fs.writeFile(path.join(modsDir, 'tacz-1.20.1-1.1.8-hotfix.jar'), modJar('tacz', '1.20.1-1.1.8-hotfix'))
    const list = await listMods(inst)
    assert.equal(list.duplicateGroups, 1)
    assert.equal(list.duplicateItems, 1)
    const group = list.items.filter((entry) => entry.duplicateGroup === 'dup-1')
    assert.equal(group.length, 2)
    assert.equal(group.filter((entry) => entry.duplicateKeep).length, 1)
    assert.equal(group.filter((entry) => entry.duplicateOf).length, 1)

    const report = await findDuplicateMods(inst)
    assert.equal(report.groups[0].keep, 'tacz-1.20.1-1.1.8-hotfix.jar')
    const plan = report.groups.map((entry) => ({
      keep: entry.keep,
      remove: entry.items.filter((entryItem) => !entryItem.keep).map((entryItem) => entryItem.relPath)
    }))
    const result = await cleanDuplicateMods(inst, { mode: 'delete', groups: plan })
    assert.equal(result.done.length, 1)
    assert.equal(result.failed.length, 0)
    assert.equal(await fs.readFile(path.join(modsDir, report.groups[0].keep), 'utf8').then(() => true), true)
    const after = await listMods(inst)
    assert.equal(after.duplicateGroups, 0)
    assert.equal(after.items.length, 1)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('cleanupDuplicateMods：禁用模式改名可逆，路径越界与保留文件缺失会失败', async () => {
  const { root, modsDir } = await makeInstance('mc-dedupe-clean-')
  try {
    await fs.writeFile(path.join(modsDir, 'keep.jar'), 'keep')
    await fs.writeFile(path.join(modsDir, 'drop.jar'), 'drop')
    const result = await cleanupDuplicateMods(modsDir, {
      mode: 'disable',
      groups: [{ keep: 'keep.jar', remove: ['drop.jar'] }]
    })
    assert.equal(result.done.length, 1)
    assert.equal(result.done[0].action, 'disable')
    assert.equal(result.done[0].to, 'drop.jar.disabled')
    await fs.access(path.join(modsDir, 'drop.jar.disabled'))

    const blocked = await cleanupDuplicateMods(modsDir, {
      mode: 'delete',
      groups: [{ keep: 'keep.jar', remove: ['../outside.jar'] }]
    })
    assert.equal(blocked.done.length, 0)
    assert.equal(blocked.failed.length, 1)
    assert.match(blocked.failed[0].error, /路径/)

    const missingKeep = await cleanupDuplicateMods(modsDir, {
      mode: 'delete',
      groups: [{ keep: 'nope.jar', remove: ['keep.jar'] }]
    })
    assert.equal(missingKeep.done.length, 0)
    assert.equal(missingKeep.failed.length, 1)
    await fs.access(path.join(modsDir, 'keep.jar'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('analyzeModDuplicates 纯函数：没有重复时返回空报告', async () => {
  const report = await analyzeModDuplicates([
    item('a.jar', { modid: 'a', modids: ['a'], hasMeta: true, size: 1 }),
    item('b.jar', { modid: 'b', modids: ['b'], hasMeta: true, size: 2 })
  ])
  assert.deepEqual(report.groups, [])
  assert.equal(report.totalGroups, 0)
  assert.equal(report.duplicateItems, 0)
})
