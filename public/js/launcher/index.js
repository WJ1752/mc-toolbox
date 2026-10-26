// 启动器主页面：实例侧栏、实例主页、下载中心 / Java 视图切换。
// 工作台仍然是独立页面，由 app.js 的页面切换控制；本模块只负责启动器。
// v1.9：实例启动阶段进度、结构化失败面板（含概览崩溃诊断）与导出整合包入口。
import {
  h, clear, debounce, escapeHtml, fmtBytes, fmtAgo, fmtDuration, fmtDateTime, copyText
} from '../core/dom.js'
import { toast } from '../core/toast.js'
import { confirmDialog, openModal } from '../core/modal.js'
import { pickDir, pickFile } from '../core/dirpicker.js'
import { btn, field, input, select, toggle, progress, spinner, iconBtn, openPath } from '../ui/kit.js'
import { icon } from '../ui/icons.js'
import { openContextMenu, closeContextMenu } from '../ui/contextmenu.js'
import { bus } from '../core/bus.js'
import { launcherApi as api } from './api.js'
import * as ui from './ui.js'
import { optimizedJvmArgs, hasOptimizedJvm } from './jvm.js'
import { openGameDirSetup } from './setup.js'
import { initUpdateChecker, disposeUpdateChecker, checkForUpdates } from './update.js'

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

// 启动阶段中文文案与错误码映射：服务端会返回 phaseLabel，这里只做兜底与说明。
const LAUNCH_PHASE_LABELS = {
  account: '校验账户',
  version: '解析版本与继承链',
  java: '检查并选择 Java',
  files: '校验客户端文件',
  natives: '解压 natives',
  spawn: '启动 Java 进程',
  window: '等待游戏窗口出现'
}

const LAUNCH_ERROR_ACTIONS = {
  NO_ACCOUNT: ['copy'],
  NO_JAVA: ['select-java', 'open-logs', 'copy'],
  JAVA_TOO_OLD: ['select-java', 'open-logs', 'copy'],
  VERSION_JSON_MISSING: ['repair', 'open-game-dir', 'open-logs', 'copy'],
  MISSING_FILES: ['repair', 'open-logs', 'copy'],
  EXTERNAL_DIR_UNWRITABLE: ['open-game-dir', 'open-logs', 'copy'],
  ALREADY_RUNNING: ['open-logs', 'copy'],
  SPAWN_FAILED: ['select-java', 'open-logs', 'copy'],
  GAME_CRASHED: ['open-logs', 'copy'],
  GAME_EXITED: ['open-logs', 'copy']
}

const LAUNCH_ERROR_REASONS = {
  NO_ACCOUNT: '启动前没有找到可用的账户。请先在账户管理中添加或选择一个账户。',
  NO_JAVA: '没有找到可用的 Java 运行时。请安装当前版本要求的 Java，然后在实例设置中手动指定。',
  JAVA_TOO_OLD: '本机 Java 版本低于当前 Minecraft 版本的要求。请安装更高版本的 Java，或在实例设置里选择兼容的运行时。',
  VERSION_JSON_MISSING: '版本 JSON 缺失，或 inheritsFrom 继承链断开。可以重新安装该版本，或检查版本目录是否完整。',
  MISSING_FILES: '客户端 JAR、libraries、assets 或 natives 不完整。点击“检查并修复文件”可以重新下载缺失内容。',
  EXTERNAL_DIR_UNWRITABLE: '外部游戏目录不可写。启动器需要写入日志、natives 等运行文件，请检查目录权限，或改用启动器管理的实例。',
  ALREADY_RUNNING: '这个实例已经在启动或运行中，请先停止当前游戏。',
  SPAWN_FAILED: 'Java 进程没有成功启动，常见原因是 Java 路径错误、内存参数过大或系统权限限制。',
  GAME_CRASHED: '游戏进程异常退出并留下了崩溃报告。请查看日志与崩溃诊断，优先检查模组冲突或内存不足。',
  GAME_EXITED: '游戏进程启动后异常退出（退出码非 0）。请查看日志末尾的错误信息。'
}

// 导出任务状态与格式文案（与后端 pack-export 的任务字段对应）。
const EXPORT_FORMATS = { mrpack: 'Modrinth 整合包', zip: '通用整合包' }
const EXPORT_ACTIVE = new Set(['queued', 'running', 'installing', 'cancelling'])
const EXPORT_FINISHED = new Set(['done', 'failed', 'cancelled'])
const EXPORT_STATUS = {
  queued: { label: '排队中', tone: 'warn' },
  running: { label: '导出中', tone: 'info' },
  installing: { label: '导出中', tone: 'info' },
  cancelling: { label: '取消中', tone: 'warn' },
  done: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'bad' },
  cancelled: { label: '已取消', tone: '' }
}

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
  detection: null,
  detectionErrorShown: false,
  stoppingIds: new Set(),
  jobs: [],
  communityJobs: [],
  detail: null,
  detailToken: 0,
  tab: 'overview',
  view: 'instance',
  search: '',
  news: null,
  newsLoading: false,
  community: null,
  lastJobState: new Map(),
  finishedNotified: new Set(),
  installController: null,
  javaController: null,
  downloadsController: null,
  friendsController: null,
  // 下载中心 → 新建实例 的一次性请求：{ path, auto, token }，由安装页消费后清空。
  pendingPackInstall: null,
  // 整页拖入的整合包 File：安装页完成渲染后消费并立即上传。
  pendingPackFile: null,
  contentHandle: null,
  contentToken: 0,
  heroRefs: null,
  // 启动进度：按 instanceId 保存 GET /instances/:id/status 返回的 launch 状态。
  // 与 state.detail 分离，切换 tab / 重绘 hero 时不会丢失。
  launchStates: new Map(),
  launchInflight: new Map(),
  launchErrorToasts: new Map(),
  overviewLaunchSlot: null,
  runningPanelSlot: null,
  pollTimer: null,
  backgroundTimer: null,
  setupOpen: false
}

let rootEl = null
let sideEl = null
let mainEl = null
let helpers = {}
let instanceListEl = null
let accountWrapEl = null
let countEl = null
let runCountEl = null
let navWrapEl = null
let searchInputEl = null
let lastPollAt = 0
let lastLaunchPollAt = 0
// 整页拖放遮罩：外部文件拖入时显示「松开以安装整合包」。
// 浏览器在拖拽取消、拖出窗口或窗口失焦时不保证触发 dragleave，因此除了
// 事件计数，还用看门狗定时器自愈，避免遮罩永久卡住页面。
let dropOverlayTimer = null
const DROP_OVERLAY_TTL = 1500

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

function runningSessions() {
  return (state.sessions || []).filter(isRunningSession)
}

/** 「外部进程」= 启动器重启后从系统进程表接管的游戏，不是本次内存 session。 */
function sessionSourceLabel(session) {
  return session?.detected ? '外部进程' : '启动器启动'
}

function sessionRuntimeText(session) {
  if (!session) return ''
  const parts = [sessionLabel(session), sessionSourceLabel(session)]
  if (session.pid) parts.push('PID ' + session.pid)
  return parts.join(' · ')
}

/* ------------------------------------------------------------------ */
/* launch helpers（纯函数，便于单测）                                  */
/* ------------------------------------------------------------------ */

function launchOf(instanceId) {
  return instanceId ? state.launchStates.get(instanceId) || null : null
}

function isPreparingLaunch(launch) {
  return !!launch && (launch.status === 'preparing' || launch.status === 'spawning')
}

function defaultLaunchActions(code) {
  return [...(LAUNCH_ERROR_ACTIONS[code] || ['repair', 'open-logs', 'copy'])]
}

/** 阶段文案：`正在准备启动 · 3/7 校验客户端文件`。 */
export function launchPhaseText(launch) {
  if (!launch || !launch.status) return ''
  const status = launch.status
  if (status === 'running') return '游戏运行中'
  if (status === 'failed') return '启动失败'
  if (status === 'cancelled') return '已取消启动'
  if (status === 'exited') return '游戏已退出'
  if (status === 'idle') return ''
  const phaseLabel = launch.phaseLabel || LAUNCH_PHASE_LABELS[launch.phase] || ''
  const step = Math.max(0, Number(launch.step) || 0)
  const total = Math.max(0, Number(launch.total) || 0)
  const stage = step && total ? `${Math.min(step, total)}/${total} ` : ''
  const prefix = status === 'spawning' ? '正在启动游戏' : '正在准备启动'
  // 没有阶段名时只显示进度，避免出现“正在准备启动 · 准备启动”的重复文案。
  if (!phaseLabel) return stage ? `${prefix} · ${stage.trim()}` : prefix
  return `${prefix} · ${stage}${phaseLabel}`
}

/** 进度条数值：只有真实进度才返回数字，其余为 indeterminate。 */
export function launchProgressInfo(launch) {
  if (!launch) return { value: null, indeterminate: true }
  if (launch.status === 'running') return { value: 100, indeterminate: false }
  // Number(null) === 0，必须显式排除空值，避免把“不确定进度”画成 0%。
  if (launch.indeterminate === true || launch.progress === null || launch.progress === undefined || launch.progress === '') {
    return { value: null, indeterminate: true }
  }
  const value = Number(launch.progress)
  const terminable = !['failed', 'cancelled', 'exited', 'idle'].includes(launch.status)
  if (terminable && Number.isFinite(value) && value >= 0) {
    return { value: Math.max(0, Math.min(100, value)), indeterminate: false }
  }
  return { value: null, indeterminate: true }
}

/**
 * 统一服务端结构化错误、Error 实例与 status.launch.error 的字段。
 * 保证返回对象一定包含 code/message/detail/missing/missingCount/paths/actions/crash。
 */
export function normalizeLaunchError(input, { message = '启动失败' } = {}) {
  if (!input) return null
  let raw = input
  if (raw && typeof raw === 'object' && raw.status && 'error' in raw) raw = raw.error
  else if (raw && typeof raw === 'object' && raw.error && typeof raw.error === 'object') raw = raw.error
  if (!raw || typeof raw !== 'object') {
    return {
      code: '',
      message: String(raw || message),
      detail: '',
      missing: [],
      missingCount: 0,
      paths: {},
      actions: ['copy'],
      crash: null,
      logFile: ''
    }
  }
  const code = String(raw.code || '')
  const missing = Array.isArray(raw.missing)
    ? raw.missing.filter(Boolean).map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') {
        const value = item.path || item.file || item.name || item.id
        if (value) return String(value)
      }
      return String(item)
    })
    : []
  const actions = Array.isArray(raw.actions) && raw.actions.length
    ? raw.actions.map((item) => String(item))
    : defaultLaunchActions(code)
  // 复制错误信息始终可用，避免面板没有可执行按钮。
  if (!actions.includes('copy')) actions.push('copy')
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {}
  const rawDetail = raw.detail || raw.cause?.message || ''
  const detail = typeof rawDetail === 'string' ? rawDetail : String(rawDetail?.message || '')
  const crash = raw.crash && typeof raw.crash === 'object' ? raw.crash : null
  return {
    code,
    message: String(raw.message || raw.error || message),
    detail,
    missing,
    missingCount: Math.max(Number(raw.missingCount) || 0, missing.length),
    paths,
    actions: [...new Set(actions)],
    crash,
    logFile: raw.logFile || raw.paths?.logFile || ''
  }
}

