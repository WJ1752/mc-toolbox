import { javaDownloadButton } from '/js/core/java-download.js'
import { h, clear, fmtBytes } from '/js/core/dom.js'
import { api } from '/js/core/api.js'
import { openModal, confirmDialog } from '/js/core/modal.js'
import { toast } from '/js/core/toast.js'
import { pickDir, pickFile } from '/js/core/dirpicker.js'
import { readPackMetadata } from '/js/core/pack-preview.js'
import { icon } from '/js/ui/icons.js'
import {
  btn, iconBtn, input, select, field, seg, progress,
  emptyState, errorState, spinner, badge, openPath
} from '/js/ui/kit.js'

const ACTIONS = [
  ['backup', '移入备份目录'],
  ['disable', '禁用（改后缀名）'],
  ['enable', '启用（恢复 .jar）'],
  ['delete', '直接删除']
]

const LOADERS = [
  ['', '请选择加载器'],
  ['vanilla', '原版 Vanilla'],
  ['fabric', 'Fabric'],
  ['forge', 'Forge'],
  ['cleanroom', 'Cleanroom（1.12.2）'],
  ['neoforge', 'NeoForge'],
  ['quilt', 'Quilt'],
  ['paper', 'Paper']
]

const LOADER_LABELS = { recommended: '推荐', latest: '最新' }

// 设置 → 服务端核心 → 分配内存（如 "2G" / "4096M"）是转换出的服务端启动脚本的
// 默认上限；转换面板把同一个数值作为初值，避免设置里填了却完全不生效。
function memoryGbFromSettings(ctx) {
  const raw = String(ctx?.settings?.()?.servercore?.memory || '').trim()
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n) || n <= 0) return 4
  const gb = /m/i.test(raw) ? n / 1024 : n
  return Math.min(256, Math.max(1, Math.round(gb) || 4))
}

// enable 没有独立文案：沿用旧实现的 backup 兜底文案，保持确认内容一致。
const APPLY_MODES = {
  delete: { verb: '删除', tail: '<b class="result-bad">删除后无法恢复！</b>', ok: '确认删除' },
  disable: { verb: '禁用', tail: '文件会被改名为 <b class="mono">.jar.disabled</b>，Minecraft 将不再加载它；把后缀改回 <b class="mono">.jar</b> 即可恢复。', ok: '确认禁用' },
  backup: { verb: '移出', tail: '文件将被移动到备份目录，可在备份目录手动恢复。', ok: '确认处理' }
}

const instances = new Set()

export default {
  async mount(ctx) {
    if (!ctx) return
    const inst = createInstance(ctx.body, ctx, { expanded: false })
    await inst.ready()
  },

  renderExpanded(container, { ctx } = {}) {
    if (!ctx) return
    const inst = createInstance(container, ctx, { expanded: true })
    inst.ready()
  },

  unmount() {
    for (const inst of Array.from(instances)) inst.dispose()
  }
}

/* ------------------------------------------------------------------ */
/* instance                                                           */
/* ------------------------------------------------------------------ */

function createInstance(container, ctx, { expanded = false } = {}) {
  const cfg = ctx.settings().client2server || {}
  const view = {
    expanded,
    dir: cfg.modsDir || '',
    items: [],
    library: [],
    selected: new Set(),
    action: cfg.defaultAction || 'backup',
    scanned: false,
    scanning: false,
    busy: false,
    applying: false,
    showMatchedOnly: false,
    tab: 'clean'
  }
  const uid = 'c2s-' + Math.random().toString(36).slice(2, 8)
  const inst = { uid, ctx, view, expanded, disposed: false }
  const disposers = []
  const pending = new Set()
  let rootEl = null

  inst.dispose = dispose
  inst.loadLibrary = loadLibrary
  inst.openLibrary = openLibraryModal
  inst.sleep = sleep

  const clean = buildCleanPanel(inst)
  inst.refreshClean = clean.refresh
  const convert = buildConvertPanel(inst)

  const modeHint = h('span', { class: 'fx-note' }, '')
  const modeSeg = seg(
    [['clean', '清理客户端 mod'], ['convert', '整合包转服务端']],
    view.tab,
    (v) => setTab(v)
  )
  const modeBar = h('div', { class: 'c2s-modebar' }, modeSeg, expanded ? modeHint : null)

  rootEl = h('div', { class: 'col', style: { gap: expanded ? '12px' : '10px' } }, modeBar, clean.el, convert.el)
  container.appendChild(rootEl)
  setTab('clean')

  if (expanded) {
    // 展开视图关闭 = 容器脱离文档：停止仍在等待的轮询 / 清理观察器。
    const obs = new MutationObserver(() => {
      if (!rootEl.isConnected) {
        obs.disconnect()
        dispose()
      }
    })
    obs.observe(document.body, { childList: true, subtree: true })
    disposers.push(() => obs.disconnect())
  }

  instances.add(inst)
  inst.ready = ready
  return inst

  function setTab(tab) {
    view.tab = tab === 'convert' ? 'convert' : 'clean'
    clean.el.hidden = view.tab !== 'clean'
    convert.el.hidden = view.tab !== 'convert'
    modeSeg.setValue(view.tab)
    if (modeHint) {
      modeHint.textContent = view.tab === 'clean'
        ? '扫描 mods 目录，按 modid 库或加载器元数据识别仅客户端 mod。'
        : '读取整合包清单，保留原包并生成新的服务端 ZIP。'
    }
    if (view.tab === 'clean') clean.refresh()
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const entry = { timer: 0, resolve }
      entry.timer = setTimeout(() => {
        pending.delete(entry)
        resolve()
      }, ms)
      pending.add(entry)
    })
  }

  function dispose() {
    if (inst.disposed) return
    inst.disposed = true
    for (const entry of pending) {
      clearTimeout(entry.timer)
      try { entry.resolve() } catch { /* noop */ }
    }
    pending.clear()
    for (const fn of disposers.splice(0)) {
      try { fn() } catch (e) { console.warn('[client2server] cleanup', e) }
    }
    instances.delete(inst)
    if (rootEl) rootEl.remove()
  }

  async function loadLibrary() {
    try {
      const data = await api.get('/api/mods/client-list')
      view.library = data.items || []
    } catch (e) {
      if (!inst.disposed) toast('读取 mod 库失败：' + e.message, 'err')
    }
  }

  function openLibraryModal() {
    const panel = createLibraryPanel(inst, { modal: true })
    const modal = openModal({
      title: '仅客户端 mod 库',
      size: 'lg',
      body: panel.el,
      buttons: [
        { label: '重新扫描目录', onClick: () => { modal.close(); clean.scan() } },
        { label: '关闭', class: 'btn-primary' }
      ]
    })
    panel.init()
  }

  async function ready() {
    if (expanded) {
      await clean.init()
      return
    }
    await loadLibrary()
    if (view.dir && !view.scanned && !inst.disposed) clean.scan()
  }
}

/* ------------------------------------------------------------------ */
/* cleaning mode                                                      */
/* ------------------------------------------------------------------ */

