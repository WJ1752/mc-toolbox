import { api } from './core/api.js'
import { h, clear, $, debounce, escapeHtml } from './core/dom.js'
import { toast } from './core/toast.js'
import { TileGrid } from './core/grid.js'
import { initSettings } from './core/settings.js'
import { openModal, confirmDialog, isModalOpen } from './core/modal.js'
import { bus } from './core/bus.js'
import { startHeartbeat } from './core/heartbeat.js'
import { icon, featureIcon, FEATURE_ICONS } from './ui/icons.js'
import { btn, iconBtn, errorState, spinner } from './ui/kit.js'
import { openContextMenu } from './ui/contextmenu.js'
import { initCommandPalette, openCommandPalette, closeCommandPalette, isCommandPaletteOpen } from './ui/command.js'
import { openDrawer, closeDrawer, isDrawerOpen } from './ui/drawer.js'

const APP_TITLE = 'Minecraft 工具箱'

const state = {
  settings: null,
  features: [],
  modules: new Map(),
  tiles: new Map(),
  loading: new Set(),
  version: '',
  author: 'Rinkore28',
  bench: null,
  jobs: []
}

const SETTINGS_BY_FEATURE = {
  'server-status': 'network',
  'latency-monitor': 'monitor',
  'client2server': 'c2s',
  'community-download': 'community',
  'server-core': 'servercore',
  'i18n': 'i18n',
  'save-editor': 'data',
  'server-manager': 'features'
}

let grid
let settingsUI
let commandUI
let jobsTimer = null
let engineTimer = null
let railActive = ''

/* ------------------------------------------------------------------ */
/* settings application                                                */
/* ------------------------------------------------------------------ */

function applySettings() {
  const s = state.settings
  if (!s) return
  const cols = Math.max(1, Math.min(4, Number(s.general.tileColumns) || 1))
  document.documentElement.dataset.theme = s.general.theme || 'dark'
  document.documentElement.style.setProperty('--accent', s.general.accent || '#c07a4a')
  document.documentElement.style.setProperty('--tile-cols', String(cols))
  document.body.classList.toggle('no-anim', s.general.animations === false)
  grid?.setAnimations(s.general.animations !== false)
  grid?.relayout?.()
  syncColumnControl(cols)
  updateTileActionLabels()
}

function syncColumnControl(cols) {
  const wrap = document.getElementById('colSegWrap')
  if (!wrap) return
  // At <=1100px the CSS forces a single column; reflect what the grid really uses.
  const computed = Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--tile-cols'), 10)
  const active = Number.isFinite(computed) && computed > 0 ? computed : cols
  for (const b of wrap.querySelectorAll('button')) {
    const on = Number(b.dataset.cols) === active
    b.classList.toggle('active', on)
    b.setAttribute('aria-pressed', String(on))
  }
}

const persistLayout = debounce(async () => {
  if (!state.settings) return
  const layout = grid.order().map((id) => {
    const t = state.tiles.get(id)
    return { id, w: t?.w || 1, h: t?.h || 1, collapsed: !!t?.collapsed }
  })
  state.settings.layout = layout
  try {
    await api.put('/api/settings', { layout })
  } catch (e) {
    console.warn('布局保存失败', e)
  }
}, 400)

/* ------------------------------------------------------------------ */
/* tiles                                                               */
/* ------------------------------------------------------------------ */

function tileSize(feature) {
  const columns = Math.max(1, Number(state.settings.general?.tileColumns) || 1)
  const saved = (state.settings.layout || []).find((l) => l.id === feature.id)
  const fallback = {
    w: feature.size?.w || 1,
    h: feature.size?.h || 1,
    collapsed: state.settings.general?.defaultCollapsed !== false
  }
  if (!saved) return { ...fallback, w: columns > 1 ? 1 : fallback.w }
  return {
    w: columns > 1 ? 1 : (saved.w || 1),
    h: saved.h || 1,
    collapsed: saved.collapsed === undefined ? fallback.collapsed : !!saved.collapsed
  }
}

function applyCollapse(tile) {
  tile.el.classList.toggle('collapsed', tile.collapsed)
  tile.el.dataset.collapsed = String(tile.collapsed)
  const chev = tile.chev
  if (chev) {
    chev.title = tile.collapsed ? '展开内容' : '折叠为仅标题'
    chev.setAttribute('aria-label', tile.collapsed ? '展开内容' : '折叠为仅标题')
    chev.setAttribute('aria-expanded', String(!tile.collapsed))
  }
  tile.el.classList.remove('h-2')
  grid?._scheduleLayout?.()
}

function toggleCollapse(id) {
  const tile = state.tiles.get(id)
  if (!tile) return
  const wasCollapsed = tile.collapsed
  tile.collapsed = !tile.collapsed
  applyCollapse(tile)
  if (wasCollapsed && !tile.collapsed) ensureMounted(id)
  persistLayout()
  updateCollapseBtn()
}

function updateCollapseBtn() {
  const btnEl = document.getElementById('btnCollapseAll')
  if (!btnEl) return
  const tiles = Array.from(state.tiles.values())
  const allCollapsed = tiles.length > 0 && tiles.every((t) => t.collapsed)
  btnEl.textContent = allCollapsed ? '全部展开' : '全部折叠'
  btnEl.disabled = tiles.length === 0
}

