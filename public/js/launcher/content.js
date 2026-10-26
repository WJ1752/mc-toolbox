// 启动器内容页：模组 / 资源包 / 光影 / 世界 / 截图 / 服务器 / 日志 / 崩溃。
// 只负责在传入容器里渲染内容；文本一律走 h()，外部字符串不进 innerHTML。
import { h, clear, fmtBytes, fmtAgo, fmtDateTime, copyText } from '../core/dom.js'
import { icon } from '../ui/icons.js'
import { openModal as openModalDefault, confirmDialog } from '../core/modal.js'
import { toast as toastDefault } from '../core/toast.js'
import { badge, btn, iconBtn, input, seg, select, spinner, openPath as openPathDefault } from '../ui/kit.js'
import { api as coreApi } from '../core/api.js'
import { launcherApi } from './api.js'
import { emptyBlock, sectionCard, loaderLabel } from './ui.js'
import { versionCombo, partitionVersions, compatibleVersion, filterSummary, isMinecraftVersion, versionTagBadges } from './version-picker.js'
import { createPager, pageOffset, SEARCH_PAGE_SIZE, SEARCH_SORTS } from './search-pager.js'
const ENV = { client: ['客户端', 'info'], server: ['服务端', 'accent'], both: ['通用', ''], '*': ['通用', ''] }
const MOD_LOADER_LABELS = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt', 'legacy-forge': '旧版 Forge', cleanroom: 'Cleanroom' }
const MODES = ['生存模式', '创造模式', '冒险模式', '旁观模式']
const KINDS = { release: '正式版', beta: '测试版', alpha: '预览版' }
const EXT = { mods: /\.(jar|zip)$/i, resourcepacks: /\.(zip|jar)$/i, shaderpacks: /\.(zip|jar)$/i }

/* 布局小片段：统一类名，避免每行重复嵌套。 */
const rowEl = (cls, ...kids) => h('div', { class: 'lp-row ' + cls }, ...kids)
const mainEl = (...kids) => h('div', { class: 'lp-mod-main' }, ...kids)
const titleEl = (...kids) => h('div', { class: 'lp-mod-title' }, ...kids)
const actEl = (...kids) => h('div', { class: 'lp-mod-actions' }, ...kids)
const metaEl = (parts, cls = 'lp-mod-meta mono') => h('div', { class: cls }, parts.filter(Boolean).join(' · '))
const iconTile = (name) => h('span', { class: 'lp-mod-icon' }, icon(name, { size: 15 }))
const barEl = (...kids) => h('div', { class: 'lp-toolbar' }, ...kids)
const tabEl = (...kids) => h('div', { class: 'lp-tab' }, ...kids)
const tip = (text, cls = 'lp-hint') => h('div', { class: cls }, text)
const spacer = () => h('span', { class: 'spacer' })
const chip = (text, cls = 'lp-chip') => h('span', { class: cls }, text)
function fillList(node, items, empty, render) {
  node.replaceChildren(...(items.length ? items.map(render) : [empty]))
}
/** 列表页通用加载器：loading / error / render 一次接好。 */
function makeLoader(t, node, { text, title, style = null, request, render }) {
  const load = async (showLoading = true) => {
    if (showLoading) node.replaceChildren(loadingBlock(text, style))
    try {
      const data = await request()
      if (t.life.dead) return
      render(data || {})
    } catch (error) {
      if (!t.life.dead) node.replaceChildren(failBlock(title, error, load))
    }
  }
  return load
}
function loadingBlock(text = '正在加载…', style = null) {
  return h('div', { class: 'lp-empty', style }, spinner(16), h('b', {}, text))
}
function failBlock(title, error, retry) {
  return emptyBlock(title, error?.message || String(error || '未知错误'),
    retry ? btn('重试', { size: 'sm', iconName: 'refresh', onClick: retry }) : null, 'warning')
}
function switchBox(checked, onChange, label = '') {
  const box = h('input', { type: 'checkbox', 'aria-label': label })
  box.checked = !!checked
  box.onchange = () => onChange(box.checked, box)
  return { el: h('label', { class: 'switch lp-toggle', title: label }, box, h('span')), input: box }
}

/** 只在指定区域接收文件；捕获阶段拦截，避免主页面把它当成整合包。 */
function bindDrop(t, zone, onFiles) {
  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files')
  t.life.on(zone, 'dragover', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    zone.classList.add('over')
  }, true)
  t.life.on(zone, 'dragleave', () => zone.classList.remove('over'), true)
  t.life.on(zone, 'drop', (event) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    zone.classList.remove('over')
    const files = Array.from(event.dataTransfer?.files || [])
    if (files.length) onFiles(files)
  }, true)
}
// ctx.pickFile 返回服务器路径，无法用于浏览器上传；上传统一用隐藏 file input。
function chooseFiles({ accept = '', multiple = false, title = '选择文件' } = {}) {
  return new Promise((resolve) => {
    const picker = h('input', { type: 'file', accept, multiple, title, style: { display: 'none' } })
    picker.oncancel = () => { picker.remove(); resolve(multiple ? [] : null) }
    picker.onchange = () => {
      const files = Array.from(picker.files || [])
      picker.remove()
      resolve(multiple ? files : (files[0] || null))
    }
    document.body.appendChild(picker)
    picker.click()
  })
}
async function uploadFiles(t, type, files, after) {
  const pattern = EXT[type] || EXT.mods
  let changed = false
  for (const file of Array.from(files || [])) {
    if (!file || !pattern.test(file.name || '')) {
      t.toast(`已跳过 ${file?.name || '未知文件'}：格式不支持`, 'warn')
      continue
    }
    try {
      await t.api.upload(t.id, type, file)
      t.toast(`已导入 ${file.name}`, 'ok')
      changed = true
    } catch (error) { t.toast(`${file.name} 导入失败：${error.message}`, 'err') }
  }
  if (!changed || t.life.dead) return
  await after?.()
  await t.reloadInstance()
}
function agoOf(value) {
  const ts = typeof value === 'number' ? value : Date.parse(String(value || ''))
  return Number.isFinite(ts) ? fmtAgo(ts) : '未知'
}
async function deleteFlow(t, { message, title, okText = '删除', okMessage = '已删除', task, after }) {
  if (!(await t.confirm(message, { title, danger: true, okText })) || t.life.dead) return false
  try {
    await task()
    t.toast(okMessage, 'ok')
    await after?.()
    return true
  } catch (error) {
    t.toast('删除失败：' + error.message, 'err')
    return false
  }
}
function analyzeText(text) {
  const lower = String(text || '').toLowerCase()
  const hints = []
  const add = (title, suggestion) => { if (!hints.some((item) => item.title === title)) hints.push({ title, suggestion }) }
  if (/outofmemoryerror|java heap space/.test(lower)) add('内存不足', '在实例设置中提高最大内存（建议 6–12 GB），并关闭其他占用内存的程序。')
  if (/unsupportedclassversionerror/.test(lower)) add('Java 版本不匹配', '换用更高版本的 64 位 Java（17/21），并在实例设置中指定。')
  if (/noclassdeffounderror|classnotfoundexception|nosuchmethoderror|incompatibleclasschangeerror/.test(lower)) add('模组或库不兼容', '检查崩溃报告里的模组列表，移除刚安装或版本不匹配的模组，并补齐前置。')
  if (/modresolutionexception|missing or unsupported mandatory dependencies|incompatible mod set/.test(lower)) add('模组依赖不完整', '安装缺失的前置，确认所有模组都支持当前 MC 与加载器版本。')
  if (/pixel format not accelerated|glfw error|opengl|failed to create window/.test(lower)) add('图形驱动问题', '更新显卡驱动；笔记本尝试指定独显运行 java.exe；远程桌面可能没有可用的 OpenGL。')
  if (/accessdeniedexception|securityexception/.test(lower)) add('文件权限被拒绝', '检查杀毒软件是否拦截了游戏目录，避免把游戏放在受保护的系统目录。')
  if (/unknownhostexception|connection reset|sockettimeoutexception|sslhandshakeexception/.test(lower)) add('网络连接失败', '检查网络与代理设置；确认资源文件已下载完整后再启动。')
  return hints.slice(0, 5)
}
function createLife() {
  const timers = new Map()
  const listeners = []
  const cleanups = []
  let dead = false
  return {
    get dead() { return dead },
    every(fn, ms) {
      const id = setInterval(() => { if (!dead) Promise.resolve().then(fn).catch(() => {}) }, ms)
      timers.set(id, 'interval')
      return id
    },
    later(fn, ms) {
      const id = setTimeout(async () => {
        timers.delete(id)
        if (dead) return
        try { await fn() } catch { /* 定时任务自行处理错误 */ }
      }, ms)
      timers.set(id, 'timeout')
      return id
    },
    on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts)
      listeners.push([target, type, fn, opts])
      return () => target.removeEventListener(type, fn, opts)
    },
    cleanup(fn) { if (typeof fn === 'function') cleanups.push(fn) },
    destroy() {
      if (dead) return
      dead = true
      for (const [id, kind] of timers) kind === 'interval' ? clearInterval(id) : clearTimeout(id)
      timers.clear()
      for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts)
      listeners.length = 0
      for (const fn of cleanups.splice(0)) { try { fn() } catch {} }
    }
  }
}
function makeTools(ctx = {}) {
  const life = createLife()
  const inst = ctx.instance || {}
  return {
    ctx, life, inst,
    api: ctx.api || launcherApi,
    id: String(inst.id || ''),
    toast: typeof ctx.toast === 'function' ? ctx.toast : toastDefault,
    confirm: typeof ctx.confirm === 'function' ? ctx.confirm : (message, opts) => confirmDialog(message, opts),
    modal: typeof ctx.openModal === 'function' ? ctx.openModal : openModalDefault,
    openPath: typeof ctx.openPath === 'function' ? ctx.openPath : openPathDefault,
    reloadInstance: async () => {
      if (typeof ctx.reloadInstance !== 'function') return
      try { await ctx.reloadInstance() } catch { /* 侧栏刷新失败不影响内容页 */ }
    }
  }
}

