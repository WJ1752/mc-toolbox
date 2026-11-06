import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { store } from '../src/server/store.js'
import { LAUNCH_HISTORY_KEY } from '../src/server/launcher/state.js'
import {
  beginLaunchAttempt,
  captureLaunchAttempt,
  getLaunchComparison,
  promoteLaunchAttempt,
  updateLaunchAttempt
} from '../src/server/launcher/launch-history.js'
import { applyModUpdate } from '../src/server/launcher/mod-update-transaction.js'
import { makeZip } from './helpers/zip.mjs'

const hash = (text) => crypto.createHash('sha1').update(text).digest('hex')

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-launch-history-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const inst = {
    id: crypto.randomUUID(), name: '历史隔离实例', root,
    gameDir: path.join(root, 'game'), mc: '1.20.1', loader: 'fabric', loaderVersion: '0.16.9',
    versionId: 'fabric-loader-1.20.1', memory: { min: 1024, max: 4096 },
    width: 1280, height: 720, fullscreen: false, jvmArgs: ''
  }
  const mods = path.join(inst.gameDir, 'mods')
  await fs.mkdir(mods, { recursive: true })
  await fs.writeFile(path.join(mods, 'sample.jar'), 'mod-v1')
  let data = { instances: {} }
  const get = store.get.bind(store)
  const set = store.set.bind(store)
  t.mock.method(store, 'get', (name, fallback) => name === LAUNCH_HISTORY_KEY ? data : get(name, fallback))
  t.mock.method(store, 'set', (name, value) => {
    if (name === LAUNCH_HISTORY_KEY) { data = value; return }
    return set(name, value)
  })
  return { inst, mods, read: () => data }
}

test('新实例没有伪造基线；快照只绑定本次启动并保留 Java/内存设置', async (t) => {
  const { inst } = await fixture(t)
  const attemptId = beginLaunchAttempt(inst, 100)
  const captured = await captureLaunchAttempt(inst, attemptId, { javaPath: 'C:/Java/bin/java.exe', javaMajor: 21, jvmArgs: '-Xmx4G' })
  assert.equal(captured.ok, true)
  const comparison = await getLaunchComparison(inst, { attemptId })
  assert.equal(comparison.baseline, null)
  assert.equal(comparison.comparison, null)
  assert.equal(comparison.attempt.status, 'captured')
  assert.equal(comparison.attempt.capturedAt, captured.snapshot.capturedAt)

  updateLaunchAttempt(inst, attemptId, { status: 'failed', failure: { code: 'JAVA_EXITED', message: '启动失败' } })
  const failed = await getLaunchComparison(inst, { attemptId })
  assert.equal(failed.attempt.status, 'failed')
  assert.equal(failed.attempt.error.code, 'JAVA_EXITED')
  assert.equal(failed.comparison, null)
})

test('成功基线只在窗口稳定后提升，变更对比与事务备份匹配时可撤销；后续异常回滚基线', async (t) => {
  const { inst, mods, read } = await fixture(t)
  const first = beginLaunchAttempt(inst, 100)
  const firstCapture = await captureLaunchAttempt(inst, first, { javaPath: 'C:/Java21/java.exe', javaMajor: 21, jvmArgs: '-Xmx4G' })
  assert.equal(promoteLaunchAttempt(inst, first), false)
  updateLaunchAttempt(inst, first, { status: 'window-ready' })
  assert.equal(promoteLaunchAttempt(inst, first, 200), true)

  const updated = { relPath: 'sample.jar', filename: 'sample.jar', oldSha1: hash('mod-v1'), sha1: hash('mod-version-2-longer') }
  await applyModUpdate(inst, [updated], {
    download: async (_item, destination) => fs.writeFile(destination, 'mod-version-2-longer')
  })
  inst.memory = { min: 2048, max: 6144 }
  inst.javaPath = 'C:/Java25/java.exe'
  const second = beginLaunchAttempt(inst, 300)
  const secondCapture = await captureLaunchAttempt(inst, second, { javaPath: inst.javaPath, javaMajor: 25, jvmArgs: '-Xmx6G' })
  assert.equal(secondCapture.ok, true)
  const pending = await getLaunchComparison(inst, { attemptId: second })
  assert.deepEqual(pending.comparison.mods.changed.map((item) => item.changes), [['content']])
  assert.deepEqual(pending.comparison.settings.map((item) => item.key), ['java.path', 'java.major', 'memory.min', 'memory.max'])
  assert.equal(pending.comparison.jvmArgsChanged, true)
  assert.equal(pending.undo.available, true)
  assert.equal(pending.undo.createdAt > 0, true)
  assert.equal(pending.undo.items[0].before, 'sample.jar')
  assert.equal(pending.attempt.snapshot, undefined)

  updateLaunchAttempt(inst, second, { status: 'failed', failure: {
    code: 'GAME_CRASHED', message: '崩溃', hints: [{ kind: 'deps', evidence: [{ text: 'requires dependency samplemod', file: 'latest.log', line: 12 }] }]
  } })
  const failed = await getLaunchComparison(inst, { attemptId: second })
  assert.equal(failed.attempt.error.evidence[0].text, 'requires dependency samplemod')
  assert.equal(failed.latestSuccessful.id, first)

  updateLaunchAttempt(inst, second, { status: 'window-ready' })
  assert.equal(promoteLaunchAttempt(inst, second, 400), true)
  updateLaunchAttempt(inst, second, { status: 'failed', failure: { code: 'GAME_CRASHED', message: 'later crash' } })
  assert.equal(read().instances[inst.id].baseline.id, first)
})

