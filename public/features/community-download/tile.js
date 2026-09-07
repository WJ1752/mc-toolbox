import { h, clear, fmtBytes, fmtAgo } from '/js/core/dom.js'

function fmtCount(n) {
  if (!n) return '0'
  if (n >= 1e8) return (n / 1e8).toFixed(1) + ' 亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万'
  return String(n)
}
import { api } from '/js/core/api.js'
import { openModal } from '/js/core/modal.js'
import { toast } from '/js/core/toast.js'
import { pickDir } from '/js/core/dirpicker.js'

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

let ctxRef = null
let defaultDir = ''
const state = {
  source: 'modrinth',
  type: '',
  query: '',
  gameVersion: '',
  loader: '',
  sort: 'relevance',
  offset: 0,
  limit: 20,
  total: 0,
  items: [],
  busy: false
}

export default {
  async mount(ctx) {
    ctxRef = ctx
    const s = ctx.settings()
    defaultDir = s.community?.downloadDir || ''
    state.source = s.community?.defaultSource || 'modrinth'
    state.gameVersion = s.community?.defaultGameVersion || ''
    state.loader = s.community?.defaultLoader || ''
    state.limit = s.community?.pageSize || 20

    const searchInput = h('input', { class: 'input', placeholder: '搜索 mod / 整合包 / 数据包 / 资源包 / 光影…' })
    const versionInput = h('input', { class: 'input mono', style: { width: '110px' }, placeholder: '版本', value: state.gameVersion })
    const versionWrap = h('div', { style: { position: 'relative' } }, versionInput)
    const suggestEl = h('div', { class: 'suggest', hidden: true })
    versionWrap.appendChild(suggestEl)

    // 版本建议下拉：聚焦/输入时显示，点击外部关闭；高度限制在磁贴可视范围内
    function openSuggest() {
      const q = versionInput.value.trim().toLowerCase()
      const list = q ? COMMON_VERSIONS.filter((v) => v.includes(q)) : COMMON_VERSIONS
      clear(suggestEl)
      if (!list.length) {
        suggestEl.hidden = true
        return
      }
      suggestEl.appendChild(h('div', { class: 'sg-head' }, '常用版本'))
      for (const v of list) {
        suggestEl.appendChild(h('button', {
          type: 'button',
          onclick: () => {
            versionInput.value = v
            state.gameVersion = v
            suggestEl.hidden = true
          }
        }, v))
      }
      // 限制下拉高度：不超过磁贴 body 在输入框下方的剩余空间，避免溢出磁贴
      try {
        const bodyRect = ctx.body.getBoundingClientRect()
        const wrapRect = versionWrap.getBoundingClientRect()
        const space = bodyRect.bottom - wrapRect.bottom - 10
        suggestEl.style.maxHeight = Math.max(96, Math.min(300, space)) + 'px'
      } catch {}
      suggestEl.style.overflowY = 'auto'
      suggestEl.hidden = false
    }
    versionInput.addEventListener('focus', openSuggest)
    versionInput.addEventListener('input', openSuggest)
    document.addEventListener('pointerdown', (e) => {
      if (!suggestEl.hidden && !versionWrap.contains(e.target)) suggestEl.hidden = true
    })
    const loaderSel = h('select', { class: 'input', style: { width: '110px' } }, ...LOADERS.map(([v, l]) => h('option', { value: v }, l)))
    loaderSel.value = state.loader
    const sortSel = h('select', { class: 'input', style: { width: '110px' }, title: '排序方式' }, ...SORTS.map(([v, l]) => h('option', { value: v }, l)))
    sortSel.value = state.sort
    sortSel.onchange = () => { state.sort = sortSel.value; state.offset = 0; search() }
    const sourceSeg = h('div', { class: 'seg' },
      ...[['modrinth', 'Modrinth'], ['curseforge', 'CurseForge']].map(([v, l]) =>
        h('button', {
          class: state.source === v ? 'active' : '',
          onclick: (e) => {
            state.source = v
            Array.from(e.target.parentElement.children).forEach((c) => c.classList.remove('active'))
            e.target.classList.add('active')
            state.offset = 0
            search()
          }
        }, l)))
    const typeWrap = h('div', { class: 'pill-list' })
    const resultsEl = h('div', { class: 'scroll-y', style: { display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '240px' } })
    const pageInfo = h('span', { class: 'muted' }, '')
    const jobsEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } })

    function renderTypes() {
      clear(typeWrap)
      for (const [v, label] of TYPES) {
        typeWrap.appendChild(h('button', {
          class: 'pill' + (state.type === v ? ' active' : ''),
          style: { cursor: 'pointer', borderColor: state.type === v ? 'var(--accent)' : '', color: state.type === v ? 'var(--accent)' : '' },
          onclick: () => {
            state.type = v
            state.offset = 0
            renderTypes()
            search()
          }
        }, label))
      }
    }

    async function search() {
      if (state.busy) return
      state.busy = true
      state.query = searchInput.value.trim()
      state.gameVersion = versionInput.value.trim()
      state.loader = loaderSel.value
      clear(resultsEl)
      resultsEl.appendChild(h('div', { class: 'muted center', style: { padding: '16px' } }, '搜索中…'))
      ctx.setBadge('搜索中', 'info')
      try {
        const params = new URLSearchParams({
          source: state.source,
          query: state.query,
          gameVersion: state.gameVersion,
          loader: state.loader,
          limit: String(state.limit),
          offset: String(state.offset),
          sort: state.sort
        })
        if (state.type) params.set('type', state.type)
        const data = await api.get('/api/community/search?' + params)
        state.items = data.items || []
        state.total = data.total || 0
        renderResults()
        ctx.setBadge(`${state.total} 个结果`, '')
      } catch (e) {
        clear(resultsEl)
        resultsEl.appendChild(h('div', { class: 'result-bad', style: { padding: '12px', fontSize: '12px' } }, e.message))
        ctx.setBadge('失败', 'bad')
      } finally {
        state.busy = false
      }
    }

    function renderResults() {
      clear(resultsEl)
      if (!state.items.length) {
        resultsEl.appendChild(h('div', { class: 'muted center', style: { padding: '16px' } }, '没有结果'))
        return
      }
      for (const it of state.items) {
        const dl = h('button', {
          class: 'btn btn-sm btn-primary',
          style: { flex: 'none' },
          title: '打开下载窗口',
          onclick: (e) => {
            e.stopPropagation()
            openDetail(it)
          }
        }, '⬇ 下载')
        resultsEl.appendChild(
          h('div', {
            class: 'feature-item',
            style: { cursor: 'pointer', padding: '8px' },
            onclick: () => openDetail(it)
          },
            it.icon
              ? h('img', { src: it.icon, style: { width: '32px', height: '32px', borderRadius: '6px', flex: 'none' }, alt: '' })
              : h('div', { class: 'fi-icon', style: { width: '32px', height: '32px', background: 'var(--surface-3)' } }, '📦'),
            h('div', { class: 'fi-main' },
              h('b', {}, it.title),
              h('span', {}, `${it.author || '未知作者'} · ↓${fmtBytes(it.downloads)} · ${fmtAgo(Date.parse(it.updated || 0))}`),
              h('div', { class: 'muted', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, it.summary || '')),
            dl
          )
        )
      }
      const from = state.offset + 1
      const to = state.offset + state.items.length
      pageInfo.textContent = `${from}-${to} / 共 ${state.total}`
    }

    ctx.body.appendChild(h('div', { class: 'row' }, h('div', { class: 'grow' }, searchInput), sourceSeg))
    ctx.body.appendChild(h('div', { class: 'row wrap' },
      versionWrap, loaderSel, sortSel,
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => { state.offset = 0; search() } }, '搜索'),
      h('span', { class: 'spacer' }), pageInfo))
    // 下载目录：直接在磁贴里设置/选择（同「服务端核心下载」的交互，下载时作为默认目录）
    const tileDirInput = h('input', { class: 'input mono grow', placeholder: '下载目录（留空用系统下载文件夹）', value: defaultDir })
    const persistDir = async () => {
      defaultDir = tileDirInput.value.trim()
      try { await api.put('/api/settings', { community: { downloadDir: defaultDir } }) } catch {}
    }
    tileDirInput.onchange = persistDir
    const browseBtn = h('button', { class: 'btn btn-sm', onclick: async () => {
      const p = await pickDir(tileDirInput.value || '')
      if (p) { tileDirInput.value = p; await persistDir() }
    } }, '浏览')
    ctx.body.appendChild(h('div', { class: 'row', style: { marginBottom: '6px' } },
      h('div', { class: 'grow' }, tileDirInput), browseBtn))
    ctx.body.appendChild(typeWrap)
    ctx.body.appendChild(resultsEl)
    ctx.body.appendChild(h('div', { class: 'row' },
      h('button', { class: 'btn btn-sm', disabled: state.offset === 0, onclick: () => { state.offset = Math.max(0, state.offset - state.limit); search() } }, '← 上一页'),
      h('button', { class: 'btn btn-sm', onclick: () => { state.offset += state.limit; search() } }, '下一页 →')))
    ctx.body.appendChild(h('div', { class: 'hr' }))
    ctx.body.appendChild(h('div', { class: 'row' }, h('span', { class: 'muted' }, '下载任务'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm', onclick: async () => {
        // 打开「当前选中的下载目录」（优先磁贴内输入/已存设置，其次系统下载夹）
        const picked = (tileDirInput && tileDirInput.value.trim()) || defaultDir || ''
        if (picked) {
          const r = await api.post('/api/fs/open', { path: picked })
          if (r.error) toast('无法打开下载目录（可能尚未创建）：' + r.error, 'err')
        } else {
          const roots = await api.get('/api/fs/roots')
          const home = (roots && roots.home) || ''
          if (home) await api.post('/api/fs/open', { path: home })
          else toast('请先在磁贴内设置下载目录', 'err')
        }
      } }, '📂 打开目录'),
      h('button', { class: 'btn btn-sm', onclick: async () => { await api.del('/api/community/jobs?scope=community') } }, '清空记录')))
    ctx.body.appendChild(jobsEl)

    renderTypes()
    startJobPoller(jobsEl)
    searchInput.onkeydown = (e) => { if (e.key === 'Enter') { state.offset = 0; search() } }
    // 不再自动搜索：留空状态等待用户输入关键词或点击「搜索」按钮
  },

  unmount() {
    if (poller) clearInterval(poller)
    poller = null
  },

  // 展开大屏：独立搜索 + 独立详情/下载面板（不与磁贴共享状态）
  renderExpanded(container, { ctx } = {}) {
    communityExpanded(container, ctx)
  }
}

