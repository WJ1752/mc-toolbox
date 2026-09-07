import { h, clear, fmtAgo, fmtTime, fmtDuration } from '/js/core/dom.js'
import { api } from '/js/core/api.js'
import { openModal, confirmDialog } from '/js/core/modal.js'
import { toast } from '/js/core/toast.js'
import { TileGrid } from '/js/core/grid.js'
import { drawLatencyChart, drawPlayersChart, drawLossChart, drawSparkByMetric } from '/js/core/chart.js'

let ctxRef = null
let innerGrid = null
let listEl = null
let emptyEl = null
let bulkRow = null
let snapshot = null
let timer = null
let openDetailId = null
let openDetailRefresh = null

const PALETTE = ['#5ec96a', '#3ba0ff', '#c084fc', '#ff8a4c', '#22d3ee', '#eab308', '#f43f5e']
const METRIC_KEYS = ['latency', 'players', 'loss']
const METRIC_LABEL = { latency: '延迟', players: '在线人数', loss: '丢包率' }

export default {
  async mount(ctx) {
    ctxRef = ctx
    const s = ctx.settings()

    const toolbar = h('div', { class: 'row wrap' },
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => openEditor() }, '＋ 添加 IP'),
      h('button', { class: 'btn btn-sm', id: 'monToggle', onclick: toggleEngine }, '⏸ 暂停'),
      h('button', { class: 'btn btn-sm', onclick: () => refresh(true) }, '↻ 刷新'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted', id: 'monMeta' }, '')
    )
    // 一键把「所有」磁贴的图表指标指标统一：点击后逐台保存并即时重绘
    bulkRow = h('div', { class: 'row', style: { gap: '6px', alignItems: 'center', margin: '2px 0 8px' } },
      h('span', { class: 'muted', style: { fontSize: '11px' } }, '全部图表指标：'),
      h('div', { class: 'seg' }, ...METRIC_KEYS.map((v) =>
        h('button', {
          dataset: { metric: v },
          title: `把全部磁贴的图表指标改为「${METRIC_LABEL[v]}」`,
          onclick: (e) => bulkMetric(v, e.currentTarget)
        }, METRIC_LABEL[v]))))
    listEl = h('div', { class: 'grid mini', style: { gap: '8px' } })
    emptyEl = h('div', { class: 'muted center', style: { padding: '18px 0' } }, '还没有监测项，点击「＋ 添加 IP」开始。')

    ctx.body.appendChild(toolbar)
    ctx.body.appendChild(bulkRow)
    ctx.body.appendChild(listEl)
    ctx.body.appendChild(emptyEl)

    innerGrid = new TileGrid(listEl, {
      itemSelector: '.mon-card',
      handleSelector: '.mon-head',
      placeholderClass: 'tile-placeholder',
      animations: ctx.settings().general.animations,
      onChange: async (ids) => {
        try {
          await api.post('/api/monitors/reorder', { ids })
        } catch (e) {
          toast('排序保存失败：' + e.message, 'err')
        }
      }
    })

    async function toggleEngine() {
      const run = !(snapshot?.running ?? true)
      await api.post('/api/monitors/engine', { running: run })
      toast(run ? '监测已启动' : '监测已暂停', 'ok')
      refresh(true)
    }

    // 接受其它功能的请求（例如「服务器在线测试」一键加入监测）
    ctx.bus.on('monitor:request-add', (data) => openEditor(data))

    timer = setInterval(() => refresh(), Math.max(2000, (s.monitor.defaultInterval || 30) * 1000 / 4))
    refresh(true)
  },

  unmount() {
    clearInterval(timer)
    timer = null
    openDetailId = null
    openDetailRefresh = null
  },

  renderExpanded(container, { ctx, close } = {}) {
    const c = ctx || ctxRef
    const statsWrap = h('div', { class: 'stat-grid' })
    const chartWrap = h('div', { class: 'chart-wrap' })
    const canvas = h('canvas')
    chartWrap.appendChild(canvas)
    const sel = h('select', { class: 'input', style: { width: '220px' } })
    // 图表指标：与磁贴同一概念，作用于当前所选服务器；丢包率无逐点历史，以统计为准
    const metricSel = h('div', { class: 'seg' }, ...METRIC_KEYS.map((v) =>
      h('button', { dataset: { metric: v }, title: `把当前服务器的图表指标改为「${METRIC_LABEL[v]}」` }, METRIC_LABEL[v])))
    const logWrap = h('div', { class: 'log-list' })
    container.appendChild(h('div', { class: 'row wrap', style: { gap: '8px' } },
      h('span', {}, '选择服务器：'), sel, metricSel,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm', onclick: async () => { await api.post('/api/monitors/engine', { running: true }); toast('已启动', 'ok') } }, '▶ 启动'),
      h('button', { class: 'btn btn-sm', onclick: async () => { await api.post('/api/monitors/engine', { running: false }); toast('已暂停', 'ok') } }, '⏸ 暂停')))
    container.appendChild(statsWrap)
    container.appendChild(chartWrap)
    container.appendChild(h('div', { class: 'hr' }))
    container.appendChild(h('div', { class: 'muted' }, '最近记录'))
    container.appendChild(logWrap)

    let cur = null
    // 用户在展开视图里点击的图表指标（覆盖所选服务器已存值），切换服务器后复位
    let metricOverride = null

    const curMetric = () => {
      const m = (cur && cur.metric) || 'latency'
      return METRIC_KEYS.includes(metricOverride) ? metricOverride : METRIC_KEYS.includes(m) ? m : 'latency'
    }
    const syncMetric = (m) => {
      Array.from(metricSel.children).forEach((b) => b.classList.toggle('active', b.dataset.metric === m))
    }
    metricSel.querySelectorAll('button').forEach((b) => {
      b.onclick = async () => {
        const id = cur && cur.id
        if (!id) { toast('请先选择服务器', 'err'); return }
        const key = b.dataset.metric
        b.disabled = true
        try {
          const r = await api.put('/api/monitors/' + id, { metric: key })
          if (r && r.error) { toast(r.error, 'err'); return }
          metricOverride = key
          syncMetric(key)
          render(lastSnapshot)
          toast(`「${cur.name || id}」图表指标已改为「${METRIC_LABEL[key]}」`, 'ok')
        } catch (e) { toast('保存失败：' + e.message, 'err') } finally { b.disabled = false }
      }
    })

    const drawChart = () => {
      const hist = cur ? (cur.history || []) : []
      const metric = curMetric()
      if (metric === 'players') {
        drawPlayersChart(canvas, hist)
      } else if (metric === 'loss') {
        drawLossChart(canvas, hist)
      } else {
        drawLatencyChart(canvas, hist, { warnAt: c.settings().monitor.latencyWarn })
      }
    }

    const render = (snap) => {
      if (!snap) return
      const items = snap.items
      if (sel.options.length !== items.length) {
        clear(sel)
        for (const it of items) sel.appendChild(h('option', { value: it.id }, `${it.name} (${it.host}:${it.port})`))
      }
      cur = items.find((x) => x.id === (cur && cur.id)) || items[0]
      if (!cur) return
      sel.value = cur.id
      const metric = curMetric()
      syncMetric(metric)
      const st = cur.stats || {}
      const status = cur.status || {}
      const headBox = metric === 'players'
        ? ['当前在线', status.ok && status.players ? `${status.players.online ?? '-'}/${status.players.max ?? '-'}` : '—', '人', status.ok ? 'ok' : 'bad']
        : metric === 'loss'
          ? ['丢包率', st.loss ?? '—', '%', st.loss > 5 ? 'warn' : 'ok']
          : ['当前延迟', status.ok ? Math.round(status.latency ?? 0) : '—', 'ms', status.ok ? (status.latency > c.settings().monitor.latencyWarn ? 'warn' : 'ok') : 'bad']
      const boxes = [
        headBox,
        ['平均延迟', st.avg ?? '—', 'ms'],
        ['最低 / 最高', st.min != null ? `${Math.round(st.min)} / ${Math.round(st.max)}` : '—', 'ms'],
        ['在线率（全部）', st.uptime ?? '—', '%'],
        ['在线率（近 60 点）', st.uptimeRecent ?? '—', '%']
      ]
      if (metric !== 'loss') boxes.push(['丢包率', st.loss ?? '—', '%'])
      boxes.push(['连续失败', st.streakFails ?? 0, '次'], ['累计探测', st.totalChecks ?? 0, '次'])
      clear(statsWrap)
      for (const [label, val, unit, kind] of boxes) {
        statsWrap.appendChild(h('div', { class: 'stat-box' }, h('label', {}, label),
          h('b', { class: kind === 'bad' ? 'result-bad' : kind === 'ok' ? 'result-ok' : kind === 'warn' ? 'badge warn' : '' }, String(val), h('small', {}, ' ' + unit))))
      }
      drawChart()
      clear(logWrap)
      for (const p of (cur.history || []).slice(-40).reverse()) {
        logWrap.appendChild(h('div', {},
          h('span', { class: 't' }, fmtTime(p.t, c.settings().general.timeFormat === '12h')),
          p.ok ? h('span', { class: 'okl' }, `在线 · ${Math.round(p.ms)} ms${p.players != null ? ' · ' + p.players + ' 人' : ''}`) : h('span', { class: 'ko' }, '超时 / 无法连接')))
      }
    }
    sel.onchange = () => { cur = { id: sel.value }; metricOverride = null; render(lastSnapshot) }
    api.get('/api/monitors').then(render)
    const iv = setInterval(() => api.get('/api/monitors').then(render).catch(() => {}), 4000)
    const ro = new ResizeObserver(drawChart)
    ro.observe(chartWrap)
    // 关闭时清理
    const obs = new MutationObserver(() => {
      if (!document.body.contains(chartWrap)) {
        clearInterval(iv)
        ro.disconnect()
        obs.disconnect()
      }
    })
    obs.observe(document.body, { childList: true, subtree: true })
  }
}