function updateTileActionLabels() {
  // reserved for future per-tile labels; keeps aria state in sync after settings change
}

function updateWorkspaceMeta() {
  const count = state.tiles.size
  const wsCount = document.getElementById('wsCount')
  if (wsCount) wsCount.textContent = count ? `${count} / ${state.features.filter((f) => f.enabled && f.visible).length}` : ''
  const empty = document.getElementById('emptyHint')
  if (empty) empty.hidden = count > 0
  updateCollapseBtn()
}

function setAllCollapsed(v) {
  for (const tile of state.tiles.values()) {
    const wasCollapsed = tile.collapsed
    tile.collapsed = v
    applyCollapse(tile)
    if (wasCollapsed && !v) ensureMounted(tile.el.dataset.id)
  }
  persistLayout()
  updateCollapseBtn()
}

function createTile(feature) {
  const size = tileSize(feature)
  const iconEl = h('span', { class: 'tile-icon', 'aria-hidden': 'true' })
  iconEl.appendChild(featureIcon(feature, { size: 16 }))
  const title = h('h3', { class: 'tile-title' }, feature.name)
  const summary = h('span', { class: 'tile-summary', title: feature.desc || '' }, feature.desc || '')
  const badge = h('span', { class: 'badge', hidden: true })
  const body = h('div', { class: 'tile-body' })
  const spacer = h('span', { class: 'spacer' })

  const chev = h('button', {
    class: 'icobtn tile-chev',
    type: 'button',
    title: '展开或折叠内容',
    'aria-label': '展开或折叠内容',
    onclick: (e) => { e.stopPropagation(); toggleCollapse(feature.id) }
  }, icon('chevron-down', { size: 14 }))

  const btnExpand = h('button', {
    class: 'icobtn',
    type: 'button',
    title: '放大查看',
    'aria-label': '放大查看',
    onclick: (e) => { e.stopPropagation(); expandTile(feature.id) }
  }, icon('expand', { size: 14 }))

  const btnMore = h('button', {
    class: 'icobtn',
    type: 'button',
    title: '更多操作',
    'aria-label': '更多操作',
    onclick: (e) => { e.stopPropagation(); tileMenu(e, feature.id) }
  }, icon('more', { size: 15 }))

  const el = h('section', { class: 'tile', dataset: { id: feature.id } },
    h('header', { class: 'tile-head' },
      iconEl,
      title,
      summary,
      badge,
      spacer,
      h('div', { class: 'tile-actions' }, btnExpand, btnMore),
      chev
    ),
    body
  )
  el.style.setProperty('--tile-color', feature.color || '#c07a4a')

  el.addEventListener('click', (e) => {
    // Only the header toggles the tile; content controls must never collapse it.
    if (!e.target.closest('.tile-head')) return
    if (e.target.closest('button, input, select, textarea, a, label, summary, pre, .drop-zone, [role=button], [data-nocollapse]')) return
    if (grid?.lastDragEnd && Date.now() - grid.lastDragEnd < 280) return
    toggleCollapse(feature.id)
  })

  const tile = {
    el,
    body,
    badge,
    chev,
    iconEl,
    w: size.w,
    h: size.h,
    collapsed: !!size.collapsed,
    mounted: false,
    mounting: false,
    loadError: null
  }
  applyCollapse(tile)
  return tile
}

function makeContext(feature, tile) {
  return {
    feature,
    el: tile.el,
    body: tile.body,
    bus,
    api,
    toast,
    confirm: (msg, opts) => (state.settings.general.confirmDanger === false ? Promise.resolve(true) : confirmDialog(msg, opts)),
    openModal,
    settings: () => state.settings,
    getSettings: () => state.settings,
    escapeHtml,
    setBadge(text, kind = '') {
      if (!text) {
        tile.badge.hidden = true
        tile.badge.textContent = ''
        setRailState(feature.id, '')
        return
      }
      tile.badge.hidden = false
      tile.badge.className = 'badge ' + (kind || '')
      tile.badge.textContent = text
      setRailState(feature.id, kind === 'ok' ? 'ok' : kind === 'bad' ? 'bad' : kind ? 'warn' : '')
    },
    expand(renderFn, opts = {}) {
      const container = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } })
      const modal = openModal({ title: feature.name, size: opts.size || 'lg', body: container })
      try {
        renderFn?.(container, { close: modal.close, ctx: makeContext(feature, tile) })
      } catch (e) {
        container.appendChild(h('div', { class: 'result-bad' }, '渲染失败：' + e.message))
      }
      return modal
    },
    // new capability: features may request the full-screen bench
    openBench: () => expandTile(feature.id)
  }
}

function showMountError(tile, feature, e, retry) {
  tile.loadError = e
  clear(tile.body)
  tile.body.appendChild(errorState(
    '功能加载失败',
    e?.message || String(e),
    btn('重试', { size: 'sm', iconName: 'refresh', onClick: retry })
  ))
  tile.body.style.display = ''
  if (tile.collapsed) {
    tile.collapsed = false
    applyCollapse(tile)
  }
}

