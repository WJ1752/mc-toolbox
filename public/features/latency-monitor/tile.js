// Latency monitor — gauge cards, detail dialog and the expanded bench.
import { h, clear, fmtAgo, fmtTime } from '/js/core/dom.js'
import { api } from '/js/core/api.js'
import { openModal, confirmDialog } from '/js/core/modal.js'
import { toast } from '/js/core/toast.js'
import { TileGrid } from '/js/core/grid.js'
import { drawLatencyChart, drawPlayersChart, drawLossChart, drawSparkByMetric } from '/js/core/chart.js'
import { btn, input, select, seg, field, badge, dot, emptyState } from '/js/ui/kit.js'

const PALETTE = ['#5ec96a', '#3ba0ff', '#c084fc', '#ff8a4c', '#22d3ee', '#eab308', '#f43f5e']
const METRIC_KEYS = ['latency', 'players', 'loss']
const METRIC_LABEL = { latency: '延迟', players: '在线人数', loss: '丢包率' }
const POLL_MS = 4000

let ctxRef = null
let innerGrid = null
let listEl = null
let emptyEl = null
let bulkRow = null
let bulkSeg = null
let metaEl = null
let engineBtn = null
let engineShownRunning = true
let snapshot = null
let timer = null
let offBus = null
let openDetailId = null
let openDetailRefresh = null
let detailDispose = null
const expandedDisposers = new Set()

// Tile widths dragged in this session (monitorId -> { w, h }); not persisted.
const cardSizes = new Map()

const metricOf = (m) => (m?.metric === 'players' || m?.metric === 'loss' ? m.metric : 'latency')
const colorOf = (index) => PALETTE[index % PALETTE.length]

