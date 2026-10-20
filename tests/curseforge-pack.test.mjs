import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import http from 'node:http'
import { hydrateCurseForgeFiles } from '../src/server/curseforge-pack.js'
import { downloadVerified } from '../src/server/verified-download.js'

test('CurseForge pins export file IDs, verifies cached files and downloads every declared mod', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-cf-test-')), progress = []
  try {
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ manifestType: 'minecraftModpack', files: [{ projectID: 101, fileID: 202 }] }))
    const bytes = Buffer.from('exact exported version'), sha = crypto.createHash('sha1').update(bytes).digest('hex')
    let queries = 0, downloads = 0
    const options = { cacheDir: path.join(root, 'cache'), apiKey: 'test-key',
      fetcher: async (url, opts) => {
        queries++; assert.ok(url.endsWith('/mods/101/files/202')); assert.equal(opts.headers['x-api-key'], 'test-key')
        return { ok: true, json: async () => ({ data: { id: 202, modId: 101, fileName: 'exact.jar', downloadUrl: 'https://example.invalid/exact.jar', hashes: [{ algo: 1, value: sha }], fileLength: bytes.length } }) }
      }, download: async (_url, file, opts) => { downloads++; assert.equal(opts.hash, sha); await fs.writeFile(file, bytes) }
    }
    await hydrateCurseForgeFiles(root, p => progress.push(p), null, options)
    assert.equal(await fs.readFile(path.join(root, 'mods/exact.jar'), 'utf8'), bytes.toString())
    await hydrateCurseForgeFiles(root, null, null, options)
    assert.equal(queries, 1); assert.equal(downloads, 1)
    await fs.writeFile(path.join(root, 'cache/202-exact.jar'), 'corrupt')
    await fs.rm(path.join(root, 'mods/exact.jar'))
    await hydrateCurseForgeFiles(root, null, null, options)
    assert.equal(downloads, 2)
    assert.equal(progress.at(-1).progress, 43)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('author-disabled downloads produce an actionable client-side message', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-cf-blocked-')), progress = []
  try {
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ manifestType: 'minecraftModpack', files: [
      { projectID: 101, fileID: 202 },
      { projectID: 303, fileID: 404 }
    ] }))
    const options = { cacheDir: path.join(root, 'cache'), apiKey: 'test-key',
      fetcher: async (url) => {
        if (url.endsWith('/mods/101/files/202')) {
          return { ok: true, json: async () => ({ data: {
            id: 202, modId: 101, fileName: 'allowed.jar', downloadUrl: 'https://example.invalid/allowed.jar',
            hashes: [{ algo: 1, value: 'a'.repeat(40) }], fileLength: 1
          } }) }
        }
        return { ok: true, json: async () => ({ data: {
          id: 404, modId: 303, fileName: 'blocked.jar', downloadUrl: null,
          hashes: [{ algo: 1, value: 'b'.repeat(40) }], fileLength: 1
        } }) }
      },
      download: async (_url, file) => { await fs.writeFile(file, 'x') }
    }
    await assert.rejects(
      hydrateCurseForgeFiles(root, p => progress.push(p), null, options),
      (error) => {
        assert.match(error.message, /禁止第三方启动器自动下载/)
        assert.match(error.message, /303\/404/)
        assert.match(error.message, /mods \/ resourcepacks \/ shaderpacks/)
        assert.doesNotMatch(error.message, /服务端/)
        return true
      }
    )
    assert.deepEqual(await fs.readdir(path.join(root, 'mods')), ['allowed.jar'])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('manually supplied files with matching SHA-1 satisfy blocked CurseForge downloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-cf-local-'))
  try {
    const bytes = Buffer.from('manually downloaded mod')
    const sha = crypto.createHash('sha1').update(bytes).digest('hex')
    const cache = path.join(root, 'cache')
    await fs.mkdir(cache, { recursive: true })
    await fs.writeFile(path.join(cache, '202-blocked.jar'), bytes)
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ manifestType: 'minecraftModpack', files: [{ projectID: 101, fileID: 202 }] }))
    let downloads = 0
    await hydrateCurseForgeFiles(root, null, null, {
      cacheDir: cache, apiKey: 'test-key',
      fetcher: async () => ({ ok: true, json: async () => ({ data: {
        id: 202, modId: 101, fileName: 'blocked.jar', downloadUrl: null,
        hashes: [{ algo: 1, value: sha }], fileLength: bytes.length
      } }) }),
      download: async () => { downloads++ }
    })
    assert.equal(downloads, 0)
    assert.deepEqual(await fs.readFile(path.join(root, 'mods/blocked.jar')), bytes)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('corrupt HTTP downloads fail hash validation and never publish partial files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-hash-test-'))
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Length': '3' }); res.end('bad') })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const file = path.join(root, 'mod.jar')
    await assert.rejects(downloadVerified(`http://127.0.0.1:${server.address().port}/file`, file, { size: 3, hash: 'a'.repeat(64) }), /哈希/)
    assert.deepEqual(await fs.readdir(root), [])
  } finally { await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }) }
})