/** 「复制错误信息」使用的中文文本，包含摘要、缺失文件和相关路径。 */
export function launchErrorCopyText(info, inst = {}) {
  if (!info) return ''
  const loader = inst.loader && inst.loader !== 'vanilla' ? ` · ${inst.loader}` : ''
  const lines = [
    `【启动失败】${inst.name || '实例'}${inst.mc ? `（${inst.mc}${loader}）` : ''}`,
    `原因：${info.message || '未知原因'}`
  ]
  if (info.code) lines.push(`错误代码：${info.code}`)
  if (info.detail) lines.push(`详细原因：${info.detail}`)
  if (!info.detail) {
    const reason = LAUNCH_ERROR_REASONS[info.code]
    if (reason) lines.push(`说明：${reason}`)
  }
  if (info.missing.length) {
    lines.push(`缺失文件（${info.missingCount}）：`)
    for (const file of info.missing.slice(0, 40)) lines.push(`  - ${file}`)
    if (info.missingCount > 40) lines.push(`  …还有 ${info.missingCount - 40} 项`)
  }
  const paths = [
    ['游戏目录', info.paths.gameDir],
    ['版本 JSON', info.paths.versionJson],
    ['客户端 JAR', info.paths.clientJar],
    ['日志目录', info.paths.logsDir],
    ['实例目录', info.paths.baseDir],
    ['日志文件', info.logFile]
  ].filter(([, value]) => value)
  if (paths.length) {
    lines.push('路径：')
    for (const [label, value] of paths) lines.push(`  ${label}：${value}`)
  }
  if (info.crash?.file) lines.push(`崩溃报告：${info.crash.file}`)
  lines.push(`时间：${fmtDateTime(Date.now())}`)
  return lines.join('\n')
}

function launchErrorReason(code) {
  return LAUNCH_ERROR_REASONS[code] || '启动器没有返回更详细的原因，请打开日志查看完整输出。'
}

function dirOf(file) {
  const text = String(file || '')
  const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return index > 0 ? text.slice(0, index) : ''
}

function baseName(file) {
  const text = String(file || '')
  const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return index >= 0 ? text.slice(index + 1) : text
}

/* ------------------------------------------------------------------ */
/* launch state tracking                                              */
/* ------------------------------------------------------------------ */

/**
 * 保存 launch 状态；只在 status 变化时通知，避免每次轮询重复弹窗/重绘。
 * 返回上一个状态，便于调用方判断。
 */
function rememberLaunch(instanceId, launch, { notify = true } = {}) {
  if (!instanceId || !launch || typeof launch !== 'object') return null
  const prev = state.launchStates.get(instanceId) || null
  const next = launch.instanceId ? launch : { ...launch, instanceId }
  state.launchStates.set(instanceId, next)
  if (prev && prev.status === next.status) {
    // 同阶段只更新进度，hero 由 pollStatus 的 updateHeroRuntime 刷新。
    if (instanceId === state.selectedId && state.view === 'instance') updateHeroRuntime()
    return prev
  }
  if (prev && notify) onLaunchStateChanged(instanceId, prev, next)
  if (instanceId === state.selectedId && state.view === 'instance') {
    if (state.tab === 'overview') refreshOverviewLaunchPanel()
    updateHeroRuntime()
  }
  return prev
}

function onLaunchStateChanged(instanceId, prev, next) {
  const inst = state.instances.find((item) => item.id === instanceId) ||
    (state.selectedId === instanceId ? selectedInstance() : null)
  if (next.status === 'failed') {
    notifyLaunchFailure(instanceId, inst, normalizeLaunchError(next.error, { message: '游戏启动失败' }))
  } else if (next.status === 'running' && ['preparing', 'spawning'].includes(prev.status)) {
    toast('Minecraft 已启动', 'ok')
  } else if (next.status === 'cancelled' && ['preparing', 'spawning'].includes(prev.status)) {
    toast('已取消启动准备', 'ok')
  }
}

function notifyLaunchFailure(instanceId, inst, info) {
  const last = state.launchErrorToasts.get(instanceId) || 0
  if (Date.now() - last < 5000) return
  state.launchErrorToasts.set(instanceId, Date.now())
  toast(`「${inst?.name || '实例'}」启动失败：${info?.message || '请查看诊断信息'}`, 'err')
}

/** 拉取单个实例的 status（含 launch），并发去重，失败静默。 */
function fetchLaunchState(instanceId, { notify = true } = {}) {
  if (!instanceId) return Promise.resolve(null)
  const inflight = state.launchInflight.get(instanceId)
  if (inflight) return inflight
  let task = null
  // 契约里的客户端方法叫 launchState；旧别名 instanceStatus 也保留兼容。
  const request = typeof api.launchState === 'function'
    ? api.launchState(instanceId)
    : api.instanceStatus(instanceId)
  task = request
    .then((data) => {
      if (data?.launch) {
        rememberLaunch(instanceId, data.launch, { notify })
      } else {
        // 服务端没有 launch（旧版本或实例已被清理）：清除本地乐观状态，
        // 否则会一直停留在“准备启动中”。
        const stored = state.launchStates.get(instanceId)
        if (stored?.local) {
          state.launchStates.delete(instanceId)
          if (instanceId === state.selectedId && state.view === 'instance') updateHeroRuntime()
        }
      }
      return data
    })
    .catch(() => null)
    .finally(() => {
      if (state.launchInflight.get(instanceId) === task) state.launchInflight.delete(instanceId)
    })
  state.launchInflight.set(instanceId, task)
  return task
}

/**
 * 概览页的失败信息：优先使用 launch.error；旧服务端没有 launch 时回退到
 * session.status === 'failed'（用户主动停止不会进入 failed）。
 */
function overviewFailureInfo(inst) {
  if (!inst) return null
  const launch = launchOf(inst.id)
  if (launch?.status === 'failed') {
    return {
      launch,
      info: normalizeLaunchError(launch.error || {
        message: launch.detail || '游戏启动失败',
        detail: launch.detail || ''
      }, { message: '游戏启动失败' })
    }
  }
  const session = sessionOf(inst.id)
  if (session?.status === 'failed') {
    return {
      launch: null,
      info: normalizeLaunchError({
        code: session.crash ? 'GAME_CRASHED' : 'GAME_EXITED',
        message: session.error || '游戏异常退出',
        crash: session.crash || null
      }, { message: '游戏异常退出' })
    }
  }
  return null
}

/**
 * 概览页常驻的启动失败诊断卡。轮询到 failed 时无需重新渲染整个概览，
 * 直接重画这个 slot，切换 tab 后再回来也不会丢失（数据在 state.launchStates）。
 */
function paintOverviewLaunchPanel(slot, inst) {
  if (!slot || !inst) return
  clear(slot)
  const failure = overviewFailureInfo(inst)
  if (!failure?.info) return
  const { info, launch } = failure
  slot.appendChild(ui.sectionCard({
    title: '启动失败诊断',
    subtitle: [launch?.phaseLabel, info.code].filter(Boolean).join(' · ') || '上次启动未成功',
    className: 'lp-card-danger',
    actions: btn('查看日志', { size: 'sm', iconName: 'terminal', onClick: () => setTab('logs') }),
    body: buildLaunchErrorPanel(info, inst)
  }))
}

function refreshOverviewLaunchPanel() {
  const slot = state.overviewLaunchSlot
  if (!slot?.isConnected) return
  const inst = selectedInstance()
  if (inst) paintOverviewLaunchPanel(slot, inst)
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
      community: state.community,
      sessions: state.sessions,
      jobs: state.jobs
    }),
    reload: () => refreshAll(),
    reloadInstance: () => refreshSelectedDetail(),
    showInstance: async (id) => { await selectInstance(id) },
    showView: async (view) => { await showView(view) },
    // 下载中心：已完成整合包 → 安装页（自动载入并开始安装）；仅打开安装页时 path 为空。
    installPackFromDownload: async (job, path) => {
      const target = String(path || job?.path || '').trim()
      if (!target) { toast('没有找到已下载的整合包文件', 'warn'); return }
      state.pendingPackInstall = { path: target, auto: true, token: Date.now() }
      await showView('install')
    },
    openPackInstaller: async () => {
      state.pendingPackInstall = { path: '', auto: false, token: Date.now() }
      await showView('install')
    },
    takePendingPackInstall: () => {
      const pending = state.pendingPackInstall
      state.pendingPackInstall = null
      return pending
    },
    takePendingPackFile: () => {
      const file = state.pendingPackFile
      state.pendingPackFile = null
      return file
    },
    openAccounts: () => openAccounts(),
    openSettings: (section = 'launcher-root') => openLauncherSettings(section),
    setTab: (tab) => setTab(tab),
    // 好友页已有最新快照时直接同步计数，避免为了角标再多请求一次服务器。
    setFriendsBadge: (counts) => {
      if (!counts || typeof counts !== 'object') return
      friendNotify.requests = Number(counts.requests) || 0
      friendNotify.unread = Number(counts.unread) || 0
      friendNotify.incoming = Number(counts.incoming) || 0
      friendNotify.activeTransfers = Number(counts.activeTransfers) || 0
      paintFriendsBadge()
    }
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
  // 启动时就先拉一次好友提示计数，侧边栏不必等第一次 activate 才出现提示标。
  void pollFriendsNotifications()
  state.ready = true
  if (state.settings?.needsSetup) setTimeout(() => openSetup(), 320)
  // 启动器自身更新：按设置自动检查一次，发现新版本时右下角弹提示卡片。
  initUpdateChecker({
    autoCheck: state.settings?.update?.autoCheck !== false,
    delay: state.settings?.needsSetup ? 6000 : 1500
  })
  return {
    activate,
    deactivate,
    refresh: refreshAll,
    applySettings,
    commandItems,
    openSetup,
    checkUpdates: () => checkForUpdates({ silent: false, force: true }),
    isActive: () => state.active,
    getState: () => state,
    destroy
  }
}

/** 首次启动 / 尚未选择游戏目录时，让用户先选 .minecraft 的位置。 */
function openSetup() {
  if (state.setupOpen) return
  state.setupOpen = true
  openGameDirSetup({
    settings: state.settings || {},
    onDone: async (next) => {
      state.setupOpen = false
      if (next) state.settings = next
      toast('游戏目录已就绪：' + (next?.root || state.settings?.root || ''), 'ok')
      try {
        await loadBootstrap({ silent: true })
        renderSidebar()
        renderMain()
      } catch (e) {
        toast('刷新启动器失败：' + e.message, 'warn')
      }
    },
    onCancel: () => { state.setupOpen = false }
  })
}

