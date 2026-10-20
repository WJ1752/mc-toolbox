// 社区资源下载 — Modrinth / CurseForge 搜索、详情与下载队列
import { h, clear, fmtBytes, fmtAgo } from '/js/core/dom.js'
import { api } from '/js/core/api.js'
import { openModal } from '/js/core/modal.js'
import { toast } from '/js/core/toast.js'
import { pickDir } from '/js/core/dirpicker.js'
import { icon } from '/js/ui/icons.js'
import { btn, iconBtn, input, select, field, seg, progress, spinner, openPath } from '/js/ui/kit.js'

const TYPES = [
  ['', '全部'],
  ['mod', 'Mod'],
  ['modpack', '整合包'],
  ['datapack', '数据包'],
  ['resourcepack', '资源包'],
  ['shader', '光影']
]
const LOADERS = [['', '不限'], ['fabric', 'Fabric'], ['forge', 'Forge'], ['neoforge', 'NeoForge'], ['quilt', 'Quilt']]
// 排序方式（Modrinth index 原生支持；CurseForge 由后端映射到 sortField/sortOrder）
const SORTS = [
  ['relevance', '相关性'],
  ['downloads', '下载量'],
  ['follows', '点赞'],
  ['updated', '最近更新'],
  ['newest', '最新发布']
]
// 常用 Minecraft 版本（新→旧），用于版本输入框建议
const COMMON_VERSIONS = [
  '1.21.5', '1.21.4', '1.21.3', '1.21.1', '1.21',
  '1.20.6', '1.20.4', '1.20.2', '1.20.1', '1.20',
  '1.19.4', '1.19.2', '1.19',
  '1.18.2', '1.18.1', '1.18',
  '1.16.5', '1.16.4', '1.16.1',
  '1.12.2', '1.7.10'
]

const JOB_LABEL = { queued: '排队中', running: '下载中', installing: '安装中', done: '已完成', failed: '失败', cancelled: '已取消' }
const DOT_CLASS = { done: 'ok', failed: 'bad', cancelled: '', queued: 'warn', running: 'warn', installing: 'warn' }
const BADGE_CLASS = { done: 'ok', failed: 'bad', cancelled: '', queued: 'warn', running: 'info', installing: 'info' }
const LINK_LABEL = { site: '官网', wiki: 'Wiki', issues: '问题追踪', discord: 'Discord' }
const FALLBACK_BODY = '（该项目没有提供简介）'
const POLL_MS = 1200

let ctxRef = null
let tileDir = ''
let tileJobs = null
let tileVersion = null

/* ---------------- 小工具 ---------------- */

function fmtCount(n) {
  if (!n) return '0'
  if (n >= 1e8) return (n / 1e8).toFixed(1) + ' 亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万'
  return String(n)
}

function fmtSpeed(bps) {
  if (!bps || bps <= 0) return ''
  if (bps >= 1024 * 1024) return (bps / 1024 / 1024).toFixed(1) + ' MB/s'
  if (bps >= 1024) return (bps / 1024).toFixed(1) + ' KB/s'
  return Math.round(bps) + ' B/s'
}