function buildCleanPanel(inst) {
  const { view, ctx, expanded, uid } = inst
  const autoDetectOn = () => ctx.settings().client2server?.autoDetectEnv !== false
  const panel = h('div', { class: 'col', style: { gap: '8px' } })

  const stepEls = ['目录', '扫描', '表格', '处理'].map((label, i) => h('div', { class: 'c2s-step' },
    h('span', { class: 'n' }, String(i + 1)),
    h('span', { class: 't' }, label)))
  const stepsEl = h('div', { class: 'c2s-steps', 'aria-label': '清理流程' }, ...stepEls)

  const dirInput = input({ value: view.dir, placeholder: '选择或输入 mods 目录', mono: true, id: uid + '-mods-dir' })
  dirInput.addEventListener('input', () => { view.dir = dirInput.value.trim(); updateSteps() })
  const browseBtn = btn('浏览', { size: 'sm', iconName: 'folder', onClick: browse })
  const scanBtn = btn('扫描', { variant: 'primary', size: 'sm', iconName: 'search', onClick: () => scan() })
  const dirField = h('div', { class: 'field' },
    h('label', { for: dirInput.id }, 'mods 目录'),
    h('div', { class: 'row wrap' },
      h('div', { class: 'grow', style: { minWidth: '150px' } }, dirInput),
      browseBtn, scanBtn))

  const summaryEl = h('div', { class: 'c2s-summary' }, '尚未扫描。')
  const tableWrap = h('div', { class: 'c2s-tablewrap', style: { maxHeight: expanded ? '46vh' : '300px' } })
  tableWrap.appendChild(h('div', {
    class: 'muted center',
    style: { padding: '18px 12px', fontSize: '11px', lineHeight: '1.6' }
  }, '选择 mods 目录后点击「扫描」；识别为仅客户端的 mod 会自动勾选。'))

  const selectAllBtn = btn('全选', { size: 'sm', onClick: () => selectAll(true) })
  const selectNoneBtn = btn('取消选择', { size: 'sm', onClick: () => selectAll(false) })
  const selectMatchedBtn = btn('仅选匹配项', { size: 'sm', onClick: selectMatched })
  const filterBtn = btn('仅显示匹配项', { size: 'sm', iconName: 'filter', onClick: toggleFilter })
  filterBtn.title = '只列出匹配到的仅客户端 mod'
  filterBtn.classList.toggle('active', view.showMatchedOnly)
  filterBtn.setAttribute('aria-pressed', String(view.showMatchedOnly))

  const actionSel = select(ACTIONS, view.action, {
    ariaLabel: '处理方式',
    onchange: (v) => { view.action = v }
  })
  actionSel.style.width = '150px'

  const applyBtn = btn('处理选中项', { variant: 'danger', size: 'sm', iconName: 'wand', onClick: apply })

  const toolbar = h('div', { class: 'c2s-actions' },
    selectAllBtn, selectNoneBtn, selectMatchedBtn, filterBtn,
    h('span', { class: 'spacer' }),
    h('span', { class: 'muted', style: { fontSize: '10.5px' } }, '处理方式'),
    actionSel, applyBtn)

  // 启动脚本绑定
  const scriptPath = (ctx.settings().client2server?.scriptPath) || ''
  const scriptInput = input({
    value: scriptPath,
    readonly: true,
    mono: true,
    placeholder: '未绑定启动脚本（可选：服务端核心下载生成的 start.bat）'
  })
  scriptInput.title = scriptPath
  const runBtn = btn('运行', { variant: 'primary', size: 'sm', iconName: 'play', disabled: !scriptPath, onClick: runScript })
  const scriptRow = h('div', { class: 'row wrap', style: { gap: '6px' } },
    h('span', { class: 'muted' }, '启动脚本：'),
    h('div', { class: 'grow', style: { minWidth: '170px' } }, scriptInput),
    btn('选择', { size: 'sm', iconName: 'file', onClick: pickScript }),
    runBtn,
    iconBtn('close', { size: 12, label: '清除启动脚本绑定', onClick: clearScript }))
  const scriptBox = h('details', { class: 'acc' },
    h('summary', {}, '启动脚本（可选）'),
    h('div', { class: 'acc-body' },
      scriptRow,
      h('div', { class: 'fx-note' }, '绑定 .bat / .cmd / .sh 后可直接在新窗口拉起服务端；绑定会写入工具箱设置。')))

  const libButtons = h('div', { class: 'row wrap', style: { gap: '6px', alignItems: 'center' } },
    btn('管理仅客户端 mod 库', { size: 'sm', iconName: 'list', onClick: () => inst.openLibrary() }),
    btn('打开库目录', { size: 'sm', iconName: 'folder-open', onClick: openModsDir }),
    h('span', { class: 'spacer' }),
    h('span', { class: 'muted', style: { fontSize: '10.5px' } }, '库文件按 modid 精确匹配（忽略大小写）'))

  const libPanel = expanded ? createLibraryPanel(inst, { modal: false }) : null

  if (expanded) {
    panel.append(
      stepsEl,
      h('div', { class: 'section' }, dirField),
      h('div', { class: 'section' },
        toolbar,
        h('div', { style: { margin: '8px 0 6px' } }, summaryEl),
        tableWrap),
      h('div', { class: 'section' }, scriptBox),
      h('div', { class: 'section' },
        h('div', { class: 'fx-head' },
          h('b', {}, '仅客户端 mod 库'),
          h('span', { class: 'spacer' }),
          btn('打开库目录', { size: 'sm', iconName: 'folder-open', onClick: openModsDir })),
        h('div', { style: { marginTop: '6px' } }, libPanel.el))
    )
  } else {
    panel.append(stepsEl, dirField, toolbar, summaryEl, tableWrap, scriptBox, libButtons)
  }

  updateSteps()
  updateControls()

  return {
    el: panel,
    scan,
    refresh: () => { if (view.scanned) renderClean() },
    init: async () => { if (libPanel) await libPanel.init() }
  }

  function updateSteps() {
    let active = 0
    if (view.scanning) active = 1
    else if (view.busy) active = 3
    else if (view.scanned) active = view.selected.size ? 3 : 2
    else if (view.dir) active = 1
    stepEls.forEach((el, i) => {
      el.classList.toggle('active', i === active)
      el.classList.toggle('done', i < active)
    })
  }

  function updateControls() {
    const locked = view.busy
    browseBtn.disabled = locked
    scanBtn.disabled = locked
    for (const b of [selectAllBtn, selectNoneBtn, selectMatchedBtn, filterBtn]) b.disabled = locked
    actionSel.disabled = locked
    applyBtn.disabled = locked
  }

  function counts() {
    const idx = libIndex(view.library)
    const auto = autoDetectOn()
    const matched = view.items.filter((m) => classifyMod(m, idx, auto))
    return { idx, auto, matched, unknown: view.items.filter((m) => !m.modid) }
  }

  function updateSummary() {
    const { matched, unknown } = counts()
    const visible = view.showMatchedOnly ? matched : view.items
    const filterPart = view.showMatchedOnly ? ` · 当前显示 ${visible.length} 个` : ''
    summaryEl.textContent = `共 ${view.items.length} 个文件 · 识别为仅客户端 ${matched.length} 个 · 无法识别 modid ${unknown.length} 个 · 已选 ${view.selected.size} 个${filterPart}`
    ctx.setBadge(matched.length ? `${matched.length} 个待处理` : '', matched.length ? 'warn' : '')
  }

  function renderClean() {
    const { idx, auto, matched } = counts()
    const visible = view.showMatchedOnly ? matched : view.items
    updateSummary()
    renderTable(visible, idx, auto)
    updateSteps()
    updateControls()
  }

  function renderTable(visible, idx, auto) {
    clear(tableWrap)
    if (!view.items.length) {
      tableWrap.appendChild(emptyState(
        '该目录下没有 jar 文件',
        '更换 mods 目录，或确认该目录确实包含 .jar / .jar.disabled 文件。',
        null,
        { iconName: 'archive' }
      ))
      return
    }
    if (!visible.length) {
      tableWrap.appendChild(emptyState(
        '没有匹配到的仅客户端 mod。',
        '可点击「仅显示匹配项」关闭过滤查看全部。',
        null,
        { iconName: 'filter' }
      ))
      return
    }
    const table = h('table', { class: 'tbl c2s-table', 'aria-label': '扫描到的 mod 文件' })
    table.appendChild(h('thead', {}, h('tr', {},
      h('th', { style: { width: '30px' } }, ''),
      h('th', {}, '文件'),
      h('th', {}, 'modid'),
      h('th', {}, '名称 / 版本'),
      h('th', {}, '加载器'),
      h('th', { class: 'num' }, '大小'),
      h('th', {}, '匹配规则'))))
    const tbody = h('tbody')
    for (const m of visible) {
      const c = classifyMod(m, idx, auto)
      const cb = h('input', {
        class: 'checkbox',
        type: 'checkbox',
        checked: view.selected.has(m.path),
        'aria-label': `选择 ${m.file}`
      })
      cb.addEventListener('change', () => {
        if (cb.checked) view.selected.add(m.path)
        else view.selected.delete(m.path)
        updateSummary()
        updateSteps()
      })
      tbody.appendChild(h('tr', { class: c ? (c.kind === 'auto' ? 'is-client' : 'is-match') : '' },
        h('td', {}, cb),
        h('td', { class: 'mono truncate', title: m.relPath || m.file }, m.file),
        h('td', { class: 'mono' }, m.modid || h('span', { class: 'muted' }, '(未知)')),
        h('td', {}, m.name || '-', m.version ? h('span', { class: 'muted' }, ' · ' + m.version) : null),
        h('td', {}, h('span', { class: 'pill' }, m.loader || '-')),
        h('td', { class: 'num' }, fmtBytes(m.size)),
        h('td', {}, c
          ? h('span', { class: 'badge ' + (c.kind === 'auto' ? 'info' : 'warn'), title: c.note || '' }, c.label)
          : h('span', { class: 'muted' }, '-'))))
    }
    table.appendChild(tbody)
    tableWrap.appendChild(table)
  }

  async function scan(force) {
    if (view.busy && !force) return
    const dir = dirInput.value.trim()
    if (!dir) {
      toast('请先选择 mods 目录', 'err')
      dirInput.focus()
      return
    }
    view.dir = dir
    view.busy = true
    view.scanning = true
    clear(tableWrap)
    tableWrap.appendChild(h('div', {
      class: 'row',
      style: { gap: '8px', color: 'var(--mute)', padding: '16px', justifyContent: 'center' }
    }, spinner(13), '扫描中…'))
    updateSteps()
    updateControls()
    try {
      const data = await api.post('/api/mods/scan', { dir })
      if (inst.disposed) return
      if (data.error) throw new Error(data.error)
      await inst.loadLibrary()
      if (inst.disposed) return
      view.items = data.items || []
      const idx = libIndex(view.library)
      const auto = autoDetectOn()
      view.selected = new Set(view.items.filter((m) => classifyMod(m, idx, auto)).map((m) => m.path))
      view.scanned = true
      renderClean()
      toast(`扫描完成：${view.items.length} 个文件`, 'ok')
    } catch (e) {
      if (inst.disposed) return
      clear(tableWrap)
      tableWrap.appendChild(errorState('扫描失败', e.message, btn('重试', {
        size: 'sm',
        iconName: 'refresh',
        onClick: () => scan()
      })))
    } finally {
      view.busy = false
      view.scanning = false
      if (!inst.disposed) {
        updateSteps()
        updateControls()
      }
    }
  }

  async function browse() {
    if (view.busy) return
    const p = await pickDir(dirInput.value || '', { title: '选择 mods 目录' })
    if (!p) return
    dirInput.value = p
    view.dir = p
    try {
      await api.put('/api/settings', { client2server: { modsDir: p } })
      const s = ctx.settings()
      if (s.client2server) s.client2server.modsDir = p
    } catch (e) {
      toast('保存 mods 目录失败：' + e.message, 'err')
    }
    scan()
  }

  function selectAll(value) {
    // 只作用于当前可见的行，与用户所见一致
    const { idx, auto, matched } = counts()
    const visible = view.showMatchedOnly ? matched : view.items
    for (const m of visible) {
      if (value) view.selected.add(m.path)
      else view.selected.delete(m.path)
    }
    renderClean()
  }

  function selectMatched() {
    const { idx, auto } = counts()
    view.selected = new Set(view.items.filter((m) => classifyMod(m, idx, auto)).map((m) => m.path))
    renderClean()
  }

  function toggleFilter() {
    view.showMatchedOnly = !view.showMatchedOnly
    filterBtn.classList.toggle('active', view.showMatchedOnly)
    filterBtn.setAttribute('aria-pressed', String(view.showMatchedOnly))
    renderClean()
  }

  async function apply() {
    const files = Array.from(view.selected)
    if (!files.length) {
      toast('没有选中任何文件', 'err')
      return
    }
    const names = files.map((f) => f.split(/[\\/]/).pop())
    const mode = view.action
    const s = ctx.settings()
    const mt = APPLY_MODES[mode] || APPLY_MODES.backup
    const ok = await ctx.confirm(
      `<div>即将${mt.verb} <b>${files.length}</b> 个文件：</div>` +
      `<div class="mono" style="margin:8px 0;max-height:180px;overflow:auto">${names.map((n) => '· ' + n).join('<br>')}</div>` +
      `<div>${mt.tail}</div>`,
      { danger: mode === 'delete', okText: mt.ok }
    )
    if (!ok || inst.disposed) return

    view.busy = true
    view.applying = true
    updateControls()
    updateSteps()
    try {
      const r = await api.post('/api/mods/apply', {
        files,
        mode,
        dir: view.dir,
        backupDir: s.client2server.backupDir
      })
      if (inst.disposed) return
      if (r.error) throw new Error(r.error)
      const okCount = r.done?.length || 0
      const failCount = r.failed?.length || 0
      openModal({
        title: '处理完成',
        body: h('div', { class: 'col', style: { gap: '8px' } },
          h('div', {}, `成功 ${okCount} 个，失败 ${failCount} 个。`),
          r.backupDir ? h('div', { class: 'muted mono' }, '备份目录：' + r.backupDir) : null,
          failCount
            ? h('div', {
              class: 'result-bad mono',
              style: { fontSize: '12px', whiteSpace: 'pre-wrap' }
            }, r.failed.map((f) => `${f.file}：${f.error}`).join('\n'))
            : null),
        buttons: [{ label: '好的', class: 'btn-primary' }]
      })
      toast(`处理完成：成功 ${okCount} 个`, 'ok')
      view.busy = false
      updateControls()
      await scan()
    } catch (e) {
      if (!inst.disposed) toast('处理失败：' + e.message, 'err')
    } finally {
      view.busy = false
      view.applying = false
      if (!inst.disposed) {
        updateControls()
        updateSteps()
      }
    }
  }

  function setScript(p) {
    scriptInput.value = p || ''
    scriptInput.title = p || ''
    runBtn.disabled = !p
    try {
      if (ctx.settings().client2server) ctx.settings().client2server.scriptPath = p || ''
    } catch { /* noop */ }
    api.put('/api/settings', { client2server: { scriptPath: p || '' } }).catch(() => {})
  }

  async function pickScript() {
    const cur = scriptInput.value || ''
    const startDir = cur ? cur.replace(/[\\/][^\\/]*$/, '') : ''
    const p = await pickFile(startDir, { title: '选择要绑定的启动脚本', exts: ['.bat', '.cmd', '.sh'] })
    if (p) {
      setScript(p)
      toast('已绑定：' + p, 'ok')
    }
  }

  async function runScript() {
    const p = scriptInput.value.trim()
    if (!p) {
      toast('请先选择启动脚本', 'err')
      return
    }
    runBtn.disabled = true
    try {
      const r = await api.post('/api/scripts/run', { path: p })
      if (r.error) {
        toast(r.error, 'err')
        return
      }
      toast('已在新窗口运行脚本', 'ok')
    } catch (e) {
      toast('运行失败：' + e.message, 'err')
    } finally {
      runBtn.disabled = false
    }
  }

  function clearScript() {
    setScript('')
    toast('已解除绑定', 'ok')
  }
}

