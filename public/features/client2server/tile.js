import { h, clear, fmtBytes } from '/js/core/dom.js'
import { api } from '/js/core/api.js'
import { openModal, confirmDialog } from '/js/core/modal.js'
import { toast } from '/js/core/toast.js'
import { pickDir, pickFile } from '/js/core/dirpicker.js'

let ctxRef = null
let dirInput = null
let summaryEl = null
let tableWrap = null
let state = { dir: '', items: [], library: [], selected: new Set(), mode: null, busy: false, showMatchedOnly: false }
let btnFilter = null

export default {
  renderExpanded(container, { ctx } = {}) {
    c2sExpanded(container, ctx)
  },
  async mount(ctx) {
    ctxRef = ctx
    const s = ctx.settings()
    state.dir = s.client2server.modsDir || ''
    state.mode = s.client2server.defaultAction || 'backup'

    dirInput = h('input', { class: 'input mono', placeholder: '选择或输入 mods 目录', value: state.dir })
    summaryEl = h('div', { class: 'muted' }, '尚未扫描。')
    tableWrap = h('div', { class: 'scroll-y', style: { maxHeight: '320px', border: '1px solid var(--line)', borderRadius: '8px' } })

    const modeSel = h('select', { class: 'input', style: { width: '150px' } },
      h('option', { value: 'backup' }, '移入备份目录'),
      h('option', { value: 'disable' }, '禁用（改后缀名）'),
      h('option', { value: 'enable' }, '启用（恢复 .jar）'),
      h('option', { value: 'delete' }, '直接删除'))
    modeSel.value = state.mode
    modeSel.onchange = () => { state.mode = modeSel.value }

    const btnScan = h('button', { class: 'btn btn-primary btn-sm', onclick: () => scan() }, '扫描')
    const btnExec = h('button', { class: 'btn btn-sm btn-danger', onclick: () => apply() }, '处理选中项')

    ctx.body.appendChild(h('div', { class: 'field' }, h('label', {}, 'mods 目录'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, dirInput),
        h('button', { class: 'btn btn-sm', onclick: async () => {
          const p = await pickDir(dirInput.value || '')
          if (p) {
            dirInput.value = p
            state.dir = p
            await api.put('/api/settings', { client2server: { modsDir: p } })
            ctx.settings().client2server.modsDir = p
            scan()
          }
        } }, '浏览'),
        btnScan)))
    btnFilter = h('button', {
      class: 'btn btn-sm' + (state.showMatchedOnly ? ' active' : ''),
      title: '只列出匹配到的仅客户端 mod',
      onclick: () => {
        state.showMatchedOnly = !state.showMatchedOnly
        btnFilter.classList.toggle('active', state.showMatchedOnly)
        render()
      }
    }, '👁 仅显示匹配项')

    ctx.body.appendChild(h('div', { class: 'row wrap' },
      h('button', { class: 'btn btn-sm', onclick: () => selectAll(true) }, '全选'),
      h('button', { class: 'btn btn-sm', onclick: () => selectAll(false) }, '取消选择'),
      h('button', { class: 'btn btn-sm', onclick: () => selectMatched() }, '仅选匹配项'),
      btnFilter,
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted' }, '处理方式'),
      modeSel,
      btnExec))
    ctx.body.appendChild(h('div', { class: 'row wrap' },
      h('button', { class: 'btn btn-sm', onclick: () => openLibrary() }, '📚 管理仅客户端 mod 库'),
      h('button', { class: 'btn btn-sm', onclick: () => openModsDir() }, '📂 打开库目录'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted', id: 'c2sCount' }, '')))

    // 绑定启动脚本：选择一个 .bat/.cmd/.sh（例如服务端核心生成的 start.bat），点「运行」拉起
    const scriptPath = (s.client2server && s.client2server.scriptPath) || ''
    const scriptInput = h('input', { class: 'input mono', readonly: true, placeholder: '未绑定启动脚本（可选：服务端核心下载生成的 start.bat）', value: scriptPath, title: scriptPath })
    const btnSel = h('button', { class: 'btn btn-sm', onclick: pickScript }, '选择')
    const btnRun = h('button', { class: 'btn btn-sm btn-primary', disabled: !scriptPath, onclick: runScript }, '▶ 运行')
    const btnClear = h('button', { class: 'btn btn-sm', onclick: clearScript }, '✕')
    ctx.body.appendChild(h('div', { class: 'row wrap', style: { gap: '6px', alignItems: 'center', margin: '2px 0 6px' } },
      h('span', { class: 'muted' }, '启动脚本：'), h('div', { class: 'grow', style: { minWidth: '180px' } }, scriptInput),
      btnSel, btnRun, btnClear))

    function setScript(p) {
      scriptInput.value = p || ''
      scriptInput.title = p || ''
      btnRun.disabled = !p
      try { if (ctx.settings().client2server) ctx.settings().client2server.scriptPath = p || '' } catch {}
      api.put('/api/settings', { client2server: { scriptPath: p || '' } }).catch(() => {})
    }
    async function pickScript() {
      const cur = scriptInput.value || ''
      const startDir = cur ? cur.replace(/[\\/][^\\/]*$/, '') : ''
      const p = await pickFile(startDir || '', { title: '选择要绑定的启动脚本' })
      if (p) { setScript(p); toast('已绑定：' + p, 'ok') }
    }
    async function runScript() {
      const p = scriptInput.value.trim()
      if (!p) { toast('请先选择启动脚本', 'err'); return }
      btnRun.disabled = true
      try {
        const r = await api.post('/api/scripts/run', { path: p })
        if (r.error) { toast(r.error, 'err'); return }
        toast('已在新窗口运行脚本', 'ok')
      } catch (e) { toast('运行失败：' + e.message, 'err') } finally { btnRun.disabled = false }
    }
    function clearScript() { setScript(''); toast('已解除绑定', 'ok') }

    ctx.body.appendChild(summaryEl)
    ctx.body.appendChild(tableWrap)

    await loadLibrary()
    if (state.dir) scan()
  }
}

// ---------------- 数据 ----------------
async function loadLibrary() {
  try {
    const data = await api.get('/api/mods/client-list')
    state.library = data.items
  } catch (e) {
    toast('读取 mod 库失败：' + e.message, 'err')
  }
}

function libMap() {
  const m = new Map()
  for (const it of state.library) m.set(String(it.modid).toLowerCase(), it)
  return m
}

function classify(mod) {
  if (!mod.modid) return null
  const hit = libMap().get(String(mod.modid).toLowerCase())
  if (hit) return { kind: 'lib', label: 'modid 库', note: hit.name || hit.modid }
  if (mod.environment === 'client' && ctxRef?.settings().client2server.autoDetectEnv !== false) {
    return { kind: 'auto', label: '自动识别', note: 'fabric/quilt 声明为 client' }
  }
  return null
}

// ---------------- 扫描 ----------------
async function scan() {
  if (state.busy) return
  const dir = dirInput.value.trim()
  if (!dir) {
    toast('请先选择 mods 目录', 'err')
    return
  }
  state.dir = dir
  state.busy = true
  clear(tableWrap)
  tableWrap.appendChild(h('div', { class: 'muted center', style: { padding: '20px' } }, '扫描中…'))
  try {
    const data = await api.post('/api/mods/scan', { dir })
    if (data.error) throw new Error(data.error)
    await loadLibrary()
    state.items = data.items
    state.selected = new Set(state.items.filter((m) => classify(m)).map((m) => m.path))
    render()
    toast(`扫描完成：${data.items.length} 个文件`, 'ok')
  } catch (e) {
    clear(tableWrap)
    tableWrap.appendChild(h('div', { class: 'result-bad', style: { padding: '12px' } }, '扫描失败：' + e.message))
  } finally {
    state.busy = false
  }
}

// 当前应显示的行（受「仅显示匹配项」过滤影响）
function visibleItems() {
  return state.showMatchedOnly ? state.items.filter((m) => classify(m)) : state.items
}

function render() {
  const matched = state.items.filter((m) => classify(m))
  const unknown = state.items.filter((m) => !m.modid)
  const visible = visibleItems()
  clear(summaryEl)
  const filterPart = state.showMatchedOnly ? ` · 当前显示 ${visible.length} 个` : ''
  summaryEl.textContent = `共 ${state.items.length} 个文件 · 识别为仅客户端 ${matched.length} 个 · 无法识别 modid ${unknown.length} 个 · 已选 ${state.selected.size} 个${filterPart}`
  ctxRef.setBadge(matched.length ? `${matched.length} 个待处理` : '', matched.length ? 'warn' : '')

  clear(tableWrap)
  if (!state.items.length) {
    tableWrap.appendChild(h('div', { class: 'muted center', style: { padding: '20px' } }, '该目录下没有 jar 文件'))
    return
  }
  if (!visible.length) {
    tableWrap.appendChild(h('div', { class: 'muted center', style: { padding: '20px' } },
      '没有匹配到的仅客户端 mod。', h('br'), '可点击「👁 仅显示匹配项」关闭过滤查看全部。'))
    return
  }
  const table = h('table', { class: 'tbl' })
  table.appendChild(h('thead', {}, h('tr', {},
    h('th', { style: { width: '32px' } }, ''),
    h('th', {}, '文件'),
    h('th', {}, 'modid'),
    h('th', {}, '名称 / 版本'),
    h('th', {}, '加载器'),
    h('th', { class: 'num' }, '大小'),
    h('th', {}, '匹配规则'))))
  const tbody = h('tbody')
  for (const m of visible) {
    const c = classify(m)
    const cb = h('input', {
      class: 'checkbox', type: 'checkbox', checked: state.selected.has(m.path),
      onchange: (e) => {
        if (e.target.checked) state.selected.add(m.path)
        else state.selected.delete(m.path)
        const cnt = document.getElementById('c2sCount')
        if (cnt) cnt.textContent = `已选 ${state.selected.size} 个`
      }
    })
    tbody.appendChild(h('tr', { class: c ? 'mod-row danger' : 'mod-row' },
      h('td', {}, cb),
      h('td', { class: 'mono', title: m.relPath }, m.file),
      h('td', { class: 'mono' }, m.modid || h('span', { class: 'muted' }, '(未知)')),
      h('td', {}, m.name || '-', m.version ? h('span', { class: 'muted' }, ' · ' + m.version) : null),
      h('td', {}, h('span', { class: 'pill' }, m.loader || '-')),
      h('td', { class: 'num' }, fmtBytes(m.size)),
      h('td', {}, c ? h('span', { class: 'badge ' + (c.kind === 'auto' ? 'info' : 'warn') }, c.label) : h('span', { class: 'muted' }, '-'))))
  }
  table.appendChild(tbody)
  tableWrap.appendChild(table)
  const cnt = document.getElementById('c2sCount')
  if (cnt) cnt.textContent = `已选 ${state.selected.size} 个`
}

function selectAll(v) {
  // 只作用于当前可见的行，与用户所见一致
  const visible = visibleItems()
  if (v) for (const m of visible) state.selected.add(m.path)
  else for (const m of visible) state.selected.delete(m.path)
  render()
}
function selectMatched() {
  state.selected = new Set(state.items.filter((m) => classify(m)).map((m) => m.path))
  render()
}

// ---------------- 执行处理 ----------------
async function apply() {
  const files = Array.from(state.selected)
  if (!files.length) {
    toast('没有选中任何文件', 'err')
    return
  }
  const names = files.map((f) => f.split(/[\\/]/).pop())
  const mode = state.mode
  const s = ctxRef.settings()
  const MODE_TEXT = {
    delete: { verb: '删除', tail: '<b class="result-bad">删除后无法恢复！</b>', ok: '确认删除' },
    disable: { verb: '禁用', tail: '文件会被改名为 <b class="mono">.jar.disabled</b>，Minecraft 将不再加载它；把后缀改回 <b class="mono">.jar</b> 即可恢复。', ok: '确认禁用' },
    backup: { verb: '移出', tail: '文件将被移动到备份目录，可在备份目录手动恢复。', ok: '确认处理' }
  }
  const mt = MODE_TEXT[mode] || MODE_TEXT.backup
  const ok = await ctxRef.confirm(
    `<div>即将${mt.verb} <b>${files.length}</b> 个文件：</div>
     <div class="mono" style="margin:8px 0;max-height:180px;overflow:auto">${names.map((n) => '· ' + n).join('<br>')}</div>
     <div>${mt.tail}</div>`
    , { danger: mode === 'delete', okText: mt.ok })
  if (!ok) return

  state.busy = true
  try {
    const r = await api.post('/api/mods/apply', { files, mode, dir: state.dir, backupDir: s.client2server.backupDir })
    if (r.error) throw new Error(r.error)
    const okCount = r.done?.length || 0
    const failCount = r.failed?.length || 0
    openModal({
      title: '处理完成',
      body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', {}, `成功 ${okCount} 个，失败 ${failCount} 个。`),
        r.backupDir ? h('div', { class: 'muted mono' }, '备份目录：' + r.backupDir) : null,
        failCount ? h('div', { class: 'result-bad mono', style: { fontSize: '12px' } }, r.failed.map((f) => `${f.file}：${f.error}`).join('\n')) : null),
      buttons: [{ label: '好的', class: 'btn-primary' }]
    })
    toast(`处理完成：成功 ${okCount} 个`, 'ok')
    await scan()
  } catch (e) {
    toast('处理失败：' + e.message, 'err')
  } finally {
    state.busy = false
  }
}

// ---------------- 仅客户端 mod 库管理 ----------------

async function openModsDir() {
  try {
    const r = await api.post('/api/system/open-path', { which: 'clientModsDir' })
    const p = (r && (r.file || r.target)) || ''
    toast(p ? `已打开：${p}` : '已打开库目录', 'ok')
  } catch (e) { toast(e.message || '打开失败', 'err') }
}

async function openLibrary() {
  await loadLibrary()
  const search = h('input', { class: 'input', placeholder: '搜索 modid 或名称' })
  const addModid = h('input', { class: 'input mono', placeholder: 'modid，例如 sodium' })
  const addName = h('input', { class: 'input', placeholder: '显示名称（可选）' })
  const addNote = h('input', { class: 'input', placeholder: '备注（可选）' })
  const tableWrap2 = h('div', { class: 'scroll-y', style: { maxHeight: '380px', border: '1px solid var(--line)', borderRadius: '8px' } })
  const countEl = h('span', { class: 'muted' }, '')

  // 拉取系统信息，显示库文件真实路径
  let clientModsDir = ''
  try { const info = await api.get('/api/system/info'); clientModsDir = info.clientModsDir || '' } catch {}
  const clientModsFile = clientModsDir ? clientModsDir.replace(/[\\/]+$/, '') + (window.navigator.platform.toLowerCase().includes('win') ? '\\' : '/') + 'clientmods.json' : ''

  const pathBox = h('div', { class: 'mono muted', style: { fontSize: '12px', padding: '6px 8px', background: 'var(--bg-2, transparent)', borderRadius: '6px', wordBreak: 'break-all' } },
    h('span', {}, '💡 库文件位置：'),
    clientModsFile
      ? h('span', { style: { userSelect: 'text' } }, clientModsFile)
      : h('span', {}, '（未获取到）'),
    h('span', { style: { marginLeft: '6px' } }),
    h('button', { class: 'btn btn-xs', style: { marginLeft: '8px', padding: '2px 8px' }, onclick: () => openModsDir() }, '📂 打开此目录')
  )

  function renderTable() {
    const q = search.value.trim().toLowerCase()
    const rows = state.library.filter((x) => !q || x.modid.toLowerCase().includes(q) || (x.name || '').toLowerCase().includes(q))
    clear(tableWrap2)
    const table = h('table', { class: 'tbl' }, h('thead', {}, h('tr', {},
      h('th', {}, 'modid'), h('th', {}, '名称'), h('th', {}, '备注'), h('th', {}, '来源'), h('th', { style: { width: '60px' } }, '操作'))))
    const tbody = h('tbody')
    for (const it of rows.slice(0, 400)) {
      tbody.appendChild(h('tr', {},
        h('td', { class: 'mono' }, it.modid),
        h('td', {}, it.name || '-'),
        h('td', { class: 'muted' }, it.note || '-'),
        h('td', {}, h('span', { class: 'pill' }, it.source === 'builtin' ? '内置' : '自定义')),
        h('td', {}, h('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
          if (ctxRef.settings().general.confirmDanger !== false && !(await confirmDialog(`确定删除记录「${it.modid}」？`, { danger: true }))) return
          await api.del('/api/mods/client-list/' + it.id)
          toast('已删除', 'ok')
          await loadLibrary()
          renderTable()
        } }, '删除'))))
    }
    table.appendChild(tbody)
    tableWrap2.appendChild(table)
    countEl.textContent = `共 ${state.library.length} 条 · 当前显示 ${rows.length} 条`
  }

  async function add() {
    const modid = addModid.value.trim()
    if (!modid) {
      toast('请填写 modid', 'err')
      return
    }
    try {
      const r = await api.post('/api/mods/client-list', { modid, name: addName.value.trim(), note: addNote.value.trim() })
      if (r.error) {
        toast(r.error, 'err')
        return
      }
      addModid.value = ''
      addName.value = ''
      addNote.value = ''
      await loadLibrary()
      renderTable()
      toast('已添加：' + modid, 'ok')
    } catch (e) {
      toast('添加失败：' + e.message, 'err')
    }
  }

  search.oninput = renderTable

  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    pathBox,
    h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, search), countEl),
    h('div', { class: 'section', style: { padding: '10px' } },
      h('div', { class: 'muted', style: { marginBottom: '6px' } }, '新增记录：按 modid 精确匹配（忽略大小写）'),
      h('div', { class: 'row wrap' }, h('div', { class: 'grow', style: { minWidth: '150px' } }, addModid),
        h('div', { class: 'grow', style: { minWidth: '140px' } }, addName),
        h('div', { class: 'grow', style: { minWidth: '140px' } }, addNote),
        h('button', { class: 'btn btn-primary btn-sm', onclick: add }, '＋ 添加'))),
    tableWrap2)

  const modal = openModal({
    title: '仅客户端 mod 库',
    size: 'lg',
    body,
    buttons: [{ label: '重新扫描目录', onClick: () => { modal.close(); scan() } }, { label: '关闭', class: 'btn-primary' }]
  })
  renderTable()
}

