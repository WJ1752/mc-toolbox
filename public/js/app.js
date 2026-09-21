import { api } from './core/api.js'
import { h, clear, $, debounce, escapeHtml } from './core/dom.js'
import { toast } from './core/toast.js'
import { TileGrid } from './core/grid.js'
import { initSettings } from './core/settings.js'
import { openModal, confirmDialog } from './core/modal.js'
import { bus } from './core/bus.js'
import { startHeartbeat } from './core/heartbeat.js'

const state = {
  settings: null,
  features: [],
  modules: new Map(),   // featureId -> module
  tiles: new Map(),     // featureId -> { el, body, api }
  loading: new Set()
}

let grid, settingsUI

// ---------------- 样式应用 ----------------
function applySettings() {
  const s = state.settings
  document.documentElement.dataset.theme = s.general.theme
  document.documentElement.style.setProperty('--accent', s.general.accent)
  document.documentElement.style.setProperty('--tile-cols', String(Math.max(1, Number(s.general.tileColumns) || 1)))
  grid?.setAnimations(s.general.animations)
}

const persistLayout = debounce(async () => {
  const order = grid.order()
  const layout = order.map((id) => {
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

// ---------------- 磁贴构建 ----------------
function tileSize(feature) {
  const saved = (state.settings.layout || []).find((l) => l.id === feature.id)
  const fallback = { w: feature.size?.w || 1, h: feature.size?.h || 1, collapsed: state.settings.general?.defaultCollapsed !== false }
  if (!saved) return fallback
  return {
    w: saved.w || 1,
    h: saved.h || 1,
    collapsed: saved.collapsed === undefined ? fallback.collapsed : !!saved.collapsed
  }
}

function applyCollapse(tile) {
  tile.el.classList.toggle('collapsed', tile.collapsed)
  if (tile.chev) {
    tile.chev.title = tile.collapsed ? '展开内容' : '折叠为仅标题'
    tile.chev.textContent = '▾'
  }
  if (tile.collapsed) tile.el.classList.remove('h-2')
  else if (tile.h > 1) tile.el.classList.add('h-2')
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

async function ensureMounted(id) {
  const tile = state.tiles.get(id)
  if (!tile || tile.mounted || tile.mounting) return
  tile.mounting = true // 并发锁：避免折叠/展开抖动时 mount 跑两次 → 内容重复
  const mod = state.modules.get(id)
  if (mod?.mount) {
    try {
      await mod.mount(tile.ctx)
      tile.mounted = true
    } catch (e) {
      console.error('[feature] mount 失败', id, e)
      tile.body.appendChild(h('div', { class: 'result-bad' }, '功能初始化失败：' + e.message))
    } finally {
      tile.mounting = false
    }
  } else {
    tile.mounting = false
  }
}

async function setAllCollapsed(v) {
  for (const tile of state.tiles.values()) {
    const wasCollapsed = tile.collapsed
    tile.collapsed = v
    applyCollapse(tile)
    if (wasCollapsed && !v) ensureMounted(tile.el.dataset.id)
  }
  persistLayout()
  updateCollapseBtn()
}

function updateCollapseBtn() {
  const btn = document.getElementById('btnCollapseAll')
  if (!btn) return
  const tiles = Array.from(state.tiles.values())
  const allCollapsed = tiles.length > 0 && tiles.every((t) => t.collapsed)
  btn.textContent = allCollapsed ? '⇲ 全部展开' : '⇱ 全部折叠'
}

function createTile(feature) {
  const size = tileSize(feature)
  const icon = h('span', { class: 'tile-icon' }, feature.icon || '🧩')
  const title = h('h3', { class: 'tile-title' }, feature.name)
  const badge = h('span', { class: 'badge', style: { display: 'none' } })
  const body = h('div', { class: 'tile-body' })

  const chev = h('button', { class: 'chev', title: '折叠为仅标题', onclick: () => toggleCollapse(feature.id) }, '▾')
  const btnExpand = h('button', { title: '放大查看', onclick: () => expandTile(feature.id) }, '⤢')
  const btnMore = h('button', { title: '更多', onclick: (e) => tileMenu(e, feature.id) }, '⋯')

  const el = h(
    'section',
    { class: 'tile', dataset: { id: feature.id } },
    h('header', { class: 'tile-head' }, chev, icon, title, badge, h('span', { class: 'spacer' }), h('div', { class: 'tile-actions' }, btnExpand, btnMore)),
    body
  )
  el.style.setProperty('--tile-color', feature.color)
  icon.style.background = feature.color
  // 单列（一行一个）时不跨列；多列时跨列数不超过总列数
  const cols = Math.max(1, Number(state.settings.general?.tileColumns) || 1)
  if (size.w > 1 && cols > 1) el.classList.add('span-' + Math.min(size.w, cols))
  const tile = { el, body, badge, chev, w: size.w, h: size.h, collapsed: !!size.collapsed, mounted: false, mounting: false }
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
    setBadge(text, kind = '') {
      if (!text) {
        tile.badge.style.display = 'none'
        return
      }
      tile.badge.style.display = ''
      tile.badge.className = 'badge ' + kind
      tile.badge.textContent = text
    },
    expand(renderFn, opts = {}) {
      const container = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } })
      const modal = openModal({ title: feature.name, size: opts.size || 'lg', body: container })
      try {
        renderFn?.(container, { close: modal.close })
      } catch (e) {
        container.appendChild(h('div', { class: 'result-bad' }, '渲染失败：' + e.message))
      }
      return modal
    },
    getSettings: () => state.settings,
    escapeHtml
  }
}

function tileMenu(e, id) {
  e.stopPropagation()
  const feature = state.features.find((f) => f.id === id)
  const tile = state.tiles.get(id)
  const items = [
    { label: tile?.collapsed ? '▸ 展开内容' : '▾ 折叠为仅标题', onClick: () => toggleCollapse(id) },
    { label: '隐藏此磁贴（可从设置恢复）', onClick: () => hideTile(id) }
  ]
  if (!feature?.builtin) items.push({ label: '删除此功能', danger: true, onClick: () => removeFeature(id) })
  const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '180px' } })
  for (const it of items) {
    list.appendChild(h('button', {
      class: 'btn btn-sm' + (it.danger ? ' btn-danger' : ''),
      style: { textAlign: 'left' },
      onclick: () => { it.onClick(); close() }
    }, it.label))
  }
  const modal = openModal({ title: feature?.name || '磁贴', body: list })
  function close() { modal.close() }
}

