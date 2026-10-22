// ZIP 读取器回归测试：中央目录大于“只扫文件末尾 2 MiB”的旧窗口时，
// 仍要能按 EOCD 记录的偏移读到条目（真实整合包 overrides 条目多时目录就有 3 MB）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { makeZip } from './helpers/zip.mjs'
import { readJarEntries } from '../src/server/zip.js'
import { readPackSummary } from '../src/server/launcher/install.js'

const MANIFEST = JSON.stringify({
  formatVersion: 1,
  game: 'minecraft',
  versionId: '2.8',
  name: '大目录整合包',
  dependencies: { minecraft: '1.21.1', neoforge: '21.1.190' }
})

async function tempFile(name, buffer) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-zip-'))
  const file = path.join(dir, name)
  await fsp.writeFile(file, buffer)
  return { dir, file }
}

function bigPack() {
  const entries = [['modrinth.index.json', Buffer.from(MANIFEST, 'utf8')]]
  // 24000 个 overrides 条目：中央目录约 3 MB，明显超过旧的 2 MiB 尾部窗口。
  for (let i = 0; i < 24000; i++) {
    entries.push([`overrides/config/kubejs/assets/toolbox/textures/block/filler_${String(i).padStart(5, '0')}.png`, Buffer.alloc(0)])
  }
  return makeZip(entries)
}

test('中央目录超过 2 MiB 时仍能读到根目录清单', async () => {
  const buffer = bigPack()
  const cdSize = 24001 * 46 + Buffer.byteLength('modrinth.index.json') +
    24000 * Buffer.byteLength('overrides/config/kubejs/assets/toolbox/textures/block/filler_00000.png')
  assert.ok(cdSize > 2 * 1024 * 1024, '用例必须让中央目录超出旧的 2 MiB 尾部窗口')

  const { dir, file } = await tempFile('big.zip', buffer)
  try {
    const stats = {}
    const entries = await readJarEntries(file, ['modrinth.index.json', 'manifest.json'], {
      maxBytes: 24 * 1024 * 1024,
      stats
    })
    assert.equal(stats.zip, true, '应当解析到中央目录')
    assert.equal(stats.entries, 24001)
    assert.ok(entries['modrinth.index.json'], '清单条目不应为 null')
    assert.equal(entries['modrinth.index.json'].toString('utf8'), MANIFEST)
    assert.equal(entries['manifest.json'], null)

    const meta = await readPackSummary(file)
    assert.equal(meta.kind, 'modrinth')
    assert.equal(meta.mc, '1.21.1')
    assert.equal(meta.loader, 'neoforge')
    assert.equal(meta.loaderVersion, '21.1.190')
    assert.equal(meta.name, '大目录整合包')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('普通小包、通配符与 stats 行为保持不变', async () => {
  const { dir, file } = await tempFile('small.jar', makeZip([
    ['META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\n')],
    ['fabric.mod.json', Buffer.from('{"id":"demo"}')],
    ['demo/one.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe])],
    ['demo/two.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe])]
  ]))
  try {
    const stats = {}
    const entries = await readJarEntries(file, ['fabric.mod.json', '*.class', 'missing.json'], { stats })
    assert.equal(stats.zip, true)
    assert.equal(stats.entries, 4)
    assert.equal(entries['fabric.mod.json'].toString('utf8'), '{"id":"demo"}')
    assert.equal(entries['demo/one.class'].length, 4)
    assert.equal(entries['demo/two.class'].length, 4)
    assert.equal(entries['missing.json'], null)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('stats 能区分“目录读不出来”与“ZIP 里没有清单”', async () => {
  // 有 ZIP 头但中央目录被截断：looksLikeZip 通过，读目录失败。
  const truncated = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(256, 0x41)])
  const { dir, file } = await tempFile('truncated.zip', truncated)
  const other = await tempFile('other.zip', makeZip([['readme.txt', Buffer.from('hi')]]))
  try {
    const broken = {}
    assert.deepEqual(await readJarEntries(file, ['modrinth.index.json'], { stats: broken }), {
      'modrinth.index.json': null
    })
    assert.equal(broken.zip, false)
    await assert.rejects(readPackSummary(file), /无法读取整合包目录/)

    const empty = {}
    await readJarEntries(other.file, ['modrinth.index.json'], { stats: empty })
    assert.equal(empty.zip, true)
    assert.equal(empty.entries, 1)
    await assert.rejects(readPackSummary(other.file), /缺少 modrinth\.index\.json 或 manifest\.json/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
    await fsp.rm(other.dir, { recursive: true, force: true })
  }
})