export default {
  async mount(ctx) {
    ctxRef = ctx
    const s = ctx.settings()
    metaEl = h('span', { class: 'mon-summary' }, '')
    engineShownRunning = true
    engineBtn = makeEngineBtn(true)
    const toolbar = h('div', { class: 'mon-toolbar' },
      btn('添加 IP', { variant: 'primary', size: 'sm', iconName: 'add', title: '添加一个监测项', onClick: () => openEditor() }),
      engineBtn,
      btn('刷新', { size: 'sm', iconName: 'refresh', title: '立即刷新监测数据', onClick: () => refresh(true) }),
      h('span', { class: 'spacer' }),
      metaEl
    )

    // One-click metric for every card; hidden while there is nothing to apply it to.
    bulkSeg = seg(METRIC_KEYS.map((k) => [k, METRIC_LABEL[k]]), null, (key) => bulkMetric(key), { title: '全部图表指标' })
    decorateSeg(bulkSeg, METRIC_KEYS, (k) => `把全部磁贴的图表指标改为「${METRIC_LABEL[k]}」`)
    bulkRow = h('div', { class: 'mon-bulk', style: { margin: '2px 0 8px' } },
      h('span', {}, '全部图表指标：'),
      bulkSeg
    )

    listEl = h('div', { class: 'grid mini', style: { gap: '8px' } })
    emptyEl = emptyState('还没有监测项，点击「＋ 添加 IP」开始。', '', btn('添加 IP', { size: 'sm', iconName: 'add', onClick: () => openEditor() }), { iconName: 'pulse' })

    ctx.body.appendChild(toolbar)
    ctx.body.appendChild(bulkRow)
    ctx.body.appendChild(listEl)
    ctx.body.appendChild(emptyEl)

    innerGrid = new TileGrid(listEl, {
      itemSelector: '.mon-card',
      handleSelector: '.mon-gauge-top',
      // Card-shaped drop slot (the shared placeholder class only paints the frame).
      placeholderClass: 'mon-card tile-placeholder',
      animations: s.general.animations,
      onChange: async (ids) => {
        try {
          await api.post('/api/monitors/reorder', { ids })
        } catch (e) {
          toast('排序保存失败：' + e.message, 'err')
        }
      }
    })

    // Other features (server status) can push a pre-filled monitor into the editor.
    offBus = ctx.bus.on('monitor:request-add', (data) => openEditor(data))

    timer = setInterval(() => refresh(), POLL_MS)
    refresh(true)
  },

  unmount() {
    if (timer) clearInterval(timer)
    timer = null
    offBus?.()
    offBus = null
    detailDispose?.()
    detailDispose = null
    for (const dispose of expandedDisposers) dispose()
    expandedDisposers.clear()
    openDetailId = null
    openDetailRefresh = null
    innerGrid?.destroy?.()
    innerGrid = null
    listEl = null
    emptyEl = null
    bulkRow = null
    bulkSeg = null
    metaEl = null
    engineBtn = null
  },

  renderExpanded(container, { ctx } = {}) {
    const c = ctx || ctxRef
    if (!c || !container) return

    const sel = select([], null, { onchange: () => { cur = { id: sel.value }; metricOverride = null; render(latest) }, ariaLabel: '选择服务器' })
    sel.style.width = '220px'
    const metricSeg = seg(METRIC_KEYS.map((k) => [k, METRIC_LABEL[k]]), 'latency', (key) => saveMetric(key), { title: '图表指标' })
    decorateSeg(metricSeg, METRIC_KEYS, (k) => `把当前服务器的图表指标改为「${METRIC_LABEL[k]}」`)

    const head = h('div', { class: 'mon-detail-head' })
    const statsWrap = h('div', { class: 'stat-grid' })
    const canvas = h('canvas')
    const chartWrap = h('div', { class: 'chart-wrap tall' }, canvas)
    const ledger = h('div', { class: 'mon-ledger' })

    const root = h('div', { class: 'col', style: { gap: '12px' } },
      h('div', { class: 'row wrap', style: { gap: '8px' } },
        h('span', {}, '选择服务器：'), sel, metricSeg,
        h('span', { class: 'spacer' }),
        btn('启动', { size: 'sm', iconName: 'play', title: '启动监测引擎', onClick: () => setRunning(true) }),
        btn('暂停', { size: 'sm', iconName: 'pause', title: '暂停监测引擎', onClick: () => setRunning(false) })
      ),
      h('div', { class: 'mon-detail-grid' },
        h('div', { class: 'col', style: { gap: '10px' } }, head, statsWrap, chartWrap),
        h('div', { class: 'col', style: { gap: '6px' } },
          h('div', { class: 'muted' }, '最近记录'),
          ledger
        )
      )
    )
    container.appendChild(root)

    let cur = null
    let latest = null
    // Metric clicked in this view overrides the stored value; reset when switching servers.
    let metricOverride = null
    let disposed = false
    let iv = null
    let ro = null
    let obs = null

    const curMetric = () => {
      const stored = (cur && cur.metric) || 'latency'
      return METRIC_KEYS.includes(metricOverride) ? metricOverride : METRIC_KEYS.includes(stored) ? stored : 'latency'
    }

    function drawChart() {
      const range = Math.max(1, Number(c.settings().monitor?.chartRange) || 120)
      const hist = (cur?.history || []).slice(-range)
      drawMetricChart(canvas, hist, curMetric(), c.settings())
    }

    async function setRunning(run) {
      try {
        await api.post('/api/monitors/engine', { running: run })
        toast(run ? '已启动' : '已暂停', 'ok')
      } catch (e) {
        toast('操作失败：' + e.message, 'err')
      }
    }

    async function saveMetric(key) {
      const id = cur && cur.id
      if (!id) {
        toast('请先选择服务器', 'err')
        return
      }
      setSegDisabled(metricSeg, true)
      try {
        await api.put('/api/monitors/' + id, { metric: key })
        metricOverride = key
        metricSeg.setValue(key)
        render(latest)
        toast(`「${cur.name || id}」图表指标已改为「${METRIC_LABEL[key]}」`, 'ok')
      } catch (e) {
        toast('保存失败：' + e.message, 'err')
        metricSeg.setValue(curMetric())
      } finally {
        setSegDisabled(metricSeg, false)
      }
    }

    function render(snap) {
      if (!snap) return
      latest = snap
      const items = snap.items || []
      const labels = items.map((it) => `${it.name} (${it.host}:${it.port})`)
      const opts = Array.from(sel.options)
      const sameOptions = opts.length === items.length && items.every((it, i) => opts[i].value === it.id && opts[i].textContent === labels[i])
      if (!sameOptions) {
        clear(sel)
        items.forEach((it, i) => sel.appendChild(h('option', { value: it.id }, labels[i])))
      }
      cur = items.find((x) => x.id === (cur && cur.id)) || items[0]
      if (!cur) return
      sel.value = cur.id
      const settings = c.settings()
      const use12h = settings.general.timeFormat === '12h'
      const metric = curMetric()
      metricSeg.setValue(metric)

      clear(head)
      head.append(...detailHeadNodes(cur, settings))

      renderStats(statsWrap, buildStatBoxes(metric, cur.status, cur.stats, settings.monitor.latencyWarn))
      drawChart()
      renderLedger(ledger, cur.history, 40, use12h)
    }

    api.get('/api/monitors').then(render).catch(() => {})
    iv = setInterval(() => api.get('/api/monitors').then(render).catch(() => {}), POLL_MS)
    ro = new ResizeObserver(drawChart)
    ro.observe(chartWrap)

    // The host clears its children when the bench closes; stop polling then.
    function dispose() {
      if (disposed) return
      disposed = true
      expandedDisposers.delete(dispose)
      if (iv) clearInterval(iv)
      ro?.disconnect()
      obs?.disconnect()
      iv = null
      ro = null
      obs = null
    }
    expandedDisposers.add(dispose)
    obs = new MutationObserver(() => {
      if (!root.isConnected) dispose()
    })
    obs.observe(document.body, { childList: true, subtree: true })
  }
}

