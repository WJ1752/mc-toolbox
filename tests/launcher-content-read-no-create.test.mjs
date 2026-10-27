// 只读列表不应该在游戏目录缺失时重建整个目录树（用户曾遇到过桌面上凭空多出文件夹）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { listMods, listResourcePacks, listShaderPacks, findDuplicateMods } from '../src/server/launcher/content.js'

test('模组/资源包/光影列表不会为了读取而创建游戏目录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-read-no-create-'))
  const gameDir = path.join(root, 'game')
  const inst = { id: 'read-only', root, folder: '', gameDir, mc: '1.20.1', loader: 'fabric' }
  try {
    const mods = await listMods(inst)
    assert.deepEqual(mods.items, [])
    assert.equal(mods.total, 0)
    const packs = await listResourcePacks(inst)
    assert.deepEqual(packs.items, [])
    const shaders = await listShaderPacks(inst)
    assert.deepEqual(shaders.items, [])
    const dupes = await findDuplicateMods(inst)
    assert.equal((dupes.groups || []).length, 0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
