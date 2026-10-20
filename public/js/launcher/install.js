// 下载中心：新建实例 / 整合包 / 导入已有 / 任务队列。
// 所有外部文本走 textContent；轮询定时器只在 render 后启动，destroy 时清空。
import { h, clear, fmtBytes, fmtDuration, fmtAgo } from '../core/dom.js'
import { icon } from '../ui/icons.js'
import { btn, input, seg, progress, spinner, badge, toggle } from '../ui/kit.js'
import { loaderInfo, sectionCard, emptyBlock } from './ui.js'
import { optimizedJvmArgs } from './jvm.js'
const FINISHED = new Set(['done', 'failed', 'cancelled'])
const STATUS = {
  queued: { label: '排队中', tone: 'warn', dot: 'warn' }, running: { label: '进行中', tone: 'info', dot: 'loading' },
  cancelling: { label: '取消中', tone: 'warn', dot: 'warn' }, done: { label: '已完成', tone: 'ok', dot: 'ok' },
  failed: { label: '失败', tone: 'bad', dot: 'bad' }, cancelled: { label: '已取消', tone: '', dot: '' }
}
const TYPE_LABEL = { install: '安装', pack: '整合包', repair: '修复', update: '更新' }
const VERSION_TYPES = [['release', '正式版'], ['snapshot', '快照'], ['all', '全部']]
const LOADERS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge']
const JOBS_POLL_MS = 1200
const MEM_MIN = 256
const MAX_PACK_BYTES = 4 * 1024 ** 3
const paneStyle = { display: 'flex', flexDirection: 'column', gap: '10px' }
/**
 * Install / download center view (not a modal).
 * @param {{ api: import('./api.js').launcherApi, ui: import('./ui.js'), toast: Function,
 *   confirm: Function, openModal: Function, pickFile: Function, openPath: Function,
 *   getState: Function, reload: Function, showInstance: Function }} ctx
 * @returns {{ render(container: HTMLElement): void, destroy(): void }}
 */
