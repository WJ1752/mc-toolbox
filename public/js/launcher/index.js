// 启动器主页面：实例侧栏、实例主页、下载中心 / Java 视图切换。
// 工作台仍然是独立页面，由 app.js 的页面切换控制；本模块只负责启动器。
import {
  h, clear, debounce, escapeHtml, fmtBytes, fmtAgo, fmtDuration, fmtDateTime, copyText
} from '../core/dom.js'
import { toast } from '../core/toast.js'
import { confirmDialog, openModal } from '../core/modal.js'
import { pickDir, pickFile } from '../core/dirpicker.js'
import { btn, field, input, select, toggle, spinner, iconBtn, openPath } from '../ui/kit.js'
import { icon } from '../ui/icons.js'
import { openContextMenu, closeContextMenu } from '../ui/contextmenu.js'
import { bus } from '../core/bus.js'
import { launcherApi as api } from './api.js'
import * as ui from './ui.js'
import { optimizedJvmArgs, hasOptimizedJvm } from './jvm.js'

const TABS = [
  ['overview', '概览'],
  ['mods', '模组'],
  ['resourcepacks', '资源包'],
  ['shaderpacks', '光影'],
  ['worlds', '世界'],
  ['screenshots', '截图'],
  ['servers', '服务器'],
  ['logs', '日志']
]

const state = {
  ready: false,
  active: false,
  loading: true,
  error: '',
  settings: null,
  root: '',
  loaders: [],
  instances: [],
  selectedId: '',
  accounts: { selected: '', items: [] },
  sessions: [],
  jobs: [],
  communityJobs: [],
  detail: null,
  detailToken: 0,
  tab: 'overview',
  view: 'instance',
  search: '',
  news: null,
  newsLoading: false,
  lastJobState: new Map(),
  finishedNotified: new Set(),
  installController: null,
  javaController: null,
  downloadsController: null,
  contentHandle: null,
  contentToken: 0,
  heroRefs: null,
  pollTimer: null,
  backgroundTimer: null
}

let rootEl = null
let sideEl = null
let mainEl = null
let helpers = {}
let instanceListEl = null
let accountWrapEl = null
let countEl = null
let navWrapEl = null
let searchInputEl = null
let lastPollAt = 0

const moduleCache = new Map()
function loadModule(name) {
  if (!moduleCache.has(name)) moduleCache.set(name, import(`./${name}.js`))
  return moduleCache.get(name)
}

function selectedInstance() {
  return (state.instances || []).find((item) => item.id === state.selectedId) || null
}

function selectedAccount() {
  const items = state.accounts?.items || []
  return items.find((item) => item.selected) || items[0] || null
}

function sessionOf(id) {
  return state.sessions.find((item) => item.instanceId === id) || null
}

function isRunningSession(session) {
  return !!session && ['starting', 'running', 'stopping'].includes(session.status)
}

function sessionLabel(session) {
  if (!session) return ''
  return {
    starting: '启动中',
    running: '运行中',
    stopping: '正在停止',
    exited: '已退出',
    stopped: '已停止',
    failed: '异常退出'
  }[session.status] || session.status
}

function pageCtx() {
  return {
    api,
    ui,
    toast,
    confirm: confirmDialog,
    openModal,
    openPath,
    pickFile,
    pickDir,
    getState: () => ({
      instances: state.instances,
      selectedId: state.selectedId,
      accounts: state.accounts,
      settings: state.settings,
      sessions: state.sessions,
      jobs: state.jobs
    }),
    reload: () => refreshAll(),
    reloadInstance: () => refreshSelectedDetail(),
    showInstance: async (id) => { await selectInstance(id) },
    showView: async (view) => { await showView(view) },
    openAccounts: () => openAccounts(),
    openSettings: () => openLauncherSettings(),
    setTab: (tab) => setTab(tab)
  }
}

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */

export async function initLauncherPage(pageHelpers = {}) {
  helpers = pageHelpers
  rootEl = document.getElementById('launcherPage')
  if (!rootEl) throw new Error('缺少启动器页面容器')
  buildSkeleton()
  bindKeys()
  try {
    await loadBootstrap()
  } catch (e) {
    state.error = e.message
    state.loading = false
  }
  renderSidebar()
  if (state.instances.length && state.selectedId) await loadDetail(state.selectedId, { render: false })
  renderMain()
  state.ready = true
  return {
    activate,
    deactivate,
    refresh: refreshAll,
    commandItems,
    isActive: () => state.active,
    getState: () => state,
    destroy
  }
}

function buildSkeleton() {
  clear(rootEl)
  sideEl = h('aside', { class: 'lp-side', 'aria-label': '游戏实例' })
  mainEl = h('section', { class: 'lp-main', id: 'lpMainView' })
  rootEl.append(sideEl, mainEl)

  const head = h('div', { class: 'lp-side-head' },
    h('div', { class: 'lp-side-title' },
      h('span', { class: 'overline' }, 'Launch Bay'),
      h('h1', {}, '游戏实例 ', h('span', { class: 'lp-count', id: 'lpCount' }))
    ),
    h('button', { class: 'lp-new', type: 'button', title: '安装新的 Minecraft 实例' },
      icon('add', { size: 15 }), h('span', {}, '新建实例'))
  )
  head.querySelector('.lp-new').onclick = () => showView('install')

  accountWrapEl = h('div', { class: 'lp-account-slot' })

  searchInputEl = input({
    placeholder: '搜索实例、版本或加载器…',
    onInput: (e) => { state.search = e.target.value.trim(); renderInstanceList() }
  })
  searchInputEl.classList.add('lp-search-input')
  const search = h('div', { class: 'lp-search' }, icon('search', { size: 14 }), searchInputEl)

  instanceListEl = h('div', { class: 'lp-inst-list', role: 'listbox', 'aria-label': '实例列表' })

  navWrapEl = h('nav', { class: 'lp-side-nav', 'aria-label': '启动器导航' })
  sideEl.append(head, accountWrapEl, search, instanceListEl, navWrapEl)
}

function navButton(id, label, iconName, onClick) {
  const b = h('button', { class: 'lp-navbtn', type: 'button', dataset: { nav: id } },
    icon(iconName, { size: 15 }), h('span', {}, label))
  b.onclick = onClick
  return b
}

function buildNav() {
  clear(navWrapEl)
  navWrapEl.append(
    navButton('downloads', '下载中心', 'download', () => showView('downloads')),
    navButton('java', 'Java', 'java', () => showView('java')),
    navButton('import', '导入已有游戏', 'archive', async () => {
      await showView('install')
      setTimeout(() => {
        const tabs = [...document.querySelectorAll('.lp-view-body .seg button')]
        tabs.find((button) => /导入已有/.test(button.textContent || ''))?.click()
      }, 60)
    }),
    navButton('settings', '启动器设置', 'settings', () => openLauncherSettings()),
    h('div', { class: 'lp-nav-sep' }),
    navButton('workspace', '返回工作台', 'workspace', () => helpers.switchPage?.('workbench'))
  )
  updateNav()
}

function updateNav() {
  for (const b of navWrapEl.querySelectorAll('.lp-navbtn')) {
    b.classList.toggle('active', b.dataset.nav === state.view)
  }
}

/* ------------------------------------------------------------------ */
/* data                                                               */
/* ------------------------------------------------------------------ */

async function loadBootstrap({ silent = false } = {}) {
  if (!silent) state.loading = true
  const data = await api.bootstrap()
  state.settings = data.settings
  state.root = data.root
  state.loaders = data.loaders || []
  state.instances = data.instances || []
  state.accounts = data.accounts || { selected: '', items: [] }
  state.sessions = data.sessions || []
  state.jobs = data.jobs || []
  const exists = state.instances.some((item) => item.id === state.selectedId)
  if (!exists) state.selectedId = data.selectedInstance || state.instances[0]?.id || ''
  state.loading = false
  state.error = ''
  for (const job of state.jobs) state.lastJobState.set(job.id, job.status)
  updateRunningIndicators()
  renderAccountCard()
  renderInstanceList()
  updateNav()
  if (countEl) countEl.textContent = state.instances.length ? String(state.instances.length) : ''
}