async function ensureMounted(id) {
  const tile = state.tiles.get(id)
  if (!tile || tile.mounted || tile.mounting) return
  const feature = state.features.find((f) => f.id === id)
  tile.mounting = true
  const mod = state.modules.get(id)
  if (!mod) {
    tile.mounting = false
    return
  }
  if (!tile.ctx) tile.ctx = makeContext(feature, tile)
  if (tile.loadError) {
    clear(tile.body)
    tile.loadError = null
  }
  if (mod.mount) {
    try {
      await mod.mount(tile.ctx)
      tile.mounted = true
    } catch (e) {
      console.error('[feature] mount 失败', id, e)
      showMountError(tile, feature, e, () => {
        tile.mounted = false
        tile.loadError = null
        clear(tile.body)
        ensureMounted(id)
      })
    } finally {
      tile.mounting = false
    }
  } else {
    tile.mounted = true
    tile.mounting = false
  }
  grid?._scheduleLayout?.()
}

async function mountFeature(feature, beforeId) {
  if (state.tiles.has(feature.id) || state.loading.has(feature.id)) return state.tiles.get(feature.id)
  state.loading.add(feature.id)
  const tile = createTile(feature)
  state.tiles.set(feature.id, tile)
  grid.mount(tile.el, beforeId)
  updateWorkspaceMeta()

  try {
    const mod = await import(`/features/${feature.dir}/${feature.entry}`)
    const module = mod.default || mod
    state.modules.set(feature.id, module)
    tile.ctx = makeContext(feature, tile)
    if (!tile.collapsed) {
      await ensureMounted(feature.id)
    }
  } catch (e) {
    console.error('[feature] 加载失败', feature.id, e)
    showMountError(tile, feature, e, async () => {
      try {
        const mod = await import(`/features/${feature.dir}/${feature.entry}?r=${Date.now()}`)
        state.modules.set(feature.id, mod.default || mod)
        tile.ctx = makeContext(feature, tile)
        tile.mounted = false
        tile.loadError = null
        clear(tile.body)
        await ensureMounted(feature.id)
      } catch (err) {
        showMountError(tile, feature, err, () => location.reload())
      }
    })
  } finally {
    state.loading.delete(feature.id)
  }
  updateWorkspaceMeta()
  return tile
}

function unmountTile(id) {
  const tile = state.tiles.get(id)
  if (!tile) return
  try {
    state.modules.get(id)?.unmount?.()
  } catch (e) {
    console.warn('[feature] unmount 失败', id, e)
  }
  grid.remove(id)
  state.tiles.delete(id)
  state.modules.delete(id)
  updateWorkspaceMeta()
}

function tileMenu(e, id) {
  const feature = state.features.find((f) => f.id === id)
  const tile = state.tiles.get(id)
  if (!feature || !tile) return
  const r = e.currentTarget?.getBoundingClientRect?.() || e.target.getBoundingClientRect()
  const items = [
    {
      label: tile.collapsed ? '展开内容' : '折叠为仅标题',
      iconName: tile.collapsed ? 'expand' : 'collapse',
      onClick: () => toggleCollapse(id)
    },
    { separator: true },
    { label: '放大查看', iconName: 'expand', onClick: () => expandTile(id) },
    { label: '隐藏此磁贴', iconName: 'eye-off', hint: '设置中恢复', onClick: () => hideTile(id) },
    { label: '打开此功能设置', iconName: 'settings', onClick: () => settingsUI.open(SETTINGS_BY_FEATURE[id] || 'features') }
  ]
  if (!feature.builtin) {
    items.push({ separator: true })
    items.push({ label: '删除此功能', iconName: 'trash', danger: true, onClick: () => removeFeature(id) })
  }
  openContextMenu({ x: r.right - 6, y: r.bottom + 4, items, label: feature.name })
}

async function hideTile(id) {
  const feature = state.features.find((f) => f.id === id)
  try {
    await api.put('/api/features/' + id, { visible: false })
    if (feature) feature.visible = false
    unmountTile(id)
    buildRail()
    persistLayout()
    toast('已隐藏磁贴，可在设置中恢复', 'ok')
  } catch (e) {
    toast('隐藏失败：' + e.message, 'err')
  }
}

async function removeFeature(id) {
  const feature = state.features.find((f) => f.id === id)
  if (!(await confirmDialog(`确定删除功能「${feature?.name || id}」？文件夹会被移动到 features_disabled。`, { danger: true }))) return
  try {
    await api.del('/api/features/' + id)
    unmountTile(id)
    state.features = state.features.filter((x) => x.id !== id)
    buildRail()
    persistLayout()
    toast('功能已删除', 'ok')
  } catch (e) {
    toast('删除失败：' + e.message, 'err')
  }
}

/* ------------------------------------------------------------------ */
/* rail                                                                */
/* ------------------------------------------------------------------ */

function setRailState(id, kind) {
  const railBtn = document.querySelector(`#railFeatures [data-rail-id="${id}"]`)
  if (!railBtn) return
  railBtn.dataset.state = kind || 'off'
}

