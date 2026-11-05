import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { backupWorld, listWorldBackups, restoreWorldBackup } from '../src/server/launcher/world-backups.js'

test('世界备份可跨会话列出，恢复生成独立副本，游戏重新运行时不发布', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-world-backup-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const inst = { root, id: 'world-test', gameDir: path.join(root, 'game') }
  const saves = path.join(inst.gameDir, 'saves')
  const world = path.join(saves, '生存')
  await fs.mkdir(path.join(world, 'region'), { recursive: true })
  await fs.writeFile(path.join(world, 'level.dat'), 'old data')
  await fs.writeFile(path.join(world, 'region', 'r.0.0.mca'), 'region')
  await fs.writeFile(path.join(world, 'session.lock'), 'lock')
  assert.deepEqual(await listWorldBackups(inst), [])
  await assert.rejects(backupWorld(inst, '../game'), /目录名无效/)
  const backup = await backupWorld(inst, '生存')
  assert.equal(backup.files, 2)
  assert.deepEqual(await listWorldBackups({ ...inst }), [backup])
  await fs.writeFile(path.join(world, 'level.dat'), 'new data')
  await assert.rejects(restoreWorldBackup(inst, backup.id, () => { throw new Error('游戏正在运行') }), /游戏正在运行/)
  assert.deepEqual(await fs.readdir(saves), ['生存'])
  const restored = await restoreWorldBackup(inst, backup.id)
  assert.equal(await fs.readFile(path.join(saves, restored.name, 'level.dat'), 'utf8'), 'old data')
  assert.equal(await fs.readFile(path.join(saves, restored.name, 'region', 'r.0.0.mca'), 'utf8'), 'region')
  assert.equal(await fs.readFile(path.join(world, 'level.dat'), 'utf8'), 'new data')
  assert.deepEqual(await listWorldBackups({ ...inst, id: 'other' }), [])
  await assert.rejects(restoreWorldBackup(inst, '../other'), /编号无效/)
  await fs.symlink(root, path.join(world, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(backupWorld(inst, '生存'), /链接或特殊文件/)
  assert.deepEqual(await listWorldBackups(inst), [backup])
})