let lastSnapshot = null
// 拖拽临时调整过的尺寸（monitorId -> {w,h}），仅本次会话生效；页面刷新后回到默认
const cardSizes = new Map()

async function refresh(force) {
  try {
    snapshot = await api.get('/api/monitors')
  } catch {
    return
  }
  lastSnapshot = snapshot
  if (!listEl) return
  const meta = document.getElementById('monMeta')
  if (meta) {
    const online = snapshot.items.filter((x) => x.status?.ok).length
    meta.textContent = `${snapshot.items.length} 台 · ${online} 在线${snapshot.running ? '' : ' · 已暂停'}`
  }
  const togg = document.getElementById('monToggle')
  if (togg) togg.textContent = snapshot.running ? '⏸ 暂停' : '▶ 继续'
  if (ctxRef) ctxRef.setBadge(`${snapshot.items.length} 台 / ${snapshot.items.filter((x) => x.status?.ok).length} 在线`, snapshot.running ? 'ok' : '')

  if (emptyEl) emptyEl.hidden = snapshot.items.length > 0

  // 全部图表指标快捷条：无监测项时隐藏；所有磁贴指标一致时高亮对应按钮
  if (bulkRow) {
    bulkRow.hidden = snapshot.items.length === 0
    const first = snapshot.items[0]
    const allSame = snapshot.items.length > 0 && snapshot.items.every((m) => (m.metric || 'latency') === (first.metric || 'latency'))
    const cur = allSame ? (first.metric || 'latency') : null
    bulkRow.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.metric === cur))
  }

  const wantedIds = snapshot.items.map((x) => x.id)
  const domIds = innerGrid.order()
  const needRebuild = force || wantedIds.length !== domIds.length || wantedIds.some((id, i) => id !== domIds[i])

  if (needRebuild) {
    for (const id of domIds) if (!wantedIds.includes(id)) innerGrid.remove(id)
    for (const m of snapshot.items) {
      if (!innerGrid.get(m.id)) {
        innerGrid.mount(buildCard(m, snapshot.items.indexOf(m)))
      } else {
        updateCard(innerGrid.get(m.id), m, snapshot.items.indexOf(m))
      }
    }
    innerGrid.setOrder(wantedIds)
  } else {
    snapshot.items.forEach((m, i) => updateCard(innerGrid.get(m.id), m, i))
  }
  if (openDetailId && openDetailRefresh) openDetailRefresh(snapshot)
  applyTileHeightPolicy()
}