async function hideTile(id) {
  await api.put('/api/features/' + id, { visible: false })
  const f = state.features.find((x) => x.id === id)
  if (f) f.visible = false
  unmountTile(id)
  persistLayout()
  toast('已隐藏磁贴，可在设置中恢复', 'ok')
}

async function removeFeature(id) {
  const f = state.features.find((x) => x.id === id)
  if (!(await confirmDialog(`确定删除功能「${f?.name || id}」？文件夹会被移动到 features_disabled。`, { danger: true }))) return
  await api.del('/api/features/' + id)
  unmountTile(id)
  state.features = state.features.filter((x) => x.id !== id)
  persistLayout()
  toast('功能已删除', 'ok')
}

function unmountTile(id) {
  const tile = state.tiles.get(id)
  if (tile) {
    try {
      state.modules.get(id)?.unmount?.()
    } catch {}
    grid.remove(id)
    state.tiles.delete(id)
  }
  document.getElementById('emptyHint').hidden = state.tiles.size > 0
}

async function mountFeature(feature, beforeId) {
  if (state.tiles.has(feature.id) || state.loading.has(feature.id)) return
  state.loading.add(feature.id)
  const tile = createTile(feature)
  state.tiles.set(feature.id, tile)
  grid.mount(tile.el, beforeId)

  try {
    const mod = await import(`/features/${feature.dir}/${feature.entry}`)
    state.modules.set(feature.id, mod.default || mod)
    const ctx = makeContext(feature, tile)
    tile.ctx = ctx
    // 折叠态不主动 mount：等到用户展开或点开大图时才加载（节省 API/计时器）
    if (!tile.collapsed) {
      await mod.default?.mount?.(ctx)
      tile.mounted = true
    }
  } catch (e) {
    console.error('[feature] 加载失败', feature.id, e)
    tile.body.appendChild(h('div', { class: 'result-bad' }, '功能加载失败：' + e.message))
  } finally {
    state.loading.delete(feature.id)
  }
  document.getElementById('emptyHint').hidden = true
}

function expandTile(id) {
  const feature = state.features.find((f) => f.id === id)
  const mod = state.modules.get(id)
  const tile = state.tiles.get(id)
  if (!feature || !tile) return
  ensureMounted(id)
  const container = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } })
  const modal = openModal({ title: feature.name, size: 'xl', body: container })
  if (mod?.renderExpanded) {
    try {
      mod.renderExpanded(container, { close: modal.close, ctx: tile.ctx })
    } catch (e) {
      container.appendChild(h('div', { class: 'result-bad' }, '渲染失败：' + e.message))
    }
  } else {
    // 无自定义展开视图时，克隆磁贴内容放大显示
    container.appendChild(h('div', { class: 'muted' }, '该功能未提供展开视图，以下为磁贴内容放大显示。'))
    const cloneWrap = h('div')
    container.appendChild(cloneWrap)
    const ctx = makeContext(feature, { el: tile.el, body: cloneWrap, badge: tile.badge })
    try {
      mod?.mount?.(ctx)
    } catch (e) {
      cloneWrap.appendChild(h('div', { class: 'result-bad' }, e.message))
    }
  }
}

