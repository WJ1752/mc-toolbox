// Forge / NeoForge 的 mods.toml 依赖解析：只从 [[mods]] 取宿主 modid，
// 并正确跳过 optional / incompatible / 仅客户端依赖，避免误报「必需依赖缺失」。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { readModMeta } from '../src/server/mods.js'
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
