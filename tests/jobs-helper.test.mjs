import test from 'node:test'
import assert from 'node:assert/strict'
import {
  jobProgress, jobBytesText, jobSpeedText, jobElapsedSeconds, jobElapsedText,
  jobMetaText, jobIdleText, mergeJobs, isActiveJob, isFinishedJob, jobStatusLabel
} from '../public/js/core/jobs.js'

const NOW = 1_800_000_000_000

test('jobProgress：完成 100，安装百分比优先，字节比例回退', () => {
  assert.equal(jobProgress({ status: 'done' }), 100)
  assert.equal(jobProgress({ status: 'installing', installProgress: 42.6 }), 42.6)
  assert.equal(jobProgress({ status: 'installing', installProgress: null }), null)
  assert.equal(jobProgress({ status: 'running', progress: 58.2 }), 58.2)
  assert.equal(jobProgress({ status: 'running', received: 50, total: 200 }), 25)
  assert.equal(jobProgress({ status: 'running', received: 50, total: 0 }), null)
  assert.equal(jobProgress({ status: 'running', indeterminate: true, received: 50, total: 200 }), null)
  assert.equal(jobProgress({ status: 'queued', progress: 0 }), null)
  assert.equal(jobProgress(null), null)
})

test('jobProgress：终态不播放不确定动画，未知进度返回 0 或已知值', () => {
  assert.equal(jobProgress({ status: 'failed', received: 5, total: 10 }), 50)
  assert.equal(jobProgress({ status: 'cancelled' }), 0)
  assert.equal(jobProgress({ status: 'failed', indeterminate: true, progress: null }), 0)
  assert.equal(jobProgress({ status: 'cancelled', indeterminate: true, received: 2, total: 4 }), 50)
})

test('jobBytesText / jobSpeedText：未知总量只显示已下载，已知总量夹紧', () => {
  assert.equal(jobBytesText({ received: 1024, total: 4096 }), '1.0 KB / 4.0 KB')
  assert.equal(jobBytesText({ received: 1024, total: 0 }), '1.0 KB')
  assert.equal(jobBytesText({ received: 0, total: 0 }), '')
  assert.equal(jobBytesText({ received: 2048, total: 1024 }), '1.0 KB / 1.0 KB')
  assert.equal(jobSpeedText({ status: 'running', speed: 2 * 1024 * 1024 }), '2.0 MB/s')
  assert.equal(jobSpeedText({ status: 'done', speed: 2048 }), '')
})

test('耗时：排队不计入运行时间，完成/失败/取消都停在 finishedAt', () => {
  const running = { status: 'running', createdAt: NOW - 90_000, startedAt: NOW - 30_000 }
  assert.equal(jobElapsedSeconds(running, NOW), 30)
  assert.equal(jobElapsedText(running, NOW), '已进行 30 秒')

  const queued = { status: 'queued', createdAt: NOW - 90_000 }
  assert.equal(jobElapsedText(queued, NOW), '已排队 1 分')

  const cancelling = { status: 'cancelling', startedAt: NOW - 30_000 }
  assert.equal(jobElapsedText(cancelling, NOW), '取消中')

  const done = { status: 'done', createdAt: NOW - 90_000, startedAt: NOW - 80_000, finishedAt: NOW - 20_000 }
  assert.equal(jobElapsedSeconds(done, NOW), 60)
  assert.equal(jobElapsedText(done, NOW), '用时 1 分')

  const failed = { status: 'failed', startedAt: NOW - 12_000, finishedAt: NOW - 6000 }
  assert.equal(jobElapsedText(failed, NOW), '用时 6 秒')

  // 失败任务没有 finishedAt 时不能继续显示「已进行」。
  assert.equal(jobElapsedText({ status: 'failed', startedAt: NOW - 12_000 }, NOW), '')
})

test('jobMetaText：排队不显示 0%，下载中组合字节、百分比、速度、耗时', () => {
  const queued = { status: 'queued', createdAt: NOW - 90_000, progress: 0 }
  assert.equal(jobMetaText(queued, NOW), '已排队 1 分')

  const job = { status: 'running', received: 58 * 1024 ** 2, total: 60 * 1024 ** 2, speed: 1024 ** 2, startedAt: NOW - 9000 }
  const text = jobMetaText(job, NOW)
  assert.match(text, /58 MB \/ 60 MB/)
  assert.match(text, /97%/)
  assert.match(text, /1\.0 MB\/s/)
  assert.match(text, /已进行 9 秒/)
})

test('无进展提示：运行中超过 2 分钟才显示，排队/终态不显示', () => {
  const running = { status: 'running', startedAt: NOW - 3_600_000, updatedAt: NOW - 600_000 }
  assert.equal(jobIdleText(running, NOW), '无进展 10 分')
  assert.match(jobMetaText(running, NOW), /已进行 1\.0 小时/)
  assert.match(jobMetaText(running, NOW), /无进展 10 分/)

  assert.equal(jobIdleText({ status: 'running', updatedAt: NOW - 30_000 }, NOW), '')
  assert.equal(jobIdleText({ status: 'queued', createdAt: NOW - 600_000, updatedAt: NOW - 600_000 }, NOW), '')
  assert.equal(jobIdleText({ status: 'done', updatedAt: NOW - 600_000 }, NOW), '')
  assert.equal(jobIdleText({ status: 'running' }, NOW), '')
})

test('状态判断与标签', () => {
  assert.equal(isActiveJob({ status: 'installing' }), true)
  assert.equal(isActiveJob({ status: 'done' }), false)
  assert.equal(isFinishedJob({ status: 'cancelled' }), true)
  assert.equal(jobStatusLabel({ status: 'installing' }), '安装中')
  assert.equal(jobStatusLabel({}), '未知')
})

test('mergeJobs：按 id 去重、保留更完整对象、按开始/创建时间倒序', () => {
  const merged = mergeJobs(
    [{ id: 'a', status: 'running', startedAt: 10 }, { id: 'b', status: 'done', startedAt: 30 }],
    [{ id: 'a', status: 'running', startedAt: 10, progress: 50 }, { id: 'c', status: 'queued', createdAt: 20 }]
  )
  assert.deepEqual(merged.map((job) => job.id), ['b', 'c', 'a'])
  assert.equal(merged.find((job) => job.id === 'a').progress, 50)
})
