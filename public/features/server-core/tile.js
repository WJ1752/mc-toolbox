import { h, clear, fmtBytes } from '/js/core/dom.js'
import { api } from '/js/core/api.js'
import { toast } from '/js/core/toast.js'
import { pickDir } from '/js/core/dirpicker.js'

const LOADERS = [
  ['vanilla', '官方原版'],
  ['fabric', 'Fabric'],
  ['forge', 'Forge'],
  ['neoforge', 'NeoForge'],
  ['quilt', 'Quilt'],
  ['paper', 'Paper']
]

let ctxRef = null
let timer = null
let els = {}
const state = { loader: 'fabric', mc: '', loaderVersion: '', dir: '', note: '', busy: false }

function fmtSpeed(bps) {
  if (!bps) return ''
  return fmtBytes(bps) + '/s'
}

export default {
  async mount(ctx) {
    ctxRef = ctx
    const s = ctx.settings()
    state.dir = s.community?.downloadDir || ''

    const loaderSel = h('select', { class: 'input' },
      ...LOADERS.map(([v, l]) => h('option', { value: v }, l)))
    loaderSel.value = state.loader

    const mcSel = h('select', { class: 'input' }, h('option', { value: '' }, '加载中…'))
    const lvSel = h('select', { class: 'input' }, h('option', { value: '' }, '—'))
    const noteEl = h('div', { class: 'muted', style: { minHeight: '14px' } }, '')
    const jobsEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } })
    const dirInput = h('input', { class: 'input mono', placeholder: '下载目录（留空用设置里的下载目录）', value: state.dir })

    els = { mcSel, lvSel, noteEl, jobsEl }

    const btnDownload = h('button', { class: 'btn btn-sm btn-primary', onclick: () => download() }, '⬇ 下载')

    loaderSel.onchange = () => {
      state.loader = loaderSel.value
      state.loaderVersion = ''
      loadLoaderVersions()
    }
    mcSel.onchange = () => {
      state.mc = mcSel.value
      state.loaderVersion = ''
      loadLoaderVersions()
    }
    lvSel.onchange = () => { state.loaderVersion = lvSel.value }

    ctx.body.appendChild(h('div', { class: 'row wrap' },
      h('div', { class: 'field grow', style: { minWidth: '110px' } }, h('label', {}, '加载器'), loaderSel),
      h('div', { class: 'field grow', style: { minWidth: '100px' } }, h('label', {}, 'MC 版本'), mcSel),
      h('div', { class: 'field grow', style: { minWidth: '110px' } }, h('label', {}, '加载器版本'), lvSel)))
    ctx.body.appendChild(h('div', { class: 'row' }, h('div', { class: 'grow' }, dirInput),
      h('button', { class: 'btn btn-sm', onclick: async () => {
        const p = await pickDir(dirInput.value || '')
        if (p) {
          dirInput.value = p
          state.dir = p
        }
      } }, '浏览')))
    ctx.body.appendChild(h('div', { class: 'row' }, btnDownload, h('span', { class: 'spacer' }), noteEl))
    ctx.body.appendChild(h('div', { class: 'hr' }))
    ctx.body.appendChild(jobsEl)

    await loadMcVersions()
    await loadLoaderVersions()
    refreshJobs()
    timer = setInterval(refreshJobs, 1000)
  },

  unmount() {
    if (timer) clearInterval(timer)
    timer = null
  },

  // 展开大屏：与磁贴完全独立的一套表单/任务区，互不干扰
  renderExpanded(container, { ctx } = {}) {
    serverCoreExpanded(container, ctx)
  }
}