// 去掉项目简介里的 HTML 标签与常见实体（内容一律走 textContent，不注入 HTML）
function stripHtml(text) {
  return String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function msgRow(text) {
  return h('div', { class: 'muted center', style: { gridColumn: '1 / -1', padding: '18px 0', fontSize: '11.5px' } }, text)
}

function errorRow(text) {
  return h('div', {
    class: 'result-bad center',
    style: { gridColumn: '1 / -1', padding: '14px 0', fontSize: '11.5px', overflowWrap: 'anywhere' }
  }, text)
}

function loadingRow(text) {
  return h('div', {
    class: 'row',
    style: { gridColumn: '1 / -1', justifyContent: 'center', padding: '18px 0', color: 'var(--mute)', fontSize: '11.5px' }
  }, spinner(12), text)
}

function thumbNode(src, { className, iconSize = 18, style = null } = {}) {
  const box = h('div', { class: className })
  if (style) Object.assign(box.style, style)
  const fallback = () => {
    clear(box)
    box.style.display = 'grid'
    box.style.placeItems = 'center'
    box.style.color = 'var(--mute)'
    box.appendChild(icon('package-down', { size: iconSize }))
  }
  if (!src) {
    fallback()
    return box
  }
  const img = h('img', { src, alt: '', loading: 'lazy' })
  img.addEventListener('error', fallback)
  box.appendChild(img)
  return box
}

// 详情面板/弹窗里的大图标：容器裁切，图片始终按框缩放
function detailIconNode(src, { size = 56, iconSize = 24 } = {}) {
  const box = h('div', {
    class: 'cd-detail-icon',
    style: {
      width: size + 'px',
      height: size + 'px',
      display: 'grid',
      placeItems: 'center',
      overflow: 'hidden',
      background: 'var(--bg-3)',
      color: 'var(--mute)'
    }
  })
  if (!src) {
    box.appendChild(icon('package-down', { size: iconSize }))
    return box
  }
  const img = h('img', { src, alt: '', style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' } })
  img.addEventListener('error', () => {
    clear(box)
    box.appendChild(icon('package-down', { size: iconSize }))
  })
  box.appendChild(img)
  return box
}

/* ---------------- MC 版本输入 + 常用版本建议 ---------------- */

function createVersionField({ value = '', bounds, placeholder = '版本' } = {}) {
  const inp = input({ value, placeholder, mono: true, title: 'Minecraft 版本，如 1.20.1' })
  inp.setAttribute('aria-label', 'Minecraft 版本')
  inp.style.width = '104px'
  const wrap = h('div', { style: { position: 'relative', flex: 'none' } }, inp)
  const pop = h('div', { class: 'suggest', hidden: true })
  wrap.appendChild(pop)

  let outside = null

  function close() {
    pop.hidden = true
    if (outside) {
      document.removeEventListener('pointerdown', outside)
      outside = null
    }
  }

  function open() {
    const q = inp.value.trim().toLowerCase()
    const list = q ? COMMON_VERSIONS.filter((v) => v.includes(q)) : COMMON_VERSIONS
    clear(pop)
    if (!list.length) {
      close()
      return
    }
    pop.appendChild(h('div', { class: 'sg-head' }, '常用版本'))
    for (const v of list) {
      pop.appendChild(h('button', {
        type: 'button',
        onclick: () => {
          inp.value = v
          close()
        }
      }, v))
    }
    // 高度限制在磁贴/展开视图给输入框预留的剩余空间内，避免溢出
    try {
      const box = typeof bounds === 'function' ? bounds() : bounds
      if (box) {
        const bodyRect = box.getBoundingClientRect()
        const wrapRect = wrap.getBoundingClientRect()
        const space = bodyRect.bottom - wrapRect.bottom - 10
        pop.style.maxHeight = Math.max(96, Math.min(300, space)) + 'px'
      }
    } catch {}
    pop.style.overflowY = 'auto'
    pop.hidden = false
    if (!outside) {
      outside = (e) => {
        if (!wrap.contains(e.target)) close()
      }
      document.addEventListener('pointerdown', outside)
    }
  }

  inp.addEventListener('focus', open)
  inp.addEventListener('input', open)
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  })

  return { el: wrap, input: inp, dispose: close }
}

/* ---------------- 结果卡片 ---------------- */

function resultCard(it, onOpen) {
  const author = it.author || '未知作者'
  const metaText = `${author} · ↓${fmtCount(it.downloads)} · ${fmtAgo(Date.parse(it.updated || 0))}`
  const title = it.title || '未命名项目'
  const open = () => onOpen(it)
  const dl = iconBtn('download', {
    size: 13,
    label: '下载',
    title: '查看版本并下载',
    onClick: (e) => {
      e.stopPropagation()
      open()
    }
  })
  dl.style.alignSelf = 'center'

  return h('div', {
    class: 'cd-card',
    role: 'button',
    tabindex: '0',
    'aria-label': title,
    onclick: open,
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        open()
      }
    }
  },
    thumbNode(it.icon, { className: 'cd-thumb', iconSize: 18 }),
    h('div', { class: 'cd-main' },
      h('div', { class: 'cd-title', title }, title),
      h('div', { class: 'cd-meta', title: metaText }, metaText),
      h('div', { class: 'cd-sum', title: it.summary || '' }, it.summary || '')
    ),
    dl
  )
}

function renderCards(host, items, onOpen) {
  clear(host)
  if (!items.length) {
    host.appendChild(msgRow('没有结果'))
    return
  }
  for (const it of items) host.appendChild(resultCard(it, onOpen))
}

/* ---------------- 下载任务队列 ---------------- */

