// 下载任务字段契约测试：全部使用本地 HTTP 服务，不访问外部网络。
// 覆盖社区下载任务的成功 / 失败 / 取消终态，以及 listJobs 与 getJob 的一致性；
// 另外验证启动器安装任务的排队 / 开始 / 完成时间语义。
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import {
  startDownload,
  getJob,
  listJobs,
  cancelJobAndWait,
  clearJobs
} from '../src/server/community.js'
import {
  startPackInstall,
  getJob as getInstallJob,
  clearFinishedJobs as clearFinishedInstallJobs
} from '../src/server/launcher/install.js'

const PAYLOAD = Buffer.alloc(8192, 0x61)
const heldResponses = new Set()
const trackedJobs = new Set()
let server
let baseDir = ''
let baseUrl = ''

before(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-download-jobs-'))
  server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(PAYLOAD.length)
      })
      res.end(PAYLOAD)
      return
    }
    if (req.url === '/hold') {
      // 只发响应头和 1 字节就挂住，保证测试能在「运行中」取消。
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(1024 * 1024)
      })
      res.write('x')
      heldResponses.add(res)
      res.on('close', () => heldResponses.delete(res))
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' })
    res.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  // 先让所有任务进入终态，避免 Windows 上删临时目录时还有文件句柄。
  for (const id of trackedJobs) {
    if (getJob(id)) await cancelJobAndWait(id).catch(() => {})
  }
  clearJobs()
  for (const res of heldResponses) res.destroy()
  heldResponses.clear()
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

async function waitFor(fn, { timeout = 10000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error('等待超时：' + JSON.stringify(last))
}

async function waitForStatus(id, status) {
  return waitFor(() => {
    const current = getJob(id)
    return current && current.status === status ? current : null
  })
}

async function waitUntilGone(target, { timeout = 5000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      await fs.access(target)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  return false
}

function assertValidProgress(progress) {
  if (progress === null) return
  assert.equal(typeof progress, 'number', 'progress 必须是数字或 null')
  assert.ok(Number.isFinite(progress), 'progress 必须是有限数字')
  assert.ok(progress >= 0 && progress <= 100, `progress 必须在 0–100：${progress}`)
}

async function startCommunityJob(options) {
  const job = await startDownload(options)
  trackedJobs.add(job.id)
  return job
}

test('成功任务：progress 为 0–100，startedAt / finishedAt / createdAt 有效', async () => {
  const job = await startCommunityJob({
    url: `${baseUrl}/ok`,
    dir: baseDir,
    filename: 'ok.bin',
    exactDir: true,
    preserveName: true
  })
  assert.ok(job.createdAt > 0, '启动时 publicJob 应包含 createdAt')
  assertValidProgress(job.progress)

  const done = await waitForStatus(job.id, 'done')
  assert.equal(done.status, 'done')
  assert.equal(done.progress, 100)
  assert.equal(typeof done.progress, 'number')
  assert.ok(done.startedAt > 0, '真正开始下载时应写入 startedAt')
  assert.ok(done.finishedAt >= done.startedAt, 'finishedAt 不能早于 startedAt')
  assert.equal(done.speed, 0, '终态速度必须归零')
  assert.ok(done.received > 0)
  assert.equal(done.total, done.received)
})

test('失败任务：404 后 status=failed、finishedAt>0、progress 合法', async () => {
  const job = await startCommunityJob({
    url: `${baseUrl}/missing`,
    dir: baseDir,
    filename: 'missing.bin',
    exactDir: true,
    preserveName: true
  })
  const failed = await waitForStatus(job.id, 'failed')
  assert.equal(failed.status, 'failed')
  assert.match(failed.error || '', /404/)
  assert.ok(failed.startedAt > 0)
  assert.ok(failed.finishedAt > 0, '失败任务必须写 finishedAt')
  assert.ok(failed.finishedAt >= failed.startedAt)
  assert.equal(failed.speed, 0, '失败后速度必须归零')
  assertValidProgress(failed.progress)
})

test('取消任务：status=cancelled、finishedAt>0、speed=0', async () => {
  const job = await startCommunityJob({
    url: `${baseUrl}/hold`,
    dir: baseDir,
    filename: 'hold.bin',
    exactDir: true,
    preserveName: true
  })
  await waitFor(() => {
    const current = getJob(job.id)
    return current && current.status === 'running' && current.startedAt > 0 ? current : null
  })
  await cancelJobAndWait(job.id)
  const cancelled = getJob(job.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.ok(cancelled.finishedAt > 0, '取消时立即写 finishedAt')
  assert.ok(cancelled.finishedAt >= cancelled.startedAt)
  assert.equal(cancelled.speed, 0, '取消后速度必须归零')
  assertValidProgress(cancelled.progress)
})

test('listJobs 与 getJob 对同一任务返回一致的字段', async () => {
  const job = await startCommunityJob({
    url: `${baseUrl}/ok`,
    dir: baseDir,
    filename: 'consistent.bin',
    exactDir: true,
    preserveName: true
  })
  await waitForStatus(job.id, 'done')
  const listed = listJobs().find((item) => item.id === job.id)
  const single = getJob(job.id)
  assert.ok(listed, 'listJobs 中应能找到该任务')
  assert.ok(single, 'getJob 应能返回该任务')
  assert.deepEqual(listed, single)
  assert.ok(listed.createdAt > 0)
  assert.ok(listed.finishedAt > 0)
})

test('启动器安装任务：排队不计入 startedAt，失败也写 finishedAt / updatedAt', async () => {
  const launcherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-install-jobs-'))
  const previousRoot = process.env.MC_TOOLBOX_LAUNCHER_ROOT
  process.env.MC_TOOLBOX_LAUNCHER_ROOT = launcherDir
  try {
    const missing = path.join(launcherDir, 'missing.mrpack')
    const started = startPackInstall({ source: missing })
    const queued = started.job
    assert.ok(queued.createdAt > 0, '创建时应写 createdAt')
    assert.equal(queued.startedAt, 0, 'runJob 真正开始前 startedAt 必须为 0')
    assert.ok(queued.updatedAt >= queued.createdAt)

    const failed = await waitFor(() => {
      const current = getInstallJob(started.job.id)
      return current && current.status === 'failed' ? current : null
    })
    assert.ok(failed.startedAt > 0, '开始执行后应写 startedAt')
    assert.ok(failed.finishedAt >= failed.startedAt)
    assert.equal(failed.updatedAt, failed.finishedAt, 'finishJob 应同步 updatedAt')
    assert.equal(await waitUntilGone(path.join(launcherDir, 'cache', 'packs', started.job.id)), true)
  } finally {
    clearFinishedInstallJobs()
    if (previousRoot === undefined) delete process.env.MC_TOOLBOX_LAUNCHER_ROOT
    else process.env.MC_TOOLBOX_LAUNCHER_ROOT = previousRoot
    await fs.rm(launcherDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})