async function refreshAll() {
  try {
    await loadBootstrap({ silent: true })
    if (state.view === 'instance') {
      await loadDetail(state.selectedId, { render: false })
      renderMain()
    } else {
      renderAccountCard()
      updateNav()
    }
  } catch (e) {
    toast('刷新启动器失败：' + e.message, 'err')
  }
}

async function refreshSelectedDetail() {
  if (!state.selectedId) return
  try {
    const detail = await api.instance(state.selectedId)
    if (state.selectedId !== detail.instance?.id) return
    state.detail = detail
    updateTabCounts()
    updateHeroRuntime()
  } catch {}
}

async function loadDetail(id, { render = true } = {}) {
  if (!id) { state.detail = null; return }
  const token = ++state.detailToken
  if (render) {
    state.detail = null
    renderMain()
  }
  try {
    const detail = await api.instance(id)
    if (token !== state.detailToken || state.selectedId !== id) return null
    state.detail = detail
    if (state.view === 'instance') {
      if (render) renderMain()
      else { updateTabCounts(); updateHeroRuntime() }
    }
    return detail
  } catch (e) {
    if (token !== state.detailToken) return null
    state.detail = { error: e.message, instance: selectedInstance(), status: {}, summary: {} }
    if (state.view === 'instance' && render) renderMain()
    return null
  }
}

/* ------------------------------------------------------------------ */
/* sidebar                                                           */
/* ------------------------------------------------------------------ */

function renderSidebar() {
  renderAccountCard()
  renderInstanceList()
  buildNav()
}

function renderAccountCard() {
  if (!accountWrapEl) return
  clear(accountWrapEl)
  const account = selectedAccount()
  const card = h('button', {
    class: 'lp-account' + (account ? '' : ' empty'),
    type: 'button',
    title: account ? '管理账户' : '添加账户',
    onclick: () => openAccounts()
  },
    account ? ui.playerAvatar(account, { size: 30 }) : h('span', { class: 'lp-account-empty-icon' }, icon('user', { size: 16 })),
    h('span', { class: 'lp-account-main' },
      h('span', { class: 'lp-account-name' }, account ? account.name : '未登录账户'),
      h('span', { class: 'lp-account-sub' }, account ? `${ui.accountTypeLabel(account.type)}${account.needsRefresh ? ' · 需要刷新' : ''}` : '离线 / 微软 / 第三方')
    ),
    icon('chevron-right', { size: 13 })
  )
  accountWrapEl.appendChild(card)
}

function renderInstanceList() {
  if (!instanceListEl) return
  clear(instanceListEl)
  const q = state.search.toLowerCase()
  const list = state.instances.filter((inst) => {
    if (!q) return true
    return `${inst.name} ${inst.mc} ${inst.loader} ${inst.group} ${inst.loaderVersion}`.toLowerCase().includes(q)
  })
  if (!list.length) {
    instanceListEl.appendChild(h('div', { class: 'lp-side-empty' },
      state.instances.length ? '没有匹配的实例' : '还没有实例，点击上方“新建实例”。'))
    return
  }
  for (const inst of list) {
    const session = sessionOf(inst.id)
    const running = isRunningSession(session)
    const active = inst.id === state.selectedId
    const row = h('button', {
      class: 'lp-inst' + (active ? ' active' : '') + (running ? ' running' : ''),
      type: 'button',
      role: 'option',
      'aria-selected': String(active),
      dataset: { instId: inst.id },
      title: `${inst.name}\n${ui.instanceSubtitle(inst)}`
    },
      ui.instanceIcon(inst, { size: 34, running }),
      h('span', { class: 'lp-inst-main' },
        h('span', { class: 'lp-inst-name' }, inst.name),
        h('span', { class: 'lp-inst-sub' }, ui.instanceSubtitle(inst), inst.group ? h('i', { class: 'lp-inst-group' }, inst.group) : null)
      ),
      h('span', { class: 'lp-inst-side' },
        running ? h('span', { class: 'lp-run-dot', title: sessionLabel(session) }) : null,
        !inst.installed ? h('span', { class: 'lp-warn-dot', title: '需要修复' }) : null
      )
    )
    row.onclick = () => selectInstance(inst.id)
    row.ondblclick = () => { selectInstance(inst.id); launchSelected() }
    instanceListEl.appendChild(row)
  }
}

function updateRunningIndicators() {
  if (!instanceListEl) return
  for (const row of instanceListEl.querySelectorAll('[data-inst-id]')) {
    const session = sessionOf(row.dataset.instId)
    const running = isRunningSession(session)
    row.classList.toggle('running', running)
    let dot = row.querySelector('.lp-run-dot')
    if (running && !dot) {
      dot = h('span', { class: 'lp-run-dot' })
      row.querySelector('.lp-inst-side')?.appendChild(dot)
    }
    if (!running && dot) dot.remove()
    if (dot) dot.title = sessionLabel(session)
  }
}

