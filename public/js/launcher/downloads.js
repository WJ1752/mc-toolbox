// 下载中心：只展示启动器任务与社区资源下载，不与安装表单混在一起。
// 每个条目都能定位到对应内容：普通文件打开所在文件夹，实例任务跳转实例页。
import { h, clear, fmtBytes, fmtDuration } from '../core/dom.js'
import { icon } from '../ui/icons.js'
import { btn, iconBtn, progress, spinner, badge } from '../ui/kit.js'
import { emptyBlock, sectionCard } from './ui.js'
import { api as coreApi } from '../core/api.js'

const STATUS = {
  queued: { label: '排队中', tone: 'warn', dot: 'warn' },
  running: { label: '下载中', tone: 'info', dot: 'loading' },
  installing: { label: '安装中', tone: 'info', dot: 'loading' },
  cancelling: { label: '取消中', tone: 'warn', dot: 'warn' },
  done: { label: '已完成', tone: 'ok', dot: 'ok' },
  failed: { label: '失败', tone: 'bad', dot: 'bad' },
  cancelled: { label: '已取消', tone: '', dot: '' }
}
const ACTIVE = new Set(['queued', 'running', 'installing', 'cancelling'])
const FINISHED = new Set(['done', 'failed', 'cancelled'])
const LAUNCHER_TYPE = { install: '安装实例', pack: '整合包', repair: '修复文件', update: '更新模组' }
const COMMUNITY_TYPE = { mod: '模组', resourcepack: '资源包', shader: '光影', modpack: '整合包', datapack: '数据包', servercore: '服务端核心' }

function statusOf(job) {
  return STATUS[job?.status] || STATUS.running
}

function timeText(job) {
  if (job.finishedAt && job.startedAt) return fmtDuration(Math.max(0, (job.finishedAt - job.startedAt) / 1000))
  if (job.startedAt) return '已进行 ' + fmtDuration(Math.max(0, Date.now() - job.startedAt))
  return ''
}

