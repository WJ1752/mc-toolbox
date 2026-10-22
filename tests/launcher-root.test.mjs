// 游戏目录解析：默认位置在启动器旁边；选中普通文件夹时使用其中的 .minecraft，
// 与 PCL / HMCL 的「选择启动器文件夹」习惯一致。这里只测纯函数，不写用户配置。
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { defaultRoot, resolveGameRoot } from '../src/server/launcher/state.js'

let tmpBase = ''

test.before(async () => {
  tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-root-'))
})

test.after(async () => {
  if (tmpBase) await fsp.rm(tmpBase, { recursive: true, force: true })
})

test('默认游戏目录是启动器旁边的 .minecraft', () => {
  assert.equal(path.basename(defaultRoot()), '.minecraft')
})

test('选择普通文件夹时在其中创建 / 使用 .minecraft', async () => {
  const picked = path.join(tmpBase, 'pcl')
  await fsp.mkdir(picked, { recursive: true })
  assert.equal(resolveGameRoot(picked), path.join(picked, '.minecraft'))
})

test('选择 .minecraft 本身时保持原样', async () => {
  const picked = path.join(tmpBase, 'direct', '.minecraft')
  await fsp.mkdir(picked, { recursive: true })
  assert.equal(resolveGameRoot(picked), picked)
})

test('选择已经是游戏根的文件夹时保持原样', async () => {
  const picked = path.join(tmpBase, 'legacy-minecraft')
  await fsp.mkdir(path.join(picked, 'versions'), { recursive: true })
  assert.equal(resolveGameRoot(picked), picked)
})