// 按设置统一 / 约束小磁贴高度（右下角拖宽时高度仍遵循此策略）
function applyTileHeightPolicy() {
  if (!snapshot || !innerGrid) return
  const mon = (ctxRef ? ctxRef.settings() : {}).monitor || {}
  const mode = mon.tileHeightMode || 'fixed'
  const val = Math.max(40, Number(mon.tileHeight) || 100)
  for (const m of snapshot.items) {
    const card = innerGrid.get(m.id)
    if (!card) continue
    if (mode === 'auto') {
      card.style.height = 'auto'
      card.style.maxHeight = ''
    } else if (mode === 'max') {
      card.style.height = 'auto'
      card.style.maxHeight = val + 'px'
    } else {
      card.style.height = val + 'px'
      card.style.maxHeight = ''
    }
  }
}

function colorOf(index) {
  return PALETTE[index % PALETTE.length]
}

// 一键把所有磁贴图表指标改为某指标
async function bulkMetric(metric, btn) {
  const n = snapshot?.items?.length || 0
  if (!n) { toast('还没有监测项', 'err'); return }
  btn.disabled = true
  try {
    const r = await api.post('/api/monitors/metric', { metric })
    if (r.error) { toast(r.error, 'err'); return }
    toast(`已把 ${r.updated || n} 台服务器的图表指标改为「${METRIC_LABEL[metric]}」`, 'ok')
    refresh(true)
  } catch (e) {
    toast('操作失败：' + e.message, 'err')
  } finally {
    btn.disabled = false
  }
}