async function selectInstance(id, { tab = 'overview' } = {}) {
  if (!id) return
  const changed = state.selectedId !== id
  state.selectedId = id
  state.tab = tab
  state.detail = null
  if (changed) api.selectInstance(id).catch(() => {})
  if (state.view !== 'instance') {
    state.view = 'instance'
    updateNav()
  }
  destroyContent()
  renderInstanceList()
  renderMain()
  await loadDetail(id, { render: false })
  if (state.view === 'instance' && state.selectedId === id) {
    renderHeroAndTabs()
  }
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

function renderMain() {
  if (!mainEl) return
  destroyContent()
  clear(mainEl)
  if (state.loading) {
    mainEl.appendChild(h('div', { class: 'lp-main-loading' }, spinner(18), '正在读取本地启动器状态…'))
    return
  }
  if (state.error) {
    mainEl.appendChild(h('div', { class: 'lp-main-error' },
      icon('warning', { size: 24 }),
      h('b', {}, '启动器状态读取失败'),
      h('p', {}, state.error),
      btn('重试', { variant: 'primary', onClick: () => refreshAll() })
    ))
    return
  }
  if (state.view === 'install') { renderInstallView(); return }
  if (state.view === 'downloads') { renderDownloadsView(); return }
  if (state.view === 'java') { renderJavaView(); return }
  if (!state.instances.length) { renderWelcome(); return }
  const inst = selectedInstance()
  if (!inst) { renderWelcome(); return }
  renderHeroAndTabs()
}

function viewHeader(title, overline, onBack, actions = null) {
  const back = h('button', { class: 'lp-back', type: 'button', title: '返回实例' }, icon('arrow-left', { size: 14 }), h('span', {}, '返回'))
  back.onclick = onBack
  return h('div', { class: 'lp-view-head' },
    back,
    h('div', { class: 'lp-view-title' }, h('span', { class: 'overline' }, overline), h('h2', {}, title)),
    h('div', { class: 'lp-view-actions' }, actions)
  )
}

function viewBackBar(onBack) {
  const back = h('button', { class: 'lp-back', type: 'button', title: '返回实例' }, icon('arrow-left', { size: 14 }), h('span', {}, '返回实例'))
  back.onclick = onBack
  return h('div', { class: 'lp-backbar' }, back)
}

async function renderInstallView() {
  const body = h('div', { class: 'lp-view-body' })
  mainEl.appendChild(h('div', { class: 'lp-view' },
    viewBackBar(() => showView('instance')),
    body
  ))
  try {
    const mod = await loadModule('install')
    if (state.view !== 'install') return
    if (!state.installController) state.installController = mod.createInstallCenter(pageCtx())
    state.installController.render(body)
  } catch (e) {
    body.appendChild(h('div', { class: 'lp-main-error' }, icon('warning', { size: 22 }), h('b', {}, '加载安装中心失败'), h('p', {}, e.message)))
  }
}

async function renderJavaView() {
  const body = h('div', { class: 'lp-view-body' })
  mainEl.appendChild(h('div', { class: 'lp-view' },
    viewBackBar(() => showView('instance')),
    body
  ))
  try {
    const mod = await loadModule('java')
    if (state.view !== 'java') return
    if (!state.javaController) state.javaController = mod.createJavaView(pageCtx())
    state.javaController.render(body)
  } catch (e) {
    body.appendChild(h('div', { class: 'lp-main-error' }, icon('warning', { size: 22 }), h('b', {}, '加载 Java 视图失败'), h('p', {}, e.message)))
  }
}

async function renderDownloadsView() {
  const body = h('div', { class: 'lp-view-body' })
  mainEl.appendChild(h('div', { class: 'lp-view lp-view-downloads' },
    viewBackBar(() => showView('instance')),
    body
  ))
  try {
    const mod = await loadModule('downloads')
    if (state.view !== 'downloads') return
    if (!state.downloadsController) state.downloadsController = mod.createDownloadsView(pageCtx())
    state.downloadsController.render(body)
  } catch (e) {
    body.appendChild(h('div', { class: 'lp-main-error' }, icon('warning', { size: 22 }), h('b', {}, '加载下载中心失败'), h('p', {}, e.message)))
  }
}

async function showView(view) {
  const previous = state.view
  if (previous === 'downloads' && view !== 'downloads') {
    state.downloadsController?.destroy?.()
    state.downloadsController = null
  }
  if (view !== 'instance') destroyContent()
  const changed = state.view !== view
  state.view = view
  updateNav()
  if (view === 'instance') {
    if (state.selectedId && (!state.detail || state.detail.instance?.id !== state.selectedId)) {
      state.detail = null
      renderMain()
      await loadDetail(state.selectedId, { render: false })
      if (state.view === 'instance') renderHeroAndTabs()
      return
    }
  }
  renderMain()
  if (changed && view === 'install') state.installController?.focus?.()
  if (changed && view === 'downloads') state.downloadsController?.focus?.()
}

/* ------------------------------------------------------------------ */
/* welcome                                                            */
/* ------------------------------------------------------------------ */

function renderWelcome() {
  const account = selectedAccount()
  const wrap = h('div', { class: 'lp-welcome' })
  wrap.appendChild(h('div', { class: 'lp-welcome-hero' },
    h('div', { class: 'lp-welcome-mark' }, icon('cube', { size: 34 })),
    h('div', { class: 'lp-welcome-title' },
      h('span', { class: 'overline' }, 'Launch Bay'),
      h('h1', {}, '准备进入世界'),
      h('p', {}, '把版本、账户和启动参数收进同一张工作台；工作台页面仍保留全部服务器与整合包工具。')
    ),
    h('div', { class: 'lp-welcome-actions' },
      btn('新建实例', { variant: 'primary', iconName: 'add', onClick: () => showView('install') }),
      btn(account ? '添加账户' : '添加账户', { iconName: 'user', onClick: () => openAccounts() }),
      btn('导入已有游戏', { iconName: 'archive', onClick: async () => {
        await showView('install')
        setTimeout(() => {
          const tabs = [...document.querySelectorAll('.lp-view-body .seg button')]
          tabs.find((button) => /导入已有/.test(button.textContent || ''))?.click()
        }, 60)
      } })
    )
  ))

  const steps = h('div', { class: 'lp-steps' })
  const stepData = [
    ['01', '账户', account ? `当前：${account.name}` : '添加离线、微软或第三方账户', () => openAccounts()],
    ['02', '实例', '安装原版 / Fabric / Forge / NeoForge，或导入已有版本', () => showView('install')],
    ['03', '启动', '设置内存与 Java，点击启动；日志和崩溃诊断都在实例页', () => showView('install')]
  ]
  for (const [n, title, text, action] of stepData) {
    const card = h('button', { class: 'lp-step', type: 'button' },
      h('span', { class: 'lp-step-n' }, n),
      h('span', { class: 'lp-step-main' }, h('b', {}, title), h('span', {}, text)),
      icon('arrow-right', { size: 14 })
    )
    card.onclick = action
    steps.appendChild(card)
  }
  wrap.appendChild(steps)

  const newsSlot = h('div', { class: 'lp-welcome-news', id: 'lpWelcomeNews' })
  wrap.appendChild(newsSlot)
  mainEl.appendChild(wrap)
  renderNewsInto(newsSlot, { compact: true })

  // If the requested instance disappears, keep the welcome page usable.
  if (state.instances.length) {
    const hint = h('div', { class: 'lp-hint' }, '也可以从左侧列表选择实例。')
    wrap.appendChild(hint)
  }
}

/* ------------------------------------------------------------------ */
/* instance hero + tabs                                               */
/* ------------------------------------------------------------------ */

function renderHeroAndTabs() {
  const inst = selectedInstance()
  if (!inst) { renderMain(); return }
  clear(mainEl)
  const detail = state.detail
  if (detail?.error) {
    mainEl.appendChild(h('div', { class: 'lp-main-error' },
      icon('warning', { size: 24 }), h('b', {}, '读取实例失败'), h('p', {}, detail.error),
      btn('返回', { onClick: () => renderWelcome() })
    ))
    return
  }
  if (!detail) {
    mainEl.appendChild(h('div', { class: 'lp-skeleton-hero' },
      h('div', { class: 'sk', style: { width: '72px', height: '72px' } }),
      h('div', { class: 'lp-skeleton-lines' }, h('div', { class: 'sk', style: { width: '42%', height: '16px' } }), h('div', { class: 'sk', style: { width: '28%', height: '11px' } }))
    ))
    return
  }
  const current = detail.instance || inst
  mainEl.appendChild(renderHero(current, detail, sessionOf(current.id)))
  mainEl.appendChild(renderMetaStrip(current, detail))
  const tabs = renderTabs(current, detail)
  mainEl.appendChild(tabs.wrap)
  mountTab(tabs.body, current, state.tab)
}

function renderHero(inst, detail, session) {
  const running = isRunningSession(session)
  const stopping = session?.status === 'stopping'
  const actionWrap = h('div', { class: 'lp-hero-actions' })
  const statusText = h('span', { class: 'lp-hero-status-text' }, running ? sessionLabel(session) : inst.installed ? '准备就绪' : '尚未安装完成')
  const elapsed = h('span', { class: 'lp-hero-elapsed' }, running ? fmtDuration(Math.max(0, (session.elapsed || 0) / 1000)) : '')
  const status = h('div', { class: 'lp-hero-status' + (running ? ' running' : '') },
    h('i', {}), statusText, elapsed)

  const launchBtn = h('button', { class: 'lp-launch' + (running ? ' stop' : ''), type: 'button' })
  function paintLaunch(isRunning = running, isStopping = stopping) {
    clear(launchBtn)
    launchBtn.className = 'lp-launch' + (isRunning ? ' stop' : '')
    launchBtn.disabled = false
    if (isRunning) {
      launchBtn.append(icon('stop', { size: 17 }), h('span', {}, isStopping ? '正在停止…' : '停止游戏'))
      launchBtn.disabled = isStopping
      launchBtn.onclick = () => stopSelected()
    } else {
      launchBtn.append(icon('play', { size: 17 }), h('span', {}, inst.installed ? '启动游戏' : '修复并启动'))
      launchBtn.onclick = () => launchSelected()
    }
  }
  paintLaunch()
  const account = selectedAccount()
  const accountLine = h('span', { class: 'lp-launch-sub' }, account ? `以 ${account.name} 登录` : '需要先添加账户')

  const settingsBtn = iconBtn('settings', { label: '实例设置', title: '实例设置', onClick: () => openInstanceSettings(inst) })
  const folderBtn = iconBtn('folder-open', { label: '打开游戏目录', title: '打开游戏目录', onClick: () => openPath(detail.paths?.gameDir || inst.paths?.gameDir || '') })
  const moreBtn = iconBtn('more', { label: '更多操作', title: '更多操作', onClick: (e) => openInstanceMenu(e, inst) })

  actionWrap.append(
    h('div', { class: 'lp-launch-wrap' }, launchBtn, accountLine),
    h('div', { class: 'lp-hero-tools' }, settingsBtn, folderBtn, moreBtn)
  )

  const badges = h('div', { class: 'lp-hero-badges' },
    h('span', { class: 'badge ' + (inst.installed ? 'ok' : 'warn') }, inst.installed ? '已安装' : '需要修复'),
    inst.external ? h('span', { class: 'badge info', title: '引用外部 .minecraft，不复制游戏文件' }, '外部目录') : null,
    detail.summary?.pack ? h('span', { class: 'badge accent' }, '整合包') : null
  )

  const root = h('div', { class: 'lp-hero' + (running ? ' is-running' : '') },
    ui.instanceIcon(inst, { size: 72, running }),
    h('div', { class: 'lp-hero-main' },
      h('span', { class: 'overline' }, inst.group || 'Instance'),
      h('h1', { title: inst.name }, inst.name),
      h('div', { class: 'lp-hero-sub' }, ui.instanceSubtitle(inst), h('span', { class: 'lp-dot-sep' }, '·'), ui.lastPlayed(inst.lastPlayed)),
      badges,
      status
    ),
    actionWrap
  )
  state.heroRefs = { root, launchBtn, status, statusText, elapsed, paintLaunch, instId: inst.id, sig: running ? (stopping ? 'stopping' : 'running') : 'idle' }
  return root
}

function updateHeroRuntime() {
  const refs = state.heroRefs
  if (!refs || refs.instId !== state.selectedId) return
  const detail = state.detail
  const inst = detail?.instance || selectedInstance()
  if (!inst) return
  const session = sessionOf(inst.id)
  const running = isRunningSession(session)
  const stopping = session?.status === 'stopping'
  refs.root?.classList.toggle('is-running', running)
  refs.status?.classList.toggle('running', running)
  if (refs.statusText) refs.statusText.textContent = running ? sessionLabel(session) : inst.installed ? '准备就绪' : '尚未安装完成'
  if (refs.elapsed) refs.elapsed.textContent = running ? fmtDuration(Math.max(0, (session.elapsed || 0) / 1000)) : ''
  if (refs.launchBtn) {
    const sig = running ? (stopping ? 'stopping' : 'running') : 'idle'
    if (refs.sig !== sig) {
      refs.sig = sig
      refs.paintLaunch(running, stopping)
    }
  }
  // If the instance just finished installing, the hero badges need refreshing.
  const badge = refs.root?.querySelector('.lp-hero-badges .badge')
  if (badge && inst.installed) {
    badge.className = 'badge ok'
    badge.textContent = '已安装'
  }
}

function renderMetaStrip(inst, detail) {
  const session = sessionOf(inst.id)
  return h('div', { class: 'lp-meta-strip' },
    ui.metric('最后游玩', ui.lastPlayed(inst.lastPlayed)),
    ui.metric('累计时长', inst.playSeconds ? fmtDuration(inst.playSeconds) : '—'),
    ui.metric('启动次数', String(inst.launches || 0)),
    ui.metric('内存', `${Math.round((inst.memory?.min || 0) / 1024 * 10) / 10}G – ${Math.round((inst.memory?.max || 0) / 1024 * 10) / 10}G`),
    ui.metric('Java', inst.javaPath ? '手动指定' : '自动选择', session?.javaMajor ? `Java ${session.javaMajor}` : ''),
    ui.metric('游戏目录', inst.external ? '外部引用' : '启动器管理')
  )
}

function renderTabs(inst, detail) {
  const active = state.tab
  const counts = tabCounts(detail)
  const bar = h('div', { class: 'lp-tabs', role: 'tablist' })
  const body = h('div', { class: 'lp-tab-body' })
  for (const [id, label] of TABS) {
    const count = counts[id]
    const b = h('button', {
      class: 'lp-tab' + (id === active ? ' active' : ''),
      type: 'button',
      role: 'tab',
      'aria-selected': String(id === active),
      dataset: { tab: id }
    }, label, count ? h('span', { class: 'lp-tab-count' }, String(count)) : null)
    b.onclick = () => setTab(id)
    bar.appendChild(b)
  }
  const wrap = h('div', { class: 'lp-tabs-wrap' }, bar, body)
  state.tabRefs = { bar, body }
  return { wrap, body }
}

function tabCounts(detail) {
  const s = detail?.summary || {}
  return {
    mods: s.mods?.total || 0,
    resourcepacks: s.resourcePacks || 0,
    shaderpacks: s.shaderPacks || 0,
    worlds: s.worlds || 0,
    screenshots: s.screenshots || 0,
    servers: s.servers || 0,
    logs: s.logs || 0
  }
}

function updateTabCounts() {
  const detail = state.detail
  if (!detail || !state.tabRefs) return
  const counts = tabCounts(detail)
  for (const b of state.tabRefs.bar.querySelectorAll('.lp-tab')) {
    const id = b.dataset.tab
    let badge = b.querySelector('.lp-tab-count')
    const value = counts[id]
    if (!value) { badge?.remove(); continue }
    if (!badge) { badge = h('span', { class: 'lp-tab-count' }); b.appendChild(badge) }
    badge.textContent = String(value)
  }
}

function setTab(id) {
  if (state.tab === id) return
  state.tab = id
  state.tabRefs?.bar.querySelectorAll('.lp-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === id)
    b.setAttribute('aria-selected', String(b.dataset.tab === id))
  })
  const inst = selectedInstance()
  if (inst && state.tabRefs) mountTab(state.tabRefs.body, inst, id)
}

