// 下载中心：只展示启动器任务与社区资源下载，不与安装表单混在一起。
// 每个条目都能定位到对应内容：普通文件打开所在文件夹，实例任务跳转实例页。
import { h, clear, fmtBytes } from '../core/dom.js'
import {
  isActiveJob, isFinishedJob, jobProgress, jobPercentText, jobBytesText, jobElapsedText,
  jobSpeedText, jobIdleText, jobStatusLabel, jobMetaText
} from '../core/jobs.js'
import { icon } from '../ui/icons.js'
import { btn, iconBtn, progress, spinner, badge } from '../ui/kit.js'
import { emptyBlock, sectionCard } from './ui.js'
import { api as coreApi } from '../core/api.js'

// 状态标签与进度统一由 core/jobs.js 提供，这里只保留徽章配色。
const STATUS_TONE = {
  queued: { tone: 'warn', dot: 'warn' },
  running: { tone: 'info', dot: 'loading' },
  installing: { tone: 'info', dot: 'loading' },
  cancelling: { tone: 'warn', dot: 'warn' },
  done: { tone: 'ok', dot: 'ok' },
  failed: { tone: 'bad', dot: 'bad' },
  cancelled: { tone: '', dot: '' }
}
const LAUNCHER_TYPE = {
  install: '安装实例', pack: '整合包', repair: '修复文件', update: '更新模组', export: '导出整合包'
}
const EXPORT_FORMAT = { mrpack: 'Modrinth · .mrpack', zip: '通用 · .zip' }
const COMMUNITY_TYPE = { mod: '模组', resourcepack: '资源包', shader: '光影', modpack: '整合包', datapack: '数据包', servercore: '服务端核心' }

/** 任务类型 → 中文标签（导出任务由服务端 pack-export 提供 type: 'export'）。 */
export function launcherTypeLabel(type) {
  return LAUNCHER_TYPE[type] || '任务'
}

const PACK_FILE = /\.(mrpack|zip)$/i

/**
 * 社区下载任务能否直接交给「新建实例 → 整合包」安装：
 * 已完成、类型是整合包、文件为 .mrpack / .zip。
 */
export function isInstallablePackJob(job) {
  if (!job || job.status !== 'done') return false
  if (String(job.meta?.type || '') !== 'modpack') return false
  return PACK_FILE.test(String(job.filename || job.path || ''))
}

/** 已下载整合包的绝对路径；缺少路径时用 dir + filename 拼出来，失败返回 ''。 */
export function packDownloadPath(job) {
  if (!isInstallablePackJob(job)) return ''
  const direct = String(job.path || '').trim()
  if (direct) return direct
  const dir = String(job.dir || '').trim().replace(/[\\/]+$/, '')
  const name = String(job.filename || '').trim()
  if (!dir || !name || /[\\/]$/.test(dir)) return ''
  return dir + (dir.includes('\\') ? '\\' : '/') + name
}

/** 导出任务完成后可打开的位置：优先输出目录，其次文件本身；非导出任务返回 ''。 */
export function exportJobTarget(job) {
  if (!job || job.type !== 'export') return ''
  return String(job.output || job.file || '')
}

/** 导出任务的格式 / 大小说明（其它任务返回 ''）。 */
export function exportJobSummary(job) {
  if (!job || job.type !== 'export') return ''
  const parts = []
  if (job.format) parts.push(EXPORT_FORMAT[job.format] || String(job.format))
  const size = Number(job.size) || 0
  if (size > 0) parts.push(fmtBytes(size))
  return parts.join(' · ')
}

/**
 * 合并启动器任务与独立导出任务：按 id 去重，导出任务统一标记 type: 'export'。
 * hiddenExports 用于「清理已完成」后本地隐藏导出任务。
 */
export function mergeLauncherJobs(jobs = [], exports = [], { hiddenExports = new Set() } = {}) {
  const merged = new Map()
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (job?.id) merged.set(job.id, job)
  }
  for (const job of Array.isArray(exports) ? exports : []) {
    if (!job?.id || merged.has(job.id) || hiddenExports.has(job.id)) continue
    merged.set(job.id, { ...job, type: 'export' })
  }
  return [...merged.values()]
}

/**
 * 进度条的取值与配色（纯函数）。
 * value 为 0–100，null 表示服务端没有真实进度，只有这时才显示不确定动画。
 */
export function jobProgressView(job) {
  const value = jobProgress(job)
  const state = job?.status === 'done' ? 'ok' : job?.status === 'failed' ? 'bad' : ''
  return { value, state }
}

