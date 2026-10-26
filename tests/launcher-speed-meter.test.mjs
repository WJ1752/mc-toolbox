// 速度采样：平滑、无新字节时衰减到 0、负增量（阶段清零）不能变成负速度。
import test from 'node:test'
import assert from 'node:assert/strict'
import { nextSpeed } from '../src/server/launcher/speed-meter.js'

test('第一次采样直接使用瞬时速度', () => {
  assert.equal(nextSpeed(0, 1024 * 1024, 0.5), 2 * 1024 * 1024)
})

test('有历史值时做指数平滑，不会因单次抖动跳变', () => {
  const smoothed = nextSpeed(1024 * 1024, 2 * 1024 * 1024, 1)
  assert.ok(smoothed > 1024 * 1024, '应向上收敛')
  assert.ok(smoothed < 2 * 1024 * 1024, '不能直接跳到瞬时值')
})

test('没有新字节时快速衰减，几秒后归零', () => {
  let speed = 4 * 1024 * 1024
  for (let i = 0; i < 20; i++) speed = nextSpeed(speed, 0, 0.5)
  assert.equal(speed, 0)
})

test('负增量按「没有新字节」处理，绝不产生负速度', () => {
  assert.equal(nextSpeed(1024, -4096, 1), 0)
  assert.equal(nextSpeed(-100, 1024, 1), 1024)
  assert.equal(nextSpeed(1024, 1024, 0), 1024)
  assert.equal(nextSpeed(0, 0, 1), 0)
})

test('小于 1 KB/s 的噪声归零', () => {
  assert.equal(nextSpeed(0, 100, 1), 0)
  assert.equal(nextSpeed(0, 2048, 1), 2048)
})