function destroyContent() {
  try { state.contentHandle?.destroy?.() } catch {}
  state.contentHandle = null
  state.contentToken++
}

async function mountTab(body, inst, tab) {
  destroyContent()
  clear(body)
  if (tab === 'overview') {
    await renderOverview(body, inst)
    return
  }
  const token = state.contentToken
  const loading = h('div', { class: 'lp-tab-loading' }, spinner(14), '正在读取…')
  body.appendChild(loading)
  try {
    const mod = await loadModule('content')
    if (token !== state.contentToken || state.tab !== tab) return
    clear(body)
    const handle = await mod.mountContentTab(body, { ...pageCtx(), instance: inst, tab })
    if (token !== state.contentToken) { handle?.destroy?.(); return }
    state.contentHandle = handle || null
  } catch (e) {
    if (token !== state.contentToken) return
    clear(body)
    body.appendChild(h('div', { class: 'lp-main-error' },
      icon('warning', { size: 22 }), h('b', {}, '这个页面加载失败'), h('p', {}, e.message)))
  }
}

/* ------------------------------------------------------------------ */
/* overview                                                           */
/* ------------------------------------------------------------------ */

async function renderOverview(container, inst) {
  const detail = state.detail
  const summary = detail?.summary || {}
  const session = sessionOf(inst.id)
  const grid = h('div', { class: 'lp-overview-grid' })
  const left = h('div', { class: 'lp-overview-col' })
  const right = h('div', { class: 'lp-overview-col' })
  grid.append(left, right)
  container.appendChild(grid)

  // Runtime console / crash
  if (isRunningSession(session)) {
    const live = h('div', { class: 'lp-live-console' })
    left.appendChild(ui.sectionCard({
      title: '游戏运行中',
      subtitle: `${sessionLabel(session)} · ${fmtDuration(Math.max(0, (session.elapsed || 0) / 1000))}`,
      actions: btn('查看完整日志', { size: 'sm', iconName: 'terminal', onClick: () => setTab('logs') }),
      body: live
    }))
    api.liveLog(inst.id, Math.max(0, (session.seq || 0) - 18)).then((data) => {
      if (!live.isConnected) return
      clear(live)
      const lines = (data.lines || []).slice(-18)
      live.appendChild(h('pre', { class: 'lp-live-lines' }, lines.length ? lines.map((l) => l.text).join('\n') : '等待游戏输出…'))
    }).catch(() => {})
  }

  if (detail?.status?.crash) {
    const crash = detail.status.crash
    const hints = (crash.hints || []).slice(0, 3)
    left.appendChild(ui.sectionCard({
      title: '上次启动的崩溃诊断',
      subtitle: crash.name || '崩溃报告',
      className: 'lp-card-danger',
      actions: btn('查看日志', { size: 'sm', onClick: () => setTab('logs') }),
      body: h('div', { class: 'lp-crash' },
        crash.description ? h('p', { class: 'lp-crash-desc' }, crash.description) : null,
        ...(hints.length ? hints.map((hint) => h('div', { class: 'lp-crash-hint' },
          h('b', {}, hint.title), h('span', {}, hint.suggestion || hint.detail))) : [h('p', { class: 'lp-hint' }, '请打开日志查看完整堆栈。')])
      )
    }))
  }

  // Launch configuration
  const account = selectedAccount()
  const configRows = h('div', { class: 'lp-rows' },
    ui.kvRow('账户', account ? `${account.name}（${ui.accountTypeLabel(account.type)}）` : '未登录'),
    ui.kvRow('Java', detail?.status?.session?.javaPath ? javaShort(detail.status.session.javaPath) : (inst.javaPath ? javaShort(inst.javaPath) : '启动时自动选择')),
    ui.kvRow('内存', `${inst.memory?.min || 0} MB – ${inst.memory?.max || 0} MB`),
    ui.kvRow('窗口', inst.fullscreen ? `全屏` : `${inst.width || 0} × ${inst.height || 0}`),
    ui.kvRow('自动进入服务器', inst.autoConnect && inst.server ? inst.server : '关闭'),
    ui.kvRow('JVM 参数', inst.jvmArgs || '使用启动器默认')
  )
  left.appendChild(ui.sectionCard({
    title: '启动配置',
    subtitle: '账户、内存、Java 与附加参数',
    actions: h('div', { class: 'lp-row-actions' },
      btn('修改', { size: 'sm', iconName: 'sliders', onClick: () => openInstanceSettings(inst) }),
      btn('命令预览', { size: 'sm', iconName: 'terminal', onClick: () => showCommandPreview(inst) })
    ),
    body: configRows
  }))

  // Instance information
  const infoRows = h('div', { class: 'lp-rows' },
    ui.kvRow('版本', inst.mc),
    ui.kvRow('加载器', ui.loaderLabel(inst)),
    ui.kvRow('版本 ID', inst.versionId || inst.mc),
    ui.kvRow('创建时间', fmtDateTime(inst.created)),
    ui.kvRow('游戏目录', detail?.paths?.gameDir || inst.paths?.gameDir || '—')
  )
  right.appendChild(ui.sectionCard({
    title: '实例信息',
    subtitle: inst.external ? '引用外部目录，不复制游戏文件' : '由启动器管理',
    actions: h('div', { class: 'lp-row-actions' },
      btn('打开目录', { size: 'sm', iconName: 'folder-open', onClick: () => openPath(detail?.paths?.gameDir || inst.paths?.gameDir || '') }),
      btn('检查修复', { size: 'sm', iconName: 'refresh', onClick: () => repairInstance(inst) })
    ),
    body: infoRows
  }))

  // Content summary
  const summaryGrid = h('div', { class: 'lp-summary-grid' })
  const cards = [
    ['模组', summary.mods?.total || 0, `${summary.mods?.enabled || 0} 启用 · ${summary.mods?.disabled || 0} 禁用`, 'mods', 'package-down'],
    ['资源包', summary.resourcePacks || 0, 'resourcepacks', 'resourcepacks', 'archive'],
    ['光影', summary.shaderPacks || 0, 'shaderpacks', 'shaderpacks', 'bolt'],
    ['世界', summary.worlds || 0, 'saves', 'worlds', 'map'],
    ['截图', summary.screenshots || 0, 'screenshots', 'screenshots', 'eye'],
    ['服务器', summary.servers || 0, 'servers.dat', 'servers', 'server']
  ]
  for (const [label, value, sub, tab, iconName] of cards) {
    const tile = h('button', { class: 'lp-summary-tile', type: 'button', onclick: () => setTab(tab) },
      h('span', { class: 'lp-summary-icon' }, icon(iconName, { size: 16 })),
      h('span', { class: 'lp-summary-main' }, h('b', {}, String(value)), h('span', {}, label)),
      h('span', { class: 'lp-summary-sub' }, sub)
    )
    summaryGrid.appendChild(tile)
  }
  right.appendChild(ui.sectionCard({
    title: '实例内容',
    subtitle: '模组、资源包、世界与服务器',
    body: summaryGrid
  }))

  // Recent log
  const logSlot = h('div', { class: 'lp-log-preview' }, h('div', { class: 'lp-tab-loading' }, spinner(12), '读取日志…'))
  right.appendChild(ui.sectionCard({
    title: '最近日志',
    subtitle: '启动器捕获的 stdout / stderr',
    actions: h('div', { class: 'lp-row-actions' },
      iconBtn('refresh', { size: 13, label: '刷新日志', onClick: () => loadRecentLog(logSlot, inst) }),
      btn('完整日志', { size: 'sm', iconName: 'terminal', onClick: () => setTab('logs') })
    ),
    body: logSlot
  }))
  loadRecentLog(logSlot, inst)

  // News
  const newsSlot = h('div', { class: 'lp-news-slot' })
  left.appendChild(ui.sectionCard({
    title: '版本动态',
    subtitle: '来自 Mojang 官方 Java 版更新日志',
    actions: btn('刷新', { size: 'sm', iconName: 'refresh', onClick: () => { state.news = null; renderNewsInto(newsSlot, { compact: false, force: true }) } }),
    body: newsSlot
  }))
  renderNewsInto(newsSlot, { compact: false })

  // Quick actions
  const quick = h('div', { class: 'lp-quick-grid' })
  for (const [label, iconName, fn] of [
    ['打开游戏目录', 'folder-open', () => openPath(detail?.paths?.gameDir || inst.paths?.gameDir || '')],
    ['打开日志目录', 'terminal', () => openPath(detail?.paths?.logsDir || inst.paths?.logsDir || '')],
    ['检查并修复文件', 'refresh', () => repairInstance(inst)],
    ['复制实例', 'copy', () => duplicateInstance(inst)],
    ['导出实例配置', 'save', () => exportInstance(inst)],
    ['删除实例', 'trash', () => deleteInstanceAction(inst)]
  ]) {
    const b = h('button', { class: 'lp-quick' + (label === '删除实例' ? ' danger' : ''), type: 'button' },
      icon(iconName, { size: 15 }), h('span', {}, label))
    b.onclick = fn
    quick.appendChild(b)
  }
  left.appendChild(ui.sectionCard({ title: '快捷操作', body: quick }))
}