export function createInstallCenter(ctx) {
  let active = null
  return {
    render(container) {
      if (!container) return
      active?.dispose()
      active = buildView(ctx, container)
    },
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
  function jobMetaText(job) {
    const parts = []
    if (job.total > 0) parts.push(`${fmtBytes(job.received)} / ${fmtBytes(job.total)}`)
    else if (job.received > 0) parts.push(fmtBytes(job.received))
    if (job.total > 0 && job.progress != null && !FINISHED.has(job.status)) parts.push(Math.round(job.progress) + '%')
    if (job.status === 'done' && job.startedAt && job.finishedAt) parts.push('用时 ' + fmtDuration((job.finishedAt - job.startedAt) / 1000))
    if (!parts.length) parts.push((STATUS[job.status] || STATUS.running).label)
    return parts.join(' · ')
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
  function createInlineJobCard(title) {
    let job = null
    const dotEl = h('span', { class: 'dot' })
    const titleEl = h('b', {})
    const badgeEl = h('span', { class: 'badge' })
    const phaseEl = h('div', { class: 'lp-hint' })
    const bar = progress(null, { className: 'lp-job-bar' })
    const metaEl = h('div', { class: 'lp-hint mono' })
    const errEl = h('div', { class: 'lp-hint bad', style: { display: 'none' } })
    const el = h('div', { class: 'lp-job', style: { display: 'none' } },
      h('div', { class: 'lp-job-head' }, dotEl,
        h('div', { style: { flex: '1 1 auto', minWidth: '0' } }, titleEl, phaseEl), badgeEl), bar.el, metaEl, errEl)
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
      bar.set(job.indeterminate || job.progress == null ? null : job.progress)
      bar.state(job.status === 'done' ? 'ok' : job.status === 'failed' ? 'bad' : '')
      metaEl.textContent = jobMetaText(job)
      show(errEl, !!job.error)
      errEl.textContent = job.error || ''
    }
    const cardObj = {
      el, show(next) { if (!next) return; job = next; el.style.display = ''; render() },
      update(next) { if (!next) return; job = next; render() }, id: () => job?.id || ''
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
      rootNote, formError, row('row', installBtn), inlineInstall.el))
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
  // ---------------- B. 整合包 ----------------
  const pack = { source: '', meta: null, busy: false }
  let packEpoch = 0
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
  dropEl.addEventListener('dragover', (e) => { e.preventDefault(); if (!pack.busy) dropEl.classList.add('over') })
  dropEl.addEventListener('dragleave', () => dropEl.classList.remove('over'))
  dropEl.addEventListener('drop', (e) => {
    e.preventDefault(); dropEl.classList.remove('over')
    const file = e.dataTransfer?.files?.[0]
    if (file) uploadPack(file)
  })
  const uploadWrap = h('div', { style: { display: 'none' } })
  const uploadBar = progress(0, { className: 'lp-job-bar' })
  const uploadText = h('div', { class: 'lp-hint mono' })
  uploadWrap.append(uploadBar.el, uploadText)
  const packNameInput = input({ placeholder: '实例名称（默认使用整合包名称）', onInput: () => { pack.nameDirty = true } })
  const packMinInput = input({ type: 'number', min: String(MEM_MIN), step: '256', value: String(defaultMin), title: '初始内存（MB）' })
  const packMaxInput = input({ type: 'number', min: String(MEM_MIN), step: '256', value: String(defaultMax), title: '最大内存（MB）' })
  const packInstallBtn = btn('安装整合包', { variant: 'primary', iconName: 'download', disabled: true, onClick: () => installPack() })
  const inlinePack = createInlineJobCard('整合包安装')
  const packPane = h('div', { style: { ...paneStyle, display: 'none' } },
    card('选择整合包', 'Modrinth / CurseForge 整合包',
      row('row wrap', h('div', { class: 'grow' }, packPathInput), packChooseBtn),
      packInspectHint, packMetaRow, h('div', { class: 'hr', style: { margin: '2px 0' } }),
      dropEl, uploadWrap, packError),
    card('安装设置', '整合包会创建独立实例',
      h('div', { class: 'lp-form-grid' }, fld('实例名称', packNameInput, null, true),
        fld('初始内存（MB）', packMinInput), fld('最大内存（MB）', packMaxInput)),
      hint('从本机路径安装前需要先解析成功；拖入 / 选择文件会先上传到启动器缓存，再由服务端安装。'),
      hint('CurseForge 整合包需要设置中的 CurseForge API Key 才能补齐文件；缺少 Key 时部分内容可能下载失败。'),
      row('row', packInstallBtn), inlinePack.el))
  function setPackError(text) { packError.textContent = text || ''; show(packError, !!text) }
  function updatePackBtn() {
    packInstallBtn.disabled = pack.busy || !pack.source || !pack.meta
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
    pack.source = ''; pack.meta = null
    show(packMetaRow, false); setPackError('')
    setHint(packInspectHint, '正在解析整合包…')
    updatePackBtn()
    try {
      const meta = await ctx.api.packInspect(path)
      if (disposed || epoch !== packEpoch) return
      pack.meta = meta || {}
      pack.source = path
      const kind = meta?.kind === 'modrinth' ? 'Modrinth' : meta?.kind === 'curseforge' ? 'CurseForge' : '未知格式'
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
    if (!pack.source || !pack.meta) { setPackError('请先选择并解析整合包文件'); return }
    const memory = readMemory(packMinInput, packMaxInput)
    if (memory.error) { setPackError(memory.error); packMinInput.focus?.(); return }
    if (pack.busy) return
    pack.busy = true
    updatePackBtn()
    try {
      const result = await ctx.api.packInstall({
        source: pack.source, name: packNameInput.value.trim(),
        memory: { min: memory.min, max: memory.max }, minMemory: memory.min
      })
      if (disposed) return
      const job = result?.job
      if (!job?.id) throw new Error('服务端没有返回安装任务')
      inlinePack.show(job)
      inlinePack.el.scrollIntoView?.({ block: 'nearest' })
      notify('已开始安装整合包：' + (job.name || pack.meta.name || ''), 'ok')
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
    if (pack.busy) return
    pack.busy = true; updatePackBtn(); show(uploadWrap, true); uploadBar.set(0)
    uploadText.textContent = '正在上传 ' + file.name + '…'
    try {
      const memory = readMemory(packMinInput, packMaxInput)
      const result = await ctx.api.packUpload(file, {
        name: packNameInput.value.trim(), maxMemory: memory.error ? 0 : memory.max,
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
      notify('整合包已上传，开始安装', 'ok'); refreshJobs()
    } catch (e) {
      if (disposed) return
      setPackError('上传失败：' + e.message); notify('上传失败：' + e.message, 'err'); show(uploadWrap, false)
    } finally { pack.busy = false; updatePackBtn() }
  }
  // ---------------- C. 导入已有 ----------------
  const imp = { dir: '', loading: false, scanned: false, roots: [], items: [] }
  let importEpoch = 0
  const scanDirInput = input({ placeholder: '可选：指定 .minecraft 目录（留空自动扫描）', mono: true, title: '启动器根目录，不是 versions 目录' })
  const importHint = hint('')
  const importError = h('div', { class: 'lp-hint bad', role: 'alert', style: { display: 'none' } })
  const importResults = h('div', { class: 'col', style: { gap: '8px' } })
  const importPane = h('div', { style: { ...paneStyle, display: 'none' } },
    card('导入已有版本', 'PCL2 / HMCL / 官方启动器 / 本地 .minecraft',
      row('row wrap', h('div', { class: 'grow' }, scanDirInput),
        btn('扫描', { size: 'sm', iconName: 'refresh', onClick: () => scanImport(scanDirInput.value.trim()) })),
      h('div', { class: 'lp-hint' }, icon('warning', { size: 12 }),
        ' 只引用原目录，不复制游戏文件；原启动器的版本目录必须完整（版本 JSON、客户端 JAR），否则导入后无法启动。'),
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
    importResults.appendChild(h('div', { class: 'lp-subhead' }, `可导入版本 · ${available} 个可用 / 共 ${imp.items.length} 个`))
    if (!imp.items.length) {
      importResults.appendChild(emptyBlock('没有可导入的版本', '确认所选目录下的 versions 文件夹里存在完整的版本 JSON。'))
      return
    }
    const listEl = h('div', { class: 'col', style: { gap: '4px', maxHeight: '360px', overflowY: 'auto' } })
    for (const item of imp.items) listEl.appendChild(importRow(item))
    importResults.appendChild(listEl)
  }
  function importRow(item) {
    const meta = [item.mc || '未知版本']
    if (item.loader && item.loader !== 'vanilla') meta.push(loaderInfo(item.loader).label + (item.loaderVersion ? ' ' + item.loaderVersion : ''))
    if (item.lastModified) meta.push(fmtAgo(item.lastModified))
    const button = btn(item.imported ? '已导入' : '导入', {
      size: 'sm', variant: item.imported ? 'ghost' : 'primary', disabled: item.imported,
      iconName: item.imported ? 'check' : 'download', onClick: () => doImport(item, button)
    })
    return h('div', { class: 'lp-import-row', title: item.gameDir || item.root || '' },
      h('div', { class: 'grow', style: { minWidth: '0' } },
        h('b', { style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.name || item.versionId),
        h('div', { class: 'lp-hint' }, `${item.versionId} · ${meta.join(' · ')}`)),
      badge(item.source || '本地'),
      item.isolated ? h('span', { class: 'badge info', title: '该版本自带 mods / saves，将使用版本目录作为游戏目录' }, '隔离目录') : null,
      item.hasJar ? null : h('span', { class: 'badge warn', title: '版本目录中缺少客户端 JAR，可能无法启动' }, '缺少 JAR'),
      item.imported ? h('span', { class: 'badge ok' }, '已导入') : null, button)
  }
  async function doImport(item, button) {
    if (!item || item.imported) return
    show(importError, false)
    button.disabled = true; button.classList.add('loading')
    try {
      const result = await ctx.api.importVersion({ dir: item.root, versionId: item.versionId })
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
  }
  const tabs = seg([['create', '新建实例'], ['pack', '整合包'], ['import', '导入已有']], 'create', switchTab, { title: '安装方式' })
  tabs.setAttribute('aria-label', '新建实例')
  const header = h('header', { class: 'lp-toolbar' },
    h('div', { class: 'col', style: { gap: '1px' } }, h('span', { class: 'overline' }, 'Instance Setup'),
      h('h2', { style: { margin: 0 } }, '新建实例'), hint('安装 Minecraft、加载器与整合包，或导入已有版本。下载进度请到「下载中心」查看。')),
    h('span', { class: 'spacer' }),
    h('div', { class: 'row wrap', style: { gap: '5px' } }, latestRelease, latestSnapshot,
      btn('下载中心', { size: 'sm', iconName: 'download', onClick: () => ctx.showView?.('downloads') })))
  const root = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, header, tabs,
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '980px' } },
      createPane, packPane, importPane))
  container.appendChild(root)
  toggleLoaderFields()
  loadVersions(form.versionType)
  refreshJobs()
  jobsTimer = setInterval(refreshJobs, JOBS_POLL_MS)
  return {
    dispose() {
      if (disposed) return
      disposed = true
      if (jobsTimer) clearInterval(jobsTimer)
      jobsTimer = null
      root.remove()
    }
  }
}
