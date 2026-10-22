// 实例目录布局：可读的 versions/<实例名>、重名避让、旧布局回退，
// 以及安装中的实例不出现在列表里。全部只碰临时目录，不写用户配置。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  allocateInstanceFolder,
  filterVisibleInstances,
  instancePaths,
  migrateInstanceLayout,
  safeInstanceFolderName
} from '../src/server/launcher/state.js'

let tmp = ''

test.before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-layout-'))
})

test.after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

test('safeInstanceFolderName：保留中文，替换非法字符，去掉结尾点号', () => {
  assert.equal(safeInstanceFolderName('Better MC [FABRIC] BMC2'), 'Better MC [FABRIC] BMC2')
  assert.equal(safeInstanceFolderName('我的整合包 1.20.1'), '我的整合包 1.20.1')
  assert.equal(safeInstanceFolderName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j')
  assert.equal(safeInstanceFolderName('  name...  '), 'name')
  assert.equal(safeInstanceFolderName('CON'), '_CON')
  assert.equal(safeInstanceFolderName(''), 'instance')
})

test('allocateInstanceFolder：撞上真版本文件夹或别的实例时自动加后缀', async () => {
  const root = path.join(tmp, 'root-a')
  await fs.mkdir(path.join(root, 'versions', '1.20.1-fabric'), { recursive: true })

  // 真版本目录已存在 → 不能占用
  assert.equal(allocateInstanceFolder(root, '1.20.1-fabric', 'inst-a'), '1.20.1-fabric-2')
  // 未占用的名字 → 直接用
  assert.equal(allocateInstanceFolder(root, '我的世界', 'inst-a'), '我的世界')

  // 目录已存在但归属同一个实例 → 复用
  const owned = path.join(root, 'versions', '已占用')
  await fs.mkdir(owned, { recursive: true })
  await fs.writeFile(path.join(owned, '.mc-toolbox-instance.json'), JSON.stringify({ id: 'inst-a' }))
  assert.equal(allocateInstanceFolder(root, '已占用', 'inst-a'), '已占用')
  assert.equal(allocateInstanceFolder(root, '已占用', 'inst-b'), '已占用-2')
})

test('allocateInstanceFolder：reserved 里的版本 ID 不会被实例目录占用', async () => {
  const root = path.join(tmp, 'root-b')
  await fs.mkdir(path.join(root, 'versions'), { recursive: true })
  const folder = allocateInstanceFolder(root, '1.20.1-forge', 'inst-c', '', ['1.20.1-forge'])
  assert.equal(folder, '1.20.1-forge-2')
})

test('instancePaths：新布局把游戏文件直接放在 versions/<实例名>', () => {
  const root = path.join(tmp, 'root-c')
  const p = instancePaths({
    id: 'abc',
    root,
    folder: '我的整合包',
    name: '我的整合包',
    mc: '1.20.1',
    loader: 'fabric',
    versionId: '1.20.1-fabric'
  })
  assert.equal(p.ownDir, path.join(root, 'versions', '我的整合包'))
  assert.equal(p.gameDir, path.join(root, 'versions', '我的整合包'))
  assert.equal(p.modsDir, path.join(root, 'versions', '我的整合包', 'mods'))
  assert.equal(p.logsDir, path.join(root, 'versions', '我的整合包', 'logs'))
  // 版本文件仍然共享
  assert.equal(p.versionDir, path.join(root, 'versions', '1.20.1-fabric'))
})

test('instancePaths：没有 folder 的旧实例继续走 instances/<id>/game', () => {
  const root = path.join(tmp, 'root-d')
  const p = instancePaths({ id: 'legacy1', root, mc: '1.20.1', loader: 'vanilla', versionId: '1.20.1' })
  assert.equal(p.ownDir, path.join(root, 'instances', 'legacy1'))
  assert.equal(p.gameDir, path.join(root, 'instances', 'legacy1', 'game'))
})

test('instancePaths：外部实例的游戏目录仍指向它自己的 .minecraft', () => {
  const root = path.join(tmp, 'root-e')
  const externalBase = path.join(tmp, 'external-mc')
  const p = instancePaths({ id: 'ext1', root, folder: '导入的整合包', baseDir: externalBase, mc: '1.20.1', versionId: '1.20.1' })
  assert.equal(p.gameDir, externalBase)
  assert.equal(p.ownDir, path.join(root, 'versions', '导入的整合包'))
})

test('filterVisibleInstances：安装中的实例不进列表，完成后才出现', () => {
  const list = [
    { id: 'a', installing: false },
    { id: 'b', installing: true },
    { id: 'c' }
  ]
  assert.deepEqual(filterVisibleInstances(list).map((item) => item.id), ['a', 'c'])
  assert.deepEqual(
    filterVisibleInstances(list, { includeInstalling: true }).map((item) => item.id),
    ['a', 'b', 'c']
  )
  assert.deepEqual(filterVisibleInstances(null), [])
})

test('migrateInstanceLayout：旧 instances/<id> 目录搬到 versions/<实例名> 并写归属标记', async () => {
  const root = path.join(tmp, 'root-legacy')
  const legacy = path.join(root, 'instances', 'old-id')
  await fs.mkdir(path.join(legacy, 'game', 'mods'), { recursive: true })
  await fs.mkdir(path.join(legacy, 'logs'), { recursive: true })
  await fs.writeFile(path.join(legacy, 'game', 'mods', 'a.jar'), 'jar')
  await fs.writeFile(path.join(legacy, 'game', 'options.txt'), 'lang:zh_cn')
  await fs.writeFile(path.join(legacy, 'logs', 'latest.log'), 'log')

  const data = {
    instances: [{ id: 'old-id', name: '我的整合包', root, mc: '1.20.1', loader: 'fabric', versionId: '1.20.1-fabric' }]
  }

  assert.equal(migrateInstanceLayout(data, { root }), true)
  assert.equal(data.layoutVersion, 2)
  assert.equal(data.instances[0].folder, '我的整合包')

  const target = path.join(root, 'versions', '我的整合包')
  assert.equal(await fs.readFile(path.join(target, 'mods', 'a.jar'), 'utf8'), 'jar')
  assert.equal(await fs.readFile(path.join(target, 'options.txt'), 'utf8'), 'lang:zh_cn')
  assert.equal(await fs.readFile(path.join(target, 'logs', 'latest.log'), 'utf8'), 'log')
  const marker = JSON.parse(await fs.readFile(path.join(target, '.mc-toolbox-instance.json'), 'utf8'))
  assert.equal(marker.id, 'old-id')
  await assert.rejects(fs.stat(legacy), '旧目录应被清空')

  // 幂等：再来一次什么都不改
  assert.equal(migrateInstanceLayout(data, { root }), false)
})

test('migrateInstanceLayout：迁移被占用时保持旧布局，且重试不会堆出 -2、-3 空目录', async () => {
  const root = path.join(tmp, 'root-busy')
  const legacy = path.join(root, 'instances', 'busy-id')
  await fs.mkdir(legacy, { recursive: true })
  // 把 game 造成普通文件：readdir 会 ENOTDIR，模拟目录被占用 / 不可读。
  await fs.writeFile(path.join(legacy, 'game'), 'not a directory')

  const data = {
    instances: [{ id: 'busy-id', name: '被占用的实例', root, mc: '1.20.1', loader: 'fabric', versionId: '1.20.1-fabric' }]
  }

  assert.equal(migrateInstanceLayout(data, { root }), false)
  assert.equal(data.instances[0].folder, undefined, '迁移失败时不能把实例切到新目录')
  assert.notEqual(data.layoutVersion, 2, '未完成迁移就不能写 layoutVersion')

  // 连续重试仍失败，但只应存在一个目标目录（归属标记让它收敛）。
  for (let i = 0; i < 3; i++) migrateInstanceLayout(data, { root })
  const dirs = (await fs.readdir(path.join(root, 'versions'))).filter((name) => name.startsWith('被占用的实例'))
  assert.deepEqual(dirs, ['被占用的实例'])
  assert.equal(data.instances[0].folder, undefined)
})