/* ------------------------------------------------------------------ */
/* tile polling + meta                                                 */
/* ------------------------------------------------------------------ */

async function refresh(force) {
  let snap
  try {
    snap = await api.get('/api/monitors')
  } catch {
    return
  }
  snapshot = snap
  if (!listEl) return

  const items = snap.items || []
  const online = items.filter((x) => x.status?.ok).length
  metaEl.textContent = `${items.length} 台 · ${online} 在线${snap.running ? '' : ' · 已暂停'}`
  syncEngine()
  ctxRef?.setBadge(`${items.length} 台 / ${online} 在线`, snap.running ? 'ok' : '')

  emptyEl.hidden = items.length > 0
  syncBulk(items)

  const wantedIds = items.map((x) => x.id)
  const domIds = innerGrid.order()
  const needRebuild = force || wantedIds.length !== domIds.length || wantedIds.some((id, i) => id !== domIds[i])

  if (needRebuild) {
    for (const id of domIds) if (!wantedIds.includes(id)) innerGrid.remove(id)
    for (const m of items) {
      if (!innerGrid.get(m.id)) {
        const card = buildCard(m, items.indexOf(m))
        innerGrid.mount(card)
        // Redraw once the card has real layout, so the first sparkline is not stretched.
        requestAnimationFrame(() => {
          if (card.isConnected) updateCard(card, m, items.indexOf(m))
        })
      } else {
        updateCard(innerGrid.get(m.id), m, items.indexOf(m))
      }
    }
    innerGrid.setOrder(wantedIds)
  } else {
    items.forEach((m, i) => updateCard(innerGrid.get(m.id), m, i))
  }
  if (openDetailId && openDetailRefresh) openDetailRefresh(snapshot)
  applyTileHeightPolicy()
}

function makeEngineBtn(running) {
  return btn(running ? '暂停' : '继续', {
    size: 'sm',
    iconName: running ? 'pause' : 'play',
    title: running ? '暂停全部监测' : '继续全部监测',
    onClick: toggleEngine
  })
}

function syncEngine() {
  const running = snapshot?.running ?? true
  if (running === engineShownRunning) return
  engineShownRunning = running
  const next = makeEngineBtn(running)
  if (engineBtn?.isConnected) engineBtn.replaceWith(next)
  engineBtn = next
}

async function toggleEngine() {
  const run = !(snapshot?.running ?? true)
  try {
    await api.post('/api/monitors/engine', { running: run })
    toast(run ? '监测已启动' : '监测已暂停', 'ok')
    refresh(true)
  } catch (e) {
    toast('操作失败：' + e.message, 'err')
  }
}

function syncBulk(items) {
  bulkRow.hidden = items.length === 0
  const first = items[0]
  const allSame = items.length > 0 && items.every((m) => metricOf(m) === metricOf(first))
  // null clears the highlight when the cards disagree.
  bulkSeg.setValue(allSame ? metricOf(first) : null)
}

async function bulkMetric(metric) {
  const n = snapshot?.items?.length || 0
  if (!n) {
    toast('还没有监测项', 'err')
    return
  }
  setSegDisabled(bulkSeg, true)
  try {
    const r = await api.post('/api/monitors/metric', { metric })
    toast(`已把 ${r?.updated || n} 台服务器的图表指标改为「${METRIC_LABEL[metric]}」`, 'ok')
    await refresh(true)
  } catch (e) {
    toast('操作失败：' + e.message, 'err')
    syncBulk(snapshot?.items || [])
  } finally {
    setSegDisabled(bulkSeg, false)
  }
}