/** 设置页保存启动器设置后同步到当前页面（不重建 DOM，避免闪烁）。 */
function applySettings(next) {
  if (next && typeof next === 'object') state.settings = next
}

function buildSkeleton() {
  clear(rootEl)
  sideEl = h('aside', { class: 'lp-side', 'aria-label': '游戏实例' })
  mainEl = h('section', { class: 'lp-main', id: 'lpMainView' })
  rootEl.append(sideEl, mainEl)

  const head = h('div', { class: 'lp-side-head' },
    h('div', { class: 'lp-side-title' },
      h('span', { class: 'overline' }, 'Launch Bay'),
      h('h1', {}, h('span', { class: 'lp-side-name' }, '游戏实例 '),
        h('span', { class: 'lp-count', id: 'lpCount' }),
        h('span', { class: 'lp-run-count', id: 'lpRunCount', hidden: true }))
    ),
    h('button', { class: 'lp-new', type: 'button', title: '安装新的 Minecraft 实例' },
      icon('add', { size: 15 }), h('span', {}, '新建实例'))
  )
  head.querySelector('.lp-new').onclick = () => showView('install')
  countEl = head.querySelector('#lpCount')
  runCountEl = head.querySelector('#lpRunCount')

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
  const friendsBtn = navButton('friends', '好友', 'user', () => showView('friends'))
  friendsBtn.badgeEl = h('span', { class: 'lp-nav-badge', hidden: true })
  friendsBtn.fileEl = h('span', { class: 'lp-nav-file', hidden: true, title: '有文件等待接收' })
  friendsBtn.append(friendsBtn.badgeEl, friendsBtn.fileEl)
  state.friendsNavBtn = friendsBtn
  navWrapEl.append(
    friendsBtn,
    navButton('downloads', '下载中心', 'download', () => showView('downloads')),
    navButton('java', 'Java', 'java', () => showView('java')),
    navButton('import', '导入已有游戏', 'archive', async () => {
      await showView('install')
      setTimeout(() => {
        const tabs = [...document.querySelectorAll('.lp-view-body .seg button')]
        tabs.find((button) => /导入已有/.test(button.textContent || ''))?.click()
      }, 60)
    }),
    h('div', { class: 'lp-nav-sep' }),
    // 启动器是主页：工作台只是另一个页面，不再写成「返回工作台」。
    navButton('workspace', '工作台', 'workspace', () => helpers.switchPage?.('workbench')),
    navButton('settings', '设置', 'settings', () => openLauncherSettings())
  )
  updateNav()
  paintFriendsBadge()
}

function updateNav() {
  for (const b of navWrapEl.querySelectorAll('.lp-navbtn')) {
    b.classList.toggle('active', b.dataset.nav === state.view)
  }
}

/* ------------------------------------------------------------------ */
/* friends notifications (sidebar badges)                             */
/* ------------------------------------------------------------------ */

const friendNotify = { requests: 0, unread: 0, incoming: 0, activeTransfers: 0 }
let friendsNotifyTimer = null
let friendsNotifyBusy = false

function paintFriendsBadge() {
  const button = state.friendsNavBtn
  if (!button) return
  const messages = friendNotify.requests + friendNotify.unread
  const files = friendNotify.incoming + friendNotify.activeTransfers
  if (button.badgeEl) {
    button.badgeEl.hidden = !messages
    button.badgeEl.textContent = messages > 99 ? '99+' : String(messages)
    button.badgeEl.className = 'lp-nav-badge' + (friendNotify.requests ? ' accent' : '')
    button.badgeEl.title = [
      friendNotify.requests ? `${friendNotify.requests} 个好友请求` : '',
      friendNotify.unread ? `${friendNotify.unread} 条未读消息` : ''
    ].filter(Boolean).join(' · ')
  }
  if (button.fileEl) {
    button.fileEl.hidden = !files
    button.fileEl.textContent = files > 99 ? '99+' : String(files)
    button.fileEl.className = 'lp-nav-file' + (friendNotify.incoming ? ' active' : '')
    button.fileEl.title = [
      friendNotify.incoming ? `${friendNotify.incoming} 个文件等待接收` : '',
      friendNotify.activeTransfers ? `${friendNotify.activeTransfers} 个传输进行中` : ''
    ].filter(Boolean).join(' · ')
  }
  const hints = []
  if (friendNotify.requests) hints.push(`${friendNotify.requests} 个好友请求`)
  if (friendNotify.unread) hints.push(`${friendNotify.unread} 条未读消息`)
  if (friendNotify.incoming) hints.push(`${friendNotify.incoming} 个文件等待接收`)
  if (friendNotify.activeTransfers) hints.push(`${friendNotify.activeTransfers} 个传输进行中`)
  button.title = hints.length ? `好友 · ${hints.join(' · ')}` : '好友'
}

async function pollFriendsNotifications() {
  if (friendsNotifyBusy) return
  friendsNotifyBusy = true
  try {
    const data = await api.friendsNotifications()
    friendNotify.requests = Number(data?.requests) || 0
    friendNotify.unread = Number(data?.unread) || 0
    friendNotify.incoming = Number(data?.incoming) || 0
    friendNotify.activeTransfers = Number(data?.activeTransfers) || 0
    paintFriendsBadge()
  } catch {
    // 未登录/网络不可用时静默处理，不打扰用户。
  } finally {
    friendsNotifyBusy = false
  }
}

function startFriendsNotifier() {
  stopFriendsNotifier()
  void pollFriendsNotifications()
  friendsNotifyTimer = setInterval(() => {
    // 好友页自己每 2 秒轮询一次，不需要重复请求。
    if (!state.active || state.view === 'friends') return
    void pollFriendsNotifications()
  }, 6000)
}

function stopFriendsNotifier() {
  if (friendsNotifyTimer) clearInterval(friendsNotifyTimer)
  friendsNotifyTimer = null
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
  state.community = data.community || null
  state.sessions = data.sessions || []
  state.detection = data.detection || null
  if (state.detection?.error && !state.detectionErrorShown) {
    state.detectionErrorShown = true
    toast(state.detection.error, 'warn')
  } else if (!state.detection?.error) {
    state.detectionErrorShown = false
  }
  state.jobs = data.jobs || []
  // 实例被删除后，旧的启动状态不再有意义。
  const alive = new Set(state.instances.map((item) => item.id))
  for (const key of [...state.launchStates.keys()]) {
    if (!alive.has(key)) state.launchStates.delete(key)
  }
  for (const id of [...state.stoppingIds]) {
    if (!state.sessions.some((item) => item.instanceId === id && item.status === 'stopping')) state.stoppingIds.delete(id)
  }
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
    if (detail?.status?.launch) rememberLaunch(state.selectedId, detail.status.launch, { notify: false })
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
    // GET /instances/:id 已经附带 status.launch，先写入缓存让 hero 立即可见。
    if (detail?.status?.launch) rememberLaunch(id, detail.status.launch, { notify: false })
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
      title: `${inst.name}\n${ui.instanceSubtitle(inst)}` + (running ? `\n${sessionRuntimeText(session)}` : '')
    },
      ui.instanceIcon(inst, { size: 34, running }),
      h('span', { class: 'lp-inst-main' },
        h('span', { class: 'lp-inst-name' }, inst.name),
        h('span', { class: 'lp-inst-sub' }, ui.instanceSubtitle(inst), inst.group ? h('i', { class: 'lp-inst-group' }, inst.group) : null)
      ),
      h('span', { class: 'lp-inst-side' },
        running ? h('span', { class: 'lp-run-dot', title: sessionRuntimeText(session) }) : null,
        !inst.installed ? h('span', { class: 'lp-warn-dot', title: '需要修复' }) : null
      )
    )
    row.onclick = () => selectInstance(inst.id)
    row.ondblclick = () => { selectInstance(inst.id); launchSelected() }
    // 右键：拦住浏览器/WebView 的默认菜单，换成实例操作菜单。
    row.oncontextmenu = (event) => {
      event.preventDefault()
      if (state.selectedId !== inst.id) selectInstance(inst.id)
      openInstanceMenu(event, inst)
    }
    instanceListEl.appendChild(row)
  }
}