function createJobBoard({ limit = 8, height = 228, holder = null, onDispose = null } = {}) {
  const list = h('div', { class: 'job-list scroll-y', style: { maxHeight: height + 'px' } })
  const emptyEl = h('div', { class: 'muted', style: { fontSize: '11px', padding: '2px 0' } }, '暂无下载任务')
  const rows = new Map()
  let timer = null
  let busy = false
  let disposed = false

  function jobMetaText(j) {
    const received = fmtBytes(j.received || 0)
    const total = j.total ? fmtBytes(j.total) : ''
    if (j.status === 'installing') {
      const ip = Number(j.installProgress)
      const pctText = Number.isFinite(ip) ? Math.round(ip) + '%' : ''
      return ['安装中', pctText, j.installLog || ''].filter(Boolean).join(' · ')
    }
    if (j.status === 'queued') return '等待调度'
    if (j.status === 'done') return total || received
    if (j.status === 'cancelled') return total ? `${received} / ${total}` : received
    const parts = [total ? `${received} / ${total}` : received]
    if (j.total) parts.push(Math.round((j.received / j.total) * 100) + '%')
    if (j.status === 'running') {
      if (j.speed > 0) parts.push(fmtSpeed(j.speed))
      if (j.threads > 1) parts.push(j.threads + ' 线程')
    }
    return parts.join(' · ')
  }

  function updateRow(r, j) {
    const pct = j.total ? Math.max(0, Math.min(100, (j.received / j.total) * 100)) : 0
    const installing = j.status === 'installing'
    const instPct = installing && Number.isFinite(Number(j.installProgress)) ? Number(j.installProgress) : null
    const barPct = installing ? instPct : pct
    r.bar.set(barPct)
    r.bar.state(j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : '')
    r.bar.el.title = barPct === null || barPct === undefined ? '进行中' : Math.round(barPct) + '%'
    r.dotEl.className = 'dot ' + (DOT_CLASS[j.status] || '')
    r.name.textContent = j.filename || j.title || '未命名文件'
    r.name.title = j.filename || ''
    r.dirEl.textContent = j.dir || ''
    r.dirEl.title = j.dir || ''
    r.dirEl.hidden = !j.dir
    r.badgeEl.className = 'badge ' + (BADGE_CLASS[j.status] || '')
    r.badgeEl.textContent = JOB_LABEL[j.status] || j.status || '未知'
    r.metaEl.textContent = jobMetaText(j)
    r.errEl.textContent = j.error || ''
    r.errEl.hidden = !j.error
    const canCancel = j.status === 'running' || j.status === 'queued'
    r.actBtn.textContent = canCancel ? '取消' : '打开'
    r.actBtn.title = canCancel ? '取消这个下载任务' : '打开任务目录'
  }

  function rowFor(j) {
    const dotEl = h('span', { class: 'dot' })
    const name = h('div', { class: 'j-title' })
    const dirEl = h('div', { class: 'j-meta mono', hidden: true })
    const bar = progress(0, { className: 'j-bar' })
    const metaEl = h('div', { class: 'j-meta' })
    const errEl = h('div', { class: 'j-error', hidden: true })
    const badgeEl = h('span', { class: 'badge' })
    const actBtn = h('button', { class: 'btn btn-xs', type: 'button' })
    const r = { row: h('div', { class: 'job' }), dotEl, name, dirEl, bar, metaEl, errEl, badgeEl, actBtn, job: j }
    actBtn.addEventListener('click', () => {
      const job = r.job
      if (!job) return
      if (job.status === 'running' || job.status === 'queued') cancelJob(job)
      else openJobDir(job)
    })
    r.row.append(
      dotEl,
      h('div', { class: 'j-main' }, name, dirEl, bar.el, metaEl, errEl),
      h('div', { class: 'j-actions' }, badgeEl, actBtn)
    )
    rows.set(j.id, r)
    return r
  }

  function render(items) {
    const shown = items.slice(0, limit)
    if (!shown.length) {
      for (const r of rows.values()) r.row.remove()
      rows.clear()
      clear(list)
      list.appendChild(emptyEl)
      return
    }
    if (emptyEl.parentNode === list) emptyEl.remove()
    const ids = new Set()
    for (const j of shown) {
      ids.add(j.id)
      const r = rowFor(j)
      r.job = j
      updateRow(r, j)
      list.appendChild(r.row)
    }
    for (const [id, r] of rows) {
      if (ids.has(id)) continue
      r.row.remove()
      rows.delete(id)
    }
  }

  async function refresh() {
    if (disposed || busy) return
    if (holder && !holder.isConnected) {
      stop()
      return
    }
    busy = true
    try {
      const data = await api.get('/api/community/jobs')
      if (disposed) return
      const items = (data.items || []).filter((j) => j.meta?.type !== 'servercore')
      render(items)
    } catch {
      // 轮询失败时保留上一次的任务视图
    } finally {
      busy = false
    }
  }

  async function cancelJob(job) {
    try {
      await api.post('/api/community/jobs/cancel', { id: job.id })
      await refresh()
    } catch (e) {
      toast('取消失败：' + e.message, 'err')
    }
  }

  async function openJobDir(job) {
    if (!job.dir) {
      toast('该任务没有记录目标目录', 'err')
      return
    }
    await openPath(job.dir)
  }

  function start() {
    if (timer) clearInterval(timer)
    disposed = false
    refresh()
    timer = setInterval(refresh, POLL_MS)
  }

  function stop() {
    if (disposed) return
    disposed = true
    if (timer) clearInterval(timer)
    timer = null
    if (typeof onDispose === 'function') {
      try { onDispose() } catch {}
    }
  }

  return { el: list, start, stop, refresh }
}

/* ---------------- 下载目录 ---------------- */

function readDir() {
  return tileDir || ''
}

/* ---------------- 详情弹窗 ---------------- */