function buildRail() {
  const wrap = document.getElementById('railFeatures')
  if (!wrap) return
  clear(wrap)
  for (const f of state.features.filter((x) => x.enabled)) {
    const b = h('button', {
      class: 'rail-btn',
      type: 'button',
      title: `${f.name}${f.desc ? ' · ' + f.desc : ''}`,
      'aria-label': f.name,
      dataset: { railId: f.id, state: state.tiles.has(f.id) ? 'off' : 'off' }
    }, featureIcon(f, { size: 18 }))
    b.addEventListener('click', () => navigateFeature(f.id))
    wrap.appendChild(b)
  }
  markRail(railActive)
}

function markRail(id) {
  railActive = id || ''
  for (const b of document.querySelectorAll('#railFeatures .rail-btn, #btnWorkspace')) {
    b.classList.toggle('active', b.id === 'btnWorkspace' ? !railActive : b.dataset.railId === railActive)
  }
}

function navigateFeature(id) {
  const feature = state.features.find((f) => f.id === id)
  if (!feature) return
  let tile = state.tiles.get(id)
  if (!tile) {
    if (!feature.enabled) {
      toast('该功能已在设置中禁用，请先启用', 'warn')
      return
    }
    addFeature(feature, { silent: true }).then(() => {
      tile = state.tiles.get(id)
      if (tile) flashTile(tile)
    })
    markRail(id)
    return
  }
  markRail(id)
  closeSettingsPage()
  flashTile(tile)
}

function flashTile(tile) {
  tile.el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  tile.el.classList.remove('is-flash')
  void tile.el.offsetWidth
  tile.el.classList.add('is-flash')
  setTimeout(() => tile.el.classList.remove('is-flash'), 1400)
}

/* ------------------------------------------------------------------ */
/* add / sync                                                          */
/* ------------------------------------------------------------------ */

async function addFeature(feature, { silent = false } = {}) {
  if (!feature) return null
  try {
    await api.put('/api/features/' + feature.id, { visible: true, enabled: true })
    feature.visible = true
    feature.enabled = true
    const tile = await mountFeature(feature)
    persistLayout()
    buildRail()
    if (!silent) toast(`已添加「${feature.name}」`, 'ok')
    return tile
  } catch (e) {
    toast('添加失败：' + e.message, 'err')
    return null
  }
}

function openAddTile() {
  const available = state.features.filter((f) => f.enabled && !state.tiles.has(f.id))
  const box = h('div', { class: 'col', style: { gap: '6px' } })
  if (!available.length) {
    box.appendChild(h('div', { class: 'empty-state' },
      icon('check-circle', { size: 20 }),
      h('div', { class: 'es-title' }, '没有可添加的功能'),
      h('div', { class: 'es-text' }, '所有功能都已在页面上，或已在设置中禁用。')
    ))
  }
  for (const f of available) {
    box.appendChild(h('div', { class: 'feature-item' },
      h('div', { class: 'fi-icon', style: { background: f.color || 'var(--surface-3)' } }, featureIcon(f, { size: 16 })),
      h('div', { class: 'fi-main' }, h('b', {}, f.name), h('span', {}, f.desc || '')),
      btn('添加', {
        variant: 'primary',
        size: 'sm',
        onClick: async () => {
          const tile = await addFeature(f)
          if (tile) modal.close()
        }
      })
    ))
  }
  const modal = openModal({ title: '添加磁贴', size: 'md', body: box, buttons: [{ label: '关闭', class: 'btn-ghost' }] })
}

async function syncTiles() {
  const wanted = state.features.filter((f) => f.enabled && f.visible)
  const wantedIds = new Set(wanted.map((f) => f.id))
  for (const id of Array.from(state.tiles.keys())) {
    if (!wantedIds.has(id)) unmountTile(id)
  }
  const order = (state.settings.layout || []).map((l) => l.id).filter((id) => wantedIds.has(id))
  for (const f of wanted) if (!order.includes(f.id)) order.push(f.id)
  for (const id of order) {
    const f = wanted.find((x) => x.id === id)
    if (f && !state.tiles.has(id)) await mountFeature(f, null)
  }
  const existing = grid.order()
  const sorted = order.filter((id) => existing.includes(id))
  for (const id of existing) if (!sorted.includes(id)) sorted.push(id)
  if (sorted.length) grid.setOrder(sorted)
  updateWorkspaceMeta()
  buildRail()
}

/* ------------------------------------------------------------------ */
/* bench (expanded tile)                                               */
/* ------------------------------------------------------------------ */

