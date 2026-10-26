// 新建实例 / 整合包（在线搜索 + 本地文件）/ 导入已有 / 任务提示。
// 所有外部文本走 textContent；轮询定时器只在 render 后启动，destroy 时清空。
import { h, clear, fmtBytes, fmtAgo } from '../core/dom.js'
import { jobProgress, jobStatusLabel, jobMetaText } from '../core/jobs.js'
import { api as coreApi } from '../core/api.js'
import { icon } from '../ui/icons.js'
import { btn, input, seg, select, progress, spinner, badge, toggle } from '../ui/kit.js'
import { loaderInfo, sectionCard, emptyBlock } from './ui.js'
import { createPager, pageOffset, SEARCH_PAGE_SIZE, SEARCH_SORTS } from './search-pager.js'
import { optimizedJvmArgs } from './jvm.js'
import {
  versionCombo, partitionVersions, compatibleVersion, isMinecraftVersion, filterSummary, versionRowShell
} from './version-picker.js'
const FINISHED = new Set(['done', 'failed', 'cancelled'])
const STATUS = {
  queued: { label: '排队中', tone: 'warn', dot: 'warn' }, running: { label: '进行中', tone: 'info', dot: 'loading' },
  cancelling: { label: '取消中', tone: 'warn', dot: 'warn' }, done: { label: '已完成', tone: 'ok', dot: 'ok' },
  failed: { label: '失败', tone: 'bad', dot: 'bad' }, cancelled: { label: '已取消', tone: '', dot: '' }
}
const TYPE_LABEL = { install: '安装', pack: '整合包', repair: '修复', update: '更新', export: '导出整合包' }
const VERSION_TYPES = [['release', '正式版'], ['snapshot', '快照'], ['all', '全部']]
const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge']
const JOBS_POLL_MS = 1200
const MEM_MIN = 256
const MAX_PACK_BYTES = 4 * 1024 ** 3
const PACK_MODES = [['search', '搜索下载'], ['local', '本地文件']]
const MODPACK_SOURCES = [['modrinth', 'Modrinth'], ['curseforge', 'CurseForge']]
const MODPACK_SOURCE_LABEL = { modrinth: 'Modrinth', curseforge: 'CurseForge' }
// 版本列表接口不可用时的内置常用版本（与内容安装弹窗保持一致）。
const PACK_VERSION_FALLBACK = [
  '26.2', '26.1', '1.21.11', '1.21.8', '1.21.4', '1.21.1', '1.20.1',
  '1.20', '1.19.4', '1.18.2', '1.17.1', '1.16.5', '1.12.2', '1.8.9'
]
const LOADER_IDS = new Set(['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'])
const MC_SOURCE_LABEL = {
  inheritsFrom: '继承识别',
  jar: 'JAR 识别',
  clientVersion: '客户端版本识别',
  assetIndex: '资源索引识别',
  assets: '资源索引识别',
  versionDir: '版本目录识别'
}
const paneStyle = { display: 'flex', flexDirection: 'column', gap: '10px' }

function versionTime(value) {
  const ts = typeof value === 'number' ? value : Date.parse(String(value || ''))
  return Number.isFinite(ts) ? ts : 0
}

/** 导入扫描项的 mcSource → 中文说明；未知来源返回空串。 */
export function mcSourceLabel(source) {
  return MC_SOURCE_LABEL[String(source || '')] || ''
}

/** 该扫描项是否需要手动填写 MC 版本（自动识别失败或识别结果不合法）。 */
export function needsManualMc(item) {
  if (!item) return false
  if (item.needsMc === true) return true
  return !isMinecraftVersion(item.mc || '')
}

/** 导入前校验手动填写的 MC 版本；失败时返回中文原因。 */
export function validateImportMc(value) {
  const mc = String(value || '').trim()
  if (!mc) return { ok: false, mc: '', error: '请填写该版本对应的 Minecraft 版本，例如 1.21.8。' }
  if (!isMinecraftVersion(mc)) {
    return { ok: false, mc, error: `「${mc}」不是有效的 MC 版本号，请输入类似 1.21.8 / 26.3 / 24w14a 的版本。` }
  }
  return { ok: true, mc, error: '' }
}

/**
 * 内联安装卡摘要：与下载中心共用 core/jobs.js 的 jobMetaText（内部即 jobBytesText /
 * jobElapsedText 的语义）。排队「已排队 X」/ 运行「已进行 X」/ 完成「用时 X」；
 * 失败或取消不再显示「已进行」。
 */
export function installJobSummary(job, now = Date.now()) {
  if (!job) return ''
  const text = jobMetaText(job, now)
  if (text && text !== jobStatusLabel(job)) return text
  return STATUS[job.status]?.label || jobStatusLabel(job)
}

/**
 * 在线整合包版本分组：兼容版本优先并标注推荐，其余折叠。
 * mc 为空或非法时视为「全部版本」，不做兼容过滤。
 */
export function packVersionGroups(versions, { mc = '' } = {}) {
  const list = (Array.isArray(versions) ? versions : []).filter(Boolean)
  const target = String(mc || '').trim()
  if (!target || !isMinecraftVersion(target)) {
    const sorted = [...list].sort((a, b) => versionTime(b?.date) - versionTime(a?.date))
    const recommended = sorted.find((item) => {
      const type = String(item?.type || '').toLowerCase()
      return !type || type === 'release'
    }) || sorted[0]
    return { compatible: sorted, others: [], recommendedId: String(recommended?.id || ''), mc: '', loader: '' }
  }
  // 整合包自带加载器，这里只按 MC 版本判断兼容（kind = modpack）。
  return partitionVersions(list, { mc: target, loader: '', kind: 'modpack' })
}

/** 社区搜索 / 版本接口错误 → UI 文案；识别 CurseForge 未配置 API Key。 */
export function describeCommunityError(error) {
  const raw = String(error?.message || error || '未知错误')
  const cfKey = error?.code === 'CURSEFORGE_API_KEY' || /(API\s*Key|API\s*密钥|未配置.{0,24}密钥|未配置.{0,24}Key)/i.test(raw)
  return {
    raw,
    cfKey,
    message: cfKey
      ? '未配置 CurseForge API Key：请在「设置 → 社区资源」填写 CurseForge API Key，或改用 Modrinth 搜索整合包。'
      : raw
  }
}

/** 在线安装接口错误 → UI 文案；额外识别服务端尚未接入路由的情况。 */
export function describeOnlineInstallError(error) {
  const info = describeCommunityError(error)
  if (info.cfKey) return info
  if (/404|not found|返回内容不是 JSON|未知的接口|接口不存在/i.test(info.raw)) {
    return {
      ...info,
      message: '在线安装接口暂不可用（服务端未接入 /api/launcher/packs/install-online）；请改用「本地文件」安装，或更新启动器服务端。'
    }
  }
  return info
}
/**
 * Install / download center view (not a modal).
 * @param {{ api: import('./api.js').launcherApi, ui: import('./ui.js'), toast: Function,
 *   confirm: Function, openModal: Function, pickFile: Function, openPath: Function,
 *   getState: Function, reload: Function, showInstance: Function, showView: Function,
 *   openSettings: Function }} ctx
 * @returns {{ render(container: HTMLElement): void, destroy(): void }}
 */
