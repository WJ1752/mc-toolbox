// 社区下载磁贴的行复用逻辑（纯函数，不触碰 DOM）。
//
// 轮询接口每次都返回完整任务列表，但磁贴不能每次都新建行：旧实现每轮
// 都 rowFor(j) 追加节点，rows.set(id) 只覆盖记录、不移除旧 DOM，于是同一
// 任务被重复渲染成多行。这里把「上一轮已渲染的 id → 本轮任务列表」的
// 计算抽出来，使磁贴只做最小的创建/更新/移除操作。

/** @typedef {{ id: string|number }} JobLike */

function normalizeIds(prevIds) {
  const list = prevIds == null
    ? []
    : (typeof prevIds[Symbol.iterator] === 'function' ? Array.from(prevIds) : [])
  const seen = new Set()
  const out = []
  for (const id of list) {
    if (id === null || id === undefined || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return { list: out, seen }
}

function normalizeLimit(limit) {
  const n = Number(limit)
  if (!Number.isFinite(n)) return Infinity
  return Math.max(0, Math.floor(n))
}

/**
 * 计算本轮应如何更新行。
 *
 * @param {Iterable<string|number>} prevIds 上一轮已渲染的行 id（DOM 顺序）
 * @param {JobLike[]} items 本轮服务端返回的任务，已按服务端顺序排列
 * @param {number} [limit=Infinity] 最多展示多少行
 * @returns {{
 *   items: JobLike[],
 *   orderedIds: Array<string|number>,
 *   createdIds: Array<string|number>,
 *   updatedIds: Array<string|number>,
 *   removedIds: Array<string|number>
 * }}
 * - `items` / `orderedIds`：去重、截断后的本轮展示项与顺序；
 * - `createdIds`：需要新建行的 id；
 * - `updatedIds`：可复用已有行、只更新内容的 id；
 * - `removedIds`：已消失或超出 limit、需要从 DOM 移除的旧 id。
 */
export function reconcileJobRows(prevIds, items, limit = Infinity) {
  const prev = normalizeIds(prevIds)
  const max = normalizeLimit(limit)

  const shown = []
  const nextSeen = new Set()
  for (const item of Array.isArray(items) ? items : []) {
    const id = item?.id
    if (id === null || id === undefined || nextSeen.has(id)) continue
    if (shown.length >= max) break
    nextSeen.add(id)
    shown.push(item)
  }

  const createdIds = []
  const updatedIds = []
  const orderedIds = []
  for (const item of shown) {
    orderedIds.push(item.id)
    if (prev.seen.has(item.id)) updatedIds.push(item.id)
    else createdIds.push(item.id)
  }

  const removedIds = prev.list.filter((id) => !nextSeen.has(id))
  return { items: shown, orderedIds, createdIds, updatedIds, removedIds }
}