// Height policy from settings; re-applied after each refresh.
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

/* ------------------------------------------------------------------ */
/* gauge card                                                          */
/* ------------------------------------------------------------------ */

function buildCard(m, index) {
  const dotEl = dot()
  const nameEl = h('span', { class: 'mon-gauge-name' }, m.name)
  const valueEl = h('b', {}, '--')
  const unitEl = h('small', {})
  const captionEl = h('span', { class: 'unit' }, METRIC_LABEL[metricOf(m)])
  const subEl = h('div', { class: 'mon-gauge-sub' })
  const spark = h('canvas', { class: 'spark' })

  const card = h('div', {
    class: 'mon-card gauge',
    dataset: { id: m.id },
    // The card opens the detail dialog; it must not collapse the whole feature tile.
    'data-nocollapse': true,
    onclick: () => {
      if (Date.now() - (innerGrid?.lastDragEnd || 0) < 200) return
      openDetail(m.id)
    }
  },
    h('div', { class: 'mon-gauge-top' }, dotEl, nameEl),
    h('div', { class: 'mon-gauge-value' }, valueEl, unitEl, captionEl),
    subEl,
    spark
  )

  // Bottom-right resize handle; height still follows the tile height policy.
  card.appendChild(h('span', {
    class: 'mon-rz',
    title: '拖动右下角改宽度；高度遵循「磁贴高度策略」设置',
    onclick: (e) => e.stopPropagation(),
    onpointerdown: (e) => {
      e.preventDefault()
      e.stopPropagation()
      startCardResize(card, m.id, e)
    }
  }))

  const saved = cardSizes.get(m.id)
  card.style.width = (saved ? saved.w : 170) + 'px'
  if (saved) card.style.height = saved.h + 'px'
  card.style.borderLeft = `3px solid ${m.color || colorOf(index)}`
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

  // fixed: width only · max: content height capped · auto: free height (94–340px)
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
      card.style.height = hFixed + 'px'
      card.style.maxHeight = ''
    } else if (heightCapped) {
      card.style.height = 'auto'
      card.style.maxHeight = hFixed + 'px'
    } else {
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
    // Redraw the sparkline for the new size.
    requestAnimationFrame(() => {
      const it = snapshot?.items.find((x) => x.id === id)
      if (it) updateCard(card, it, snapshot.items.indexOf(it))
    })
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
}

function updateCard(card, m, index) {
  if (!card) return
  const st = m.status || {}
  const metric = metricOf(m)
  const players = st.players
  const warnAt = ctxRef?.settings().monitor.latencyWarn || 200
  const lossVal = st.loss != null ? st.loss : m.stats && m.stats.loss != null ? m.stats.loss : null

  const dotEl = card.querySelector('.dot')
  if (dotEl) dotEl.className = 'dot ' + (st.checking ? 'loading' : st.ok ? 'ok' : st.offline || !st.ok ? 'bad' : 'warn')

  // Edits to name / address / color show up on the next poll.
  const nameEl = card.querySelector('.mon-gauge-name')
  if (nameEl && nameEl.textContent !== m.name) nameEl.textContent = m.name
  const tip = `${m.name} · ${m.host}:${m.port}`
  if (card.title !== tip) card.title = tip

  const border = `3px solid ${m.color || colorOf(index)}`
  if (card.style.borderLeft !== border) card.style.borderLeft = border

  const valueEl = card.querySelector('.mon-gauge-value b')
  const unitEl = card.querySelector('.mon-gauge-value small')
  const captionEl = card.querySelector('.mon-gauge-value .unit')
  const subEl = card.querySelector('.mon-gauge-sub')
  const spark = card.querySelector('.spark')

  let value = '--'
  let unit = ''
  let kind = ''
  if (!st.ok) {
    value = st.error ? '离线' : '--'
    kind = 'result-bad'
  } else if (metric === 'players') {
    value = players ? `${players.online ?? '-'}/${players.max ?? '-'}` : '--'
    unit = players ? '人' : ''
    kind = 'result-warn'
  } else if (metric === 'loss') {
    value = lossVal != null ? String(Math.round(lossVal)) : '--'
    unit = lossVal != null ? '%' : ''
    kind = lossVal > 5 ? 'result-warn' : ''
  } else {
    value = String(Math.round(st.latency))
    unit = 'ms'
    kind = st.latency > warnAt ? 'result-warn' : ''
  }

  if (valueEl) {
    if (valueEl.textContent !== value) valueEl.textContent = value
    valueEl.className = kind
  }
  if (unitEl && unitEl.textContent !== unit) unitEl.textContent = unit
  if (captionEl && captionEl.textContent !== METRIC_LABEL[metric]) captionEl.textContent = METRIC_LABEL[metric]

  const sub = st.ok
    ? `${players?.online ?? '-'}/${players?.max ?? '-'} 人 · ${Math.round(st.latency)} ms · ${fmtAgo(st.checkedAt)}`
    : st.error || '等待首次探测'
  if (subEl && subEl.textContent !== sub) subEl.textContent = sub

  drawSparkByMetric(spark, m.history || [], metric, m.color || colorOf(index))
}