async function expandTile(id) {
  const feature = state.features.find((f) => f.id === id)
  const tile = state.tiles.get(id)
  if (!feature || !tile) return
  if (settingsUI?.isOpen()) closeSettingsPage()
  closeContextMenuSafe()
  const view = document.getElementById('benchView')
  const benchInner = document.getElementById('benchInner')
  const title = document.getElementById('benchTitle')
  const iconWrap = document.getElementById('benchIcon')
  const benchBadge = document.getElementById('benchBadge')
  const benchNav = document.getElementById('benchNav')
  const benchSettings = document.getElementById('benchSettings')
  if (!view || !benchInner) return
  view.hidden = false
  document.body.classList.add('bench-open')
  clear(benchInner)
  clear(benchNav)
  title.textContent = feature.name
  iconWrap.style.setProperty('--tile-color', feature.color || 'var(--copper)')
  clear(iconWrap)
  iconWrap.appendChild(featureIcon(feature, { size: 18 }))
  benchBadge.hidden = true
  benchBadge.textContent = ''
  benchSettings.onclick = () => settingsUI.open(SETTINGS_BY_FEATURE[id] || 'features')

  const close = () => closeBench()
  state.bench = { id, close }

  const loading = h('div', { class: 'row', style: { gap: '8px', color: 'var(--mute)', padding: '10px 0' } }, spinner(14), '正在准备视图…')
  benchInner.appendChild(loading)
  await ensureMounted(id)
  clear(benchInner)

  const mod = state.modules.get(id)
  if (mod?.renderExpanded) {
    try {
      mod.renderExpanded(benchInner, { close, ctx: tile.ctx })
    } catch (e) {
      console.error('[feature] renderExpanded 失败', id, e)
      benchInner.appendChild(errorState('渲染失败', e.message || String(e)))
    }
  } else {
    benchInner.appendChild(h('div', { class: 'fx-note', style: { marginBottom: '10px' } },
      '该功能未提供展开视图，以下为磁贴内容放大显示。'))
    const cloneWrap = h('div', { class: 'col', style: { gap: '10px' } })
    benchInner.appendChild(cloneWrap)
    const cloneCtx = makeContext(feature, { el: tile.el, body: cloneWrap, badge: tile.badge, ctx: tile.ctx })
    try {
      mod?.mount?.(cloneCtx)
    } catch (e) {
      cloneWrap.appendChild(h('div', { class: 'result-bad' }, e.message))
    }
  }
}

function closeBench() {
  const view = document.getElementById('benchView')
  if (!view || view.hidden) return
  view.hidden = true
  document.body.classList.remove('bench-open')
  const inner = document.getElementById('benchInner')
  if (inner) clear(inner)
  state.bench = null
}