/* --- 模组 --- */
async function mountMods(container, t) {
  let data = {}
  let query = ''
  let filter = 'all'
  let mutating = false
  const updateState = { loading: false, data: null, error: '' }
  const depState = { loading: false, data: null, error: '', started: false }
  const searchInput = input({ placeholder: '搜索名称、modid 或文件名', onInput: () => { query = searchInput.value.trim().toLowerCase(); paint() } })
  Object.assign(searchInput.style, { flex: '1 1 200px', minWidth: '150px' })
  const count = tip('')
  const updateHint = tip('')
  const depsPanel = h('div', { class: 'lp-deps' })
  const list = h('div', { class: 'lp-list lp-mod-list' })
  const openFolder = () => t.openPath(data.dir || t.inst.paths?.modsDir || '')
  const refresh = async () => { await load(false); await t.reloadInstance() }
  const openInstall = (initialQuery = '') => openContentInstall(t, 'mods', refresh, { initialQuery })
  const importOne = async () => {
    const file = await chooseFiles({ accept: '.jar,.zip', title: '选择模组 JAR' })
    if (file) await uploadFiles(t, 'mods', [file], () => load(false))
  }
  const updateAllBtn = btn('全部更新', { size: 'sm', iconName: 'download', disabled: true, onClick: () => updateAll() })
  const checkBtn = btn('检查更新', { size: 'sm', iconName: 'refresh', onClick: () => checkUpdates(true) })
  const dedupeLabel = h('span', {}, '整理重复')
  const dedupeBtn = btn(dedupeLabel, { size: 'sm', iconName: 'copy', onClick: () => openDedupe() })
  container.appendChild(tabEl(
    barEl(searchInput, seg([['all', '全部'], ['enabled', '已启用'], ['disabled', '已禁用'], ['duplicate', '重复']], 'all', (value) => { filter = value; paint() }), spacer(), count,
      checkBtn, updateAllBtn, dedupeBtn,
      btn('打开 mods 文件夹', { size: 'sm', iconName: 'folder-open', onClick: openFolder }),
      btn('导入 JAR', { size: 'sm', iconName: 'upload', onClick: importOne }),
      btn('安装模组', { size: 'sm', variant: 'primary', iconName: 'package-down', onClick: () => openInstall() })),
    tip('启停会重命名 .jar / .jar.disabled；删除不可撤销。拖入 JAR 可直接导入。'),
    depsPanel,
    updateHint,
    list
  ))
  bindDrop(t, list, (files) => uploadFiles(t, 'mods', files, () => load(false)))
  const load = makeLoader(t, list, {
    text: '正在读取模组…',
    title: '无法读取模组',
    request: () => t.api.content(t.id, 'mods'),
    render: (result) => {
      data = result
      paint()
      const missing = data.missingDependencies || []
      if (missing.length) loadDependencies()
      else { depState.data = null; depState.started = false; paintDependencies() }
    }
  })
  function updateMap() {
    const map = new Map()
    for (const item of updateState.data?.updates || []) map.set(item.relPath, item)
    return map
  }
  function paint() {
    const all = data.items || []
    const missing = data.missingDependencies || []
    const updates = updateState.data?.updates || []
    const duplicateGroups = Number(data.duplicateGroups) || 0
    const duplicateItems = Number(data.duplicateItems) || 0
    count.textContent = `共 ${data.total ?? all.length} · 启用 ${data.enabled ?? 0} · 禁用 ${data.disabled ?? 0}` +
      (duplicateGroups ? ` · 重复 ${duplicateGroups} 组` : '') +
      (updates.length ? ` · ${updates.length} 个可更新` : '') +
      (missing.length ? ` · 缺少 ${missing.length} 个前置` : '')
    dedupeLabel.textContent = duplicateGroups ? `整理重复 (${duplicateGroups})` : '整理重复'
    dedupeBtn.title = duplicateGroups
      ? `${duplicateGroups} 组重复 · ${duplicateItems} 个多余文件，可筛选后选择保留或一键删除`
      : '扫描重复模组；没有重复时只显示提示'
    dedupeBtn.classList.toggle('has-dup', duplicateGroups > 0)
    paintUpdates()
    const map = updateMap()
    const items = all.filter((item) =>
      (filter === 'all'
        || (filter === 'enabled' ? !item.disabled : filter === 'disabled' ? item.disabled : !!item.duplicateGroup)) &&
      (!query || [item.name, item.modid, item.file, ...(item.modids || [])].join(' ').toLowerCase().includes(query)))
    if (!items.length) {
      const duplicateView = filter === 'duplicate'
      list.replaceChildren(emptyBlock(
        all.length ? (duplicateView && !query ? '没有重复模组' : '没有匹配的模组') : '还没有安装模组',
        all.length
          ? (duplicateView && !query ? '当前实例里每个模组都只有一个文件，不需要整理。' : '换个关键词，或把筛选切回“全部”。')
          : '拖入 JAR，或点击“安装模组”从 Modrinth / CurseForge 搜索。',
        all.length
          ? btn('清除筛选', { size: 'sm', onClick: () => { query = ''; filter = 'all'; searchInput.value = ''; paint() } })
          : btn('安装模组', { size: 'sm', variant: 'primary', iconName: 'package-down', onClick: () => openInstall() }),
        duplicateView && !query ? 'check' : 'puzzle'))
      return
    }
    fillList(list, items, null, (item) => modItem(item, map.get(item.relPath)))
  }
  function paintUpdates() {
    const updates = updateState.data?.updates || []
    const unknown = updateState.data?.unknown || []
    updateAllBtn.disabled = updateState.loading || !updates.length
    updateHint.className = 'lp-hint'
    if (updateState.loading) {
      updateHint.replaceChildren(spinner(11), h('span', {}, ' 正在通过 Modrinth 文件哈希检查更新…'))
      return
    }
    if (updateState.error) {
      updateHint.className = 'lp-hint bad'
      updateHint.textContent = '检查更新失败：' + updateState.error
      return
    }
    if (!updateState.data) { updateHint.textContent = ''; return }
    const unknownText = unknown.length ? ` · ${unknown.length} 个模组未在 Modrinth 收录（多为 CurseForge 独占），无法自动检查` : ''
    updateHint.textContent = updates.length
      ? `发现 ${updates.length} 个可更新模组${unknownText}`
      : `没有可更新的模组${unknownText}`
  }
  function modItem(item, upd) {
    const label = item.name || item.file
    const env = ENV[item.environment] || ENV['*']
    const missing = item.missingDependencies || []
    const toggle = switchBox(!item.disabled, async (checked, box) => {
      if (mutating) { box.checked = !checked; return }
      mutating = true
      box.disabled = true
      try {
        await t.api.toggleMod(t.id, item.relPath, checked)
        t.toast(`${checked ? '已启用' : '已禁用'} ${label}`, 'ok')
        await load(false)
        await t.reloadInstance()
      } catch (error) {
        box.checked = !checked
        t.toast('切换失败：' + error.message, 'err')
      } finally {
        mutating = false
        box.disabled = false
      }
    }, item.disabled ? '启用模组' : '禁用模组')
    return rowEl('lp-mod-row' + (item.disabled ? ' is-disabled' : ''),
      toggle.el,
      iconTile('puzzle'),
      mainEl(
        titleEl(h('b', { title: label }, label), badge(env[0], env[1]),
          item.version ? chip('v' + item.version, 'lp-chip mono') : null,
          upd ? badge('可更新 ' + (upd.latest?.number || ''), 'accent') : null,
          item.duplicateGroup
            ? (item.duplicateKeep
              ? badge('重复 · 建议保留', 'accent')
              : badge('重复', 'warn'))
            : null,
          item.loaderMismatch ? badge('加载器不匹配', 'warn') : null,
          missing.length && !item.loaderMismatch ? badge('缺少依赖', 'bad') : null),
        metaEl([item.modid, item.loader ? (MOD_LOADER_LABELS[item.loader] || item.loader) : null, item.file, fmtBytes(item.size), fmtAgo(item.mtime)]),
        item.loaderMismatch
          ? tip(`这是 ${MOD_LOADER_LABELS[item.loader] || item.loader || '其它加载器'} 模组，当前实例是 ${MOD_LOADER_LABELS[t.inst?.loader] || t.inst?.loader || '原版'}；游戏不会加载它，已忽略它的依赖缺失。`)
          : missing.length ? tip('缺少前置：' + missing.join('、')) : null
      ),
      actEl(
        upd ? btn('更新', { size: 'xs', variant: 'primary', iconName: 'download', onClick: () => updateOne(item) }) : null,
        iconBtn('folder-open', { size: 13, label: '打开 mods 文件夹', onClick: openFolder }),
        iconBtn('trash', { size: 13, label: '删除模组', onClick: () => removeMod(item, label) })
      ))
  }
  async function removeMod(item, label) {
    if (mutating) return
    mutating = true
    await deleteFlow(t, {
      message: '删除后无法恢复，请确认没有其他整合包或存档依赖这个文件。',
      title: `删除模组「${label}」`,
      okMessage: `已删除 ${label}`,
      task: () => t.api.deleteMod(t.id, item.relPath),
      after: async () => { await load(false); await t.reloadInstance() }
    })
    mutating = false
  }

  /* ---------------- 重复模组整理 ---------------- */
  async function openDedupe() {
    const report = { loading: true, error: '', data: null }
    const selection = new Map()
    const rowSyncs = new Map()
    let query = ''
    let kind = 'all'
    let busy = false

    const summary = h('div', { class: 'lp-dedupe-summary' })
    const search = input({ placeholder: '搜索模组名、文件名或 modid', onInput: () => { query = search.value.trim().toLowerCase(); paint() } })
    search.style.flex = '1 1 220px'
    search.style.minWidth = '150px'
    const kindSeg = seg(
      [['all', '全部'], ['identical', '内容相同'], ['version', '版本不同']],
      'all',
      (value) => { kind = value; paint() }
    )
    const groupsBox = h('div', { class: 'lp-dedupe-groups' })
    const toolbar = h('div', { class: 'lp-dedupe-toolbar' }, search, kindSeg, spacer(),
      btn('恢复推荐', { size: 'xs', iconName: 'wand', onClick: () => { resetSelection(); paint() } }))
    const body = h('div', { class: 'lp-dedupe' }, summary, toolbar, groupsBox)
    const modal = t.modal({ title: '一键整理重复模组', size: 'lg', body })
    const cancelBtn = btn('取消', { class: 'btn-ghost', onClick: () => modal.close() })
    const disableLabel = h('span', {}, '禁用多余')
    const deleteLabel = h('span', {}, '删除多余')
    const disableBtn = btn(disableLabel, { iconName: 'eye-off', disabled: true, onClick: () => apply('disable') })
    const deleteBtn = btn(deleteLabel, { variant: 'danger', iconName: 'trash', disabled: true, onClick: () => apply('delete') })
    modal.foot.append(cancelBtn, disableBtn, deleteBtn)

    function resetSelection() {
      selection.clear()
      for (const group of report.data?.groups || []) {
        selection.set(group.id, { keep: group.keep, checked: true })
      }
    }

    function selectedPlan() {
      const plan = []
      for (const group of report.data?.groups || []) {
        const state = selection.get(group.id)
        if (!state?.checked || !state.keep) continue
        const remove = group.items
          .filter((item) => item.relPath !== state.keep)
          .map((item) => item.relPath)
        if (remove.length) plan.push({ keep: state.keep, remove })
      }
      return plan
    }

    function matches(group) {
      if (kind === 'identical' && group.kind !== 'identical') return false
      if (kind === 'version' && group.kind !== 'version') return false
      if (!query) return true
      const text = [group.label, group.modid, ...group.items.map((item) => item.file)]
        .join(' ').toLowerCase()
      return text.includes(query)
    }

    function updateFoot() {
      const groups = report.data?.groups || []
      const plan = selectedPlan()
      const removeCount = plan.reduce((sum, group) => sum + group.remove.length, 0)
      disableLabel.textContent = removeCount ? `禁用多余 (${removeCount})` : '禁用多余'
      deleteLabel.textContent = removeCount ? `删除多余 (${removeCount})` : '删除多余'
      disableBtn.disabled = busy || !removeCount
      deleteBtn.disabled = busy || !removeCount
      cancelBtn.disabled = busy
      if (!report.data) return
      summary.replaceChildren(
        h('div', { class: 'lp-dedupe-summary-main' },
          icon('copy', { size: 15 }),
          h('b', {}, `发现 ${groups.length} 组重复模组`),
          h('span', {}, `${report.data.duplicateItems || 0} 个多余文件 · 可回收 ${fmtBytes(report.data.reclaimBytes || 0)}`)),
        h('div', { class: 'lp-dedupe-summary-pick' }, `已选 ${plan.length}/${groups.length} 组 · 将处理 ${removeCount} 个文件`)
      )
    }

    function paint() {
      clear(groupsBox)
      rowSyncs.clear()
      if (report.loading) {
        summary.replaceChildren(h('div', { class: 'lp-dedupe-summary-main' }, spinner(12), h('span', {}, '正在扫描模组并比对文件内容…')))
        groupsBox.appendChild(h('div', { class: 'lp-tab-loading' }, spinner(13), '正在读取模组元数据与文件哈希…'))
        updateFoot()
        return
      }
      if (report.error) {
        summary.replaceChildren(h('div', { class: 'lp-hint bad' }, '扫描失败：' + report.error))
        groupsBox.appendChild(failBlock('无法扫描重复模组', report.error, () => { void reload() }))
        updateFoot()
        return
      }
      const groups = report.data?.groups || []
      if (!groups.length) {
        summary.replaceChildren(h('div', { class: 'lp-dedupe-summary-main' }, icon('check', { size: 15 }), h('b', {}, '没有重复模组')))
        groupsBox.appendChild(emptyBlock('没有重复模组', '当前实例里每个模组都只有一个文件，不需要整理。', null, 'check'))
        updateFoot()
        return
      }
      const visible = groups.filter(matches)
      if (!visible.length) {
        summary.replaceChildren()
        groupsBox.appendChild(emptyBlock('没有匹配的重复组', '换个关键词，或把筛选切回“全部”。', null, 'filter'))
        updateFoot()
        return
      }
      for (const group of visible) groupsBox.appendChild(groupCard(group))
      updateFoot()
    }

    function groupCard(group) {
      const state = selection.get(group.id)
      const card = h('div', { class: 'lp-dedupe-group' + (state?.checked ? '' : ' is-off') })
      const checkbox = h('input', { type: 'checkbox', 'aria-label': '处理这一组' })
      checkbox.checked = state?.checked !== false
      checkbox.onchange = () => {
        const target = selection.get(group.id)
        if (target) target.checked = checkbox.checked
        card.classList.toggle('is-off', !checkbox.checked)
        updateFoot()
      }
      const head = h('div', { class: 'lp-dedupe-head' },
        h('label', { class: 'lp-inline-check' }, checkbox, '处理'),
        h('div', { class: 'lp-dedupe-group-title' },
          h('b', { title: group.label }, group.label),
          group.modid ? h('span', { class: 'lp-dedupe-modid mono' }, group.modid) : null,
          group.kind === 'identical' ? badge('内容完全相同', 'warn')
            : group.kind === 'version' ? badge('版本不同', 'accent')
              : badge('版本相同', '')),
        h('span', { class: 'lp-dedupe-reclaim mono' }, `可回收 ${fmtBytes(group.reclaimSize)}`)
      )
      const rows = h('div', { class: 'lp-dedupe-items' })
      const syncs = []
      for (const item of group.items) rows.appendChild(itemRow(group, item, syncs))
      rowSyncs.set(group.id, syncs)
      card.append(head, rows)
      return card
    }

    function itemRow(group, item, syncs) {
      const radio = h('input', { type: 'radio', name: 'dedupe-' + group.id, value: item.relPath })
      const tag = h('span', { class: 'lp-dedupe-tag' })
      const recommended = item.relPath === group.keep
      const row = h('label', { class: 'lp-dedupe-item' },
        radio,
        h('span', { class: 'lp-dedupe-file mono', title: item.relPath }, item.file),
        h('span', { class: 'lp-dedupe-tags' },
          item.disabled ? badge('已禁用', 'warn') : badge('已启用', 'ok'),
          recommended ? badge(group.keepReason || '推荐保留', 'accent') : null,
          item.version ? chip('v' + item.version, 'lp-chip mono') : null),
        h('span', { class: 'lp-dedupe-meta mono' }, [fmtBytes(item.size), fmtAgo(item.mtime)].filter(Boolean).join(' · ')),
        tag
      )
      const sync = () => {
        const isKeep = selection.get(group.id)?.keep === item.relPath
        row.classList.toggle('is-keep', isKeep)
        row.classList.toggle('is-remove', !isKeep)
        tag.textContent = isKeep ? '保留' : '删除'
        tag.className = 'lp-dedupe-tag ' + (isKeep ? 'keep' : 'remove')
        radio.checked = isKeep
      }
      radio.onchange = () => {
        const target = selection.get(group.id)
        if (target) target.keep = item.relPath
        for (const fn of rowSyncs.get(group.id) || []) fn()
        updateFoot()
      }
      syncs.push(sync)
      sync()
      return row
    }

    async function reload() {
      report.loading = true
      report.error = ''
      report.data = null
      paint()
      try {
        report.data = await t.api.modDuplicates(t.id)
        resetSelection()
      } catch (error) {
        report.error = error.message
      } finally {
        report.loading = false
        if (body.isConnected) paint()
      }
    }

    async function apply(mode) {
      if (busy) return
      const plan = selectedPlan()
      if (!plan.length) { t.toast('没有选中要处理的重复文件', 'warn'); return }
      const removeCount = plan.reduce((sum, group) => sum + group.remove.length, 0)
      const verb = mode === 'disable' ? '禁用' : '删除'
      const ok = await t.confirm(
        `将${verb} ${removeCount} 个重复文件，每组保留 1 个（共 ${plan.length} 组）。\n\n` +
          (mode === 'disable'
            ? '禁用只是把文件改名为 .jar.disabled，随时可以在模组列表里重新启用。'
            : '删除后无法恢复；不确定时请先选「禁用多余」。'),
        { title: `${verb}重复模组`, danger: mode === 'delete', okText: verb }
      )
      if (!ok || !body.isConnected) return
      busy = true
      updateFoot()
      try {
        const result = await t.api.cleanModDuplicates(t.id, mode, plan)
        const done = result?.done?.length || 0
        const failed = result?.failed || []
        const skipped = result?.skipped?.length || 0
        t.toast(
          `${verb}了 ${done} 个重复文件` +
            (failed.length ? `，${failed.length} 个失败` : '') +
            (skipped ? `，${skipped} 个已跳过` : ''),
          failed.length ? 'warn' : 'ok'
        )
        if (failed.length) console.warn('[mods] 重复模组清理失败项', failed)
        modal.close()
        await load(false)
        await t.reloadInstance()
      } catch (error) {
        t.toast(`${verb}失败：` + error.message, 'err')
      } finally {
        busy = false
        if (body.isConnected) updateFoot()
      }
    }

    void reload()
  }

  /* ---------------- 更新 ---------------- */
  async function checkUpdates(force = false) {
    if (updateState.loading) return
    updateState.loading = true
    updateState.error = ''
    checkBtn.disabled = true
    paintUpdates()
    try {
      updateState.data = await t.api.modUpdates(t.id, force)
      const n = updateState.data?.updates?.length || 0
      if (n) t.toast(`发现 ${n} 个可更新模组`, 'ok')
    } catch (error) {
      updateState.error = error.message
      updateState.data = null
    } finally {
      if (t.life.dead) return
      updateState.loading = false
      checkBtn.disabled = false
      paint()
    }
  }
  async function submitUpdates(items) {
    const payload = items.map((upd) => ({
      relPath: upd.relPath,
      name: upd.name,
      url: upd.latest?.file?.url || '',
      filename: upd.latest?.file?.filename || '',
      sha1: upd.latest?.file?.sha1 || '',
      size: upd.latest?.file?.size || 0
    })).filter((item) => item.relPath && item.url && item.sha1)
    if (!payload.length) { t.toast('没有可用的更新文件', 'warn'); return }
    try {
      const result = await t.api.updateMods(t.id, payload)
      t.toast(`已开始更新 ${payload.length} 个模组`, 'ok')
      watchLauncherJob(t, result?.job?.id, async (ok, message) => {
        t.toast(message, ok ? 'ok' : 'err')
        if (!ok) return
        updateState.data = null
        await load(false)
        await t.reloadInstance()
        void checkUpdates(true)
      })
    } catch (error) { t.toast('更新失败：' + error.message, 'err') }
  }
  function updateOne(item) {
    const upd = updateMap().get(item.relPath)
    if (!upd) return
    void submitUpdates([upd])
  }
  function updateAll() {
    const updates = updateState.data?.updates || []
    if (!updates.length) return
    void submitUpdates(updates)
  }

  /* ---------------- 缺失前置 ---------------- */
  async function loadDependencies(force = false) {
    if (depState.loading) return
    if (!force && depState.started && depState.data) return
    depState.started = true
    depState.loading = true
    depState.error = ''
    paintDependencies()
    try {
      depState.data = await t.api.missingDependencies(t.id)
    } catch (error) {
      depState.error = error.message
    } finally {
      if (t.life.dead) return
      depState.loading = false
      paintDependencies()
    }
  }
  function paintDependencies() {
    clear(depsPanel)
    const missing = data.missingDependencies || []
    if (!missing.length) { depsPanel.style.display = 'none'; return }
    depsPanel.style.display = ''
    const head = h('div', { class: 'lp-deps-head' },
      icon('warning', { size: 15 }),
      h('div', { class: 'lp-deps-title' }, h('b', {}, `缺少 ${missing.length} 个前置依赖`),
        h('span', {}, '从 Modrinth 匹配并下载；自动结果不确定时会让你手动选择。')),
      h('div', { class: 'lp-row-actions' },
        btn('全部补全', {
          size: 'xs', variant: 'primary', iconName: 'download',
          disabled: !(depState.data?.items || []).some((item) => item.state === 'ready' && item.version?.file),
          onClick: () => completeAllDependencies()
        }),
        btn('重新匹配', { size: 'xs', iconName: 'refresh', onClick: () => loadDependencies(true) }))
    )
    depsPanel.appendChild(head)
    if (depState.loading) {
      depsPanel.appendChild(h('div', { class: 'lp-tab-loading' }, spinner(12), '正在匹配前置模组…'))
      return
    }
    if (depState.error) {
      depsPanel.appendChild(h('div', { class: 'lp-hint bad' }, '匹配失败：' + depState.error))
      return
    }
    const items = depState.data?.items || []
    if (!items.length) {
      depsPanel.appendChild(h('div', { class: 'lp-hint' }, '没有可自动匹配的前置。'))
      return
    }
    for (const item of items) depsPanel.appendChild(dependencyRow(item))
  }
  function dependencyRow(item) {
    const project = item.project || {}
    const ready = item.state === 'ready' && item.version?.file?.url
    const iconEl = project.icon
      ? h('img', { class: 'lp-mod-result-icon', src: project.icon, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (event) => event.target.replaceWith(h('span', { class: 'lp-mod-result-icon' }, icon('puzzle', { size: 15 }))) })
      : h('span', { class: 'lp-mod-result-icon' }, icon('puzzle', { size: 15 }))
    let action
    if (ready) {
      action = btn('下载前置', { size: 'xs', variant: 'primary', iconName: 'download', onClick: (event) => installDependency(item, project, item.version, item.version.file, event.currentTarget) })
    } else if (item.state === 'ambiguous') {
      action = btn('选择匹配', { size: 'xs', iconName: 'search', onClick: () => chooseDependency(item) })
    } else {
      action = btn('手动搜索', { size: 'xs', iconName: 'search', onClick: () => openInstall(item.id) })
    }
    const detail = ready
      ? `匹配到 ${project.title || item.id} · ${item.version.number || item.version.name || ''}`
      : item.state === 'error' ? '查询失败：' + (item.message || '') : '未找到明确匹配，请手动确认'
    return h('div', { class: 'lp-row lp-dep-row' },
      iconEl,
      mainEl(
        titleEl(h('b', {}, item.id), badge(ready ? '可自动补全' : item.state === 'ambiguous' ? '需要确认' : '未匹配', ready ? 'ok' : item.state === 'ambiguous' ? 'warn' : 'bad')),
        tip(detail)
      ),
      actEl(action)
    )
  }
  async function installDependency(item, project, version, file, button) {
    if (!file?.url) { t.toast('没有可用的下载文件', 'warn'); return }
    if (button) button.disabled = true
    try {
      const job = await coreApi.post('/api/community/download', {
        url: file.url,
        filename: file.filename || file.name,
        dir: data.dir || t.inst.paths?.modsDir,
        preserveName: true,
        exactDir: true,
        title: `前置 ${project?.title || item.id} ${version?.number || version?.name || ''}`.trim(),
        meta: {
          project: project?.title || item.id,
          version: version?.number || version?.name || '',
          loader: t.inst.loader || '',
          gameversion: t.inst.mc || '',
          type: 'mod',
          source: 'modrinth',
          instanceId: t.id
        }
      })
      t.toast('已加入前置下载：' + (project?.title || item.id), 'ok')
      watchDownload(t, job?.id, async (ok, message) => {
        t.toast(message, ok ? 'ok' : 'err')
        if (!ok) { if (button) button.disabled = false; return }
        await load(false)
        await t.reloadInstance()
        loadDependencies(true)
      })
    } catch (error) {
      if (button) button.disabled = false
      t.toast('下载前置失败：' + error.message, 'err')
    }
  }
  function completeAllDependencies() {
    const ready = (depState.data?.items || []).filter((item) => item.state === 'ready' && item.version?.file?.url)
    if (!ready.length) { t.toast('没有可自动补全的前置', 'warn'); return }
    t.toast(`正在补全 ${ready.length} 个前置…`, 'ok')
    for (const item of ready) void installDependency(item, item.project, item.version, item.version.file)
  }
  function chooseDependency(item) {
    const candidates = item.candidates || []
    if (!candidates.length) { openInstall(item.id); return }
    const listEl = h('div', { class: 'lp-list', style: { maxHeight: '56vh', overflowY: 'auto' } })
    const modal = t.modal({
      title: `选择前置：${item.id}`,
      size: 'lg',
      body: h('div', { class: 'col', style: { gap: '6px' } },
        tip('没有找到完全同名项目，请选择实际提供该模组 ID 的前置。'),
        listEl),
      buttons: [{ label: '关闭', class: 'btn-ghost' }]
    })
    for (const hit of candidates) {
      const choose = btn('使用这个', { size: 'xs', variant: 'primary', onClick: async (event) => {
        event.currentTarget.disabled = true
        try {
          const params = new URLSearchParams({ source: 'modrinth', id: hit.id })
          if (t.inst.mc) params.set('gameVersion', t.inst.mc)
          if (t.inst.loader && t.inst.loader !== 'vanilla') params.set('loader', t.inst.loader)
          const versions = await coreApi.get('/api/community/versions?' + params)
          const version = (versions || []).find((entry) => (entry.files || []).length)
          const file = version?.files?.find((entry) => entry.primary) || version?.files?.[0]
          if (!version || !file) throw new Error('这个项目没有适配当前版本的下载文件')
          modal.close()
          await installDependency(item, hit, version, file)
        } catch (error) {
          event.currentTarget.disabled = false
          t.toast('选择失败：' + error.message, 'err')
        }
      } })
      listEl.appendChild(h('div', { class: 'lp-row lp-mod-result' },
        hit.icon
          ? h('img', { class: 'lp-mod-result-icon', src: hit.icon, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
          : h('span', { class: 'lp-mod-result-icon' }, icon('puzzle', { size: 15 })),
        mainEl(titleEl(h('b', {}, hit.title || hit.slug || hit.id)), tip(hit.summary || ''), metaEl([hit.slug, `${Number(hit.downloads || 0).toLocaleString()} 次下载`])),
        choose))
    }
  }

  await load()
}

/** Modrinth / CurseForge 搜索与版本安装（模组 / 资源包 / 光影共用）。 */
const INSTALL_KINDS = {
  mods: { type: 'mod', label: '模组', icon: 'puzzle', title: '安装模组', loader: true },
  resourcepacks: { type: 'resourcepack', label: '资源包', icon: 'grid', title: '安装资源包', loader: false },
  shaderpacks: { type: 'shader', label: '光影', icon: 'wand', title: '安装光影', loader: false }
}

/** 读取 Mojang 版本清单失败时的内置常用版本（契约 §7）。 */
const MC_FALLBACK_VERSIONS = ['26.2', '26.1', '1.21.11', '1.21.8', '1.21.4', '1.21.1', '1.20.1', '1.20', '1.19.4', '1.18.2', '1.17.1', '1.16.5', '1.12.2', '1.8.9']

function openContentInstall(t, kind, onDone, { initialQuery = '' } = {}) {
  const conf = INSTALL_KINDS[kind] || INSTALL_KINDS.mods
  const isMod = kind === 'mods'
  const instanceMc = String(t.inst.mc || '').trim()
  // 实例没有真实 MC 版本时不把实例名/目录名当版本传出去，避免用非法值筛选。
  const hasMc = isMinecraftVersion(instanceMc)
  const targetDir = isMod
    ? t.inst.paths?.modsDir
    : kind === 'resourcepacks' ? t.inst.paths?.resourcePacksDir : t.inst.paths?.shaderPacksDir
  let source = 'modrinth'
  let project = null
  let view = 'search'
  let seq = 0
  let versions = []
  let othersOpen = false
  let onlyCompatible = false
  let page = 1
  let total = 0
  let sort = 'relevance'
  const searchBox = input({ value: initialQuery, placeholder: `搜索${conf.label}名称…`, onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); search() } } })
  searchBox.style.flex = '1 1 200px'
  const status = tip('')
  const results = h('div', { class: 'lp-list', style: { maxHeight: '52vh', overflowY: 'auto' } })
  const sortSel = select(SEARCH_SORTS, sort, {
    ariaLabel: '排序方式',
    title: '排序方式：按下载量可优先查看热门资源',
    onchange: (value) => {
      sort = value
      search()
    }
  })
  sortSel.style.width = '132px'
  sortSel.style.flex = '0 0 auto'
  const pager = createPager({
    pageSize: SEARCH_PAGE_SIZE,
    onChange: (next) => { search({ page: next }) }
  })
  pager.el.hidden = true
  const sourceSeg = seg([['modrinth', 'Modrinth'], ['curseforge', 'CurseForge']], source, (value) => {
    source = value
    // 项目 ID 与来源绑定：切换来源后旧项目不再有效，直接回到搜索结果。
    project = null
    othersOpen = false
    onlyCompatible = false
    search()
  })
  const combo = versionCombo({
    value: hasMc ? instanceMc : '',
    instanceMc: hasMc ? instanceMc : '',
    versions: MC_FALLBACK_VERSIONS,
    title: '按 Minecraft 版本筛选',
    allLabel: '全部版本',
    currentLabel: '当前实例',
    onChange: () => {
      paintFilterLine()
      // 版本列表已经一次读全，切换筛选项只需本地重新分组，不重复请求。
      if (view === 'versions' && project) renderVersions()
      else search()
    }
  })
  // 输入框同时是筛选框：聚焦时清空文字以便浏览完整 Mojang 版本列表，
  // 没选就离开时还原成已选值（versionCombo 内部仍保留选中值）。
  const comboField = combo.el.querySelector('.lp-vc-input')
  if (comboField) {
    comboField.addEventListener('focus', () => {
      if (!comboField.value) return
      comboField.value = ''
      comboField.dispatchEvent(new Event('input', { bubbles: true }))
    })
    comboField.addEventListener('blur', () => {
      const selected = combo.getValue()
      if (selected && !String(comboField.value || '').trim()) comboField.value = selected
    })
  }
  const searchBtn = btn('搜索', {
    size: 'sm',
    variant: 'primary',
    iconName: 'search',
    onClick: () => {
      // 输入框里手动输入了合法版本时，先确认筛选条件再搜索，避免界面显示与请求不一致。
      const typed = String(comboField?.value || '').trim()
      const selected = combo.getValue()
      if (typed && typed !== selected) {
        if (!isMinecraftVersion(typed)) {
          combo.setError(`「${typed}」不是有效的 MC 版本号，请输入类似 1.21.8 或 26.3 的版本。`)
          return
        }
        combo.setValue(typed) // apply 内部会触发 onChange 重新搜索
        // 在版本列表页点“搜索”时，明确回到搜索结果，而不是只重新分组。
        if (view === 'versions') search()
        return
      }
      search()
    }
  })
  const searchBar = barEl(sourceSeg, combo.el, sortSel, searchBox, searchBtn)
  searchBar.style.border = '0'
  searchBar.style.padding = '0'
  const filterLine = h('div', { class: 'lp-filter-line' })
  const comboHint = h('div', { class: 'lp-hint', hidden: true })
  const noticeEl = h('div', { class: 'lp-form-note lp-version-notice', hidden: true })
  const loader = isMod && t.inst.loader && t.inst.loader !== 'vanilla' ? t.inst.loader : ''
  const vanillaWarning = isMod && !loader
    ? h('div', { class: 'lp-form-note lp-danger-note' }, '当前实例是原版，没有模组加载器；这里安装的 JAR 不会在游戏中生效。请先新建 Fabric / Forge / NeoForge 实例。')
    : null
  const modal = t.modal({
    title: conf.title,
    size: 'xl',
    body: h('div', { class: 'col', style: { gap: '8px' } }, searchBar, filterLine, comboHint, noticeEl, vanillaWarning, status, results, pager.el),
    buttons: [{ label: '关闭', class: 'btn-ghost' }],
    onClose: () => combo.destroy()
  })
  function filterMc() {
    return String(combo.getValue() || '').trim()
  }
  /** 结果区顶部的筛选条件，例如「筛选：1.21.8 · Fabric」。 */
  function paintFilterLine() {
    const summary = filterSummary({ mc: filterMc(), loader: isMod ? loader : '', kind })
    const extras = []
    if (!hasMc) {
      extras.push(h('span', {
        class: 'lp-vc-badge warn',
        title: '实例没有识别到真实的 MC 版本；安装记录会留空，建议先到实例设置里填写，例如 1.21.8。'
      }, '实例 MC 版本未知'))
    }
    // “筛选：”保持弱化颜色，具体条件用强调色，避免整行都是高亮。
    const value = summary.startsWith('筛选：') ? summary.slice(3) : summary
    filterLine.replaceChildren(h('span', {}, '筛选：'), h('b', {}, value), ...extras)
  }
  /** 接口返回的版本回退提示（例如版本未识别，已按全部版本搜索）。 */
  function setNotice(text = '') {
    const value = String(text || '').trim()
    noticeEl.hidden = !value
    noticeEl.replaceChildren(icon('warning', { size: 13 }), h('span', {}, value))
  }
  function showHint() {
    paintFilterLine()
    pager.el.hidden = true
    status.textContent = hasMc
      ? `按 ${filterMc() || '全部 MC 版本'} 过滤；点击结果选择版本。`
      : '当前实例没有识别到 MC 版本，默认按全部版本搜索；可在上方输入版本号，例如 1.21.8。'
    results.replaceChildren(emptyBlock(`搜索并选择${conf.label}`, `结果来自 Modrinth / CurseForge；安装会把文件下载到当前实例的对应目录。`, null, conf.icon))
  }
  async function search({ page: targetPage = 1 } = {}) {
    const token = ++seq
    page = Math.max(1, Math.round(Number(targetPage) || 1))
    searchBtn.disabled = true
    view = 'search'
    project = null
    versions = []
    paintFilterLine()
    setNotice('')
    status.textContent = '正在搜索…'
    results.replaceChildren(loadingBlock('正在搜索…'))
    // 请求期间先隐藏分页条，避免闪现上一页的页码；返回后统一刷新。
    pager.el.hidden = true
    const mc = filterMc()
    try {
      const params = new URLSearchParams({
        source,
        query: (searchBox.value || '').trim(),
        type: conf.type,
        limit: String(SEARCH_PAGE_SIZE),
        offset: String(pageOffset(page, SEARCH_PAGE_SIZE)),
        sort
      })
      params.set('gameVersion', mc || 'all')
      // 模组只用实例加载器筛选；其它类型显式传 none，避免服务端回落到默认加载器。
      if (loader) params.set('loader', loader)
      else params.set('loader', 'none')
      const data = await coreApi.get('/api/community/search?' + params)
      if (token !== seq || !modal.panel.isConnected) return
      const items = Array.isArray(data) ? data : (data?.items || [])
      // 服务端识别失败时会回退全部版本并给出中文说明，这里原样提示。
      setNotice(!Array.isArray(data) ? data?.gameVersionNotice : '')
      total = Array.isArray(data) ? items.length : (data?.total ?? items.length)
      // 页大小固定为 limit，服务端 total 是总命中数；两者一起换算总页数。
      status.textContent = `共 ${total} 个结果 · 点击查看匹配版本`
      fillList(results, items, emptyBlock('没有搜索结果',
        source === 'curseforge'
          ? 'CurseForge 需要 API Key，可在“设置 → 社区资源”里配置。'
          : mc ? `该内容没有适配 ${mc} 的结果；可把版本筛选切到“全部版本”再试。` : '换个关键词，或把版本筛选切到“全部版本”。',
        null, 'search'), hitRow)
      pager.set({ page, total, count: items.length, loading: false })
      pager.el.hidden = false
    } catch (error) {
      if (token !== seq) return
      status.textContent = ''
      pager.el.hidden = true
      results.replaceChildren(failBlock('搜索失败', error, search))
    } finally {
      if (token === seq) searchBtn.disabled = false
    }
  }
  function hitRow(hit) {
    const cover = hit.icon
      ? h('img', { class: 'lp-mod-result-icon', src: hit.icon, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (event) => { event.target.style.visibility = 'hidden' } })
      : h('span', { class: 'lp-mod-result-icon' }, icon(conf.icon, { size: 16 }))
    const open = () => openProject(hit)
    return h('div', { class: 'lp-row lp-mod-result', role: 'button', tabindex: '0', onclick: open, onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() } } },
      cover,
      mainEl(
        titleEl(h('b', { title: hit.title }, hit.title), hit.author ? tip(hit.author) : null),
        h('p', { class: 'lp-hint', style: { margin: 0 } }, hit.summary || ''),
        metaEl([`${Number(hit.downloads || 0).toLocaleString()} 次下载`, '更新于 ' + agoOf(hit.updated)])
      ),
      chip('查看版本')
    )
  }
  /** 读取项目的全部版本（不按 MC / 加载器过滤，交给前端分组，才能“查看全部版本”）。 */
  async function fetchVersions(hit) {
    const params = new URLSearchParams({ source, id: String(hit?.id || '') })
    const data = await coreApi.get('/api/community/versions?' + params)
    const items = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : [])
    const notice = Array.isArray(data) ? '' : String(data?.gameVersionNotice || '')
    return { items: items.filter(Boolean), notice }
  }
  function backBar(hit) {
    const back = barEl(btn('返回搜索结果', { size: 'sm', iconName: 'arrow-left', onClick: () => search({ page }) }), h('b', { style: { fontSize: '12px' } }, hit?.title || '版本列表'))
    back.style.border = '0'
    back.style.padding = '0'
    return back
  }
  async function openProject(hit) {
    const token = ++seq
    view = 'versions'
    project = hit
    versions = []
    pager.el.hidden = true
    othersOpen = false
    onlyCompatible = false
    paintFilterLine()
    setNotice('')
    status.textContent = `正在读取「${hit.title || ''}」的版本…`
    results.replaceChildren(loadingBlock('正在读取版本列表…'))
    const back = backBar(hit)
    try {
      const data = await fetchVersions(hit)
      if (token !== seq || !modal.panel.isConnected) return
      versions = data.items
      setNotice(data.notice)
      renderVersions(back)
    } catch (error) {
      if (token !== seq) return
      status.textContent = ''
      results.replaceChildren(backBar(hit), failBlock('读取版本失败', error))
    }
  }
  /** 当前实例可用：MC 与实例一致，且模组加载器明确匹配（不靠猜测）。 */
  function isCurrentVersion(version, mc) {
    if (!hasMc || !mc || mc !== instanceMc) return false
    if (!compatibleVersion(version, { mc: instanceMc, loader: isMod ? loader : '', kind })) return false
    if (kind !== 'mods') return true
    if (!loader) return false // 原版实例无法加载模组，不能标成可用
    const loaders = Array.isArray(version?.loaders) ? version.loaders.map((item) => String(item).toLowerCase()) : []
    return loaders.includes(String(loader).toLowerCase())
  }
  /** 折叠的不兼容版本组：默认收起，展开后才创建行，避免一次渲染上百条。 */
  function otherVersionsGroup(rows) {
    const list = h('div', { class: 'lp-version-list', hidden: !othersOpen },
      ...(othersOpen ? rows.map((version) => versionRow(version)) : []))
    const toggle = h('button', {
      class: 'lp-version-group-toggle',
      type: 'button',
      'aria-expanded': String(othersOpen),
      title: othersOpen ? '收起其他 MC 版本的版本文件' : '展开其他 MC 版本的版本文件',
      onclick: () => { othersOpen = !othersOpen; renderVersions() }
    },
    icon(othersOpen ? 'chevron-down' : 'chevron-right', { size: 12 }),
    h('span', {}, `其他版本（${rows.length}）`),
    h('b', {}, othersOpen ? '收起' : '展开'))
    return h('div', { class: 'lp-version-group' }, toggle, list)
  }
  function renderVersions(back = null) {
    if (!project) return
    const head = back || backBar(project)
    const mc = filterMc()
    const total = versions.length
    if (!total) {
      status.textContent = '该内容没有可用的版本文件'
      results.replaceChildren(head, emptyBlock('没有可用的版本',
        '该项目暂时没有公开的下载文件，换一个项目或来源再试。',
        btn('返回搜索结果', { size: 'sm', onClick: () => search() }), 'filter'))
      return
    }
    if (!mc) {
      // 选了“全部版本”就无法判断适配性：平铺全部版本，不伪造“当前实例可用”。
      status.textContent = `共 ${total} 个版本 · 当前筛选为全部 MC 版本`
      results.replaceChildren(head, h('div', { class: 'lp-version-group' },
        h('div', { class: 'lp-version-group-head' },
          h('span', {}, '全部版本'),
          h('span', { class: 'badge' }, `${total} 个`)),
        tip(`当前筛选为“全部 MC 版本”，未按实例版本分组；安装记录仍使用实例版本 ${instanceMc || '未知'}。`),
        h('div', { class: 'lp-version-list' }, ...versions.map((version) => versionRow(version)))
      ))
      return
    }
    const partition = partitionVersions(versions, { mc, loader: isMod ? loader : '', kind })
    const compatible = partition.compatible
    const others = partition.others
    if (!compatible.length) {
      status.textContent = `${project.title || ''} · 没有适配 ${mc} 的版本（共 ${total} 个）`
      const empty = h('div', { class: 'lp-version-empty' },
        h('b', {}, `该内容没有适配 ${mc} 的版本`),
        h('p', {}, `该项目共有 ${total} 个版本文件，可能只支持其它 MC 版本或加载器。${instanceMc && instanceMc !== mc ? `安装到实例时会记录为 ${instanceMc}。` : ''}`),
        othersOpen ? null : btn('查看全部版本', { size: 'sm', variant: 'primary', iconName: 'list', onClick: () => { othersOpen = true; renderVersions() } })
      )
      const group = h('div', { class: 'lp-version-group' },
        h('div', { class: 'lp-version-group-head' },
          h('span', {}, `适配 ${mc} 的版本`),
          h('span', { class: 'badge' }, '0 个')),
        empty
      )
      results.replaceChildren(head, group, ...(othersOpen && others.length ? [otherVersionsGroup(others)] : []))
      return
    }
    status.textContent = `${project.title || ''} · 适配 ${mc} 的版本 ${compatible.length} 个 · 共 ${total} 个版本`
    const switchBtn = btn(onlyCompatible ? '显示全部版本' : '只看适配版本', {
      size: 'xs',
      variant: 'ghost',
      iconName: onlyCompatible ? 'list' : 'filter',
      title: onlyCompatible ? '显示其它 MC 版本的版本文件' : '只显示适配当前筛选的版本',
      onClick: () => { onlyCompatible = !onlyCompatible; renderVersions() }
    })
    const groupHead = h('div', { class: 'lp-version-group-head' },
      h('span', {}, `适配 ${mc} 的版本`),
      h('span', { class: 'badge ok' }, `${compatible.length} 个`),
      kind === 'mods' && loader ? h('span', { class: 'lp-vc-badge accent', title: '当前实例加载器' }, loaderLabel(t.inst)) : null,
      switchBtn
    )
    const compatibleGroup = h('div', { class: 'lp-version-group' }, groupHead,
      h('div', { class: 'lp-version-list' }, ...compatible.map((version) => versionRow(version, {
        compatible: true,
        current: isCurrentVersion(version, mc),
        recommended: String(version.id) === partition.recommendedId
      }))))
    const extra = !onlyCompatible && others.length ? [otherVersionsGroup(others)] : []
    results.replaceChildren(head, compatibleGroup, ...extra)
  }
  function versionRow(version, { compatible = false, current = false, recommended = false } = {}) {
    const file = (version.files || []).find((item) => item.primary) || (version.files || [])[0]
    const installBtn = btn('安装到实例', { size: 'sm', variant: 'primary', iconName: 'download', disabled: !file })
    if (file) installBtn.onclick = () => install(version, file, installBtn)
    const tags = versionTagBadges(version, { mc: filterMc(), loader: isMod ? loader : '', kind, recommended, current })
      .map((item) => h('span', { class: 'badge ' + (item.tone || ''), title: item.title }, item.text))
    return rowEl('lp-mod-version' + (compatible ? ' is-compatible' : '') + (current ? ' is-current' : '') + (recommended ? ' is-recommended' : ''),
      mainEl(
        titleEl(h('b', { title: version.name || version.number || '' }, version.name || version.number || '未命名版本'),
          version.type ? badge(KINDS[version.type] || version.type) : null,
          ...tags,
          file ? chip(fmtBytes(file.size), 'lp-chip mono') : null),
        metaEl([(version.gameVersions || []).join(', '), (version.loaders || []).join(', '), version.date ? '发布于 ' + agoOf(version.date) : '']),
        file ? h('div', { class: 'lp-hint mono', title: file.name }, file.name) : tip('没有可用的下载文件')
      ),
      actEl(installBtn)
    )
  }
  /** 版本下拉的数据源：Mojang 版本清单；失败时退回内置常用版本，并说明原因。 */
  async function loadComboVersions() {
    try {
      const data = await coreApi.get('/api/launcher/versions?type=all&limit=400')
      if (t.life.dead || !modal.panel.isConnected) return
      const list = Array.isArray(data) ? data : (data?.items || [])
      const ids = list
        .map((item) => String(typeof item === 'string' ? item : item?.id || '').trim())
        .filter((id) => isMinecraftVersion(id))
      if (!ids.length) throw new Error('宁愿用内置列表，也不使用空版本清单')
      combo.setVersions(ids)
      comboHint.hidden = true
    } catch (error) {
      if (t.life.dead || !modal.panel.isConnected) return
      combo.setVersions(MC_FALLBACK_VERSIONS)
      comboHint.hidden = false
      comboHint.textContent = `未能读取 Mojang 版本列表（${error?.message || '网络不可用'}），已使用内置常用版本；也可以直接输入版本号。`
    }
  }
  async function install(version, file, button) {
    if (!project) return
    if (!targetDir) {
      t.toast(`缺少${conf.label}目录，无法安装`, 'err')
      button.disabled = false
      return
    }
    button.disabled = true
    try {
      const job = await coreApi.post('/api/community/download', {
        url: file.url,
        filename: file.name,
        dir: targetDir,
        preserveName: true,
        exactDir: true,
        title: `${project.title} ${version.number || version.name || ''}`.trim(),
        meta: {
          project: project.title,
          version: version.number || version.name || '',
          loader: t.inst.loader || '',
          // 必须写实例的真实 MC 版本（不能用实例名或筛选值）。
          gameversion: t.inst.mc || '',
          type: conf.type,
          source,
          instanceId: t.id
        }
      })
      modal.close()
      t.toast('已加入下载队列：' + (job?.filename || file.name), 'ok')
      watchDownload(t, job?.id, async (ok, message) => {
        t.toast(message, ok ? 'ok' : 'err')
        if (ok) await onDone?.()
      })
    } catch (error) {
      t.toast('下载失败：' + error.message, 'err')
      button.disabled = false
    }
  }
  showHint()
  search()
  void loadComboVersions()
}
function watchDownload(t, jobId, done) {
  if (!jobId) { done(true, '下载任务已提交'); return }
  let tries = 0
  const tick = async () => {
    if (t.life.dead) return
    try {
      const data = await coreApi.get('/api/community/jobs')
      const job = (data?.items || []).find((item) => item.id === jobId)
      if (!job) { done(true, '下载任务已结束'); return }
      if (job.status === 'done') { done(true, '已安装：' + (job.filename || '模组')); return }
      if (job.status === 'failed' || job.status === 'cancelled') { done(false, job.error || '下载失败'); return }
      if (++tries > 200) { done(false, '下载耗时过长，请到下载中心查看'); return }
      t.life.later(tick, 1000)
    } catch {
      if (++tries > 200) { done(false, '无法获取下载状态'); return }
      t.life.later(tick, 1500)
    }
  }
  t.life.later(tick, 800)
}

