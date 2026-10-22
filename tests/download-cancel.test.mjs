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
  // 文件被创建和内容写入之间有一小段窗口，必须等到 PID 文本完整再读，
  // 否则可能读到空串得到 pid=0，process.kill(0,0) 永远成功。
  let pidText = ''
  while (Date.now() < deadline) {
    pidText = await fs.readFile(marker, 'utf8').catch(() => '')
    if (/^\d+$/.test(pidText.trim())) break
    await new Promise(r => setTimeout(r, 20))
  }
  assert.equal(getJob(job.id).status, 'installing')
  const pid = Number(pidText.trim())
  assert.ok(Number.isInteger(pid) && pid > 0, '测试子进程 PID 应为正整数：' + JSON.stringify(pidText))
  await cancelJobAndWait(job.id)
  assert.equal(getJob(job.id).status, 'cancelled')
  // 取消会先杀进程树再返回；高负载机器上进程退出可能有几十毫秒延迟，
  // 这里轮询等待，避免用一次 process.kill 断言造成偶发失败。
  let gone = false
  const exitDeadline = Date.now() + 5000
  while (Date.now() < exitDeadline) {
    try {
      process.kill(pid, 0)
    } catch {
      gone = true
      break
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.equal(gone, true, '取消后安装器子进程应已退出')
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
