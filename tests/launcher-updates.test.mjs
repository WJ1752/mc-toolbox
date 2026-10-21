import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { sha1OfFile } from '../src/server/launcher/updates.js'

test('sha1OfFile hashes jar bytes and caches by size/mtime', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-updates-'))
  const file = path.join(dir, 'sample.jar')
  const bytes = Buffer.from('fake jar payload for hashing')
  try {
    await fs.writeFile(file, bytes)
    const expected = crypto.createHash('sha1').update(bytes).digest('hex')
    assert.equal(await sha1OfFile(file), expected)
    assert.equal(await sha1OfFile(file), expected)
    await fs.writeFile(file, Buffer.concat([bytes, Buffer.from('!')]))
    assert.notEqual(await sha1OfFile(file), expected)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
