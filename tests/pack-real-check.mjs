// Optional read-only validation of a user supplied archive. Stops before any network/core install.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { convertPack } from '../src/server/pack-converter.js'

const source = process.argv[2]
if (!source) throw new Error('请传入整合包路径')
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-real-check-'))
const controller = new AbortController()
let recognized = ''
let lastStage = ''
let lastAt = 0
const started = Date.now()
try {
  await assert.rejects(convertPack({ source, outputDir: dir, installServerCore: true, signal: controller.signal,
    onProgress(p) {
      if (p.detail.startsWith('已识别')) recognized = p.detail
      if (p.stage !== lastStage || Date.now() - lastAt > 10000) {
        console.log(p.stage, Math.round(p.progress), p.detail); lastStage = p.stage; lastAt = Date.now()
      }
      if (p.stage === 'core-resolve') { controller.abort(); controller.signal.throwIfAborted() }
    }
  }), /abort/i)
  assert.match(recognized, /1\.12\.2.*forge.*14\.23\.5\.2855/)
  assert.deepEqual(await fs.readdir(dir), [])
  console.log('PASS', recognized, '中止后无输出文件；耗时', Math.round((Date.now() - started) / 1000), '秒')
} finally { await fs.rm(dir, { recursive: true, force: true }) }