function buildCard(m, index) {
  const dot = h('span', { class: 'dot' })
  const name = h('span', { class: 'mc-name' }, m.name)
  const lat = h('span', { class: 'mc-lat' }, '--')
  const sub = h('div', { class: 'mc-sub' }, h('span', {}, `${m.host}:${m.port}`), h('span', {}, ''))
  const spark = h('canvas', { class: 'spark' })
  const card = h('div', { class: 'mon-card mini', dataset: { id: m.id }, onclick: () => {
    if (Date.now() - (innerGrid.lastDragEnd || 0) < 200) return
    openDetail(m.id)
  } },
    h('div', { class: 'mon-head' }, dot, name, h('span', { class: 'spacer' }), lat),
    sub,
    spark
  )
  // 右下角拖拽手柄：临时调整本卡宽高（本次会话内记住）
  const rz = h('span', {
    class: 'mon-rz',
    title: '拖动右下角改宽度；高度遵循「磁贴高度策略」设置',
    onclick: (e) => e.stopPropagation(),
    onpointerdown: (e) => {
      e.preventDefault()
      e.stopPropagation()
      startCardResize(card, m.id, e)
    }
  })
  card.appendChild(rz)
  const saved = cardSizes.get(m.id)
  if (saved) {
    card.style.width = saved.w + 'px'
    card.style.height = saved.h + 'px'
  }
  card.style.borderLeft = `3px solid ${m.color || colorOf(index)}`
  // 允许用户在设置里限制监测磁贴的最大宽度，0 表示不限制
  const maxW = ctxRef?.settings().monitor.maxTileWidth
  if (maxW > 0) card.style.maxWidth = maxW + 'px'
  updateCard(card, m, index)
  return card
}