/** Poll a launcher install/update job until it finishes. */
function watchLauncherJob(t, jobId, done) {
  if (!jobId) { done?.(true, '任务已提交，请到下载中心查看进度'); return }
  let tries = 0
  const tick = async () => {
    if (t.life.dead) return
    try {
      const job = await t.api.job(jobId, 0)
      if (!job) { done?.(true, '任务已结束'); return }
      if (job.status === 'done') { done?.(true, '更新完成'); return }
      if (job.status === 'failed' || job.status === 'cancelled') { done?.(false, job.error || '任务已取消'); return }
      if (++tries > 900) { done?.(false, '任务耗时过长，请到下载中心查看'); return }
      t.life.later(tick, 1000)
    } catch {
      if (++tries > 900) { done?.(false, '无法获取任务状态'); return }
      t.life.later(tick, 1500)
    }
  }
  t.life.later(tick, 800)
}

/* --- 资源包 / 光影包 --- */
async function mountPacks(container, t, kind) {
  const isResource = kind === 'resourcepacks'
  const label = isResource ? '资源包' : '光影包'
  let data = {}
  let busy = false
  const count = tip('')
  const list = h('div', { class: 'lp-list lp-pack-list' })
  const openFolder = () => t.openPath(data.dir || (isResource ? t.inst.paths?.resourcePacksDir : t.inst.paths?.shaderPacksDir) || '')
  const openInstall = () => openContentInstall(t, kind, () => load(false))
  const importOne = async () => {
    const file = await chooseFiles({ accept: '.zip,.jar', title: `选择${label}文件` })
    if (file) await uploadFiles(t, kind, [file], () => load(false))
  }
  container.appendChild(tabEl(
    barEl(count, spacer(),
      btn('搜索下载', { size: 'sm', variant: 'primary', iconName: 'search', onClick: openInstall }),
      btn(`打开${label}文件夹`, { size: 'sm', iconName: 'folder-open', onClick: openFolder }),
      btn(`导入${label}`, { size: 'sm', iconName: 'upload', onClick: importOne })),
    tip(isResource
      ? '启用状态直接写入 options.txt；游戏运行中修改可能被游戏覆盖。拖入 ZIP 可直接导入。'
      : '光影需要 Iris / Oculus 等前置模组；安装后可在游戏内“视频设置 → 光影”里选择。拖入 ZIP 可直接导入。'),
    list
  ))
  bindDrop(t, list, (files) => uploadFiles(t, kind, files, () => load(false)))
  const load = makeLoader(t, list, {
    text: `正在读取${label}…`,
    title: `无法读取${label}`,
    request: () => t.api.content(t.id, kind),
    render: (result) => { data = result; paint() }
  })
  function paint() {
    const items = data.items || []
    count.textContent = `共 ${items.length} 个${label}`
    if (!items.length) {
      const empty = emptyBlock(`还没有${label}`, `把 ZIP 拖到这里，或从 Modrinth / CurseForge 搜索安装。`,
        h('div', { class: 'lp-row-actions' },
          btn('搜索下载', { size: 'sm', variant: 'primary', iconName: 'search', onClick: openInstall }),
          btn(`导入${label}`, {
            size: 'sm', iconName: 'upload',
            onClick: async () => {
              const file = await chooseFiles({ accept: '.zip,.jar', title: `选择${label}文件` })
              if (file) await uploadFiles(t, kind, [file], () => load(false))
            }
          })), isResource ? 'grid' : 'wand')
      list.replaceChildren(empty)
      return
    }
    fillList(list, items, null, packRow)
  }
  function packRow(item) {
    const toggle = isResource
      ? switchBox(!!item.enabled, (checked, box) => togglePack(item, checked, box), item.enabled ? '禁用资源包' : '启用资源包')
      : null
    return rowEl('lp-pack-row' + (isResource ? '' : ' no-toggle') + (isResource && item.enabled ? ' is-enabled' : ''),
      toggle?.el,
      iconTile(isResource ? 'grid' : 'wand'),
      mainEl(
        titleEl(h('b', { title: item.name }, item.name),
          isResource ? (item.enabled ? badge('已启用', 'ok') : badge('未启用')) : null),
        metaEl([fmtBytes(item.size), fmtAgo(item.mtime)])
      ),
      actEl(
        iconBtn('folder-open', { size: 13, label: `打开${label}文件夹`, onClick: openFolder }),
        iconBtn('trash', { size: 13, label: `删除${label}`, onClick: () => remove(item) })
      ))
  }
  async function togglePack(item, checked, box) {
    if (busy) { box.checked = !checked; return }
    busy = true
    box.disabled = true
    try {
      await t.api.setResourcePack(t.id, item.name, checked)
      item.enabled = checked
      t.toast(`${checked ? '已启用' : '已禁用'} ${item.name}`, 'ok')
      paint()
    } catch (error) {
      box.checked = !checked
      t.toast('切换失败：' + error.message, 'err')
    } finally {
      busy = false
      box.disabled = false
    }
  }
  async function remove(item) {
    if (busy) return
    busy = true
    await deleteFlow(t, {
      message: isResource
        ? '删除后无法恢复；如果它已在 options.txt 中启用，游戏可能会提示资源包丢失。'
        : '删除后无法恢复。',
      title: `删除${label}「${item.name}」`,
      okMessage: `已删除 ${item.name}`,
      task: () => t.api.deleteContent(t.id, kind, item.name),
      after: async () => { await load(false); await t.reloadInstance() }
    })
    busy = false
  }
  await load()
}

