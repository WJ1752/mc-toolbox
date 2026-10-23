// CurseForge 排序参数：v1 API 只接受 asc / desc，数字 1/2 会返回 HTTP 400。
import test from 'node:test'
import assert from 'node:assert/strict'
import { curseforgeSort } from '../src/server/community.js'

test('curseforgeSort：下载量使用 TotalDownloads(sortField=6) 且降序', () => {
  assert.deepEqual(curseforgeSort('downloads'), { sortField: '6', sortOrder: 'desc' })
})

test('curseforgeSort：点赞 / 最近更新 / 最新发布均按 desc 排序', () => {
  for (const sort of ['follows', 'updated', 'newest']) {
    const value = curseforgeSort(sort)
    assert.ok(value.sortField, sort)
    assert.equal(value.sortOrder, 'desc', sort)
  }
})

test('curseforgeSort：所有 sortOrder 只能是 asc / desc，不能是旧数字值', () => {
  for (const sort of ['relevance', 'downloads', 'follows', 'updated', 'newest']) {
    const value = curseforgeSort(sort)
    if (value.sortOrder !== undefined) {
      assert.ok(['asc', 'desc'].includes(value.sortOrder), `${sort}: ${value.sortOrder}`)
    }
  }
})

test('curseforgeSort：未知排序回落到相关性（Featured）', () => {
  assert.deepEqual(curseforgeSort('bogus'), { sortField: '1' })
  assert.deepEqual(curseforgeSort(''), { sortField: '1' })
  assert.deepEqual(curseforgeSort(undefined), { sortField: '1' })
})