function closeContextMenuSafe() {
  const root = document.getElementById('contextRoot')
  if (root) root.hidden = true
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function openSettingsPage(id) {
  closeBench()
  settingsUI.open(id)
}

function closeSettingsPage() {
  if (settingsUI?.isOpen()) settingsUI.close()
}

function initSettingsUI() {
  settingsUI = initSettings({
    getSettings: () => state.settings,
    onSaved: (s, meta = {}) => {
      state.settings = s
      applySettings()
      bus.emit('settings:changed', s)
      if (meta.silent !== true) flashSaved()
    },
    onAnimationsChange: (v) => grid.setAnimations(v),
    onReload: async () => {
      const data = await api.get('/api/features')
      state.features = data.items
      await syncTiles()
    },
    onFeatureToggle: async (id, visible) => {
      const f = state.features.find((x) => x.id === id)
      if (f) f.visible = visible
      if (visible && !state.tiles.has(id)) await mountFeature(f)
      else if (!visible) unmountTile(id)
      persistLayout()
      buildRail()
    },
    onResetLayout: async () => {
      await api.put('/api/settings', { layout: [] })
      state.settings.layout = []
      for (const id of Array.from(state.tiles.keys())) unmountTile(id)
      await syncTiles()
      toast('布局已重置', 'ok')
    },
    openAddTile,
    onFeaturesChanged: async () => {
      const data = await api.get('/api/features')
      state.features = data.items
      await syncTiles()
    }
  })
}

const flashSaved = debounce(() => {
  const el = document.getElementById('settingsSaveState')
  if (!el) return
  el.textContent = '已保存 · ' + new Date().toLocaleTimeString()
}, 80)

/* ------------------------------------------------------------------ */
/* statusbar: engine + tasks                                           */
/* ------------------------------------------------------------------ */

async function refreshEngineStatus() {
  const dotEl = document.getElementById('sbEngineDot')
  const textEl = document.getElementById('sbEngineText')
  if (!dotEl || !textEl) return
  try {
    const snap = await api.get('/api/monitors')
    const online = (snap.items || []).filter((x) => x.status?.ok).length
    if (snap.running) {
      dotEl.className = 'dot ok'
      textEl.textContent = `${snap.items.length} 台 · ${online} 在线`
    } else {
      dotEl.className = 'dot'
      textEl.textContent = '已暂停'
    }
  } catch {
    dotEl.className = 'dot bad'
    textEl.textContent = '不可用'
  }
}

function jobStatusLabel(job) {
  return {
    queued: '排队中',
    running: '下载中',
    installing: '安装中',
    done: '已完成',
    failed: '失败',
    cancelled: '已取消',
    cancelling: '正在取消'
  }[job.status] || job.status
}

function jobMeta(job) {
  if (job.status === 'running') {
    const pct = job.total ? Math.round((job.received / job.total) * 100) : 0
    const speed = job.speed ? ` · ${fmtSpeed(job.speed)}` : ''
    return `${pct}% · ${formatBytes(job.received)} / ${job.total ? formatBytes(job.total) : '?'}${speed}`
  }
  if (job.status === 'installing') return job.installProgress != null ? `安装 ${Math.round(job.installProgress)}%` : '安装中…'
  if (job.status === 'done') return `已完成 · ${formatBytes(job.total || job.received)}`
  if (job.status === 'failed') return job.error || '失败'
  return jobStatusLabel(job)
}

function formatBytes(n) {
  if (!n && n !== 0) return '-'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

function fmtSpeed(bps) {
  if (!bps || bps <= 0) return ''
  if (bps >= 1024 * 1024) return (bps / 1024 / 1024).toFixed(1) + ' MB/s'
  if (bps >= 1024) return (bps / 1024).toFixed(1) + ' KB/s'
  return Math.round(bps) + ' B/s'
}

function activeJobs() {
  return state.jobs.filter((j) => ['queued', 'running', 'installing'].includes(j.status))
}

async function refreshJobs() {
  try {
    const data = await api.get('/api/community/jobs')
    state.jobs = data.items || []
  } catch {
    return
  }
  const n = activeJobs().length
  const text = document.getElementById('sbTaskText')
  if (text) text.textContent = n ? `任务 ${n} 进行中` : '任务 0'
  if (isDrawerOpen()) renderTaskDrawer(document.getElementById('drawerBody'))
}

async function cancelJob(id) {
  try {
    await api.post('/api/community/jobs/cancel', { id })
    toast('已请求取消任务', 'ok')
    await refreshJobs()
  } catch (e) {
    toast('取消失败：' + e.message, 'err')
  }
}

async function retryJob(job) {
  if (!job?.url) {
    toast('该任务缺少下载地址，无法重试', 'err')
    return
  }
  try {
    await api.post('/api/community/download', {
      url: job.url,
      filename: job.filename,
      dir: job.dir,
      title: job.meta?.project || job.filename,
      meta: job.meta || {}
    })
    toast('已重新加入下载队列', 'ok')
    await refreshJobs()
  } catch (e) {
    toast('重试失败：' + e.message, 'err')
  }
}

async function clearAllJobs() {
  if (!(await confirmDialog('确定取消所有下载任务并清空记录？已下载的文件不会被删除。', { danger: true }))) return
  try {
    await api.del('/api/community/jobs')
    toast('已清空下载记录', 'ok')
    await refreshJobs()
  } catch (e) {
    toast('清空失败：' + e.message, 'err')
  }
}

function jobRow(job) {
  const pct = job.total ? Math.min(100, Math.round((job.received / job.total) * 100)) : 0
  const installing = job.status === 'installing'
  const barPct = installing ? job.installProgress : pct
  const fill = h('i', { style: (barPct == null ? {} : { width: barPct + '%' }) })
  const bar = h('div', { class: 'bar' + (barPct == null ? ' indeterminate' : '') + ' j-bar' }, fill)
  const actions = h('div', { class: 'j-actions' })
  if (['queued', 'running'].includes(job.status)) {
    actions.appendChild(btn('取消', { size: 'xs', variant: 'danger', onClick: () => cancelJob(job.id) }))
  } else if (job.status === 'failed' && job.url) {
    actions.appendChild(btn('重试', { size: 'xs', onClick: () => retryJob(job) }))
  }
  if (job.dir) {
    actions.appendChild(btn('打开', { size: 'xs', onClick: async () => {
      try { await api.post('/api/fs/open', { path: job.dir }) } catch (e) { toast('打开失败：' + e.message, 'err') }
    } }))
  }
  const kind = job.status === 'done' ? 'ok' : job.status === 'failed' ? 'bad' : ['running', 'installing', 'queued'].includes(job.status) ? 'warn' : ''
  return h('div', { class: 'job' },
    h('span', { class: 'dot ' + kind, title: jobStatusLabel(job) }),
    h('div', { class: 'j-main' },
      h('div', { class: 'j-title', title: job.filename }, job.filename),
      h('div', { class: 'j-meta' }, jobMeta(job)),
      bar,
      job.error ? h('div', { class: 'j-error' }, job.error) : null
    ),
    actions
  )
}

function renderTaskDrawer(bodyEl) {
  if (!bodyEl) return
  clear(bodyEl)
  const items = state.jobs
  const running = items.filter((j) => ['queued', 'running', 'installing'].includes(j.status))
  const finished = items.filter((j) => !['queued', 'running', 'installing'].includes(j.status))
  const count = document.getElementById('drawerCount')
  if (count) { count.textContent = String(running.length); count.hidden = running.length === 0 }
  if (!items.length) {
    bodyEl.appendChild(h('div', { class: 'empty-state' },
      icon('download', { size: 22 }),
      h('div', { class: 'es-title' }, '没有任务'),
      h('div', { class: 'es-text' }, '社区资源下载、服务端核心下载与整合包转换的任务会显示在这里。')
    ))
    return
  }
  const groups = [
    ['进行中', running],
    ['已结束', finished.slice(0, 40)]
  ]
  for (const [label, list] of groups) {
    if (!list.length) continue
    bodyEl.appendChild(h('div', { class: 'overline', style: { padding: '4px 2px' } }, `${label} · ${list.length}`))
    for (const job of list) bodyEl.appendChild(jobRow(job))
  }
}

function openTaskDrawer() {
  openDrawer({
    title: '任务',
    width: 430,
    render: (body) => renderTaskDrawer(body),
    footer: h('div', { class: 'row', style: { width: '100%', justifyContent: 'space-between' } },
      btn('刷新', { size: 'sm', iconName: 'refresh', onClick: refreshJobs }),
      btn('清空记录', { size: 'sm', variant: 'danger', onClick: clearAllJobs })
    )
  })
  refreshJobs()
}

/* ------------------------------------------------------------------ */
/* command palette                                                     */
/* ------------------------------------------------------------------ */

function commandItems() {
  const items = []
  for (const f of state.features.filter((x) => x.enabled)) {
    items.push({
      group: '功能',
      label: f.name,
      hint: state.tiles.has(f.id) ? '定位' : '添加',
      iconName: FEATURE_ICONS[f.id] || 'puzzle',
      keywords: f.desc + ' ' + f.id,
      run: () => navigateFeature(f.id)
    })
  }
  items.push(
    { group: '动作', label: '添加磁贴', hint: '', iconName: 'add', run: openAddTile },
    { group: '动作', label: '全部折叠', hint: '', iconName: 'collapse', run: () => setAllCollapsed(true) },
    { group: '动作', label: '全部展开', hint: '', iconName: 'expand', run: () => setAllCollapsed(false) },
    { group: '动作', label: '重新加载功能', hint: '', iconName: 'refresh', run: reloadFeatures },
    { group: '动作', label: '打开设置', hint: '', iconName: 'settings', run: () => settingsUI.open('general') },
    { group: '动作', label: '打开任务抽屉', hint: '', iconName: 'download', run: openTaskDrawer },
    { group: '动作', label: '清空任务记录', hint: '', iconName: 'trash', run: clearAllJobs },
    { group: '动作', label: '隐藏所有折叠磁贴', hint: '', iconName: 'eye-off', run: async () => {
      const collapsed = Array.from(state.tiles.values()).filter((t) => t.collapsed)
      for (const t of collapsed) await hideTile(t.el.dataset.id)
    } }
  )
  const sections = settingsUI?.sections?.() || []
  for (const s of sections) {
    items.push({ group: '设置', label: s.label, hint: s.desc || '', iconName: s.iconName, run: () => settingsUI.open(s.id) })
  }
  return items
}

async function reloadFeatures() {
  try {
    const data = await api.get('/api/features')
    state.features = data.items
    await syncTiles()
    toast('已重新加载功能', 'ok')
  } catch (e) {
    toast('重载失败：' + e.message, 'err')
  }
}

/* ------------------------------------------------------------------ */
/* window chrome (WebView2 frameless host)                             */
/* ------------------------------------------------------------------ */

function initNativeChrome() {
  const wv = window.chrome && window.chrome.webview
  if (!wv) return
  document.body.classList.add('nv')
  const wc = document.getElementById('winControls')
  if (wc) {
    wc.hidden = false
    const maxBtn = wc.querySelector('[data-act="max"]')
    wv.addEventListener?.('message', (ev) => {
      const m = ev.data
      if (m === 'wm 1') maxBtn?.classList.add('maximized')
      else if (m === 'wm 0') maxBtn?.classList.remove('maximized')
    })
    wc.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const act = b.dataset.act
        if (act === 'min' || act === 'close') {
          try { wv.postMessage(act) } catch {}
        } else if (act === 'max') {
          try { wv.postMessage('max') } catch {}
          b.classList.toggle('maximized')
        }
      }
    })
  }
  const bar = document.querySelector('header.titlebar')
  if (!bar) return
  const interactive = (t) => !!t.closest('button, a, input, select, textarea, label, .win-controls, .titlebar-right')

  const RZ = { n: 12, s: 15, e: 11, w: 10, nw: 13, ne: 14, sw: 16, se: 17 }
  const rzLayer = h('div', { class: 'rsz-layer' })
  for (const pos of Object.keys(RZ)) {
    const zone = h('div', { class: 'rsz rsz-' + pos })
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      try { wv.postMessage('rsz ' + RZ[pos]) } catch {}
    })
    rzLayer.appendChild(zone)
  }
  document.body.appendChild(rzLayer)

  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || interactive(e.target)) return
    try { wv.postMessage('cap') } catch {}
  })
  bar.addEventListener('dblclick', (e) => {
    if (interactive(e.target)) return
    try { wv.postMessage('max') } catch {}
  })
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

