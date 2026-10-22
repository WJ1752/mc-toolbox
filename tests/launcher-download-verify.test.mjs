// 下载校验优先级：有 SHA-1 时以哈希为准（清单里的 size 可能来自另一次上传），
// 没有哈希时才退回长度校验。用本地 HTTP 服务复现「差 2 字节」的误报。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import crypto from 'node:crypto'

import { fetchToFile } from '../src/server/launcher/download.js'

const body = Buffer.from('jar-bytes-with-two-extra')          // 24 字节
const goodSha1 = crypto.createHash('sha1').update(body).digest('hex')
const badSha1 = crypto.createHash('sha1').update('something else').digest('hex')

let dir = ''
let server = null
let base = ''

test.before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-verify-'))
  server = http.createServer((req, res) => {
    if (req.url === '/missing') { res.writeHead(404); res.end('nope'); return }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

test.after(async () => {
  server?.closeAllConnections?.()
  await new Promise((resolve) => server?.close(resolve))
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

test('哈希匹配时忽略清单长度差异（1286460 vs 实际 1286462 的场景）', async () => {
  const target = path.join(dir, 'mods', 'Structure.jar')
  const result = await fetchToFile(`${base}/file`, target, { sha1: goodSha1, size: body.length - 2 })
  assert.equal(result.cached, false)
  assert.equal(result.size, body.length)
  assert.equal((await fs.readFile(target)).length, body.length)
})

test('哈希不匹配时仍然失败，并清掉半成品', async () => {
  const target = path.join(dir, 'mods', 'bad.jar')
  await assert.rejects(
    fetchToFile(`${base}/file`, target, { sha1: badSha1, size: body.length, retries: 0 }),
    /SHA-1 校验失败/
  )
  await assert.rejects(fs.stat(target))
})

test('没有哈希时保留长度校验，防止截断文件被当成完整文件', async () => {
  const target = path.join(dir, 'mods', 'truncated.jar')
  await assert.rejects(
    fetchToFile(`${base}/file`, target, { size: body.length + 2, retries: 0 }),
    /长度校验失败/
  )
})

test('HTTP 404 不重试，错误信息保留状态码', async () => {
  const target = path.join(dir, 'mods', 'missing.jar')
  await assert.rejects(fetchToFile(`${base}/missing`, target, { retries: 3 }), /HTTP 404/)
})