/* --- 世界 --- */
async function mountWorlds(container, t) {
  let data = { worlds: [] }
  let busy = false
  const count = tip('')
  const grid = h('div', { class: 'lp-grid lp-world-grid' })
  const openFolder = () => t.openPath(data.savesDir || t.inst.paths?.savesDir || '')
  container.appendChild(tabEl(
    barEl(count, spacer(),
      btn('刷新', { size: 'sm', iconName: 'refresh', onClick: () => load() }),
      btn('打开 saves 文件夹', { size: 'sm', iconName: 'folder-open', onClick: openFolder })),
    grid
  ))
  const load = makeLoader(t, grid, {
    text: '正在读取世界存档…',
    title: '无法读取世界列表',
    style: { gridColumn: '1 / -1' },
    request: () => t.api.content(t.id, 'worlds'),
    render: (result) => { data = result; paint() }
  })
  function paint() {
    const worlds = data.worlds || []
    count.textContent = `共 ${worlds.length} 个世界`
    if (!worlds.length) {
      const empty = emptyBlock('还没有世界存档', '启动游戏创建一个世界后，这里会显示版本、游戏模式与存档大小。', null, 'cube')
      empty.style.gridColumn = '1 / -1'
      grid.replaceChildren(empty)
      return
    }
    grid.replaceChildren(...worlds.map(worldCard))
  }
  function worldCard(world) {
    const name = world.levelName || world.name
    return h('article', { class: 'lp-card lp-world-card' },
      h('div', { class: 'lp-world-head' }, h('b', { class: 'lp-world-name', title: world.name }, name), chip(world.version || '?', 'lp-chip mono')),
      world.error
        ? tip('无法读取 level.dat：' + world.error)
        : h('div', { class: 'lp-world-meta' },
          h('span', {}, MODES[world.gameType] || '未知模式'),
          h('span', { class: 'lp-hint', title: fmtDateTime(world.lastPlayed) }, `上次游玩 ${fmtAgo(world.lastPlayed)}`),
          h('span', { class: 'lp-hint mono' }, `${fmtBytes(world.size)} · ${world.files || 0} 个文件`)),
      h('div', { class: 'lp-world-actions' },
        btn('打开文件夹', { size: 'sm', iconName: 'folder-open', onClick: () => t.openPath(world.path || data.savesDir || '') }),
        btn('删除', { size: 'sm', variant: 'danger', iconName: 'trash', onClick: () => removeWorld(world, name) }))
    )
  }
  async function removeWorld(world, name) {
    if (busy) return
    busy = true
    await deleteFlow(t, {
      message: '世界存档会从磁盘删除，且不会进入回收站。',
      title: `删除世界「${name}」`,
      okText: '删除世界',
      okMessage: `已删除世界 ${name}`,
      task: () => t.api.deleteContent(t.id, 'worlds', world.name),
      after: async () => { await load(false); await t.reloadInstance() }
    })
    busy = false
  }
  await load()
}