// ---------------- 展开视图：大屏搜索/下载 ----------------
function communityExpanded(container, ctx) {
  const settings = (ctx && ctx.settings ? ctx.settings() : ctxRef?.settings()) || {}
  const s = settings

  const source = s.community?.defaultSource || 'modrinth'
  const qInput = h('input', { class: 'input', placeholder: '搜索 mod / 整合包 / 数据包 / 资源包 / 光影…' })
  const verInput = h('input', { class: 'input mono', style: { width: '110px' }, placeholder: '版本', value: s.community?.defaultGameVersion || '' })
  const loaderSel = h('select', { class: 'input' }, ...LOADERS.map(([v, l]) => h('option', { value: v }, l)))
  loaderSel.value = s.community?.defaultLoader || ''
  const sortSel = h('select', { class: 'input' }, ...SORTS.map(([v, l]) => h('option', { value: v }, l)))
  const pageInfo = h('span', { class: 'muted' }, '')
  const resultsEl = h('div', { class: 'scroll-y', style: { display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '52vh', flex: '1' } })
  const detailEl = h('div', { style: { width: '320px', flex: 'none', display: 'flex', flexDirection: 'column', gap: '10px' } })
  const hint = h('div', { class: 'muted center', style: { padding: '40px 0' } }, '在左侧搜索资源，点击结果在右侧查看版本并下载')
  detailEl.appendChild(hint)
  const wrap = h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '14px', marginTop: '10px' } },
    h('div', { style: { flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '6px' } }, resultsEl),
    detailEl)

  const local = { source, offset: 0, items: [], total: 0, busy: false, gameVersion: verInput.value.trim(), loader: loaderSel.value, type: '' }

  const srcSeg = h('div', { class: 'seg' }, ...[['modrinth', 'Modrinth'], ['curseforge', 'CurseForge']].map(([v, l]) =>
    h('button', { class: local.source === v ? 'active' : '', onclick: (e) => { local.source = v; Array.from(e.target.parentElement.children).forEach((c) => c.classList.remove('active')); e.target.classList.add('active'); local.offset = 0; search() } }, l)))
  sortSel.onchange = () => { local.offset = 0; search() }
  const btnSearch = h('button', { class: 'btn btn-primary', onclick: () => { local.offset = 0; search() } }, '搜索')
  qInput.onkeydown = (e) => { if (e.key === 'Enter') { local.offset = 0; search() } }

  // 资源类型筛选（mod / 整合包 / 数据包 / 资源包 / 光影）
  const typeWrap = h('div', { class: 'pill-list', style: { margin: '8px 0 2px' } })
  const renderTypes = () => {
    clear(typeWrap)
    for (const [v, label] of TYPES) {
      typeWrap.appendChild(h('button', {
        class: 'pill' + (local.type === v ? ' active' : ''),
        style: { cursor: 'pointer', borderColor: local.type === v ? 'var(--accent)' : '', color: local.type === v ? 'var(--accent)' : '' },
        onclick: () => { local.type = v; renderTypes(); local.offset = 0; search() }
      }, label))
    }
  }

  container.appendChild(h('div', { class: 'row wrap', style: { gap: '8px' } },
    h('div', { class: 'grow', style: { minWidth: '220px' } }, qInput), srcSeg, verInput, loaderSel, sortSel, btnSearch,
    h('span', { class: 'spacer' }), pageInfo))
  container.appendChild(typeWrap)
  renderTypes()
  container.appendChild(wrap)

  async function search() {
    if (local.busy) return
    local.busy = true
    const q = qInput.value.trim()
    local.gameVersion = verInput.value.trim()
    local.loader = loaderSel.value
    clear(resultsEl)
    resultsEl.appendChild(h('div', { class: 'muted center', style: { padding: '20px' } }, '搜索中…'))
    try {
      const p = new URLSearchParams({ source: local.source, query: q, limit: '24', offset: String(local.offset), sort: sortSel.value })
      if (local.gameVersion) p.set('gameVersion', local.gameVersion)
      if (local.loader) p.set('loader', local.loader)
      if (local.type) p.set('type', local.type)
      const data = await api.get('/api/community/search?' + p)
      local.items = data.items || []
      local.total = data.total || 0
      renderList()
    } catch (e) {
      clear(resultsEl)
      resultsEl.appendChild(h('div', { class: 'result-bad', style: { padding: '14px' } }, e.message))
    } finally {
      local.busy = false
    }
  }

  function renderList() {
    clear(resultsEl)
    if (!local.items.length) { resultsEl.appendChild(h('div', { class: 'muted center', style: { padding: '20px' } }, '没有结果')); return }
    pageInfo.textContent = `${local.offset + 1}-${local.offset + local.items.length} / ${local.total}`
    for (const it of local.items) {
      resultsEl.appendChild(h('div', { class: 'feature-item', style: { cursor: 'pointer', padding: '8px' }, onclick: () => showDetail(it) },
        it.icon ? h('img', { src: it.icon, style: { width: '34px', height: '34px', borderRadius: '6px', flex: 'none' }, alt: '' }) : h('div', { class: 'fi-icon', style: { width: '34px', height: '34px', background: 'var(--surface-3)' } }, '📦'),
        h('div', { class: 'fi-main' }, h('b', {}, it.title), h('span', {}, `${it.author || '未知作者'} · ↓${fmtCount(it.downloads)} · ${fmtAgo(Date.parse(it.updated || 0))}`), h('div', { class: 'muted', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, it.summary || ''))))
    }
  }

  function showDetail(it) {
    clear(detailEl)
    const verSel = h('select', { class: 'input' }, h('option', { value: '' }, '加载中…'))
    const fileSel = h('select', { class: 'input' })
    const dirInput = h('input', { class: 'input mono', value: defaultDir || '', readonly: '', title: '与磁贴内「下载目录」同步' })
    const btnDl = h('button', { class: 'btn btn-primary' }, '⬇ 下载到本地')
    const errEl = h('div', { class: 'result-bad', style: { display: 'none' } })
    let versions = []
    btnDl.onclick = async () => {
      errEl.style.display = 'none'
      const url = fileSel.value
      if (!url) { errEl.textContent = '请先选择版本/文件'; errEl.style.display = ''; return }
      const v = versions[Number(verSel.value) || 0] || {}
      const f = (v.files || []).find((x) => x.url === url) || {}
      try {
        await api.post('/api/community/download', {
          url, filename: f.name || 'download.jar', dir: dirInput.value, title: it.title,
          meta: { project: it.title || '', version: v.number || v.name || '', loader: (v.loaders || [])[0] || '', gameVersion: (v.gameVersions || [])[0] || '', type: it.type || '', source: it.source }
        })
        toast('已加入下载：' + it.title, 'ok')
      } catch (e) {
        errEl.textContent = '下载失败：' + e.message
        errEl.style.display = ''
      }
    }
    detailEl.appendChild(h('div', {}, it.icon ? h('img', { src: it.icon, style: { width: '48px', height: '48px', borderRadius: '8px' }, alt: '' }) : null,
      h('div', { style: { fontWeight: '600', fontSize: '14px' } }, it.title),
      h('div', { class: 'muted' }, `${it.author || '未知作者'} · ↓${fmtCount(it.downloads)}`)))
    detailEl.appendChild(h('div', { class: 'field' }, h('label', {}, '版本'), verSel, fileSel))
    detailEl.appendChild(h('div', { class: 'field' }, h('label', {}, '下载到（与磁贴内「下载目录」同步，可在磁贴修改）'), dirInput))
    detailEl.appendChild(btnDl)
    detailEl.appendChild(errEl)
    detailEl.appendChild(h('div', { class: 'muted', style: { fontSize: '11px' } }, '关闭本弹窗后，任务会显示在「社区资源下载」磁贴的下载任务区。'))

    api.get(`/api/community/versions?source=${it.source}&id=${encodeURIComponent(it.id)}&gameVersion=${encodeURIComponent(local.gameVersion)}&loader=${encodeURIComponent(local.loader)}`)
      .then((list) => {
        versions = list
        clear(verSel)
        if (!list.length) { verSel.appendChild(h('option', { value: '' }, '没有匹配的版本')); return }
        list.slice(0, 80).forEach((v, i) => verSel.appendChild(h('option', { value: String(i) }, `${v.name} · ${(v.loaders || []).join('/') || '—'} · ${(v.gameVersions || []).slice(-3).join(', ')}`)))
        const pickFiles = () => {
          const v = list[Number(verSel.value) || 0]
          clear(fileSel)
          for (const f of v.files || []) fileSel.appendChild(h('option', { value: f.url }, `${f.name}（${fmtBytes(f.size)}）`))
          if (!(v.files || []).length) fileSel.appendChild(h('option', { value: '' }, '该版本没有可下载文件'))
        }
        verSel.onchange = pickFiles
        pickFiles()
      })
      .catch(() => {
        clear(verSel)
        verSel.appendChild(h('option', { value: '' }, '版本加载失败'))
      })
  }
}

