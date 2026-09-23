import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { convertPack } from '../src/server/pack-converter.js'
import { inspectPack, inspectMetadata } from '../src/server/pack-preview.js'
import { readPackMetadata } from '../public/js/core/pack-preview.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-preview-'))
try {
  const source = path.join(root, 'fixture')
  await fs.mkdir(path.join(source, 'wrapper'), { recursive: true })
  await fs.writeFile(path.join(source, 'wrapper/launcher-version.json'), JSON.stringify({ addons: [{ id: 'game', version: '1.12.2' }, { id: 'forge', version: '14.23.5.2855' }] }))
  await fs.writeFile(path.join(source, 'wrapper/irrelevant.json'), '{"components": {}, "libraries": {}}')
  const result = await convertPack({ source, outputDir: root })
  const runtime = await inspectPack(result.output)
  assert.equal(runtime.mc, '1.12.2')
  assert.equal(runtime.loaderVersion, '14.23.5.2855')
  assert.equal((await inspectPack(source)).mc, runtime.mc)
  // Use browser-compatible slices, then send the same bounded metadata to the server.
  const file = new Blob([await fs.readFile(result.output)])
  const records = await readPackMetadata(file.size, (offset, length) => file.slice(offset, offset + length).arrayBuffer())
  assert.deepEqual(await inspectMetadata(records), runtime)
  await assert.rejects(readPackMetadata(5 * 1024 ** 3, () => { throw new Error('must not read') }), /4 GB/)
  let inspectedBytes = 0
  const largeSize = 3 * 1024 ** 3
  const emptyEnd = Buffer.alloc(22); emptyEnd.writeUInt32LE(0x06054b50)
  const large = await readPackMetadata(largeSize, (offset, length) => {
    inspectedBytes += length
    const bytes = new Uint8Array(length)
    if (offset + length === largeSize) bytes.set(emptyEnd, length - 22)
    return bytes
  })
  assert.equal(large.length, 0)
  assert.ok(inspectedBytes < 70000, '3 GB ZIP preview reads only bounded directory slices')
  await assert.rejects(readPackMetadata(3, () => new Uint8Array(3)), /ZIP/)
  await assert.rejects(inspectMetadata([{ name: 'manifest.json', size: 1, method: 0, data: btoa('oversized') }]), /校验/)
  await assert.rejects(inspectMetadata([{ name: 'manifest.json', size: 3 * 1024 ** 2, method: 0, data: '' }]), /无效/)
  console.log('✓ 目录、ZIP、浏览器 File 分片识别一致；无效 ZIP 与大小上限校验通过')
} finally { await fs.rm(root, { recursive: true, force: true }) }