/**
 * 下载行底部摘要（纯函数）：字节、百分比、速度、耗时统一走 core/jobs.js。
 * - 运行中：字节 + 百分比 + 速度 + 已进行；
 * - 完成：字节 + 100% + 用时；
 * - 失败 / 取消：字节 + 终态百分比 + 用时/终态，绝不再出现「已进行」。
 */
export function jobRowSummary(job, now = Date.now()) {
  if (!job) return ''
  const parts = []
  const bytes = jobBytesText(job)
  if (bytes) parts.push(bytes)
  const pctText = jobPercentText(job)
  if (pctText) parts.push(pctText)
  const speed = jobSpeedText(job)
  if (speed) parts.push(speed)
  const elapsed = jobElapsedText(job, now)
  if (elapsed) parts.push(elapsed)
  const idle = jobIdleText(job, now)
  if (idle) parts.push(idle)
  if (isFinishedJob(job) && job.status !== 'done') parts.push(jobStatusLabel(job))
  if (!parts.length) return jobMetaText(job, now) || jobStatusLabel(job)
  return parts.join(' · ')
}

function toneOf(job) {
  return STATUS_TONE[job?.status] || STATUS_TONE.running
}

function communityLabel(job) {
  return COMMUNITY_TYPE[job?.meta?.type] || '文件'
}

/**
 * @param {{ api: import('./api.js').launcherApi, toast: Function, confirm: Function,
 *   openModal: Function, openPath: Function, showInstance: Function, reload: Function }} ctx
 */
export function createDownloadsView(ctx) {
  let active = null
  return {
    render(container) {
      if (!container) return
      active?.dispose()
      active = buildView(ctx, container)
    },
    destroy() { active?.dispose(); active = null },
    focus() { active?.refresh?.() }
  }
}