function openDetail(item, { gameVersion = '', loader = '', onDownloaded = null } = {}) {
  let versions = []
  let projType = ''

  const head = h('div', { class: 'cd-detail-head' })
  const links = h('div', { class: 'pill-list' })
  const bodyText = h('div', { class: 'cd-detail-body' }, '加载中…')
  const verSel = select([], '', { ariaLabel: '版本' })
  verSel.appendChild(h('option', { value: '' }, '加载中…'))
  const fileSel = select([], '', { ariaLabel: '文件' })
  fileSel.appendChild(h('option', { value: '' }, '加载中…'))
  const dirInput = input({ value: readDir(), mono: true, readonly: true, placeholder: '留空 = 系统下载文件夹', title: '在磁贴内「下载目录」处修改' })
  const errEl = h('div', { class: 'result-bad', style: { display: 'none', fontSize: '11px', overflowWrap: 'anywhere' } })

  const author = item.author || '未知作者'
  const title = item.title || '未命名项目'
  head.append(
    detailIconNode(item.icon, { size: 56, iconSize: 24 }),
    h('div', { style: { minWidth: '0', display: 'flex', flexDirection: 'column', gap: '3px' } },
      h('div', { style: { fontSize: 'var(--fs-15)', fontWeight: '600', lineHeight: '1.35', overflowWrap: 'anywhere' } }, title),
      h('div', { class: 'muted', style: { fontSize: '11px' } },
        `${author} · ↓${fmtCount(item.downloads)} · ${fmtAgo(Date.parse(item.updated || 0))}`),
      item.summary ? h('div', { class: 'muted', style: { fontSize: '11.5px', lineHeight: '1.6' } }, item.summary) : null
    )
  )

  if (item.url) {
    links.appendChild(h('button', {
      class: 'pill',
      type: 'button',
      style: { cursor: 'pointer' },
      title: item.url,
      onclick: () => window.open(item.url, '_blank')
    }, icon('external', { size: 11 }), '打开项目页'))
  }

  const dlBtn = btn('下载', { variant: 'primary', iconName: 'download', onClick: () => doDownload() })

  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
    head,
    links,
    bodyText,
    h('div', { class: 'hr', style: { margin: '0' } }),
    h('div', { class: 'cd-versions' },
      field('版本', verSel),
      field('文件', fileSel)
    ),
    field('下载到（默认目录在磁贴内「下载目录」处设置；留空 = 系统下载文件夹）', dirInput),
    errEl
  )

  const modal = openModal({
    title,
    size: 'lg',
    body,
    buttons: [
      { label: '关闭', class: 'btn-ghost' },
      dlBtn
    ]
  })

  api.get(`/api/community/project?source=${encodeURIComponent(item.source || '')}&id=${encodeURIComponent(item.id)}`)
    .then((p) => {
      projType = p?.type || ''
      const raw = p?.body || p?.summary || ''
      const text = stripHtml(raw)
      bodyText.textContent = text ? text.slice(0, 4000) : FALLBACK_BODY
      if (p?.license) links.appendChild(h('span', { class: 'pill', title: '许可证' }, '许可：' + p.license))
      for (const [k, v] of Object.entries(p?.links || {})) {
        if (!v) continue
        links.appendChild(h('button', {
          class: 'pill',
          type: 'button',
          style: { cursor: 'pointer' },
          title: v,
          onclick: () => window.open(v, '_blank')
        }, icon('link', { size: 11 }), LINK_LABEL[k] || k))
      }
    })
    .catch((e) => {
      bodyText.textContent = '详情加载失败：' + e.message
    })

  api.get(`/api/community/versions?source=${encodeURIComponent(item.source || '')}&id=${encodeURIComponent(item.id)}&gameVersion=${encodeURIComponent(gameVersion)}&loader=${encodeURIComponent(loader)}`)
    .then((result) => {
      const list = Array.isArray(result) ? result : []
      versions = list
      clear(verSel)
      if (!list.length) {
        verSel.appendChild(h('option', { value: '' }, '没有匹配的版本'))
        clear(fileSel)
        fileSel.appendChild(h('option', { value: '' }, '该文件没有可下载地址'))
        return
      }
      list.slice(0, 60).forEach((v, i) => {
        verSel.appendChild(h('option', { value: String(i) },
          `${v.name} · ${(v.loaders || []).join('/') || '—'} · ${(v.gameVersions || []).slice(-3).join(', ')}`))
      })
      verSel.value = '0'
      renderFiles()
      verSel.onchange = renderFiles
    })
    .catch((e) => {
      clear(verSel)
      verSel.appendChild(h('option', { value: '' }, '版本加载失败：' + e.message))
    })

  function renderFiles() {
    const v = versions[Number(verSel.value) || 0]
    clear(fileSel)
    const files = (v && v.files) || []
    for (const f of files) fileSel.appendChild(h('option', { value: f.url }, `${f.name}（${fmtBytes(f.size)}）`))
    if (!files.length) fileSel.appendChild(h('option', { value: '' }, '该文件没有可下载地址'))
    else fileSel.value = files[0].url
  }

  async function doDownload() {
    errEl.style.display = 'none'
    const url = fileSel.value
    if (!url) {
      toast('请先选择版本', 'err')
      return
    }
    const v = versions[Number(verSel.value) || 0] || {}
    const f = (v.files || []).find((x) => x.url === url) || {}
    dlBtn.disabled = true
    try {
      await api.post('/api/community/download', {
        url,
        filename: f.name || 'download.jar',
        dir: dirInput.value,
        title: item.title,
        meta: {
          project: item.title || '',
          version: v.number || v.name || '',
          loader: (v.loaders || [])[0] || '',
          gameVersion: (v.gameVersions || [])[0] || '',
          type: item.type || projType || '',
          source: item.source
        }
      })
      toast('已加入下载：' + item.title, 'ok')
      modal.close()
      if (onDownloaded) onDownloaded()
    } catch (e) {
      errEl.textContent = '下载失败：' + e.message
      errEl.style.display = ''
      toast('下载失败：' + e.message, 'err')
    } finally {
      dlBtn.disabled = false
    }
  }
}