function javaShort(path) {
  const text = String(path || '')
  const home = text.replace(/[\\/]bin[\\/]java(w)?\.exe$/i, '')
  return home || text
}

async function loadRecentLog(slot, inst) {
  try {
    const session = sessionOf(inst.id)
    let lines = []
    if (isRunningSession(session)) {
      const data = await api.liveLog(inst.id, Math.max(0, (session.seq || 0) - 24))
      lines = (data.lines || []).map((l) => l.text)
    } else {
      const data = await api.savedLog(inst.id)
      lines = (data.lines || []).slice(-24)
    }
    if (!slot.isConnected) return
    clear(slot)
    if (!lines.length) {
      slot.appendChild(h('div', { class: 'lp-hint' }, '还没有启动记录。第一次启动后这里会显示输出。'))
      return
    }
    slot.appendChild(h('pre', { class: 'lp-log-lines' }, lines.join('\n')))
  } catch (e) {
    if (!slot.isConnected) return
    clear(slot)
    slot.appendChild(h('div', { class: 'lp-hint' }, '读取日志失败：' + e.message))
  }
}

async function renderNewsInto(slot, { compact = false, force = false } = {}) {
  if (!slot) return
  clear(slot)
  if (state.news) { paintNews(slot, compact); return }
  slot.appendChild(h('div', { class: 'lp-tab-loading' }, spinner(12), '正在读取 Mojang 资讯…'))
  if (state.newsLoading) return
  state.newsLoading = true
  try {
    const data = await api.news(force)
    state.news = data
    if (slot.isConnected) paintNews(slot, compact)
  } catch (e) {
    if (slot.isConnected) slot.appendChild(h('div', { class: 'lp-hint' }, '资讯加载失败：' + e.message))
  } finally {
    state.newsLoading = false
  }
}