/* --- 截图 --- */
async function mountScreenshots(container, t) {
  let data = {}
  const count = tip('')
  const grid = h('div', { class: 'lp-grid lp-shot-grid' })
  const openFolder = () => t.openPath(data.dir || t.inst.paths?.screenshotsDir || '')
  container.appendChild(tabEl(
    barEl(count, spacer(),
      btn('刷新', { size: 'sm', iconName: 'refresh', onClick: () => load() }),
      btn('打开 screenshots 文件夹', { size: 'sm', iconName: 'folder-open', onClick: openFolder })),
    grid
  ))
  const load = makeLoader(t, grid, {
    text: '正在读取截图…',
    title: '无法读取截图',
    style: { gridColumn: '1 / -1' },
    request: () => t.api.content(t.id, 'screenshots'),
    render: (result) => { data = result; paint() }
  })
  function paint() {
    const items = data.items || []
    count.textContent = `共 ${items.length} 张截图`
    if (!items.length) {
      const empty = emptyBlock('还没有截图', '在游戏里按 F2 截图后，这里会显示缩略图。', null, 'eye')
      empty.style.gridColumn = '1 / -1'
      grid.replaceChildren(empty)
      return
    }
    grid.replaceChildren(...items.map(shotCard))
  }
  function shotCard(item) {
    const open = () => preview(item)
    return h('figure', { class: 'lp-shot-card', role: 'button', tabindex: '0', title: item.name, onclick: open, onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() } } },
      h('img', { class: 'lp-shot-img', src: item.url, alt: item.name, loading: 'lazy' }),
      h('figcaption', { class: 'lp-shot-meta' },
        h('span', { class: 'lp-shot-name' }, item.name),
        h('span', { class: 'lp-hint' }, `${fmtBytes(item.size)} · ${fmtAgo(item.mtime)}`)),
      iconBtn('trash', { size: 13, label: '删除截图', class: 'lp-shot-del', onClick: (event) => { event.stopPropagation(); removeShot(item) } })
    )
  }
  function preview(item) {
    t.modal({
      title: item.name,
      size: 'xl',
      body: h('img', { src: item.url, alt: item.name, style: { display: 'block', maxWidth: '100%', maxHeight: '70vh', margin: '0 auto', objectFit: 'contain' } }),
      buttons: [
        { label: '打开文件夹', class: 'btn-ghost', onClick: () => t.openPath(data.dir || '') },
        { label: '关闭', class: 'btn-primary' }
      ]
    })
  }
  async function removeShot(item) {
    await deleteFlow(t, {
      message: '删除后无法恢复。',
      title: `删除截图「${item.name}」`,
      task: () => t.api.deleteContent(t.id, 'screenshots', item.name),
      after: async () => { await load(false); await t.reloadInstance() }
    })
  }
  await load()
}

