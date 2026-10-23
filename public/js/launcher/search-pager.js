// 启动器在线搜索（模组 / 资源包 / 光影 / 整合包）共用的排序项与分页条。
// 社区接口原生支持 offset + sort，这里只负责把页码换算成 offset 并展示分页状态。
import { h } from '../core/dom.js'
import { btn } from '../ui/kit.js'

// 与后端 src/server/community.js 的统一排序项保持一致。
export const SEARCH_SORTS = [
  ['relevance', '相关性'],
  ['downloads', '下载量（热度）'],
  ['follows', '点赞'],
  ['updated', '最近更新'],
  ['newest', '最新发布']
]

export const SEARCH_PAGE_SIZE = 20

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/**
 * 分页条：上一页 / 页码输入 / 下一页。
 *
 * @param {{ pageSize?: number, onChange?: (page: number) => void }} options
 *   onChange 只接收目标页码（从 1 开始），请求由调用方发起；
 *   pageSize 必须与请求里的 limit 一致，否则「1–20 / 共 N」会算错。
 */
export function createPager({ pageSize = SEARCH_PAGE_SIZE, onChange = () => {} } = {}) {
  const requestedSize = Number(pageSize)
  const size = Number.isFinite(requestedSize) && requestedSize > 0
    ? Math.max(1, Math.floor(requestedSize))
    : SEARCH_PAGE_SIZE
  let page = 1
  let total = 0
  let count = 0
  let loading = false
  let disposed = false

  const prev = btn('上一页', { size: 'sm', iconName: 'arrow-left' })
  const next = btn('下一页', { size: 'sm', iconName: 'arrow-right' })
  const jump = h('input', {
    class: 'input lp-pager-jump mono',
    type: 'number',
    min: '1',
    step: '1',
    value: '1',
    title: '输入页码后按 Enter 跳转',
    'aria-label': '跳转到页码'
  })
  const pageText = h('span', { class: 'lp-pager-page' }, '第 ', jump, ' 页')
  const info = h('span', { class: 'lp-pager-info mono' }, '共 0 个结果')
  const el = h('div', { class: 'lp-pager' }, prev, pageText, h('span', { class: 'spacer' }), info, next)

  function pageCount() {
    return Math.max(1, Math.ceil(total / size))
  }

  function render() {
    const pages = pageCount()
    page = clamp(page, 1, pages)
    const start = count ? (page - 1) * size + 1 : 0
    const end = count ? start + count - 1 : 0

    jump.value = String(page)
    jump.max = String(pages)
    jump.disabled = disposed || loading || pages <= 1
    prev.disabled = disposed || loading || page <= 1
    next.disabled = disposed || loading || page >= pages || count === 0
    info.textContent = count ? `${start}–${end} / 共 ${total} 个结果` : `共 ${total} 个结果`
    el.dataset.page = String(page)
    el.dataset.pages = String(pages)
  }

  function go(target) {
    if (disposed || loading) return
    const wanted = clamp(Math.round(Number(target) || 1), 1, pageCount())
    if (wanted === page) {
      jump.value = String(page)
      return
    }
    onChange(wanted)
  }

  prev.addEventListener('click', () => go(page - 1))
  next.addEventListener('click', () => go(page + 1))
  jump.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      go(jump.value)
    } else if (event.key === 'Escape') {
      jump.value = String(page)
      jump.blur()
    }
  })
  jump.addEventListener('change', () => go(jump.value))
  jump.addEventListener('blur', () => { jump.value = String(page) })

  render()

  return {
    el,
    /** 请求开始/结束时调用；不传字段则保持原值。 */
    set({ page: nextPage, total: nextTotal, count: nextCount, loading: nextLoading } = {}) {
      if (Number.isFinite(Number(nextPage)) && nextPage !== undefined) page = Number(nextPage)
      if (Number.isFinite(Number(nextTotal)) && nextTotal !== undefined) total = Math.max(0, Number(nextTotal))
      if (Number.isFinite(Number(nextCount)) && nextCount !== undefined) count = Math.max(0, Number(nextCount))
      if (typeof nextLoading === 'boolean') loading = nextLoading
      render()
    },
    /** 当前页码（1 起）。 */
    get page() { return page },
    get total() { return total },
    get pageSize() { return size },
    destroy() {
      disposed = true
      render()
    }
  }
}

/** 页码 → 接口 offset；页码从 1 开始，非法值按第 1 页处理。 */
export function pageOffset(page, pageSize = SEARCH_PAGE_SIZE) {
  const requestedSize = Number(pageSize)
  const size = Number.isFinite(requestedSize) && requestedSize > 0
    ? Math.max(1, Math.floor(requestedSize))
    : SEARCH_PAGE_SIZE
  const requestedPage = Number(page)
  const value = Number.isFinite(requestedPage) ? Math.max(1, Math.round(requestedPage)) : 1
  return (value - 1) * size
}