/* ------------------------------------------------------------------ */
/* conversion mode                                                    */
/* ------------------------------------------------------------------ */

function buildConvertPanel(inst) {
  const { expanded, uid, ctx } = inst
  const panel = h('div', { class: 'col', style: { gap: '8px' } })

  const c = {
    source: '',
    file: null,
    busy: false,
    inspecting: false,
    inspectSerial: 0,
    versionSerial: 0,
    javaSerial: 0,
    jobId: '',
    uploadXhr: null,
    cancelRequested: false,
    lastProgress: 0,
    memoryEdited: false,
    wizard: 0,
    result: null,
    failed: false
  }

  const stepEls = ['选择来源', '确认配置', '进度 / 结果'].map((label, i) => h('div', { class: 'wizard-step' },
    h('span', { class: 'n' }, String(i + 1)),
    h('span', { class: 't', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label)))
  const stepsEl = h('div', { class: 'wizard-steps', 'aria-label': '转换流程' }, ...stepEls)

  // ---- source ----
  const sourceInput = input({ readonly: true, mono: true, placeholder: '拖入或选择客户端整合包 / 客户端目录' })
  sourceInput.setAttribute('aria-label', '整合包来源')
  const drop = h('div', {
    class: 'drop-zone c2s-source-drop',
    tabindex: '0',
    role: 'button',
    'aria-label': '拖入 .zip 或 .mrpack 整合包'
  },
    icon('archive', { size: 22 }),
    h('div', {},
      h('div', {}, '将客户端 ZIP / .mrpack 拖到这里'),
      h('div', { class: 'fx-note' }, '或点击选择文件；也可以选择已解压的客户端文件夹')))

  const pickPkgBtn = btn('选择安装包', { size: 'sm', iconName: 'file', onClick: pickPackage })
  const pickFolderBtn = btn('选择文件夹', { size: 'sm', iconName: 'folder', onClick: pickFolder })

  const sourcePanel = h('div', { class: 'wizard-panel' },
    drop,
    h('div', { class: 'row wrap', style: { gap: '6px' } },
      h('div', { class: 'grow', style: { minWidth: '190px' } }, sourceInput),
      pickPkgBtn, pickFolderBtn),
    h('div', { class: 'fx-note' }, '选择文件夹时直接读取本地路径；拖入或选择的压缩包只会读取清单并上传到本机工具箱处理。原客户端文件不会被修改。'))

  // ---- config ----
  const sourceSummary = h('div', { class: 'c2s-detect' }, '尚未选择来源。')
  const detectHint = h('div', { class: 'c2s-detect', 'aria-live': 'polite' }, '选择整合包后自动读取 MC、加载器和加载器版本。')

  const mcOptions = h('datalist', { id: uid + '-mc-list' })
  const runtimeMcInput = input({ id: uid + '-mc', list: uid + '-mc-list', placeholder: '例如 1.12.2', mono: true })
  const runtimeLoaderSel = select(LOADERS, '', { id: uid + '-loader', ariaLabel: '加载器类型' })
  const versionOptions = h('datalist', { id: uid + '-lv-list' })
  const runtimeLoaderVersionInput = input({
    id: uid + '-lv',
    list: uid + '-lv-list',
    placeholder: '识别后自动填写，可输入或展开选择',
    mono: true
  })
  const versionHint = h('div', { class: 'fx-note' },
    '点击版本输入框即可滚动查看在线候选；也可以输入历史版本，输入内容会自动过滤候选。')

  const runtimeControls = [runtimeMcInput, runtimeLoaderSel, runtimeLoaderVersionInput]
  const fieldGrid = expanded ? 'field-grid two' : 'field-grid'
  const mcField = field('Minecraft 版本', runtimeMcInput, { id: runtimeMcInput.id, hint: '例如 1.12.2 / 1.20.1' })
  const loaderField = field('加载器类型', runtimeLoaderSel, { id: runtimeLoaderSel.id })
  const loaderVersionField = field('加载器版本（模组服必填）', runtimeLoaderVersionInput, {
    id: runtimeLoaderVersionInput.id,
    hint: '原版可留空，模组服必须与整合包一致。'
  })

  const memoryInput = input({
    id: uid + '-mem',
    type: 'number',
    min: '1',
    max: '256',
    step: '1',
    value: String(memoryGbFromSettings(ctx)),
    mono: true
  })
  const minMemoryInput = input({
    id: uid + '-min-mem',
    type: 'number',
    min: '1',
    max: '256',
    step: '1',
    value: '1',
    mono: true
  })
  memoryInput.addEventListener('input', () => { c.memoryEdited = true })
  const memoryHint = h('div', { class: 'fx-note' }, '最大内存是上限，不应占满物理内存；请为系统和其他程序保留空间。')

  const javaInput = input({ id: uid + '-java', placeholder: '自动选择兼容的 Java', readonly: true, mono: true })
  const javaHint = h('div', { class: 'c2s-detect', 'aria-live': 'polite' },
    '根据 MC 版本检查 Java；Forge 1.12.2 通常需要 Java 8；新版 Cleanroom 需要 Java 25，可直接下载。')
  const javaPick = btn('选择 Java', { size: 'sm', iconName: 'java', onClick: async () => {
    const p = await pickFile('', { title: '选择 Java 可执行文件', exts: ['.exe'] })
    if (p && !c.busy) {
      javaInput.value = p
      checkJava()
    }
  } })
  const javaAuto = btn('自动选择', { size: 'sm', iconName: 'refresh', onClick: () => {
    javaInput.value = ''
    checkJava()
  } })
  const javaDownload = javaDownloadButton({
    getRuntime: () => ({
      mc: runtimeMcInput.value,
      loader: runtimeLoaderSel.value,
      loaderVersion: runtimeLoaderVersionInput.value
    }),
    isLocked: () => c.busy || c.inspecting,
    onReady: (p) => {
      javaInput.value = p
      checkJava()
    }
  })

  const worldPreset = input({
    id: uid + '-world',
    placeholder: '可选：填入整合包提供的世界预设 UUID',
    mono: true
  })
  const advanced = h('details', { class: 'acc' },
    h('summary', {}, '世界生成预设（可选）'),
    h('div', { class: 'acc-body' },
      worldPreset,
      h('div', { class: 'fx-note' }, '使用 Default World Generator 的整合包可能在首次启动时等待选择世界。已知预设 UUID 可在此填写；留空时可在开服管理控制台按日志提示选择。一般整合包保持空白。')))

  const bundleJavaInput = h('input', { type: 'checkbox', checked: true })
  const bundleJavaLabel = h('label', { class: 'row wrap', style: { marginTop: '8px' } },
    bundleJavaInput,
    '将兼容的 Java 一起打包（增加体积；Windows 运行时仅适用于 Windows）')

  const outputInput = input({ id: uid + '-out', readonly: true, mono: true, placeholder: '输出文件夹（可选）' })
  const outputBtn = btn('选择输出文件夹', { size: 'sm', iconName: 'folder-open', onClick: pickOutput })
  const outputField = h('div', { class: 'field' },
    h('label', { for: outputInput.id }, '输出文件夹（可选）'),
    h('div', { class: 'row wrap' },
      h('div', { class: 'grow', style: { minWidth: '170px' } }, outputInput),
      outputBtn))

  const convertStatus = h('div', { class: 'fx-note', 'aria-live': 'polite' },
    '未选择输出文件夹时：目录或已选择的压缩包会在客户端原文件夹生成；直接拖入的文件会生成到系统“下载”文件夹。原文件不会被修改。')

  const coreSection = h('div', { class: 'col', style: { gap: '8px' } },
    h('div', { class: 'row wrap', style: { gap: '6px' } },
      h('div', { class: 'grow' }, sourceSummary),
      btn('更换来源', { size: 'xs', iconName: 'swap', onClick: () => setWizard(0) })),
    h('div', { class: 'mini-label' }, '核心识别'),
    detectHint,
    h('div', { class: fieldGrid }, mcField, loaderField, loaderVersionField),
    mcOptions, versionOptions, versionHint)

  const launchSection = h('div', { class: 'col', style: { gap: '8px' } },
    h('div', { class: 'mini-label' }, '启动设置'),
    h('div', { class: 'field-grid two' },
      field('最大内存（GB）', memoryInput, { id: memoryInput.id }),
      field('初始内存（GB）', minMemoryInput, { id: minMemoryInput.id })),
    memoryHint,
    h('div', { class: 'field' },
      h('label', { for: javaInput.id }, 'Java 路径（自动匹配或手动选择）'),
      h('div', { class: 'row wrap' },
        h('div', { class: 'grow', style: { minWidth: '180px' } }, javaInput),
        javaPick, javaAuto, javaDownload)),
    javaHint,
    advanced,
    bundleJavaLabel,
    outputField)

  const configInner = expanded
    ? h('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
        gap: '12px',
        alignItems: 'start'
      }
    }, coreSection, launchSection)
    : h('div', { class: 'col', style: { gap: '8px' } }, coreSection, launchSection)

  const configPanel = h('div', { class: 'wizard-panel' }, configInner)

  // ---- progress ----
  const bar = progress(null)
  const detailText = h('span', { class: 'muted', 'aria-live': 'polite' }, '')
  const percentText = h('span', { class: 'muted mono' }, '0%')
  const runStatus = h('div', { class: 'fx-note', 'aria-live': 'polite' }, '等待开始转换。')
  const progressPanel = h('div', { class: 'wizard-panel' },
    h('div', { class: 'fx-head' }, h('b', {}, '转换进度'), h('span', { class: 'spacer' }), percentText),
    h('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '6px' } },
      detailText, h('span', { class: 'muted', style: { fontSize: '10.5px' } }, '每 350 ms 刷新')),
    bar.el,
    runStatus,
    h('div', { class: 'fx-note' }, '原客户端文件不会被修改；转换过程中可以中止，后台会停止并清理临时文件。'))

  // ---- footer ----
  const prevBtn = btn('上一步', { size: 'sm', iconName: 'arrow-left', onClick: () => setWizard(c.wizard - 1) })
  const nextBtn = btn('下一步：确认配置', { size: 'sm', iconName: 'arrow-right', onClick: () => setWizard(1) })
  const restartBtn = btn('重新选择来源', { size: 'sm', iconName: 'refresh', disabled: false, onClick: () => setWizard(0) })
  const convertBtn = btn('转换为服务端包', { variant: 'primary', size: 'sm', iconName: 'bolt', onClick: convert })
  const cancelBtn = btn('中止转换', { variant: 'danger', size: 'sm', iconName: 'stop', onClick: cancelConvert })
  cancelBtn.hidden = true
  const foot = h('div', { class: 'wizard-foot' },
    prevBtn, nextBtn, restartBtn,
    h('span', { class: 'spacer' }),
    convertBtn, cancelBtn)

  panel.append(stepsEl, sourcePanel, configPanel, progressPanel, foot)
  sourcePanel.hidden = false
  configPanel.hidden = true
  progressPanel.hidden = true
  setWizard(0)
  updateDisabled()

  // 版本候选：进入转换模式时预热一次，与旧实现一致。
  api.get('/api/servercore/gameversions').then((r) => {
    if (inst.disposed) return
    for (const v of r.items || []) mcOptions.appendChild(h('option', { value: v.id }))
  }).catch(() => {})

  drop.addEventListener('click', () => { if (!c.busy) pickPackage() })
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (!c.busy) pickPackage()
    }
  })
  drop.addEventListener('dragover', (e) => {
    e.preventDefault()
    if (!c.busy) drop.classList.add('over')
  })
  drop.addEventListener('dragleave', () => drop.classList.remove('over'))
  drop.addEventListener('drop', (e) => {
    e.preventDefault()
    drop.classList.remove('over')
    if (c.busy) return
    const file = e.dataTransfer?.files?.[0]
    if (!file) return
    if (!/\.(zip|mrpack)$/i.test(file.name)) {
      toast('请拖入 .zip 或 .mrpack 客户端整合包', 'err')
      return
    }
    // WebView 可能提供 file.path；标准浏览器没有路径时改为上传文件内容。
    setSource(file.path || '', file.path ? null : file)
  })

  runtimeMcInput.addEventListener('input', () => {
    ++c.versionSerial
    ++c.javaSerial
    runtimeLoaderVersionInput.value = ''
    clear(versionOptions)
  })
  runtimeMcInput.addEventListener('change', runtimeChanged)
  runtimeLoaderVersionInput.addEventListener('change', checkJava)
  runtimeLoaderSel.addEventListener('change', runtimeChanged)

  // ---------------- helpers ----------------

  const runtimeValue = () => ({
    mc: runtimeMcInput.value.trim(),
    loader: runtimeLoaderSel.value,
    loaderVersion: runtimeLoaderVersionInput.value
  })

  function setSource(source, file) {
    if (c.busy || inst.disposed) return
    const serial = ++c.inspectSerial
    ++c.versionSerial
    ++c.javaSerial
    c.inspecting = true
    for (const el of runtimeControls) el.value = ''
    clear(versionOptions)
    detectHint.textContent = '正在读取整合包版本信息…（只读取清单，不解压整个包）'
    c.source = source || ''
    c.file = file || null
    sourceInput.value = source || file?.name || ''
    sourceInput.title = sourceInput.value
    const suffix = file ? '（将上传到本地工具箱处理）' : ''
    sourceSummary.textContent = `已选择：${source || file?.name || '未选择'}${suffix} 原文件不会被修改。`
    convertStatus.textContent = `已选择：${source || file?.name || '未选择'}${suffix} 原文件不会被修改。`
    if (!c.memoryEdited) memoryInput.value = '4'
    memoryHint.textContent = '将按模组数量和体积提供内存建议；最大内存不应占满物理内存。'
    setWizard(1)
    updateDisabled()
    ;(async () => {
      try {
        const records = file ? await readPackMetadata(file.size, (offset, length) => {
          if (serial !== c.inspectSerial || inst.disposed) throw new Error('选择已更新')
          return file.slice(offset, offset + length).arrayBuffer()
        }) : null
        if (serial !== c.inspectSerial || inst.disposed) return
        const r = await api.post('/api/mods/inspect', records ? { records, summary: records.summary } : { source })
        if (serial !== c.inspectSerial || inst.disposed) return
        if (r.runtime) {
          if (!c.memoryEdited) memoryInput.value = String(r.runtime.recommendedMemory || 4)
          memoryHint.textContent = `检测到 ${r.runtime.modCount || 0} 个模组文件，按规模建议最大 ${r.runtime.recommendedMemory || 4} GB；请按人数和实测调整，并为系统保留内存。这不是最低内存保证。`
          runtimeMcInput.value = r.runtime.mc || ''
          runtimeLoaderSel.value = r.runtime.loader || ''
          runtimeLoaderVersionInput.value = r.runtime.loaderVersion || ''
          detectHint.textContent = `已识别：Minecraft ${r.runtime.mc} · ${r.runtime.loader} ${r.runtime.loaderVersion || ''}；来源：${r.runtime.source}${r.runtime.loaderVersionSuggested ? '；Cleanroom 版本为在线建议，请核对作者要求' : ''}`
        } else {
          detectHint.textContent = '未找到有效版本信息，请手动填写下方 MC、加载器及其版本后再转换。'
        }
      } catch (e) {
        if (serial === c.inspectSerial && !inst.disposed) {
          detectHint.textContent = '自动识别失败：' + e.message + '。可以手动填写版本。'
        }
      } finally {
        if (serial === c.inspectSerial) {
          c.inspecting = false
          updateDisabled()
          refreshVersions()
          checkJava()
        }
      }
    })()
  }

  function setWizard(n) {
    if (inst.disposed) return
    n = Math.max(0, Math.min(2, n))
    if (n === 1 && !(c.source || c.file)) n = 0
    if (n === 2 && !c.busy && !c.result && !c.failed) return
    paintWizard(n)
  }

  function paintWizard(n) {
    c.wizard = n
    sourcePanel.hidden = n !== 0
    configPanel.hidden = n !== 1
    progressPanel.hidden = n !== 2
    stepEls.forEach((el, i) => {
      el.classList.toggle('active', i === n)
      el.classList.toggle('done', i < n)
    })
    updateFoot()
  }

  function updateFoot() {
    prevBtn.hidden = !(c.wizard > 0 && !c.busy)
    nextBtn.hidden = !(c.wizard === 0 && (c.source || c.file) && !c.busy)
    restartBtn.hidden = !(c.wizard === 2 && !c.busy)
    convertBtn.hidden = c.wizard !== 1
    cancelBtn.hidden = !c.busy
  }

  function updateDisabled() {
    const locked = c.busy || c.inspecting
    convertBtn.disabled = locked
    for (const el of [
      ...runtimeControls, versionOptions, memoryInput, minMemoryInput,
      bundleJavaInput, worldPreset, javaPick, javaAuto, javaDownload,
      pickPkgBtn, pickFolderBtn, outputBtn, nextBtn, prevBtn, restartBtn
    ]) el.disabled = locked
    if (!locked && runtimeLoaderSel.value === 'vanilla') {
      runtimeLoaderVersionInput.disabled = true
      versionOptions.disabled = true
    }
    drop.style.pointerEvents = locked ? 'none' : ''
    drop.setAttribute('aria-disabled', String(locked))
    if (!locked) updateFoot()
  }

  async function checkJava() {
    const serial = ++c.javaSerial
    if (!runtimeMcInput.value || !runtimeLoaderSel.value) {
      javaHint.textContent = '先确定 MC 版本和加载器，再检查兼容的 Java。'
      return
    }
    javaHint.textContent = '正在检查本机 Java…'
    try {
      const r = await api.post('/api/mods/java', { runtime: runtimeValue(), javaPath: javaInput.value })
      if (serial !== c.javaSerial || inst.disposed) return
      javaHint.textContent = `已找到 Java ${r.major}（64 位）：${r.path}。此版本服务端使用 Java ${r.required}。`
    } catch (e) {
      if (serial === c.javaSerial && !inst.disposed) javaHint.textContent = e.message
    }
  }

  async function refreshVersions() {
    const serial = ++c.versionSerial
    clear(versionOptions)
    const loader = runtimeLoaderSel.value
    const mc = runtimeMcInput.value.trim()
    runtimeLoaderVersionInput.disabled = c.busy || c.inspecting || loader === 'vanilla'
    versionOptions.disabled = c.busy || c.inspecting || loader === 'vanilla'
    if (loader === 'vanilla') {
      runtimeLoaderVersionInput.value = ''
      runtimeLoaderVersionInput.placeholder = '原版无需加载器版本'
      versionHint.textContent = '原版服务端不需要加载器版本。'
      versionOptions.disabled = true
      return
    }
    runtimeLoaderVersionInput.placeholder = '填写准确版本号'
    if (!loader || !mc) {
      versionHint.textContent = '先填写 MC 版本并选择加载器；模组加载器版本必填。'
      return
    }
    const current = runtimeLoaderVersionInput.value.trim()
    if (current) versionOptions.appendChild(h('option', { value: current, label: `${current}（当前版本）` }))
    versionHint.textContent = '正在获取在线候选；当前版本不会被自动替换。'
    try {
      const r = await api.get('/api/servercore/loaderversions?' + new URLSearchParams({ loader, mc }))
      if (serial !== c.versionSerial || inst.disposed) return
      for (const item of r.items || []) {
        if (String(item.version) === current) continue
        const raw = LOADER_LABELS[item.label] || item.label
        versionOptions.appendChild(h('option', {
          value: item.version,
          label: `${item.version}${raw ? '（' + raw + '）' : ''}`
        }))
      }
      versionHint.textContent = '可滚动或输入搜索历史版本；优先保持整合包的准确版本，不会自动升级。'
    } catch {
      if (serial === c.versionSerial && !inst.disposed) {
        versionHint.textContent = '在线列表暂不可用，仍可使用已识别版本或手动填写。'
      }
    }
  }

  function runtimeChanged() {
    runtimeLoaderVersionInput.value = ''
    detectHint.textContent = '已手动更改运行环境，请重新确定对应的加载器版本。'
    refreshVersions()
    checkJava()
  }

  async function pickPackage() {
    if (c.busy) return
    const p = await pickFile('', { title: '选择客户端整合包', exts: ['.zip', '.mrpack'] })
    if (p) setSource(p, null)
  }

  async function pickFolder() {
    if (c.busy) return
    const p = await pickDir('', { title: '选择客户端整合包目录' })
    if (p) setSource(p, null)
  }

  async function pickOutput() {
    if (c.busy) return
    const p = await pickDir(outputInput.value || '', { title: '选择服务端包输出文件夹' })
    if (p) {
      outputInput.value = p
      convertStatus.textContent = `服务端包将生成到：${p}。原客户端文件不会被修改。`
    }
  }

  async function convert() {
    if (c.busy || c.inspecting || inst.disposed) return
    if (!c.source && !c.file) {
      toast('请先拖入或选择客户端整合包 / 目录', 'err')
      return
    }
    if (c.file?.size > 4 * 1024 * 1024 * 1024) {
      toast('整合包超过 4 GB，请先解压并使用“选择文件夹”', 'err')
      return
    }
    const memory = Number(memoryInput.value)
    const minMemory = Number(minMemoryInput.value)
    if (!Number.isInteger(memory) || !Number.isInteger(minMemory) || minMemory < 1 || memory < minMemory || memory > 256) {
      toast('内存请输入 1–256 的整数，初始内存不能大于最大内存', 'err')
      return
    }
    if (!/^1\.\d+(?:\.\d+)?$/.test(runtimeMcInput.value.trim()) || !runtimeLoaderSel.value ||
      (runtimeLoaderSel.value !== 'vanilla' && !runtimeLoaderVersionInput.value.trim())) {
      toast('请先补全 MC 版本、加载器及加载器版本', 'err')
      return
    }
    c.cancelRequested = false
    c.lastProgress = 0
    c.result = null
    c.failed = false
    c.busy = true
    setWizard(2)
    updateDisabled()
    cancelBtn.disabled = false
    setConvertProgress({ stage: 'queued', progress: null, detail: '正在提交转换任务…' })
    try {
      const selectedJava = await api.post('/api/mods/java', {
        runtime: {
          mc: runtimeMcInput.value.trim(),
          loader: runtimeLoaderSel.value,
          loaderVersion: runtimeLoaderVersionInput.value
        },
        javaPath: javaInput.value
      })
      if (c.cancelRequested) throw new Error('转换已中止')
      let job
      if (c.file) {
        const q = new URLSearchParams({
          memory: memory + 'G',
          minMemory: minMemory + 'G',
          javaPath: selectedJava.path,
          bundleJava: String(bundleJavaInput.checked)
        })
        if (worldPreset.value.trim()) q.set('worldPreset', worldPreset.value.trim())
        if (outputInput.value.trim()) q.set('outputDir', outputInput.value.trim())
        if (runtimeMcInput.value.trim()) q.set('mc', runtimeMcInput.value.trim())
        if (runtimeLoaderSel.value) q.set('loader', runtimeLoaderSel.value)
        if (runtimeLoaderVersionInput.value.trim()) q.set('loaderVersion', runtimeLoaderVersionInput.value.trim())
        job = await uploadConvertFile('/api/mods/convert-upload?' + q, c.file)
      } else {
        const runtime = {
          mc: runtimeMcInput.value.trim(),
          loader: runtimeLoaderSel.value,
          loaderVersion: runtimeLoaderVersionInput.value.trim()
        }
        job = await api.post('/api/mods/convert', {
          source: c.source,
          outputDir: outputInput.value.trim(),
          runtime,
          memory: memory + 'G',
          minMemory: minMemory + 'G',
          javaPath: selectedJava.path,
          bundleJava: bundleJavaInput.checked,
          worldPreset: worldPreset.value.trim()
        })
      }
      if (job.error) throw new Error(job.error)
      if (!job.id) throw new Error('转换任务创建失败')
      c.jobId = job.id
      if (c.cancelRequested) await cancelConvert()
      let result
      for (;;) {
        await inst.sleep(350)
        if (inst.disposed) return
        const current = await api.get('/api/mods/convert/jobs/' + encodeURIComponent(job.id))
        if (inst.disposed) return
        setConvertProgress(current)
        if (current.status === 'done') {
          result = current.result
          break
        }
        if (current.status === 'cancelled') throw new Error('转换已中止')
        if (current.status === 'failed') throw new Error(current.error || '转换失败')
      }
      if (inst.disposed) return
      c.result = result
      showResult(result)
      if (inst.disposed) return
      toast('服务端整合包已生成', 'ok')
    } catch (e) {
      if (inst.disposed) return
      const cancelled = e.message === '转换已中止' || e.message === '客户端整合包上传已取消'
      c.failed = !cancelled
      toast(cancelled ? '已中止转换' : '转换失败：' + e.message, cancelled ? 'warn' : 'err')
      setConvertProgress({
        status: cancelled ? 'cancelled' : 'failed',
        stage: cancelled ? 'cancelled' : 'failed',
        progress: c.lastProgress,
        detail: cancelled ? '转换已中止' : e.message
      })
    } finally {
      c.busy = false
      c.jobId = ''
      c.uploadXhr = null
      if (!inst.disposed) {
        // 结束后仍停留在进度 / 结果步，允许返回修改或重新选择来源。
        updateDisabled()
        paintWizard(2)
      }
    }
  }

  async function cancelConvert() {
    if (!c.busy) return
    c.cancelRequested = true
    cancelBtn.disabled = true
    setConvertProgress({ status: 'cancelling', progress: null, detail: '正在请求中止，请等待后台停止并清理…' })
    if (c.uploadXhr) {
      c.uploadXhr.abort()
      return
    }
    if (c.jobId) {
      try {
        await api.post('/api/mods/convert/jobs/' + encodeURIComponent(c.jobId) + '/cancel')
      } catch (e) {
        cancelBtn.disabled = false
        if (!inst.disposed) toast('中止请求失败：' + e.message, 'err')
      }
    }
  }

  function uploadConvertFile(url, file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      c.uploadXhr = xhr
      xhr.open('POST', url)
      xhr.setRequestHeader('Content-Type', file.type || 'application/zip')
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name))
      xhr.onloadend = () => { if (c.uploadXhr === xhr) c.uploadXhr = null }
      xhr.upload.onload = () => setConvertProgress({
        stage: 'upload',
        progress: null,
        detail: '上传完成，正在等待本地工具箱创建任务…'
      })
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) {
          setConvertProgress({ stage: 'upload', progress: null, detail: `正在上传到本机 · 已传 ${fmtBytes(event.loaded)}` })
          return
        }
        const ratio = Math.max(0, Math.min(1, event.loaded / event.total))
        const uploaded = `${fmtBytes(event.loaded)} / ${fmtBytes(event.total)}`
        setConvertProgress({ stage: 'upload', progress: ratio * 100, detail: `上传到本机（上传阶段） · ${uploaded}` })
      }
      xhr.onerror = () => reject(new Error('客户端整合包上传失败，请检查文件是否仍可读取'))
      xhr.onabort = () => reject(new Error('客户端整合包上传已取消'))
      xhr.onload = () => {
        let data = null
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null
        } catch {
          reject(new Error('上传接口返回了无效响应'))
          return
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(data?.error || `上传失败（HTTP ${xhr.status}）`))
          return
        }
        setConvertProgress({ stage: 'queued', progress: null, detail: '上传完成，正在启动转换任务…' })
        resolve(data)
      }
      xhr.send(file)
    })
  }

  function setConvertProgress(job) {
    const known = typeof job.progress === 'number' && Number.isFinite(job.progress)
    const p = known ? Math.max(0, Math.min(100, job.progress)) : 0
    if (known) c.lastProgress = p
    bar.set(known ? p : null)
    detailText.textContent = job.detail || job.stage || '处理中…'
    if (job.status === 'cancelled') percentText.textContent = '已中止'
    else if (job.status === 'failed') percentText.textContent = '失败'
    else percentText.textContent = known ? `${Math.round(p)}%` : '处理中'
    bar.state(job.status === 'done' ? 'ok' : (job.status === 'failed' || job.status === 'cancelled') ? 'bad' : '')
    if (job.status === 'done') {
      runStatus.className = 'result-ok'
      runStatus.textContent = '转换完成。已校验服务端核心和启动文件，原客户端文件未修改。'
      convertStatus.textContent = '转换完成。已校验服务端核心和启动文件，原客户端文件未修改。'
    } else if (job.status === 'failed') {
      runStatus.className = 'result-bad'
      runStatus.textContent = `转换失败：${job.error || job.detail || '未知错误'}`
      convertStatus.textContent = `转换失败：${job.error || job.detail || '未知错误'}`
    } else if (job.status === 'cancelled') {
      runStatus.className = 'result-warn'
      runStatus.textContent = '转换已中止，未生成服务端包。'
    } else {
      runStatus.className = 'fx-note'
      runStatus.textContent = '转换进行中，请保持工具箱运行；原客户端文件不会被修改。'
    }
  }

  function showResult(result) {
    const warning = (result.warnings || []).map((x) => h('div', { class: 'result-bad' }, x))
    const detail = h('div', { class: 'col', style: { gap: '7px' } },
      h('div', { class: 'result-ok' }, `转换完成：移除 ${result.removedCount || 0} 个客户端 / 不适用服务端的 mod`),
      h('div', { class: 'mono', style: { wordBreak: 'break-all' } }, result.output),
      h('div', { class: 'muted' }, `扫描 ${result.totalMods || 0} 个 mod · 输出 ${fmtBytes(result.packed?.bytes || 0)}`),
      result.core
        ? h('div', { class: 'muted' }, `Java ${result.core.javaMajor} · 初始 ${result.core.minMemory} / 最大 ${result.core.memory} · ${result.core.bundledJava ? '已包含 Java 运行时' : '使用本机 Java'}`)
        : null,
      h('div', { class: 'muted' }, result.validation || '请在开服管理中启动服务端，检查实际世界加载情况。'),
      ...(result.compatibility || []).map((change) => h('div', { class: 'muted' }, `${change.action}：${change.file}`)),
      ...warning)
    openModal({
      title: '服务端整合包已生成',
      body: detail,
      buttons: [
        {
          label: '打开输出文件夹',
          onClick: async () => { await openPath(result.outputDir) }
        },
        { label: '关闭', class: 'btn-primary' }
      ]
    })
  }

  return { el: panel }
}