// ---------------- 添加磁贴 ----------------
function openAddTile() {
  const available = state.features.filter((f) => f.enabled && !state.tiles.has(f.id))
  const box = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } })
  if (!available.length) {
    box.appendChild(h('div', { class: 'muted center', style: { padding: '20px' } }, '没有可添加的功能。所有功能都已在页面上，或已在设置中禁用。'))
  }
  for (const f of available) {
    box.appendChild(
      h('div', { class: 'feature-item' },
        h('div', { class: 'fi-icon', style: { background: f.color } }, f.icon),
        h('div', { class: 'fi-main' }, h('b', {}, f.name), h('span', {}, f.desc || '')),
        h('button', {
          class: 'btn btn-sm btn-primary',
          onclick: async () => {
            await api.put('/api/features/' + f.id, { visible: true, enabled: true })
            f.visible = true
            await mountFeature(f)
            persistLayout()
            modal.close()
            toast(`已添加「${f.name}」`, 'ok')
          }
        }, '添加')
      )
    )
  }
  const modal = openModal({ title: '添加磁贴', body: box, buttons: [{ label: '关闭' }] })
}

// ---------------- 无边框窗口（WebView2 宿主）标题栏 ----------------
// 页面运行在 WebView2 无边框宿主里时（URL 带 ?host=webview2），
// 顶栏承担窗口拖拽 + 最小化/最大化/关闭按钮，替代系统标题栏。
function initNativeChrome() {
  const wv = window.chrome && window.chrome.webview
  if (!wv) return
  document.body.classList.add('nv')
  const wc = document.getElementById('winControls')
  if (wc) {
    wc.hidden = false
    const maxBtn = wc.querySelector('[data-act="max"]')
    // 宿主在最大化/还原变化时回传状态，用于切换「最大化/还原」图形
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
          // 乐观切换；宿主随后会回传 wm 状态校正
          b.classList.toggle('maximized')
        }
      }
    })
  }
  const bar = document.querySelector('header.topbar')
  if (!bar) return
  const interactive = (t) => !!t.closest('button, a, input, select, textarea, label, .win-controls, .topbar-actions')

  // 窗口边缘悬浮层：WebView2 铺满客户区后系统收不到边框命中，改用这些隐形条触发原生缩放
  // 命中码即 WM_NCHITTEST 的 HT* 值：左10 右11 上12 左上13 右上14 下15 左下16 右下17
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

  // 窗口拖拽：按下即通知宿主走系统原生移动（HTCAPTION），平滑跟手
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || interactive(e.target)) return
    try { wv.postMessage('cap') } catch {}
  })
  bar.addEventListener('dblclick', (e) => {
    if (interactive(e.target)) return
    try { wv.postMessage('max') } catch {}
  })
}

// ---------------- 初始化 ----------------
async function boot() {
  const boot = await api.get('/api/bootstrap')
  state.settings = boot.settings
  state.features = boot.features
  applySettings()

  grid = new TileGrid(document.getElementById('grid'), {
    onChange: () => persistLayout(),
    animations: state.settings.general.animations
  })

  settingsUI = initSettings({
    getSettings: () => state.settings,
    onSaved: (s) => {
      state.settings = s
      applySettings()
      bus.emit('settings:changed', s)
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
    },
    onResetLayout: async () => {
      await api.put('/api/settings', { layout: [] })
      state.settings.layout = []
      for (const id of Array.from(state.tiles.keys())) unmountTile(id)
      await syncTiles()
      toast('布局已重置', 'ok')
    },
    openAddTile
  })

  await syncTiles()

  // 自动启动不依赖翻译磁贴是否展开（默认折叠时也应生效）。失败交给磁贴
  // 和设置页在用户需要时再次显示具体错误，避免阻塞工具箱主界面启动。
  if (state.settings.i18n?.autoStart) {
    api.post('/api/i18n/start', { i18n: state.settings.i18n }).catch(() => {})
  }

  $('#btnSettings').onclick = () => settingsUI.open()
  $('#btnCloseSettings').onclick = () => settingsUI.close()
  $('#btnAddTile').onclick = openAddTile
  $('#btnEmptyAdd').onclick = openAddTile
  $('#btnCollapseAll').onclick = () => {
    const tiles = Array.from(state.tiles.values())
    setAllCollapsed(!tiles.every((t) => t.collapsed))
  }
  $('#btnReload').onclick = async () => {
    const data = await api.get('/api/features')
    state.features = data.items
    await syncTiles()
    toast('已重新加载功能', 'ok')
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsUI.isOpen()) settingsUI.close()
  })

  initNativeChrome()
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
  // 按保存顺序排列
  const existing = grid.order()
  const sorted = order.filter((id) => existing.includes(id))
  for (const id of existing) if (!sorted.includes(id)) sorted.push(id)
  if (sorted.length) grid.setOrder(sorted)
  document.getElementById('emptyHint').hidden = state.tiles.size > 0
  updateCollapseBtn()
}

// 启动页面心跳：后端据此判断应用窗口是否还开着（关窗即停服务）
startHeartbeat()

boot().catch((e) => {
  document.body.appendChild(h('div', { style: { padding: '20px', color: '#ff5f56' } }, '初始化失败：' + e.message))
})