// ---------------- 下载任务 ----------------
let poller = null
function startJobPoller(jobsEl) {
  if (poller) clearInterval(poller)
  const render = async (silent) => {
    try {
      const data = await api.get('/api/community/jobs')
      renderJobsInto(jobsEl, data.items || [])
      // 有排队任务时，触发一次调度（后端 pump 在 GET 时也会重新计算）
      if (!silent) return
    } catch {}
  }
  render(true)
  poller = setInterval(() => render(false), 1200)
}

function fmtSpeed(bps) {
  if (!bps || bps <= 0) return ''
  if (bps >= 1024 * 1024) return (bps / 1024 / 1024).toFixed(1) + ' MB/s'
  if (bps >= 1024) return (bps / 1024).toFixed(1) + ' KB/s'
  return Math.round(bps) + ' B/s'
}

function renderJobsInto(el, items) {
  clear(el)
  // 社区资源磁贴只显示社区资源类下载；服务端核心下载有自己的磁贴
  items = items.filter((j) => j.meta?.type !== 'servercore')
  if (!items.length) {
    el.appendChild(h('div', { class: 'muted' }, '暂无下载任务'))
    return
  }
  for (const j of items.slice(0, 8)) {
    const pct = j.total ? Math.min(100, (j.received / j.total) * 100) : 0
    const statusMap = { done: 'ok', failed: 'bad', cancelled: '', queued: 'warn', running: 'warn', installing: 'warn' }
    el.appendChild(
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
        h('div', { class: 'row', style: { gap: '8px' } },
          h('span', { class: 'dot ' + (statusMap[j.status] || '') }),
          h('span', { class: 'mono', style: { fontSize: '11.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1' } }, j.filename),
          h('span', { class: 'muted nowrap', style: { fontSize: '11px' } },
            j.status === 'queued' ? '排队中'
              : j.status === 'done' ? fmtBytes(j.total || j.received)
              : j.status === 'failed' ? '失败'
              : j.status === 'cancelled' ? '已取消'
              : j.status === 'installing' ? '安装中…'
              : `${fmtBytes(j.received)}${j.total ? ' / ' + fmtBytes(j.total) : ''} · ${fmtSpeed(j.speed)}`),
          (j.status === 'running' || j.status === 'queued')
            ? h('button', { class: 'btn btn-sm', onclick: async () => { await api.post('/api/community/jobs/cancel', { id: j.id }) } }, '取消')
            : h('button', { class: 'btn btn-sm', onclick: async () => { await api.post('/api/fs/open', { path: j.dir }) } }, '打开')),
        j.dir ? h('div', { class: 'muted mono', style: { fontSize: '10.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: j.dir }, j.dir) : null,
        h('div', { class: 'row', style: { gap: '6px' } },
          h('div', { class: 'bar grow' }, h('i', { style: { width: pct + '%', background: j.status === 'failed' ? 'var(--danger)' : j.status === 'done' ? 'var(--ok)' : j.status === 'cancelled' ? 'var(--text-mute)' : '' } })),
          j.status === 'running' && j.threads > 1 ? h('span', { class: 'muted nowrap', style: { fontSize: '10px' } }, j.threads + ' 线程') : null),
        j.error ? h('div', { class: 'result-bad', style: { fontSize: '11px' } }, j.error) : null
      )
    )
  }
}

// ---------------- 详情 ----------------
async function openDetail(item) {
  const meta = h('div', { style: { display: 'flex', gap: '12px' } })
  const bodyText = h('div', { class: 'scroll-y mono', style: { fontSize: '12px', maxHeight: '220px', whiteSpace: 'pre-wrap', background: 'var(--surface-2)', padding: '10px', borderRadius: '8px' } }, '加载中…')
  const verSel = h('select', { class: 'input' }, h('option', { value: '' }, '加载中…'))
  const fileSel = h('select', { class: 'input' })
  const dirInput = h('input', { class: 'input mono', value: defaultDir, readonly: '', title: '在磁贴内「下载目录」处修改' })
  const links = h('div', { class: 'pill-list' })
  const dlBtn = h('button', { class: 'btn btn-primary', onclick: doDownload }, '⬇ 下载')

  let versions = []
  let projMeta = null

  async function doDownload() {
    const url = fileSel.value
    if (!url) {
      toast('请先选择版本', 'err')
      return
    }
    const v = versions[Number(verSel.value) || 0] || {}
    const f = (v.files || []).find((x) => x.url === url) || {}
    try {
      await api.post('/api/community/download', {
        url,
        filename: f.name || fileSel.selectedOptions?.[0]?.textContent || 'download.jar',
        dir: dirInput.value,
        title: item.title,
        meta: {
          project: item.title || '',
          version: v.number || v.name || '',
          loader: (v.loaders || [])[0] || '',
          gameVersion: (v.gameVersions || [])[0] || '',
          type: item.type || projMeta?.type || '',
          source: item.source
        }
      })
      toast('已加入下载：' + item.title, 'ok')
      modal.close()
    } catch (e) {
      toast('下载失败：' + e.message, 'err')
    }
  }

  const container = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
    meta,
    links,
    bodyText,
    h('div', { class: 'hr' }),
    h('div', { class: 'row wrap' }, h('div', { class: 'field grow' }, h('label', {}, '选择版本'), verSel, fileSel)),
    h('div', { class: 'field' }, h('label', {}, '下载到（默认目录在磁贴内「浏览」处设置；留空=系统下载文件夹）'), dirInput))

  const modal = openModal({
    title: item.title,
    size: 'lg',
    body: container,
    buttons: [
      { label: '关闭' },
      dlBtn
    ]
  })

  // 元信息
  meta.appendChild(item.icon ? h('img', { src: item.icon, style: { width: '64px', height: '64px', borderRadius: '10px', flex: 'none' }, alt: '' }) : h('div', {}))
  meta.appendChild(h('div', {},
    h('div', { style: { fontSize: '15px', fontWeight: '600' } }, item.title),
    h('div', { class: 'muted' }, `${item.author || '未知作者'} · ↓${fmtCount(item.downloads)} · ${fmtAgo(Date.parse(item.updated || 0))}`),
    h('div', { class: 'muted', style: { marginTop: '4px' } }, item.summary || '')))

  if (item.url) links.appendChild(h('button', { class: 'pill', style: { cursor: 'pointer' }, onclick: () => window.open(item.url, '_blank') }, '🔗 打开项目页'))

  // 详情 + 版本
  api.get(`/api/community/project?source=${item.source}&id=${encodeURIComponent(item.id)}`)
    .then((p) => {
      projMeta = p
      clear(bodyText)
      const text = (p.body || p.summary || '（该项目没有提供简介）').replace(/<[^>]+>/g, '')
      bodyText.textContent = text.slice(0, 4000)
      if (p.license) links.appendChild(h('span', { class: 'pill' }, '许可：' + p.license))
      for (const [k, v] of Object.entries(p.links || {})) {
        if (v) links.appendChild(h('button', { class: 'pill', style: { cursor: 'pointer' }, onclick: () => window.open(v, '_blank') }, k === 'site' ? '官网' : k === 'wiki' ? 'Wiki' : k === 'issues' ? '问题追踪' : k === 'discord' ? 'Discord' : k))
      }
    })
    .catch((e) => {
      bodyText.textContent = '详情加载失败：' + e.message
    })

  api.get(`/api/community/versions?source=${item.source}&id=${encodeURIComponent(item.id)}&gameVersion=${encodeURIComponent(state.gameVersion)}&loader=${encodeURIComponent(state.loader)}`)
    .then((list) => {
      versions = list
      clear(verSel)
      if (!list.length) {
        verSel.appendChild(h('option', { value: '' }, '没有匹配的版本'))
        return
      }
      list.slice(0, 60).forEach((v) => {
        verSel.appendChild(h('option', { value: String(list.indexOf(v)) }, `${v.name} · ${(v.loaders || []).join('/') || '—'} · ${(v.gameVersions || []).slice(-3).join(', ')}`))
      })
      const renderFiles = () => {
        const v = list[Number(verSel.value) || 0]
        clear(fileSel)
        for (const f of v.files || []) {
          fileSel.appendChild(h('option', { value: f.url }, `${f.name}（${fmtBytes(f.size)}）`))
        }
        if (!(v.files || []).length) fileSel.appendChild(h('option', { value: '' }, '该文件没有可下载地址'))
      }
      verSel.onchange = renderFiles
      renderFiles()
    })
    .catch((e) => {
      clear(verSel)
      verSel.appendChild(h('option', { value: '' }, '版本加载失败：' + e.message))
    })
}
