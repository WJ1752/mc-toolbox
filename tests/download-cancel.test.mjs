import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { startDownload, getJob, cancelJobAndWait, clearJobs } from '../src/server/community.js'

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-cancel-test-'))
const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Length': '4' }); res.end('test') })
await new Promise(r => server.listen(0, '127.0.0.1', r))
let activeJob
try {
  const marker = path.join(dir, 'pid.txt')
  const job = await startDownload({ url: `http://127.0.0.1:${server.address().port}/file`, dir, filename: 'fixture.jar', exactDir: true, preserveName: true,
    postCommand: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));setInterval(()=>{},100)`] })
  activeJob = job.id
  const deadline = Date.now() + 5000
  while (!(await fs.stat(marker).catch(() => null)) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
  assert.equal(getJob(job.id).status, 'installing')
  const pid = Number(await fs.readFile(marker, 'utf8'))
  await cancelJobAndWait(job.id)
  assert.equal(getJob(job.id).status, 'cancelled')
  assert.throws(() => process.kill(pid, 0))
  await new Promise(r => setTimeout(r, 50))
  assert.equal(getJob(job.id).status, 'cancelled')
  console.log('✓ 中止安装器会终止真实子进程并等待退出，状态不会被迟到的成功回调覆盖')
} finally {
  if (activeJob) await cancelJobAndWait(activeJob)
  clearJobs()
  server.closeAllConnections()
  await new Promise(r => server.close(r))
  await fs.rm(dir, { recursive: true, force: true })
}