function updateRunningIndicators() {
  const running = runningSessions()
  if (runCountEl) {
    runCountEl.hidden = !running.length
    runCountEl.textContent = running.length ? `${running.length} 运行中` : ''
    runCountEl.title = [
      ...running.map((session) => {
        const inst = state.instances.find((item) => item.id === session.instanceId)
        return `${inst?.name || session.instanceName || session.instanceId} · ${sessionRuntimeText(session)}`
      }),
      state.detection?.error || ''
    ].filter(Boolean).join('\n')
    runCountEl.classList.toggle('warn', !!state.detection?.error && !running.length)
  }
  if (!instanceListEl) return
  for (const row of instanceListEl.querySelectorAll('[data-inst-id]')) {
    const session = sessionOf(row.dataset.instId)
    const isRunning = isRunningSession(session)
    row.classList.toggle('running', isRunning)
    row.querySelector('.lp-inst-icon')?.classList.toggle('running', isRunning)
    let dot = row.querySelector('.lp-run-dot')
    if (isRunning && !dot) {
      dot = h('span', { class: 'lp-run-dot' })
      row.querySelector('.lp-inst-side')?.appendChild(dot)
    }
    if (!isRunning && dot) dot.remove()
    if (dot) dot.title = sessionRuntimeText(session)
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
  // detail 里没有 launch 时（旧服务端/首次加载），再单独拉一次启动状态。
  if (!launchOf(id)) void fetchLaunchState(id, { notify: false })
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

function renderMain() {
  if (!mainEl) return
  if (state.view !== 'friends') {
    state.friendsController?.dispose?.()
    state.friendsController = null
  }
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
  if (state.view === 'friends') { renderFriendsView(); return }
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
    state.pendingPackFile = null
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

async function renderFriendsView() {
  const body = h('div', { class: 'lp-view-body' })
  mainEl.appendChild(h('div', { class: 'lp-view lp-view-friends' },
    viewBackBar(() => showView('instance')),
    body
  ))
  try {
    const mod = await loadModule('friends')
    if (state.view !== 'friends') return
    state.friendsController?.dispose?.()
    state.friendsController = mod.createFriendsView(pageCtx())
    state.friendsController.render(body)
  } catch (e) {
    body.appendChild(h('div', { class: 'lp-main-error' }, icon('warning', { size: 22 }), h('b', {}, '加载好友页失败'), h('p', {}, e.message)))
  }
}

async function showView(view) {
  // 切页时一定收掉拖放遮罩，避免 ESC 取消拖拽后遮罩跟着新页面一起出现。
  hideDropOverlay()
  // 离开安装页时丢弃还没被消费的拖入文件，避免下次进入安装页时误触发上传。
  if (view !== 'install') state.pendingPackFile = null
  const previous = state.view
  if (previous === 'downloads' && view !== 'downloads') {
    state.downloadsController?.destroy?.()
    state.downloadsController = null
  }
  if (previous === 'friends' && view !== 'friends') {
    state.friendsController?.dispose?.()
    state.friendsController = null
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
  if (!mainEl) return
  // 直接 -- 从错误卡片的「返回」等入口进来时，mainEl 里可能还留着上一屏，
  // 不清干净会叠出好几份欢迎页。
  clear(mainEl)
  const account = selectedAccount()
  const wrap = h('div', { class: 'lp-welcome' })
  wrap.appendChild(h('div', { class: 'lp-welcome-hero' },
    h('div', { class: 'lp-welcome-mark' }, icon('cube', { size: 34 })),
    h('div', { class: 'lp-welcome-title' },
      h('span', { class: 'overline' }, 'Launch Bay'),
      h('h1', {}, '准备进入世界'),
      h('p', {}, '版本、账户和启动参数都收在启动器里；服务器、整合包与其它工具在工作台页面。')
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
      // 实例可能已被删除：清掉选中项并重新拉一次列表，而不是叠一层欢迎页。
      btn('返回', { onClick: async () => { state.selectedId = ''; state.detail = null; await refreshAll() } })
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

function heroMode(inst, session, launch) {
  // 接管的外部进程优先：即使内存里还留着上一次失败的 launch 状态，
  // 只要系统进程表里这个实例确实在运行，就应该显示运行中/停止按钮。
  if (session?.detected && isRunningSession(session)) return 'running'
  if (isPreparingLaunch(launch)) return 'preparing'
  if (launch?.status === 'failed') return 'failed'
  if (launch?.status === 'running') return 'running'
  if (session?.status === 'failed') return 'failed'
  if (isRunningSession(session)) return session.status === 'starting' ? 'preparing' : 'running'
  return 'idle'
}

function heroLastText(inst, session) {
  if (session && isRunningSession(session)) return session.detected ? '正在运行（外部进程）' : '正在运行'
  return ui.lastPlayed(inst.lastPlayed)
}

function heroStatusText(inst, session, launch, mode) {
  if (mode === 'preparing') {
    const phase = launch?.phaseLabel || LAUNCH_PHASE_LABELS[launch?.phase] || ''
    return phase ? `准备启动 · ${phase}` : '正在启动…'
  }
  if (mode === 'running') {
    if (!session) return launch?.status === 'running' ? '运行中' : '准备就绪'
    if (session.status === 'stopping') return '正在停止游戏…'
    const source = session.detected ? '已接管外部进程' : '运行中'
    const pid = session.pid ? ` · PID ${session.pid}` : ''
    return source + pid
  }
  if (mode === 'failed') return '启动失败'
  if (launch?.status === 'cancelled') return '已取消启动'
  if (launch?.status === 'exited') return '游戏已退出'
  return inst.installed ? '准备就绪' : '尚未安装完成'
}

function launchPaintKey(mode, launch, stopping) {
  return `${mode}:${launch?.status || ''}:${stopping ? 1 : 0}`
}

/** 服务端没有 launch 时，用 session.failed 合成一个可展示的失败状态。 */
function heroLaunchState(inst, session) {
  if (session?.detected && (session.status === 'running' || session.status === 'stopping')) {
    return {
      instanceId: inst.id,
      status: 'running',
      detail: '已接管外部游戏进程',
      progress: 100,
      indeterminate: false
    }
  }
  const launch = launchOf(inst.id)
  if (launch) return launch
  if (session?.status === 'failed') {
    return {
      instanceId: inst.id,
      status: 'failed',
      error: {
        code: session.crash ? 'GAME_CRASHED' : 'GAME_EXITED',
        message: session.error || '游戏异常退出',
        crash: session.crash || null
      }
    }
  }
  return null
}

/**
 * hero 上的启动进度块：阶段文案 + 真实/不确定进度 + 取消按钮；
 * 失败时改为红色错误条，点击打开结构化错误面板。
 */
function buildLaunchProgress(inst) {
  const headIcon = h('span', { class: 'lp-launch-progress-icon' })
  const headText = h('b', {}, '')
  const cancelBtn = btn('取消', {
    size: 'xs',
    variant: 'ghost',
    class: 'lp-launch-cancel',
    title: '取消启动准备',
    onClick: () => cancelPreparingLaunch(inst)
  })
  const bar = progress(null, { className: 'lp-launch-progress-bar' })
  const phase = h('div', { class: 'lp-launch-phase' }, '')
  const errorLine = h('button', { class: 'lp-launch-error-line', type: 'button', hidden: true })
  const root = h('div', { class: 'lp-launch-progress', hidden: true },
    h('div', { class: 'lp-launch-progress-head' }, headIcon, headText, cancelBtn),
    bar.el,
    phase,
    errorLine
  )

  function paint(launch, session) {
    const status = launch?.status || ''
    const visible = ['preparing', 'spawning', 'running', 'failed'].includes(status)
    root.hidden = !visible
    if (!visible) return
    root.classList.toggle('is-failed', status === 'failed')
    root.classList.toggle('is-running', status === 'running')
    clear(headIcon)

    if (status === 'failed') {
      const info = normalizeLaunchError(launch.error, { message: '游戏启动失败' })
      headIcon.appendChild(icon('warning', { size: 12 }))
      headText.textContent = '启动失败'
      headText.title = info?.message || ''
      cancelBtn.hidden = true
      bar.el.hidden = true
      phase.textContent = info?.message || '启动失败，请查看诊断信息'
      errorLine.hidden = false
      clear(errorLine)
      errorLine.append(
        icon('warning', { size: 12 }),
        h('span', { title: info?.message || '' }, info?.message || '启动失败'),
        h('b', {}, '查看原因')
      )
      errorLine.onclick = () => showLaunchError(info || launch.error, inst, { launch })
      return
    }

    if (status === 'running') {
      headIcon.appendChild(icon('check-circle', { size: 12 }))
      headText.textContent = '游戏运行中'
      headText.title = ''
      cancelBtn.hidden = true
      bar.el.hidden = false
      bar.state('ok')
      bar.set(100)
      phase.textContent = session
        ? `${sessionSourceLabel(session)} · 已运行 ${fmtDuration(Math.max(0, (session.elapsed || 0) / 1000))} · 日志可从「日志」页接入`
        : '游戏进程正在运行'
      errorLine.hidden = true
      return
    }

    headIcon.appendChild(spinner(10))
    headText.textContent = launchPhaseText(launch)
    headText.title = headText.textContent
    cancelBtn.hidden = !(launch?.cancellable !== false && ['preparing', 'spawning'].includes(status))
    bar.el.hidden = false
    bar.state('')
    const info = launchProgressInfo(launch)
    bar.set(info.value)
    phase.textContent = launch.detail || '正在准备启动文件…'
    errorLine.hidden = true
  }

  return { root, paint }
}

async function cancelPreparingLaunch(inst) {
  if (!inst) return
  try {
    const result = await api.cancelLaunch(inst.id)
    if (result && result.ok === false) throw new Error(result.error || '服务端未能取消启动')
    toast('已取消启动准备', 'ok')
    await pollStatus(true)
  } catch (e) {
    toast('取消启动失败：' + e.message, 'err')
  }
}

function renderHero(inst, detail, session) {
  const launch = launchOf(inst.id)
  const mode = heroMode(inst, session, launch)
  const stopping = session?.status === 'stopping'
  const actionWrap = h('div', { class: 'lp-hero-actions' })
  const statusText = h('span', { class: 'lp-hero-status-text' }, heroStatusText(inst, session, launch, mode))
  const elapsed = h('span', { class: 'lp-hero-elapsed' }, mode === 'running' ? fmtDuration(Math.max(0, (session?.elapsed || 0) / 1000)) : '')
  const status = h('div', { class: 'lp-hero-status' + (mode === 'running' ? ' running' : mode === 'preparing' ? ' preparing' : mode === 'failed' ? ' failed' : '') },
    h('i', {}), statusText, elapsed)

  const launchProgress = buildLaunchProgress(inst)
  const launchBtn = h('button', { class: 'lp-launch' + (mode === 'running' ? ' stop' : ''), type: 'button' })
  const launchMoreBtn = btn('再开一个', {
    size: 'sm',
    iconName: 'add',
    class: 'lp-launch-more',
    title: '保持当前实例运行，再启动另一个实例',
    onClick: () => openLaunchAnother(inst)
  })
  launchMoreBtn.hidden = mode !== 'running'
  function paintLaunch(currentMode = mode, isStopping = stopping) {
    const currentLaunch = launchOf(inst.id)
    clear(launchBtn)
    launchBtn.disabled = false
    launchBtn.removeAttribute('aria-busy')
    launchBtn.className = 'lp-launch' + (currentMode === 'running' ? ' stop' : '')
    launchBtn.onclick = null
    launchMoreBtn.hidden = currentMode !== 'running'
    launchMoreBtn.disabled = isStopping
    if (currentMode === 'running') {
      launchBtn.append(icon('stop', { size: 17 }), h('span', {}, isStopping ? '正在停止…' : '停止游戏'))
      launchBtn.disabled = isStopping
      launchBtn.onclick = () => stopInstanceById(inst)
      return
    }
    if (currentMode === 'preparing') {
      const label = currentLaunch?.status === 'spawning' ? '正在启动…' : '准备启动中…'
      launchBtn.disabled = true
      launchBtn.setAttribute('aria-busy', 'true')
      launchBtn.append(spinner(14), h('span', {}, label))
      return
    }
    const failedBefore = currentLaunch?.status === 'failed' || sessionOf(inst.id)?.status === 'failed'
    const label = !inst.installed ? '修复并启动' : failedBefore ? '重新启动' : '启动游戏'
    launchBtn.append(icon('play', { size: 17 }), h('span', {}, label))
    launchBtn.onclick = () => launchSelected()
  }
  paintLaunch()
  launchProgress.paint(heroLaunchState(inst, session), session)
  const account = selectedAccount()
  const accountLine = h('span', { class: 'lp-launch-sub' },
    mode === 'running' && session?.detected
      ? '外部进程运行中，账户信息不可用'
      : account ? `以 ${account.name} 登录` : '需要先添加账户')

  const settingsBtn = iconBtn('settings', { label: '实例设置', title: '实例设置', onClick: () => openInstanceSettings(inst) })
  const folderBtn = iconBtn('folder-open', { label: '打开游戏目录', title: '打开游戏目录', onClick: () => openPath(detail.paths?.gameDir || inst.paths?.gameDir || '') })
  const moreBtn = iconBtn('more', { label: '更多操作', title: '更多操作', onClick: (e) => openInstanceMenu(e, inst) })

  actionWrap.append(
    h('div', { class: 'lp-launch-wrap' }, launchBtn, launchMoreBtn, launchProgress.root, accountLine),
    h('div', { class: 'lp-hero-tools' }, settingsBtn, folderBtn, moreBtn)
  )

  const badges = h('div', { class: 'lp-hero-badges' },
    h('span', { class: 'badge ' + (inst.installed ? 'ok' : 'warn') }, inst.installed ? '已安装' : '需要修复'),
    inst.external ? h('span', { class: 'badge info', title: '引用外部 .minecraft，不复制游戏文件' }, '外部目录') : null,
    detail.summary?.pack ? h('span', { class: 'badge accent' }, '整合包') : null
  )

  const root = h('div', { class: 'lp-hero' + (mode === 'running' ? ' is-running' : '') },
    ui.instanceIcon(inst, { size: 72, running: mode === 'running' }),
    h('div', { class: 'lp-hero-main' },
      h('span', { class: 'overline' }, inst.group || 'Instance'),
      h('h1', { title: inst.name }, inst.name),
      h('div', { class: 'lp-hero-sub' }, ui.instanceSubtitle(inst), h('span', { class: 'lp-dot-sep' }, '·'),
        h('span', { class: 'lp-hero-last' }, heroLastText(inst, session))),
      badges,
      status
    ),
    actionWrap
  )
  state.heroRefs = {
    root,
    launchBtn,
    status,
    statusText,
    elapsed,
    accountLine,
    paintLaunch,
    paintProgress: launchProgress.paint,
    progress: launchProgress.root,
    instId: inst.id,
    sig: launchPaintKey(mode, launch, stopping)
  }
  return root
}

function updateHeroRuntime() {
  const refs = state.heroRefs
  if (!refs || refs.instId !== state.selectedId) return
  const detail = state.detail
  const inst = detail?.instance || selectedInstance()
  if (!inst) return
  const session = sessionOf(inst.id)
  const launch = launchOf(inst.id)
  const mode = heroMode(inst, session, launch)
  const stopping = session?.status === 'stopping'
  refs.root?.classList.toggle('is-running', mode === 'running')
  if (refs.status) {
    refs.status.className = 'lp-hero-status' +
      (mode === 'running' ? ' running' : mode === 'preparing' ? ' preparing' : mode === 'failed' ? ' failed' : '')
  }
  if (refs.statusText) refs.statusText.textContent = heroStatusText(inst, session, launch, mode)
  const last = refs.root?.querySelector('.lp-hero-last')
  if (last) last.textContent = heroLastText(inst, session)
  if (refs.accountLine) {
    const account = selectedAccount()
    refs.accountLine.textContent = mode === 'running' && session?.detected
      ? '外部进程运行中，账户信息不可用'
      : account ? `以 ${account.name} 登录` : '需要先添加账户'
  }
  if (refs.elapsed) {
    refs.elapsed.textContent = mode === 'running' ? fmtDuration(Math.max(0, (session?.elapsed || 0) / 1000)) : ''
  }
  if (refs.launchBtn) {
    const sig = launchPaintKey(mode, launch, stopping)
    if (refs.sig !== sig) {
      refs.sig = sig
      refs.paintLaunch(mode, stopping)
    }
  }
  refs.paintProgress?.(heroLaunchState(inst, session), session)
  // If the instance just finished installing, the hero badges need refreshing.
  const badge = refs.root?.querySelector('.lp-hero-badges .badge')
  if (badge && inst.installed) {
    badge.className = 'badge ok'
    badge.textContent = '已安装'
  }
}

/* ------------------------------------------------------------------ */
/* structured launch error panel                                      */
/* ------------------------------------------------------------------ */

function launchErrorActionButton(action, info, inst, onAction) {
  const fire = (name, fn) => () => {
    try { onAction?.(name) } catch {}
    fn()
  }
  switch (action) {
    case 'repair':
      return btn('检查并修复文件', { size: 'sm', iconName: 'refresh', onClick: fire('repair', () => repairInstance(inst)) })
    case 'select-java':
      return btn('选择 Java', { size: 'sm', iconName: 'java', onClick: fire('select-java', () => openInstanceSettings(inst)) })
    case 'open-game-dir': {
      const dir = info.paths.gameDir || inst?.paths?.gameDir || ''
      if (!dir) return null
      return btn('打开游戏目录', { size: 'sm', iconName: 'folder-open', onClick: fire('open-game-dir', () => openPath(dir)) })
    }
    case 'open-logs':
      return btn('打开日志', { size: 'sm', iconName: 'terminal', onClick: fire('open-logs', () => setTab('logs')) })
    case 'copy':
      return btn('复制错误信息', {
        size: 'sm',
        iconName: 'copy',
        onClick: async () => {
          const ok = await copyText(launchErrorCopyText(info, inst))
          toast(ok ? '错误信息已复制' : '复制失败，请手动选择文本', ok ? 'ok' : 'err')
        }
      })
    default:
      return null
  }
}

/**
 * 结构化错误面板：摘要、详细原因、缺失文件（最多 12 项）、相关路径、
 * 崩溃诊断，以及按 error.actions 渲染的可操作按钮。
 */
function buildLaunchErrorPanel(info, inst, { onAction = null } = {}) {
  const wrap = h('div', { class: 'lp-launch-error-panel' })
  if (!info) return wrap
  wrap.appendChild(h('div', { class: 'lp-launch-error-summary' },
    icon('warning', { size: 20 }),
    h('div', { class: 'lp-launch-error-summary-main' },
      h('div', { class: 'lp-launch-error-summary-title' },
        h('b', {}, info.message || '启动失败'),
        info.code ? h('span', { class: 'lp-error-code', title: '错误代码' }, info.code) : null
      ),
      h('p', {}, info.detail || launchErrorReason(info.code))
    )
  ))

  if (info.missing.length) {
    const shown = info.missing.slice(0, 12)
    const total = Math.max(info.missingCount, info.missing.length)
    wrap.appendChild(h('div', { class: 'lp-launch-error-detail' },
      h('div', { class: 'lp-subhead' }, `缺失文件（${total}）`),
      h('ul', { class: 'lp-error-missing' }, ...shown.map((file) => h('li', { title: file }, file))),
      total > shown.length ? h('div', { class: 'lp-hint' }, `仅显示前 ${shown.length} 项，共 ${total} 项。`) : null
    ))
  }

  const pathRows = [
    ['游戏目录', info.paths.gameDir],
    ['版本 JSON', info.paths.versionJson],
    ['客户端 JAR', info.paths.clientJar],
    ['日志目录', info.paths.logsDir],
    ['实例目录', info.paths.baseDir],
    ['日志文件', info.logFile]
  ].filter(([, value]) => !!value)
  if (pathRows.length) {
    wrap.appendChild(h('div', { class: 'lp-launch-error-detail' },
      h('div', { class: 'lp-subhead' }, '相关路径'),
      ...pathRows.map(([label, value]) => h('div', { class: 'lp-error-path-row' },
        h('span', {}, label),
        h('code', { title: String(value) }, String(value))
      ))
    ))
  }

  if (info.crash) {
    const crash = info.crash
    const hints = (Array.isArray(crash.hints) ? crash.hints : []).slice(0, 3)
    wrap.appendChild(h('div', { class: 'lp-crash-panel' },
      h('b', {}, crash.name || crash.file || '崩溃报告'),
      crash.description ? h('p', {}, crash.description) : null,
      ...hints.map((hint) => h('p', {}, `${hint.title || '诊断'}：${hint.suggestion || hint.detail || ''}`)),
      crash.file ? h('p', { class: 'mono' }, crash.file) : null
    ))
  }

  const actions = h('div', { class: 'lp-error-actions' })
  for (const action of info.actions) {
    const button = launchErrorActionButton(action, info, inst, onAction)
    if (button) actions.appendChild(button)
  }
  if (actions.childElementCount) wrap.appendChild(actions)
  return wrap
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
  // 全宽显示所有正在运行的实例（含启动器重启后接管的外部进程）。
  const runningSlot = h('div', { class: 'lp-running-slot' })
  state.runningPanelSlot = runningSlot
  container.appendChild(runningSlot)
  paintRunningPanel()

  const grid = h('div', { class: 'lp-overview-grid' })
  const left = h('div', { class: 'lp-overview-col' })
  const right = h('div', { class: 'lp-overview-col' })
  grid.append(left, right)
  container.appendChild(grid)

  // 启动失败诊断：常驻卡片，轮询到 failed 后在这里持久显示，而不是只弹 toast。
  const launchSlot = h('div', { class: 'lp-overview-launch' })
  state.overviewLaunchSlot = launchSlot
  left.appendChild(launchSlot)
  paintOverviewLaunchPanel(launchSlot, inst)

  // Runtime console / crash
  if (isRunningSession(session)) {
    const live = h('div', { class: 'lp-live-console' })
    left.appendChild(ui.sectionCard({
      title: '游戏运行中',
      subtitle: `${sessionSourceLabel(session)}${session.pid ? ' · PID ' + session.pid : ''} · ${fmtDuration(Math.max(0, (session.elapsed || 0) / 1000))}`,
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

  // launch 已包含崩溃诊断时不再重复显示“上次启动的崩溃诊断”卡片。
  const launchCrashShown = ['GAME_CRASHED', 'GAME_EXITED'].includes(overviewFailureInfo(inst)?.info?.code)
  if (detail?.status?.crash && !launchCrashShown) {
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
    subtitle: session?.detected ? '外部进程 · 跟随游戏 latest.log' : '启动器捕获的 stdout / stderr',
    actions: h('div', { class: 'lp-row-actions' },
      iconBtn('refresh', { size: 13, label: '刷新日志', onClick: () => loadRecentLog(logSlot, inst) }),
      btn('完整日志', { size: 'sm', iconName: 'terminal', onClick: () => setTab('logs') })
    ),
    body: logSlot
  }))
  loadRecentLog(logSlot, inst)

  // Quick actions
  const quick = h('div', { class: 'lp-quick-grid' })
  for (const [label, iconName, fn] of [
    ['打开游戏目录', 'folder-open', () => openPath(detail?.paths?.gameDir || inst.paths?.gameDir || '')],
    ['打开日志目录', 'terminal', () => openPath(detail?.paths?.logsDir || inst.paths?.logsDir || '')],
    ['检查并修复文件', 'refresh', () => repairInstance(inst)],
    ['复制实例', 'copy', () => duplicateInstance(inst)],
    ['导出为整合包', 'archive', () => openPackExport(inst)],
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

function runningPanelSignature(list) {
  return list.map((session) => `${session.instanceId}:${session.pid}:${session.status}:${session.detected ? 1 : 0}`).join('|') +
    `|${state.detection?.error || ''}|${state.selectedId}|${state.stoppingIds.size}`
}

/** 全宽的「正在运行」面板；同时接管的多个实例都在这里逐行管理。 */
function paintRunningPanel() {
  const slot = state.runningPanelSlot
  if (!slot || !slot.isConnected) return
  const list = runningSessions().sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
  const signature = runningPanelSignature(list)
  if (slot.dataset.sig === signature) {
    for (const el of slot.querySelectorAll('[data-run-elapsed]')) {
      const session = list.find((item) => item.instanceId === el.dataset.runElapsed)
      if (session) el.textContent = `已运行 ${fmtDuration(Math.max(0, (session.elapsed || 0) / 1000))}`
    }
    return
  }
  slot.dataset.sig = signature
  clear(slot)
  if (!list.length) {
    slot.hidden = true
    return
  }
  slot.hidden = false
  const rows = h('div', { class: 'lp-run-list' })
  for (const session of list) {
    const target = state.instances.find((item) => item.id === session.instanceId)
    const name = target?.name || session.instanceName || session.instanceId
    const stopping = session.status === 'stopping' || state.stoppingIds.has(session.instanceId)
    rows.appendChild(h('div', { class: 'lp-run-row' + (session.instanceId === state.selectedId ? ' active' : '') },
      ui.instanceIcon(target || { mc: '?' }, { size: 30, running: true }),
      h('div', { class: 'lp-run-main' },
        h('b', { title: name }, name),
        h('span', { class: 'lp-run-meta' },
          `${sessionSourceLabel(session)} · PID ${session.pid || '?'} · `,
          h('i', { dataset: { runElapsed: session.instanceId } }, `已运行 ${fmtDuration(Math.max(0, (session.elapsed || 0) / 1000))}`)
        )
      ),
      h('div', { class: 'lp-run-actions' },
        session.instanceId === state.selectedId
          ? h('span', { class: 'badge accent' }, '当前')
          : btn('切换', { size: 'xs', onClick: () => selectInstance(session.instanceId) }),
        btn('日志', { size: 'xs', iconName: 'terminal', onClick: () => selectInstance(session.instanceId, { tab: 'logs' }) }),
        btn(stopping ? '停止中' : '停止', {
          size: 'xs',
          variant: 'danger',
          iconName: 'stop',
          disabled: stopping,
          onClick: () => stopInstanceById(target || { id: session.instanceId, name })
        })
      )
    ))
  }
  const body = h('div', {},
    rows,
    state.detection?.error ? h('div', { class: 'lp-hint bad' }, state.detection.error) : null
  )
  slot.appendChild(ui.sectionCard({
    title: `正在运行 ${list.length} 个实例`,
    subtitle: '不同实例可同时运行；停止只影响这一行，日志会自动跟随游戏 latest.log',
    className: 'lp-running-card',
    actions: h('div', { class: 'lp-row-actions' },
      btn('重新检测', { size: 'sm', iconName: 'refresh', onClick: () => refreshDetection() }),
      btn('再开一个', { size: 'sm', iconName: 'add', onClick: () => openLaunchAnother(selectedInstance()) })
    ),
    body
  }))
}

/** 强制重新扫描进程表；用于手动刷新和打开面板时纠正缓存。 */
async function refreshDetection({ silent = false } = {}) {
  try {
    const data = await api.running(true)
    if (data?.detection) state.detection = data.detection
    await pollStatus(true)
    if (data?.detection?.error) toast(data.detection.error, 'warn')
    else if (!silent) toast(`检测完成：${data?.runningCount || 0} 个实例在运行`, 'ok')
  } catch (e) {
    toast('实例检测失败：' + e.message, 'err')
  }
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
  return await launchInstance(inst)
}

async function launchInstance(inst) {
  if (!inst) { showView('install'); return }
  // 未安装完成也允许发起一次启动：后端会返回 VERSION_JSON_MISSING /
  // MISSING_FILES 等结构化错误，前端给出「检查并修复文件」等操作，
  // 比只弹一个“尚未安装”的 toast 更可操作。
  const launch = launchOf(inst.id)
  if (isPreparingLaunch(launch)) {
    toast('这个实例正在准备启动，请稍候', 'warn')
    return
  }
  const account = selectedAccount()
  if (!account) {
    toast('请先添加并选择一个账户', 'warn')
    openAccounts()
    return
  }
  try {
    // 先写入乐观状态：即使服务端还没返回，hero 也会立即显示“准备启动中”并禁用按钮。
    rememberLaunch(inst.id, {
      instanceId: inst.id,
      status: 'preparing',
      phase: 'account',
      phaseLabel: LAUNCH_PHASE_LABELS.account,
      step: 1,
      total: 7,
      detail: '正在提交启动请求…',
      progress: null,
      indeterminate: true,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      cancellable: false,
      error: null,
      local: true
    }, { notify: false })
    updateHeroRuntime()

    const result = await api.launch(inst.id, account.id)
    if (result?.launch) rememberLaunch(inst.id, result.launch, { notify: false })
    toast('正在启动 Minecraft…', 'ok')
    await pollStatus(true)
    // hero 常驻，切到日志 tab 不会丢失进度块；不在实例页时不操作隐藏的 tab。
    if (state.view === 'instance') setTab('logs')
    if (state.settings?.closeOnLaunch) {
      setTimeout(() => { try { navigator.sendBeacon('/api/shutdown') } catch {} }, 2500)
    }
  } catch (e) {
    state.launchStates.delete(inst.id)
    updateHeroRuntime()
    showLaunchError(e, inst)
    // 失败后刷新一次，避免按钮仍停留在乐观的“准备启动中”。
    await pollStatus(true)
  }
}

function showLaunchError(error, inst, { launch = null } = {}) {
  const target = inst || selectedInstance() || { name: '实例', paths: {} }
  const info = normalizeLaunchError(error || launch?.error || { message: '启动失败' }, { message: '启动失败' })
  if (!info) {
    toast('启动失败，请打开日志查看原因', 'err')
    return
  }
  // 抑制同一失败原因的重复 toast；结构化面板本身是主要反馈。
  if (target.id) state.launchErrorToasts.set(target.id, Date.now())
  let modal = null
  const panel = buildLaunchErrorPanel(info, target, {
    onAction: (action) => {
      if (action === 'copy') return
      try { modal?.close() } catch {}
    }
  })
  modal = openModal({
    title: `无法启动「${target.name || '实例'}」`,
    size: 'lg',
    body: panel,
    buttons: [
      { label: '关闭', class: 'btn-ghost' }
    ]
  })
}

function markSessionStopping(instanceId) {
  state.sessions = state.sessions.map((session) => session.instanceId === instanceId
    ? { ...session, status: 'stopping', stopping: true }
    : session)
  updateRunningIndicators()
  updateHeroRuntime()
  paintRunningPanel()
}

/**
 * 停止指定实例。外部接管的进程先请求正常关闭，超时由服务端强制结束；
 * 本启动器拉起的进程沿用原来的快速停止。其它实例不受影响。
 */
async function stopInstanceById(inst, { confirm = true } = {}) {
  if (!inst?.id) return
  const session = sessionOf(inst.id)
  if (!isRunningSession(session)) {
    toast('游戏未在运行', 'warn')
    return
  }
  if (session.status === 'stopping') return
  if (session.status === 'starting') {
    await cancelPreparingLaunch(inst)
    return
  }
  const external = session.detected === true
  const name = inst.name || session.instanceName || '实例'
  const message = external
    ? `关闭「${name}」的外部游戏进程（PID ${session.pid || '?'}）？启动器会先请求游戏正常退出，8 秒后仍未退出会强制结束；其它正在运行的实例不受影响。`
    : `停止「${name}」的游戏进程？未保存的世界进度可能丢失；其它正在运行的实例不受影响。`
  if (confirm && !(await confirmDialog(message, { danger: true, okText: external ? '关闭游戏' : '停止游戏' }))) return
  state.stoppingIds.add(inst.id)
  markSessionStopping(inst.id)
  try {
    const result = await api.stop(inst.id, external ? false : true)
    if (result && result.ok === false) throw new Error(result.error || '服务端未能停止游戏')
    toast(external ? '已请求关闭游戏，正在等待进程退出' : '已请求停止游戏', 'ok')
  } catch (e) {
    state.stoppingIds.delete(inst.id)
    toast('停止失败：' + e.message, 'err')
  } finally {
    await pollStatus(true)
  }
}

async function stopSelected() {
  const inst = selectedInstance()
  if (!inst) return
  await stopInstanceById(inst)
}

/** 「再开一个」：保持当前实例运行，从其它已安装实例里选一个启动。 */
function openLaunchAnother(current = null) {
  const busy = new Set(runningSessions().map((session) => session.instanceId))
  const candidates = state.instances.filter((inst) => inst.installed && !busy.has(inst.id) && !isPreparingLaunch(launchOf(inst.id)))
  let modal = null
  const body = h('div', { class: 'lp-launch-another' })
  if (candidates.length) {
    body.appendChild(h('div', { class: 'lp-launch-another-note' },
      `当前有 ${busy.size} 个实例在运行。选择另一个实例启动，两个客户端会同时保持运行。`))
    const list = h('div', { class: 'lp-launch-another-list' })
    for (const inst of candidates) {
      list.appendChild(h('div', { class: 'lp-launch-another-row' },
        ui.instanceIcon(inst, { size: 34 }),
        h('div', { class: 'lp-launch-another-main' },
          h('b', { title: inst.name }, inst.name),
          h('span', {}, ui.instanceSubtitle(inst))
        ),
        btn('启动', {
          size: 'sm',
          variant: 'primary',
          iconName: 'play',
          onClick: async () => {
            try { modal?.close() } catch {}
            if (state.selectedId !== inst.id) await selectInstance(inst.id)
            await launchInstance(inst)
          }
        })
      ))
    }
    body.appendChild(list)
    body.appendChild(h('div', { class: 'lp-hint' },
      '同一个实例仍只允许一个进程，避免存档与 options.txt 互相覆盖；要同版本多开，请先停止再复制实例。'))
  } else {
    body.appendChild(ui.emptyBlock('没有可再开的实例',
      '所有已安装实例都在运行。要同时开同一个版本，请先停止其中一个，再复制实例（复制后存档与配置独立）。',
      btn('新建实例', { size: 'sm', iconName: 'add', onClick: () => { try { modal?.close() } catch {}; showView('install') } }),
      'cube'))
  }
  modal = openModal({
    title: '再开一个实例',
    size: 'md',
    body,
    buttons: [{ label: '关闭', class: 'btn-ghost' }]
  })
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

/* ------------------------------------------------------------------ */
/* export pack (.mrpack / .zip)                                       */
/* ------------------------------------------------------------------ */

/**
 * 「导出为整合包」弹窗：格式、存档/截图开关、输出目录与任务进度。
 * 任务由后端 /api/launcher/exports/:id 提供，关闭弹窗只停止本地轮询。
 */
function openPackExport(inst) {
  let format = 'mrpack'
  let outputDir = ''
  let includeSaves = false
  let includeScreenshots = false
  let job = null
  let pollTimer = null
  let after = 0
  let logLines = []
  let closed = false

  const formatWrap = h('div', { class: 'lp-export-format' })
  const formatOptions = []
  for (const [value, title, desc] of [
    ['mrpack', 'Modrinth 整合包（.mrpack）', '写入 modrinth.index.json，兼容 Modrinth 及支持 mrpack 的启动器。'],
    ['zip', '通用整合包（.zip）', '写入 manifest.json，可用本工具箱直接重新导入安装。']
  ]) {
    const radio = h('input', {
      type: 'radio',
      name: 'lp-export-format',
      value,
      checked: value === format,
      onchange: () => { format = value; syncFormat() }
    })
    const option = h('label', {
      class: 'lp-export-format-option' + (value === format ? ' is-active' : '')
    },
      radio,
      h('span', { class: 'lp-export-option-main' },
        h('b', {}, title),
        h('span', {}, desc)
      )
    )
    formatOptions.push([value, option])
    formatWrap.appendChild(option)
  }
  function syncFormat() {
    for (const [value, option] of formatOptions) {
      option.classList.toggle('is-active', value === format)
      const radio = option.querySelector('input')
      if (radio) radio.checked = value === format
    }
  }

  const savesInput = h('input', { type: 'checkbox', onchange: (e) => { includeSaves = e.target.checked } })
  const screenshotsInput = h('input', { type: 'checkbox', onchange: (e) => { includeScreenshots = e.target.checked } })
  const pathText = h('span', { class: 'lp-export-path' }, '启动器 exports 目录（默认）')
  const pickBtn = btn('选择目录', {
    size: 'sm',
    iconName: 'folder-open',
    onClick: async () => {
      const dir = await pickDir(outputDir || '', { title: '选择整合包导出目录' })
      if (!dir) return
      outputDir = dir
      pathText.textContent = dir
      pathText.title = dir
    }
  })
  const defaultBtn = btn('使用默认', {
    size: 'sm',
    variant: 'ghost',
    onClick: () => {
      outputDir = ''
      pathText.textContent = '启动器 exports 目录（默认）'
      pathText.title = ''
    }
  })

  const errorLine = h('div', { class: 'lp-launch-error-line', hidden: true })
  const jobSlot = h('div', { class: 'lp-export-job-slot' })
  const form = h('div', { class: 'lp-export-form' },
    h('div', { class: 'lp-field-row' }, h('label', {}, '格式'), formatWrap),
    h('div', { class: 'lp-field-row' },
      h('label', {}, '包含内容'),
      h('label', { class: 'lp-inline-check' }, savesInput, h('span', {}, '包含存档')),
      h('label', { class: 'lp-inline-check' }, screenshotsInput, h('span', {}, '包含截图'))
    ),
    h('div', { class: 'lp-field-row' },
      h('label', {}, '输出目录'),
      pathText,
      pickBtn,
      defaultBtn
    ),
    h('div', { class: 'lp-hint' }, [
      '默认排除日志、崩溃报告、缓存与账户令牌；未匹配到下载地址的模组会放进 overrides。',
      inst.external ? '这是外部实例，导出只读取原目录，不会写入或修改它。' : '导出不会修改实例本身。',
      '关闭窗口不会中断导出，任务会继续在后台完成。'
    ].join('')),
    errorLine,
    jobSlot
  )

  const startBtn = btn('开始导出', { variant: 'primary', iconName: 'archive', onClick: () => startExport() })
  function setStartLabel(text, iconName, disabled) {
    clear(startBtn)
    if (iconName) startBtn.appendChild(icon(iconName, { size: 14 }))
    startBtn.appendChild(h('span', {}, text))
    startBtn.disabled = !!disabled
  }
  setStartLabel('开始导出', 'archive', false)

  function showError(text) {
    errorLine.hidden = false
    clear(errorLine)
    errorLine.append(icon('warning', { size: 12 }), h('span', { title: text }, text))
  }
  function clearError() {
    errorLine.hidden = true
    clear(errorLine)
  }
  function stopPoll() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  function renderJob(current) {
    clear(jobSlot)
    if (!current) return
    const status = current.status || 'running'
    const active = EXPORT_ACTIVE.has(status)
    const done = status === 'done'
    const failed = status === 'failed'
    const progressValue = Number(current.progress)
    const hasProgress = current.indeterminate !== true && current.progress !== null &&
      current.progress !== undefined && current.progress !== '' && Number.isFinite(progressValue)
    const bar = progress(hasProgress ? progressValue : null, { className: 'lp-export-bar' })
    bar.state(done ? 'ok' : failed ? 'bad' : '')
    const badgeInfo = EXPORT_STATUS[status] || EXPORT_STATUS.running
    const card = h('div', { class: 'lp-export-job' + (done ? ' is-done' : failed ? ' is-failed' : '') },
      h('div', { class: 'lp-export-job-head' },
        icon(done ? 'check-circle' : failed ? 'x-circle' : 'archive', { size: 15 }),
        h('b', {}, `${EXPORT_FORMATS[current.format] || '整合包'}${current.instanceName ? ' · ' + current.instanceName : ''}`),
        h('span', { class: 'badge ' + badgeInfo.tone }, badgeInfo.label)
      ),
      bar.el,
      h('div', { class: 'lp-hint' }, [current.phase, current.detail].filter(Boolean).join(' · ') || '准备导出…')
    )
    if (done) {
      const file = current.file || ''
      const openTarget = current.output || dirOf(file) || file
      card.appendChild(h('div', { class: 'lp-export-done' },
        h('span', {}, file ? `已生成 ${baseName(file)}` : '导出完成'),
        current.size ? h('span', { class: 'mono' }, fmtBytes(current.size)) : null,
        openTarget ? btn('打开所在文件夹', { size: 'xs', iconName: 'folder-open', onClick: () => openPath(openTarget) }) : null
      ))
    }
    if (failed) {
      const failText = typeof current.error === 'string'
        ? current.error
        : (current.error?.message || current.detail || '导出失败，请查看任务日志。')
      card.appendChild(h('div', { class: 'lp-launch-error-line' },
        icon('warning', { size: 12 }),
        h('span', { title: failText }, failText)
      ))
    }
    if (active) {
      card.appendChild(h('div', { class: 'lp-row-actions' },
        btn('取消导出', { size: 'xs', variant: 'danger', onClick: () => cancelExportJob() })
      ))
    }
    if (logLines.length) {
      card.appendChild(h('pre', { class: 'lp-export-job-log' },
        logLines.slice(-6).map((line) => `[${line.t || ''}] ${line.text}`).join('\n')))
    }
    jobSlot.appendChild(card)
  }

  async function cancelExportJob() {
    if (!job?.id || !EXPORT_ACTIVE.has(job.status)) return
    if (!(await confirmDialog('取消当前导出任务？临时文件会被清理，未完成的输出文件不会保留。', {
      title: '取消导出', danger: true, okText: '取消导出'
    }))) return
    try {
      await api.cancelExport(job.id)
      toast('已请求取消导出', 'ok')
      setStartLabel('取消中…', 'archive', true)
    } catch (e) {
      toast('取消导出失败：' + e.message, 'err')
    }
  }

  function startPolling(id) {
    stopPoll()
    setStartLabel('导出中…', 'archive', true)
    const tick = async () => {
      if (closed) return
      try {
        const data = await api.exportJob(id, after)
        if (closed) return
        const next = data?.job
          ? { ...data.job, logs: data.logs ?? data.job.logs }
          : data
        if (!next || typeof next !== 'object') return
        job = { ...job, ...next }
        if (Array.isArray(next.logs) && next.logs.length) {
          logLines.push(...next.logs)
          after = Math.max(after, ...next.logs.map((line) => Number(line.seq) || 0))
        }
        const seq = Number(next.logSeq)
        if (Number.isFinite(seq) && seq > after) after = seq
        if (logLines.length > 60) logLines = logLines.slice(-60)
        renderJob(job)
        if (EXPORT_FINISHED.has(job.status)) {
          stopPoll()
          if (job.status === 'done') {
            setStartLabel('再次导出', 'archive', false)
            toast('整合包导出完成', 'ok')
          } else if (job.status === 'failed') {
            setStartLabel('重新导出', 'refresh', false)
            const reason = typeof job.error === 'string' ? job.error : job.error?.message
            toast('导出失败：' + (reason || job.detail || '请查看任务日志'), 'err')
          } else {
            setStartLabel('开始导出', 'archive', false)
          }
        }
      } catch (e) {
        stopPoll()
        setStartLabel('开始导出', 'archive', false)
        showError('读取导出进度失败：' + e.message)
      }
    }
    tick()
    pollTimer = setInterval(tick, 1200)
  }

  async function startExport() {
    if (startBtn.disabled) return
    setStartLabel('正在创建任务…', 'archive', true)
    clearError()
    clear(jobSlot)
    logLines = []
    after = 0
    try {
      const payload = { format, includeSaves, includeScreenshots, outputDir, name: inst.name }
      const result = await api.exportInstance(inst.id, payload)
      const created = result?.job || result
      if (!created?.id) throw new Error('服务器没有返回导出任务编号')
      job = created
      renderJob(job)
      startPolling(job.id)
    } catch (e) {
      setStartLabel('开始导出', 'archive', false)
      showError('无法开始导出：' + e.message)
    }
  }

  const modal = openModal({
    title: `导出为整合包 · ${inst.name}`,
    size: 'lg',
    body: form,
    buttons: [
      { label: '关闭', class: 'btn-ghost' },
      startBtn
    ],
    onClose: () => {
      closed = true
      stopPoll()
    }
  })
  return modal
}

async function deleteInstanceAction(inst) {
  const message = inst.external
    ? `从列表中移除「${inst.name}」？这是外部引用的实例，原 .minecraft 文件不会被删除。`
    : `删除「${inst.name}」？将删除实例目录（模组、存档、截图、日志会一起删除），共享的版本文件与资源库不会删除。`
  if (!(await confirmDialog(message, { danger: true, okText: '删除实例' }))) return
  try {
    const result = await api.deleteInstance(inst.id)
    // 目录被游戏/日志占用时服务端只能把实例从列表移除，必须如实告诉用户。
    if (result?.warning) toast(result.warning, 'warn')
    else toast('实例已删除', 'ok')
    state.selectedId = ''
    state.detail = null
    await refreshAll()
    if (state.instances.length) await selectInstance(state.instances[0].id)
  } catch (e) {
    toast('删除失败：' + e.message, 'err')
  }
}

function openInstanceMenu(e, inst) {
  // 右键用指针位置，按钮用按钮下沿，两种情况都贴着触发点弹出。
  const pointer = e?.type === 'contextmenu' || e?.type === 'pointerdown'
  const rect = e?.currentTarget?.getBoundingClientRect?.() || null
  const x = pointer ? e.clientX : (rect ? rect.right - 8 : 0)
  const y = pointer ? e.clientY : (rect ? rect.bottom + 4 : 0)
  const runningSession = sessionOf(inst.id)
  const running = isRunningSession(runningSession)
  const busy = isPreparingLaunch(launchOf(inst.id))
  const primary = running
    ? { label: runningSession?.detected ? '关闭游戏进程' : '停止游戏', iconName: 'stop', danger: true, onClick: () => stopInstanceById(inst) }
    : busy
      ? { label: '正在启动…', iconName: 'play', disabled: true, onClick: () => {} }
      : {
          label: inst.installed ? '启动游戏' : '检查并修复文件',
          iconName: inst.installed ? 'play' : 'refresh',
          onClick: () => inst.installed ? launchSelected() : repairInstance(inst)
        }
  openContextMenu({
    x,
    y,
    label: inst.name,
    items: [
      primary,
      ...(running ? [
        { label: '查看实时日志', iconName: 'terminal', onClick: () => selectInstance(inst.id, { tab: 'logs' }) },
        { label: '再开一个实例', iconName: 'add', onClick: () => openLaunchAnother(inst) }
      ] : []),
      { label: '实例设置', iconName: 'settings', onClick: () => openInstanceSettings(inst) },
      { label: '打开游戏目录', iconName: 'folder-open', onClick: () => openPath(inst.paths?.gameDir || '') },
      { label: '打开日志目录', iconName: 'terminal', onClick: () => openPath(inst.paths?.logsDir || '') },
      { separator: true },
      { label: '复制启动命令', iconName: 'copy', onClick: () => showCommandPreview(inst, true) },
      { label: '导出为整合包', iconName: 'archive', onClick: () => openPackExport(inst) },
      { label: '导出实例配置', iconName: 'save', onClick: () => exportInstance(inst) },
      { label: '复制实例', iconName: 'copy', disabled: running, title: running ? '请先退出游戏' : '', onClick: () => duplicateInstance(inst) },
      { separator: true },
      { label: '删除实例', iconName: 'trash', danger: true, disabled: running, title: running ? '请先退出游戏' : '', onClick: () => deleteInstanceAction(inst) }
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

// 设置已并入整页设置：启动器侧栏只负责跳到「启动器」分组。
async function openLauncherSettings(section = 'launcher-root') {
  if (typeof helpers.openSettings === 'function') {
    try {
      await helpers.openSettings(section)
      return
    } catch (e) {
      toast('打开设置失败：' + e.message, 'err')
      return
    }
  }
  toast('设置页不可用，请刷新后重试', 'err')
}

/* ------------------------------------------------------------------ */
/* polling / statusbar                                                */
/* ------------------------------------------------------------------ */

async function pollStatus(force = false) {
  if (!state.active && !force) return
  if (!force && Date.now() - lastPollAt < 1200) return
  lastPollAt = Date.now()
  // 选中实例的启动状态单独节流拉取，并与全局状态并行；失败静默。
  const launchId = state.selectedId
  const wantLaunch = !!launchId && (force || Date.now() - lastLaunchPollAt >= 1800)
  let launchTask = null
  if (wantLaunch) {
    lastLaunchPollAt = Date.now()
    launchTask = fetchLaunchState(launchId, { notify: true })
  }
  try {
    const [data, community] = await Promise.all([
      api.status(),
      api.communityJobs().catch(() => ({ items: [] })),
      launchTask || Promise.resolve(null)
    ])
    const previousSessions = state.sessions
    state.sessions = data.sessions || []
    state.detection = data.detection || state.detection
    state.jobs = data.jobs || []
    state.communityJobs = community.items || []
    for (const id of [...state.stoppingIds]) {
      if (!state.sessions.some((item) => item.instanceId === id && isRunningSession(item))) state.stoppingIds.delete(id)
    }
    // 旧服务端/启动状态缺失时，用 session.failed 兜底显示持久诊断，主动停止不会触发。
    const before = previousSessions.find((item) => item.instanceId === state.selectedId)
    const after = state.sessions.find((item) => item.instanceId === state.selectedId)
    if (state.selectedId && after?.status === 'failed' && before?.status !== 'failed') {
      notifyLaunchFailure(state.selectedId, selectedInstance(), normalizeLaunchError({
        code: after.crash ? 'GAME_CRASHED' : 'GAME_EXITED',
        message: after.error || '游戏异常退出',
        crash: after.crash || null
      }, { message: '游戏异常退出' }))
      if (state.tab === 'overview') refreshOverviewLaunchPanel()
    } else if (before?.status === 'failed' && after?.status !== 'failed' && state.tab === 'overview') {
      refreshOverviewLaunchPanel()
    }
    updateRunningIndicators()
    updateHeroRuntime()
    paintRunningPanel()
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
      // 失败/取消时服务端会删掉这次新建的半成品实例；列表不刷新的话，
      // 点进去只会看到「实例不存在」。
      refreshAll().catch(() => {})
    } else if (finished.status === 'cancelled') {
      refreshAll().catch(() => {})
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
  // 服务端只保留最近 50 个任务；清掉已消失任务的 id，避免长时间运行时集合无限增长。
  const aliveJobIds = new Set(state.jobs.map((job) => job.id))
  for (const id of [...state.finishedNotified]) if (!aliveJobIds.has(id)) state.finishedNotified.delete(id)
  for (const id of [...state.lastJobState.keys()]) if (!aliveJobIds.has(id)) state.lastJobState.delete(id)
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
  startFriendsNotifier()
  if (state.view === 'instance') {
    if (state.selectedId) {
      await loadDetail(state.selectedId, { render: false })
      // 启动状态在后台拉取，hero 重绘后再补进度块，不阻塞页面。
      if (!launchOf(state.selectedId)) void fetchLaunchState(state.selectedId, { notify: false })
      renderMain()
    } else {
      renderMain()
    }
  }
  emitStatus()
}

function deactivate() {
  state.active = false
  state.pendingPackFile = null
  hideDropOverlay()
  stopPolling()
  stopFriendsNotifier()
  destroyContent()
  startBackgroundStatus()
}

function destroy() {
  deactivate()
  stopBackgroundStatus()
  stopFriendsNotifier()
  disposeUpdateChecker()
  state.installController?.destroy?.()
  state.javaController?.destroy?.()
  state.downloadsController?.destroy?.()
  state.friendsController?.dispose?.()
  state.installController = null
  state.javaController = null
  state.downloadsController = null
  state.friendsController = null
  closeContextMenu()
}

function commandItems() {
  const inst = selectedInstance()
  const account = selectedAccount()
  const selectedRunning = isRunningSession(sessionOf(inst?.id))
  const runningCount = runningSessions().length
  const items = [
    {
      group: '启动器',
      label: inst ? (selectedRunning ? `停止 ${inst.name}` : `启动 ${inst.name}`) : '新建 Minecraft 实例',
      hint: inst && account ? account.name : '需要账户',
      iconName: selectedRunning ? 'stop' : 'play',
      run: () => inst ? (selectedRunning ? stopSelected() : launchSelected()) : showView('install')
    },
    ...(runningCount
      ? [{ group: '启动器', label: '再开一个实例', hint: `${runningCount} 个运行中`, iconName: 'add', run: () => openLaunchAnother(inst) }]
      : []),
    { group: '启动器', label: '下载中心', iconName: 'download', run: () => showView('downloads') },
    { group: '启动器', label: '好友', iconName: 'user', run: () => showView('friends') },
    { group: '启动器', label: '新建实例 / 安装版本', iconName: 'add', run: () => showView('install') },
    { group: '启动器', label: '账户管理', hint: account ? account.name : '未登录', iconName: 'user', run: () => openAccounts() },
    { group: '启动器', label: 'Java 运行时', iconName: 'java', run: () => showView('java') },
    ...(state.settings?.needsSetup
      ? [{ group: '启动器', label: '选择游戏目录', hint: '尚未设置', iconName: 'folder', run: () => openSetup() }]
      : []),
    { group: '启动器', label: '设置', hint: '游戏目录 / 下载 / 启动', iconName: 'settings', run: () => openLauncherSettings() },
    { group: '启动器', label: '检查启动器更新', hint: '从 GitHub Releases 获取新版本', iconName: 'refresh', run: () => { checkForUpdates({ silent: false, force: true }) } }
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
  rootEl.addEventListener('dragenter', (e) => {
    if (!hasFileDrag(e)) return
    e.preventDefault()
    if (isOwnDropZone(e.target)) { hideDropOverlay(); return }
    showDropOverlay()
  })
  rootEl.addEventListener('dragover', (e) => {
    if (!hasFileDrag(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    // 安装页有自己的拖放区：那里由 dropEl 显示高亮，不能再叠一层整页遮罩。
    if (isOwnDropZone(e.target)) hideDropOverlay()
    else showDropOverlay()
  })
  rootEl.addEventListener('dragleave', (e) => {
    // relatedTarget 为空表示指针离开了窗口；内部元素之间移动不应关闭遮罩。
    if (!e.relatedTarget) hideDropOverlay()
  })
  rootEl.addEventListener('drop', async (e) => {
    // 安装页 dropEl 已经处理了这个文件；阻止冒泡失败时也不能重复上传。
    if (isOwnDropZone(e.target)) return
    const files = [...(e.dataTransfer.files || [])]
    if (!files.length) return
    e.preventDefault()
    hideDropOverlay()
    const file = files[0]
    if (!/\.(mrpack|zip)$/i.test(file.name)) { toast('请拖入 .mrpack 或整合包 ZIP', 'warn'); return }
    // 上传过程中再次拖入：保留当前进度，不重渲染安装页（重渲染会丢掉上传卡片）。
    if (state.installController?.isImporting?.()) {
      toast('正在导入整合包，请等待当前上传完成', 'warn')
      return
    }
    // 先把文件交给安装页，再切页：安装页渲染完成后会立刻切到「整合包 → 本地文件」
    // 并显示真实上传百分比，不再先静默上传 1 GB 再跳页。
    state.pendingPackFile = file
    try {
      await showView('install')
    } catch (err) {
      state.pendingPackFile = null
      toast('整合包导入失败：' + err.message, 'err')
    }
  })
  // 这三种情况不会稳定触发 dragleave：拖拽被 Esc 取消、窗口失焦、标签页隐藏。
  window.addEventListener('dragend', hideDropOverlay)
  window.addEventListener('blur', hideDropOverlay)
  document.addEventListener('visibilitychange', () => { if (document.hidden) hideDropOverlay() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideDropOverlay() }, true)
}

function hasFileDrag(event) {
  const types = event?.dataTransfer?.types
  if (!types) return false
  try { return [...types].includes('Files') } catch { return false }
}

function isOwnDropZone(target) {
  return !!(target && typeof target.closest === 'function' && target.closest('.lp-drop'))
}

function hideDropOverlay() {
  if (dropOverlayTimer) { clearTimeout(dropOverlayTimer); dropOverlayTimer = null }
  rootEl?.classList.remove('is-drop')
}

function showDropOverlay() {
  if (!rootEl) return
  rootEl.classList.add('is-drop')
  if (dropOverlayTimer) clearTimeout(dropOverlayTimer)
  // dragover 在指针静止时仍会周期性触发，每次都会续期；停止拖拽后 1.5 秒自动清除。
  dropOverlayTimer = setTimeout(hideDropOverlay, DROP_OVERLAY_TTL)
}

export { pageCtx, state }