/* ---------------- 磁贴 ---------------- */

function buildTile(ctx) {
  const s = ctx.settings() || {}
  const comm = s.community || {}
  tileDir = comm.downloadDir || ''

  const st = {
    source: comm.defaultSource || 'modrinth',
    type: '',
    query: '',
    gameVersion: comm.defaultGameVersion || '',
    loader: comm.defaultLoader || '',
    sort: 'relevance',
    offset: 0,
    limit: Number(comm.pageSize) || 20,
    total: 0,
    items: [],
    busy: false
  }

  if (tileJobs) { tileJobs.stop(); tileJobs = null }
  if (tileVersion) { tileVersion.dispose(); tileVersion = null }

  /* --- 搜索头部 --- */
  const searchInput = input({
    placeholder: '搜索 mod / 整合包 / 数据包 / 资源包 / 光影…',
    class: 'grow',
    onKeyDown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        st.offset = 0
        search()
      }
    }
  })
  searchInput.setAttribute('aria-label', '搜索社区资源')

  const version = createVersionField({ value: st.gameVersion, bounds: () => ctx.body })
  tileVersion = version

  const loaderSel = select(LOADERS, st.loader, { ariaLabel: '加载器', title: '加载器' })
  loaderSel.style.width = '110px'
  const sortSel = select(SORTS, st.sort, {
    ariaLabel: '排序方式',
    title: '排序方式',
    onchange: (v) => {
      st.sort = v
      st.offset = 0
      search()
    }
  })
  sortSel.style.width = '110px'

  const sourceSeg = seg([['modrinth', 'Modrinth'], ['curseforge', 'CurseForge']], st.source, (v) => {
    st.source = v
    st.offset = 0
    search()
  }, { title: '资源来源' })

  const searchBtn = btn('搜索', { variant: 'primary', iconName: 'search', onClick: () => { st.offset = 0; search() } })

  const typeBar = h('div', { class: 'cd-typebar' })
  function renderTypes() {
    clear(typeBar)
    for (const [v, label] of TYPES) {
      typeBar.appendChild(h('button', {
        class: 'pill' + (st.type === v ? ' active' : ''),
        type: 'button',
        'aria-pressed': st.type === v ? 'true' : 'false',
        onclick: () => {
          st.type = v
          st.offset = 0
          renderTypes()
          search()
        }
      }, label))
    }
  }

  /* --- 下载目录 --- */
  const dirInput = input({
    value: tileDir,
    mono: true,
    class: 'grow',
    placeholder: '下载目录（留空用系统下载文件夹）',
    title: '下载保存目录，修改后立即保存',
    onChange: () => persistDir()
  })
  dirInput.setAttribute('aria-label', '下载目录')

  async function persistDir() {
    tileDir = dirInput.value.trim()
    try {
      await api.put('/api/settings', { community: { downloadDir: tileDir } })
      try {
        const cur = ctx.settings()
        if (cur.community) cur.community.downloadDir = tileDir
      } catch {}
    } catch (e) {
      toast('保存下载目录失败：' + e.message, 'err')
    }
  }

  const browseBtn = btn('浏览', {
    size: 'sm',
    iconName: 'folder',
    title: '选择下载目录',
    onClick: async () => {
      try {
        const picked = await pickDir(dirInput.value || '')
        if (picked) {
          dirInput.value = picked
          await persistDir()
        }
      } catch (e) {
        toast('选择目录失败：' + e.message, 'err')
      }
    }
  })

  async function openDownloadDir() {
    const picked = (dirInput.value || '').trim() || readDir()
    try {
      if (picked) {
        await api.post('/api/fs/open', { path: picked })
        return
      }
      const roots = await api.get('/api/fs/roots')
      const home = (roots && roots.home) || ''
      if (!home) {
        toast('请先在磁贴内设置下载目录', 'err')
        return
      }
      await api.post('/api/fs/open', { path: home })
    } catch (e) {
      toast('无法打开下载目录（可能尚未创建）：' + e.message, 'err')
    }
  }

  const openDirBtn = iconBtn('folder-open', { label: '打开下载目录', title: '打开下载目录', onClick: openDownloadDir })

  /* --- 结果区 --- */
  const resultsEl = h('div', { class: 'cd-results' })
  const pageInfo = h('span', { class: 'info' }, '')
  const prevBtn = btn('上一页', {
    size: 'sm',
    iconName: 'arrow-left',
    onClick: () => {
      st.offset = Math.max(0, st.offset - st.limit)
      search()
    }
  })
  const nextBtn = btn('下一页', {
    size: 'sm',
    iconName: 'arrow-right',
    onClick: () => {
      st.offset += st.limit
      search()
    }
  })
  prevBtn.disabled = true

  function updatePager() {
    prevBtn.disabled = st.offset === 0
    pageInfo.textContent = st.items.length
      ? `${st.offset + 1}-${st.offset + st.items.length} / 共 ${st.total}`
      : `共 ${st.total}`
  }

  async function search() {
    if (st.busy) return
    st.busy = true
    st.query = searchInput.value.trim()
    st.gameVersion = version.input.value.trim()
    st.loader = loaderSel.value
    clear(resultsEl)
    resultsEl.appendChild(loadingRow('搜索中…'))
    ctx.setBadge('搜索中', 'info')
    try {
      const params = new URLSearchParams({
        source: st.source,
        query: st.query,
        gameVersion: st.gameVersion,
        loader: st.loader,
        limit: String(st.limit),
        offset: String(st.offset),
        sort: st.sort
      })
      if (st.type) params.set('type', st.type)
      const data = await api.get('/api/community/search?' + params)
      st.items = data.items || []
      st.total = data.total || 0
      renderCards(resultsEl, st.items, (it) => openDetail(it, {
        gameVersion: st.gameVersion,
        loader: st.loader,
        onDownloaded: () => tileJobs && tileJobs.refresh()
      }))
      updatePager()
      ctx.setBadge(`${st.total} 个结果`, '')
    } catch (e) {
      clear(resultsEl)
      resultsEl.appendChild(errorRow(e.message))
      ctx.setBadge('失败', 'bad')
    } finally {
      st.busy = false
    }
  }

  /* --- 任务区 --- */
  const board = createJobBoard({ limit: 8, height: 228, holder: ctx.el })
  tileJobs = board

  const clearJobsBtn = btn('清空记录', {
    size: 'sm',
    iconName: 'trash',
    onClick: async () => {
      try {
        await api.del('/api/community/jobs?scope=community')
        await board.refresh()
      } catch (e) {
        toast('清空失败：' + e.message, 'err')
      }
    }
  })

  /* --- 组装 --- */
  ctx.body.append(
    h('div', { class: 'cd-search', 'data-nocollapse': '' },
      h('div', { class: 'cd-search-row' },
        h('div', { class: 'grow' }, searchInput),
        sourceSeg,
        searchBtn
      ),
      h('div', { class: 'cd-search-row', style: { flexWrap: 'wrap' } },
        version.el,
        loaderSel,
        sortSel
      ),
      typeBar
    ),
    h('div', { class: 'cd-dirline', 'data-nocollapse': '' },
      h('div', { class: 'grow' }, dirInput),
      browseBtn,
      openDirBtn
    ),
    resultsEl,
    h('div', { class: 'cd-pager', 'data-nocollapse': '' }, prevBtn, pageInfo, nextBtn),
    h('div', { class: 'hr', style: { margin: '2px 0' } }),
    h('div', { class: 'row', style: { gap: '6px' }, 'data-nocollapse': '' },
      h('span', { class: 'muted', style: { fontSize: '11px' } }, '下载任务'),
      h('span', { class: 'spacer' }),
      clearJobsBtn
    ),
    board.el
  )

  renderTypes()
  resultsEl.appendChild(msgRow('输入关键词后点击搜索，或直接按 Enter'))
  board.start()
}