// ---------------- 展开视图（独立实例，不复用磁贴的全局 els/state/timer） ----------------
function serverCoreExpanded(container, ctx) {
  const settings = (ctx && ctx.settings ? ctx.settings() : ctxRef?.settings()) || {}
  const s = settings

  container.appendChild(h('div', { class: 'row' },
    h('b', { style: { fontSize: '14px' } }, '服务端核心下载'),
    h('span', { class: 'spacer' }),
    h('span', { class: 'muted' }, '支持 官方原版 / Fabric / Forge / NeoForge / Quilt / Paper')))

  const loaderSel = h('select', { class: 'input' }, ...LOADERS.map(([v, l]) => h('option', { value: v }, l)))
  loaderSel.value = 'fabric'
  const mcSel = h('select', { class: 'input' }, h('option', { value: '' }, '加载中…'))
  const lvSel = h('select', { class: 'input' }, h('option', { value: '' }, '—'))
  const dirInput = h('input', { class: 'input mono', placeholder: '下载目录（留空用设置里的下载目录）', value: s.community?.downloadDir || '' })
  const noteEl = h('div', { class: 'muted' }, '')
  const jobsEl = h('div', { class: 'scroll-y', style: { maxHeight: '300px', display: 'flex', flexDirection: 'column', gap: '6px' } })

  const local = { loader: 'fabric', mc: '', lv: '' }

  loaderSel.onchange = () => { local.loader = loaderSel.value; local.lv = ''; loadLoaderVersions() }
  mcSel.onchange = () => { local.mc = mcSel.value; local.lv = ''; loadLoaderVersions() }
  lvSel.onchange = () => { local.lv = lvSel.value }

  async function loadMc() {
    try {
      const data = await api.get('/api/servercore/gameversions')
      const items = data.items || []
      if (!items.length) throw new Error(data.error || '空')
      clear(mcSel)
      for (const v of items) mcSel.appendChild(h('option', { value: v.id }, v.id))
      local.mc = items[0].id
      mcSel.value = local.mc
      loadLoaderVersions()
    } catch (e) {
      clear(mcSel)
      mcSel.appendChild(h('option', { value: '' }, '（获取失败）'))
    }
  }
  async function loadLoaderVersions() {
    clear(lvSel)
    lvSel.appendChild(h('option', { value: '' }, '加载中…'))
    try {
      const data = await api.get(`/api/servercore/loaderversions?loader=${encodeURIComponent(local.loader)}&mc=${encodeURIComponent(local.mc || '')}`)
      const items = data.items || []
      clear(lvSel)
      if (!items.length) { lvSel.appendChild(h('option', { value: '' }, '（无可用版本）')); return }
      for (const it of items) lvSel.appendChild(h('option', { value: it.version }, it.label ? `${it.version} (${it.label})` : it.version))
      local.lv = items[0].version
      lvSel.value = local.lv
    } catch {
      clear(lvSel)
      lvSel.appendChild(h('option', { value: '' }, '（获取失败）'))
    }
  }

  const btnDownload = h('button', { class: 'btn btn-primary' }, '⬇ 下载')
  btnDownload.onclick = async () => {
    if (!local.mc) { toast('请选择 MC 版本', 'err'); return }
    if (local.loader !== 'vanilla' && !local.lv) { toast('请选择加载器版本', 'err'); return }
    btnDownload.disabled = true
    try {
      const r = await api.post('/api/servercore/download', {
        loader: local.loader, mc: local.mc, loaderVersion: local.lv, dir: dirInput.value
      })
      if (r.error) throw new Error(r.error)
      if (r.note) noteEl.textContent = r.note
      toast('已加入下载队列：' + r.filename, 'ok')
      refreshJobs()
    } catch (e) {
      toast('下载失败：' + e.message, 'err')
    } finally {
      btnDownload.disabled = false
    }
  }

  async function refreshJobs() {
    try {
      const data = await api.get('/api/community/jobs')
      const jobs = (data.items || []).filter((j) => j.meta && j.meta.type === 'servercore')
      clear(jobsEl)
      if (!jobs.length) { jobsEl.appendChild(h('div', { class: 'muted center', style: { padding: '12px' } }, '暂无下载任务')); return }
      for (const j of jobs.slice(0, 12)) {
        const pct = j.total ? Math.min(100, Math.round((j.received / j.total) * 100)) : 0
        const installing = j.status === 'installing'
        const barW = installing ? (typeof j.installProgress === 'number' ? j.installProgress : null) : pct
        const shortLabel = { queued: '排队中', running: '下载中', installing: '安装中', done: '已完成', failed: '失败', cancelled: '已取消' }[j.status] || j.status
        const badgeCls = j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : (j.status === 'running' || j.status === 'installing') ? 'info' : ''
        const statusText = installing
          ? (j.installProgress != null ? `正在安装 ${Math.round(j.installProgress)}%` : '正在安装…') + (j.installLog ? ' · ' + j.installLog : '')
          : j.status === 'running' ? `${fmtBytes(j.received)} / ${j.total ? fmtBytes(j.total) : '?'} · ${pct}% · ${fmtSpeed(j.speed)}`
          : j.status === 'done' ? `已完成 · ${fmtBytes(j.total || j.received)}`
          : j.status === 'failed' ? '失败'
          : j.status === 'cancelled' ? '已取消' : '排队中'
        jobsEl.appendChild(h('div', { class: 'feature-item', style: { padding: '8px 10px' } },
          h('div', { class: 'fi-main' },
            h('div', { class: 'row' }, h('b', { style: { fontSize: '12.5px' } }, j.filename),
              h('span', { class: 'spacer' }),
              h('span', { class: 'badge ' + badgeCls }, shortLabel)),
            j.dir ? h('div', { class: 'muted mono', style: { fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: j.dir }, j.dir) : null,
            h('div', { class: 'bar' + ((installing && typeof j.installProgress !== 'number') ? ' indeterminate' : ''), style: { margin: '5px 0' } },
              h('i', { style: barW == null ? {} : { width: barW + '%' } })),
            h('div', { class: 'muted' }, statusText)),
          (j.status === 'running' || j.status === 'queued') ? h('button', { class: 'btn btn-sm', onclick: async () => { await api.post('/api/community/jobs/cancel', { id: j.id }); refreshJobs() } }, '取消') : null))
      }
    } catch { /* 忽略 */ }
  }

  // 布局
  container.appendChild(h('div', { class: 'section', style: { marginTop: '10px' } },
    h('div', { class: 'row wrap' },
      h('div', { class: 'field grow' }, h('label', {}, '加载器'), loaderSel),
      h('div', { class: 'field grow' }, h('label', {}, 'MC 版本'), mcSel),
      h('div', { class: 'field grow' }, h('label', {}, '加载器版本'), lvSel)),
    h('div', { class: 'row', style: { marginTop: '8px' } }, h('div', { class: 'grow' }, dirInput),
      h('button', { class: 'btn btn-sm', onclick: async () => { const p = await pickDir(dirInput.value || ''); if (p) dirInput.value = p } }, '浏览')),
    h('div', { class: 'row', style: { marginTop: '10px' } }, btnDownload, h('span', { class: 'spacer' }), noteEl)))
  container.appendChild(h('div', { class: 'hr' }))
  container.appendChild(h('div', { class: 'row' }, h('span', { class: 'muted' }, '下载任务'), h('span', { class: 'spacer' }), h('button', { class: 'btn btn-sm', onclick: refreshJobs }, '↻ 刷新')))
  container.appendChild(jobsEl)

  loadMc()
  refreshJobs()
  const iv = setInterval(refreshJobs, 1500)
  // 大屏关闭时停止轮询
  const obs = new MutationObserver(() => {
    if (!document.body.contains(container)) {
      clearInterval(iv)
      obs.disconnect()
    }
  })
  obs.observe(document.body, { childList: true, subtree: true })
}

// ---------------- 数据 ----------------
async function loadMcVersions() {
  try {
    const data = await api.get('/api/servercore/gameversions')
    const items = data.items || []
    if (!items.length) throw new Error(data.error || '版本列表为空')
    clear(els.mcSel)
    for (const v of items) els.mcSel.appendChild(h('option', { value: v.id }, v.id))
    state.mc = items[0].id
    els.mcSel.value = state.mc
  } catch (e) {
    clear(els.mcSel)
    els.mcSel.appendChild(h('option', { value: '' }, '（获取失败）'))
    toast('获取 MC 版本失败：' + e.message, 'err')
  }
}

async function loadLoaderVersions() {
  if (!state.mc) return
  clear(els.lvSel)
  els.lvSel.appendChild(h('option', { value: '' }, '加载中…'))
  els.noteEl.textContent = ''
  try {
    const data = await api.get(`/api/servercore/loaderversions?loader=${encodeURIComponent(state.loader)}&mc=${encodeURIComponent(state.mc)}`)
    const items = data.items || []
    clear(els.lvSel)
    if (!items.length) {
      els.lvSel.appendChild(h('option', { value: '' }, '（无可用版本）'))
      if (data.error) els.noteEl.textContent = data.error
      return
    }
    for (const it of items) {
      const label = it.label ? `${it.version} (${it.label})` : it.version
      els.lvSel.appendChild(h('option', { value: it.version }, label))
    }
    state.loaderVersion = items[0].version
    els.lvSel.value = state.loaderVersion
  } catch (e) {
    clear(els.lvSel)
    els.lvSel.appendChild(h('option', { value: '' }, '（获取失败）'))
  }
}

// ---------------- 下载 ----------------
async function download() {
  if (state.busy) return
  if (!state.mc) {
    toast('请选择 MC 版本', 'err')
    return
  }
  if (state.loader !== 'vanilla' && !state.loaderVersion) {
    toast('请选择加载器版本', 'err')
    return
  }
  state.busy = true
  try {
    const r = await api.post('/api/servercore/download', {
      loader: state.loader,
      mc: state.mc,
      loaderVersion: state.loaderVersion,
      dir: state.dir
    })
    if (r.error) throw new Error(r.error)
    if (r.note) els.noteEl.textContent = r.note
    toast('已加入下载队列：' + r.filename, 'ok')
    refreshJobs()
  } catch (e) {
    toast('下载失败：' + e.message, 'err')
  } finally {
    state.busy = false
  }
}

async function refreshJobs() {
  if (!els.jobsEl) return
  try {
    const data = await api.get('/api/community/jobs')
    const all = data.items || []
    const jobs = all.filter((j) => j.meta && j.meta.type === 'servercore')
    const running = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length
    ctxRef?.setBadge(running ? `${running} 个进行中` : '', running ? 'info' : '')
    clear(els.jobsEl)
    if (!jobs.length) {
      els.jobsEl.appendChild(h('div', { class: 'muted center', style: { padding: '10px' } }, '暂无下载任务'))
      return
    }
    const STATUS = { queued: '排队中', running: '下载中', installing: '安装中', done: '已完成', failed: '失败', cancelled: '已取消' }
    for (const j of jobs.slice(0, 8)) {
      const pct = j.total ? Math.min(100, Math.round((j.received / j.total) * 100)) : 0
      const badgeClass = j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : j.status === 'running' || j.status === 'installing' ? 'info' : ''
      const installing = j.status === 'installing'
      const instPct = typeof j.installProgress === 'number' ? j.installProgress : null
      const barWidth = installing ? instPct : pct
      const indeterminate = installing && instPct == null
      let statusText
      if (installing) {
        statusText = instPct != null ? `正在安装 · ${Math.round(instPct)}%` : '正在安装，请稍候…'
        if (j.installLog) statusText += ` · ${j.installLog}`
      } else {
        statusText = `${fmtBytes(j.received)} / ${j.total ? fmtBytes(j.total) : '?'} · ${pct}%`
        if (j.status === 'running') statusText += ` · ${fmtSpeed(j.speed)} · ${j.threads} 线程`
      }
      if (j.error) statusText += ` · ${j.error}`
      els.jobsEl.appendChild(h('div', { class: 'feature-item', style: { padding: '6px 8px' } },
        h('div', { class: 'fi-main' },
          h('div', { class: 'row' },
            h('b', { style: { fontSize: '12px' } }, j.filename),
            h('span', { class: 'spacer' }),
            h('span', { class: 'badge ' + badgeClass }, STATUS[j.status] || j.status)),
          j.dir ? h('div', { class: 'muted mono', style: { fontSize: '10.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }, title: j.dir }, j.dir) : null,
          h('div', { class: 'bar' + (indeterminate ? ' indeterminate' : ''), style: { margin: '4px 0' } },
            h('i', { style: barWidth == null ? {} : { width: barWidth + '%' } })),
          h('span', { class: 'muted', style: { wordBreak: 'break-all' } }, statusText)),
        (j.status === 'running' || j.status === 'queued')
          ? h('button', { class: 'btn btn-sm', onclick: async () => {
            await api.post('/api/community/jobs/cancel', { id: j.id })
            refreshJobs()
          } }, '取消')
          : null))
    }
  } catch {
    /* 忽略轮询错误 */
  }
}
