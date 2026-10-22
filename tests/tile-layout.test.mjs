// 手动列布局的纯函数测试（不依赖 DOM / jsdom）。
// 布局约定：
//   * col 为 0 基列号，列内按数组顺序（DOM 顺序）垂直堆叠；
//   * 列高独立累计，容器高度取最高列；
//   * 保存的 col 只影响显示：超出有效列数时 clamp，不改写输入。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clampColumn,
  resolveTileColumn,
  manualLayout,
  manualTargetColumn,
  manualInsertIndex
} from '../public/js/core/grid.js'

const GAP = 14
const COL = 300
const PITCH = COL + GAP

test('手动布局：全部 col=0 时左对齐、按高度堆叠、容器高度正确', () => {
  const items = [
    { id: 'a', col: 0, height: 100 },
    { id: 'b', col: 0, height: 60 },
    { id: 'c', col: 0, height: 40 }
  ]
  const layout = manualLayout(items, { columns: 3, colWidth: COL, gap: GAP })

  assert.equal(layout.positions.length, 3)
  for (const pos of layout.positions) {
    assert.equal(pos.col, 0, '全部磁贴留在第一列')
    assert.equal(pos.left, 0, '第一列左对齐')
  }
  assert.deepEqual(layout.positions.map((p) => p.top), [0, 100 + GAP, 100 + GAP + 60 + GAP])
  assert.equal(layout.height, 100 + GAP + 60 + GAP + 40, '容器高度 = 第一列总高')
  // 没有磁贴的列高度为 0。
  assert.equal(layout.heights[1], 0)
  assert.equal(layout.heights[2], 0)
  assert.equal(layout.heights[0], layout.height + GAP)

  // 多列时容器高度取最高列，而不是所有列高之和。
  const mixed = manualLayout(
    [
      { id: 'x', col: 0, height: 90 },
      { id: 'y', col: 2, height: 30 }
    ],
    { columns: 3, colWidth: COL, gap: GAP }
  )
  assert.equal(mixed.height, 90)
  assert.equal(mixed.positions[1].left, 2 * PITCH, 'col=2 的磁贴落在第三列')
})

test('手动布局：移动第一列磁贴不改变第二列坐标', () => {
  const base = [
    { id: 'a', col: 0, height: 100 },
    { id: 'b', col: 1, height: 120 },
    { id: 'c', col: 0, height: 50 }
  ]
  const before = manualLayout(base, { columns: 2, colWidth: COL, gap: GAP })
  const posOf = (layout, id) => layout.positions.find((p) => p.id === id)
  const bBefore = { ...posOf(before, 'b') }
  assert.equal(bBefore.col, 1)
  assert.equal(bBefore.left, PITCH)
  assert.equal(bBefore.top, 0)

  // 第一列内把 c 拖到 a 前面。
  const moved = [
    { id: 'c', col: 0, height: 50 },
    { id: 'a', col: 0, height: 100 },
    { id: 'b', col: 1, height: 120 }
  ]
  const after = manualLayout(moved, { columns: 2, colWidth: COL, gap: GAP })
  assert.deepEqual(posOf(after, 'b'), bBefore, '第二列坐标完全不变')
  assert.equal(posOf(after, 'c').top, 0)
  assert.equal(posOf(after, 'a').top, 50 + GAP)
  assert.equal(after.height, 50 + GAP + 100, '容器高度只由第一列决定')

  // 第一列再插入一块，第二列仍然不动。
  const inserted = [
    { id: 'c', col: 0, height: 50 },
    { id: 'd', col: 0, height: 30 },
    { id: 'a', col: 0, height: 100 },
    { id: 'b', col: 1, height: 120 }
  ]
  const after2 = manualLayout(inserted, { columns: 2, colWidth: COL, gap: GAP })
  assert.deepEqual(posOf(after2, 'b'), bBefore)
  assert.equal(after2.height, 50 + GAP + 30 + GAP + 100)
})

test('手动布局：col 超出有效列数时 clamp 显示但不改写输入值', () => {
  const items = [
    { id: 'a', col: 5, height: 40 },
    { id: 'b', col: 9, height: 20 },
    { id: 'c', col: 1, height: 30 }
  ]
  const layout = manualLayout(items, { columns: 3, colWidth: COL, gap: GAP })

  assert.equal(layout.positions[0].requestedCol, 5)
  assert.equal(layout.positions[0].col, 2, '超出时临时显示在最后一列')
  assert.equal(layout.positions[0].left, 2 * PITCH)
  assert.equal(layout.positions[1].col, 2, '多个超界磁贴都 clamp 到最后一列')
  assert.equal(layout.positions[1].top, 40 + GAP, '仍需在列内顺序堆叠')
  assert.equal(layout.positions[2].col, 1)
  assert.equal(layout.positions[2].top, 0)

  // 输入值（保存的列位）不能被 clamp 结果覆盖。
  assert.equal(items[0].col, 5)
  assert.equal(items[1].col, 9)

  // 窗口变宽 / 有效列数恢复后，磁贴回到原来的列。
  const wide = manualLayout(items, { columns: 6, colWidth: COL, gap: GAP })
  assert.equal(wide.positions[0].col, 5)
  assert.equal(wide.positions[0].left, 5 * PITCH)
  assert.equal(wide.positions[1].col, 5)
})

