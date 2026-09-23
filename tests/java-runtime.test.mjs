import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createJavaRuntimeManager } from '../src/server/java-runtime.js'
import { DOWNLOADABLE_JAVA_MAJORS } from '../src/server/java-runtime.js'

assert.deepEqual(DOWNLOADABLE_JAVA_MAJORS, Array.from({ length: 18 }, (_, i) => i + 8))

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const settled = async (manager, id) => {
  for (let i = 0; i < 200; i++) { const j = manager.get(id); if (['done', 'failed', 'cancelled'].includes(j.status)) return j; await wait(10) }
  throw new Error('Java job did not finish')
}
test('Java download is deduplicated, verified and published only when complete', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-java-job-'))
  let release
  const barrier = new Promise(resolve => { release = resolve })
  try {
    const manager = createJavaRuntimeManager({ root, platform: 'win32', arch: 'x64',
      fetcher: async () => ({ ok: true, json: async () => [{ binary: { package: { link: 'https://example.invalid/java.zip', name: 'java.zip', checksum: 'a'.repeat(64), size: 3 } } }] }),
      download: async (_url, file) => fs.writeFile(file, 'zip'),
      extract: async (_file, target, progress) => {
        await fs.mkdir(path.join(target, 'jdk/bin'), { recursive: true })
        await fs.writeFile(path.join(target, 'jdk/bin/java.exe'), 'fixture')
        progress(1); await barrier
      }, probe: async file => ({ path: file, major: 25, version: '25.0.1', bits: 64 })
    })
    const a = await manager.start(25), b = await manager.start(25)
    assert.equal(a.id, b.id)
    await wait(50)
    assert.deepEqual(await manager.list(), [])
    release()
    const result = await settled(manager, a.id)
    assert.equal(result.status, 'done')
    assert.ok(result.path.startsWith(path.join(root, '25')))
    assert.equal((await manager.list()).length, 1)
    assert.equal(manager.cancel(a.id), false)
    assert.ok(!('controller' in result))
  } finally { release(); await wait(30); await fs.rm(root, { recursive: true, force: true }) }
})

for (const mode of ['cancel', 'wrong-version', 'bad-download']) test(`Java ${mode} cannot become a usable runtime`, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-java-failure-'))
  try {
    const manager = createJavaRuntimeManager({ root, platform: 'win32', arch: 'x64',
      fetcher: async () => ({ ok: true, json: async () => [{ binary: { package: { link: 'https://example.invalid/java.zip', name: 'java.zip', checksum: 'a'.repeat(64), size: 3 } } }] }),
      download: async (_url, file, { signal }) => {
        await fs.writeFile(file, 'zip')
        if (mode === 'cancel') { await wait(50); signal.throwIfAborted() }
        if (mode === 'bad-download') throw new Error('下载文件哈希校验失败')
      },
      extract: async (_file, target) => { await fs.mkdir(path.join(target, 'bin')); await fs.writeFile(path.join(target, 'bin/java.exe'), 'partial') },
      probe: async file => ({ path: file, major: 21, bits: 64 })
    })
    const job = await manager.start(25)
    if (mode === 'cancel') { await wait(20); assert.equal(manager.cancel(job.id), true) }
    const result = await settled(manager, job.id)
    assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'failed')
    assert.deepEqual(await manager.list(), [])
    assert.equal(await fs.stat(path.join(root, '25')).catch(() => null), null)
    await wait(30)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
