import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { writeUpload } from '../src/server/launcher/content.js'
import { receiveUpload } from '../src/server/upload.js'

test('实例上传并发重名时保留两份内容，中断或超限时清理暂存文件', async () => {
  const gameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-content-upload-'))
  const upload = (req) => writeUpload({ gameDir }, 'resourcepacks', 'sample.ZIP', req)
  try {
    const contents = ['first', 'second']
    const saved = await Promise.all(contents.map(text => upload(Readable.from([Buffer.from(text)]))))
    assert.equal(new Set(saved.map(item => item.file)).size, 2)
    for (const [index, item] of saved.entries()) {
      assert.equal(item.size, contents[index].length)
      assert.equal(await fs.readFile(path.join(item.dir, item.file), 'utf8'), contents[index])
    }
    const broken = Readable.from((async function* () {
      yield Buffer.from('partial')
      throw new Error('断开')
    })())
    await assert.rejects(upload(broken), /断开/)
    await assert.rejects(upload(Readable.from([])), /为空/)
    await assert.rejects(upload({ headers: { 'content-length': 512 * 1024 ** 2 + 1 } }), /512 MiB/)
    const dir = saved[0].dir
    await assert.rejects(receiveUpload(Readable.from([Buffer.alloc(3), Buffer.alloc(2)]), 'payload', {
      parent: dir, maxBytes: 4, limitMessage: '超限'
    }), /超限/)
    assert.deepEqual((await fs.readdir(dir)).sort(), saved.map(item => item.file).sort())
  } finally {
    await fs.rm(gameDir, { recursive: true, force: true })
  }
})
