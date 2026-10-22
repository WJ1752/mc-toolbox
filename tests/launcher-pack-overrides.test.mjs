// 整合包覆盖文件：客户端只解压 overrides / client-overrides，
// server-overrides 不能进客户端实例；根目录杂项也不能落进实例。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { copyPackOverrides } from '../src/server/launcher/install.js'

const fakeJob = { signal: { throwIfAborted() {} }, log() {} }

let tmp = ''
let packDir = ''
let gameDir = ''

test.beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-pack-overrides-'))
  packDir = path.join(tmp, 'pack')
  gameDir = path.join(tmp, 'game')
  await fs.mkdir(gameDir, { recursive: true })
})

test.afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true })
})

async function writeFile(rel, content) {
  const full = path.join(packDir, ...rel.split('/'))
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
}

test('客户端安装不复制 server-overrides，overrides 与 client-overrides 正常落地', async () => {
  await writeFile('overrides/config/client.cfg', 'client')
  await writeFile('client-overrides/config/client-only.cfg', 'client-only')
  await writeFile('server-overrides/config/server.cfg', 'server')
  await writeFile('server-overrides/mods/server-mod.jar', 'jar')

  await copyPackOverrides(packDir, gameDir, 'modrinth', fakeJob)

  assert.equal(await fs.readFile(path.join(gameDir, 'config/client.cfg'), 'utf8'), 'client')
  assert.equal(await fs.readFile(path.join(gameDir, 'config/client-only.cfg'), 'utf8'), 'client-only')
  await assert.rejects(fs.stat(path.join(gameDir, 'config/server.cfg')))
  await assert.rejects(fs.stat(path.join(gameDir, 'mods/server-mod.jar')))
})

test('Modrinth 包根目录的 README 等杂项不会被复制', async () => {
  await writeFile('overrides/config/a.cfg', 'a')
  await writeFile('README.md', 'readme')
  await writeFile('pack.png', 'png')

  await copyPackOverrides(packDir, gameDir, 'modrinth', fakeJob)

  assert.equal(await fs.readFile(path.join(gameDir, 'config/a.cfg'), 'utf8'), 'a')
  await assert.rejects(fs.stat(path.join(gameDir, 'README.md')))
  await assert.rejects(fs.stat(path.join(gameDir, 'pack.png')))
})

test('CurseForge 包没有 overrides 目录时兼容根目录布局', async () => {
  await writeFile('config/root.cfg', 'root')
  await writeFile('mods/root-mod.jar', 'jar')

  await copyPackOverrides(packDir, gameDir, 'curseforge', fakeJob)

  assert.equal(await fs.readFile(path.join(gameDir, 'config/root.cfg'), 'utf8'), 'root')
  assert.equal(await fs.readFile(path.join(gameDir, 'mods/root-mod.jar'), 'utf8'), 'jar')
})

test('清单里的 overrides 越界路径会被拒绝，退回默认目录', async () => {
  await writeFile('overrides/config/safe.cfg', 'safe')
  // 压缩包外的诱饵目录：如果 overrides 被直接拼接就会把它搬进来
  const outside = path.join(tmp, 'outside')
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(outside, 'evil.cfg'), 'evil')

  await copyPackOverrides(packDir, gameDir, 'modrinth', fakeJob, { overrides: '../outside' })

  assert.equal(await fs.readFile(path.join(gameDir, 'config/safe.cfg'), 'utf8'), 'safe')
  await assert.rejects(fs.stat(path.join(gameDir, 'evil.cfg')))
})