function bytesText(job) {
  const received = Number(job.received) || 0
  const total = Number(job.total) || 0
  if (total > 0) return `${fmtBytes(received)} / ${fmtBytes(total)}`
  if (received > 0) return fmtBytes(received)
  return ''
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

  const launcherList = h('div', { class: 'lp-list lp-download-list' })
  const communityList = h('div', { class: 'lp-list lp-download-list' })
  const launcherCount = h('span', { class: 'lp-hint' })
  const communityCount = h('span', { class: 'lp-hint' })
  const launcherSection = sectionCard({
    title: '启动器任务',
    subtitle: '实例安装、整合包、文件修复与模组更新',
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
    const bar = progress(job.indeterminate || job.progress == null ? null : job.progress, { className: 'lp-job-bar' })
    bar.state(job.status === 'done' ? 'ok' : job.status === 'failed' ? 'bad' : '')
    return bar
  }

  async function openLauncherLog(job) {
    const pre = h('pre', { class: 'lp-job-log', role: 'log' }, '正在读取任务日志…')
    let after = 0
    let logTimer = null
    let closed = false
    const tick = async () => {
      if (closed) return
      try {
        const data = await ctx.api.job(job.id, after)
        if (!data || closed) return
        const lines = (data.logs || []).map((line) => `[${line.t || ''}] ${line.text}`)
        if (lines.length) {
          after = Math.max(after, ...data.logs.map((line) => Number(line.seq) || 0))
          pre.textContent = (pre.textContent === '正在读取任务日志…' ? '' : pre.textContent + '\n') + lines.join('\n')
          pre.scrollTop = pre.scrollHeight
        }
        if (FINISHED.has(data.status) && logTimer) { clearInterval(logTimer); logTimer = null }
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
    if (!FINISHED.has(job.status)) logTimer = setInterval(tick, 1000)
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

  async function cancelLauncher(job) {
    if (!(await ctx.confirm(`取消「${job.name || job.id}」？已下载完成的文件会保留。`, { title: '取消任务', danger: true, okText: '取消任务' }))) return
    try { await ctx.api.cancelJob(job.id); await refresh(true) } catch (e) { ctx.toast('取消失败：' + e.message, 'err') }
  }

  async function cancelCommunity(job) {
    if (!(await ctx.confirm(`取消下载「${job.title || job.filename || job.id}」？`, { title: '取消下载', danger: true, okText: '取消下载' }))) return
    try {
      await coreApi.post('/api/community/jobs/cancel', { id: job.id })
      await refresh(true)
    } catch (e) { ctx.toast('取消失败：' + e.message, 'err') }
  }

  function launcherRow(job) {
    const meta = statusOf(job)
    const bar = progressNode(job)
    const actions = h('div', { class: 'lp-row-actions' })
    if (ACTIVE.has(job.status)) actions.appendChild(btn('取消', { size: 'xs', variant: 'danger', onClick: () => cancelLauncher(job) }))
    if (job.instanceId) actions.appendChild(btn('打开实例', { size: 'xs', variant: job.status === 'done' ? 'primary' : 'ghost', iconName: 'arrow-right', onClick: () => ctx.showInstance?.(job.instanceId) }))
    actions.appendChild(iconBtn('terminal', { size: 13, label: '查看任务日志', onClick: () => openLauncherLog(job) }))
    const sub = [job.phase, job.detail].filter(Boolean).join(' · ')
    return h('div', { class: 'lp-row lp-download-row' },
      h('span', { class: 'lp-mod-icon' }, icon(job.type === 'update' ? 'refresh' : job.type === 'pack' ? 'archive' : 'download', { size: 15 })),
      h('div', { class: 'lp-mod-main' },
        h('div', { class: 'lp-mod-title' },
          h('b', { title: job.name || job.id }, job.name || job.id),
          badge(LAUNCHER_TYPE[job.type] || '任务', 'info'),
          badge(meta.label, meta.tone)),
        h('div', { class: 'lp-hint' }, sub || '准备中…'),
        bar.el,
        h('div', { class: 'lp-hint mono' }, [bytesText(job), timeText(job)].filter(Boolean).join(' · ') || meta.label)),
      actions)
  }

  function communityRow(job) {
    const meta = statusOf(job)
    const bar = progressNode(job)
    const actions = h('div', { class: 'lp-row-actions' })
    if (ACTIVE.has(job.status)) actions.appendChild(btn('取消', { size: 'xs', variant: 'danger', onClick: () => cancelCommunity(job) }))
    if (job.status === 'done') actions.appendChild(btn('打开文件夹', { size: 'xs', variant: 'primary', iconName: 'folder-open', onClick: () => openFolder(job) }))
    actions.appendChild(iconBtn('info', { size: 13, label: '下载详情', onClick: () => openCommunityLog(job) }))
    const speed = Number(job.speed) > 0 ? `${fmtBytes(job.speed)}/s` : ''
    return h('div', { class: 'lp-row lp-download-row' },
      h('span', { class: 'lp-mod-icon' }, icon('download', { size: 15 })),
      h('div', { class: 'lp-mod-main' },
        h('div', { class: 'lp-mod-title' },
          h('b', { title: job.title || job.filename || job.id }, job.title || job.filename || job.id),
          badge(communityLabel(job), 'accent'),
          badge(meta.label, meta.tone)),
        h('div', { class: 'lp-hint mono', title: job.dir || '' }, job.filename || job.path || '—'),
        bar.el,
        h('div', { class: 'lp-hint mono' }, [bytesText(job), speed, job.status === 'done' ? '' : job.installProgress != null ? Math.round(job.installProgress) + '%' : ''].filter(Boolean).join(' · '))),
      actions)
  }

  function paint() {
    const launcher = showFinished ? launcherJobs : launcherJobs.filter((job) => ACTIVE.has(job.status))
    const community = showFinished ? communityJobs : communityJobs.filter((job) => ACTIVE.has(job.status))
    clear(launcherList)
    clear(communityList)
    launcherCount.textContent = `${launcher.filter((job) => ACTIVE.has(job.status)).length} 进行中 · ${launcher.length} 个任务`
    communityCount.textContent = `${community.filter((job) => ACTIVE.has(job.status)).length} 进行中 · ${community.length} 个下载`
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
      const [launcherData, communityData] = await Promise.all([
        ctx.api.jobs(),
        coreApi.get('/api/community/jobs')
      ])
      if (disposed) return
      launcherJobs = (Array.isArray(launcherData?.items) ? launcherData.items : [])
        .slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
      communityJobs = (Array.isArray(communityData?.items) ? communityData.items : [])
        .slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
      setError('')
      paint()
    } catch (error) {
      if (!disposed) setError(error.message)
    } finally {
      busy = false
    }
  }

  async function clearFinished() {
    const finishedLauncher = launcherJobs.filter((job) => FINISHED.has(job.status)).length
    const finishedCommunity = communityJobs.filter((job) => FINISHED.has(job.status)).length
    if (!finishedLauncher && !finishedCommunity) { ctx.toast('没有已完成的任务', 'info'); return }
    if (!(await ctx.confirm(`清理 ${finishedLauncher + finishedCommunity} 个已完成任务？下载的文件不会被删除。`, { title: '清理已完成', okText: '清理' }))) return
    try {
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