/* ------------------------------------------------------------------ */
/* detail dialog                                                       */
/* ------------------------------------------------------------------ */

function openDetail(id) {
  const head = h('div', { class: 'mon-detail-head' })
  const statsWrap = h('div', { class: 'stat-grid' })
  const canvas = h('canvas')
  const chartWrap = h('div', { class: 'chart-wrap' }, canvas)
  const ledger = h('div', { class: 'mon-ledger' })

  const metricSeg = seg(METRIC_KEYS.map((k) => [k, METRIC_LABEL[k]]), 'latency', (key) => saveMetric(key), { title: '图表指标' })
  decorateSeg(metricSeg, METRIC_KEYS, (k) => `折线图显示「${METRIC_LABEL[k]}」`)

  const body = h('div', { class: 'col', style: { gap: '12px' } },
    head,
    h('div', { class: 'row wrap', style: { gap: '6px' } },
      h('span', { class: 'muted' }, '图表指标：'), metricSeg,
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted', style: { fontSize: '11px' } }, '作用于本台服务器（磁贴与详情图同步）')
    ),
    h('div', { class: 'mon-detail-grid' },
      h('div', { class: 'col', style: { gap: '10px' } }, statsWrap, chartWrap),
      h('div', { class: 'col', style: { gap: '6px' } },
        h('div', { class: 'muted' }, '最近记录'),
        ledger
      )
    )
  )

  let metricOverride = null
  let latest = null
  let disposed = false
  let iv = null
  let ro = null
  let obs = null

  const modal = openModal({
    title: '监测详情',
    size: 'lg',
    body,
    buttons: [
      { label: '编辑', onClick: () => {
        const item = latest?.items.find((x) => x.id === id) || snapshot?.items.find((x) => x.id === id)
        if (!item) return
        modal.close()
        openEditor(item, true)
      } },
      { label: '立即检测', onClick: async () => {
        try {
          await api.post('/api/monitors/' + id + '/check')
          toast('已触发检测', 'ok')
          refresh(true)
        } catch (e) {
          toast('操作失败：' + e.message, 'err')
        }
      } },
      { label: '关闭', class: 'btn-primary' }
    ],
    onClose: () => dispose()
  })

  openDetailId = id
  openDetailRefresh = render
  detailDispose = dispose

  const curMetric = (m) => {
    const stored = (m && m.metric) || 'latency'
    return METRIC_KEYS.includes(metricOverride) ? metricOverride : METRIC_KEYS.includes(stored) ? stored : 'latency'
  }

  function drawChart(m) {
    drawMetricChart(canvas, m ? m.history || [] : [], curMetric(m), ctxRef.settings())
  }

  async function saveMetric(key) {
    setSegDisabled(metricSeg, true)
    try {
      await api.put('/api/monitors/' + id, { metric: key })
      metricOverride = key
      metricSeg.setValue(key)
      render(latest)
      toast(`折线图图表指标已改为「${METRIC_LABEL[key]}」`, 'ok')
    } catch (e) {
      toast('保存失败：' + e.message, 'err')
      const m = latest?.items.find((x) => x.id === id)
      metricSeg.setValue(m ? curMetric(m) : 'latency')
    } finally {
      setSegDisabled(metricSeg, false)
    }
  }

  function render(snap) {
    const m = (snap || latest)?.items.find((x) => x.id === id)
    if (!m) return
    if (snap) latest = snap
    const s = ctxRef.settings()
    const use12h = s.general.timeFormat === '12h'
    modal.setTitle(`监测详情 · ${m.name}`)

    clear(head)
    head.append(...detailHeadNodes(m, s))

    const metric = curMetric(m)
    metricSeg.setValue(metric)
    renderStats(statsWrap, buildStatBoxes(metric, m.status, m.stats, s.monitor.latencyWarn))
    drawChart(m)
    renderLedger(ledger, m.history, 50, use12h)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    if (iv) clearInterval(iv)
    ro?.disconnect()
    obs?.disconnect()
    iv = null
    ro = null
    obs = null
    if (openDetailId === id) {
      openDetailId = null
      openDetailRefresh = null
    }
    if (detailDispose === dispose) detailDispose = null
  }

  render(snapshot)
  iv = setInterval(() => api.get('/api/monitors').then(render).catch(() => {}), POLL_MS)
  ro = new ResizeObserver(() => {
    const m = latest?.items.find((x) => x.id === id)
    drawChart(m)
  })
  ro.observe(chartWrap)
  obs = new MutationObserver(() => {
    if (!document.body.contains(chartWrap)) dispose()
  })
  obs.observe(document.body, { childList: true, subtree: true })
}

