// 在线搜索分页纯逻辑：页码 → 接口 offset、排序项与页大小。
import test from 'node:test'
import assert from 'node:assert/strict'
import { pageOffset, SEARCH_PAGE_SIZE, SEARCH_SORTS } from '../public/js/launcher/search-pager.js'

test('pageOffset：第 1 页从 0 开始，之后按页大小递增', () => {
  assert.equal(pageOffset(1), 0)
  assert.equal(pageOffset(2), 20)
  assert.equal(pageOffset(3), 40)
  assert.equal(pageOffset(10), 180)
})

test('pageOffset：非法页码一律回到第 1 页', () => {
  for (const value of [0, -1, '', 'abc', null, undefined, NaN, Infinity]) {
    assert.equal(pageOffset(value), 0, String(value))
  }
  assert.equal(pageOffset(2.6), 40)
})

test('pageOffset：自定义页大小与搜索请求保持一致', () => {
  assert.equal(pageOffset(3, 50), 100)
  assert.equal(pageOffset(2, 0), 20)
  assert.equal(pageOffset(2, -10), 20)
})

test('SEARCH_PAGE_SIZE / SEARCH_SORTS：页大小 20，且包含按下载量（热度）排序', () => {
  assert.equal(SEARCH_PAGE_SIZE, 20)
  const values = SEARCH_SORTS.map(([value]) => value)
  assert.deepEqual(values, ['relevance', 'downloads', 'follows', 'updated', 'newest'])
  assert.equal(new Set(values).size, values.length)
  assert.match(SEARCH_SORTS.find(([value]) => value === 'downloads')[1], /下载量.*热度/)
})