// ---------------- 展开视图：大屏「仅客户端 mod 库」管理 ----------------
function c2sExpanded(container, ctx) {
  const settings = (ctx && ctx.settings ? ctx.settings() : ctxRef?.settings()) || {}
  container.appendChild(h('div', { class: 'row' },
    h('b', { style: { fontSize: '14px' } }, '仅客户端 mod 库'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn btn-sm', onclick: async () => { try { await api.post('/api/system/open-path', { which: 'clientModsDir' }) } catch (e) { toast(e.message || '打开失败', 'err') } } }, '📂 打开库目录')))

  const search = h('input', { class: 'input', placeholder: '搜索 modid 或名称' })
  const addModid = h('input', { class: 'input mono', placeholder: 'modid，例如 sodium' })
  const addName = h('input', { class: 'input', placeholder: '显示名称（可选）' })
  const addNote = h('input', { class: 'input', placeholder: '备注（可选）' })
  const countEl = h('span', { class: 'muted' }, '')
  const tableWrap = h('div', { class: 'scroll-y', style: { maxHeight: '54vh', border: '1px solid var(--line)', borderRadius: '8px' } })
  let items = []

  const btnAdd = h('button', { class: 'btn btn-primary btn-sm' }, '＋ 添加')
  btnAdd.onclick = async () => {
    const modid = addModid.value.trim()
    if (!modid) { toast('请输入 modid', 'err'); return }
    try {
      const r = await api.post('/api/mods/client-list', { modid, name: addName.value.trim(), note: addNote.value.trim() })
      if (r.error) { toast(r.error, 'err'); return }
      addModid.value = ''; addName.value = ''; addNote.value = ''
      await load()
    } catch (e) { toast('添加失败：' + e.message, 'err') }
  }
  addModid.onkeydown = (e) => { if (e.key === 'Enter') btnAdd.click() }
  search.oninput = () => render()

  container.appendChild(h('div', { class: 'row wrap', style: { margin: '10px 0 8px' } },
    h('div', { class: 'grow', style: { minWidth: '150px' } }, search), countEl))
  container.appendChild(h('div', { class: 'section', style: { padding: '10px' } },
    h('div', { class: 'muted', style: { marginBottom: '6px', fontSize: '12px' } }, '新增记录：按 modid 精确匹配（忽略大小写），库文件可直接编辑 / 分享'),
    h('div', { class: 'row wrap' },
      h('div', { class: 'grow', style: { minWidth: '150px' } }, addModid),
      h('div', { class: 'grow', style: { minWidth: '140px' } }, addName),
      h('div', { class: 'grow', style: { minWidth: '140px' } }, addNote),
      btnAdd)))
  container.appendChild(tableWrap)

  async function load() {
    try {
      const data = await api.get('/api/mods/client-list')
      items = data.items || []
      render()
    } catch (e) { toast('加载库失败：' + e.message, 'err') }
  }

  function render() {
    clear(tableWrap)
    const q = search.value.trim().toLowerCase()
    const list = q ? items.filter((it) => (it.modid + ' ' + (it.name || '')).toLowerCase().includes(q)) : items
    countEl.textContent = list.length + ' / ' + items.length + ' 条'
    if (!list.length) { tableWrap.appendChild(h('div', { class: 'muted center', style: { padding: '30px 0' } }, '（空）')); return }
    for (const it of list) {
      const name = h('input', { class: 'input', value: it.name || '', style: { width: '150px' } })
      const note = h('input', { class: 'input', value: it.note || '', style: { minWidth: '170px', flex: '1' } })
      const btnSave = h('button', { class: 'btn btn-sm btn-primary', style: { display: 'none' }, onclick: async () => {
        try {
          await api.put('/api/mods/client-list/' + it.id, { name: name.value.trim(), note: note.value.trim() })
          await load()
        } catch (e) { toast('保存失败：' + e.message, 'err') }
      } }, '保存')
      const btnEdit = h('button', { class: 'btn btn-sm', onclick: () => { btnEdit.style.display = 'none'; btnSave.style.display = '' } }, '编辑')
      const btnDel = h('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
        if (!(await confirmDialog('删除「' + (it.name || it.modid) + '」？仅从库中移除，不影响本地文件。', { danger: true }))) return
        try {
          await api.del('/api/mods/client-list/' + it.id)
          await load()
        } catch (e) { toast('删除失败：' + e.message, 'err') }
      } }, '删除')
      tableWrap.appendChild(h('div', { class: 'feature-item', style: { padding: '7px 9px' } },
        h('div', { class: 'fi-main' },
          h('div', { class: 'row' }, h('b', { class: 'mono', style: { fontSize: '12px' } }, it.modid),
            h('span', { class: 'badge' }, it.source === 'builtin' ? '内置' : '自定义')),
          h('div', { class: 'row wrap', style: { marginTop: '4px', gap: '6px' } },
            h('label', { class: 'muted', style: { fontSize: '11px' } }, '名称'), name,
            h('label', { class: 'muted', style: { fontSize: '11px' } }, '备注'), note)),
        h('div', { class: 'row', style: { gap: '6px' } }, btnEdit, btnSave, btnDel)))
    }
  }

  load()
}