/* ------------------------------------------------------------------ */
/* add / edit                                                          */
/* ------------------------------------------------------------------ */

function openEditor(existing, isEdit) {
  if (!ctxRef) return
  const s = ctxRef.settings()
  const net = s.network || {}
  const mon = s.monitor || {}
  const isBedrock = (existing?.type || net.defaultType) === 'bedrock'

  const nameIn = input({ value: existing?.name || '', placeholder: '留空则使用地址' })
  const hostIn = input({ value: existing?.host || '', placeholder: 'mc.example.com', mono: true })
  const portIn = input({ type: 'number', value: String(existing?.port || (isBedrock ? net.bedrockPort : net.javaPort)), mono: true })
  const typeIn = select([['auto', '自动识别'], ['java', 'Java 版'], ['bedrock', '基岩版']], existing?.type || net.defaultType || 'auto', { ariaLabel: '服务器类型' })
  typeIn.addEventListener('change', () => {
    portIn.value = String(typeIn.value === 'bedrock' ? net.bedrockPort : net.javaPort)
  })
  const intervalIn = input({ type: 'number', min: 5, value: String(existing?.interval || mon.defaultInterval), mono: true })
  const metricDefault = METRIC_KEYS.includes(existing?.metric)
    ? existing.metric
    : METRIC_KEYS.includes(mon.defaultMetric) ? mon.defaultMetric : 'latency'
  const metricIn = select([['latency', '延迟 (ms)'], ['players', '在线人数'], ['loss', '丢包率']], metricDefault, { ariaLabel: '图表指标' })

  const activeColor = existing?.color || PALETTE[(snapshot?.items?.length || 0) % PALETTE.length]
  const colors = h('div', { class: 'color-dots' }, ...PALETTE.map((c) => h('button', {
    type: 'button',
    class: activeColor === c ? 'active' : '',
    style: { background: c },
    title: `使用颜色 ${c}`,
    'aria-label': `使用颜色 ${c}`,
    onclick: (e) => {
      const wrap = e.currentTarget.parentElement
      for (const b of wrap.children) b.classList.remove('active')
      e.currentTarget.classList.add('active')
    }
  })))

  const form = h('div', { class: 'col', style: { gap: '10px' } },
    field('名称', nameIn),
    h('div', { class: 'row' },
      field('地址', hostIn, { class: 'grow' }),
      field('端口', portIn),
      field('类型', typeIn)
    ),
    h('div', { class: 'row' },
      field('轮询间隔（秒）', intervalIn, { class: 'grow' }),
      field('图表指标', metricIn)
    ),
    field('磁贴颜色', colors)
  )

  const buttons = [
    { label: '取消', class: 'btn-ghost' },
    {
      label: isEdit ? '保存' : '添加',
      class: 'btn-primary',
      onClick: async (m) => {
        const payload = {
          name: nameIn.value.trim(),
          host: hostIn.value.trim(),
          port: Number(portIn.value) || undefined,
          type: typeIn.value,
          interval: Number(intervalIn.value) || mon.defaultInterval,
          metric: metricIn.value,
          color: colors.querySelector('.active')?.style.background || null
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
        try {
          await api.del('/api/monitors/' + existing.id)
          toast('已删除', 'ok')
          m.close()
          refresh(true)
        } catch (e) {
          toast('操作失败：' + e.message, 'err')
        }
      }
    })
  }

  openModal({ title: isEdit ? '编辑监测项' : '添加监测服务器', body: form, buttons })
}