function paintNews(slot, compact) {
  clear(slot)
  const news = state.news
  if (!news) return
  const latest = news.latest || {}
  const head = h('div', { class: 'lp-news-head' },
    h('div', { class: 'lp-news-version' },
      h('span', { class: 'lp-news-label' }, '最新正式版'),
      h('b', {}, latest.release || '—')
    ),
    latest.snapshot ? h('div', { class: 'lp-news-version' },
      h('span', { class: 'lp-news-label' }, '最新快照'),
      h('b', {}, latest.snapshot)
    ) : null
  )
  slot.appendChild(head)
  const list = h('div', { class: 'lp-news-list' })
  const patches = (news.patches || []).slice(0, compact ? 2 : 4)
  for (const item of patches) {
    list.appendChild(h('div', { class: 'lp-news-item' },
      h('div', { class: 'lp-news-item-main' },
        h('b', {}, item.title || item.version || '版本更新'),
        h('span', {}, `${item.version || ''}${item.type ? ' · ' + item.type : ''}${item.date ? ' · ' + item.date : ''}`)
      )
    ))
  }
  if (!patches.length) list.appendChild(h('div', { class: 'lp-hint' }, '暂无可显示的更新日志。'))
  slot.appendChild(list)
}

/* ------------------------------------------------------------------ */
/* actions                                                            */
/* ------------------------------------------------------------------ */

async function launchSelected() {
  const inst = selectedInstance()
  if (!inst) { showView('install'); return }
  if (!inst.installed) { toast('实例尚未安装完成，先执行“检查并修复文件”', 'warn'); return }
  const account = selectedAccount()
  if (!account) {
    toast('请先添加并选择一个账户', 'warn')
    openAccounts()
    return
  }
  try {
    const refs = state.heroRefs
    if (refs?.launchBtn) refs.launchBtn.disabled = true
    await api.launch(inst.id, account.id)
    toast('正在启动 Minecraft…', 'ok')
    await pollStatus(true)
    setTab('logs')
    if (state.settings?.closeOnLaunch) {
      setTimeout(() => { try { navigator.sendBeacon('/api/shutdown') } catch {} }, 2500)
    }
  } catch (e) {
    if (refs?.launchBtn) refs.launchBtn.disabled = false
    showLaunchError(e, inst)
  }
}

function showLaunchError(error, inst) {
  const box = h('div', { class: 'lp-launch-error' },
    icon('warning', { size: 20 }),
    h('div', {},
      h('b', {}, '启动失败'),
      h('p', {}, error.message || String(error)),
      h('p', { class: 'lp-hint' }, '常见原因：Java 版本不匹配、文件不完整、账户登录过期或模组冲突。')
    )
  )
  const modal = openModal({
    title: '无法启动 ' + inst.name,
    size: 'md',
    body: box,
    buttons: [
      { label: '关闭', class: 'btn-ghost' },
      { label: '检查并修复文件', class: 'btn-primary', onClick: () => { modal.close(); repairInstance(inst) } }
    ]
  })
}

async function stopSelected() {
  const inst = selectedInstance()
  if (!inst) return
  if (!(await confirmDialog(`停止「${inst.name}」的游戏进程？未保存的世界进度可能丢失。`, { danger: true, okText: '停止游戏' }))) return
  try {
    await api.stop(inst.id, true)
    toast('已请求停止游戏', 'ok')
    await pollStatus(true)
  } catch (e) {
    toast('停止失败：' + e.message, 'err')
  }
}

async function repairInstance(inst) {
  try {
    const result = await api.repairInstance(inst.id)
    toast('已开始检查并修复文件', 'ok')
    await pollStatus(true)
    if (result?.job?.id) state.lastJobState.set(result.job.id, result.job.status)
  } catch (e) {
    toast('无法修复：' + e.message, 'err')
  }
}

async function duplicateInstance(inst) {
  const name = `${inst.name} 副本`
  if (!(await confirmDialog(`复制实例「${inst.name}」？游戏目录也会被复制，可能需要一些时间。`, { okText: '复制' }))) return
  try {
    const copy = await api.duplicateInstance(inst.id, name)
    toast('实例已复制', 'ok')
    await refreshAll()
    if (copy?.id) await selectInstance(copy.id)
  } catch (e) {
    toast('复制失败：' + e.message, 'err')
  }
}

