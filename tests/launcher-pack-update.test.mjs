import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { makeZip } from './helpers/zip.mjs'
import { readPackMeta } from '../src/server/launcher/install.js'
import { isNewerPack } from '../src/server/launcher/pack-update.js'
import { resolveOnlinePack } from '../src/server/launcher/pack-online.js'
import {
  manifestMods, modConflicts, compareEntries, mergePlayerOptions, localPackFiles, readPackMarker, writePackMarker
} from '../src/server/launcher/pack-baseline.js'

test('版本检查不建议降级、相同版本及缺发布时间，拒绝其他 CurseForge 项目的文件', async () => {
  const current = { versionId: 'old', date: '2026-01-01' }
  assert.equal(isNewerPack(current, { versionId: 'new', date: '2026-02-01' }), true)
  for (const version of [current, { versionId: 'a', date: '2025-12-01' }, { versionId: 'b' }]) {
    assert.equal(isNewerPack(current, version), false)
  }
  const fetcher = async url => ({
    ok: true, json: async () => ({ data: url.includes('/files?') ? [{ modId: 987, id: 52 }] : { id: 123 } })
  })
  await assert.rejects(resolveOnlinePack({ source: 'curseforge', projectId: '123', apiKey: 'test', fetcher }), /项目不一致/)
})

test('整包清单跟踪改名、玩家禁用及 CurseForge 未映射项，区分本地冲突', () => {
  const meta = (name, sha1) => ({ index: { files: [{ path: 'mods/' + name, hashes: { sha1 }, downloads: [
    'https://cdn.modrinth.com/data/abc/versions/ver/' + name
  ] }] } })
  const old = manifestMods(meta('item-1.jar', 'old'))
  const next = manifestMods(meta('item-2.jar', 'new'))
  const local = { added: ['mods/item-1.jar.disabled'], changed: [], removed: ['mods/item-1.jar'] }
  assert.deepEqual(compareEntries(old, next).changed, ['mods/item-1.jar → mods/item-2.jar'])
  assert.equal(modConflicts(old, next, local).conflicts.length, 1)
  const cf = manifestMods({ kind: 'curseforge', manifest: { files: [{ projectID: 1, fileID: 11 }] } })
  assert.deepEqual(modConflicts([], cf, local), { conflicts: [], unmapped: ['CF #1'] })
  assert.equal(modConflicts(old, [], local).conflicts.length, 1)
})

test('旧版设置只合并玩家偏好，保留新版的格式、资源包和新按键默认值', () => {
  const result = mergePlayerOptions('version:1\nkey_jump:key.old\nlang:zh_cn\nresourcePacks:["old"]\n', 'version:2\nresourcePacks:["new"]\nkey_jump:key.new\nkey_new:unbound\n')
  assert.equal(result, 'version:2\nresourcePacks:["new"]\nkey_jump:key.old\nkey_new:unbound\nlang:zh_cn\n')
})

test('真实压缩包提取 CRC，独立保存持久基线，检测同大小配置变更', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mtb-pack-review-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const origin = { source: 'modrinth', projectId: 'abc', versionId: '123' }
  const archive = path.join(root, 'demo.mrpack')
  await fs.writeFile(archive, makeZip([
    ['modrinth.index.json', JSON.stringify({ dependencies: { minecraft: '1.20.1' }, files: [] })],
    ['overrides/config/demo.cfg', '123456789']
  ]))
  const meta = await readPackMeta(archive)
  assert.equal(meta.overrideConfigs[0].digest, 'zip:' + 0xcbf43926)
  await fs.mkdir(path.join(root, 'config'))
  await fs.writeFile(path.join(root, 'config', 'demo.cfg'), '123456789')
  await writePackMarker(root, { origin, manifest: [], configs: meta.overrideConfigs, local: await localPackFiles(root) })
  assert.equal((await readPackMarker(root)).local, undefined)
  const saved = await readPackMarker(root, { includeBaseline: true })
  await fs.writeFile(path.join(root, 'config', 'demo.cfg'), '987654321')
  assert.deepEqual(compareEntries(saved.local, await localPackFiles(root)).changed, ['config/demo.cfg'])
})
