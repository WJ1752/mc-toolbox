// 模组对称补齐：差异分类要准，落盘要稳（不删用户文件、校验失败不写）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  applyJar,
  diffManifests,
  fillPlan,
  findStagedBySha,
  manifestFromItems,
  normalizeModId,
  stagingDirFor
} from '../src/server/friends/mods-sync.js'
import { sanitizeFileName } from '../src/server/friends/transfer.js'

const sha = (text) => crypto.createHash('sha1').update(text).digest('hex')

function mod(overrides = {}) {
  const file = overrides.file || 'example.jar'
  return {
    file,
    relPath: file,
    size: 100,
    sha1: sha(file),
    modid: file.replace('.jar', ''),
    name: file,
    version: '1.0',
    enabled: true,
    loader: 'fabric',
    ...overrides
  }
}

test('清单过滤：缺少文件或 SHA-1 的条目直接丢弃', () => {
  const items = manifestFromItems([
    { file: 'a.jar', sha1: sha('a.jar'), size: 1, modid: 'a' },
    { file: 'b.jar', sha1: 'not-a-hash', size: 1 },
    { relPath: 'c.jar', sha1: sha('c.jar'), disabled: true }
  ])
  assert.equal(items.length, 2)
  assert.equal(items[0].relPath, 'a.jar')
  assert.equal(items[1].enabled, false)
})

test('差异分类：一致 / 版本不同 / 启用状态不同 / 单边独有', () => {
  const jei = mod({ file: 'jei.jar', modid: 'jei' })
  const sodium = mod({ file: 'sodium.jar', modid: 'sodium' })
  const iris = mod({ file: 'iris.jar', modid: 'iris' })
  const mine = [jei, sodium, iris]
  const peer = [
    jei,
    mod({ file: 'sodium-2.jar', modid: 'sodium', version: '2.0' }),
    mod({ file: 'create.jar', modid: 'create' })
  ]
  const diff = diffManifests(mine, peer)
  assert.equal(diff.same.length, 1)
  assert.equal(diff.same[0].mine.file, 'jei.jar')
  assert.equal(diff.different.length, 1)
  assert.equal(diff.different[0].reason, 'version')
  assert.equal(diff.different[0].peer.file, 'sodium-2.jar')
  assert.equal(diff.onlyMine.length, 1)
  assert.equal(diff.onlyMine[0].file, 'iris.jar')
  assert.equal(diff.onlyPeer.length, 1)
  assert.equal(diff.onlyPeer[0].file, 'create.jar')
  assert.equal(diff.counts.symmetric, false)
})

test('同一个 jar 但一侧停用算「状态不同」，不算一致', () => {
  const mine = [mod({ file: 'jei.jar', enabled: true })]
  const peer = [mod({ file: 'jei.jar', enabled: false })]
  const diff = diffManifests(mine, peer)
  assert.equal(diff.same.length, 0)
  assert.equal(diff.different.length, 1)
  assert.equal(diff.different[0].reason, 'enabled')
})

test('没有 modid 时按文件名匹配版本差异', () => {
  const mine = [mod({ file: 'unknown-mod.jar', modid: '' })]
  const peer = [mod({ file: 'unknown-mod.jar', modid: '', version: '2.0', sha1: sha('v2') })]
  const diff = diffManifests(mine, peer)
  assert.equal(diff.different.length, 1)
  assert.equal(diff.different[0].reason, 'version')
})

test('补齐计划（以对方为准）：拿对方的、停用自己的，执行后完全对称', () => {
  const jei = mod({ file: 'jei.jar', modid: 'jei' })
  const sodium = mod({ file: 'sodium.jar', modid: 'sodium' })
  const iris = mod({ file: 'iris.jar', modid: 'iris' })
  const create = mod({ file: 'create.jar', modid: 'create' })
  const mine = [jei, sodium, iris]
  const peer = [jei, mod({ file: 'sodium-2.jar', modid: 'sodium', version: '2.0' }), create]

  const plan = fillPlan(diffManifests(mine, peer), 'acquire')
  assert.equal(plan.mode, 'acquire')
  assert.deepEqual(plan.acquire.map((entry) => entry.item.file).sort(), ['create.jar', 'sodium-2.jar'])
  assert.deepEqual(plan.disable.map((entry) => entry.item.file).sort(), ['iris.jar', 'sodium.jar'])
  assert.equal(plan.toggle.length, 0)

  // 执行后：mine = peer 的集合（旧版本与对方没有的都停用，不再参与比较）
  const afterMine = [jei, peer[1], create]
  assert.equal(diffManifests(afterMine, peer).counts.symmetric, true)
})