test('更新备份磁盘内容变化时不提供撤销提示', async (t) => {
  const { inst, mods } = await fixture(t)
  const first = beginLaunchAttempt(inst)
  await captureLaunchAttempt(inst, first, { javaPath: 'java', javaMajor: 21 })
  updateLaunchAttempt(inst, first, { status: 'window-ready' })
  promoteLaunchAttempt(inst, first)
  await applyModUpdate(inst, [{ relPath: 'sample.jar', filename: 'sample.jar', oldSha1: hash('mod-v1'), sha1: hash('mod-version-2') }], {
    download: async (_item, destination) => fs.writeFile(destination, 'mod-version-2')
  })
  const second = beginLaunchAttempt(inst)
  await captureLaunchAttempt(inst, second, { javaPath: 'java', javaMajor: 21 })
  await fs.writeFile(path.join(mods, 'sample.jar'), 'manual replacement')
  const comparison = await getLaunchComparison(inst, { attemptId: second })
  assert.equal(comparison.undo.available, false)
})

test('使用唯一真实 modid 将更新改名配对为 changed', async (t) => {
  const { inst, mods } = await fixture(t)
  const oldJar = makeZip([['fabric.mod.json', JSON.stringify({ schemaVersion: 1, id: 'samplemod', name: 'Sample Mod', version: '1.0.0' })]])
  const newJar = makeZip([['fabric.mod.json', JSON.stringify({ schemaVersion: 1, id: 'samplemod', name: 'Sample Mod', version: '2.0.0' })]])
  await fs.writeFile(path.join(mods, 'sample.jar'), oldJar)
  const first = beginLaunchAttempt(inst)
  await captureLaunchAttempt(inst, first, { javaPath: 'java', javaMajor: 21 })
  updateLaunchAttempt(inst, first, { status: 'window-ready' })
  promoteLaunchAttempt(inst, first)

  await applyModUpdate(inst, [{ relPath: 'sample.jar', filename: 'renamed.jar', oldSha1: hash(oldJar), sha1: hash(newJar) }], {
    download: async (_item, destination) => fs.writeFile(destination, newJar)
  })
  const second = beginLaunchAttempt(inst)
  await captureLaunchAttempt(inst, second, { javaPath: 'java', javaMajor: 21 })
  const comparison = await getLaunchComparison(inst, { attemptId: second })
  assert.equal(comparison.comparison.mods.changed.length, 1)
  assert.deepEqual(comparison.comparison.mods.changed[0].changes, ['path', 'content'])
  assert.equal(comparison.comparison.mods.changed[0].before.relPath, 'sample.jar')
  assert.equal(comparison.comparison.mods.changed[0].after.relPath, 'renamed.jar')
  assert.equal(comparison.comparison.mods.changed[0].before.modid, 'samplemod')
  assert.equal(comparison.undo.available, true)
})