/* --- 服务器 --- */
function serverIcon(item) {
  const raw = String(item.icon || '')
  if (!raw) return h('span', { class: 'lp-server-icon' }, icon('server', { size: 16 }))
  return h('img', {
    class: 'lp-server-icon',
    src: raw.startsWith('data:') ? raw : 'data:image/png;base64,' + raw,
    alt: '',
    loading: 'lazy',
    onerror: (event) => event.target.replaceWith(h('span', { class: 'lp-server-icon' }, icon('server', { size: 16 })))
  })
}
async function mountServers(container, t) {
  let data = { items: [] }
  let busy = false
  const list = h('div', { class: 'lp-list lp-server-list' })
  const hint = tip('')
  const nameInput = input({ placeholder: '名称（可选）', onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); add() } } })
  nameInput.style.flex = '0 1 140px'
  const ipInput = input({ placeholder: '服务器地址，例如 play.example.com', mono: true, onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); add() } } })
  ipInput.style.flex = '1 1 220px'
  const addBtn = btn('添加服务器', { size: 'sm', variant: 'primary', iconName: 'add', onClick: add })
  container.appendChild(tabEl(
    barEl(nameInput, ipInput, addBtn, spacer(),
      btn('刷新', { size: 'sm', iconName: 'refresh', onClick: () => load() }),
      btn('打开游戏文件夹', { size: 'sm', iconName: 'folder-open', onClick: () => t.openPath(t.inst.paths?.gameDir || '') })),
    hint,
    list
  ))
  const load = makeLoader(t, list, {
    text: '正在读取服务器列表…',
    title: '无法读取服务器列表',
    request: () => t.api.content(t.id, 'servers'),
    render: (result) => {
      data = result
      hint.textContent = data.error
        ? data.error
        : `servers.dat：${data.file || '尚未生成'} · 共 ${(data.items || []).length} 个服务器`
      paint()
    }
  })
  function paint() {
    const items = data.items || []
    if (!items.length) {
      list.replaceChildren(emptyBlock('还没有服务器', '在游戏里添加一次服务器，或在上方填写名称与地址后点击“添加服务器”。', null, 'server'))
      return
    }
    fillList(list, items, null, serverRow)
  }
  function serverRow(item, index) {
    const active = String(t.inst.server || '') === item.ip
    const useBtn = btn(active ? '已设为启动服务器' : '设为启动服务器', { size: 'sm', variant: active ? 'ghost' : 'primary', iconName: 'play', disabled: active, onClick: () => use(item, useBtn) })
    return rowEl('lp-server-row' + (active ? ' is-active' : ''),
      serverIcon(item),
      mainEl(
        titleEl(h('b', { title: item.name }, item.name || item.ip),
          active ? badge('启动服务器', 'ok') : null,
          item.acceptTextures === false ? badge('不接收材质') : null),
        h('div', { class: 'lp-server-addr mono' }, item.ip)),
      actEl(useBtn, iconBtn('trash', { size: 13, label: '删除服务器', onClick: () => removeServer(item, index) })))
  }
  async function use(item, button) {
    if (busy) return
    busy = true
    button.disabled = true
    try {
      await t.api.updateInstance(t.id, { server: item.ip, autoConnect: true })
      t.inst.server = item.ip
      t.inst.autoConnect = true
      t.toast(`启动时将自动连接 ${item.name || item.ip}`, 'ok')
      paint()
      await t.reloadInstance()
    } catch (error) {
      t.toast('设置失败：' + error.message, 'err')
      button.disabled = false
    } finally { busy = false }
  }
  async function add() {
    if (busy) return
    const address = ipInput.value.trim()
    if (!address) { t.toast('请填写服务器地址', 'warn'); ipInput.focus(); return }
    busy = true
    addBtn.disabled = true
    try {
      await t.api.serverAction(t.id, { action: 'add', name: nameInput.value.trim() || address, ip: address })
      t.toast('已添加服务器', 'ok')
      nameInput.value = ''
      ipInput.value = ''
      await load(false)
      await t.reloadInstance()
    } catch (error) { t.toast('添加失败：' + error.message, 'err') } finally {
      busy = false
      addBtn.disabled = false
    }
  }
  async function removeServer(item, index) {
    if (busy) return
    busy = true
    await deleteFlow(t, {
      message: '该服务器会从 servers.dat 中移除，游戏内其他设置不受影响。',
      title: `删除服务器「${item.name || item.ip}」`,
      task: () => t.api.serverAction(t.id, { action: 'delete', index }),
      after: async () => { await load(false); await t.reloadInstance() }
    })
    busy = false
  }
  await load()
}

