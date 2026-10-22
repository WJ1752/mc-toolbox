// 工作台社区下载磁贴：行复用 + 统一进度口径的纯逻辑测试（不依赖 DOM）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileJobRows } from '../public/features/community-download/job-board.js'
import { jobProgress } from '../public/js/core/jobs.js'

const job = (id, extra = {}) => ({
  id,
  status: 'running',
  filename: `${id}.jar`,
  received: 0,
  total: 0,
  ...extra
})

// 模拟 tile.js 里的 rows Map + list 子节点顺序：
// 只根据 reconcileJobRows 的结果创建/更新/移除/重排，验证不会重复建行。
function createFakeBoard(limit = 8) {
  const dom = []
  const rows = new Map()
  return {
    dom,
    rows,
    render(items) {
      const plan = reconcileJobRows(dom, items, limit)
      for (const id of plan.removedIds) {
        const at = dom.indexOf(id)
        if (at >= 0) dom.splice(at, 1)
        rows.delete(id)
      }
      plan.items.forEach((item, index) => {
        const row = rows.get(item.id)
        if (row) row.job = item
        else rows.set(item.id, { id: item.id, job: item })
        const at = dom.indexOf(item.id)
        if (at === index) return
        if (at >= 0) dom.splice(at, 1)
        dom.splice(index, 0, item.id)
      })
      return plan
    }
  }
}

test('连续两次 render 同一任务：复用已有行，行 id 不重复', () => {
  const board = createFakeBoard()
  const first = board.render([job('task-a')])
  assert.deepEqual(first.orderedIds, ['task-a'])
  assert.deepEqual(first.createdIds, ['task-a'])
  assert.deepEqual(first.updatedIds, [])
  assert.deepEqual(board.dom, ['task-a'])

  const second = board.render([job('task-a', { received: 30, total: 63 })])
  assert.deepEqual(second.orderedIds, ['task-a'])
  assert.deepEqual(second.createdIds, [])
  assert.deepEqual(second.updatedIds, ['task-a'])

  // 连续 30 次轮询（模拟 1.2s × 30 ≈ 36 秒）行数不增长。
  for (let i = 1; i <= 30; i++) {
    const poll = board.render([job('task-a', { received: i, total: 30 })])
    assert.deepEqual(poll.createdIds, [])
    assert.deepEqual(poll.orderedIds, ['task-a'])
  }
  assert.deepEqual(board.dom, ['task-a'])
  assert.equal(board.dom.filter((id) => id === 'task-a').length, 1)
  assert.equal(board.rows.size, 1)

  const done = board.render([job('task-a', { status: 'done', received: 30, total: 30 })])
  assert.deepEqual(done.createdIds, [])
  assert.deepEqual(done.updatedIds, ['task-a'])
  assert.equal(board.rows.get('task-a').job.status, 'done')
})

test('任务完成/新增/消失：移除旧行并按服务端顺序重排', () => {
  const board = createFakeBoard()
  board.render([job('a'), job('b')])

  // 任务 a 完成（同 id 复用）、b 消失、c 新增；服务端顺序为 c, a。
  const plan = board.render([job('c'), job('a', { status: 'done' })])
  assert.deepEqual(plan.orderedIds, ['c', 'a'])
  assert.deepEqual(plan.createdIds, ['c'])
  assert.deepEqual(plan.updatedIds, ['a'])
  assert.deepEqual(plan.removedIds, ['b'])
  assert.deepEqual(board.dom, ['c', 'a'])
  assert.equal(board.rows.size, 2)
  assert.equal(board.rows.get('a').job.status, 'done')

  // 全部消失后行与记录都清空。
  const empty = board.render([])
  assert.deepEqual(empty.removedIds, ['c', 'a'])
  assert.deepEqual(board.dom, [])
  assert.equal(board.rows.size, 0)
})

test('limit 截断：只保留服务端顺序前 N 个，其余行移除', () => {
  const board = createFakeBoard(3)
  board.render([job('a'), job('b'), job('c'), job('d')])
  assert.deepEqual(board.dom, ['a', 'b', 'c'])

  const plan = board.render([job('d'), job('b'), job('e'), job('a')])
  assert.deepEqual(plan.orderedIds, ['d', 'b', 'e'])
  assert.deepEqual(plan.createdIds, ['d', 'e'])
  assert.deepEqual(plan.updatedIds, ['b'])
  assert.deepEqual(plan.removedIds, ['a', 'c'])
  assert.deepEqual(board.dom, ['d', 'b', 'e'])
  assert.equal(board.rows.size, 3)

  // limit = 0 时全部移除。
  assert.deepEqual(reconcileJobRows(['d'], [job('e')], 0), {
    items: [],
    orderedIds: [],
    createdIds: [],
    updatedIds: [],
    removedIds: ['d']
  })
})

test('同一 id 在服务端列表重复出现时只保留第一项', () => {
  const items = [job('a', { filename: 'first.jar' }), job('a', { filename: 'second.jar' }), job('b')]
  const plan = reconcileJobRows([], items, 8)
  assert.deepEqual(plan.orderedIds, ['a', 'b'])
  assert.equal(plan.items.length, 2)
  assert.equal(plan.items[0].filename, 'first.jar')
})

test('jobProgress：running / installing / done / 未知 的确定进度', () => {
  assert.equal(jobProgress({ status: 'running', received: 25, total: 100 }), 25)
  assert.equal(jobProgress({ status: 'running', progress: 42.6 }), 42.6)
  assert.equal(jobProgress({ status: 'installing', installProgress: 37.2 }), 37.2)
  assert.equal(jobProgress({ status: 'done', received: 1, total: 2 }), 100)
  // 未知进度必须是 null，界面才显示不确定动画。
  assert.equal(jobProgress({ status: 'queued' }), null)
  assert.equal(jobProgress({ status: 'installing' }), null)
  assert.equal(jobProgress({ status: 'running', received: 5, total: 0 }), null)
  assert.equal(jobProgress({ status: 'running', indeterminate: true, received: 5, total: 10 }), null)
  assert.equal(jobProgress(null), null)
})
