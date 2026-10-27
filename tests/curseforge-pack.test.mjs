import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import http from 'node:http'
import { hydrateCurseForgeFiles, blockedFilesMessage } from '../src/server/curseforge-pack.js'
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
        // 缺 mod 属于致命错误：调用方据此保留实例，等用户补齐，而不是删库重来。
        assert.equal(error.code, 'CF_RESTRICTED')
        assert.deepEqual(error.blocked.map((item) => item.id), ['303/404'])
        assert.equal(error.blocked[0].fileName, 'blocked.jar')
        assert.equal(error.blocked[0].folder, 'mods')
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

test('缺失的只有光影/资源包时跳过并返回清单，不中断整合包安装', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-cf-optional-'))
  try {
    const allowed = Buffer.from('allowed-mod')
    const allowedSha = crypto.createHash('sha1').update(allowed).digest('hex')
    const shader = Buffer.from('shader-zip')
    const shaderSha = crypto.createHash('sha1').update(shader).digest('hex')
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({ manifestType: 'minecraftModpack', files: [
      { projectID: 101, fileID: 202 },
      { projectID: 303, fileID: 404 }
    ] }))
    const result = await hydrateCurseForgeFiles(root, null, null, {
      cacheDir: path.join(root, 'cache'), apiKey: 'test-key',
      fetcher: async (url) => {
        if (url.endsWith('/mods/101/files/202')) {
          return { ok: true, json: async () => ({ data: {
            id: 202, modId: 101, fileName: 'allowed.jar', downloadUrl: 'https://example.invalid/a.jar',
            hashes: [{ algo: 1, value: allowedSha }], fileLength: allowed.length
          } }) }
        }
        if (url.endsWith('/mods/303')) {
          return { ok: true, json: async () => ({ data: {
            id: 303, name: 'Some Shader', classId: 6552,
            links: { websiteUrl: 'https://www.curseforge.com/minecraft/shaders/some-shader' }
          } }) }
        }
        return { ok: true, json: async () => ({ data: {
          id: 404, modId: 303, fileName: 'some-shader.zip', downloadUrl: null,
          hashes: [{ algo: 1, value: shaderSha }], fileLength: shader.length
        } }) }
      },
      download: async (_url, file) => { await fs.writeFile(file, allowed) }
    })
    assert.equal(result.downloaded, 2)
    assert.equal(result.blocked.length, 1)
    assert.deepEqual(result.blocked[0], {
      id: '303/404',
      projectId: 303,
      fileId: 404,
      fileName: 'some-shader.zip',
      folder: 'shaderpacks',
      title: 'Some Shader',
      url: 'https://www.curseforge.com/minecraft/shaders/some-shader'
    })
    assert.deepEqual(await fs.readdir(path.join(root, 'mods')), ['allowed.jar'])
    assert.equal((await fs.readdir(root)).includes('shaderpacks'), false)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('blockedFilesMessage：错误提示保持简短，完整地址留给日志', () => {
  const blocked = Array.from({ length: 10 }, (_, i) => ({
    id: `${i}/1`, fileName: `f${i}.zip`, folder: 'shaderpacks',
    title: `t${i}`, url: `https://example.invalid/${i}`
  }))
  const msg = blockedFilesMessage(blocked)
  assert.match(msg, /10 个文件/)
  assert.match(msg, /0\/1（f0\.zip）/)
  assert.match(msg, /4\/1（f4\.zip）/)
  assert.match(msg, /等 10 个/)
  assert.doesNotMatch(msg, /f8\.zip/)
  // toast 里不放 118 条网页地址，完整清单在任务日志和实例目录
  assert.doesNotMatch(msg, /https:\/\/example\.invalid/)
  assert.match(msg, /\.mc-toolbox-missing-files\.txt/)
  assert.match(msg, /不会重复下载/)
  const withErrors = blockedFilesMessage(blocked.slice(0, 1), ['1/2：下载失败'])
  assert.match(withErrors, /下载失败/)
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

test('CurseForge 默认下载器会分段请求 CDN，而不是单连接硬扛', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-cf-range-'))
  const bytes = Buffer.alloc(5 * 1024 * 1024, 7)
  const sha = crypto.createHash('sha1').update(bytes).digest('hex')
  const ranges = []
  const server = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '')
    if (!match) {
      res.writeHead(200, { 'Content-Length': String(bytes.length) })
      res.end(bytes)
      return
    }
    const start = Number(match[1])
    const end = Math.min(Number(match[2]), bytes.length - 1)
    ranges.push([start, end])
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
      'Accept-Ranges': 'bytes'
    })
    res.end(bytes.subarray(start, end + 1))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
      manifestType: 'minecraftModpack',
      files: [{ projectID: 101, fileID: 202 }]
    }))
    const result = await hydrateCurseForgeFiles(root, null, null, {
      cacheDir: path.join(root, 'cache'),
      apiKey: 'test-key',
      threads: 4,
      concurrency: 1,
      fetcher: async () => ({
        ok: true,
        json: async () => ({ data: {
          id: 202,
          modId: 101,
          fileName: 'big.jar',
          downloadUrl: `${base}/big.jar`,
          hashes: [{ algo: 1, value: sha }],
          fileLength: bytes.length
        } })
      })
    })
    assert.equal(result.downloaded, 1)
    assert.deepEqual(await fs.readFile(path.join(root, 'mods/big.jar')), bytes)
    assert.ok(ranges.length > 1, '应发出多个 Range 请求')
    assert.ok(ranges.some(([start]) => start > 0), '应真正分段，而不是只探测 0-0')
  } finally {
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  }
})
