import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { makeZip } from './helpers/zip.mjs'
import { convertPack, extractZip } from '../src/server/pack-converter.js'

test('Modrinth retries a corrupt mirror, replaces stale files and reports transferred bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-mr-download-'))
  const jar = makeZip([['fabric.mod.json', JSON.stringify({ id: 'servermod', version: '1.0', environment: '*' })]])
  const hash = crypto.createHash('sha512').update(jar).digest('hex')
  const requests = [], progress = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    const bytes = req.url === '/bad' ? Buffer.alloc(jar.length) : jar
    res.writeHead(200, { 'Content-Length': String(bytes.length) }); res.end(bytes)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const source = path.join(root, 'source')
    await fs.mkdir(path.join(source, 'mods'), { recursive: true })
    await fs.writeFile(path.join(source, 'mods/server.jar'), 'stale')
    const base = `http://127.0.0.1:${server.address().port}`
    await fs.writeFile(path.join(source, 'modrinth.index.json'), JSON.stringify({
      dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.0' },
      files: [{ path: 'mods/server.jar', hashes: { sha512: hash }, fileSize: jar.length, downloads: [base + '/bad', base + '/good'] }]
    }))
    const result = await convertPack({ source, outputDir: root, onProgress: p => progress.push(p) })
    assert.deepEqual(requests, ['/bad', '/good'])
    assert.equal(result.indexedFiles.downloaded, 1)
    assert.equal(result.totalMods, 1)
    assert.ok(progress.some(p => p.detail.includes('已下载')))
    const unpack = path.join(root, 'unpack')
    await extractZip(result.output, unpack)
    assert.deepEqual(await fs.readFile(path.join(unpack, 'mods/server.jar')), jar)
    assert.equal(await fs.readFile(path.join(source, 'mods/server.jar'), 'utf8'), 'stale')
  } finally {
    await new Promise(resolve => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  }
})