test('补齐计划（发送方向）只挑我独有的文件，不做任何停用', () => {
  const jei = mod({ file: 'jei.jar', modid: 'jei' })
  const iris = mod({ file: 'iris.jar', modid: 'iris' })
  const peer = [jei]
  const plan = fillPlan(diffManifests([jei, iris], peer), 'send')
  assert.equal(plan.mode, 'send')
  assert.deepEqual(plan.acquire.map((entry) => entry.item.file), ['iris.jar'])
  assert.equal(plan.disable.length, 0)
})

test('同一个 jar 只是启用状态不同：只切换，不传文件', () => {
  const mine = [mod({ file: 'jei.jar', enabled: true })]
  const peer = [mod({ file: 'jei.jar', enabled: false })]
  const plan = fillPlan(diffManifests(mine, peer), 'acquire')
  assert.equal(plan.acquire.length, 0)
  assert.equal(plan.disable.length, 0)
  assert.equal(plan.toggle.length, 1)
  assert.equal(plan.toggle[0].enabled, false)
})

test('modid 归一化忽略大小写与分隔符', () => {
  assert.equal(normalizeModId('Yumi-Commons_Core'), normalizeModId('yumi_commons_core'))
  assert.equal(normalizeModId(' Yumi Commons Core '), 'yumicommonscore')
})

test('暂存目录 id 不允许路径穿越', () => {
  assert.equal(stagingDirFor('/tmp/received', 'in_abc-123'), path.join('/tmp/received', 'in_abc-123'))
  assert.throws(() => stagingDirFor('/tmp/received', '../evil'), /传输 id 无效/)
  assert.throws(() => stagingDirFor('/tmp/received', ''), /传输 id 无效/)
})

test('applyJar：写入、跳过相同文件、冲突时停用旧文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mctb-friends-jar-'))
  const source = path.join(dir, 'source.jar')
  fs.writeFileSync(source, 'jar-content-v1')
  const sha1 = sha('jar-content-v1')
  const modsDir = path.join(dir, 'mods')
  const first = await applyJar({ sourceFile: source, targetDir: modsDir, filename: 'example.jar', sha1 })
  assert.equal(first.skipped, false)
  assert.equal(fs.readFileSync(path.join(modsDir, 'example.jar'), 'utf8'), 'jar-content-v1')

  const again = await applyJar({ sourceFile: source, targetDir: modsDir, filename: 'example.jar', sha1 })
  assert.equal(again.skipped, true)

  fs.writeFileSync(source, 'jar-content-v2')
  const next = await applyJar({ sourceFile: source, targetDir: modsDir, filename: 'example.jar', sha1: sha('jar-content-v2') })
  assert.equal(next.skipped, false)
  assert.equal(fs.readFileSync(path.join(modsDir, 'example.jar'), 'utf8'), 'jar-content-v2')
  assert.equal(fs.readFileSync(path.join(modsDir, 'example.jar.disabled'), 'utf8'), 'jar-content-v1')
})

test('applyJar：哈希不符拒绝落盘，文件名穿越被消毒', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mctb-friends-jar2-'))
  const source = path.join(dir, 'source.jar')
  fs.writeFileSync(source, 'content')
  const modsDir = path.join(dir, 'mods')
  await assert.rejects(
    () => applyJar({ sourceFile: source, targetDir: modsDir, filename: '../../evil.jar', sha1: sha('other') }),
    /校验失败/
  )
  assert.equal(fs.existsSync(path.join(dir, 'evil.jar')), false)
  const result = await applyJar({ sourceFile: source, targetDir: modsDir, filename: '../../evil.jar', sha1: sha('content') })
  assert.equal(path.basename(result.file), 'evil.jar')
  assert.equal(fs.existsSync(path.join(modsDir, 'evil.jar')), true)
})

test('按 SHA-1 在暂存目录找已收到的 jar', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mctb-friends-stage-'))
  fs.writeFileSync(path.join(dir, 'a.jar'), 'aaa')
  fs.writeFileSync(path.join(dir, 'b.jar.disabled'), 'bbb')
  assert.equal(await findStagedBySha(dir, sha('bbb')), path.join(dir, 'b.jar.disabled'))
  assert.equal(await findStagedBySha(dir, sha('none')), '')
})

test('消毒后的文件名仍保留 .jar 扩展名', () => {
  assert.equal(sanitizeFileName('..\\..\\bad name?.jar'), 'bad name_.jar')
})
