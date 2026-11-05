import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { availableBytes, estimateInstallSpace } from '../src/server/launcher/install-space.js'

test('安装预估按目标卷、对象去重和文件大小计算，区分待下载、替换占用和未知项', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mtb-space-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const version = {
    downloads: { client: { size: 50 } },
    assetIndex: { id: 'test', size: 10, url: 'https://example.invalid/index' }
  }
  const hash = 'a'.repeat(40)
  const obj = path.join(root, 'assets', 'objects', 'aa')
  await fs.mkdir(obj, { recursive: true })
  await fs.writeFile(path.join(obj, hash), Buffer.alloc(30))
  const client = path.join(root, 'versions', 'test')
  await fs.mkdir(client, { recursive: true })
  await fs.writeFile(path.join(client, 'test.jar'), Buffer.alloc(20))
  const settings = { downloadAssets: true }
  const result = await estimateInstallSpace({ mc: 'test', loader: 'forge' }, {
    root, version, settings, readRemoteIndex: async () => ({
      objects: { first: { hash, size: 30 }, alias: { hash, size: 30 } }
    })
  })
  assert.equal(result.cachedBytes, 30)
  assert.equal(result.downloadBytes, 60)
  assert.equal(result.growthBytes, 40)
  assert.equal(result.largestPartBytes, 50)
  assert.equal(result.minimumFreeBytes, 50)
  assert.match(result.notes.join(' '), /加载器/)
  assert.ok(await availableBytes(path.join(root, 'not', 'created')) > 0)

  version.downloads.client.size = Number.MAX_SAFE_INTEGER
  const insufficient = await estimateInstallSpace({ mc: 'test' }, {
    root, version, settings: { downloadAssets: false }, readRemoteIndex: assert.fail
  })
  assert.equal(insufficient.insufficient, true)
})