/* --- 日志 --- */
async function mountLogs(container, t) {
  let data = { items: [], crashes: [] }
  let current = null
  let crashName = ''
  let mode = 'log'
  let auto = true
  let follow = true
  let polling = false
  let seq = 0
  let liveStatus = null
  const statusDot = h('span', { class: 'dot' })
  const statusText = tip('正在检查运行状态…')
  const fileSelect = h('select', { class: 'input lp-log-select', 'aria-label': '选择日志文件' })
  Object.assign(fileSelect.style, { flex: '1 1 240px', minWidth: '180px' })
  fileSelect.onchange = () => {
    const item = data.items[Number(fileSelect.value)]
    if (item) loadLog(item)
  }
  const autoSwitch = switchBox(true, (checked) => { auto = checked }, '游戏运行时每 3 秒刷新')
  const backBtn = btn('返回日志', { size: 'sm', iconName: 'arrow-left', onClick: () => { if (current) loadLog(current) } })
  backBtn.hidden = true
  const title = h('div', { class: 'lp-log-title' }, '日志')
  const pane = h('pre', { class: 'lp-log-pane mono', tabindex: '0', 'aria-label': '日志内容' }, '正在读取…')
  pane.addEventListener('scroll', () => { follow = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 32 })
  const hints = h('div', { class: 'lp-log-hints' })
  const crashList = h('div', { class: 'lp-list lp-log-crash-list' })
  const crashCard = sectionCard({ title: '崩溃报告', subtitle: '点击查看报告全文与可识别的问题', body: crashList, className: 'lp-log-crashes' })
  const liveBtn = btn('接入 latest.log', {
    size: 'sm',
    iconName: 'terminal',
    title: '跳到正在运行的实例写入的游戏日志并跟随刷新',
    disabled: true,
    onClick: () => {
      const item = (data.items || []).find((entry) => entry.source === 'game' && entry.name === 'latest.log')
      if (item) loadLog(item)
      else t.toast('还没有生成游戏 latest.log', 'warn')
    }
  })
  container.appendChild(tabEl(
    barEl(fileSelect, backBtn,
      btn('刷新', { size: 'sm', iconName: 'refresh', onClick: () => load(true) }),
      btn('复制', { size: 'sm', iconName: 'copy', onClick: copyLog }),
      btn('下载', { size: 'sm', iconName: 'download', onClick: downloadLog }),
      liveBtn,
      spacer(), statusDot, statusText, autoSwitch.el,
      btn('游戏日志目录', { size: 'sm', iconName: 'folder-open', onClick: () => t.openPath(data.gameLogDir || (t.inst.paths?.gameDir || '') + '/logs') }),
      btn('启动器日志目录', { size: 'sm', iconName: 'terminal', onClick: () => t.openPath(data.logsDir || t.inst.paths?.logsDir || '') })),
    hints,
    h('div', { class: 'lp-log-view' }, title, pane),
    crashCard
  ))
  function paintStatus(status) {
    liveStatus = status
    const running = !!status?.running
    const session = status?.session
    statusDot.className = 'dot' + (running ? ' ok' : '')
    statusText.textContent = running
      ? (session?.detected
        ? `已接管外部进程 · PID ${session.pid || '?'} · 日志自动跟随`
        : `游戏运行中${session?.pid ? ' · PID ' + session.pid : ''}`)
      : '游戏未运行'
    statusText.title = running ? (session?.logFile || '') : ''
  }
  async function load(initial = false) {
    try {
      const [result, status] = await Promise.all([
        t.api.content(t.id, 'logs'),
        t.api.instanceStatus(t.id).catch(() => null)
      ])
      if (t.life.dead) return
      paintStatus(status)
      data = result || { items: [], crashes: [] }
      fillSelect()
      fillCrashes()
      liveBtn.disabled = !(data.items || []).some((item) => item.source === 'game' && item.name === 'latest.log')
      if (!data.items?.length) {
        current = null
        mode = 'log'
        title.textContent = '日志'
        pane.textContent = '还没有日志文件。启动一次游戏后，这里会出现启动器日志与游戏 latest.log。'
        return
      }
      const keep = current && data.items.find((item) => item.name === current.name && item.source === current.source)
      const runningGameLog = status?.running
        ? data.items.find((item) => item.source === 'game' && item.name === 'latest.log')
        : null
      // 检测到正在运行的外部进程时，默认接入游戏 latest.log；用户已经选过文件则保持。
      const pick = keep || runningGameLog || data.items[0]
      if (initial || !keep) await loadLog(pick, { silent: !initial })
    } catch (error) {
      if (t.life.dead) return
      pane.textContent = '读取日志列表失败：' + error.message
      t.toast('读取日志列表失败：' + error.message, 'err')
    }
  }
  function fillSelect() {
    clear(fileSelect)
    if (!data.items?.length) {
      fileSelect.appendChild(h('option', { value: '' }, '没有日志文件'))
      fileSelect.disabled = true
      return
    }
    fileSelect.disabled = false
    data.items.forEach((item, index) => {
      fileSelect.appendChild(h('option', { value: String(index) }, `${item.source === 'game' ? '游戏' : '启动器'} · ${item.name}`))
    })
    if (current) {
      const index = data.items.findIndex((item) => item.name === current.name && item.source === current.source)
      if (index >= 0) fileSelect.value = String(index)
    }
  }
  async function loadLog(item, { silent = false } = {}) {
    if (!item) return
    const token = ++seq
    mode = 'log'
    crashName = ''
    backBtn.hidden = true
    hints.replaceChildren()
    current = item
    if (!silent) pane.textContent = '正在读取…'
    try {
      const result = await t.api.content(t.id, 'log', { source: item.source || 'launcher', file: item.name })
      if (t.life.dead || token !== seq) return
      pane.textContent = result?.text || '（日志为空）'
      title.textContent = `${item.source === 'game' ? '游戏日志' : '启动器日志'} · ${item.name} · ${fmtBytes(result?.size || item.size || 0)}`
      if (!silent || follow) pane.scrollTop = pane.scrollHeight
      follow = true
      const index = data.items.indexOf(item)
      if (index >= 0) fileSelect.value = String(index)
    } catch (error) {
      if (t.life.dead || token !== seq) return
      pane.textContent = '读取日志失败：' + error.message
      t.toast('读取日志失败：' + error.message, 'err')
    }
  }
  async function loadCrash(crash) {
    const token = ++seq
    mode = 'crash'
    crashName = crash.name
    backBtn.hidden = false
    title.textContent = `崩溃报告 · ${crash.name}`
    pane.textContent = '正在读取崩溃报告…'
    try {
      const result = await t.api.content(t.id, 'crash', { file: crash.name })
      if (t.life.dead || token !== seq) return
      const text = result?.text || '（报告为空）'
      pane.textContent = text
      const list = analyzeText(text)
      hints.replaceChildren(...(list.length
        ? list.map((item) => h('div', { class: 'lp-log-hint' }, h('b', {}, item.title), h('span', {}, item.suggestion)))
        : [tip('没有匹配到可识别的错误特征，请在报告里搜索 “Caused by”。')]))
      pane.scrollTop = 0
    } catch (error) {
      if (t.life.dead || token !== seq) return
      pane.textContent = '读取崩溃报告失败：' + error.message
      t.toast('读取崩溃报告失败：' + error.message, 'err')
    }
  }
  function fillCrashes() {
    const crashes = data.crashes || []
    if (!crashes.length) {
      crashList.replaceChildren(tip('没有崩溃报告。'))
      return
    }
    fillList(crashList, crashes, null, (crash) => {
      const open = () => loadCrash(crash)
      return h('div', { class: 'lp-row lp-log-crash', role: 'button', tabindex: '0', onclick: open, onkeydown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() } } },
        chip('CRASH'),
        mainEl(h('b', { class: 'lp-log-crash-name', title: crash.name }, crash.name), metaEl([fmtBytes(crash.size), fmtAgo(crash.mtime)])),
        tip('查看分析'))
    })
  }
  async function tick() {
    if (polling || t.life.dead) return
    polling = true
    try {
      const status = await t.api.instanceStatus(t.id)
      if (t.life.dead) return
      paintStatus(status)
      const running = !!status?.running
      if (auto && running) {
        if (!data.items?.length) await load(false)
        else if (mode === 'log' && current) await loadLog(current, { silent: true })
      }
    } catch {
      if (!t.life.dead) {
        statusDot.className = 'dot'
        statusText.textContent = '运行状态未知'
      }
    } finally {
      polling = false
    }
  }
  async function copyLog() {
    const ok = await copyText(pane.textContent || '')
    t.toast(ok ? '已复制到剪贴板' : '复制失败', ok ? 'ok' : 'err')
  }
  function downloadLog() {
    const text = pane.textContent || ''
    if (!text.trim()) { t.toast('当前没有可下载的内容', 'warn'); return }
    const name = mode === 'crash' ? (crashName || 'crash-report.txt') : (current?.name || 'minecraft.log')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const link = h('a', { href: url, download: /\.(log|txt)$/i.test(name) ? name : name + '.txt' })
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
  }
  t.life.every(() => { void tick() }, 3000)
  await load(true)
  await tick()
}

