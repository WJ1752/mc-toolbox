// 自适应并发池：慢速线路按阈值加连接、限流期间保持回退、失败与取消尽快结束。
import test from 'node:test'
import assert from 'node:assert/strict'

import { runPool, runPoolAdaptive } from '../src/server/launcher/download.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const sleepWith = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason || new Error('已取消'))
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new Error('已取消')) }, { once: true })
})

function makeTracker() {
  const stats = { live: 0, peak: 0, completed: 0 }
  const enter = () => { stats.live++; stats.peak = Math.max(stats.peak, stats.live) }
  const leave = () => { stats.live--; stats.completed++ }
  return { stats, enter, leave }
}

test('runPoolAdaptive：吞吐达标时不加连接，并发保持起始值', async () => {
  const { stats, enter, leave } = makeTracker()
  const counter = { received: 0 }
  const items = Array.from({ length: 40 }, (_, i) => i)
  await runPoolAdaptive(items, async (item) => {
    enter()
    await sleep(20)
    counter.received += item + 1
    leave()
  }, { start: 3, max: 9, counter, targetBps: 1, sampleMs: 500 })
  assert.equal(stats.completed, 40)
  assert.ok(stats.peak <= 3, `高吞吐不应加连接（peak=${stats.peak}）`)
})

test('runPoolAdaptive：吞吐持续低于阈值会自动加连接，但不超过上限', async () => {
  const { stats, enter, leave } = makeTracker()
  const counter = { received: 0 }
  const items = Array.from({ length: 300 }, (_, i) => i)
  await runPoolAdaptive(items, async (item) => {
    enter()
    await sleep(25)
    counter.received += 8
    leave()
  }, { start: 2, max: 6, counter, targetBps: 50000, sampleMs: 500 })
  assert.equal(stats.completed, 300)
  assert.ok(stats.peak >= 4, `慢速时应该加到 ≥4 条（peak=${stats.peak}）`)
  assert.ok(stats.peak <= 6, `并发不应超过上限（peak=${stats.peak}）`)
})

test('runPoolAdaptive：canGrow 返回 false（限流）时保持起始并发', async () => {
  const { stats, enter, leave } = makeTracker()
  const counter = { received: 0 }
  const items = Array.from({ length: 120 }, (_, i) => i)
  await runPoolAdaptive(items, async (item) => {
    enter()
    await sleep(20)
    counter.received += 1
    leave()
  }, { start: 2, max: 8, counter, targetBps: 100000, sampleMs: 500, canGrow: () => false })
  assert.equal(stats.completed, 120)
  assert.ok(stats.peak <= 2, `限流期间不应加连接（peak=${stats.peak}）`)
})

test('runPoolAdaptive：第一个失败的任务让整个池子尽快失败', async () => {
  const { stats } = makeTracker()
  let started = 0
  await assert.rejects(
    runPoolAdaptive(Array.from({ length: 50 }, (_, i) => i), async (item) => {
      started++
      await sleep(5)
      if (item === 2) throw new Error('boom-' + item)
    }, { start: 4, max: 4, sampleMs: 600 }),
    /boom-2/
  )
  assert.ok(started > 0 && started < 50, `失败后不应跑完全部任务（started=${started}）`)
  assert.ok(stats.completed <= 50)
})

test('runPoolAdaptive：取消后池子立刻结束并抛出取消原因', async () => {
  const controller = new AbortController()
  const run = runPoolAdaptive(Array.from({ length: 20 }, (_, i) => i), async () => {
    await sleepWith(1000, controller.signal)
    throw new Error('未取消')
  }, { start: 2, max: 2, signal: controller.signal, sampleMs: 600 })
  setTimeout(() => controller.abort(new Error('用户取消')), 120)
  await assert.rejects(run, /用户取消/)
})

test('runPoolAdaptive：空列表直接完成', async () => {
  await runPoolAdaptive([], async () => { throw new Error('不应该被调用') }, { start: 2 })
  const counter = { received: 0 }
  await runPoolAdaptive([], async () => {}, { start: 2, counter })
})

test('runPoolAdaptive：max 小于 start 时退化为固定并发池', async () => {
  const { stats, enter, leave } = makeTracker()
  await runPoolAdaptive(Array.from({ length: 24 }, (_, i) => i), async () => {
    enter()
    await sleep(10)
    leave()
  }, { start: 4, max: 2, counter: { received: 0 }, targetBps: 1, sampleMs: 500 })
  assert.equal(stats.completed, 24)
  assert.ok(stats.peak <= 4, `上限数值应被钳制（peak=${stats.peak}）`)
})

test('runPool：保持原有语义（固定并发、首个错误中止）', async () => {
  const { stats, enter, leave } = makeTracker()
  await runPool(Array.from({ length: 30 }, (_, i) => i), async () => {
    enter()
    await sleep(5)
    leave()
  }, 3)
  assert.equal(stats.completed, 30)
  assert.ok(stats.peak <= 3)
  await assert.rejects(runPool([1, 2, 3], async (item) => { if (item === 2) throw new Error('第二个失败') }, 3), /第二个失败/)
})
