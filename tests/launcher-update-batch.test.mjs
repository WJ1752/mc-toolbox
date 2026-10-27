// 版本检查批量化：331 个模组不应该发 662 个请求。这里用假 fetcher 验证
// 只发两次批量 POST（已安装版本 + 最新兼容版本），且更新判断与旧行为一致。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { makeZip } from './helpers/zip.mjs'
import { findModUpdates, clearHashCache } from '../src/server/launcher/updates.js'

test('版本检查只发两次批量请求，并正确区分可更新 / 已最新', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-update-batch-'))
  const gameDir = path.join(root, 'versions', 'demo')
  const mods = path.join(gameDir, 'mods')
  try {
    await fs.mkdir(mods, { recursive: true })
    const oldJar = makeZip([['fabric.mod.json', JSON.stringify({ id: 'old', version: '1.0.0' })]])
    const currentJar = makeZip([['fabric.mod.json', JSON.stringify({ id: 'current', version: '2.0.0' })]])
    await fs.writeFile(path.join(mods, 'old.jar'), oldJar)
    await fs.writeFile(path.join(mods, 'current.jar'), currentJar)
    const oldHash = crypto.createHash('sha1').update(oldJar).digest('hex')
    const currentHash = crypto.createHash('sha1').update(currentJar).digest('hex')
    const calls = []
    const installed = {
      [oldHash]: { id: 'old-v1', project_id: 'p-old', version_number: '1.0.0', date_published: '2025-01-01T00:00:00Z', version_type: 'release' },
      [currentHash]: { id: 'cur-v2', project_id: 'p-cur', version_number: '2.0.0', date_published: '2025-02-01T00:00:00Z', version_type: 'release' }
    }
    const latest = {
      [oldHash]: { ...installed[oldHash], id: 'old-v2', version_number: '1.1.0', date_published: '2025-03-01T00:00:00Z', files: [{ primary: true, url: 'https://example.invalid/old-1.1.0.jar', filename: 'old-1.1.0.jar', size: 10 }] },
      [currentHash]: { ...installed[currentHash], files: [{ primary: true, url: 'https://example.invalid/current-2.0.0.jar', filename: 'current-2.0.0.jar', size: 10 }] }
    }
    const fetcher = async (url, options) => {
      calls.push({ url, method: options.method, body: JSON.parse(options.body || '{}') })
      const data = url.endsWith('/version_files/update') ? latest : installed
      return { ok: true, status: 200, json: async () => data }
    }
    clearHashCache()
    const inst = { id: 'batch-test', root, folder: 'demo', mc: '1.20.1', loader: 'fabric' }
    const result = await findModUpdates(inst, { force: true, fetcher })
    assert.equal(result.total, 2)
    assert.equal(result.unknown.length, 0)
    assert.equal(result.updates.length, 1, '只有 old.jar 有新版本')
    assert.equal(result.updates[0].current.number, '1.0.0')
    assert.equal(result.updates[0].latest.number, '1.1.0')
    assert.equal(result.items.find((item) => item.current.number === '2.0.0').latest.number, '2.0.0')
    assert.equal(calls.length, 2, '两个批量接口各一次')
    assert.ok(calls.every((call) => call.method === 'POST'))
    assert.equal(calls[1].body.loaders[0], 'fabric')
    assert.equal(calls[1].body.game_versions[0], '1.20.1')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