export function createInstallCenter(ctx) {
  let active = null
  let pendingFile = null
  return {
    render(container) {
      if (!container) return
      active?.dispose()
      active = buildView(ctx, container)
      if (pendingFile && active?.importFile) {
        const file = pendingFile
        pendingFile = null
        void active.importFile(file)
      }
    },
    /** 整页拖入 / 外部入口：切到「整合包 → 本地文件」并立即上传。 */
    importFile(file) {
      if (!file) return Promise.resolve()
      if (active?.importFile) return active.importFile(file)
      pendingFile = file
      return Promise.resolve()
    },
    isImporting() { return active?.isImporting?.() === true },
    destroy() { active?.dispose(); active = null }
  }
}
function buildView(ctx, container) {
  let disposed = false
  let jobsTimer = null
  let jobsBusy = false
  let reloadPending = null
  let jobsStarted = false
  let jobsErrorShown = false
  const notified = new Set()
  const inlineCards = []
  const stateOf = () => { try { return ctx.getState?.() || {} } catch { return {} } }
  const notify = (message, type = 'info') => { try { ctx.toast?.(message, type) } catch {} }
  const setHint = (el, text, tone = '') => { el.textContent = text || ''; el.className = 'lp-hint' + (tone ? ' ' + tone : '') }
  const show = (el, on = true) => { el.style.display = on ? '' : 'none' }
  const option = (value, label) => h('option', { value }, label)
  const hint = (text, tone = '') => h('div', { class: 'lp-hint' + (tone ? ' ' + tone : '') }, text)
  const fill = (sel, text, disabled = true) => { clear(sel); sel.appendChild(option('', text)); sel.disabled = disabled }
  const row = (cls, ...kids) => h('div', { class: cls }, ...kids)
  const fld = (label, control, hintNode = null, grid = false) => h('div', {
    class: 'field', style: grid ? { gridColumn: '1 / -1' } : null
  }, h('label', {}, label), control, hintNode)
  const card = (title, subtitle, ...kids) => sectionCard({
    title, subtitle, body: h('div', { class: 'col', style: { gap: '8px' } }, ...kids)
  })
  const jobName = (job) => (job?.name || TYPE_LABEL[job?.type] || '任务')
  const basename = (p) => String(p || '').split(/[\\/]/).pop() || ''
  const agoOf = (value) => {
    const ts = typeof value === 'number' ? value : Date.parse(String(value || ''))
    return Number.isFinite(ts) ? fmtAgo(ts) : '未知'
  }
  function currentInstance() {
    const state = stateOf()
    const list = Array.isArray(state.instances) ? state.instances : []
    const raw = state.selectedInstance
    if (raw && typeof raw === 'object') return raw
    const id = (typeof raw === 'string' && raw) || state.selectedId || ''
    return list.find((item) => item.id === id) || null
  }
  function currentInstanceMc() {
    const mc = String(currentInstance()?.mc || '').trim()
    return isMinecraftVersion(mc) ? mc : ''
  }
  async function openInstance(id) {
    if (!id || typeof ctx.showInstance !== 'function') return
    try { await ctx.showInstance(id) } catch (e) { notify('打开实例失败：' + e.message, 'err') }
  }
  function reloadState() {
    if (disposed) return Promise.resolve()
    if (!reloadPending) reloadPending = Promise.resolve().then(() => ctx.reload?.()).catch(() => {}).finally(() => { reloadPending = null })
    return reloadPending
  }
  async function cancelJob(job) {
    if (!job?.id) return
    if (typeof ctx.confirm === 'function') {
      let ok = false
      try { ok = await ctx.confirm('取消这个任务？已下载完成的文件会保留。', { title: '取消任务', danger: true, okText: '取消任务' }) }
      catch { ok = false }
      if (!ok) return
    }
    try {
      await ctx.api.cancelJob(job.id)
      notify('已请求取消任务', 'info')
      await refreshJobs()
    } catch (e) { notify('取消失败：' + e.message, 'err') }
  }
  // ---------------- 内联进度卡 ----------------
  // 安装进度固定在页头下方（sticky），不再埋在「安装设置」卡片底部：
  // 用户滚动到内存/分组字段时，进度和失败原因仍然可见。
  const jobDock = h('div', { class: 'lp-job-dock', role: 'status', 'aria-live': 'polite', hidden: true })
  function createInlineJobCard(title) {
    let job = null
    const dotEl = h('span', { class: 'dot' })
    const titleEl = h('b', {})
    const pctEl = h('span', { class: 'lp-job-pct mono' })
    const badgeEl = h('span', { class: 'badge' })
    const phaseEl = h('div', { class: 'lp-hint' })
    const bar = progress(null, { className: 'lp-job-bar' })
    const metaEl = h('div', { class: 'lp-hint mono' })
    const errEl = h('div', { class: 'lp-hint bad', role: 'alert', style: { display: 'none' } })
    const cancelBtn = btn('取消任务', {
      size: 'xs', variant: 'danger',
      onClick: async () => {
        if (!job?.id) return
        try { await ctx.api.cancelJob(job.id); notify('已请求取消任务', 'info') } catch (e) { notify('取消失败：' + e.message, 'err') }
      }
    })
    const logBtn = btn('查看日志', { size: 'xs', iconName: 'terminal', onClick: () => ctx.showView?.('downloads') })
    const openBtn = btn('打开实例', { size: 'xs', variant: 'primary', iconName: 'arrow-right', onClick: () => { if (job?.instanceId) void openInstance(job.instanceId) } })
    const actionRow = h('div', { class: 'lp-job-actions' }, cancelBtn, logBtn, openBtn)
    const el = h('div', { class: 'lp-job', style: { display: 'none' } },
      h('div', { class: 'lp-job-head' }, dotEl,
        h('div', { style: { flex: '1 1 auto', minWidth: '0' } }, titleEl, phaseEl), pctEl, badgeEl),
      bar.el, metaEl, errEl, actionRow)
    jobDock.appendChild(el)
    function render() {
      if (!job) return
      const meta = STATUS[job.status] || STATUS.running
      const label = job.status === 'done' ? '安装完成' : job.status === 'failed' ? '安装失败' : job.status === 'cancelled' ? '已取消' : title
      dotEl.className = 'dot ' + (meta.dot || '')
      titleEl.textContent = label + (job.name ? ' · ' + job.name : '')
      titleEl.title = titleEl.textContent
      badgeEl.className = 'badge ' + (meta.tone || '')
      badgeEl.textContent = meta.label
      const text = [job.phase, job.detail].filter(Boolean).join(' · ')
      phaseEl.textContent = text || '准备中…'
      phaseEl.title = text
      // 服务端可能把 progress 置为 null（indeterminate）：统一交给 jobProgress 判断，
      // 只有它返回 null 时才显示不确定动画。
      const pct = jobProgress(job)
      bar.set(pct)
      bar.state(job.status === 'done' ? 'ok' : job.status === 'failed' ? 'bad' : '')
      pctEl.textContent = pct === null ? '' : Math.round(pct) + '%'
      pctEl.title = pct === null ? '进度未知' : `安装进度 ${Math.round(pct)}%`
      metaEl.textContent = installJobSummary(job)
      show(errEl, !!job.error)
      errEl.textContent = job.error || ''
      const active = ['queued', 'running', 'installing', 'cancelling'].includes(job.status)
      show(cancelBtn, active)
      show(logBtn, !active)
      show(openBtn, !active && !!job.instanceId)
    }
    const cardObj = {
      el,
      show(next) {
        if (!next) return
        job = next; el.style.display = ''; jobDock.hidden = false; render()
      },
      update(next) { if (!next) return; job = next; render() },
      id: () => job?.id || ''
    }
    inlineCards.push(cardObj)
    return cardObj
  }
  // ---------------- A. 新建实例 ----------------
  const settings = stateOf().settings || {}
  const defaultMin = Number(settings.defaultMinMemory) || 1024
  const defaultMax = Number(settings.defaultMemory) || 4096
  const form = {
    versionType: 'release', search: '', mc: '', loader: 'vanilla', loaderVersion: '',
    versions: [], latest: {}, nameDirty: false, javaPath: '', busy: false
  }
  let versionEpoch = 0
  let loaderEpoch = 0
  let javaEpoch = 0
  const latestRelease = badge('最新正式版 —', 'accent')
  const latestSnapshot = badge('最新快照 —')
  const versionTypeSeg = seg(VERSION_TYPES, form.versionType, (value) => {
    if (form.versionType === value) return
    form.versionType = value
    form.search = ''
    searchInput.value = ''
    loadVersions(value)
  }, { title: '版本类型' })
  const searchInput = input({
    placeholder: '搜索版本 ID，例如 1.20', class: 'grow', title: '按版本 ID 过滤',
    onInput: () => { form.search = searchInput.value.trim(); applyVersionFilter() }
  })
  searchInput.setAttribute('aria-label', '搜索 Minecraft 版本')
  const versionSel = h('select', {
    class: 'input', 'aria-label': 'Minecraft 版本', disabled: true,
    onchange: () => { if (!versionSel.value || versionSel.value === form.mc) return; form.mc = versionSel.value; onMcChanged() }
  }, option('', '正在获取版本…'))
  const versionHint = hint('正在获取版本列表…')
  const versionField = fld('Minecraft 版本', versionSel, versionHint)
  const loaderSeg = seg(LOADERS.map((id) => [id, loaderInfo(id).label]), form.loader, (value) => {
    if (form.loader === value) return
    form.loader = value
    form.loaderVersion = ''
    syncName()
    toggleLoaderFields()
    loadLoaderVersions()
  }, { title: '模组加载器' })
  const loaderRow = row('row wrap', h('span', { class: 'lp-hint', style: { flex: 'none' } }, '加载器'), loaderSeg)
  const loaderVerSel = h('select', {
    class: 'input', 'aria-label': '加载器版本', disabled: true,
    onchange: () => { form.loaderVersion = loaderVerSel.value }
  }, option('', '先选择 Minecraft 版本'))
  const loaderVersionHint = hint('')
  const loaderBusyEl = h('span', { class: 'dotline', style: { display: 'none' } }, spinner(11))
  const loaderVersionField = h('div', { class: 'field' }, h('label', { class: 'field-label' }, '加载器版本'),
    loaderVerSel, row('row', loaderVersionHint, loaderBusyEl))
  const vanillaField = h('div', { class: 'field' }, h('label', { class: 'field-label' }, '加载器版本'),
    hint('原版不需要加载器版本，将直接安装 Mojang 官方客户端。'))
  const nameInput = input({ placeholder: '实例名称（留空使用默认名称）', onInput: () => { form.nameDirty = true } })
  const minInput = input({ type: 'number', min: String(MEM_MIN), step: '256', value: String(defaultMin), title: '初始内存（MB）' })
  const maxInput = input({ type: 'number', min: String(MEM_MIN), step: '256', value: String(defaultMax), title: '最大内存（MB）' })
  minInput.setAttribute('aria-label', '初始内存 MB')
  maxInput.setAttribute('aria-label', '最大内存 MB')
  const javaSel = h('select', {
    class: 'input', 'aria-label': 'Java 路径', disabled: true,
    onchange: () => { form.javaPath = javaSel.value }
  }, option('', '自动选择（推荐）'))
  const javaHint = hint('选择 Minecraft 版本后自动检测本机 Java。')
  const javaField = h('div', { class: 'field', style: { gridColumn: '1 / -1' } },
    h('label', { class: 'field-label' }, 'Java 路径'), javaSel, javaHint)
  const groupInput = input({ value: String(settings.defaultGroup || ''), placeholder: '分组（可选）' })
  const optimizeJvm = toggle(true, () => {})
  const optimizeJvmHint = hint('一键写入 Aikar 风格 G1 参数，适合 4 GB 以上内存；只影响 GC，不改内存。')
  const optimizeJvmRow = h('div', { class: 'lp-switch-row lp-span-2' },
    h('div', {}, h('b', {}, '一键优化 JVM 参数'), optimizeJvmHint),
    optimizeJvm)
  const formError = h('div', { class: 'lp-hint bad', role: 'alert', style: { display: 'none' } })
  const installBtn = btn('安装实例', { variant: 'primary', iconName: 'download', onClick: () => submitInstall() })
  const inlineInstall = createInlineJobCard('安装进度')
  const rootNote = hint('文件将下载到当前启动器游戏目录' + (settings.root ? ' · ' + settings.root : '')
    + '。原版客户端约 20 MB，资源文件通常数百 MB；首次安装需要一些时间。')
  const createPane = h('div', { style: paneStyle },
    card('版本与加载器', '选择 Minecraft 版本，再决定是否安装模组加载器',
      row('row wrap', versionTypeSeg, h('div', { class: 'grow' }, searchInput)), versionField,
      loaderRow, loaderVersionField, vanillaField),
    card('实例设置', '名称、内存、Java 运行时与 JVM 参数',
      h('div', { class: 'lp-form-grid' }, fld('实例名称', nameInput, null, true),
        fld('初始内存（MB）', minInput), fld('最大内存（MB）', maxInput), fld('分组', groupInput), javaField,
        optimizeJvmRow),
      hint('初始内存应小于或等于最大内存；留空 Java 路径时由启动器自动选择。'),
      rootNote, formError, row('row', installBtn)))
  async function loadVersions(type, preferId = '') {
    form.versionType = type
    versionTypeSeg.setValue?.(type)
    const epoch = ++versionEpoch
    form.versions = []
    fill(versionSel, '正在获取版本…')
    setHint(versionHint, '正在从 Mojang 获取版本列表…')
    try {
      const data = await ctx.api.versions({ type })
      if (disposed || epoch !== versionEpoch) return
      form.versions = Array.isArray(data?.items) ? data.items : []
      if (data?.latest) form.latest = data.latest
      updateLatest()
      syncPackInstance()
      applyVersionFilter(preferId)
    } catch (e) {
      if (disposed || epoch !== versionEpoch) return
      form.mc = ''
      fill(versionSel, '（获取版本失败）')
      setHint(versionHint, '获取版本失败：' + e.message, 'bad')
      clearLoaderForNoMc()
      clearJavaForNoMc()
      syncName()
    }
  }
  function updateLatest() {
    latestRelease.textContent = '最新正式版 · ' + (form.latest?.release || '—')
    latestSnapshot.textContent = '最新快照 · ' + (form.latest?.snapshot || '—')
  }
  function applyVersionFilter(preferId = '') {
    const q = form.search.trim().toLowerCase()
    const list = q ? form.versions.filter((item) => String(item.id).toLowerCase().includes(q)) : form.versions.slice()
    clear(versionSel)
    if (!list.length) {
      fill(versionSel, q ? '没有匹配的版本' : '（没有可用版本）')
      setHint(versionHint, q ? `没有匹配「${form.search}」的版本` : '版本列表为空，请稍后刷新', q ? 'warnc' : 'bad')
      if (form.mc) { form.mc = ''; clearLoaderForNoMc(); clearJavaForNoMc() }
      syncName()
      return
    }
    for (const item of list) versionSel.appendChild(option(item.id, item.id + (item.installed ? ' · 已安装' : '')))
    versionSel.disabled = false
    const ids = new Set(list.map((item) => item.id))
    const next = (preferId && ids.has(preferId)) ? preferId : (form.mc && ids.has(form.mc)) ? form.mc : list[0].id
    versionSel.value = next
    setHint(versionHint, q ? `${list.length} / ${form.versions.length} 个版本匹配「${form.search}」`
      : `${form.versions.length} 个版本可用 · 可直接搜索过滤`)
    if (next !== form.mc) { form.mc = next; onMcChanged() }
  }
  function onMcChanged() { form.loaderVersion = ''; syncName(); loadLoaderVersions(); loadJava() }
  function syncName() {
    if (!form.nameDirty) nameInput.value = form.mc ? form.mc + (form.loader === 'vanilla' ? '' : ' ' + loaderInfo(form.loader).label) : ''
  }
  function toggleLoaderFields() {
    const vanilla = form.loader === 'vanilla'
    loaderVersionField.style.display = vanilla ? 'none' : ''; vanillaField.style.display = vanilla ? '' : 'none'
  }
  function clearLoaderForNoMc() {
    form.loaderVersion = ''; fill(loaderVerSel, '先选择 Minecraft 版本')
    setHint(loaderVersionHint, '选择版本后再选择加载器版本。'); show(loaderBusyEl, false)
  }
  function clearJavaForNoMc() {
    form.javaPath = ''; fill(javaSel, '自动选择（推荐）')
    setHint(javaHint, '选择 Minecraft 版本后自动检测本机 Java。')
  }
  async function loadLoaderVersions() {
    const epoch = ++loaderEpoch
    const { mc, loader } = form
    if (loader === 'vanilla') { form.loaderVersion = ''; loaderVerSel.value = ''; return }
    if (!mc) { clearLoaderForNoMc(); return }
    fill(loaderVerSel, '正在获取加载器版本…')
    setHint(loaderVersionHint, '正在获取 ' + loaderInfo(loader).label + ' 版本…')
    show(loaderBusyEl, true)
    try {
      const data = await ctx.api.loaderVersions(loader, mc)
      if (disposed || epoch !== loaderEpoch) return
      const items = Array.isArray(data?.items) ? data.items : []
      if (!items.length) {
        fill(loaderVerSel, '（该版本没有可用加载器版本）')
        form.loaderVersion = ''
        setHint(loaderVersionHint, loaderInfo(loader).label + ' 没有适用于 ' + mc + ' 的版本', 'bad')
        return
      }
      clear(loaderVerSel)
      for (const item of items) loaderVerSel.appendChild(option(item.version, item.version + (item.stable ? ' · 推荐' : '') + (item.label ? ' · ' + item.label : '')))
      const preferred = items.find((item) => item.stable) || items[0]
      form.loaderVersion = preferred.version; loaderVerSel.value = preferred.version; loaderVerSel.disabled = false
      setHint(loaderVersionHint, `${items.length} 个版本 · 推荐 ${preferred.version}`)
    } catch (e) {
      if (disposed || epoch !== loaderEpoch) return
      fill(loaderVerSel, '（获取加载器版本失败）')
      form.loaderVersion = ''
      setHint(loaderVersionHint, '获取加载器版本失败：' + e.message, 'bad')
    } finally {
      if (!disposed && epoch === loaderEpoch) show(loaderBusyEl, false)
    }
  }
  async function loadJava() {
    const epoch = ++javaEpoch
    const mc = form.mc
    if (!mc) { clearJavaForNoMc(); return }
    fill(javaSel, '正在检测 Java…')
    setHint(javaHint, '正在检测本机 Java 运行时…')
    try {
      const data = await ctx.api.java(false, mc)
      if (disposed || epoch !== javaEpoch) return
      const required = Number(data?.required) || 0
      const compatible = (Array.isArray(data?.items) ? data.items : [])
        .filter((item) => !required || Number(item.major) >= required)
        .sort((a, b) => (Number(b.major) || 0) - (Number(a.major) || 0))
      clear(javaSel)
      javaSel.appendChild(option('', required ? `自动选择（Java ${required}+）` : '自动选择（推荐）'))
      for (const item of compatible) javaSel.appendChild(option(item.path, `Java ${item.major || '?'} · ${item.version || ''}${item.bundled ? ' · 内置' : ''} · ${item.path}`))
      form.javaPath = compatible.some((item) => item.path === form.javaPath) ? form.javaPath : ''
      javaSel.value = form.javaPath; javaSel.disabled = false
      const missing = required ? `未检测到 Java ${required}+；安装时仍会尝试自动选择，可在「Java 运行时」中下载。` : '未检测到 Java 运行时，安装时将自动选择。'
      setHint(javaHint, compatible.length ? `需要 Java ${required}+ · 检测到 ${compatible.length} 个兼容运行时` : missing, compatible.length ? '' : 'warnc')
    } catch (e) {
      if (disposed || epoch !== javaEpoch) return
      fill(javaSel, '自动选择（推荐）', false)
      form.javaPath = ''
      setHint(javaHint, 'Java 检测失败：' + e.message + '（将自动选择）', 'bad')
    }
  }
  function readMemory(minEl, maxEl) {
    const min = Math.round(Number(minEl.value)), max = Math.round(Number(maxEl.value))
    if (!Number.isFinite(min) || min < MEM_MIN) return { error: `初始内存至少 ${MEM_MIN} MB` }
    if (!Number.isFinite(max) || max < MEM_MIN) return { error: `最大内存至少 ${MEM_MIN} MB` }
    if (min > max) return { error: '初始内存不能大于最大内存' }
    return { min, max }
  }
  async function submitInstall() {
    formError.textContent = ''
    show(formError, false)
    if (!form.mc) { formError.textContent = '请先选择 Minecraft 版本'; show(formError, true); versionSel.focus?.(); return }
    if (form.loader !== 'vanilla' && !form.loaderVersion) {
      formError.textContent = '请选择加载器版本'; show(formError, true); loaderVerSel.focus?.(); return
    }
    const memory = readMemory(minInput, maxInput)
    if (memory.error) { formError.textContent = memory.error; show(formError, true); minInput.focus?.(); return }
    if (form.busy) return
    form.busy = true
    installBtn.disabled = true
    installBtn.classList.add('loading')
    try {
      const result = await ctx.api.install({
        name: nameInput.value.trim(), mc: form.mc, loader: form.loader,
        loaderVersion: form.loader === 'vanilla' ? '' : form.loaderVersion,
        memory: { min: memory.min, max: memory.max }, minMemory: memory.min,
        javaPath: javaSel.value || '', group: groupInput.value.trim(),
        jvmArgs: optimizeJvm.querySelector('input')?.checked ? optimizedJvmArgs('') : ''
      })
      if (disposed) return
      const job = result?.job
      if (!job?.id) throw new Error('服务端没有返回安装任务')
      inlineInstall.show(job)
      inlineInstall.el.scrollIntoView?.({ block: 'nearest' })
      notify('已开始安装：' + (job.name || form.mc), 'ok')
      await reloadState()
      refreshJobs()
    } catch (e) {
      if (!disposed) { formError.textContent = '安装失败：' + e.message; show(formError, true); notify('安装失败：' + e.message, 'err') }
    } finally {
      form.busy = false
      installBtn.disabled = false
      installBtn.classList.remove('loading')
    }
  }
  // ---------------- B. 整合包（在线搜索 / 本地文件） ----------------
  const pack = {
    mode: 'search', path: '', meta: null, busy: false, nameDirty: false,
    versionTouched: false, instanceMc: ''
  }
  let packEpoch = 0
  let packVersionOptions = PACK_VERSION_FALLBACK.slice()
  const packJobWatches = new Map()
  const packModeHint = hint('从 Modrinth / CurseForge 在线搜索并安装整合包')
  const packModeSeg = seg(PACK_MODES, pack.mode, (value) => switchPackMode(value), { title: '整合包来源' })

  /* --- 本地文件节点（行为与改造前一致） --- */
  const packPathInput = input({ readonly: true, mono: true, placeholder: '尚未选择整合包文件', title: '整合包路径' })
  const packChooseBtn = btn('选择文件', { size: 'sm', iconName: 'folder', onClick: () => choosePackFile() })
  const packInspectHint = hint('选择本机整合包后，会先解析名称与运行时再安装。')
  const packMetaRow = h('div', { class: 'row wrap', style: { gap: '5px', display: 'none' } })
  const packError = h('div', { class: 'lp-hint bad', role: 'alert', style: { display: 'none' } })
  const packFileInput = h('input', { type: 'file', accept: '.mrpack,.zip,application/zip', style: { display: 'none' } })
  packFileInput.addEventListener('change', () => { const file = packFileInput.files?.[0]; packFileInput.value = ''; if (file) uploadPack(file) })
  const dropEl = h('div', {
    class: 'lp-drop', role: 'button', tabindex: '0', title: '拖入或点击选择 .mrpack / .zip',
    onclick: () => { if (!pack.busy) packFileInput.click() },
    onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && !pack.busy) { e.preventDefault(); packFileInput.click() } }
  }, icon('upload', { size: 22 }), h('b', {}, '拖入整合包，或点击选择'),
  h('span', { class: 'lp-hint' }, '支持 Modrinth .mrpack 与 CurseForge .zip，最大 4 GB'), packFileInput)
  // 安装页的拖放区由自己处理，必须阻止冒泡，否则根节点的整页拖放处理器
  // 会把同一个文件再上传一次，最终创建两个安装任务。
  dropEl.addEventListener('dragenter', (e) => { e.preventDefault(); e.stopPropagation() })
  dropEl.addEventListener('dragover', (e) => {
    e.preventDefault(); e.stopPropagation()
    if (!pack.busy) dropEl.classList.add('over')
  })
  dropEl.addEventListener('dragleave', (e) => { e.stopPropagation(); dropEl.classList.remove('over') })
  dropEl.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); dropEl.classList.remove('over')
    const file = e.dataTransfer?.files?.[0]
    if (file) uploadPack(file)
  })
  const uploadWrap = h('div', { style: { display: 'none' } })
  const uploadBar = progress(0, { className: 'lp-job-bar' })
  const uploadText = h('div', { class: 'lp-hint mono' })
  uploadWrap.append(uploadBar.el, uploadText)

  /* --- 两种模式共用的安装设置 --- */
  const packNameInput = input({ placeholder: '实例名称（默认使用整合包名称）', onInput: () => { pack.nameDirty = true } })
  const packMinInput = input({ type: 'number', min: String(MEM_MIN), step: '256', value: String(defaultMin), title: '初始内存（MB）' })
  const packMaxInput = input({ type: 'number', min: String(MEM_MIN), step: '256', value: String(defaultMax), title: '最大内存（MB）' })
  const packGroupInput = input({ value: String(settings.defaultGroup || ''), placeholder: '分组（可选）' })
  const packOpenWhenDone = toggle(true, () => {}, { title: '安装完成后自动打开实例' })
  const packOpenRow = h('div', { class: 'lp-switch-row lp-span-2' },
    h('div', {}, h('b', {}, '完成后打开实例'),
      hint('安装完成后自动切换到新实例；在线与本地整合包都生效。默认开启。')),
    packOpenWhenDone)
  const packOpenChecked = () => !!packOpenWhenDone.querySelector('input')?.checked
  const packInstallBtn = btn('安装整合包', { variant: 'primary', iconName: 'download', disabled: true, onClick: () => installPack() })
  const inlinePack = createInlineJobCard('整合包安装')

  /* --- 在线搜索状态 --- */
  const search = {
    source: 'modrinth', query: '', view: 'search', project: null,
    results: [], total: 0, notice: '', error: '', loaded: false, loading: false,
    versions: [], versionNotice: '', versionError: '', versionLoading: false,
    showOthers: false, cfKey: false, cfOk: false, busy: false, jobId: '', seq: 0,
    sort: 'relevance', page: 1
  }
  const initialPackMc = currentInstanceMc()
  const packSourceSeg = seg(MODPACK_SOURCES, search.source, (value) => setPackSource(value), { title: '整合包来源' })
  const packQueryInput = input({
    placeholder: '搜索整合包名称，回车开始搜索',
    class: 'grow', title: '搜索整合包',
    onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); void searchPacks() } }
  })
  packQueryInput.setAttribute('aria-label', '搜索整合包')
  const packSearchBtn = btn('搜索', { size: 'sm', variant: 'primary', iconName: 'search', onClick: () => void searchPacks() })
  const packSortSel = select(SEARCH_SORTS, search.sort, {
    ariaLabel: '排序方式',
    title: '排序方式：按下载量可优先查看热门整合包',
    onchange: (value) => {
      search.sort = value
      void searchPacks()
    }
  })
  packSortSel.style.width = '132px'
  packSortSel.style.flex = '0 0 auto'
  const packVersionCombo = versionCombo({
    value: initialPackMc,
    instanceMc: initialPackMc,
    versions: packVersionOptions,
    title: '按 Minecraft 版本筛选整合包',
    onChange: () => {
      pack.versionTouched = true
      search.showOthers = false
      updatePackFilterLine()
      if (search.view === 'versions') paintPackVersions()
      else if (search.loaded) void searchPacks()
    }
  })
  const packFilterLine = h('div', { class: 'lp-filter-line' })
  const packSearchStatus = hint('')
  const packSearchNotice = h('div', { class: 'lp-hint warnc', role: 'status', style: { display: 'none' } })
  const packSearchError = h('div', { class: 'lp-hint bad', role: 'alert', style: { display: 'none' } })
  const packCfHint = h('div', { class: 'lp-hint warnc', style: { display: 'none' } })
  const packCfGuide = h('div', { class: 'lp-form-note lp-danger-note', style: { display: 'none' } },
    h('b', {}, 'CurseForge 需要 API Key'),
    h('p', { style: { margin: '2px 0 0' } },
      '当前未配置 CurseForge API Key，搜索与在线安装都会失败。请到「设置 → 社区资源 → CurseForge API Key」填写 Eternal API Key 后重试，或改用 Modrinth。'),
    h('div', { class: 'lp-row-actions', style: { marginTop: '6px' } },
      btn('前往设置', { size: 'sm', variant: 'primary', iconName: 'settings', onClick: () => openPackSettings() }),
      btn('改用 Modrinth', { size: 'sm', onClick: () => setPackSource('modrinth') })))
  const packResults = h('div', { class: 'lp-list', style: { maxHeight: '440px', overflowY: 'auto', paddingRight: '2px' } })
  const packPager = createPager({
    pageSize: SEARCH_PAGE_SIZE,
    onChange: (next) => { void searchPacks({ page: next }) }
  })
  packPager.el.hidden = true

  /* --- 页面组装 --- */
  const packSearchPane = h('div', { style: paneStyle },
    card('搜索下载', '从 Modrinth / CurseForge 在线安装整合包',
      row('row wrap', packSourceSeg, h('div', { class: 'grow' }, packQueryInput), packSortSel, packSearchBtn),
      row('row wrap', h('span', { class: 'lp-hint', style: { flex: 'none' } }, 'MC 版本'), packVersionCombo.el, packFilterLine),
      packCfHint, packCfGuide, packSearchNotice, packSearchStatus, packSearchError, packResults, packPager.el))
  const packLocalPane = h('div', { style: { ...paneStyle, display: 'none' } },
    card('选择本地整合包', 'Modrinth / CurseForge / 本工具导出的整合包',
      row('row wrap', h('div', { class: 'grow' }, packPathInput), packChooseBtn),
      packInspectHint, packMetaRow, h('div', { class: 'hr', style: { margin: '2px 0' } }),
      dropEl, uploadWrap, packError, row('row', packInstallBtn)))
  const packSettingsCard = card('安装设置', '整合包会创建独立实例',
    h('div', { class: 'lp-form-grid' }, fld('实例名称', packNameInput, null, true),
      fld('初始内存（MB）', packMinInput), fld('最大内存（MB）', packMaxInput),
      fld('分组', packGroupInput)),
    packOpenRow,
    hint('初始内存应小于或等于最大内存。在线安装会先把整合包下载到启动器缓存，任务结束（成功 / 失败 / 取消）后自动清理临时文件。'),
    hint('CurseForge 整合包需要 API Key 才能补齐文件；缺少 Key 时搜索区域会显示设置引导。'))
  const packPane = h('div', { style: { ...paneStyle, display: 'none' } },
    row('row wrap', packModeSeg, h('span', { class: 'spacer' }), packModeHint),
    packSearchPane, packLocalPane, packSettingsCard)

  /* --- 本地文件行为 --- */
  function setPackError(text) { packError.textContent = text || ''; show(packError, !!text) }
  function updatePackBtn() {
    packInstallBtn.disabled = pack.busy || !pack.path || !pack.meta
    packChooseBtn.disabled = pack.busy
    dropEl.style.pointerEvents = pack.busy ? 'none' : ''; dropEl.style.opacity = pack.busy ? '.6' : ''
    packInstallBtn.classList.toggle('loading', pack.busy)
  }
  async function choosePackFile() {
    if (pack.busy || typeof ctx.pickFile !== 'function') return
    let path = null
    try { path = await ctx.pickFile('', { title: '选择整合包', exts: ['.mrpack', '.zip'] }) }
    catch (e) { setPackError('选择文件失败：' + e.message); return }
    if (!path || disposed) return
    packPathInput.value = path
    packPathInput.title = path
    inspectPack(path)
  }
  async function inspectPack(path) {
    const epoch = ++packEpoch
    pack.path = ''; pack.meta = null
    show(packMetaRow, false); setPackError('')
    setHint(packInspectHint, '正在解析整合包…')
    updatePackBtn()
    try {
      const meta = await ctx.api.packInspect(path)
      if (disposed || epoch !== packEpoch) return
      pack.meta = meta || {}
      pack.path = path
      const kind = meta?.kind === 'modrinth' ? 'Modrinth'
        : meta?.kind === 'curseforge' ? 'CurseForge'
          : meta?.kind === 'toolbox' ? '本工具导出的整合包' : '未知格式'
      clear(packMetaRow)
      packMetaRow.append(badge(kind, meta?.kind === 'modrinth' ? 'info' : 'accent'),
        badge(meta?.mc || '未声明 MC 版本', meta?.mc ? '' : 'warn'),
        badge(loaderInfo(meta?.loader).label + (meta?.loaderVersion ? ' ' + meta.loaderVersion : '')))
      show(packMetaRow, true)
      setHint(packInspectHint, '已解析：' + (meta?.name || basename(path)))
      if (!pack.nameDirty || !packNameInput.value.trim()) {
        packNameInput.value = meta?.name || basename(path).replace(/\.(mrpack|zip)$/i, '')
      }
    } catch (e) {
      if (disposed || epoch !== packEpoch) return
      setHint(packInspectHint, '解析失败：' + e.message, 'bad')
      setPackError('无法解析整合包：' + e.message)
      notify('解析整合包失败：' + e.message, 'err')
    } finally {
      if (!disposed && epoch === packEpoch) updatePackBtn()
    }
  }
  async function installPack() {
    setPackError('')
    if (!pack.path || !pack.meta) { setPackError('请先选择并解析整合包文件'); return }
    const memory = readMemory(packMinInput, packMaxInput)
    if (memory.error) { setPackError(memory.error); packMinInput.focus?.(); return }
    if (pack.busy) return
    pack.busy = true
    updatePackBtn()
    try {
      const result = await ctx.api.packInstall({
        source: pack.path, name: packNameInput.value.trim(),
        memory: { min: memory.min, max: memory.max }, minMemory: memory.min,
        group: packGroupInput.value.trim()
      })
      if (disposed) return
      const job = result?.job
      if (!job?.id) throw new Error('服务端没有返回安装任务')
      inlinePack.show(job)
      inlinePack.el.scrollIntoView?.({ block: 'nearest' })
      notify('已开始安装整合包：' + (job.name || pack.meta.name || ''), 'ok')
      watchPackJob(job, { openWhenDone: packOpenChecked() })
      refreshJobs()
    } catch (e) {
      if (!disposed) { setPackError('安装失败：' + e.message); notify('安装失败：' + e.message, 'err') }
    } finally {
      pack.busy = false
      updatePackBtn()
    }
  }
  async function uploadPack(file) {
    setPackError('')
    if (!/\.(mrpack|zip)$/i.test(file.name || '')) return setPackError('只支持 .mrpack 或 .zip 整合包')
    if (Number(file.size) > MAX_PACK_BYTES) return setPackError('整合包超过 4 GB，请改用「选择文件」从本机路径安装')
    if (pack.busy) return notify('已有整合包正在上传，请等待当前任务完成', 'warn')
    const packKey = [file.name, file.size, file.lastModified].join(':')
    // 先占住单飞标记，再查任务列表：两次快速拖入不会同时通过重复检查。
    pack.busy = true; updatePackBtn()
    try {
      // 同一个整合包已有任务在跑：先查一次任务列表，避免又上传整个文件才被服务端拒绝。
      const active = await findActivePackImport(packKey)
      if (disposed) return
      if (active) {
        setPackError(`该整合包正在安装中${active.name ? '：' + active.name : ''}，请等待完成后再试。`)
        notify(`该整合包正在安装中${active.name ? '：' + active.name : ''}，进度可在「下载中心」查看`, 'warn')
        return
      }
      show(uploadWrap, true); uploadBar.set(0)
      uploadText.textContent = '正在上传 ' + file.name + '…'
      uploadWrap.scrollIntoView?.({ block: 'nearest' })
      notify(`开始导入整合包：${file.name}（${fmtBytes(Number(file.size) || 0)}）`, 'info')
      const memory = readMemory(packMinInput, packMaxInput)
      const result = await ctx.api.packUpload(file, {
        name: packNameInput.value.trim(),
        maxMemory: memory.error ? 0 : memory.max,
        // 上传走 query 参数，之前只传了最大内存，分组/初始内存会被静默丢掉。
        minMemory: memory.error ? 0 : memory.min,
        group: packGroupInput.value.trim(),
        // 同一个文件在上一次导入结束前再次拖入时，服务端据此拒绝重复任务。
        packKey,
        onProgress: ({ loaded, total, ratio }) => {
          if (disposed) return
          const pct = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) * 100 : 0
          uploadBar.set(pct)
          uploadText.textContent = `上传 ${fmtBytes(loaded)} / ${total ? fmtBytes(total) : '?'} · ${Math.round(pct)}%`
        }
      })
      if (disposed) return
      const job = result?.job
      if (!job?.id) throw new Error('服务端没有返回安装任务')
      uploadBar.set(100); uploadText.textContent = '上传完成，已开始安装：' + file.name
      inlinePack.show(job); inlinePack.el.scrollIntoView?.({ block: 'nearest' })
      notify('整合包已上传，开始安装', 'ok')
      watchPackJob(job, { openWhenDone: packOpenChecked() })
      refreshJobs()
    } catch (e) {
      if (disposed) return
      setPackError('上传失败：' + e.message); notify('上传失败：' + e.message, 'err'); show(uploadWrap, false)
    } finally { pack.busy = false; updatePackBtn() }
  }
  async function findActivePackImport(packKey) {
    if (!packKey) return null
    try {
      const data = await ctx.api.jobs()
      const items = Array.isArray(data?.items) ? data.items : []
      return items.find((job) => job?.type === 'pack' && job.packKey === packKey && !FINISHED.has(job.status)) || null
    } catch { return null }
  }
  /** 外部入口（整页拖入）：切到本地文件页并立即开始上传。 */
  function importFile(file) {
    if (disposed || !file) return Promise.resolve()
    if (pack.busy) { notify('已有整合包正在上传，请等待当前任务完成', 'warn'); return Promise.resolve() }
    tabs.setValue?.('pack')
    switchPackMode('local')
    switchTab('pack')
    return uploadPack(file)
  }

  /* --- 在线搜索与安装 --- */
  function updatePackFilterLine() {
    clear(packFilterLine)
    const mc = packVersionCombo.getValue()
    packFilterLine.append(h('span', {}, filterSummary({ mc, loader: '', kind: 'modpack' })), h('span', { class: 'spacer' }),
      h('span', { class: 'lp-vc-badge' }, MODPACK_SOURCE_LABEL[search.source] || search.source))
  }
  function ensurePackVersionValue() {
    if (packVersionCombo.getValue() || pack.versionTouched) return
    const next = currentInstanceMc() || String(form.latest?.release || '')
    if (next) packVersionCombo.setValue(next, { silent: true })
  }
  function syncPackInstance() {
    const mc = currentInstanceMc()
    const before = packVersionCombo.getValue()
    packVersionCombo.setInstanceMc(mc)
    if (pack.versionTouched) {
      if (pack.instanceMc && packVersionCombo.getValue() === pack.instanceMc && mc && mc !== pack.instanceMc) {
        packVersionCombo.setValue(mc, { silent: true })
      }
    } else if (mc) {
      if (packVersionCombo.getValue() !== mc) packVersionCombo.setValue(mc, { silent: true })
    } else {
      ensurePackVersionValue()
    }
    pack.instanceMc = mc
    updatePackFilterLine()
    // 当前实例变化导致筛选版本被跟随更新时，同步刷新已展示的结果/版本列表。
    if (before !== packVersionCombo.getValue()) {
      if (search.view === 'versions' && search.project) paintPackVersions()
      else if (search.loaded && !search.loading) void searchPacks()
    }
  }
  async function loadPackVersionOptions() {
    try {
      const data = await ctx.api.versions({ type: 'all', limit: 400 })
      if (disposed) return
      const ids = (Array.isArray(data?.items) ? data.items : []).map((item) => String(item?.id || '')).filter(Boolean)
      if (ids.length) {
        packVersionOptions = ids
        packVersionCombo.setVersions(ids)
      }
      ensurePackVersionValue()
      updatePackFilterLine()
    } catch {
      // 版本列表获取失败时保留内置常用版本，不阻断搜索。
    }
  }
  function openPackSettings() {
    if (typeof ctx.openSettings === 'function') {
      try {
        const result = ctx.openSettings('community')
        if (result && typeof result.catch === 'function') result.catch((e) => notify('打开设置失败：' + e.message, 'err'))
        return
      } catch (e) { notify('打开设置失败：' + e.message, 'err'); return }
    }
    notify('请在左侧「设置 → 社区资源」中填写 CurseForge API Key', 'info')
  }
  function refreshCfGuide() {
    const cf = search.source === 'curseforge'
    show(packCfHint, cf)
    // 启动器设置里没有 community 段：Key 是否已配置由 bootstrap 的 community 标志给出。
    const snapshot = stateOf()
    const community = snapshot.settings?.community
    const known = community && typeof community.cfApiKey === 'string'
      ? !!community.cfApiKey.trim()
      : (typeof snapshot.community?.cfApiKeySet === 'boolean' ? snapshot.community.cfApiKeySet : null)
    const configured = known === true || search.cfOk
    show(packCfGuide, cf && (search.cfKey || known === false))
    packCfHint.textContent = configured
      ? 'CurseForge 已配置 API Key；如果搜索仍失败，请到「设置 → 社区资源」检查 Key 是否有效。'
      : 'CurseForge 需要 API Key：请在「设置 → 社区资源 → CurseForge API Key」填写后再搜索或安装。'
  }
  function setPackSource(value) {
    if (search.source !== value) {
      search.source = value
      search.view = 'search'
      search.project = null
      search.loaded = false
      search.loading = false
      search.error = ''
      search.results = []
      search.total = 0
      search.page = 1
      search.notice = ''
      search.versions = []
      search.showOthers = false
      search.seq++
    }
    packSourceSeg.setValue(value)
    refreshCfGuide()
    paintPackResults()
    void searchPacks()
  }
  function setSearchError(text) {
    packSearchError.textContent = text || ''
    show(packSearchError, !!text)
  }
  /** 社区接口错误：CurseForge 的 401/403 也按 Key 问题引导。 */
  function communityErrorMessage(error) {
    const info = describeCommunityError(error)
    if (search.source === 'curseforge' && /HTTP (401|403)/i.test(info.raw)) {
      return { ...info, cfKey: true, message: 'CurseForge API Key 无效或没有权限：请在「设置 → 社区资源」重新填写后重试。' }
    }
    return info
  }
  function onlinePackErrorMessage(error) {
    const info = describeOnlineInstallError(error)
    if (search.source === 'curseforge' && /HTTP (401|403)/i.test(info.raw)) {
      return { ...info, cfKey: true, message: 'CurseForge API Key 无效或没有权限：请在「设置 → 社区资源」重新填写后重试。' }
    }
    return info
  }
  async function searchPacks({ page: targetPage = 1 } = {}) {
    ensurePackVersionValue()
    updatePackFilterLine()
    setSearchError('')
    const token = ++search.seq
    search.page = Math.max(1, Math.round(Number(targetPage) || 1))
    search.query = packQueryInput.value.trim()
    search.loading = true
    search.error = ''
    search.loaded = false
    search.results = []
    search.total = 0
    search.notice = ''
    search.view = 'search'
    paintPackResults()
    try {
      const params = new URLSearchParams({
        source: search.source,
        type: 'modpack',
        query: search.query,
        gameVersion: packVersionCombo.getValue() || 'all',
        loader: 'none',
        limit: String(SEARCH_PAGE_SIZE),
        offset: String(pageOffset(search.page, SEARCH_PAGE_SIZE)),
        sort: search.sort
      })
      const data = await coreApi.get('/api/community/search?' + params)
      if (disposed || token !== search.seq) return
      search.results = Array.isArray(data?.items) ? data.items : []
      search.total = Number(data?.total) || search.results.length
      search.notice = String(data?.gameVersionNotice || '')
      search.loaded = true
      if (search.source === 'curseforge') { search.cfKey = false; search.cfOk = true; refreshCfGuide() }
    } catch (e) {
      if (disposed || token !== search.seq) return
      const info = communityErrorMessage(e)
      if (info.cfKey) { search.cfKey = true; search.cfOk = false; refreshCfGuide() }
      search.error = info.message
      search.loaded = true
    } finally {
      if (!disposed && token === search.seq) {
        search.loading = false
        paintPackResults()
      }
    }
  }
  function packIcon(hit) {
    if (hit?.icon) {
      return h('img', {
        class: 'lp-mod-result-icon', src: hit.icon, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer',
        onerror: (event) => event.target.replaceWith(h('span', { class: 'lp-mod-result-icon' }, icon('archive', { size: 16 })))
      })
    }
    return h('span', { class: 'lp-mod-result-icon' }, icon('archive', { size: 16 }))
  }
  function packLoaderIds(hit) {
    const raw = Array.isArray(hit?.loaders) && hit.loaders.length
      ? hit.loaders
      : (Array.isArray(hit?.categories) ? hit.categories : [])
    return [...new Set(raw.map((item) => String(item || '').toLowerCase()).filter((id) => LOADER_IDS.has(id)))]
  }
  function gameVersionText(list) {
    const versions = [...new Set((Array.isArray(list) ? list : []).map(String).filter((item) => isMinecraftVersion(item)))]
    if (!versions.length) return ''
    return versions.slice(0, 6).join(' / ') + (versions.length > 6 ? ` 等 ${versions.length} 个版本` : '')
  }
  function packHitRow(hit) {
    const open = () => void openPackProject(hit)
    const loaders = packLoaderIds(hit)
    const gameVersions = gameVersionText(hit?.gameVersions || hit?.versions)
    const categories = (Array.isArray(hit?.categories) ? hit.categories : [])
      .map(String)
      .filter((item) => item && !LOADER_IDS.has(item.toLowerCase()))
      .slice(0, 4)
    return h('div', {
      class: 'lp-row lp-mod-result', role: 'button', tabindex: '0', title: '查看可用版本',
      onclick: open,
      onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() } }
    },
    packIcon(hit),
    h('div', { class: 'lp-mod-main', style: { gap: '2px' } },
      h('div', { class: 'lp-mod-title' },
        h('b', { title: hit?.title || '' }, hit?.title || '未命名整合包'),
        loaders.map((id) => badge(loaderInfo(id).label, 'info'))),
      hit?.author ? h('div', { class: 'lp-hint' }, hit.author) : null,
      h('p', { class: 'lp-hint', style: { margin: 0 } }, hit?.summary || ''),
      h('div', { class: 'lp-mod-meta mono' },
        [`${Number(hit?.downloads || 0).toLocaleString()} 次下载`,
          hit?.updated ? '更新于 ' + agoOf(hit.updated) : '',
          gameVersions ? '支持 ' + gameVersions : ''].filter(Boolean).join(' · ')),
      categories.length ? h('div', { class: 'lp-hint' }, categories.join(' · ')) : null),
    h('span', { class: 'lp-chip' }, '查看版本'))
  }
  function paintPackResults() {
    updatePackFilterLine()
    show(packSearchNotice, !!search.notice)
    if (search.notice) packSearchNotice.textContent = search.notice
    clear(packResults)
    // 加载 / 失败 / 未搜索时不显示分页条，避免出现没有意义的「共 0 个结果」。
    packPager.el.hidden = true
    if (search.loading) {
      packSearchStatus.textContent = '正在搜索整合包…'
      packResults.appendChild(emptyBlock('正在搜索', `正在从 ${MODPACK_SOURCE_LABEL[search.source]} 获取整合包列表…`, spinner(14), 'search'))
      return
    }
    if (search.error) {
      packSearchStatus.textContent = ''
      packResults.appendChild(emptyBlock('搜索失败', search.error,
        btn('重试', { size: 'sm', iconName: 'refresh', onClick: () => void searchPacks() }), 'warning'))
      return
    }
    if (!search.loaded) {
      packSearchStatus.textContent = ''
      packResults.appendChild(emptyBlock('搜索并安装整合包',
        '输入名称后按回车搜索，也可以直接搜索热门整合包；安装会创建独立实例。',
        btn('搜索热门整合包', { size: 'sm', variant: 'primary', iconName: 'search', onClick: () => void searchPacks() }), 'archive'))
      return
    }
    if (!search.results.length) {
      packSearchStatus.textContent = '没有找到整合包'
      packResults.appendChild(emptyBlock('没有搜索结果',
        '换个关键词，或把 MC 版本切到「全部版本」再试；CurseForge 未配置 API Key 时会搜索失败。', null, 'search'))
      return
    }
    const total = search.total || search.results.length
    packSearchStatus.textContent = `共 ${total} 个结果 · 点击查看可用版本`
    for (const hit of search.results) packResults.appendChild(packHitRow(hit))
    packPager.set({ page: search.page, total, count: search.results.length, loading: false })
    packPager.el.hidden = false
    packResults.scrollTop = 0
  }
  async function openPackProject(hit) {
    if (!hit?.id) return
    search.view = 'versions'
    search.project = hit
    search.versions = []
    search.versionError = ''
    search.versionNotice = ''
    search.showOthers = false
    packPager.el.hidden = true
    setSearchError('')
    const token = ++search.seq
    search.versionLoading = true
    paintPackVersions()
    try {
      const params = new URLSearchParams({ source: search.source, id: String(hit.id), withMeta: '1' })
      const data = await coreApi.get('/api/community/versions?' + params)
      if (disposed || token !== search.seq) return
      const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : [])
      search.versions = items.filter((item) => item && item.id)
      search.versionNotice = Array.isArray(data)
        ? ''
        : String(data?.notice || data?.gameVersionNotice || '')
      if (search.source === 'curseforge') { search.cfKey = false; search.cfOk = true; refreshCfGuide() }
      if (!search.versions.length && !search.versionNotice) search.versionError = '该项目没有返回可下载的整合包版本。'
    } catch (e) {
      if (disposed || token !== search.seq) return
      const info = communityErrorMessage(e)
      if (info.cfKey) { search.cfKey = true; search.cfOk = false; refreshCfGuide() }
      search.versionError = info.message
    } finally {
      if (!disposed && token === search.seq && search.view === 'versions') {
        search.versionLoading = false
        paintPackVersions()
      }
    }
  }
  function packVersionRow(version, recommendedId) {
    const file = (version.files || []).find((item) => item.primary) || (version.files || [])[0]
    const action = btn(search.busy ? '提交中…' : '下载并安装', {
      size: 'sm', variant: 'primary', iconName: 'download', disabled: search.busy,
      onClick: (event) => void installPackOnline(version, event.currentTarget)
    })
    const mc = packVersionCombo.getValue()
    const row = versionRowShell({
      version,
      mc,
      loader: '',
      kind: 'modpack',
      recommended: !!recommendedId && String(version.id) === String(recommendedId),
      action,
      extraBadges: file ? [] : [badge('缺少下载文件', 'warn')]
    })
    if (compatibleVersion(version, { mc, loader: '', kind: 'modpack' })) row.classList.add('is-compatible')
    return row
  }
  function versionGroup(label, versions, { collapsed = false, toggleText = '', onToggle = null, recommendedId = '' } = {}) {
    return h('div', { class: 'lp-version-group' },
      label ? h('div', { class: 'lp-version-group-head' }, h('span', {}, label), badge(String(versions.length))) : null,
      collapsed
        ? h('button', {
          class: 'lp-version-group-toggle', type: 'button', 'aria-expanded': 'false',
          onclick: () => onToggle?.()
        }, icon('chevron-right', { size: 12 }), h('span', {}, toggleText || `其他版本（${versions.length}）`))
        : h('div', { class: 'lp-version-list' },
          ...versions.map((version) => packVersionRow(version, recommendedId))))
  }
  function paintPackVersions() {
    updatePackFilterLine()
    clear(packResults)
    packPager.el.hidden = true
    const project = search.project
    if (!project) { search.view = 'search'; paintPackResults(); return }
    const back = h('div', { class: 'lp-toolbar', style: { border: '0', padding: '0', marginBottom: '4px' } },
      btn('返回搜索结果', {
        size: 'sm', iconName: 'arrow-left',
        onClick: () => {
          search.seq++
          search.versionLoading = false
          search.view = 'search'
          paintPackResults()
        }
      }),
      h('div', { class: 'lp-mod-main', style: { flex: '1 1 auto' } },
        h('b', { style: { fontSize: '12px' } }, project.title || '整合包'),
        h('div', { class: 'lp-hint' },
          [MODPACK_SOURCE_LABEL[search.source], project.author, project.slug].filter(Boolean).join(' · '))))
    packResults.appendChild(back)
    const notice = search.versionNotice || search.notice
    show(packSearchNotice, !!notice)
    if (notice) packSearchNotice.textContent = notice
    if (search.versionLoading) {
      packSearchStatus.textContent = '正在读取版本列表…'
      packResults.appendChild(emptyBlock('正在读取版本', '正在从社区接口读取该整合包的全部版本…', spinner(14), 'archive'))
      return
    }
    if (search.versionError) {
      packSearchStatus.textContent = ''
      packResults.appendChild(emptyBlock('读取版本失败', search.versionError,
        btn('重试', { size: 'sm', iconName: 'refresh', onClick: () => void openPackProject(project) }), 'warning'))
      return
    }
    if (!search.versions.length) {
      packSearchStatus.textContent = ''
      packResults.appendChild(emptyBlock('没有可用版本', '这个项目没有可下载的整合包文件。', null, 'archive'))
      return
    }
    const mc = packVersionCombo.getValue()
    const group = packVersionGroups(search.versions, { mc })
    packSearchStatus.textContent = `${project.title || '整合包'} · ${search.versions.length} 个版本`
      + (mc ? ` · 适配 ${mc} 的 ${group.compatible.length} 个` : '')
    if (!mc) {
      packResults.appendChild(versionGroup(`全部版本（${group.compatible.length}）`, group.compatible, {
        recommendedId: group.recommendedId
      }))
      return
    }
    if (group.compatible.length) {
      packResults.appendChild(versionGroup(`适配 Minecraft ${mc} 的版本（${group.compatible.length}）`, group.compatible, {
        recommendedId: group.recommendedId
      }))
    } else {
      packResults.appendChild(h('div', { class: 'lp-version-empty' },
        h('b', {}, `该整合包没有适配 ${mc} 的版本`),
        h('p', {}, '可以查看全部版本，或把 MC 版本切换成该整合包支持的游戏版本后再试。'),
        h('div', { class: 'lp-row-actions' },
          btn('查看全部版本', {
            size: 'sm', variant: 'primary', iconName: 'arrow-down',
            onClick: () => { search.showOthers = true; paintPackVersions() }
          }),
          btn('切换 MC 版本', { size: 'sm', iconName: 'filter', onClick: () => packVersionCombo.focus?.() }))))
    }
    if (group.others.length) {
      if (search.showOthers) {
        packResults.appendChild(versionGroup(`其他版本（${group.others.length}）`, group.others))
        packResults.appendChild(h('div', { class: 'lp-row-actions', style: { marginTop: '4px' } },
          btn('只看适配版本', {
            size: 'sm', iconName: 'filter',
            onClick: () => { search.showOthers = false; paintPackVersions() }
          })))
      } else {
        packResults.appendChild(versionGroup('', group.others, {
          collapsed: true,
          toggleText: `其他版本（${group.others.length}）· 默认收起，点击展开`,
          onToggle: () => { search.showOthers = true; paintPackVersions() }
        }))
      }
    }
  }
  async function installPackOnline(version, button) {
    if (search.busy) return
    setSearchError('')
    if (!search.project?.id || !version?.id) { setSearchError('缺少整合包项目或版本信息，请返回并重新加载版本列表。'); return }
    const memory = readMemory(packMinInput, packMaxInput)
    if (memory.error) { setSearchError(memory.error); packMinInput.focus?.(); return }
    if (!pack.nameDirty) packNameInput.value = search.project.title || ''
    const openWhenDone = packOpenChecked()
    const payload = {
      source: search.source,
      projectId: String(search.project.id),
      versionId: String(version.id),
      name: packNameInput.value.trim(),
      memory: { min: memory.min, max: memory.max },
      minMemory: memory.min,
      group: packGroupInput.value.trim(),
      openWhenDone
    }
    search.busy = true
    if (button) { button.disabled = true; button.classList.add('loading') }
    try {
      const request = typeof ctx.api.packOnlineInstall === 'function'
        ? ctx.api.packOnlineInstall(payload)
        : coreApi.post('/api/launcher/packs/install-online', payload)
      const result = await request
      if (disposed) return
      const job = result?.job
      if (!job?.id) throw new Error('服务端没有返回在线安装任务')
      search.jobId = job.id
      inlinePack.show(job)
      inlinePack.el.scrollIntoView?.({ block: 'nearest' })
      notify('已开始下载并安装整合包：' + (job.name || payload.name || search.project.title || ''), 'ok')
      watchPackJob(job, { openWhenDone })
      refreshJobs()
    } catch (e) {
      if (disposed) return
      const info = onlinePackErrorMessage(e)
      if (info.cfKey) { search.cfKey = true; search.cfOk = false; refreshCfGuide() }
      setSearchError('在线安装失败：' + info.message)
      notify('在线安装失败：' + info.message, 'err')
      if (button) { button.disabled = false; button.classList.remove('loading') }
    } finally {
      search.busy = false
      if (!disposed) {
        for (const node of packResults.querySelectorAll('.lp-mod-actions .btn')) {
          node.disabled = false
          node.classList.remove('loading')
          if (node.textContent === '提交中…') node.textContent = '下载并安装'
        }
      }
    }
  }
  function stopPackJobWatch(id) {
    const timer = packJobWatches.get(id)
    if (timer) clearTimeout(timer)
    packJobWatches.delete(id)
  }
  function stopPackWatches() {
    for (const timer of packJobWatches.values()) clearTimeout(timer)
    packJobWatches.clear()
  }
  function watchPackJob(job, { openWhenDone = false } = {}) {
    if (!job?.id) return
    stopPackJobWatch(job.id)
    // 完成提示由这里统一发送，避免与下载中心的全量任务轮询重复 toast。
    notified.add(job.id + '|done')
    notified.add(job.id + '|failed')
    notified.add(job.id + '|cancelled')
    let misses = 0
    // 只取增量日志：这个轮询只用状态字段，不需要每 1.2 秒重传上千行安装器日志。
    let logCursor = 0
    const tick = async () => {
      if (disposed) return
      try {
        const data = await ctx.api.job(job.id, logCursor)
        if (disposed) return
        if (!data) {
          stopPackJobWatch(job.id)
          notify('安装任务已结束，请到实例列表或下载中心查看结果', 'info')
          void reloadState()
          return
        }
        if (Array.isArray(data.logs) && data.logs.length) {
          const lastSeq = Number(data.logs[data.logs.length - 1]?.seq) || 0
          if (lastSeq > logCursor) logCursor = lastSeq
        }
        misses = 0
        inlinePack.update(data)
        if (data.status === 'done') {
          stopPackJobWatch(job.id)
          notify('整合包安装完成：' + (data.name || job.name || '新实例'), 'ok')
          await reloadState()
          if (disposed) return
          void refreshJobs()
          const id = data.instanceId || job.instanceId
          if (openWhenDone) {
            if (id) await openInstance(id)
            else notify('安装完成，但服务端没有返回实例 ID，请到实例列表查看', 'warn')
          }
          return
        }
        if (data.status === 'failed' || data.status === 'cancelled') {
          stopPackJobWatch(job.id)
          if (data.status === 'failed') notify('整合包安装失败：' + (data.error || '未知原因'), 'err')
          else notify('整合包安装已取消', 'info')
          void reloadState()
          return
        }
        packJobWatches.set(job.id, setTimeout(tick, 1200))
      } catch (e) {
        if (disposed) return
        misses++
        if (misses >= 4) {
          stopPackJobWatch(job.id)
          notify('无法获取安装任务状态：' + e.message, 'err')
          return
        }
        packJobWatches.set(job.id, setTimeout(tick, 1600))
      }
    }
    packJobWatches.set(job.id, setTimeout(tick, 700))
  }
  function switchPackMode(value) {
    pack.mode = value
    // 程序化切换（拖入文件 / 下载中心载入）也要同步分段控件的选中态，
    // 否则页面显示本地文件，按钮却还停在「搜索下载」。
    packModeSeg.setValue?.(value)
    packSearchPane.style.display = value === 'search' ? 'flex' : 'none'
    packLocalPane.style.display = value === 'local' ? 'flex' : 'none'
    packModeHint.textContent = value === 'search'
      ? '从 Modrinth / CurseForge 在线搜索并安装整合包'
      : '从本机选择 .mrpack / .zip（含本工具导出的整合包）'
    if (value === 'search') {
      syncPackInstance()
      refreshCfGuide()
      if (!search.loaded && !search.loading && !search.error) void searchPacks()
    }
  }
  // ---------------- C. 导入已有 ----------------
  const imp = { dir: '', loading: false, scanned: false, roots: [], items: [] }
  let importEpoch = 0
  const scanDirInput = input({ placeholder: '可选：指定 .minecraft 目录（留空自动扫描）', mono: true, title: '启动器根目录，不是 versions 目录' })
  const browseScanDir = btn('浏览…', {
    size: 'sm',
    iconName: 'folder',
    title: '选择要导入的 .minecraft 目录',
    onClick: async () => {
      const dir = await ctx.pickDir(scanDirInput.value.trim(), { title: '选择 .minecraft 目录（含 versions 文件夹）' })
      if (!dir) return
      scanDirInput.value = dir
      await scanImport(dir)
    }
  })
  const importHint = hint('')
  const importError = h('div', { class: 'lp-hint bad', role: 'alert', style: { display: 'none' } })
  const importResults = h('div', { class: 'col', style: { gap: '8px' } })
  const importPane = h('div', { style: { ...paneStyle, display: 'none' } },
    card('导入已有版本', 'PCL2 / HMCL / 官方启动器 / 本地 .minecraft',
      row('row wrap', h('div', { class: 'grow' }, scanDirInput), browseScanDir,
        btn('扫描', { size: 'sm', iconName: 'refresh', onClick: () => scanImport(scanDirInput.value.trim()) })),
      h('div', { class: 'lp-hint' }, icon('warning', { size: 12 }),
        ' 只引用原目录，不复制游戏文件；原启动器的版本目录必须完整（版本 JSON、客户端 JAR），否则导入后无法启动。'),
      h('div', { class: 'lp-hint' },
        '自动识别失败时不会用文件夹名或实例名冒充 MC 版本；这类条目会标记「需要手动选择 MC 版本」，填写后才能导入。'),
      importHint, importError, importResults))
  async function scanImport(dir = '') {
    const epoch = ++importEpoch
    imp.dir = dir; imp.loading = true
    show(importError, false); clear(importResults)
    importResults.appendChild(emptyBlock('正在扫描已有版本', '读取默认 .minecraft 与 PCL2 / HMCL 目录…', spinner(12)))
    setHint(importHint, '正在扫描…')
    try {
      const data = await ctx.api.importScan(dir)
      if (disposed || epoch !== importEpoch) return
      imp.roots = Array.isArray(data?.roots) ? data.roots : []
      imp.items = Array.isArray(data?.items) ? data.items : []
      imp.scanned = true
      const missing = dir && !imp.roots.some((root) => String(root.dir).toLowerCase() === String(dir).toLowerCase())
      setHint(importHint, missing ? '该目录下没有 versions 文件夹，已显示其他扫描位置'
        : `启动器根目录：${data?.launcherRoot || '未知'}`, missing ? 'warnc' : '')
      renderImportResults()
    } catch (e) {
      if (disposed || epoch !== importEpoch) return
      clear(importResults)
      importResults.appendChild(emptyBlock('扫描失败', e.message, null, 'warning'))
      setHint(importHint, '扫描失败：' + e.message, 'bad')
    } finally {
      if (!disposed && epoch === importEpoch) imp.loading = false
    }
  }
  function renderImportResults() {
    clear(importResults)
    importResults.appendChild(h('div', { class: 'lp-subhead' }, '扫描位置'))
    if (!imp.roots.length) {
      importResults.appendChild(emptyBlock('没有找到可扫描的启动器目录',
        '请使用官方启动器、PCL2 或 HMCL 运行过一次游戏，或在上方选择一个包含 versions 文件夹的目录。'))
    } else {
      for (const root of imp.roots) {
        importResults.appendChild(h('div', { class: 'lp-import-row' }, icon('folder', { size: 14 }),
          h('div', { class: 'grow', style: { minWidth: '0' } }, h('div', { class: 'mono', title: root.dir }, root.dir),
            hint(`${root.versions || 0} 个版本 · ${root.source || '本地'}`)), badge(root.source || '本地')))
      }
    }
    const available = imp.items.filter((item) => !item.imported).length
    const needsMcCount = imp.items.filter((item) => !item.imported && needsManualMc(item)).length
    importResults.appendChild(h('div', { class: 'lp-subhead' }, `可导入版本 · ${available} 个可用 / 共 ${imp.items.length} 个`))
    importResults.appendChild(h('div', { class: 'lp-hint' },
      '自动识别失败不会静默使用实例名：需要手动填写的条目会显示「需要手动选择 MC 版本」，填写正确后才会导入。'))
    if (needsMcCount) {
      importResults.appendChild(h('div', { class: 'lp-hint warnc' },
        `有 ${needsMcCount} 个版本的 MC 版本无法自动识别，请在对应行填写，例如 1.21.8。`))
    }
    if (!imp.items.length) {
      importResults.appendChild(emptyBlock('没有可导入的版本', '确认所选目录下的 versions 文件夹里存在完整的版本 JSON。'))
      return
    }
    const listEl = h('div', { class: 'col', style: { gap: '4px', maxHeight: '360px', overflowY: 'auto' } })
    for (const item of imp.items) listEl.appendChild(importRow(item))
    importResults.appendChild(listEl)
  }
  function importRow(item) {
    const manual = needsManualMc(item)
    const inputNeeded = manual && !item.imported
    const sourceNote = mcSourceLabel(item.mcSource)
    const meta = []
    if (item.loader && item.loader !== 'vanilla') meta.push(loaderInfo(item.loader).label + (item.loaderVersion ? ' ' + item.loaderVersion : ''))
    if (item.lastModified) meta.push(fmtAgo(item.lastModified))
    const mcText = isMinecraftVersion(item.mc || '')
      ? `MC ${String(item.mc).trim()}${sourceNote ? '（' + sourceNote + '）' : ''}`
      : (item.mc ? `MC ${item.mc}` : 'MC 未识别')
    const mcInput = inputNeeded ? input({
      value: String(item.mcManual || '').trim(),
      placeholder: '例如 1.21.8', mono: true, title: '该版本对应的 Minecraft 版本',
      onInput: () => {
        item.mcManual = mcInput.value.trim()
        mcError.textContent = ''
        show(mcError, false)
      }
    }) : null
    if (mcInput) {
      mcInput.style.width = '150px'
      mcInput.setAttribute('aria-label', '该版本对应的 Minecraft 版本')
    }
    const mcError = h('div', { class: 'lp-hint bad', role: 'alert', style: { display: 'none' } })
    const button = btn(item.imported ? '已导入' : '导入', {
      size: 'sm', variant: item.imported ? 'ghost' : 'primary', disabled: item.imported,
      iconName: item.imported ? 'check' : 'download',
      onClick: () => void doImport(item, button, mcInput, mcError)
    })
    return h('div', { class: 'lp-import-row', title: item.gameDir || item.root || '' },
      h('div', { class: 'lp-import-main' },
        h('b', { style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: item.name || item.versionId },
          item.name || item.versionId),
        h('div', { class: 'lp-hint' },
          `${item.versionId} · ${[mcText, ...meta].join(' · ')}`),
        inputNeeded
          ? h('div', { class: 'lp-hint warnc', style: { display: 'flex', alignItems: 'center', gap: '4px' } },
            icon('warning', { size: 12 }), ' 需要手动选择 MC 版本')
          : null,
        inputNeeded ? h('div', { class: 'row', style: { gap: '6px', marginTop: '3px' } }, mcInput) : null,
        mcError),
      h('div', { class: 'lp-import-actions', style: { flexWrap: 'wrap', justifyContent: 'flex-end' } },
        badge(item.source || '本地'),
        item.isolated ? h('span', { class: 'badge info', title: '该版本自带 mods / saves，将使用版本目录作为游戏目录' }, '隔离目录') : null,
        item.hasJar ? null : h('span', { class: 'badge warn', title: '版本目录中缺少客户端 JAR，可能无法启动' }, '缺少 JAR'),
        manual
          ? h('span', { class: 'badge warn', title: item.imported ? '已导入实例，但扫描时未能自动识别 MC 版本' : '导入前必须手动填写 MC 版本' }, item.imported ? 'MC 未识别' : '需要手动选择 MC 版本')
          : h('span', { class: 'badge ok', title: sourceNote ? '自动识别来源：' + sourceNote : '已识别真实 MC 版本' }, `MC ${String(item.mc).trim()}`),
        item.imported ? h('span', { class: 'badge ok' }, '已导入') : null,
        button))
  }
  async function doImport(item, button, mcInput, mcError) {
    if (!item || item.imported) return
    show(importError, false)
    if (mcError) { mcError.textContent = ''; show(mcError, false) }
    let mc = isMinecraftVersion(item.mc || '') ? String(item.mc).trim() : ''
    if (mcInput) {
      const checked = validateImportMc(mcInput.value)
      if (!checked.ok) {
        if (mcError) { mcError.textContent = checked.error; show(mcError, true) }
        notify(checked.error, 'warn')
        mcInput.focus?.()
        return
      }
      mc = checked.mc
    }
    button.disabled = true; button.classList.add('loading')
    try {
      const result = await ctx.api.importVersion({
        dir: item.root,
        versionId: item.versionId,
        name: '',
        group: '',
        mc
      })
      if (disposed) return
      item.imported = true
      const instance = result?.instance
      notify('已导入：' + (instance?.name || item.name || item.versionId), 'ok')
      renderImportResults()
      await reloadState()
      if (instance?.id) await openInstance(instance.id)
    } catch (e) {
      if (disposed) return
      importError.textContent = '导入失败：' + e.message; show(importError, true)
      if (mcError && e.code === 'INVALID_MC_VERSION') { mcError.textContent = e.message; show(mcError, true) }
      if (mcInput && e.code === 'MC_VERSION_REQUIRED') mcInput.focus?.()
      notify('导入失败：' + e.message, 'err')
      button.disabled = false; button.classList.remove('loading')
    }
  }
  // ---------------- D. 任务提示 ----------------
  // 下载中心是独立页面；这里只保留内联进度卡和完成提示，避免安装表单与
  // 全量任务列表混在一起。
  function handleFinished(items) {
    for (const job of items) {
      if (!FINISHED.has(job.status)) continue
      const key = job.id + '|' + job.status
      if (notified.has(key)) continue
      notified.add(key)
      if (job.status === 'done') { notify('任务完成：' + jobName(job), 'ok'); void reloadState() }
      else if (job.status === 'failed') notify('任务失败：' + (job.error || jobName(job)), 'err')
    }
  }
  async function refreshJobs() {
    if (disposed || jobsBusy) return
    jobsBusy = true
    try {
      const data = await ctx.api.jobs()
      if (disposed) return
      const items = Array.isArray(data?.items) ? data.items : []
      if (!jobsStarted) {
        jobsStarted = true
        for (const job of items) if (FINISHED.has(job.status)) notified.add(job.id + '|' + job.status)
      }
      handleFinished(items)
      for (const cardObj of inlineCards) {
        const id = cardObj.id()
        const job = id ? items.find((item) => item.id === id) : null
        if (job) cardObj.update(job)
      }
    } catch (e) {
      if (!disposed && !jobsErrorShown) { jobsErrorShown = true; notify('无法获取任务列表：' + e.message, 'err') }
    } finally {
      jobsBusy = false
    }
  }
  // ---------------- 页头 / 分页 / 组装 ----------------
  const panes = { create: createPane, pack: packPane, import: importPane }
  function switchTab(id) {
    for (const [key, pane] of Object.entries(panes)) pane.style.display = key === id ? 'flex' : 'none'
    if (id === 'import' && !imp.scanned && !imp.loading) scanImport(imp.dir)
    if (id === 'pack') {
      syncPackInstance()
      refreshCfGuide()
      if (pack.mode === 'search' && !search.loaded && !search.loading && !search.error) void searchPacks()
    }
  }
  const tabs = seg([['create', '新建实例'], ['pack', '整合包'], ['import', '导入已有']], 'create', switchTab, { title: '安装方式' })
  tabs.setAttribute('aria-label', '新建实例')
  const header = h('header', { class: 'lp-toolbar' },
    h('div', { class: 'col', style: { gap: '1px' } }, h('span', { class: 'overline' }, 'Instance Setup'),
      h('h2', { style: { margin: 0 } }, '新建实例'), hint('安装 Minecraft、加载器与整合包，或导入已有版本。下载进度请到「下载中心」查看。')),
    h('span', { class: 'spacer' }),
    h('div', { class: 'row wrap', style: { gap: '5px' } }, latestRelease, latestSnapshot,
      btn('下载中心', { size: 'sm', iconName: 'download', onClick: () => ctx.showView?.('downloads') })))
  const root = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, header, jobDock, tabs,
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '980px' } },
      createPane, packPane, importPane))
  container.appendChild(root)
  toggleLoaderFields()
  loadVersions(form.versionType)
  loadPackVersionOptions()
  updatePackFilterLine()
  refreshCfGuide()
  refreshJobs()
  jobsTimer = setInterval(refreshJobs, JOBS_POLL_MS)

  // 下载中心 → 新建实例：载入已下载的本地整合包；auto 时直接开始安装。
  const pending = ctx.takePendingPackInstall?.() || null
  if (pending) {
    // 有文件时先切到本地模式再切页，避免 switchTab('pack') 顺手发起一次在线搜索。
    if (pending.path) switchPackMode('local')
    tabs.setValue?.('pack')
    switchTab('pack')
    if (pending.path) {
      pack.path = pending.path
      packPathInput.value = pending.path
      packPathInput.title = pending.path
      setHint(packInspectHint, '正在解析下载中心载入的整合包…')
      void inspectPack(pending.path).then(() => {
        if (disposed || !pack.meta) return
        if (pending.auto) void installPack()
        else notify('已载入整合包，确认安装设置后点击「安装整合包」', 'ok')
      })
    } else {
      packQueryInput.focus?.()
    }
  }
  // 整页拖入：安装页渲染完成后立即切到「整合包 → 本地文件」并开始上传，
  // 用户松手后马上看到真实进度，而不是先静默上传再跳页。
  const droppedFile = ctx.takePendingPackFile?.() || null
  if (droppedFile) void importFile(droppedFile)
  return {
    /** 整页拖入的整合包：切换到本地文件并上传；返回上传 Promise 便于去重。 */
    importFile,
    isImporting: () => pack.busy === true,
    dispose() {
      if (disposed) return
      disposed = true
      if (jobsTimer) clearInterval(jobsTimer)
      jobsTimer = null
      stopPackWatches()
      try { packVersionCombo.destroy() } catch {}
      root.remove()
    }
  }
}