test('manualTargetColumn：gap 归属、边界与最后一列', () => {
  const metrics = { left: 0, colWidth: COL, gap: GAP, columns: 3 }

  assert.equal(manualTargetColumn(-100, metrics), 0, '容器左侧越界 clamp 到第一列')
  assert.equal(manualTargetColumn(0, metrics), 0)
  assert.equal(manualTargetColumn(299, metrics), 0)
  assert.equal(manualTargetColumn(300, metrics), 0, '列尾空白仍归当前列')
  assert.equal(manualTargetColumn(313, metrics), 0, '列间距归左边一列')
  assert.equal(manualTargetColumn(314, metrics), 1, '越过下一列起点才换列')
  assert.equal(manualTargetColumn(470, metrics), 1)
  assert.equal(manualTargetColumn(627, metrics), 1)
  assert.equal(manualTargetColumn(628, metrics), 2)
  assert.equal(manualTargetColumn(100000, metrics), 2, '容器外仍 clamp 到最后一列')

  // 容器坐标偏移与单列边界。
  assert.equal(manualTargetColumn(100, { ...metrics, left: 100 }), 0)
  assert.equal(manualTargetColumn(500, { ...metrics, left: 100 }), 1)
  assert.equal(manualTargetColumn(50, { columns: 1, colWidth: COL, gap: GAP }), 0)
  assert.equal(manualTargetColumn(50, { columns: 3, colWidth: 0 }), 0)
})

test('manualInsertIndex：按磁贴中线插入', () => {
  const items = [
    { top: 0, height: 100 },   // 中线 50
    { top: 114, height: 100 }, // 中线 164
    { top: 228, height: 60 }   // 中线 258
  ]

  assert.equal(manualInsertIndex(items, -20), 0)
  assert.equal(manualInsertIndex(items, 49), 0)
  assert.equal(manualInsertIndex(items, 50), 1, '正好在中线上时插到它后面')
  assert.equal(manualInsertIndex(items, 113), 1)
  assert.equal(manualInsertIndex(items, 163), 1)
  assert.equal(manualInsertIndex(items, 164), 2, '越过第二块中线')
  assert.equal(manualInsertIndex(items, 257), 2)
  assert.equal(manualInsertIndex(items, 258), 3, '越过所有中线时追加到列尾')
  assert.equal(manualInsertIndex(items, 99999), 3)
  assert.equal(manualInsertIndex([], 10), 0)
  assert.equal(manualInsertIndex(items, NaN), 3, '非法坐标按列尾处理')
})

test('clampColumn：负值与超界统一收敛到有效列', () => {
  assert.equal(clampColumn(-2, 3), 0)
  assert.equal(clampColumn(0, 3), 0)
  assert.equal(clampColumn(1, 3), 1)
  assert.equal(clampColumn(7, 3), 2)
  assert.equal(clampColumn(2, 1), 0)
  assert.equal(clampColumn(undefined, 3), 0)
})

test('resolveTileColumn：保存值优先，老数据按顺序分列，新磁贴进入第一列', () => {
  // 保存的 col（包括超过当前窗口有效列数的值）原样返回，供窗口变宽后恢复。
  assert.equal(resolveTileColumn(3, 0, 4), 3)
  assert.equal(resolveTileColumn(9, 7, 2), 9)
  assert.equal(resolveTileColumn('2', 0, 4), 2)
  // 缺少 / 非法 col：按 layout 顺序均匀分列。
  assert.equal(resolveTileColumn(undefined, 0, 4), 0)
  assert.equal(resolveTileColumn(null, 1, 4), 1)
  assert.equal(resolveTileColumn('', 4, 4), 0)
  assert.equal(resolveTileColumn(-1, 5, 4), 1)
  assert.equal(resolveTileColumn(undefined, 7, 2), 1)
  // 单列 / 非法列数时全部落在第一列。
  assert.equal(resolveTileColumn(undefined, 5, 1), 0)
  assert.equal(resolveTileColumn(undefined, 5, 0), 0)
})