/* ------------------------------------------------------------------ */
/* shared pieces                                                       */
/* ------------------------------------------------------------------ */

function detailHeadNodes(m, settings) {
  const use12h = settings.general.timeFormat === '12h'
  const nodes = [
    dot(m.status?.ok ? 'ok' : 'bad'),
    h('strong', {}, m.name),
    badge(m.type === 'bedrock' ? '基岩版' : m.type === 'java' ? 'Java 版' : '自动'),
    h('span', { class: 'muted mono' }, `${m.host}:${m.port}`),
    h('span', { class: 'muted' }, `每 ${m.interval} 秒`),
    h('span', { class: 'spacer' }),
    h('span', { class: 'muted' }, m.status?.checkedAt ? '更新于 ' + fmtTime(m.status.checkedAt, use12h) : '尚未探测')
  ]
  if (!m.status?.ok && m.status?.error) nodes.push(badge(m.status.error, 'bad'))
  return nodes
}

function buildStatBoxes(metric, status, stats, warnAt) {
  const st = stats || {}
  const head = metric === 'players'
    ? ['当前在线', status?.ok && status.players ? `${status.players.online ?? '-'}/${status.players.max ?? '-'}` : '—', '人', status?.ok ? 'ok' : 'bad']
    : metric === 'loss'
      ? ['丢包率', st.loss ?? '—', '%', st.loss > 5 ? 'warn' : 'ok']
      : ['当前延迟', status?.ok ? Math.round(status.latency ?? 0) : '—', 'ms', status?.ok ? (status.latency > warnAt ? 'warn' : 'ok') : 'bad']

  const boxes = [
    head,
    ['平均延迟', st.avg ?? '—', 'ms'],
    ['最低 / 最高', st.min != null ? `${Math.round(st.min)} / ${Math.round(st.max)}` : '—', 'ms'],
    ['抖动', st.jitter ?? '—', 'ms'],
    ['在线率（全部）', st.uptime ?? '—', '%'],
    ['在线率（近 60 点）', st.uptimeRecent ?? '—', '%']
  ]
  if (metric !== 'loss') boxes.push(['丢包率', st.loss ?? '—', '%'])
  boxes.push(['连续失败', st.streakFails ?? 0, '次'], ['累计探测', st.totalChecks ?? 0, '次'])
  return boxes
}

function renderStats(wrap, boxes) {
  clear(wrap)
  for (const [label, value, unit, kind] of boxes) {
    wrap.appendChild(h('div', { class: 'stat-box' },
      h('label', {}, label),
      h('b', { class: kind === 'bad' ? 'result-bad' : kind === 'ok' ? 'result-ok' : kind === 'warn' ? 'result-warn' : '' },
        String(value), h('small', {}, ' ' + unit))
    ))
  }
}

function renderLedger(wrap, history, limit, use12h) {
  clear(wrap)
  for (const p of (history || []).slice(-limit).reverse()) {
    wrap.appendChild(h('div', { class: 'mon-ledger-row ' + (p.ok ? 'ok' : 'ko') },
      h('span', { class: 't' }, fmtTime(p.t, use12h)),
      h('span', { class: 'v' }, p.ok
        ? `在线 · ${Math.round(p.ms)} ms${p.players != null ? ' · ' + p.players + ' 人' : ''}`
        : '超时 / 无法连接')
    ))
  }
}

function drawMetricChart(canvas, history, metric, settings) {
  const hist = history || []
  if (metric === 'players') drawPlayersChart(canvas, hist)
  else if (metric === 'loss') drawLossChart(canvas, hist)
  else drawLatencyChart(canvas, hist, { warnAt: settings?.monitor?.latencyWarn })
}

function decorateSeg(wrap, keys, titleOf) {
  const buttons = Array.from(wrap.querySelectorAll('button'))
  buttons.forEach((b, i) => {
    const key = keys[i]
    if (!key) return
    b.dataset.metric = key
    b.title = titleOf(key)
  })
}

function setSegDisabled(wrap, disabled) {
  for (const b of wrap.querySelectorAll('button')) b.disabled = disabled
}