function buildView(ctx, container) {
  let disposed = false
  let timer = null
  let busy = false
  let launcherJobs = []
  let communityJobs = []
  let errorText = ''
  let showFinished = true
  // 导出任务可能由独立接口 /api/launcher/exports 提供；记录本地清理过的导出任务，
  // 避免「清理已完成」后它们又从独立接口回来。
  const clearedExports = new Set()
  // 服务端尚未接入导出接口时（404）停止重复请求，避免轮询刷错误。
  let exportsSupported = typeof ctx.api.exports === 'function'

  const launcherList = h('div', { class: 'lp-list lp-download-list' })
  const communityList = h('div', { class: 'lp-list lp-download-list' })
  const launcherCount = h('span', { class: 'lp-hint' })
  const communityCount = h('span', { class: 'lp-hint' })
  const launcherSection = sectionCard({
    title: '启动器任务',
    subtitle: '实例安装、整合包、导出、文件修复与模组更新',
    actions: h('div', { class: 'lp-row-actions' }, launcherCount, iconBtn('refresh', { size: 13, label: '刷新', onClick: () => refresh(true) })),
    body: launcherList
  })
  const communitySection = sectionCard({
    title: '资源下载',
    subtitle: '模组、资源包、光影与服务端核心的文件下载',
    actions: h('div', { class: 'lp-row-actions' }, communityCount, iconBtn('refresh', { size: 13, label: '刷新', onClick: () => refresh(true) })),
    body: communityList
  })
  const finishSwitch = h('label', { class: 'lp-inline-check' },
    h('input', {
      type: 'checkbox', checked: true,
      onchange: () => { showFinished = finishSwitch.querySelector('input').checked; paint() }
    }),
    h('span', {}, '显示已完成')
  )
  const header = h('header', { class: 'lp-toolbar lp-downloads-head' },
    h('div', { class: 'lp-downloads-title' },
      h('span', { class: 'overline' }, 'Download Center'),
      h('h2', {}, '下载中心'),
      h('p', { class: 'lp-hint' }, '这里只显示下载与安装任务；已完成的任务可以直接打开对应文件夹或实例。')
    ),
    h('div', { class: 'lp-downloads-actions' },
      finishSwitch,
      btn('安装整合包', { size: 'sm', iconName: 'archive', onClick: () => ctx.openPackInstaller?.() }),
      btn('清理已完成', { size: 'sm', iconName: 'trash', onClick: () => clearFinished() }),
      btn('刷新', { size: 'sm', iconName: 'refresh', onClick: () => refresh(true) })
    )
  )
  const errorBox = h('div', { class: 'lp-main-error', style: { display: 'none' } })
  const loading = h('div', { class: 'lp-main-loading' }, spinner(16), '正在读取下载任务…')
  const root = h('div', { class: 'lp-downloads' }, header, errorBox, loading)
  container.appendChild(root)
  root.append(launcherSection, communitySection)
  clear(loading)
  loading.remove()

  function setError(text = '') {
    errorText = text
    errorBox.style.display = text ? '' : 'none'
    clear(errorBox)
    if (text) {
      errorBox.append(icon('warning', { size: 20 }), h('b', {}, '读取下载任务失败'), h('p', {}, text),
        btn('重试', { variant: 'primary', onClick: () => refresh(true) }))
    }
  }

  function progressNode(job) {
    const view = jobProgressView(job)
    // jobProgress 已经处理了 done / installProgress / progress / received-total 的优先级；
    // 只有它返回 null 时才用 indeterminate 动画条。
    const bar = progress(view.value, { className: 'lp-job-bar' })
    bar.state(view.state)
    return bar
  }

  async function openLauncherLog(job) {
    const pre = h('pre', { class: 'lp-job-log', role: 'log' }, '正在读取任务日志…')
    let after = 0
    let logTimer = null
    let closed = false
    // 导出任务的日志走 /api/launcher/exports/:id，其余任务仍走 /api/launcher/jobs/:id。
    const fetchJob = job.type === 'export' && typeof ctx.api.exportJob === 'function'
      ? (since) => ctx.api.exportJob(job.id, since)
      : (since) => ctx.api.job(job.id, since)
    const tick = async () => {
      if (closed) return
      try {
        const data = await fetchJob(after)
        if (!data || closed) return
        const lines = (data.logs || []).map((line) => `[${line.t || ''}] ${line.text}`)
        if (lines.length) {
          after = Math.max(after, ...data.logs.map((line) => Number(line.seq) || 0))
          pre.textContent = (pre.textContent === '正在读取任务日志…' ? '' : pre.textContent + '\n') + lines.join('\n')
          pre.scrollTop = pre.scrollHeight
        }
        if (isFinishedJob(data) && logTimer) { clearInterval(logTimer); logTimer = null }
      } catch (error) {
        pre.textContent = '读取日志失败：' + error.message
        if (logTimer) { clearInterval(logTimer); logTimer = null }
      }
    }
    const modal = ctx.openModal({
      title: `任务日志 · ${job.name || job.id}`,
      size: 'xl',
      body: pre,
      buttons: [{ label: '关闭', class: 'btn-ghost' }],
      onClose: () => { closed = true; if (logTimer) clearInterval(logTimer) }
    })
    await tick()
    // 首次 tick 期间用户可能已经关闭弹窗；此时不能再创建 interval。
    if (!closed && !isFinishedJob(job)) logTimer = setInterval(tick, 1000)
    return modal
  }

  function openCommunityLog(job) {
    const text = [job.installLog, job.error].filter(Boolean).join('\n') || '（这个任务没有额外日志）'
    ctx.openModal({
      title: `下载详情 · ${job.title || job.filename || job.id}`,
      size: 'lg',
      body: h('div', { class: 'lp-download-detail' },
        h('div', { class: 'lp-kv' }, h('span', {}, '文件'), h('b', { title: job.path || '' }, job.filename || '—')),
        h('div', { class: 'lp-kv' }, h('span', {}, '保存位置'), h('b', { title: job.dir || '' }, job.dir || '—')),
        h('div', { class: 'lp-kv' }, h('span', {}, '类型'), h('b', {}, communityLabel(job))),
        h('div', { class: 'lp-kv' }, h('span', {}, '来源'), h('b', {}, job.meta?.source || '—')),
        h('pre', { class: 'lp-job-log' }, text)),
      buttons: [
        { label: '打开文件夹', class: 'btn', onClick: () => openFolder(job) },
        { label: '关闭', class: 'btn-ghost' }
      ]
    })
  }

  function openFolder(job) {
    const target = job.path || job.dir || ''
    if (!target) { ctx.toast('没有可打开的下载位置', 'warn'); return }
    ctx.openPath(target)
  }

  function openExportFolder(job) {
    const target = exportJobTarget(job)
    if (!target) { ctx.toast('没有可打开的导出位置，请到启动器 exports 目录查看', 'warn'); return }
    ctx.openPath(target)
  }

  async function cancelLauncher(job) {
    if (!(await ctx.confirm(`取消「${job.name || job.id}」？已下载完成的文件会保留。`, { title: '取消任务', danger: true, okText: '取消任务' }))) return
    try {
      if (job.type === 'export' && typeof ctx.api.cancelExport === 'function') await ctx.api.cancelExport(job.id)
      else await ctx.api.cancelJob(job.id)
      await refresh(true)
    } catch (e) { ctx.toast('取消失败：' + e.message, 'err') }
  }

  async function cancelCommunity(job) {
    if (!(await ctx.confirm(`取消下载「${job.title || job.filename || job.id}」？`, { title: '取消下载', danger: true, okText: '取消下载' }))) return
    try {
      await coreApi.post('/api/community/jobs/cancel', { id: job.id })
      await refresh(true)
    } catch (e) { ctx.toast('取消失败：' + e.message, 'err') }
  }

  function launcherRow(job) {
    const tone = toneOf(job)
    const bar = progressNode(job)
    const actions = h('div', { class: 'lp-row-actions' })
    if (isActiveJob(job)) actions.appendChild(btn('取消', { size: 'xs', variant: 'danger', onClick: () => cancelLauncher(job) }))
    if (job.type === 'export' && job.status === 'done' && exportJobTarget(job)) {
      actions.appendChild(btn('打开所在文件夹', {
        size: 'xs', variant: 'primary', iconName: 'folder-open', onClick: () => openExportFolder(job)
      }))
    }
    if (job.instanceId) actions.appendChild(btn('打开实例', { size: 'xs', variant: job.status === 'done' ? 'primary' : 'ghost', iconName: 'arrow-right', onClick: () => ctx.showInstance?.(job.instanceId) }))
    actions.appendChild(iconBtn('terminal', { size: 13, label: '查看任务日志', onClick: () => openLauncherLog(job) }))
    const sub = [job.phase, job.detail].filter(Boolean).join(' · ')
    const iconName = job.type === 'update' ? 'refresh' : job.type === 'pack' ? 'archive' : job.type === 'export' ? 'save' : 'download'
    const summary = [jobRowSummary(job), exportJobSummary(job)].filter(Boolean).join(' · ')
    return h('div', { class: 'lp-row lp-download-row' },
      h('span', { class: 'lp-mod-icon' }, icon(iconName, { size: 15 })),
      h('div', { class: 'lp-mod-main' },
        h('div', { class: 'lp-mod-title' },
          h('b', { title: job.file || job.name || job.id }, job.name || job.id),
          badge(launcherTypeLabel(job.type), job.type === 'export' ? 'accent' : 'info'),
          badge(jobStatusLabel(job), tone.tone)),
        h('div', { class: 'lp-hint' }, sub || '准备中…'),
        job.status === 'failed' && job.error ? h('div', { class: 'lp-hint bad', title: job.error }, job.error) : null,
        bar.el,
        h('div', { class: 'lp-hint mono' }, summary || jobStatusLabel(job))),
      actions)
  }

  function communityRow(job) {
    const tone = toneOf(job)
    const bar = progressNode(job)
    const installPath = packDownloadPath(job)
    const actions = h('div', { class: 'lp-row-actions' })
    if (isActiveJob(job)) actions.appendChild(btn('取消', { size: 'xs', variant: 'danger', onClick: () => cancelCommunity(job) }))
    // 整合包下载完成后可以直接部署：带着本地文件跳到「新建实例 → 整合包」并自动开始安装。
    if (installPath) {
      actions.appendChild(btn('安装到新实例', {
        size: 'xs', variant: 'primary', iconName: 'archive',
        title: '用这个整合包创建独立实例',
        onClick: () => ctx.installPackFromDownload?.(job, installPath)
      }))
    }
    if (job.status === 'done') actions.appendChild(btn('打开文件夹', { size: 'xs', variant: installPath ? 'ghost' : 'primary', iconName: 'folder-open', onClick: () => openFolder(job) }))
    actions.appendChild(iconBtn('info', { size: 13, label: '下载详情', onClick: () => openCommunityLog(job) }))
    return h('div', { class: 'lp-row lp-download-row' },
      h('span', { class: 'lp-mod-icon' }, icon('download', { size: 15 })),
      h('div', { class: 'lp-mod-main' },
        h('div', { class: 'lp-mod-title' },
          h('b', { title: job.title || job.filename || job.id }, job.title || job.filename || job.id),
          badge(communityLabel(job), 'accent'),
          badge(jobStatusLabel(job), tone.tone)),
        h('div', { class: 'lp-hint mono', title: job.dir || '' }, job.filename || job.path || '—'),
        job.status === 'failed' && job.error ? h('div', { class: 'lp-hint bad', title: job.error }, job.error) : null,
        bar.el,
        h('div', { class: 'lp-hint mono' }, jobRowSummary(job))),
      actions)
  }

  function paint() {
    const activeFilter = (job) => isActiveJob(job)
    const launcher = showFinished ? launcherJobs : launcherJobs.filter(activeFilter)
    const community = showFinished ? communityJobs : communityJobs.filter(activeFilter)
    clear(launcherList)
    clear(communityList)
    launcherCount.textContent = `${launcher.filter(activeFilter).length} 进行中 · ${launcher.length} 个任务`
    communityCount.textContent = `${community.filter(activeFilter).length} 进行中 · ${community.length} 个下载`
    if (!launcher.length) launcherList.appendChild(emptyBlock('没有启动器任务', '新建实例、安装整合包或修复文件后，任务会出现在这里。', null, 'download'))
    else for (const job of launcher) launcherList.appendChild(launcherRow(job))
    if (!community.length) communityList.appendChild(emptyBlock('没有资源下载', '在实例内容页或工作台下载模组、资源包、光影后，文件会出现在这里。', null, 'package-down'))
    else for (const job of community) communityList.appendChild(communityRow(job))
  }

  async function refresh(showLoading = false) {
    if (disposed || busy) return
    busy = true
    if (showLoading && !launcherJobs.length && !communityJobs.length) {
      launcherList.replaceChildren(h('div', { class: 'lp-tab-loading' }, spinner(12), '正在读取…'))
      communityList.replaceChildren(h('div', { class: 'lp-tab-loading' }, spinner(12), '正在读取…'))
    }
    try {
      const exportRequest = exportsSupported
        ? Promise.resolve().then(() => ctx.api.exports()).catch((error) => {
          if (error?.status === 404 || /404/.test(error?.message || '')) exportsSupported = false
          return null
        })
        : Promise.resolve(null)
      const [launcherData, communityData, exportData] = await Promise.all([
        ctx.api.jobs(),
        coreApi.get('/api/community/jobs'),
        exportRequest
      ])
      if (disposed) return
      const launcherItems = Array.isArray(launcherData?.items) ? launcherData.items : []
      const exportItems = Array.isArray(exportData?.items) ? exportData.items : []
      // 若服务端已把导出任务合并进 jobs，这里按 id 去重；否则补上独立导出接口的结果。
      // 排队任务可能只有 createdAt，没有 startedAt：排序时两者都接受。
      const jobTime = (job) => Number(job?.startedAt) || Number(job?.createdAt) || 0
      launcherJobs = mergeLauncherJobs(launcherItems, exportItems, { hiddenExports: clearedExports })
        .slice().sort((a, b) => jobTime(b) - jobTime(a))
      communityJobs = (Array.isArray(communityData?.items) ? communityData.items : [])
        .slice().sort((a, b) => jobTime(b) - jobTime(a))
      setError('')
      paint()
    } catch (error) {
      if (!disposed) setError(error.message)
    } finally {
      busy = false
    }
  }

  async function clearFinished() {
    const finishedJobs = launcherJobs.filter((job) => isFinishedJob(job))
    const finishedLauncher = finishedJobs.length
    const finishedCommunity = communityJobs.filter((job) => isFinishedJob(job)).length
    if (!finishedLauncher && !finishedCommunity) { ctx.toast('没有已完成的任务', 'info'); return }
    if (!(await ctx.confirm(`清理 ${finishedLauncher + finishedCommunity} 个已完成任务？下载的文件不会被删除。`, { title: '清理已完成', okText: '清理' }))) return
    try {
      for (const job of finishedJobs) if (job.type === 'export') clearedExports.add(job.id)
      if (finishedLauncher) await ctx.api.clearJobs()
      if (finishedCommunity) await coreApi.post('/api/community/jobs/clear-finished', {})
      await refresh(true)
      ctx.toast('已清理完成的任务', 'ok')
    } catch (e) { ctx.toast('清理失败：' + e.message, 'err') }
  }

  void errorText
  refresh(true)
  timer = setInterval(() => { if (!disposed) refresh(false) }, 1500)
  return {
    refresh,
    dispose() {
      if (disposed) return
      disposed = true
      if (timer) clearInterval(timer)
      timer = null
      root.remove()
    }
  }
}