/* --- 崩溃诊断 --- */
async function mountCrash(container, t) {
  const root = tabEl()
  container.appendChild(root)
  await load()
  async function load() {
    root.replaceChildren(loadingBlock('正在检查崩溃报告…'))
    try {
      const [crash, logs] = await Promise.all([t.api.crash(t.id), t.api.content(t.id, 'logs').catch(() => null)])
      if (t.life.dead) return
      const crashDir = logs?.crashDir || ''
      const openBtn = btn('打开 crash-reports 文件夹', {
        size: 'sm', iconName: 'folder-open',
        onClick: () => t.openPath(crashDir || (t.inst.paths?.gameDir || '') + '/crash-reports')
      })
      const refreshBtn = btn('重新检测', { size: 'sm', iconName: 'refresh', onClick: () => load() })
      if (!crash) {
        root.replaceChildren(
          barEl(tip('检查最近一次启动生成的 crash-report 与 latest.log'), spacer(), refreshBtn, openBtn),
          h('div', { class: 'lp-card' }, emptyBlock('没有检测到崩溃报告', '最近一次启动没有生成 crash-report，也没有从 latest.log 发现致命错误。', null, 'shield'))
        )
        return
      }
      const hints = crash.hints || []
      const excerpt = crash.excerpt || []
      const fullBtn = crash.name ? btn('查看完整报告', { size: 'sm', iconName: 'expand', onClick: () => openFull(crash) }) : null
      root.replaceChildren(
        barEl(
          mainEl(h('b', {}, crash.description || '游戏异常退出'),
            tip(crash.name ? `${crash.name} · ${fmtDateTime(crash.mtime)}` : '来自 latest.log 的诊断')),
          spacer(), fullBtn, refreshBtn, openBtn),
        h('div', { class: 'lp-card lp-crash-hints' },
          h('div', { class: 'lp-subhead' }, '可能原因'),
          ...(hints.length
            ? hints.map((hint) => h('div', { class: 'lp-log-hint' },
              h('b', {}, hint.title),
              hint.detail ? h('p', {}, hint.detail) : null,
              hint.suggestion ? h('span', {}, hint.suggestion) : null))
            : [tip('没有匹配到已知错误特征，请查看完整报告里的第一个 “Caused by”。')])),
        h('div', { class: 'lp-card lp-crash-excerpt' },
          h('div', { class: 'lp-subhead' }, '关键行'),
          h('pre', { class: 'lp-log-pane mono', style: { maxHeight: '340px' } }, excerpt.length ? excerpt.join('\n') : '（没有可提取的关键行）'))
      )
    } catch (error) {
      if (!t.life.dead) root.replaceChildren(failBlock('无法读取崩溃信息', error, load))
    }
  }
  async function openFull(crash) {
    try {
      const full = await t.api.content(t.id, 'crash', { file: crash.name })
      if (t.life.dead) return
      t.modal({
        title: '崩溃报告 · ' + crash.name,
        size: 'xl',
        body: h('pre', { class: 'lp-log-pane mono', style: { maxHeight: '68vh' } }, full?.text || '（空）'),
        buttons: [{ label: '关闭', class: 'btn-primary' }]
      })
    } catch (error) { t.toast('读取完整报告失败：' + error.message, 'err') }
  }
}

/* --- 入口 --- */

/**
 * Render one launcher content tab into `container`.
 * @param {HTMLElement} container
 * @param {{
 *   instance: object, tab: 'mods'|'resourcepacks'|'shaderpacks'|'worlds'|'screenshots'|'servers'|'logs'|'crash',
 *   api: import('./api.js').launcherApi, ui: import('./ui.js'),
 *   toast: Function, confirm: Function, openModal: Function, openPath: Function,
 *   pickFile: Function, reloadInstance: Function
 * }} ctx
 * @returns {{ destroy: Function }} 停止定时器与监听器
 */
export async function mountContentTab(container, ctx = {}) {
  const t = makeTools(ctx)
  if (!container) return { destroy() { t.life.destroy() } }
  const tab = String(ctx.tab || '')
  if (!t.id) {
    container.appendChild(emptyBlock('没有选择实例', '请先在左侧选择一个实例，再查看内容。', null, 'cube'))
    return { destroy() { t.life.destroy() } }
  }
  try {
    if (tab === 'mods') await mountMods(container, t)
    else if (tab === 'resourcepacks') await mountPacks(container, t, 'resourcepacks')
    else if (tab === 'shaderpacks') await mountPacks(container, t, 'shaderpacks')
    else if (tab === 'worlds') await mountWorlds(container, t)
    else if (tab === 'screenshots') await mountScreenshots(container, t)
    else if (tab === 'servers') await mountServers(container, t)
    else if (tab === 'logs') await mountLogs(container, t)
    else if (tab === 'crash') await mountCrash(container, t)
    else container.appendChild(emptyBlock('未知的内容页', tab || '缺少 tab 参数', null, 'warning'))
  } catch (error) {
    if (!t.life.dead) {
      clear(container)
      container.appendChild(failBlock('这个页面加载失败', error))
    }
  }
  return { destroy() { t.life.destroy() } }
}
