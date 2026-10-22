// 在线整合包解析与安装流程测试：全部使用注入 fetcher / 本地 HTTP 服务，
// 不访问真实网络。重点覆盖 Modrinth、CurseForge、mc-toolbox 清单识别，
// 以及 startOnlinePackInstall 下载失败后的缓存清理。
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { resolveOnlinePack, CURSEFORGE_API_KEY_MESSAGE } from '../src/server/launcher/pack-online.js'
import { readPackSummary, readPackMeta, startPackInstall, startOnlinePackInstall, getJob } from '../src/server/launcher/install.js'
import { makeZip } from './helpers/zip.mjs'

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => ''
  }
}

async function waitFor(fn, { timeout = 10000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error('等待超时：' + String(last))
}

async function waitUntilGone(target, { timeout = 5000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      await fsp.access(target)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  return false
}

test('resolveOnlinePack 解析 Modrinth 版本的主 mrpack 文件', async () => {
  const requests = []
  const version = {
    id: 'ver-1',
    project_id: 'proj-1',
    name: '示例整合包 1.0.0',
    version_number: '1.0.0',
    version_type: 'release',
    date_published: '2026-01-02T03:04:05Z',
    game_versions: ['1.20.1', '1.20'],
    loaders: ['fabric'],
    files: [
      { hashes: { sha1: '1'.repeat(40) }, url: 'https://cdn.example.invalid/readme.txt', filename: 'readme.txt', primary: false, size: 10 },
      {
        hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
        url: 'https://cdn.example.invalid/example-1.0.0.mrpack',
        filename: 'example-1.0.0.mrpack',
        primary: true,
        size: 123456
      }
    ]
  }
  const fetcher = async (url) => {
    requests.push(url)
    if (url.includes('/project/proj-1/version/ver-1')) return jsonResponse(version)
    if (url.endsWith('/project/proj-1')) {
      return jsonResponse({
        id: 'proj-1',
        slug: 'example-pack',
        project_type: 'modpack',
        title: '示例整合包',
        icon_url: 'https://cdn.example.invalid/icon.png'
      })
    }
    throw new Error('未预期的请求：' + url)
  }
  const pack = await resolveOnlinePack({ source: 'modrinth', projectId: 'proj-1', versionId: 'ver-1', fetcher })
  assert.equal(pack.source, 'modrinth')
  assert.equal(pack.format, 'mrpack')
  assert.equal(pack.url, 'https://cdn.example.invalid/example-1.0.0.mrpack')
  assert.equal(pack.filename, 'example-1.0.0.mrpack')
  assert.equal(pack.size, 123456)
  assert.deepEqual(pack.hashes, { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) })
  assert.equal(pack.project.id, 'proj-1')
  assert.equal(pack.project.title, '示例整合包')
  assert.equal(pack.project.slug, 'example-pack')
  assert.equal(pack.project.icon, 'https://cdn.example.invalid/icon.png')
  assert.equal(pack.project.url, 'https://modrinth.com/modpack/example-pack')
  assert.equal(pack.version.id, 'ver-1')
  assert.equal(pack.version.name, '示例整合包 1.0.0')
  assert.equal(pack.version.number, '1.0.0')
  assert.equal(pack.version.type, 'release')
  assert.deepEqual(pack.version.gameVersions, ['1.20.1', '1.20'])
  assert.deepEqual(pack.version.loaders, ['fabric'])
  assert.ok(requests.some((url) => url.includes('/version/ver-1')))
})

test('resolveOnlinePack 无版本 ID 时从 Modrinth 版本列表选择正式版 mrpack', async () => {
  const fetcher = async (url) => {
    if (url.endsWith('/project/proj-2/version')) {
      return jsonResponse([
        { id: 'old', version_number: '0.9', version_type: 'beta', files: [{ filename: 'old.zip', url: 'https://example.invalid/old.zip', size: 1, hashes: { sha1: 'c'.repeat(40) } }] },
        { id: 'new', version_number: '1.0', version_type: 'release', files: [{ filename: 'new.mrpack', url: 'https://example.invalid/new.mrpack', size: 2, hashes: { sha512: 'd'.repeat(128) } }] }
      ])
    }
    if (url.endsWith('/project/proj-2')) return jsonResponse({ id: 'proj-2', slug: 'two', title: '二号包', project_type: 'modpack' })
    throw new Error('未预期的请求：' + url)
  }
  const pack = await resolveOnlinePack({ source: 'modrinth', projectId: 'proj-2', fetcher })
  assert.equal(pack.version.id, 'new')
  assert.equal(pack.format, 'mrpack')
  assert.deepEqual(pack.hashes, { sha512: 'd'.repeat(128) })
})

test('resolveOnlinePack 缺少 CurseForge API Key 时抛出中文引导', async () => {
  await assert.rejects(
    resolveOnlinePack({
      source: 'curseforge',
      projectId: '123',
      versionId: '456',
      fetcher: async () => { throw new Error('不应发起网络请求') }
    }),
    (error) => {
      assert.equal(error.code, 'CURSEFORGE_API_KEY')
      assert.equal(error.message, CURSEFORGE_API_KEY_MESSAGE)
      assert.match(error.message, /设置 → 社区资源/)
      assert.match(error.message, /Eternal API Key/)
      assert.match(error.message, /Modrinth/)
      return true
    }
  )
})

test('resolveOnlinePack 用 CurseForge download-url 解析文件信息', async () => {
  const sha1 = 'e'.repeat(40)
  const seen = []
  const fetcher = async (url, init) => {
    seen.push({ url, key: init?.headers?.['x-api-key'] })
    if (url.endsWith('/mods/123')) {
      return jsonResponse({
        data: {
          id: 123,
          name: 'Curse 整合包',
          slug: 'curse-pack',
          logo: { url: 'https://media.example.invalid/logo.png' },
          authors: [{ name: '作者甲' }],
          links: { websiteUrl: 'https://www.curseforge.com/minecraft/modpacks/curse-pack' }
        }
      })
    }
    if (url.endsWith('/mods/123/files/456')) {
      return jsonResponse({
        data: {
          id: 456,
          fileName: 'CursePack-1.0.zip',
          displayName: 'Curse Pack 1.0',
          fileLength: 765432,
          fileDate: '2026-02-03T04:05:06Z',
          releaseType: 1,
          gameVersions: ['1.20.1', 'Forge', '1.20.1', 'Fabric'],
          hashes: [{ algo: 1, value: sha1 }]
        }
      })
    }
    if (url.endsWith('/mods/123/files/456/download-url')) {
      return jsonResponse({ data: 'https://edge.forgecdn.net/files/0123/456/CursePack-1.0.zip' })
    }
    throw new Error('未预期的请求：' + url)
  }
  const pack = await resolveOnlinePack({ source: 'curseforge', projectId: '123', versionId: '456', apiKey: 'test-key', fetcher })
  assert.equal(pack.source, 'curseforge')
  assert.equal(pack.format, 'zip')
  assert.equal(pack.url, 'https://edge.forgecdn.net/files/0123/456/CursePack-1.0.zip')
  assert.equal(pack.filename, 'CursePack-1.0.zip')
  assert.equal(pack.size, 765432)
  assert.deepEqual(pack.hashes, { sha1 })
  assert.equal(pack.project.id, '123')
  assert.equal(pack.project.title, 'Curse 整合包')
  assert.equal(pack.project.author, '作者甲')
  assert.equal(pack.project.icon, 'https://media.example.invalid/logo.png')
  assert.equal(pack.version.id, '456')
  assert.equal(pack.version.name, 'Curse Pack 1.0')
  assert.equal(pack.version.type, 'release')
  assert.deepEqual(pack.version.gameVersions, ['1.20.1', 'Forge', '1.20.1', 'Fabric'])
  assert.deepEqual(pack.version.loaders, ['forge', 'fabric'])
  assert.ok(seen.length >= 3)
  assert.ok(seen.every((item) => item.key === 'test-key'))
})

test('resolveOnlinePack 在 download-url 为空时回退到 CurseForge CDN 直链', async () => {
  const fetcher = async (url) => {
    if (url.endsWith('/mods/9')) return jsonResponse({ data: { id: 9, name: '兜底包', slug: 'fallback', authors: [] } })
    if (url.endsWith('/mods/9/files/1234567')) {
      return jsonResponse({ data: { id: 1234567, fileName: 'fallback.zip', fileLength: 10, releaseType: 1, gameVersions: ['1.20.1'], hashes: [] } })
    }
    if (url.endsWith('/mods/9/files/1234567/download-url')) return jsonResponse({ data: null })
    throw new Error('未预期的请求：' + url)
  }
  const pack = await resolveOnlinePack({ source: 'curseforge', projectId: '9', versionId: '1234567', apiKey: 'k', fetcher })
  assert.equal(pack.url, 'https://edge.forgecdn.net/files/1234/567/fallback.zip')
  assert.deepEqual(pack.hashes, {})
  assert.equal(pack.version.loaders.length, 0)
})

test('readPackSummary 能识别 mc-toolbox 通用 ZIP 并构造下载 index', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-manifest-'))
  try {
    const manifest = {
      formatVersion: 1,
      manifestType: 'mc-toolbox',
      name: '通用导出包',
      versionId: '20261021-120000',
      summary: '测试用通用整合包',
      minecraft: { version: '1.20.1', modLoaders: [{ id: 'fabric-0.16.9', primary: true }] },
      files: [{
        path: 'mods/example.jar',
        hashes: { sha1: 'f'.repeat(40), sha512: '0'.repeat(128) },
        downloads: ['https://example.invalid/example.jar'],
        fileSize: 12,
        env: { client: 'required' }
      }],
      overrides: 'overrides'
    }
    const zip = makeZip([
      ['manifest.json', JSON.stringify(manifest)],
      ['overrides/config/example.txt', 'hello'],
      ['overrides/mods/extra.jar', 'jar']
    ])
    const file = path.join(root, 'toolbox.zip')
    await fsp.writeFile(file, zip)
    const meta = await readPackSummary(file)
    assert.equal(meta.kind, 'toolbox')
    assert.equal((await readPackMeta(file)).kind, 'toolbox')
    assert.equal(meta.name, '通用导出包')
    assert.equal(meta.mc, '1.20.1')
    assert.equal(meta.loader, 'fabric')
    assert.equal(meta.loaderVersion, '0.16.9')
    assert.equal(meta.overrides, 'overrides')
    assert.equal(meta.index.formatVersion, 1)
    assert.equal(meta.index.game, 'minecraft')
    assert.equal(meta.index.versionId, '20261021-120000')
    assert.equal(meta.index.files.length, 1)
    assert.equal(meta.index.files[0].path, 'mods/example.jar')
    assert.deepEqual(meta.index.dependencies, { minecraft: '1.20.1', 'fabric-loader': '0.16.9' })
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('readPackSummary 保持 Modrinth mrpack 识别行为', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-mrpack-meta-'))
  try {
    const zip = makeZip([
      ['modrinth.index.json', JSON.stringify({
        formatVersion: 1,
        name: 'MR 包',
        dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.0' },
        files: []
      })]
    ])
    const file = path.join(root, 'pack.mrpack')
    await fsp.writeFile(file, zip)
    const meta = await readPackSummary(file)
    assert.equal(meta.kind, 'modrinth')
    assert.equal(meta.mc, '1.20.1')
    assert.equal(meta.loader, 'fabric')
    assert.equal(meta.loaderVersion, '0.15.0')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('startPackInstall 对缺失的本地整合包给出中文错误（保持原有流程）', async () => {
  const missing = path.join(os.tmpdir(), `mc-missing-pack-${Date.now()}.mrpack`)
  const { job } = startPackInstall({ source: missing })
  const failed = await waitFor(() => {
    const current = getJob(job.id)
    return current && current.status === 'failed' ? current : null
  })
  assert.match(failed.error, /整合包文件不存在/)
  assert.equal(failed.phase, '准备')
})

test('startOnlinePackInstall 下载阶段失败后任务失败并清理缓存目录', async () => {
  const launcherDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-online-install-'))
  const previousRoot = process.env.MC_TOOLBOX_LAUNCHER_ROOT
  process.env.MC_TOOLBOX_LAUNCHER_ROOT = launcherDir
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' })
    res.end('boom')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const version = {
      id: 'ver-fail',
      project_id: 'proj-fail',
      name: '失败测试包',
      version_number: '1.0.0',
      version_type: 'release',
      date_published: '2026-03-04T05:06:07Z',
      game_versions: ['1.20.1'],
      loaders: ['fabric'],
      files: [{
        hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) },
        url: `http://127.0.0.1:${port}/broken.mrpack`,
        filename: 'broken.mrpack',
        primary: true,
        size: 4096
      }]
    }
    const fetcher = async (url) => {
      if (url.includes('/project/proj-fail/version/ver-fail')) return jsonResponse(version)
      if (url.endsWith('/project/proj-fail')) return jsonResponse({ id: 'proj-fail', slug: 'fail-pack', title: '失败测试包', project_type: 'modpack' })
      throw new Error('未预期的请求：' + url)
    }
    const started = startOnlinePackInstall({
      source: 'modrinth',
      projectId: 'proj-fail',
      versionId: 'ver-fail',
      name: '失败测试包',
      openWhenDone: true,
      fetcher
    })
    assert.ok(started.job?.id)
    assert.equal(started.job.openWhenDone, true)
    assert.equal(started.job.phase, '下载整合包')
    const jobId = started.job.id
    const cacheDir = path.join(launcherDir, 'cache', 'packs', jobId)
    const failed = await waitFor(() => {
      const job = getJob(jobId)
      return job && ['failed', 'cancelled'].includes(job.status) ? job : null
    })
    assert.equal(failed.status, 'failed')
    assert.match(failed.error, /下载失败|HTTP 500/)
    assert.equal(failed.phase, '下载整合包')
    assert.equal(failed.openWhenDone, true)
    assert.equal(await waitUntilGone(cacheDir), true, '失败后应删除 cache/packs/<jobId> 缓存目录')
  } finally {
    await new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections?.()
    })
    if (previousRoot === undefined) delete process.env.MC_TOOLBOX_LAUNCHER_ROOT
    else process.env.MC_TOOLBOX_LAUNCHER_ROOT = previousRoot
    await fsp.rm(launcherDir, { recursive: true, force: true })
  }
})