async function exportInstance(inst) {
  const payload = {
    type: 'mc-toolbox-instance',
    version: 1,
    exportedAt: Date.now(),
    instance: {
      name: inst.name,
      mc: inst.mc,
      loader: inst.loader,
      loaderVersion: inst.loaderVersion,
      memory: inst.memory,
      jvmArgs: inst.jvmArgs,
      gameArgs: inst.gameArgs,
      width: inst.width,
      height: inst.height,
      fullscreen: inst.fullscreen,
      server: inst.server,
      autoConnect: inst.autoConnect,
      notes: inst.notes
    }
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${inst.name.replace(/[<>:"/\\|?*]/g, '_')}.mc-toolbox.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1500)
  toast('实例配置已导出（不含游戏文件）', 'ok')
}

async function deleteInstanceAction(inst) {
  const message = inst.external
    ? `从列表中移除「${inst.name}」？这是外部引用的实例，原 .minecraft 文件不会被删除。`
    : `删除「${inst.name}」？将删除实例目录（模组、存档、截图、日志会一起删除），共享的版本文件与资源库不会删除。`
  if (!(await confirmDialog(message, { danger: true, okText: '删除实例' }))) return
  try {
    await api.deleteInstance(inst.id)
    toast('实例已删除', 'ok')
    state.selectedId = ''
    state.detail = null
    await refreshAll()
    if (state.instances.length) await selectInstance(state.instances[0].id)
  } catch (e) {
    toast('删除失败：' + e.message, 'err')
  }
}

function openInstanceMenu(e, inst) {
  const rect = e.currentTarget?.getBoundingClientRect?.() || e.target.getBoundingClientRect()
  openContextMenu({
    x: rect.right - 8,
    y: rect.bottom + 4,
    label: inst.name,
    items: [
      { label: inst.installed ? '启动游戏' : '检查并修复文件', iconName: inst.installed ? 'play' : 'refresh', onClick: () => inst.installed ? launchSelected() : repairInstance(inst) },
      { label: '实例设置', iconName: 'settings', onClick: () => openInstanceSettings(inst) },
      { label: '打开游戏目录', iconName: 'folder-open', onClick: () => openPath(inst.paths?.gameDir || '') },
      { label: '打开日志目录', iconName: 'terminal', onClick: () => openPath(inst.paths?.logsDir || '') },
      { separator: true },
      { label: '复制启动命令', iconName: 'copy', onClick: () => showCommandPreview(inst, true) },
      { label: '导出实例配置', iconName: 'save', onClick: () => exportInstance(inst) },
      { label: '复制实例', iconName: 'copy', onClick: () => duplicateInstance(inst) },
      { separator: true },
      { label: '删除实例', iconName: 'trash', danger: true, onClick: () => deleteInstanceAction(inst) }
    ]
  })
}

async function showCommandPreview(inst, copy = false) {
  try {
    const preview = await api.preview(inst.id)
    if (copy) {
      const ok = await copyText(preview.preview)
      toast(ok ? '启动命令已复制（访问令牌已隐藏）' : '复制失败', ok ? 'ok' : 'err')
      return
    }
    openModal({
      title: '启动命令预览',
      size: 'xl',
      body: h('div', { class: 'lp-preview' },
        h('pre', { class: 'lp-pre' }, preview.preview),
        preview.missing?.length ? h('div', { class: 'lp-hint' }, `缺少 ${preview.missing.length} 个文件：` + preview.missing.slice(0, 8).join('、')) : null
      ),
      buttons: [
        { label: '复制', class: 'btn', onClick: async () => { const ok = await copyText(preview.preview); toast(ok ? '已复制' : '复制失败', ok ? 'ok' : 'err') } },
        { label: '关闭', class: 'btn-ghost' }
      ]
    })
  } catch (e) {
    toast('无法生成启动命令：' + e.message, 'err')
  }
}

/* ------------------------------------------------------------------ */
/* instance settings                                                  */
/* ------------------------------------------------------------------ */

async function openInstanceSettings(inst) {
  const javaList = await api.java(false, inst.mc).catch(() => ({ items: [] }))
  const javaPaths = (javaList.items || []).map((item) => item.path)
  if (inst.javaPath && !javaPaths.includes(inst.javaPath)) javaPaths.unshift(inst.javaPath)
  const name = input({ value: inst.name })
  const group = input({ value: inst.group || '', placeholder: '例如：整合包 / 1.20.1' })
  const memoryMin = input({ type: 'number', value: inst.memory?.min || 1024, min: 256, max: 262144 })
  const memoryMax = input({ type: 'number', value: inst.memory?.max || 4096, min: 256, max: 262144 })
  const width = input({ type: 'number', value: inst.width || 1280, min: 0, max: 7680 })
  const height = input({ type: 'number', value: inst.height || 720, min: 0, max: 4320 })
  const fullscreen = toggle(!!inst.fullscreen, () => {})
  const server = input({ value: inst.server || '', placeholder: 'mc.example.com 或 mc.example.com:25565' })
  const autoConnect = toggle(!!inst.autoConnect, () => {})
  const jvmArgs = h('textarea', { class: 'input mono', rows: '2', placeholder: '-XX:+UseG1GC …' }, inst.jvmArgs || '')
  const jvmState = h('span', { class: 'lp-hint' }, hasOptimizedJvm(inst.jvmArgs) ? '已应用一键优化参数' : '可一键写入适合大型整合包的 G1 参数')
  const optimizeBtn = btn('一键优化', {
    size: 'sm', iconName: 'bolt', title: '写入 Aikar 风格 G1 参数（不会改动内存设置）',
    onClick: () => {
      const before = jvmArgs.value
      jvmArgs.value = optimizedJvmArgs(before)
      jvmState.textContent = jvmArgs.value === before ? '参数已经是最优状态' : '已写入一键优化参数'
      toast(jvmArgs.value === before ? 'JVM 参数已经优化' : '已写入一键优化 JVM 参数，保存后生效', 'ok')
    }
  })
  const gameArgs = h('textarea', { class: 'input mono', rows: '2', placeholder: '--fullscreen …' }, inst.gameArgs || '')
  const notes = h('textarea', { class: 'input', rows: '2', placeholder: '备注（仅本地）' }, inst.notes || '')
  const javaSelect = select([
    ['', '自动选择（推荐）'],
    ...javaPaths.map((p) => [p, javaRuntimeOption(p, javaList.items?.find((x) => x.path === p))])
  ], inst.javaPath || '')

  const grid = h('div', { class: 'lp-settings-grid' },
    field('实例名称', name),
    field('分组', group, { hint: '用于侧栏显示，可留空' }),
    field('初始内存（MB）', memoryMin),
    field('最大内存（MB）', memoryMax, { hint: '建议 4096–12288；过小会导致大型整合包崩溃' }),
    field('窗口宽度', width),
    field('窗口高度', height),
    h('div', { class: 'lp-switch-row' }, h('div', {}, h('b', {}, '全屏启动'), h('span', {}, '覆盖窗口尺寸')), fullscreen),
    h('div', { class: 'lp-switch-row' }, h('div', {}, h('b', {}, '自动进入服务器'), h('span', {}, '启动后直接连接下面的地址')), autoConnect),
    field('服务器地址', server, { hint: '用于自动连接；支持 host:port 与 [IPv6]:port' }),
    field('Java 运行时', javaSelect, { hint: `当前实例需要 Java ${javaList.required || '—'}；留空自动选择兼容版本` }),
    h('div', { class: 'lp-span-2' }, field('附加 JVM 参数', h('div', { class: 'lp-jvm-field' },
      h('div', { class: 'lp-jvm-tools' }, jvmState, optimizeBtn), jvmArgs), { hint: '每行或空格分隔；请勿重复设置 -Xmx。一键优化只写入 GC 参数。' })),
    h('div', { class: 'lp-span-2' }, field('附加游戏参数', gameArgs)),
    h('div', { class: 'lp-span-2' }, field('备注', notes)),
    h('div', { class: 'lp-span-2 lp-hint' },
      inst.external
        ? `外部实例：游戏目录 ${inst.paths?.gameDir || ''}，删除实例不会删除原目录。`
        : `游戏目录：${inst.paths?.gameDir || ''}`)
  )

  const modal = openModal({
    title: '实例设置 · ' + inst.name,
    size: 'lg',
    body: grid,
    buttons: [
      { label: '取消', class: 'btn-ghost' },
      {
        label: '保存', class: 'btn-primary', onClick: async () => {
          const min = Math.round(Number(memoryMin.value) || 0)
          const max = Math.round(Number(memoryMax.value) || 0)
          if (min < 256 || max < min) { toast('内存设置无效：初始内存不能大于最大内存', 'err'); return }
          try {
            await api.updateInstance(inst.id, {
              name: name.value.trim() || inst.name,
              group: group.value.trim(),
              memory: { min, max },
              width: Math.max(0, Math.round(Number(width.value) || 0)),
              height: Math.max(0, Math.round(Number(height.value) || 0)),
              fullscreen: fullscreen.querySelector('input')?.checked === true,
              server: server.value.trim(),
              autoConnect: autoConnect.querySelector('input')?.checked === true,
              javaPath: javaSelect.value,
              jvmArgs: jvmArgs.value.trim(),
              gameArgs: gameArgs.value.trim(),
              notes: notes.value.trim()
            })
            modal.close()
            toast('实例设置已保存', 'ok')
            await refreshAll()
          } catch (e) {
            toast('保存失败：' + e.message, 'err')
          }
        }
      }
    ]
  })
}

function javaRuntimeOption(path, info) {
  if (!info) return path
  return `Java ${info.major}${info.bundled ? '（工具箱）' : ''} · ${path}`
}

/* ------------------------------------------------------------------ */
/* accounts / settings / import                                      */
/* ------------------------------------------------------------------ */

async function openAccounts() {
  try {
    const mod = await loadModule('accounts')
    mod.openAccountManager({
      ...pageCtx(),
      onChanged: async (accounts) => {
        state.accounts = accounts || state.accounts
        renderAccountCard()
        if (state.view === 'instance') renderMain()
      }
    })
  } catch (e) {
    toast('账户面板加载失败：' + e.message, 'err')
  }
}

async function openLauncherSettings() {
  try {
    const mod = await loadModule('settings')
    mod.openLauncherSettings({
      ...pageCtx(),
      onSaved: async (settings) => {
        if (settings) state.settings = settings
        await loadBootstrap({ silent: true })
        if (state.view === 'instance') renderMain()
      }
    })
  } catch (e) {
    toast('设置面板加载失败：' + e.message, 'err')
  }
}

/* ------------------------------------------------------------------ */
/* polling / statusbar                                                */
/* ------------------------------------------------------------------ */

async function pollStatus(force = false) {
  if (!state.active && !force) return
  if (!force && Date.now() - lastPollAt < 1200) return
  lastPollAt = Date.now()
  try {
    const [data, community] = await Promise.all([
      api.status(),
      api.communityJobs().catch(() => ({ items: [] }))
    ])
    state.sessions = data.sessions || []
    state.jobs = data.jobs || []
    state.communityJobs = community.items || []
    updateRunningIndicators()
    updateHeroRuntime()
    detectJobChanges()
    emitStatus()
  } catch {}
}

function detectJobChanges() {
  const active = state.jobs.filter((job) => ['queued', 'running', 'installing', 'cancelling'].includes(job.status))
  const communityActive = (state.communityJobs || []).filter((job) => ['queued', 'running', 'installing'].includes(job.status))
  const totalActive = active.length + communityActive.length
  let finished = null
  for (const job of state.jobs) {
    const prev = state.lastJobState.get(job.id)
    if (prev && prev !== job.status && ['done', 'failed', 'cancelled'].includes(job.status) && !state.finishedNotified.has(job.id)) {
      state.finishedNotified.add(job.id)
      finished = job
    }
    state.lastJobState.set(job.id, job.status)
  }
  if (finished) {
    if (finished.status === 'done') {
      const kind = finished.type === 'pack' ? '整合包' : finished.type === 'update' ? '模组更新' : finished.type === 'repair' ? '修复' : '实例'
      toast(`${kind}「${finished.name || finished.mc}」完成`, 'ok')
      refreshAll().then(() => {
        if (finished.instanceId && state.instances.some((item) => item.id === finished.instanceId)) {
          if (!state.selectedId) selectInstance(finished.instanceId)
        }
      })
    } else if (finished.status === 'failed') {
      toast(`安装失败：${finished.error || finished.detail || '请查看任务日志'}`, 'err')
    }
  }
  const nav = navWrapEl?.querySelector('[data-nav="downloads"]')
  if (nav) {
    let badge = nav.querySelector('.lp-nav-badge')
    if (totalActive) {
      if (!badge) { badge = h('span', { class: 'lp-nav-badge' }); nav.appendChild(badge) }
      badge.textContent = String(totalActive)
    } else badge?.remove()
  }
}

function emitStatus() {
  const running = state.sessions.filter(isRunningSession)
  const selectedSession = sessionOf(state.selectedId)
  const activeJobs = state.jobs.filter((job) => ['queued', 'running', 'installing'].includes(job.status)).length +
    (state.communityJobs || []).filter((job) => ['queued', 'running', 'installing'].includes(job.status)).length
  bus.emit('launcher:status', {
    runningCount: running.length,
    activeJobs,
    selected: selectedInstance()?.name || '',
    session: selectedSession || null,
    account: selectedAccount()?.name || ''
  })
}

function startPolling() {
  stopPolling()
  pollStatus(true)
  state.pollTimer = setInterval(() => { pollStatus(false) }, 2200)
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer)
  state.pollTimer = null
}

function stopBackgroundStatus() {
  if (state.backgroundTimer) clearInterval(state.backgroundTimer)
  state.backgroundTimer = null
}

function startBackgroundStatus() {
  stopBackgroundStatus()
  state.backgroundTimer = setInterval(async () => {
    try {
      const [data, community] = await Promise.all([
        api.status(),
        api.communityJobs().catch(() => ({ items: [] }))
      ])
      state.sessions = data.sessions || []
      state.jobs = data.jobs || []
      state.communityJobs = community.items || []
      emitStatus()
    } catch {}
  }, 10000)
}

/* ------------------------------------------------------------------ */
/* lifecycle / commands                                               */
/* ------------------------------------------------------------------ */

async function activate() {
  state.active = true
  stopBackgroundStatus()
  rootEl.hidden = false
  if (!state.ready) return
  startPolling()
  if (state.view === 'instance') {
    if (state.selectedId) {
      await loadDetail(state.selectedId, { render: false })
      renderMain()
    } else {
      renderMain()
    }
  }
  emitStatus()
}

function deactivate() {
  state.active = false
  stopPolling()
  destroyContent()
  startBackgroundStatus()
}

function destroy() {
  deactivate()
  stopBackgroundStatus()
  state.installController?.destroy?.()
  state.javaController?.destroy?.()
  state.downloadsController?.destroy?.()
  state.installController = null
  state.javaController = null
  state.downloadsController = null
  closeContextMenu()
}

function commandItems() {
  const inst = selectedInstance()
  const account = selectedAccount()
  const items = [
    {
      group: '启动器',
      label: inst ? `启动 ${inst.name}` : '新建 Minecraft 实例',
      hint: inst && account ? account.name : '需要账户',
      iconName: 'play',
      run: () => inst ? (isRunningSession(sessionOf(inst.id)) ? stopSelected() : launchSelected()) : showView('install')
    },
    { group: '启动器', label: '下载中心', iconName: 'download', run: () => showView('downloads') },
    { group: '启动器', label: '新建实例 / 安装版本', iconName: 'add', run: () => showView('install') },
    { group: '启动器', label: '账户管理', hint: account ? account.name : '未登录', iconName: 'user', run: () => openAccounts() },
    { group: '启动器', label: 'Java 运行时', iconName: 'java', run: () => showView('java') },
    { group: '启动器', label: '启动器设置', iconName: 'settings', run: () => openLauncherSettings() }
  ]
  if (inst) {
    items.push(
      { group: '启动器', label: '实例设置', hint: inst.name, iconName: 'sliders', run: () => openInstanceSettings(inst) },
      { group: '启动器', label: '打开游戏目录', iconName: 'folder-open', run: () => openPath(inst.paths?.gameDir || '') },
      { group: '启动器', label: '实例日志', iconName: 'terminal', run: () => { state.view = 'instance'; setTab('logs'); updateNav() } }
    )
  }
  return items
}

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (!state.active) return
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return
    if (e.target.closest('input, textarea, select, [contenteditable]')) return
    e.preventDefault()
    const inst = selectedInstance()
    if (!inst) return
    if (isRunningSession(sessionOf(inst.id))) stopSelected()
    else launchSelected()
  })
  rootEl.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return
    e.preventDefault()
    rootEl.classList.add('is-drop')
  })
  rootEl.addEventListener('dragleave', (e) => {
    if (e.target === rootEl) rootEl.classList.remove('is-drop')
  })
  rootEl.addEventListener('drop', async (e) => {
    const files = [...(e.dataTransfer.files || [])]
    if (!files.length) return
    e.preventDefault()
    rootEl.classList.remove('is-drop')
    const file = files[0]
    if (!/\.(mrpack|zip)$/i.test(file.name)) { toast('请拖入 .mrpack 或整合包 ZIP', 'warn'); return }
    try {
      const result = await api.packUpload(file, { name: '' })
      toast('整合包上传完成，正在安装…', 'ok')
      await showView('install')
      if (result?.job?.id) state.lastJobState.set(result.job.id, result.job.status)
      await pollStatus(true)
    } catch (err) {
      toast('整合包上传失败：' + err.message, 'err')
    }
  })
}

export { pageCtx, state }
