import test from 'node:test'
import assert from 'node:assert/strict'
import { parseBoundPort } from '../src/server/i18n.js'

test('翻译工作台只从启动横幅提取实际绑定端口', () => {
  assert.equal(parseBoundPort('图形界面地址：http://127.0.0.1:8637\r\n'), 8637)
  assert.equal(parseBoundPort('banner\n  图形界面地址: http://127.0.0.1:8642\n'), 8642)
  assert.equal(parseBoundPort('ready at http://127.0.0.1:8636/api/status\n'), 0)
  assert.equal(parseBoundPort('图形界面地址：http://127.0.0.1:863'), 0)
  assert.equal(parseBoundPort('图形界面地址：http://127.0.0.1:863'.concat('7\r\n')), 8637)
  assert.equal(parseBoundPort('图形界面地址：http://127.0.0.1:99999\n'), 0)
})