function bindToolbar() {
  const addBtn = document.getElementById('btnAddTile')
  if (addBtn) {
    clear(addBtn)
    addBtn.append(icon('add', { size: 13 }), h('span', {}, '添加磁贴'))
    addBtn.onclick = openAddTile
  }
  const emptyAdd = document.getElementById('btnEmptyAdd')
  if (emptyAdd) emptyAdd.onclick = openAddTile
  const reload = document.getElementById('btnReload')
  if (reload) {
    clear(reload)
    reload.append(icon('refresh', { size: 13 }), h('span', {}, '重载'))
    reload.onclick = reloadFeatures
  }
  const settingsBtn = document.getElementById('btnSettings')
  if (settingsBtn) {
    clear(settingsBtn)
    settingsBtn.appendChild(icon('settings', { size: 18 }))
    settingsBtn.onclick = () => openSettingsPage('general')
  }
  const railAdd = document.getElementById('btnRailAdd')
  if (railAdd) {
    clear(railAdd)
    railAdd.appendChild(icon('add', { size: 18 }))
    railAdd.onclick = openAddTile
  }
  const wsBtn = document.getElementById('btnWorkspace')
  if (wsBtn) {
    clear(wsBtn)
    wsBtn.appendChild(icon('workspace', { size: 18 }))
    wsBtn.onclick = () => {
      markRail('')
      closeSettingsPage()
      document.getElementById('workspace').scrollTo({ top: 0, behavior: 'smooth' })
    }
  }
  const collapseBtn = document.getElementById('btnCollapseAll')
  if (collapseBtn) {
    collapseBtn.onclick = () => {
      const tiles = Array.from(state.tiles.values())
      setAllCollapsed(!tiles.every((t) => t.collapsed))
    }
  }
  const closeSettings = document.getElementById('btnCloseSettings')
  if (closeSettings) closeSettings.onclick = () => closeSettingsPage()
  const commandBtn = document.getElementById('btnCommand')
  if (commandBtn) commandBtn.onclick = openCommandPalette
  const benchClose = document.getElementById('benchClose')
  if (benchClose) benchClose.onclick = closeBench
  const sbTasks = document.getElementById('sbTasks')
  if (sbTasks) sbTasks.onclick = openTaskDrawer
  const sbEngine = document.getElementById('sbEngine')
  if (sbEngine) sbEngine.onclick = () => openSettingsPage('monitor')
  const tbStatus = document.getElementById('tbStatus')
  if (tbStatus) tbStatus.onclick = () => {
    const dot = document.getElementById('hbDot')
    const st = dot?.className?.includes('bad') ? '本地服务连接中断' : '本地服务运行正常'
    toast(st, 'info')
  }
}