/* ------------------------------------------------------------------ */
/* client-mod library                                                 */
/* ------------------------------------------------------------------ */

function createLibraryPanel(inst, { modal = false } = {}) {
  const { view, ctx } = inst
  let query = ''
  let editingId = ''
  let infoLoaded = false

  const search = input({
    placeholder: '搜索 modid 或名称',
    onInput: () => {
      query = search.value.trim().toLowerCase()
      renderRows()
    }
  })
  const countEl = h('span', { class: 'muted', style: { fontSize: '10.5px' } }, '')
  const pathText = h('span', {
    class: 'mono',
    style: { userSelect: 'text', overflowWrap: 'anywhere' }
  }, '（未获取到）')
  const tableWrap = h('div', { class: 'c2s-tablewrap', style: { maxHeight: modal ? '320px' : '44vh' } })

  const addModid = input({ placeholder: 'modid，例如 sodium', mono: true })
  const addName = input({ placeholder: '显示名称（可选）' })
  const addNote = input({ placeholder: '备注（可选）' })
  const addBtn = btn('添加', { variant: 'primary', size: 'sm', iconName: 'add', onClick: add })
  addModid.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      add()
    }
  })

  const pathRow = h('div', { class: 'row wrap', style: { gap: '6px' } },
    icon('info', { size: 13 }),
    h('span', { class: 'muted', style: { fontSize: '10.5px' } }, '库文件位置：'),
    pathText,
    h('span', { class: 'spacer' }),
    btn('打开此目录', { size: 'xs', iconName: 'folder-open', onClick: openModsDir }))

  const searchRow = h('div', { class: 'row wrap', style: { gap: '6px' } },
    h('div', { class: 'grow', style: { minWidth: '150px' } }, search),
    countEl)

  const addBox = h('div', { class: 'section', style: { padding: '10px', background: 'var(--surface-2)' } },
    h('div', { class: 'fx-note', style: { marginBottom: '6px' } },
      '新增记录：按 modid 精确匹配（忽略大小写），库文件可直接编辑 / 分享'),
    h('div', { class: 'row wrap', style: { gap: '6px' } },
      h('div', { class: 'grow', style: { minWidth: '140px' } }, addModid),
      h('div', { class: 'grow', style: { minWidth: '130px' } }, addName),
      h('div', { class: 'grow', style: { minWidth: '130px' } }, addNote),
      addBtn))

  const el = h('div', { class: 'col', style: { gap: '8px' } }, pathRow, searchRow, addBox, tableWrap)

  renderRows()

  return {
    el,
    init: async () => {
      await reload()
      await loadInfo()
    },
    reload
  }

  async function loadInfo() {
    if (infoLoaded) return
    try {
      const info = await api.get('/api/system/info')
      const dir = String(info.clientModsDir || '')
      if (!dir) {
        pathText.textContent = '（未获取到）'
        return
      }
      const sep = String(navigator.platform || '').toLowerCase().includes('win') ? '\\' : '/'
      const file = dir.replace(/[\\/]+$/, '') + sep + 'clientmods.json'
      pathText.textContent = file
      pathText.title = file
      infoLoaded = true
    } catch {
      pathText.textContent = '（未获取到）'
    }
  }

  async function reload() {
    try {
      const data = await api.get('/api/mods/client-list')
      view.library = data.items || []
    } catch (e) {
      if (!inst.disposed) toast('读取 mod 库失败：' + e.message, 'err')
    }
    renderRows()
    if (!inst.disposed) inst.refreshClean?.()
  }

  function renderRows() {
    clear(tableWrap)
    const q = query
    const rows = view.library.filter((x) => !q ||
      String(x.modid).toLowerCase().includes(q) ||
      String(x.name || '').toLowerCase().includes(q))
    countEl.textContent = `共 ${view.library.length} 条 · 当前显示 ${rows.length} 条`
    if (!rows.length) {
      tableWrap.appendChild(emptyState(
        q ? '没有匹配的记录' : '库中还没有记录',
        q ? '换一个 modid 或名称再试。' : '在下方输入 modid 添加第一条记录。',
        null,
        { iconName: 'list' }
      ))
      return
    }
    const table = h('table', { class: 'tbl c2s-table', 'aria-label': '仅客户端 mod 库' })
    table.appendChild(h('thead', {}, h('tr', {},
      h('th', {}, 'modid'),
      h('th', {}, '名称'),
      h('th', {}, '备注'),
      h('th', {}, '来源'),
      h('th', { class: 'num', style: { width: '128px' } }, '操作'))))
    const tbody = h('tbody')
    for (const it of rows.slice(0, 400)) tbody.appendChild(renderRow(it))
    table.appendChild(tbody)
    tableWrap.appendChild(table)
    if (rows.length > 400) {
      tableWrap.appendChild(h('div', { class: 'muted center', style: { padding: '8px', fontSize: '10.5px' } },
        `仅显示前 400 条（共 ${rows.length} 条），请使用搜索缩小范围。`))
    }
  }

  function renderRow(it) {
    const builtin = it.source === 'builtin'
    const sourceBadge = badge(builtin ? '内置' : '自定义', builtin ? '' : 'info')
    if (editingId === it.id) {
      const nameEl = input({ value: it.name || '' })
      const noteEl = input({ value: it.note || '' })
      const saveBtn = btn('保存', { variant: 'primary', size: 'xs', iconName: 'save', onClick: async () => {
        try {
          await api.put('/api/mods/client-list/' + encodeURIComponent(it.id), {
            name: nameEl.value.trim(),
            note: noteEl.value.trim()
          })
          editingId = ''
          await reload()
          toast('已保存', 'ok')
        } catch (e) {
          toast('保存失败：' + e.message, 'err')
        }
      } })
      const cancelBtn = btn('取消', { size: 'xs', iconName: 'close', onClick: () => {
        editingId = ''
        renderRows()
      } })
      return h('tr', {},
        h('td', { class: 'mono' }, it.modid),
        h('td', {}, nameEl),
        h('td', {}, noteEl),
        h('td', {}, sourceBadge),
        h('td', { class: 'num' }, h('div', { class: 'row-actions' }, saveBtn, cancelBtn)))
    }
    return h('tr', {},
      h('td', { class: 'mono' }, it.modid),
      h('td', {}, it.name || '-'),
      h('td', { class: 'muted' }, it.note || '-'),
      h('td', {}, sourceBadge),
      h('td', { class: 'num' }, h('div', { class: 'row-actions' },
        btn('编辑', { size: 'xs', iconName: 'edit', onClick: () => {
          editingId = it.id
          renderRows()
        } }),
        btn('删除', { variant: 'danger', size: 'xs', iconName: 'trash', onClick: () => remove(it) }))))
  }

  async function add() {
    const modid = addModid.value.trim()
    if (!modid) {
      toast('请填写 modid', 'err')
      addModid.focus()
      return
    }
    try {
      await api.post('/api/mods/client-list', {
        modid,
        name: addName.value.trim(),
        note: addNote.value.trim()
      })
      addModid.value = ''
      addName.value = ''
      addNote.value = ''
      await reload()
      toast('已添加：' + modid, 'ok')
    } catch (e) {
      toast('添加失败：' + e.message, 'err')
    }
  }

  async function remove(it) {
    const settings = ctx.settings()
    if (settings.general?.confirmDanger !== false) {
      const ok = await confirmDialog(`删除「${it.name || it.modid}」？仅从库中移除，不影响本地文件。`, { danger: true })
      if (!ok) return
    }
    try {
      await api.del('/api/mods/client-list/' + encodeURIComponent(it.id))
      if (editingId === it.id) editingId = ''
      await reload()
      toast('已删除', 'ok')
    } catch (e) {
      toast('删除失败：' + e.message, 'err')
    }
  }
}

/* ------------------------------------------------------------------ */
/* shared helpers                                                     */
/* ------------------------------------------------------------------ */

function libIndex(library) {
  const map = new Map()
  for (const it of library || []) map.set(String(it.modid).toLowerCase(), it)
  return map
}

function classifyMod(mod, idx, autoDetect) {
  if (!mod.modid) return null
  const hit = idx.get(String(mod.modid).toLowerCase())
  if (hit) return { kind: 'lib', label: 'modid 库', note: hit.name || hit.modid }
  if (mod.environment === 'client' && autoDetect) {
    return { kind: 'auto', label: '自动识别', note: 'fabric/quilt 声明为 client' }
  }
  return null
}

async function openModsDir() {
  try {
    const r = await api.post('/api/system/open-path', { which: 'clientModsDir' })
    const p = (r && (r.file || r.target)) || ''
    toast(p ? `已打开：${p}` : '已打开库目录', 'ok')
  } catch (e) {
    toast(e.message || '打开失败', 'err')
  }
}
