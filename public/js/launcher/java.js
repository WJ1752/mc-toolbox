// Java 运行时视图：扫描本机 Java、手动指定 java.exe、下载 Temurin 运行时。
//
// 所有运行时都由后端真实执行 `java -version` 校验；本视图只展示结果。
// 下载任务是后端 job，轮询在视图销毁时必须停止，但下载本身会继续。
import { h, clear, copyText, escapeHtml } from '../core/dom.js'
import { icon } from '../ui/icons.js'
import { btn, select, spinner, openPath as coreOpenPath } from '../ui/kit.js'
import { pickFile as corePickFile } from '../core/dirpicker.js'
import { toast as defaultToast } from '../core/toast.js'
import { confirmDialog } from '../core/modal.js'
import { recommendedJava } from '../core/java-download.js'
import { launcherApi } from './api.js'
import * as launcherUi from './ui.js'

const MAJORS = Array.from({ length: 18 }, (_, index) => index + 8)
const LTS = new Set([8, 11, 17, 21, 25])
const STATUS_LABEL = {
  queued: '排队中',
  running: '下载中',
  cancelling: '正在取消',
  publishing: '正在发布',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

function helpers(ctx) {
  return Object.assign({}, launcherUi, ctx?.ui || {})
}

function apiOf(ctx) {
  return ctx?.api || launcherApi
}

function normPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function samePath(a, b) {
  return !!a && !!b && normPath(a) === normPath(b)
}

function dirname(value) {
  const text = String(value || '').replace(/[\\/]+$/, '')
  const index = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
  return index > 0 ? text.slice(0, index) : text
}

function shorten(value, max = 68) {
  const text = String(value || '')
  if (text.length <= max) return text
  const keep = Math.floor((max - 1) / 2)
  return text.slice(0, keep) + '…' + text.slice(-keep)
}

function isFinal(status) {
  return ['done', 'failed', 'cancelled'].includes(String(status || ''))
}

function selectedInstance(state) {
  const list = Array.isArray(state?.instances) ? state.instances : []
  const id = state?.selectedId || state?.selectedInstance || ''
  return list.find((item) => item.id === id) || list[0] || null
}

/** Local estimate used only for the download default; launch always re-checks. */
function suggestMajor(instance) {
  if (!instance) return 21
  const modern = /^(\d+)\./.exec(String(instance.mc || ''))
  if (modern && Number(modern[1]) >= 2) return 21
  return recommendedJava(instance)
}

/**
 * Create the Java runtime view.
 * @param {{api:object,ui:object,toast:Function,confirm:Function,pickFile:Function,
 *          openPath:Function,getState?:Function,reload?:Function}} ctx
 * @returns {{render: (container: HTMLElement) => void, destroy: () => void}}
 */
export function createJavaView(ctx = {}) {
  const api = apiOf(ctx)
  const U = helpers(ctx)
  const toast = ctx.toast || defaultToast
  const confirm = ctx.confirm || confirmDialog
  const pickFile = ctx.pickFile || corePickFile
  const openPath = ctx.openPath || coreOpenPath

  let destroyed = false
  let started = false
  let scanning = false
  let scanError = ''
  let items = []
  let defaultPath = ''
  let pollTimer = null
  let jobId = ''
  let downloading = false

  /* ---------------- download panel ---------------- */

  const instance = selectedInstance(ctx.getState?.())
  const preferred = suggestMajor(instance)
  const majorSelect = select(
    MAJORS.map((major) => [String(major), `Java ${major}${LTS.has(major) ? ' · LTS' : ''}（64 位）`]),
    String(MAJORS.includes(preferred) ? preferred : 21),
    { ariaLabel: '下载 Java 大版本' }
  )
  const downloadBtn = btn('下载并安装', { variant: 'primary', iconName: 'download', onClick: () => startDownload() })
  const cancelBtn = btn('中止下载', { variant: 'danger', size: 'sm', onClick: () => cancelDownload() })
  cancelBtn.hidden = true
  const jobStatus = h('span', { class: 'badge' })
  jobStatus.hidden = true
  const jobDetail = h('div', { class: 'lp-java-job-detail', 'aria-live': 'polite' })
  const jobPath = h('div', { class: 'lp-hint mono lp-java-job-path' })
  const jobError = h('div', { class: 'error', hidden: true })
  const bar = U.progressBar(0)
  bar.el.hidden = true

  const downloadBody = h('div', { class: 'lp-java-download' },
    h('div', { class: 'lp-hint' },
      '使用 Eclipse Temurin 官方构建，下载后校验 SHA-256 并真实运行 Java 检查版本与 64 位；校验失败不会加入可用列表。',
      '安装位置由工具箱管理，不写入系统环境变量。'),
    h('div', { class: 'lp-form-grid' },
      h('div', { class: 'field span-2' },
        h('label', {}, '目标大版本'),
        majorSelect,
        h('div', { class: 'hint' }, 'MC 1.20.5+ 需要 Java 21；1.18–1.20.4 需要 Java 17；1.17 需要 Java 16；更早版本通常使用 Java 8。')
      )
    ),
    h('div', { class: 'lp-row' }, downloadBtn, cancelBtn, jobStatus),
    bar.el,
    jobDetail,
    jobPath,
    h('div', { class: 'field' }, jobError)
  )
  const downloadCard = U.sectionCard({
    title: '下载 Java 运行时',
    subtitle: 'Eclipse Temurin · Windows 64 位 · 官方校验',
    body: downloadBody
  })
  downloadCard.classList.add('lp-java-download-card')

  function scrollToDownload() {
    try {
      downloadCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      majorSelect.focus({ preventScroll: true })
    } catch {}
  }

  const addBtn = btn('添加本机 Java', { size: 'sm', iconName: 'folder-open', onClick: () => addManual() })
  const refreshBtn = btn('重新扫描', { size: 'sm', iconName: 'refresh', onClick: () => load(true) })
  const downloadShortcut = btn('下载 Java', { size: 'sm', iconName: 'download', onClick: scrollToDownload })

  const summaryEl = h('div', { class: 'lp-row lp-java-summary' })
  const listEl = h('div', { class: 'lp-java-list', role: 'list', 'aria-label': '已检测到的 Java 运行时' })
  const scanStatus = h('div', { class: 'lp-hint lp-java-scan-status', 'aria-live': 'polite' })
  const headOverline = h('span', { class: 'overline' }, 'Runtime')
  const headTitle = h('h2', {}, 'Java 运行时')
  const headHint = h('div', { class: 'lp-hint' }, '扫描 PATH、JAVA_HOME、常见 JDK 目录、官方启动器 runtime 与工具箱内置运行时。')

  const root = h('div', { class: 'lp-java' },
    h('div', { class: 'lp-toolbar lp-java-head' },
      h('div', { class: 'lp-java-heading' }, headOverline, headTitle, headHint),
      h('span', { class: 'spacer' }),
      h('div', { class: 'lp-row lp-toolbar-actions' }, refreshBtn, addBtn, downloadShortcut)
    ),
    summaryEl,
    listEl,
    scanStatus,
    h('div', { class: 'lp-hint lp-java-rule' },
      h('b', {}, '版本要求：'),
      'MC 1.16 及更早 → Java 8；1.17 → Java 16；1.18–1.20.4 → Java 17；1.20.5 及以上 → Java 21。',
      h('div', {}, '启动前会校验 64 位与所需大版本：Java 8 只能用于需要 8 的版本，较高的 MC 版本允许使用更高的 Java；不匹配时会拒绝启动并提示。'),
      h('div', {}, '单个实例可以在实例设置中覆盖默认 Java；这里的「默认」只影响未单独指定 Java 的实例。')
    ),
    downloadCard
  )

  /* ---------------- list ---------------- */

  function renderSummary() {
    clear(summaryEl)
    const selected = defaultPath || items.find((item) => item.selected)?.path || ''
    summaryEl.appendChild(h('span', { class: 'lp-status badge ' + (selected ? 'ok' : 'warn') }, selected ? '已设置默认 Java' : '未设置默认 Java'))
    summaryEl.appendChild(h('span', { class: 'lp-hint' }, items.length ? `已发现 ${items.length} 个 64 位运行时` : '未发现可用的 64 位 Java'))
    if (selected) {
      summaryEl.appendChild(h('b', { class: 'lp-java-default mono', title: selected }, shorten(selected, 72)))
    }
  }

  function javaRow(item) {
    const isDefault = !!defaultPath && samePath(item.path, defaultPath)
    const setDefaultBtn = btn(isDefault ? '默认' : '设为默认', {
      size: 'sm',
      variant: isDefault ? 'ghost' : 'primary',
      iconName: isDefault ? 'check' : '',
      disabled: isDefault,
      onClick: () => setDefault(item.path)
    })
    const path = String(item.path || '')
    return h('div', { class: 'lp-java-row' + (isDefault ? ' active selected' : ''), role: 'listitem' },
      h('span', { class: 'lp-java-glyph', 'aria-hidden': 'true' }, icon('java', { size: 16 })),
      h('div', { class: 'lp-java-main' },
        h('div', { class: 'lp-row lp-java-title-line' },
          h('b', {}, `Java ${item.major ?? '?'}`),
          h('span', { class: 'lp-java-version' }, item.version || '未知版本'),
          h('strong', { class: 'badge' }, `${item.bits || 64} 位`),
          item.bundled ? h('strong', { class: 'badge accent', title: '由工具箱下载并校验' }, '内置') : null,
          isDefault ? h('strong', { class: 'badge ok' }, '默认') : null
        ),
        h('div', { class: 'lp-hint mono lp-java-path', title: path }, path)
      ),
      h('div', { class: 'lp-java-actions' },
        setDefaultBtn,
        btn('打开目录', { size: 'sm', iconName: 'folder-open', onClick: () => openPath(dirname(path)) }),
        btn('复制路径', { size: 'sm', iconName: 'copy', onClick: () => copyJavaPath(path) })
      )
    )
  }

  function renderList() {
    clear(listEl)
    if (scanning && !items.length) {
      listEl.appendChild(h('div', { class: 'lp-java-loading' }, spinner(14), '正在扫描本机 Java…'))
      return
    }
    if (scanError) {
      listEl.appendChild(U.emptyBlock('扫描失败', scanError, btn('重试', { size: 'sm', onClick: () => load(true) }), 'warning'))
      return
    }
    if (!items.length) {
      listEl.appendChild(U.emptyBlock(
        '没有发现 Java',
        '启动器会扫描常见 JDK 目录；也可以手动指定 java.exe，或直接下载一个 64 位运行时。',
        h('div', { class: 'lp-row' },
          btn('添加本机 Java', { size: 'sm', iconName: 'folder-open', onClick: () => addManual() }),
          btn('下载 Java', { size: 'sm', variant: 'primary', iconName: 'download', onClick: scrollToDownload })
        ),
        'java'
      ))
      return
    }
    for (const item of items) listEl.appendChild(javaRow(item))
  }

  async function copyJavaPath(path) {
    const ok = await copyText(path)
    toast(ok ? 'Java 路径已复制' : '复制失败', ok ? 'ok' : 'err')
  }

  /* ---------------- scan / default ---------------- */

  async function load(refresh) {
    if (scanning || destroyed) return
    scanning = true
    scanError = ''
    refreshBtn.disabled = true
    refreshBtn.classList.add('loading')
    scanStatus.textContent = refresh ? '正在重新扫描本机 Java…' : '正在扫描本机 Java…'
    renderList()
    try {
      const data = await api.java(!!refresh)
      if (destroyed) return
      items = Array.isArray(data.items) ? data.items : []
      defaultPath = String(data.default || items.find((item) => item.selected)?.path || '')
      scanStatus.textContent = items.length ? `已发现 ${items.length} 个 64 位 Java 运行时` : '没有发现可用的 64 位 Java'
    } catch (e) {
      if (destroyed) return
      scanError = e.message
      scanStatus.textContent = '扫描失败：' + e.message
      toast('扫描 Java 失败：' + e.message, 'err')
    } finally {
      scanning = false
      if (!destroyed) {
        refreshBtn.disabled = false
        refreshBtn.classList.remove('loading')
        renderSummary()
        renderList()
      }
    }
  }

  async function setDefault(path) {
    if (!path || destroyed) return
    try {
      await api.saveSettings({ defaultJava: path })
      if (destroyed) return
      defaultPath = path
      renderSummary()
      renderList()
      toast('已设为默认 Java', 'ok')
      Promise.resolve(ctx.reload?.()).catch(() => {})
    } catch (e) {
      toast('设置默认 Java 失败：' + e.message, 'err')
    }
  }

  async function addManual() {
    let picked = ''
    try {
      picked = await pickFile(defaultPath || items[0]?.path || '', { title: '选择 java.exe', exts: ['.exe'] })
    } catch (e) {
      toast('无法打开文件选择器：' + e.message, 'err')
      return
    }
    if (!picked) return
    if (!/(^|[\\/])java(\.exe)?$/i.test(picked.trim())) {
      toast('请选择 java.exe 可执行文件', 'err')
      return
    }
    const path = picked.trim()
    const ok = await confirm(
      `将「${escapeHtml(path)}」设为默认 Java？\n启动器仍会在启动前校验 64 位与大版本；如果该路径不是可运行的 Java，启动时会提示错误。`,
      { title: '添加本机 Java', okText: '设为默认' }
    )
    if (!ok) return
    await setDefault(path)
  }

  /* ---------------- download ---------------- */

  function setJobStatus(status) {
    const label = STATUS_LABEL[status] || String(status || '')
    jobStatus.hidden = !label
    jobStatus.textContent = label
    jobStatus.className = 'badge ' + (status === 'done' ? 'ok' : ['failed', 'cancelled'].includes(status) ? 'bad' : 'info')
  }

  function clearJobError() {
    jobError.textContent = ''
    jobError.hidden = true
  }

  function showJobError(message) {
    jobError.textContent = message || ''
    jobError.hidden = !message
  }

  function applyJob(job) {
    if (!job) return
    const status = String(job.status || '')
    const progress = job.progress === null || job.progress === undefined ? null : Number(job.progress)
    setJobStatus(status)
    jobDetail.textContent = job.detail || STATUS_LABEL[status] || '正在处理…'
    jobPath.textContent = job.path || ''
    bar.el.classList.remove('ok', 'bad')
    if (status === 'done') {
      bar.set(100)
      bar.el.classList.add('ok')
    } else if (['failed', 'cancelled'].includes(status)) {
      bar.set(Number.isFinite(progress) ? progress : 0)
      bar.el.classList.add('bad')
      if (status === 'failed') showJobError(job.error || job.detail || '下载失败')
    } else if (progress === null || !Number.isFinite(progress)) {
      bar.set(0, true)
    } else {
      bar.set(progress)
    }
  }

  function schedulePoll(delay = 900) {
    clearTimeout(pollTimer)
    pollTimer = setTimeout(pollJob, delay)
  }

  async function pollJob() {
    if (!jobId || destroyed) return
    const id = jobId
    try {
      const job = await api.javaJob(id)
      if (destroyed || jobId !== id) return
      applyJob(job)
      if (isFinal(job.status)) {
        await finishDownload(job)
        return
      }
      schedulePoll()
    } catch (e) {
      if (destroyed) return
      clearTimeout(pollTimer)
      pollTimer = null
      jobId = ''
      downloading = false
      downloadBtn.disabled = false
      majorSelect.disabled = false
      cancelBtn.hidden = true
      jobDetail.textContent = '读取下载进度失败：' + e.message
      showJobError(e.message)
      toast('读取 Java 下载进度失败：' + e.message, 'err')
    }
  }

  async function startDownload() {
    if (downloading || destroyed) return
    clearTimeout(pollTimer)
    pollTimer = null
    downloading = true
    clearJobError()
    jobPath.textContent = ''
    downloadBtn.disabled = true
    majorSelect.disabled = true
    cancelBtn.disabled = false
    cancelBtn.hidden = true
    jobStatus.hidden = false
    setJobStatus('queued')
    bar.el.hidden = false
    bar.el.classList.remove('ok', 'bad')
    bar.set(0)
    jobDetail.textContent = '正在创建下载任务…'
    try {
      const job = await api.downloadJava(Number(majorSelect.value))
      if (destroyed) return
      jobId = job.id || ''
      if (!jobId) throw new Error('下载任务返回缺少 ID')
      applyJob(job)
      if (isFinal(job.status)) {
        await finishDownload(job)
        return
      }
      cancelBtn.hidden = false
      schedulePoll()
    } catch (e) {
      if (destroyed) return
      downloading = false
      downloadBtn.disabled = false
      majorSelect.disabled = false
      cancelBtn.hidden = true
      setJobStatus('failed')
      jobDetail.textContent = '无法开始下载。'
      showJobError(e.message)
      toast('无法开始下载 Java：' + e.message, 'err')
    }
  }

  async function cancelDownload() {
    if (!jobId || destroyed) return
    cancelBtn.disabled = true
    jobDetail.textContent = '正在中止下载并清理临时文件…'
    try {
      await api.cancelJavaJob(jobId)
      if (destroyed) return
      schedulePoll(400)
    } catch (e) {
      if (destroyed) return
      cancelBtn.disabled = false
      toast('取消 Java 下载失败：' + e.message, 'err')
    }
  }

  async function finishDownload(job) {
    clearTimeout(pollTimer)
    pollTimer = null
    jobId = ''
    downloading = false
    downloadBtn.disabled = false
    majorSelect.disabled = false
    cancelBtn.hidden = true
    cancelBtn.disabled = false
    if (job.status === 'done') {
      applyJob(job)
      toast(`Java ${job.major || ''} 已安装并校验通过`, 'ok')
      await load(true)
      if (!destroyed) scanStatus.textContent = job.path
        ? `Java ${job.major || ''} 已就绪：${job.path}`
        : `Java ${job.major || ''} 已就绪`
    } else if (job.status === 'cancelled') {
      applyJob(job)
      jobDetail.textContent = '下载已取消，临时文件已清理。'
      toast('已取消 Java 下载', 'info')
    } else {
      applyJob(job)
      showJobError(job.error || job.detail || '下载失败')
      toast('Java 下载失败：' + (job.error || job.detail || '未知错误'), 'err')
    }
  }

  /* ---------------- lifecycle ---------------- */

  function render(container) {
    if (destroyed || !container) return
    clear(container)
    container.appendChild(root)
    const embedded = !!container.closest('.lp-view')?.querySelector('.lp-view-title h2')
    headOverline.hidden = embedded
    headTitle.hidden = embedded
    renderSummary()
    renderList()
    if (!started) {
      started = true
      load(false)
    }
  }

  function destroy() {
    destroyed = true
    clearTimeout(pollTimer)
    pollTimer = null
    jobId = ''
    root.remove()
  }

  renderSummary()
  renderList()

  return { render, destroy }
}