function buildColumnControl() {
  const wrap = document.getElementById('colSegWrap')
  if (!wrap) return
  clear(wrap)
  for (let n = 1; n <= 4; n++) {
    const b = h('button', { class: 'btn btn-sm', type: 'button', dataset: { cols: String(n) }, title: `${n} 列` }, String(n))
    b.onclick = async () => {
      if (!state.settings) return
      state.settings.general.tileColumns = n
      applySettings()
      try {
        await api.put('/api/settings', { general: { tileColumns: n } })
      } catch (e) {
        toast('保存列数失败：' + e.message, 'err')
      }
    }
    wrap.appendChild(b)
  }
}

function handleHeartbeat(st) {
  const level = st.level
  const dotClass = level === 'green' ? 'dot ok' : level === 'amber' ? 'dot warn' : 'dot bad'
  const text = level === 'green' ? '本地服务正常' : level === 'amber' ? '心跳不稳定' : '本地服务已断开'
  for (const id of ['hbDot', 'tbDot']) {
    const el = document.getElementById(id)
    if (el) el.className = dotClass
  }
  const hbText = document.getElementById('hbText')
  if (hbText) hbText.textContent = text
  const tbText = document.getElementById('tbStatusText')
  if (tbText) tbText.textContent = level === 'green' ? '本地服务' : text
}

async function boot() {
  const bootData = await api.get('/api/bootstrap')
  state.settings = bootData.settings
  state.features = bootData.features
  state.version = bootData.version || ''
  state.author = bootData.author || 'Rinkore28'

  const brandVersion = document.getElementById('brandVersion')
  if (brandVersion && state.version) brandVersion.textContent = `v${state.version}`
  const sbVersion = document.getElementById('sbVersion')
  if (sbVersion) sbVersion.textContent = `${APP_TITLE} · v${state.version}`
  const sbAuthor = document.getElementById('sbAuthor')
  if (sbAuthor) sbAuthor.textContent = state.author

  document.title = `${APP_TITLE}${state.version ? ' v' + state.version : ''}`
  buildColumnControl()
  applySettings()

  grid = new TileGrid(document.getElementById('grid'), {
    onChange: () => persistLayout(),
    animations: state.settings.general.animations !== false,
    masonry: true
  })

  initSettingsUI()
  commandUI = initCommandPalette(commandItems)
  bindToolbar()
  initNativeChrome()

  bus.on('heartbeat:state', handleHeartbeat)
  bus.on('settings:changed', () => refreshEngineStatus())

  await syncTiles()
  await refreshEngineStatus()
  await refreshJobs()
  jobsTimer = setInterval(refreshJobs, 2500)
  engineTimer = setInterval(refreshEngineStatus, 8000)

  if (state.settings.i18n?.autoStart) {
    api.post('/api/i18n/start', { i18n: state.settings.i18n }).catch(() => {})
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (isModalOpen() || isCommandPaletteOpen() || isDrawerOpen()) return
    if (document.getElementById('benchView')?.hidden === false) {
      e.preventDefault()
      closeBench()
      return
    }
    if (settingsUI?.isOpen()) {
      e.preventDefault()
      closeSettingsPage()
    }
  })

  window.addEventListener('resize', debounce(() => {
    grid?.relayout?.()
    if (state.settings) syncColumnControl(Number(state.settings.general.tileColumns) || 1)
  }, 120))
}

// heartbeat must start immediately so the backend knows the window is alive
startHeartbeat()

boot().catch((e) => {
  console.error('[boot]', e)
  const gridEl = document.getElementById('grid')
  if (gridEl) {
    clear(gridEl)
    gridEl.style.position = 'static'
    gridEl.appendChild(errorState('初始化失败', e.message || String(e), btn('重新加载', { variant: 'primary', onClick: () => location.reload() })))
  }
})
