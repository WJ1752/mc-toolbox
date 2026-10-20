import { h, clear, fmtBytes } from '/js/core/dom.js'
import { api } from '/js/core/api.js'
import { toast } from '/js/core/toast.js'
import { pickDir } from '/js/core/dirpicker.js'
import { javaDownloadButton } from '/js/core/java-download.js'
import { btn, iconBtn, badge, progress, spinner } from '/js/ui/kit.js'

const LOADERS = [
  ['vanilla', '官方原版'],
  ['fabric', 'Fabric'],
  ['forge', 'Forge'],
  ['cleanroom', 'Cleanroom（1.12.2）'],
  ['neoforge', 'NeoForge'],
  ['quilt', 'Quilt'],
  ['paper', 'Paper']
]

const LOADER_HINT = {
  vanilla: 'Mojang 官方原版服务端',
  fabric: '轻量模组加载器',
  forge: '经典模组加载器',
  cleanroom: '1.12.2 社区维护分支，版本固定',
  neoforge: 'Forge 社区新版分支',
  quilt: 'Fabric 衍生加载器',
  paper: '高性能插件服务端'
}

const STATUS_LABEL = {
  queued: '排队中',
  running: '下载中',
  installing: '安装中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

const EMPTY_JOBS = '暂无下载任务'
const TILE_JOB_LIMIT = 8
const EXPANDED_JOB_LIMIT = 12

let ctxRef = null
let tileHandle = null

export default {
  async mount(ctx) {
    ctxRef = ctx
    tileHandle?.dispose()
    tileHandle = createServerCore(ctx, { expanded: false })
    await tileHandle.mount()
  },

  unmount() {
    tileHandle?.dispose()
    tileHandle = null
  },

  // 展开大屏：独立实例，拥有自己的表单、状态与轮询定时器
  renderExpanded(container, { ctx } = {}) {
    if (!container) return
    const handle = createServerCore(ctx || ctxRef, { expanded: true })
    handle.mountExpanded(container)
  }
}

// ---------------- 实例 ----------------
function createServerCore(ctx, { expanded }) {
  const settings = readSettings(ctx)
  const state = {
    javaPath: '',
    loader: 'fabric',
    mc: '',
    loaderVersion: '',
    busy: false
  }

  let disposed = false
  let pollTimer = null
  let observer = null
  let refreshing = false
  let mcSerial = 0
  let loaderSerial = 0
  let mcState = 'loading'
  let mcCount = 0

  // -------- 控件 --------
  const dirInput = h('input', {
    class: 'input mono',
    type: 'text',
    value: String(settings.community?.downloadDir || ''),
    placeholder: '下载目录（留空用设置里的下载目录）',
    'aria-label': '下载目录',
    spellcheck: 'false'
  })
  dirInput.style.flex = '1 1 auto'
  dirInput.style.minWidth = '0'
  dirInput.title = dirInput.value

  const loaderSel = h('select', { class: 'input', 'aria-label': '加载器' },
    ...LOADERS.map(([value, label]) => h('option', { value }, label)))
  loaderSel.value = state.loader
  loaderSel.style.flex = expanded ? '0 1 300px' : '0 1 230px'
  loaderSel.style.minWidth = '140px'

  const mcSel = h('select', { class: 'input', 'aria-label': 'MC 版本' }, h('option', { value: '' }, '加载中…'))
  mcSel.style.flex = '1 1 auto'
  mcSel.style.minWidth = '0'

  const lvSel = h('select', { class: 'input', 'aria-label': '加载器版本' }, h('option', { value: '' }, '加载中…'))
  lvSel.style.flex = '1 1 auto'
  lvSel.style.minWidth = '0'

  const loaderHintEl = h('span', {
    class: 'muted',
    style: { flex: '1 1 120px', minWidth: '0', fontSize: '10.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
  }, LOADER_HINT[state.loader])

  const versionHintEl = expanded
    ? h('span', { class: 'muted', style: { fontSize: '10.5px', fontWeight: '400' } }, '正在获取 MC 版本…')
    : null

  const versionBusy = h('span', { class: 'dotline', hidden: true, title: '正在获取版本列表', style: { flex: 'none' } }, spinner(11))

  const noteEl = h('div', {
    class: 'muted',
    role: 'status',
    'aria-live': 'polite',
    style: {
      flex: '0 1 auto',
      minWidth: '0',
      minHeight: '14px',
      maxWidth: expanded ? '60%' : '46%',
      fontSize: '11px',
      textAlign: 'right',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, '')

  const btnDownload = btn(expanded ? '下载服务端核心' : '下载', {
    variant: 'primary',
    iconName: 'download',
    title: '加入下载队列',
    onClick: () => download()
  })

  const btnBrowse = btn('浏览', {
    size: 'sm',
    iconName: 'folder',
    title: '选择下载目录',
    onClick: () => browseDir()
  })

  const btnRetryVersions = iconBtn('refresh', {
    size: 13,
    label: '重新获取版本列表',
    title: '重新获取版本列表',
    onClick: () => loadMcVersions({ toastOnError: !expanded })
  })

  const btnRefreshJobs = iconBtn('refresh', {
    size: 13,
    label: '刷新任务列表',
    title: '刷新任务列表',
    onClick: () => refreshJobs()
  })

  const javaBtn = javaDownloadButton({
    getRuntime: () => ({ mc: state.mc, loader: state.loader, loaderVersion: state.loaderVersion }),
    isLocked: () => state.busy,
    onReady: (path) => {
      state.javaPath = path || ''
      setNote('Java 已就绪', 'ok')
      noteEl.title = path || ''
    }
  })

  const summaryEl = expanded
    ? h('span', {
      class: 'badge mono',
      style: { maxWidth: '46%', height: '22px', display: 'inline-flex', overflow: 'hidden' }
    }, '')
    : null

  // -------- 任务区 --------
  const jobListEl = h('div', { class: 'job-list' })
  const jobCountEl = h('span', { class: 'muted mono', style: { fontSize: '10px', flex: 'none' } }, '')
  const jobsWrap = h('div', { class: 'sc-jobs', style: { maxHeight: expanded ? '360px' : '190px' } }, jobListEl)

  const tasksHead = h('div', { class: 'row', style: { gap: '6px' } },
    h('span', { class: 'mini-label' }, '下载任务'),
    jobCountEl,
    h('span', { class: 'spacer' }),
    btnRefreshJobs
  )

  const bottom = h('div', { class: 'sc-bottom', style: { marginTop: expanded ? '2px' : '0' } },
    btnDownload,
    javaBtn,
    h('span', { class: 'spacer' }),
    noteEl
  )

  // -------- 步骤 --------
  const mcField = inlineField('MC 版本', mcSel)
  const lvField = inlineField('加载器版本', lvSel)

  const step1 = makeStep(1, '加载器', h('div', { class: 'row wrap', style: { gap: '8px', minWidth: '0' } }, loaderSel, loaderHintEl), '选择核心来源')
  const step2 = makeStep(2, '版本', h('div', { class: 'row wrap', style: { gap: '8px', minWidth: '0' } }, mcField, lvField, versionBusy, btnRetryVersions), versionHintEl)
  const step3 = makeStep(3, '目标', h('div', { class: 'row', style: { gap: '6px', minWidth: '0' } }, dirInput, btnBrowse), '下载保存位置')

  const steps = [step1, step2, step3]
  const flow = h('div', { class: 'sc-flow' }, ...steps)

  // -------- 事件 --------
  loaderSel.addEventListener('change', async () => {
    state.loader = loaderSel.value
    state.javaPath = ''
    state.loaderVersion = ''
    applyCleanroomLock()
    setNote('')
    updateLoaderHint()
    updateSummary()
    updateStepState()
    await loadLoaderVersions()
  })

  mcSel.addEventListener('change', async () => {
    state.mc = mcSel.value
    state.loaderVersion = ''
    updateSummary()
    updateStepState()
    await loadLoaderVersions()
  })

  lvSel.addEventListener('change', () => {
    state.loaderVersion = lvSel.value
    updateSummary()
    updateStepState()
  })

  dirInput.addEventListener('input', () => {
    dirInput.title = dirInput.value
  })

  // -------- 初始化 --------
  function mount() {
    ctx.body.append(flow, bottom, h('div', { class: 'hr', style: { margin: '0' } }), tasksHead, jobsWrap)
    updateLoaderHint()
    updateSummary()
    updateStepState()
    const first = loadMcVersions({ toastOnError: true })
    refreshJobs()
    pollTimer = setInterval(() => { if (!disposed) refreshJobs() }, 1000)
    return first
  }

  function mountExpanded(container) {
    container.appendChild(h('div', { class: 'col', style: { gap: '12px' } },
      h('div', { class: 'row wrap', style: { gap: '10px', alignItems: 'flex-end' } },
        h('div', { class: 'col', style: { gap: '1px', minWidth: '0' } },
          h('span', { class: 'overline' }, 'Server Core'),
          h('h3', { style: { fontSize: 'var(--fs-18)' } }, '下载配置'),
          h('span', { class: 'muted', style: { fontSize: '11px' } },
            '官方原版 / Fabric / Forge / Cleanroom / NeoForge / Quilt / Paper')
        ),
        h('span', { class: 'spacer' }),
        summaryEl
      ),
      flow,
      bottom,
      h('div', { class: 'hr', style: { margin: '0' } }),
      h('div', { class: 'col', style: { gap: '6px' } }, tasksHead, jobsWrap)
    ))
    updateLoaderHint()
    updateSummary()
    updateStepState()
    loadMcVersions({ toastOnError: false })
    refreshJobs()
    pollTimer = setInterval(() => { if (!disposed) refreshJobs() }, 1500)
    if (typeof MutationObserver === 'function') {
      observer = new MutationObserver(() => {
        if (!container.isConnected || !document.body.contains(container)) dispose()
      })
      observer.observe(document.body, { childList: true, subtree: true })
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    observer?.disconnect()
    observer = null
  }

  // -------- 版本列表 --------
  async function loadMcVersions({ toastOnError = true } = {}) {
    const serial = ++mcSerial
    mcState = 'loading'
    clear(mcSel)
    mcSel.appendChild(option('', '加载中…'))
    mcSel.value = ''
    setBusyIndicator(true)
    if (versionHintEl) versionHintEl.textContent = '正在获取 MC 版本…'
    updateSummary()
    updateStepState()

    try {
      const data = await api.get('/api/servercore/gameversions')
      if (disposed || serial !== mcSerial) return
      const items = data.items || []
      if (!items.length) throw new Error(data.error || '版本列表为空')

      mcCount = items.length
      clear(mcSel)
      for (const item of items) mcSel.appendChild(option(item.id, item.id))
      const preferred = state.mc && items.some((item) => item.id === state.mc) ? state.mc : items[0].id
      state.mc = preferred
      mcSel.value = preferred
      mcState = 'ready'
      applyCleanroomLock()
      if (versionHintEl) versionHintEl.textContent = `${items.length} 个 MC 版本`
      updateSummary()
      updateStepState()
      await loadLoaderVersions()
    } catch (e) {
      if (disposed || serial !== mcSerial) return
      mcState = 'error'
      state.mc = ''
      state.loaderVersion = ''
      clear(mcSel)
      mcSel.appendChild(option('', '（获取失败）'))
      mcSel.value = ''
      clear(lvSel)
      lvSel.appendChild(option('', '（获取失败）'))
      lvSel.value = ''
      if (state.loader === 'cleanroom') applyCleanroomLock()
      if (versionHintEl) versionHintEl.textContent = '获取 MC 版本失败'
      setNote('获取 MC 版本失败：' + e.message, 'bad')
      if (toastOnError) toast('获取 MC 版本失败：' + e.message, 'err')
      updateSummary()
      updateStepState()
    } finally {
      if (serial === mcSerial && !disposed) setBusyIndicator(false)
    }
  }

  async function loadLoaderVersions() {
    const serial = ++loaderSerial
    state.loaderVersion = ''

    if (!state.mc) {
      clear(lvSel)
      lvSel.appendChild(option('', mcState === 'error' ? '（获取失败）' : '加载中…'))
      lvSel.value = ''
      updateSummary()
      updateStepState()
      return
    }

    clear(lvSel)
    lvSel.appendChild(option('', '加载中…'))
    lvSel.value = ''
    setNote('')
    setBusyIndicator(true)
    if (versionHintEl) versionHintEl.textContent = '正在获取加载器版本…'
    updateSummary()
    updateStepState()

    try {
      const data = await api.get(`/api/servercore/loaderversions?loader=${encodeURIComponent(state.loader)}&mc=${encodeURIComponent(state.mc)}`)
      if (disposed || serial !== loaderSerial) return
      const items = data.items || []

      clear(lvSel)
      if (!items.length) {
        lvSel.appendChild(option('', '（无可用版本）'))
        lvSel.value = ''
        if (versionHintEl) versionHintEl.textContent = '没有可用的加载器版本'
        if (data.error) setNote(data.error, 'warn')
        updateSummary()
        updateStepState()
        return
      }

      for (const item of items) {
        lvSel.appendChild(option(item.version, item.label ? `${item.version} (${item.label})` : item.version))
      }
      state.loaderVersion = items[0].version
      lvSel.value = state.loaderVersion
      if (versionHintEl) versionHintEl.textContent = `${mcCount} 个 MC 版本 · ${items.length} 个加载器版本`
      updateSummary()
      updateStepState()
    } catch (e) {
      if (disposed || serial !== loaderSerial) return
      clear(lvSel)
      lvSel.appendChild(option('', '（获取失败）'))
      lvSel.value = ''
      state.loaderVersion = ''
      if (versionHintEl) versionHintEl.textContent = '获取加载器版本失败'
      setNote('获取加载器版本失败：' + e.message, 'bad')
      updateSummary()
      updateStepState()
    } finally {
      if (serial === loaderSerial && !disposed) setBusyIndicator(false)
    }
  }

  // -------- 下载 --------
  async function download() {
    if (state.busy) return
    if (!state.mc) {
      toast('请选择 MC 版本', 'err')
      mcSel.focus()
      return
    }
    if (state.loader !== 'vanilla' && !state.loaderVersion) {
      toast('请选择加载器版本', 'err')
      lvSel.focus()
      return
    }

    state.busy = true
    btnDownload.disabled = true
    btnDownload.classList.add('loading')
    try {
      const r = await api.post('/api/servercore/download', {
        loader: state.loader,
        mc: state.mc,
        loaderVersion: state.loaderVersion,
        dir: dirInput.value.trim(),
        javaPath: state.javaPath
      })
      if (r.error) throw new Error(r.error)
      if (r.note) setNote(r.note)
      toast('已加入下载队列：' + r.filename, 'ok')
      refreshJobs()
    } catch (e) {
      toast('下载失败：' + e.message, 'err')
    } finally {
      state.busy = false
      btnDownload.disabled = false
      btnDownload.classList.remove('loading')
    }
  }

  async function browseDir() {
    const picked = await pickDir(dirInput.value || '')
    if (!picked || disposed) return
    dirInput.value = picked
    dirInput.title = picked
  }

  // -------- 任务轮询 --------
  async function refreshJobs() {
    if (disposed || refreshing) return
    refreshing = true
    try {
      const data = await api.get('/api/community/jobs')
      if (disposed) return
      const jobs = (data.items || []).filter((j) => j.meta && j.meta.type === 'servercore')
      if (!expanded && ctx) {
        const running = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length
        ctx.setBadge?.(running ? `${running} 个进行中` : '', running ? 'info' : '')
      }
      renderJobs(jobs)
    } catch {
      // 轮询失败保持上一次渲染结果
    } finally {
      refreshing = false
    }
  }

  function renderJobs(jobs) {
    const keepScroll = jobsWrap.scrollTop
    clear(jobListEl)
    jobCountEl.textContent = jobs.length ? `${jobs.length} 项` : ''

    if (!jobs.length) {
      jobsWrap.scrollTop = 0
      jobListEl.appendChild(h('div', {
        class: 'muted center',
        style: { padding: expanded ? '18px' : '9px', border: '1px dashed var(--line)', borderRadius: 'var(--r-1)', fontSize: '11px' }
      }, EMPTY_JOBS))
      return
    }

    const limit = expanded ? EXPANDED_JOB_LIMIT : TILE_JOB_LIMIT
    for (const job of jobs.slice(0, limit)) jobListEl.appendChild(jobCard(job))
    jobsWrap.scrollTop = keepScroll
  }

  function jobCard(job) {
    const label = STATUS_LABEL[job.status] || job.status || '未知'
    const kind = job.status === 'done' ? 'ok' : job.status === 'failed' ? 'bad' : (job.status === 'running' || job.status === 'installing') ? 'info' : ''
    const dotKind = job.status === 'done' ? 'ok' : job.status === 'failed' ? 'bad' : (job.status === 'running' || job.status === 'installing' || job.status === 'queued') ? 'info' : ''
    const installing = job.status === 'installing'
    const pct = job.total ? Math.min(100, Math.round((job.received / job.total) * 100)) : 0
    const instPct = typeof job.installProgress === 'number' ? job.installProgress : null
    const barValue = installing ? instPct : pct
    const indeterminate = installing && instPct == null
    const bar = progress(indeterminate ? null : barValue, {
      className: 'j-bar',
      title: indeterminate ? '正在安装' : `${Math.round(barValue || 0)}%`
    })
    if (job.status === 'done') bar.state('ok')
    else if (job.status === 'failed') bar.state('bad')

    let meta
    if (installing) {
      meta = instPct == null ? '正在安装，请稍候…' : `正在安装 · ${Math.round(instPct)}%`
    } else {
      meta = `${fmtBytes(job.received)} / ${job.total ? fmtBytes(job.total) : '?'} · ${pct}%`
      if (job.status === 'running') {
        const speed = fmtSpeed(job.speed)
        if (speed) meta += ` · ${speed}`
        if (job.threads != null) meta += ` · ${job.threads} 线程`
      }
    }

    const dirLine = job.dir
      ? h('div', { class: 'j-meta mono', title: job.dir }, job.dir)
      : null
    const logLine = installing && job.installLog
      ? h('div', { class: 'j-meta', style: { whiteSpace: 'normal', overflowWrap: 'anywhere' }, title: job.installLog }, job.installLog)
      : null
    const errLine = job.error
      ? h('div', { class: 'j-error', title: job.error }, job.error)
      : null

    const actions = h('div', { class: 'j-actions', style: { minWidth: '38px', justifyContent: 'flex-end' } })
    if (job.status === 'running' || job.status === 'queued') {
      actions.appendChild(btn('取消', {
        size: 'xs',
        variant: 'danger',
        title: '取消此下载任务',
        onClick: () => cancelJob(job.id)
      }))
    }

    return h('div', { class: 'job' },
      h('span', { class: 'dot' + (dotKind ? ' ' + dotKind : ''), title: label }),
      h('div', { class: 'j-main' },
        h('div', { class: 'row', style: { gap: '6px', minWidth: '0' } },
          h('span', { class: 'j-title', style: { flex: '1 1 auto', minWidth: '0' }, title: job.filename }, job.filename || '未命名任务'),
          badge(label, kind)
        ),
        dirLine,
        bar.el,
        h('div', { class: 'j-meta', title: meta }, meta),
        logLine,
        errLine
      ),
      actions
    )
  }

  async function cancelJob(id) {
    if (!id) return
    try {
      await api.post('/api/community/jobs/cancel', { id })
      await refreshJobs()
    } catch (e) {
      if (!disposed) toast('取消失败：' + e.message, 'err')
    }
  }

  // -------- 展示辅助 --------
  function makeStep(index, title, controls, hint) {
    const titleNode = h('div', {
      class: 'sc-step-title',
      style: expanded ? { flexDirection: 'column', alignItems: 'flex-start', gap: '1px', minWidth: '0' } : null
    },
      h('b', {}, title),
      expanded && hint ? h('span', { class: 'muted', style: { fontSize: '10.5px', fontWeight: '400', lineHeight: '1.45' } }, hint) : null
    )
    return h('div', { class: 'sc-step', dataset: { step: String(index) } },
      h('span', { class: 'n' }, String(index).padStart(2, '0')),
      h('div', {
        class: 'sc-step-body',
        style: expanded
          ? { display: 'grid', gridTemplateColumns: '210px minmax(0, 1fr)', alignItems: 'center', gap: '14px' }
          : { display: 'grid', gridTemplateColumns: '68px minmax(0, 1fr)', alignItems: 'center', gap: '8px' }
      }, titleNode, controls)
    )
  }

  function inlineField(label, control) {
    return h('div', { class: 'row', style: { gap: '6px', flex: '1 1 160px', minWidth: '0' } },
      h('span', { class: 'mini-label', style: { flex: 'none' } }, label),
      control
    )
  }

  function updateLoaderHint() {
    loaderHintEl.textContent = LOADER_HINT[state.loader] || ''
  }

  function updateSummary() {
    if (!summaryEl) return
    const loaderLabel = LOADERS.find(([value]) => value === state.loader)?.[1] || state.loader
    const mcLabel = state.mc || (mcState === 'loading' ? '加载中…' : mcState === 'error' ? '版本获取失败' : '未选择')
    const bits = [loaderLabel, mcLabel]
    if (state.loader !== 'vanilla' && state.loaderVersion) bits.push(state.loaderVersion)
    const text = bits.join(' · ')
    summaryEl.textContent = text
    summaryEl.title = text
  }

  function updateStepState() {
    const ready = !!state.mc && (state.loader === 'vanilla' || !!state.loaderVersion)
    steps[0]?.classList.toggle('active', !state.mc)
    steps[1]?.classList.toggle('active', !!state.mc && !ready)
    steps[2]?.classList.toggle('active', ready)
  }

  function applyCleanroomLock() {
    const cleanroom = state.loader === 'cleanroom'
    if (cleanroom) {
      if (!Array.from(mcSel.options).some((opt) => opt.value === '1.12.2')) {
        mcSel.appendChild(option('1.12.2', '1.12.2'))
      }
      state.mc = '1.12.2'
      mcSel.value = '1.12.2'
    }
    mcSel.disabled = cleanroom
    mcSel.title = cleanroom ? 'Cleanroom 仅支持 MC 1.12.2' : '选择 MC 版本'
  }

  function setBusyIndicator(busy) {
    versionBusy.hidden = !busy
  }

  function setNote(text, kind = '') {
    noteEl.textContent = text || ''
    noteEl.title = text || ''
    noteEl.className = 'muted' + (kind === 'bad' ? ' bad' : kind === 'ok' ? ' okc' : kind === 'warn' ? ' warnc' : '')
  }

  return { mount, mountExpanded, dispose }
}

// ---------------- 共享格式 ----------------
function option(value, label) {
  return h('option', { value }, label)
}

function fmtSpeed(bps) {
  if (!bps || bps <= 0) return ''
  return fmtBytes(bps) + '/s'
}

function readSettings(ctx) {
  try {
    const getter = ctx && typeof ctx.settings === 'function' ? ctx.settings : ctxRef?.settings
    return (typeof getter === 'function' ? getter() : null) || {}
  } catch {
    return {}
  }
}
