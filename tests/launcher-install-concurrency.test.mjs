// v1.12.3 并发导入修复：同一整合包去重 + 同一游戏目录安装串行化。
// 这两条约束来自真实故障：重复拖入同一个整合包时，多个 Forge 安装器同时
// 改写 libraries / versions 和同一个 patched jar，安装器会直接退出码 1。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  findActivePackJob, packImportKey, withRootInstallLock
} from '../src/server/launcher/install.js'

const fakeJob = () => ({
  phaseKey: '安装加载器',
  signal: new AbortController().signal,
  log() {},
  phaseLabel() {}
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('packImportKey：前端指纹优先，路径安装回退为绝对路径', () => {
  assert.equal(packImportKey('C:\\packs\\恶咒曲.zip', '恶咒曲.zip:123:456'), '恶咒曲.zip:123:456')
  const key = packImportKey('C:\\packs\\恶咒曲.zip')
  assert.match(key, /^path:/)
  assert.ok(key.endsWith('恶咒曲.zip'))
})

test('findActivePackJob：只拦截同指纹且未完成的整合包任务', () => {
  const items = [
    { id: 'done', type: 'pack', packKey: 'k', status: 'done' },
    { id: 'failed', type: 'pack', packKey: 'k', status: 'failed' },
    { id: 'running', type: 'pack', packKey: 'k', status: 'running', name: '恶咒曲' },
    { id: 'other-type', type: 'install', packKey: 'k', status: 'running' }
  ]
  assert.equal(findActivePackJob(items, 'k')?.id, 'running')
  assert.equal(findActivePackJob(items, 'missing'), null)
  assert.equal(findActivePackJob(items, ''), null)
  assert.equal(findActivePackJob(null, 'k'), null)
})

test('withRootInstallLock：同一游戏目录串行，等待中的任务不会并发运行', async () => {
  let running = 0
  let maxRunning = 0
  const order = []
  const task = (label) => async () => {
    running++
    maxRunning = Math.max(maxRunning, running)
    order.push('start:' + label)
    await sleep(15)
    order.push('end:' + label)
    running--
  }
  await Promise.all([
    withRootInstallLock('C:\\root-a', fakeJob(), task('first')),
    withRootInstallLock('C:\\root-a', fakeJob(), task('second')),
    withRootInstallLock('C:\\root-a', fakeJob(), task('third'))
  ])
  assert.equal(maxRunning, 1)
  assert.deepEqual(order, [
    'start:first', 'end:first',
    'start:second', 'end:second',
    'start:third', 'end:third'
  ])
})

test('withRootInstallLock：不同游戏目录不会互相阻塞', async () => {
  let slowStarted = false
  let slowFinished = false
  const slow = withRootInstallLock('C:\\root-a', fakeJob(), async () => {
    slowStarted = true
    await sleep(40)
    slowFinished = true
  })
  const fast = await withRootInstallLock('C:\\root-b', fakeJob(), async () => 'fast-done')
  await sleep(0)
  assert.equal(fast, 'fast-done')
  assert.equal(slowStarted, true)
  assert.equal(slowFinished, false)
  await slow
  assert.equal(slowFinished, true)
})

test('withRootInstallLock：排队中取消会立刻退出，不吞掉后续任务', async () => {
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  const first = withRootInstallLock('C:\\root-c', fakeJob(), async () => { await firstGate })
  const controller = new AbortController()
  const cancelled = withRootInstallLock('C:\\root-c', {
    phaseKey: '准备安装', signal: controller.signal, log() {}, phaseLabel() {}
  }, async () => 'should-not-run')
  controller.abort()
  await assert.rejects(cancelled, /已取消/)
  releaseFirst()
  await first
  // 锁必须已经释放，下一个任务可以正常拿到
  assert.equal(await withRootInstallLock('C:\\root-c', fakeJob(), async () => 'next'), 'next')
})