/* ---------------- 展开大屏 ---------------- */

function buildExpanded(container, ctx) {
  const s = ctx.settings() || {}
  const comm = s.community || {}
  if (!tileDir) tileDir = comm.downloadDir || ''

  const st = {
    source: comm.defaultSource || 'modrinth',
    type: '',
    gameVersion: comm.defaultGameVersion || '',
    loader: comm.defaultLoader || '',
    sort: 'relevance',
    offset: 0,
    limit: 24,
    total: 0,
    items: [],
    busy: false
  }

  const qInput = input({
    placeholder: '搜索 mod / 整合包 / 数据包 / 资源包 / 光影…',
    class: 'grow',
    onKeyDown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        st.offset = 0
        search()
      }
    }
  })
  qInput.setAttribute('aria-label', '搜索社区资源')

  const version = createVersionField({ value: st.gameVersion, bounds: () => container })

  const loaderSel = select(LOADERS, st.loader, { ariaLabel: '加载器', title: '加载器' })
  loaderSel.style.width = '110px'
  const sortSel = select(SORTS, st.sort, {
    ariaLabel: '排序方式',
    title: '排序方式',
    onchange: (v) => {
      st.sort = v
      st.offset = 0
      search()
    }
  })
  sortSel.style.width = '110px'

  const sourceSeg = seg([['modrinth', 'Modrinth'], ['curseforge', 'CurseForge']], st.source, (v) => {
    st.source = v
    st.offset = 0
    search()
  }, { title: '资源来源' })

  const searchBtn = btn('搜索', { variant: 'primary', iconName: 'search', onClick: () => { st.offset = 0; search() } })

  const typeBar = h('div', { class: 'cd-typebar' })
  function renderTypes() {
    clear(typeBar)
    for (const [v, label] of TYPES) {
      typeBar.appendChild(h('button', {
        class: 'pill' + (st.type === v ? ' active' : ''),
        type: 'button',
        'aria-pressed': st.type === v ? 'true' : 'false',
        onclick: () => {
          st.type = v
          st.offset = 0
          renderTypes()
          search()
        }
      }, label))
    }
  }

  const resultsEl = h('div', { class: 'cd-results', style: { maxHeight: '52vh' } })
  const pageInfo = h('span', { class: 'info' }, '')
  const prevBtn = btn('上一页', {
    size: 'sm',
    iconName: 'arrow-left',
    onClick: () => {
      st.offset = Math.max(0, st.offset - st.limit)
      search()
    }
  })
  const nextBtn = btn('下一页', {
    size: 'sm',
    iconName: 'arrow-right',
    onClick: () => {
      st.offset += st.limit
      search()
    }
  })
  prevBtn.disabled = true
  const pager = h('div', { class: 'cd-pager' }, prevBtn, pageInfo, nextBtn)

  function updatePager() {
    prevBtn.disabled = st.offset === 0
    pageInfo.textContent = st.items.length
      ? `${st.offset + 1}-${st.offset + st.items.length} / 共 ${st.total}`
      : `共 ${st.total}`
  }

  const detailEl = h('div', { class: 'col', style: { gap: '8px', minWidth: '0' } })
  const detailHint = h('div', { class: 'muted center', style: { padding: '40px 0', fontSize: '11.5px', lineHeight: '1.7' } },
    '在左侧搜索资源，点击结果在右侧查看版本并下载')
  detailEl.appendChild(detailHint)

  const root = h('div', { class: 'col', style: { gap: '10px' } })
  // holder 用本视图自己的根节点：展开视图被关闭（节点移除）后轮询自动停止
  const board = createJobBoard({ limit: 3, height: 150, holder: root, onDispose: () => version.dispose() })
  const jobsStrip = h('div', { class: 'col', style: { gap: '4px' } },
    h('div', { class: 'row', style: { gap: '6px' } },
      h('span', { class: 'muted', style: { fontSize: '11px' } }, '下载任务'),
      h('span', { class: 'spacer' }),
      btn('清空记录', {
        size: 'xs',
        iconName: 'trash',
        onClick: async () => {
          try {
            await api.del('/api/community/jobs?scope=community')
            await board.refresh()
          } catch (e) {
            toast('清空失败：' + e.message, 'err')
          }
        }
      })
    ),
    board.el
  )

  root.append(
    h('div', { class: 'col', style: { gap: '6px' } },
      h('div', { class: 'cd-search-row' },
        h('div', { class: 'grow' }, qInput),
        sourceSeg,
        searchBtn
      ),
      h('div', { class: 'cd-search-row', style: { flexWrap: 'wrap' } },
        version.el,
        loaderSel,
        sortSel
      ),
      typeBar
    ),
    jobsStrip,
    h('div', { style: { display: 'flex', gap: '14px', alignItems: 'flex-start', flexWrap: 'wrap' } },
      h('div', { style: { flex: '1 1 480px', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '6px' } },
        resultsEl,
        pager
      ),
      h('div', { class: 'col', style: { flex: '0 1 330px', minWidth: '260px', gap: '8px' } },
        detailEl
      )
    )
  )
  container.appendChild(root)

  async function search() {
    if (st.busy) return
    st.busy = true
    const q = qInput.value.trim()
    st.gameVersion = version.input.value.trim()
    st.loader = loaderSel.value
    clear(resultsEl)
    resultsEl.appendChild(loadingRow('搜索中…'))
    try {
      const params = new URLSearchParams({
        source: st.source,
        query: q,
        limit: String(st.limit),
        offset: String(st.offset),
        sort: st.sort
      })
      if (st.gameVersion) params.set('gameVersion', st.gameVersion)
      if (st.loader) params.set('loader', st.loader)
      if (st.type) params.set('type', st.type)
      const data = await api.get('/api/community/search?' + params)
      st.items = data.items || []
      st.total = data.total || 0
      renderCards(resultsEl, st.items, showDetail)
      updatePager()
    } catch (e) {
      clear(resultsEl)
      resultsEl.appendChild(errorRow(e.message))
    } finally {
      st.busy = false
    }
  }

  function showDetail(item) {
    clear(detailEl)
    let versions = []

    const author = item.author || '未知作者'
    const title = item.title || '未命名项目'
    const verSel = select([], '', { ariaLabel: '版本' })
    verSel.appendChild(h('option', { value: '' }, '加载中…'))
    const fileSel = select([], '', { ariaLabel: '文件' })
    const dirInput = input({ value: readDir(), mono: true, readonly: true, placeholder: '留空 = 系统下载文件夹', title: '与磁贴内「下载目录」同步，可在磁贴修改' })
    const errEl = h('div', { class: 'result-bad', style: { display: 'none', fontSize: '11px', overflowWrap: 'anywhere' } })

    const dlBtn = btn('下载到本地', { variant: 'primary', iconName: 'download', onClick: () => doDownload() })

    detailEl.append(
      h('div', { class: 'cd-detail-head' },
        detailIconNode(item.icon, { size: 44, iconSize: 20 }),
        h('div', { style: { minWidth: '0', display: 'flex', flexDirection: 'column', gap: '2px' } },
          h('div', { class: 'cd-title', style: { fontSize: 'var(--fs-13)' }, title: title }, title),
          h('div', { class: 'muted', style: { fontSize: '10.5px' } },
            `${author} · ↓${fmtCount(item.downloads)} · ${fmtAgo(Date.parse(item.updated || 0))}`)
        )
      ),
      field('版本', verSel),
      field('文件', fileSel),
      field('下载到（与磁贴内「下载目录」同步）', dirInput),
      dlBtn,
      errEl,
      h('div', { class: 'fx-note' }, '下载任务会显示在「社区资源下载」磁贴与上方的任务条中。')
    )

    if (item.url) {
      detailEl.insertBefore(
        h('button', {
          class: 'pill',
          type: 'button',
          style: { cursor: 'pointer', justifySelf: 'start', alignSelf: 'flex-start' },
          title: item.url,
          onclick: () => window.open(item.url, '_blank')
        }, icon('external', { size: 11 }), '打开项目页'),
        detailEl.children[1] || null
      )
    }

    function renderFiles() {
      const v = versions[Number(verSel.value) || 0]
      clear(fileSel)
      const files = (v && v.files) || []
      for (const f of files) fileSel.appendChild(h('option', { value: f.url }, `${f.name}（${fmtBytes(f.size)}）`))
      if (!files.length) fileSel.appendChild(h('option', { value: '' }, '该文件没有可下载地址'))
      else fileSel.value = files[0].url
    }

    async function doDownload() {
      errEl.style.display = 'none'
      const url = fileSel.value
      if (!url) {
        errEl.textContent = '请先选择版本/文件'
        errEl.style.display = ''
        return
      }
      const v = versions[Number(verSel.value) || 0] || {}
      const f = (v.files || []).find((x) => x.url === url) || {}
      dlBtn.disabled = true
      try {
        await api.post('/api/community/download', {
          url,
          filename: f.name || 'download.jar',
          dir: dirInput.value,
          title: item.title,
          meta: {
            project: item.title || '',
            version: v.number || v.name || '',
            loader: (v.loaders || [])[0] || '',
            gameVersion: (v.gameVersions || [])[0] || '',
            type: item.type || '',
            source: item.source
          }
        })
        toast('已加入下载：' + item.title, 'ok')
        board.refresh()
      } catch (e) {
        errEl.textContent = '下载失败：' + e.message
        errEl.style.display = ''
        toast('下载失败：' + e.message, 'err')
      } finally {
        dlBtn.disabled = false
      }
    }

    api.get(`/api/community/versions?source=${encodeURIComponent(item.source || '')}&id=${encodeURIComponent(item.id)}&gameVersion=${encodeURIComponent(st.gameVersion)}&loader=${encodeURIComponent(st.loader)}`)
      .then((result) => {
        const list = Array.isArray(result) ? result : []
        versions = list
        clear(verSel)
        if (!list.length) {
          verSel.appendChild(h('option', { value: '' }, '没有匹配的版本'))
          clear(fileSel)
          fileSel.appendChild(h('option', { value: '' }, '该文件没有可下载地址'))
          return
        }
        list.slice(0, 60).forEach((v, i) => {
          verSel.appendChild(h('option', { value: String(i) },
            `${v.name} · ${(v.loaders || []).join('/') || '—'} · ${(v.gameVersions || []).slice(-3).join(', ')}`))
        })
        verSel.value = '0'
        renderFiles()
        verSel.onchange = renderFiles
      })
      .catch((e) => {
        clear(verSel)
        verSel.appendChild(h('option', { value: '' }, '版本加载失败：' + e.message))
      })
  }

  renderTypes()
  resultsEl.appendChild(msgRow('输入关键词后点击搜索，或直接按 Enter'))
  board.start()
}

/* ---------------- 模块导出 ---------------- */

export default {
  async mount(ctx) {
    ctxRef = ctx
    buildTile(ctx)
  },

  unmount() {
    if (tileJobs) {
      tileJobs.stop()
      tileJobs = null
    }
    if (tileVersion) {
      tileVersion.dispose()
      tileVersion = null
    }
  },

  // 展开大屏：独立搜索状态 + 右侧详情/下载面板（不与磁贴共享结果）
  renderExpanded(container, { ctx } = {}) {
    const active = ctx || ctxRef
    if (!active) {
      container.appendChild(h('div', { class: 'result-bad' }, '缺少上下文，无法渲染社区资源视图'))
      return
    }
    buildExpanded(container, active)
  }
}