function startCardResize(card, id, downEv) {
  const startX = downEv.clientX
  const startY = downEv.clientY
  const cw = card.offsetWidth || 150
  const ch = card.offsetHeight || 96
  const prevSelect = document.body.style.userSelect
  document.body.style.userSelect = 'none'

  // 高度遵循「磁贴高度策略」设置：
  //   固定 → 高度锁定为设定值，仅允许横向拖宽
  //   限高 → 高度不超过设定值
  //   自适应 → 可自由拖高（94–340px，旧行为）
  const mon = (ctxRef ? ctxRef.settings() : {}).monitor || {}
  const hMode = mon.tileHeightMode || 'fixed'
  const hFixed = Math.max(40, Number(mon.tileHeight) || 100)
  const heightLocked = hMode === 'fixed'
  const heightCapped = hMode === 'max'

  const move = (ev) => {
    let w = Math.round(cw + ev.clientX - startX)
    w = Math.max(128, Math.min(w, 620))
    const maxW = ctxRef?.settings().monitor.maxTileWidth
    if (maxW > 0) w = Math.min(w, maxW)
    const pw = card.parentElement ? card.parentElement.clientWidth : 0
    if (pw > 0 && w > pw) w = pw
    card.style.width = w + 'px'
    if (heightLocked) {
      // 固定：垂直拖动不改变高度
      card.style.height = hFixed + 'px'
      card.style.maxHeight = ''
    } else if (heightCapped) {
      // 限高：内容自适应，高度不超过上限（垂直拖动无效）
      card.style.height = 'auto'
      card.style.maxHeight = hFixed + 'px'
    } else {
      // 自适应：自由拖高（94–340px，会话内记住）
      let h = Math.round(ch + ev.clientY - startY)
      h = Math.max(94, Math.min(h, 340))
      card.style.height = h + 'px'
      card.style.maxHeight = ''
      cardSizes.set(id, { w, h })
    }
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    document.body.style.userSelect = prevSelect
    // 重绘 sparkline 以匹配新尺寸
    requestAnimationFrame(() => {
      const it = lastSnapshot?.items.find((x) => x.id === id)
      if (it) updateCard(card, it, lastSnapshot.items.indexOf(it))
    })
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

function updateCard(card, m, index) {
  if (!card) return
  const st = m.status || {}
  const dot = card.querySelector('.dot')
  const lat = card.querySelector('.mc-lat')
  const sub = card.querySelector('.mc-sub')
  const spark = card.querySelector('.spark')
  dot.className = 'dot ' + (st.checking ? 'loading' : st.ok ? 'ok' : st.offline || !st.ok ? 'bad' : 'warn')

  // 编辑（名称 / 域名+端口 / 颜色）后即时同步到卡片，无需重启
  const nameEl = card.querySelector('.mc-name')
  if (nameEl && nameEl.textContent !== m.name) nameEl.textContent = m.name
  if (sub && sub.children[0]) {
    const addr = `${m.host}:${m.port}`
    if (sub.children[0].textContent !== addr) sub.children[0].textContent = addr
  }
  const border = `3px solid ${m.color || colorOf(index)}`
  if (card.style.borderLeft !== border) card.style.borderLeft = border

  // 磁贴图表指标指标：延迟 / 在线人数 / 丢包率（每台服务器可独立选择）
  const metric = m.metric === 'players' || m.metric === 'loss' ? m.metric : 'latency'
  const players = st.players
  const warnAt = ctxRef?.settings().monitor.latencyWarn || 200
  const lossVal = (st.loss != null ? st.loss : (m.stats && m.stats.loss != null ? m.stats.loss : null))

  if (!st.ok) {
    lat.textContent = st.error ? '离线' : '--'
    lat.className = 'mc-lat result-bad'
  } else if (metric === 'players') {
    lat.textContent = players ? `${players.online ?? '-'}/${players.max ?? '-'} 人` : '--'
    lat.className = 'mc-lat badge warn'
  } else if (metric === 'loss') {
    lat.textContent = lossVal != null ? Math.round(lossVal) + '%' : '--'
    lat.className = 'mc-lat ' + (lossVal > 5 ? 'badge warn' : '')
  } else {
    lat.textContent = Math.round(st.latency) + ' ms'
    lat.className = 'mc-lat ' + (st.latency > warnAt ? 'badge warn' : '')
  }
  sub.children[1].textContent = st.ok
    ? `${players?.online ?? '-'}/${players?.max ?? '-'} 人 · ${Math.round(st.latency)} ms · ${fmtAgo(st.checkedAt)}`
    : (st.error || '等待首次探测')
  drawSparkByMetric(spark, m.history || [], metric, m.color || colorOf(index))
}

// ---------------- 详情弹窗 ----------------
function openDetail(id) {
  const statsWrap = h('div', { class: 'stat-grid' })
  const chartWrap = h('div', { class: 'chart-wrap' }, (() => h('canvas'))())
  const canvas = chartWrap.firstChild
  const logWrap = h('div', { class: 'log-list' })
  const head = h('div', { class: 'row wrap' })
  // 折线图图表指标：延迟 / 在线人数 / 丢包率（与磁贴同一概念，随所选服务器保存）
  const metricSel = h('div', { class: 'seg' }, ...METRIC_KEYS.map((v) =>
    h('button', { dataset: { metric: v }, title: `折线图显示「${METRIC_LABEL[v]}」` }, METRIC_LABEL[v])))
  const metricRow = h('div', { class: 'row wrap', style: { gap: '6px', alignItems: 'center' } },
    h('span', { class: 'muted' }, '图表指标：'), metricSel,
    h('span', { class: 'spacer' }),
    h('span', { class: 'muted', style: { fontSize: '11px' } }, '作用于本台服务器（磁贴与详情图同步）'))
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
    head, metricRow, statsWrap, chartWrap, h('div', { class: 'hr' }), h('div', { class: 'muted' }, '最近记录'), logWrap)

  const modal = openModal({
    title: '监测详情',
    size: 'lg',
    body,
    buttons: [
      { label: '编辑', onClick: () => { modal.close(); openEditor(snapshot?.items.find((x) => x.id === id), true) } },
      { label: '立即检测', onClick: async () => { await api.post('/api/monitors/' + id + '/check'); toast('已触发检测', 'ok'); refresh(true) } },
      { label: '关闭', class: 'btn-primary' }
    ],
    onClose: () => { openDetailId = null; openDetailRefresh = null }
  })

  openDetailId = id
  openDetailRefresh = render

  let metricOverride = null
  const curMetric = (m) => {
    const base = (m && m.metric) || 'latency'
    return METRIC_KEYS.includes(metricOverride) ? metricOverride : METRIC_KEYS.includes(base) ? base : 'latency'
  }
  const syncMetric = (m) => {
    Array.from(metricSel.children).forEach((b) => b.classList.toggle('active', b.dataset.metric === m))
  }
  metricSel.querySelectorAll('button').forEach((b) => {
    b.onclick = async () => {
      const key = b.dataset.metric
      b.disabled = true
      try {
        const r = await api.put('/api/monitors/' + id, { metric: key })
        if (r && r.error) { toast(r.error, 'err'); return }
        metricOverride = key
        syncMetric(key)
        render(lastSnapshot)
        toast(`折线图图表指标已改为「${METRIC_LABEL[key]}」`, 'ok')
      } catch (e) { toast('保存失败：' + e.message, 'err') } finally { b.disabled = false }
    }
  })

  const drawChart = (m) => {
    const hist = m ? (m.history || []) : []
    const metric = curMetric(m)
    if (metric === 'players') drawPlayersChart(canvas, hist)
    else if (metric === 'loss') drawLossChart(canvas, hist)
    else drawLatencyChart(canvas, hist, { warnAt: ctxRef.settings().monitor.latencyWarn })
  }

  function render(snap) {
    const m = (snap || lastSnapshot)?.items.find((x) => x.id === id)
    if (!m) return
    const s = ctxRef.settings()
    document.getElementById('modalTitle').textContent = `监测详情 · ${m.name}`
    clear(head)
    head.appendChild(h('span', { class: 'dot ' + (m.status?.ok ? 'ok' : 'bad') }))
    head.appendChild(h('strong', {}, m.name))
    head.appendChild(h('span', { class: 'badge' }, m.type === 'bedrock' ? '基岩版' : m.type === 'java' ? 'Java 版' : '自动'))
    head.appendChild(h('span', { class: 'muted mono' }, `${m.host}:${m.port}`))
    head.appendChild(h('span', { class: 'muted' }, `每 ${m.interval} 秒`))
    head.appendChild(h('span', { class: 'spacer' }))
    head.appendChild(h('span', { class: 'muted' }, m.status?.checkedAt ? '更新于 ' + fmtTime(m.status.checkedAt, s.general.timeFormat === '12h') : '尚未探测'))
    if (!m.status?.ok && m.status?.error) head.appendChild(h('span', { class: 'badge bad' }, m.status.error))

    const metric = curMetric(m)
    syncMetric(metric)
    const st = m.stats || {}
    const status = m.status || {}
    const headBox = metric === 'players'
      ? ['当前在线', status.ok && status.players ? `${status.players.online ?? '-'}/${status.players.max ?? '-'}` : '—', '人', status.ok ? 'ok' : 'bad']
      : metric === 'loss'
        ? ['丢包率', st.loss ?? '—', '%', st.loss > 5 ? 'warn' : 'ok']
        : ['当前延迟', status.ok ? Math.round(status.latency ?? 0) : '—', 'ms', status.ok ? (status.latency > s.monitor.latencyWarn ? 'warn' : 'ok') : 'bad']
    const boxes = [
      headBox,
      ['平均延迟', st.avg ?? '—', 'ms'],
      ['最低 / 最高', st.min != null ? `${Math.round(st.min)} / ${Math.round(st.max)}` : '—', 'ms'],
      ['抖动', st.jitter ?? '—', 'ms'],
      ['在线率（全部）', st.uptime ?? '—', '%'],
      ['在线率（近 60 点）', st.uptimeRecent ?? '—', '%'],
      ['累计探测', st.totalChecks ?? 0, '次']
    ]
    if (metric !== 'loss') boxes.splice(6, 0, ['丢包率', st.loss ?? '—', '%'])
    clear(statsWrap)
    for (const [label, val, unit, kind] of boxes) {
      statsWrap.appendChild(h('div', { class: 'stat-box' }, h('label', {}, label),
        h('b', { class: kind === 'bad' ? 'result-bad' : kind === 'ok' ? 'result-ok' : kind === 'warn' ? 'badge warn' : '' }, String(val), h('small', {}, ' ' + unit))))
    }
    drawChart(m)
    clear(logWrap)
    for (const p of (m.history || []).slice(-50).reverse()) {
      logWrap.appendChild(h('div', {},
        h('span', { class: 't' }, fmtTime(p.t, s.general.timeFormat === '12h')),
        p.ok ? h('span', { class: 'okl' }, `在线 · ${Math.round(p.ms)} ms${p.players != null ? ' · ' + p.players + ' 人' : ''}`) : h('span', { class: 'ko' }, '超时 / 无法连接')))
    }
  }
  render(lastSnapshot)
  const iv = setInterval(() => api.get('/api/monitors').then(render).catch(() => {}), 4000)
  const ro = new ResizeObserver(() => {
    const m = lastSnapshot?.items.find((x) => x.id === id)
    drawChart(m)
  })
  ro.observe(chartWrap)
  const obs = new MutationObserver(() => {
    if (!document.body.contains(chartWrap)) {
      clearInterval(iv)
      ro.disconnect()
      obs.disconnect()
    }
  })
  obs.observe(document.body, { childList: true, subtree: true })
}

// ---------------- 新增 / 编辑 ----------------
function openEditor(existing, isEdit) {
  const s = ctxRef.settings()
  const isBedrock = (existing?.type || s.network.defaultType) === 'bedrock'
  const name = h('input', { class: 'input', placeholder: '留空则使用地址', value: existing?.name || '' })
  const host = h('input', { class: 'input mono', placeholder: 'mc.example.com', value: existing?.host || '' })
  const port = h('input', { class: 'input mono', type: 'number', value: existing?.port || (isBedrock ? s.network.bedrockPort : s.network.javaPort) })
  const type = h('select', { class: 'input' }, h('option', { value: 'auto' }, '自动识别'), h('option', { value: 'java' }, 'Java 版'), h('option', { value: 'bedrock' }, '基岩版'))
  type.value = existing?.type || s.network.defaultType || 'auto'
  const interval = h('input', { class: 'input mono', type: 'number', min: 5, value: existing?.interval || s.monitor.defaultInterval })
  const metric = h('select', { class: 'input' },
    h('option', { value: 'latency' }, '延迟 (ms)'),
    h('option', { value: 'players' }, '在线人数'),
    h('option', { value: 'loss' }, '丢包率'))
  metric.value = METRIC_KEYS.includes(existing?.metric)
    ? existing.metric
    : (METRIC_KEYS.includes(s.monitor.defaultMetric) ? s.monitor.defaultMetric : 'latency')
  const color = h('div', { class: 'color-dots' }, ...PALETTE.map((c) => h('button', {
    class: (existing?.color || PALETTE[(snapshot?.items.length || 0) % PALETTE.length]) === c ? 'active' : '',
    style: { background: c },
    onclick: (e) => {
      Array.from(e.target.parentElement.children).forEach((b) => b.classList.remove('active'))
      e.target.classList.add('active')
    }
  })))

  type.onchange = () => { port.value = type.value === 'bedrock' ? s.network.bedrockPort : s.network.javaPort }

  const form = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    h('div', { class: 'field' }, h('label', {}, '名称'), name),
    h('div', { class: 'row' },
      h('div', { class: 'field grow' }, h('label', {}, '地址'), host),
      h('div', { class: 'field' }, h('label', {}, '端口'), port),
      h('div', { class: 'field' }, h('label', {}, '类型'), type)),
    h('div', { class: 'row' },
      h('div', { class: 'field grow' }, h('label', {}, '轮询间隔（秒）'), interval),
      h('div', { class: 'field' }, h('label', {}, '图表指标'), metric)),
    h('div', { class: 'field' }, h('label', {}, '磁贴颜色'), color)
  )

  const buttons = [
    { label: '取消' },
    {
      label: isEdit ? '保存' : '添加',
      class: 'btn-primary',
      onClick: async (m) => {
        const payload = {
          name: name.value.trim(),
          host: host.value.trim(),
          port: Number(port.value) || undefined,
          type: type.value,
          interval: Number(interval.value) || s.monitor.defaultInterval,
          metric: metric.value,
          color: color.querySelector('.active')?.style.background || null
        }
        if (!payload.host) {
          toast('请填写地址', 'err')
          return
        }
        try {
          if (isEdit) await api.put('/api/monitors/' + existing.id, payload)
          else await api.post('/api/monitors', payload)
          toast(isEdit ? '已保存' : '已添加监测', 'ok')
          m.close()
          refresh(true)
        } catch (e) {
          toast('操作失败：' + e.message, 'err')
        }
      }
    }
  ]
  if (isEdit) {
    buttons.unshift({
      label: '删除',
      class: 'btn-danger',
      onClick: async (m) => {
        const s2 = ctxRef.settings()
        if (s2.general.confirmDanger !== false && !(await confirmDialog(`确定删除监测项「${existing.name}」？历史数据会一并清除。`, { danger: true }))) return
        await api.del('/api/monitors/' + existing.id)
        toast('已删除', 'ok')
        m.close()
        refresh(true)
      }
    })
  }
  openModal({ title: isEdit ? '编辑监测项' : '添加监测服务器', body: form, buttons })
}
