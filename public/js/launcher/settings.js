// 启动器设置：游戏目录、下载、默认内存与窗口、Java、账户与行为。
//
// 所有字段先写入本地草稿，点「保存」时一次性 PUT；数字在保存前校验。
// 修改游戏目录是显式确认操作，且不会搬移已有文件。
import { h, clear, escapeHtml } from '../core/dom.js'
import { icon } from '../ui/icons.js'
import { btn, input, seg, toggle, spinner } from '../ui/kit.js'
import { pickDir as corePickDir, pickFile as corePickFile } from '../core/dirpicker.js'
import { openPath as coreOpenPath } from '../ui/kit.js'
import { toast as defaultToast } from '../core/toast.js'
import { openModal as coreOpenModal, confirmDialog } from '../core/modal.js'
import { launcherApi } from './api.js'

const DEFAULTS = {
  root: '',
  source: 'auto',
  concurrency: 8,
  retries: 3,
  verify: true,
  defaultMinMemory: 1024,
  defaultMemory: 4096,
  defaultWidth: 1280,
  defaultHeight: 720,
  jvmArgs: '',
  gameArgs: '',
  defaultJava: '',
  msClientId: '',
  closeOnLaunch: false,
  downloadAssets: true,
  showLog: true
}

const NUMBER_RULES = {
  concurrency: { min: 1, max: 32, label: '并发下载数' },
  retries: { min: 0, max: 10, label: '重试次数' },
  defaultMinMemory: { min: 256, max: 262144, label: '初始内存' },
  defaultMemory: { min: 256, max: 262144, label: '最大内存' },
  defaultWidth: { min: 320, max: 7680, label: '窗口宽度' },
  defaultHeight: { min: 240, max: 4320, label: '窗口高度' }
}

const SOURCES = [
  ['auto', '自动'],
  ['official', '官方'],
  ['bmclapi', 'BMCL 镜像']
]

const SECTION_ALIASES = {
  general: 'root',
  root: 'root',
  download: 'download',
  downloads: 'download',
  memory: 'memory',
  java: 'java',
  account: 'account',
  accounts: 'account',
  behavior: 'behavior',
  storage: 'storage'
}

function stateOf(ctx) {
  return typeof ctx?.getState === 'function' ? ctx.getState() : null
}

function pickSettings(data) {
  const state = data && typeof data === 'object' ? data : {}
  const source = state.settings && typeof state.settings === 'object' ? state.settings : state
  const out = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key]
  }
  out.defaultJava = source.defaultJava || source.java?.default || ''
  out.root = source.root || ''
  out.verify = source.verify !== false
  out.downloadAssets = source.downloadAssets !== false
  out.showLog = source.showLog !== false
  out.closeOnLaunch = source.closeOnLaunch === true
  return out
}

function normPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function joinPath(root, ...parts) {
  const base = String(root || '').replace(/[\\/]+$/, '')
  if (!base) return ''
  const sep = base.includes('\\') ? '\\' : '/'
  return [base, ...parts.filter(Boolean)].join(sep)
}

/**
 * Open launcher settings modal.
 * @param {{api:object,ui:object,toast:Function,confirm:Function,pickDir:Function,
 *          pickFile?:Function,openPath:Function,getState?:Function,reload?:Function,
 *          onSaved?:Function}} ctx
 * @param {{initial?:string}} [options] section id to scroll to (root/download/memory/java/account/behavior/storage)
 * @returns {object|undefined} the modal handle from openModal()
 */
export function openLauncherSettings(ctx = {}, { initial = '' } = {}) {
  const api = ctx.api || launcherApi
  const toast = ctx.toast || defaultToast
  const confirm = ctx.confirm || confirmDialog
  const openModal = ctx.openModal || coreOpenModal
  const pickDir = ctx.pickDir || corePickDir
  const pickFile = ctx.pickFile || corePickFile
  const openPath = ctx.openPath || coreOpenPath

  const snapshot = stateOf(ctx)?.settings
  let closed = false
  let saving = false
  let dirty = false
  let formBuilt = false
  let modal = null
  let draft = pickSettings(snapshot || {})
  let baseline = { ...draft }
  const setters = {}
  const errors = {}
  const fields = {}

  const body = h('div', { class: 'lp-settings' })
  const loadingEl = h('div', { class: 'lp-settings-loading' }, spinner(16), '正在读取启动器设置…')
  const statusEl = h('span', { class: 'lp-settings-foot-state', style: { marginRight: 'auto' } })

  const saveBtn = btn('保存', { variant: 'primary', iconName: 'save', disabled: true, onClick: () => save() })
  const closeBtn = btn('关闭', { variant: 'ghost', onClick: () => requestClose() })
  const openRootBtn = btn('打开游戏目录', { iconName: 'folder-open', onClick: () => openPath(draft.root) })

  let rootInputEl = null
  let rootChangeEl = null
  let javaInputEl = null
  let clearJavaBtn = null
  const storageRows = []

  /* ---------------- status / dirty ---------------- */

  function setStatus(text, kind = '') {
    statusEl.textContent = text
    statusEl.dataset.kind = kind
  }

  function updateDirtyState() {
    saveBtn.disabled = saving || !dirty
    saveBtn.classList.toggle('loading', saving)
    closeBtn.disabled = saving
    openRootBtn.disabled = saving
  }

  function markDirty() {
    if (saving) return
    dirty = true
    setStatus('有未保存的更改')
    updateDirtyState()
  }

  function showError(key, message) {
    const error = errors[key]
    if (error) {
      error.textContent = message
      error.hidden = false
    }
    fields[key]?.classList.add('invalid')
  }

  function clearError(key) {
    const error = errors[key]
    if (error) {
      error.textContent = ''
      error.hidden = true
    }
    fields[key]?.classList.remove('invalid')
  }

  function clearErrors() {
    for (const key of Object.keys(errors)) clearError(key)
  }

  async function requestClose() {
    if (saving) return
    if (dirty) {
      const ok = await confirm('有未保存的更改，关闭后这些修改会丢失。确定关闭吗？', {
        title: '放弃更改',
        danger: true,
        okText: '放弃并关闭'
      })
      if (!ok) return
    }
    modal?.close()
  }

  /* ---------------- field helpers ---------------- */

  function field(key, label, control, hint = '') {
    const error = h('div', { class: 'error', hidden: true })
    if (key) {
      errors[key] = error
      fields[key] = null
    }
    const wrap = h('div', { class: 'field', dataset: key ? { key } : {} },
      label ? h('label', {}, label) : null,
      control,
      hint ? h('div', { class: 'hint' }, hint) : null,
      error
    )
    if (key) fields[key] = wrap
    return wrap
  }

  function fullField(node) {
    node.style.gridColumn = '1 / -1'
    return node
  }

  function numberField(key, label, hint = '') {
    const rule = NUMBER_RULES[key]
    const node = input({ type: 'number', value: draft[key] ?? '', min: rule.min, max: rule.max, step: 1 })
    node.addEventListener('input', () => {
      draft[key] = node.value
      clearError(key)
      markDirty()
    })
    node.addEventListener('blur', () => {
      if (node.value === '') return
      const value = Number(node.value)
      if (!Number.isFinite(value)) return
      const clamped = Math.max(rule.min, Math.min(rule.max, Math.round(value)))
      if (String(clamped) !== node.value) {
        node.value = String(clamped)
        draft[key] = clamped
        markDirty()
      }
    })
    setters[key] = (value) => { node.value = value ?? '' }
    return field(key, label, node, hint)
  }

  function textareaField(key, label, { placeholder = '', hint = '' } = {}) {
    const node = h('textarea', { class: 'input mono', rows: '2', placeholder, spellcheck: 'false' })
    node.value = draft[key] ?? ''
    node.addEventListener('input', () => {
      draft[key] = node.value
      clearError(key)
      markDirty()
    })
    setters[key] = (value) => { node.value = value ?? '' }
    return fullField(field(key, label, node, hint))
  }

  function segField(key, options, label, hint = '') {
    const node = seg(options, draft[key], (value) => {
      draft[key] = value
      clearError(key)
      markDirty()
    })
    setters[key] = (value) => node.setValue(value)
    return fullField(field(key, label, node, hint))
  }

  function boolRow(key, label, hint = '', warn = false) {
    const switchNode = toggle(!!draft[key], (value) => {
      draft[key] = value
      markDirty()
    })
    setters[key] = (value) => {
      const checkbox = switchNode.querySelector('input')
      if (checkbox) checkbox.checked = !!value
    }
    return h('div', { class: 'lp-switch-row lp-settings-toggle' + (warn ? ' warn' : '') },
      h('div', { class: 'lp-settings-toggle-info' },
        h('b', {}, label),
        hint ? h('span', { class: 'lp-hint' }, hint) : null
      ),
      switchNode
    )
  }

  function card(id, title, subtitle, ...children) {
    return h('section', { class: 'lp-card lp-settings-card', id: 'lp-settings-' + id },
      h('div', { class: 'lp-card-head' },
        h('div', { class: 'lp-card-title' }, h('b', {}, title), subtitle ? h('span', {}, subtitle) : null)
      ),
      h('div', { class: 'lp-card-body' }, ...children)
    )
  }

  /* ---------------- root / storage ---------------- */

  function updateRootNote() {
    if (!rootChangeEl) return
    const changed = !!draft.root && !!baseline.root && normPath(draft.root) !== normPath(baseline.root)
    rootChangeEl.hidden = !changed
    rootChangeEl.textContent = changed
      ? `保存后生效：现有实例与共享文件仍留在「${baseline.root}」，不会被移动。`
      : ''
  }

  function refreshStorage() {
    for (const item of storageRows) item.refresh()
    if (rootInputEl) rootInputEl.value = draft.root || ''
  }

  async function chooseRoot() {
    let picked = ''
    try {
      picked = await pickDir(draft.root || '', { title: '选择游戏目录' })
    } catch (e) {
      toast('无法打开目录选择器：' + e.message, 'err')
      return
    }
    if (!picked || closed) return
    if (normPath(picked) === normPath(draft.root)) return
    const ok = await confirm(
      `更改游戏目录不会移动已有的实例、素材和库文件。\n\n新目录：${escapeHtml(picked)}\n\n之后下载和新建的实例会使用新目录；现有实例仍从原目录读取。确定更换吗？`,
      { title: '更改游戏目录', okText: '更换目录' }
    )
    if (!ok || closed) return
    draft.root = picked
    if (rootInputEl) rootInputEl.value = picked
    updateRootNote()
    refreshStorage()
    markDirty()
  }

  function pathRow(label, sub) {
    const value = h('b', { class: 'lp-settings-path mono' })
    const open = btn('打开', {
      size: 'xs',
      variant: 'ghost',
      iconName: 'folder',
      onClick: () => openPath(sub ? joinPath(draft.root, sub) : draft.root)
    })
    const row = h('div', { class: 'lp-row lp-settings-path-row' },
      h('div', { class: 'lp-kv' }, h('span', {}, label), value),
      open
    )
    const entry = {
      row,
      refresh() {
        const path = sub ? joinPath(draft.root, sub) : (draft.root || '')
        value.textContent = path || '—'
        value.title = path || ''
        open.disabled = !path
      }
    }
    storageRows.push(entry)
    entry.refresh()
    return row
  }

  /* ---------------- cards ---------------- */

  function buildForm() {
    if (formBuilt) return
    formBuilt = true

    const rootInput = input({ value: draft.root || '', mono: true, readonly: true })
    rootInput.style.flex = '1 1 auto'
    rootInputEl = rootInput
    setters.root = (value) => { rootInput.value = value || '' }
    rootChangeEl = h('div', { class: 'lp-hint lp-settings-root-change', hidden: true })

    body.appendChild(card('root', '游戏目录', '实例、素材与库文件的根目录',
      h('div', { class: 'field' },
        h('label', {}, '当前游戏目录'),
        h('div', { class: 'lp-row lp-settings-root-row' },
          rootInput,
          btn('选择目录', { size: 'sm', iconName: 'folder-open', onClick: () => chooseRoot() }),
          btn('打开', { size: 'sm', iconName: 'folder', onClick: () => openPath(draft.root) })
        ),
        h('div', { class: 'hint' }, '更改目录只会影响之后下载和新建的实例，不会移动已有的实例、素材与库文件。'),
        rootChangeEl
      )
    ))

    body.appendChild(card('download', '下载', '版本、素材与 Java 的下载行为',
      h('div', { class: 'lp-form-grid' },
        segField('source', SOURCES, '下载源', '自动：优先 BMCL 镜像，失败后回退官方源。镜像只加速版本、素材与库文件。'),
        numberField('concurrency', '并发下载数', '1–32。并发过高可能被下载源限速。'),
        numberField('retries', '失败重试次数', '0–10。单个文件下载失败后的自动重试次数。')
      ),
      boolRow('verify', '校验已存在文件', '复用本地文件时校验 SHA1；关闭会更快，但损坏的文件可能被漏过。')
    ))

    body.appendChild(card('memory', '默认内存与窗口', '新建实例的初始值',
      h('div', { class: 'lp-form-grid' },
        numberField('defaultMinMemory', '初始内存（MB）', '建议 1024 MB；不能大于最大内存。'),
        numberField('defaultMemory', '最大内存（MB）', '建议 4096–12288 MB；大型整合包可以更高。'),
        numberField('defaultWidth', '默认窗口宽度', '新建实例的窗口宽度，像素。'),
        numberField('defaultHeight', '默认窗口高度', '新建实例的窗口高度，像素。'),
        textareaField('jvmArgs', '默认 JVM 参数', {
          placeholder: '-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions',
          hint: '留空使用启动器默认。参数按空格拆分；含空格的参数用引号包裹。'
        }),
        textareaField('gameArgs', '默认游戏参数', {
          placeholder: '--fullscreen',
          hint: '附加到游戏主类之后，按空格拆分。'
        })
      )
    ))

    const javaInput = input({ value: draft.defaultJava || '', mono: true, readonly: true })
    javaInput.style.flex = '1 1 auto'
    javaInputEl = javaInput
    const clearJava = btn('清除', {
      size: 'sm',
      variant: 'ghost',
      onClick: () => {
        draft.defaultJava = ''
        javaInput.value = ''
        clearJava.disabled = true
        markDirty()
      }
    })
    clearJavaBtn = clearJava
    clearJava.disabled = !draft.defaultJava
    setters.defaultJava = (value) => {
      javaInput.value = value || ''
      clearJava.disabled = !value
    }
    body.appendChild(card('java', 'Java', '默认运行时，可在实例中单独覆盖',
      h('div', { class: 'field' },
        h('label', {}, '默认 Java'),
        h('div', { class: 'lp-row lp-settings-java-row' },
          javaInput,
          btn('选择 java.exe', {
            size: 'sm',
            iconName: 'folder-open',
            onClick: () => chooseJava()
          }),
          clearJava
        ),
        h('div', { class: 'hint' }, '留空时按实例所需的 MC 版本自动选择。启动前会校验 64 位与大版本；不匹配会拒绝启动并给出提示。')
      )
    ))

    const msInput = input({ value: draft.msClientId || '', mono: true, placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' })
    setters.msClientId = (value) => { msInput.value = value || '' }
    msInput.addEventListener('input', () => {
      draft.msClientId = msInput.value
      clearError('msClientId')
      markDirty()
    })
    const azureLink = h('a', {
      class: 'btn btn-sm',
      href: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
      target: '_blank',
      rel: 'noopener noreferrer',
      style: { alignSelf: 'flex-start' }
    }, icon('external', { size: 13 }), '打开 Azure 应用注册')
    body.appendChild(card('account', '账户', '微软正版登录（默认无需配置）',
      h('div', { class: 'field' },
        h('label', {}, 'Microsoft OAuth 客户端 ID（可选）'),
        msInput,
        h('div', { class: 'hint' }, '留空时使用内置公共客户端，采用与 PCL / HMCL 相同的微软设备码登录，无需注册 Azure 应用。填写自己的 Azure 应用 ID 可覆盖内置值。'),
        h('div', { class: 'hint' }, '如需自定义：在 Azure 门户创建「公共客户端」应用，账户类型选「个人 Microsoft 账户」，添加「移动和桌面应用程序」平台并启用公共客户端流，然后复制应用程序(客户端) ID。'),
        azureLink
      )
    ))

    body.appendChild(card('behavior', '行为', '启动、下载与日志',
      boolRow('closeOnLaunch', '启动游戏后关闭启动器窗口', '启动成功后约 2 秒关闭本窗口；正在进行的下载或未保存的设置会中断。', true),
      boolRow('downloadAssets', '下载游戏素材（assets）', '关闭后不会下载声音与语言文件，部分版本可能没有声音。'),
      boolRow('showLog', '启动游戏时自动显示日志', '实例页会自动切换到日志标签，便于查看崩溃信息。')
    ))

    body.appendChild(card('storage', '存储与清理', '共享目录与实例目录',
      h('div', { class: 'lp-settings-paths' },
        pathRow('游戏目录', ''),
        pathRow('库文件', 'libraries'),
        pathRow('素材', 'assets'),
        pathRow('实例', 'instances'),
        pathRow('版本', 'versions')
      ),
      h('div', { class: 'lp-hint' }, 'libraries 与 assets 由该目录下的所有实例共享；删除实例不会删除共享的版本与素材。')
    ))

    updateRootNote()
    refreshStorage()
    updateDirtyState()
  }

  async function chooseJava() {
    let picked = ''
    try {
      picked = await pickFile(draft.defaultJava || '', { title: '选择 java.exe', exts: ['.exe'] })
    } catch (e) {
      toast('无法打开文件选择器：' + e.message, 'err')
      return
    }
    if (!picked || closed) return
    const path = picked.trim()
    if (!/(^|[\\/])java(\.exe)?$/i.test(path)) {
      toast('请选择 java.exe 可执行文件', 'err')
      return
    }
    draft.defaultJava = path
    if (javaInputEl) javaInputEl.value = path
    if (clearJavaBtn) clearJavaBtn.disabled = false
    markDirty()
    toast('已选择 Java，保存后生效', 'info')
  }

  /* ---------------- load / save ---------------- */

  function applyData(data, { reset = false } = {}) {
    draft = pickSettings(data)
    if (reset) baseline = { ...draft }
    for (const [key, setter] of Object.entries(setters)) {
      try { setter(draft[key]) } catch (e) { console.warn('[settings] setter', key, e) }
    }
    dirty = false
    clearErrors()
    updateRootNote()
    refreshStorage()
    updateDirtyState()
    if (!saving) setStatus('')
  }

  function validate() {
    clearErrors()
    let first = ''
    for (const [key, rule] of Object.entries(NUMBER_RULES)) {
      const raw = draft[key]
      const value = Number(raw)
      if (raw === '' || raw === null || raw === undefined || !Number.isFinite(value) || !Number.isInteger(value)) {
        showError(key, '请输入整数')
        if (!first) first = key
        continue
      }
      if (value < rule.min || value > rule.max) {
        showError(key, `请输入 ${rule.min}–${rule.max} 之间的整数`)
        if (!first) first = key
      }
    }
    if (!first) {
      const min = Number(draft.defaultMinMemory)
      const max = Number(draft.defaultMemory)
      if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
        showError('defaultMinMemory', '初始内存不能大于最大内存')
        showError('defaultMemory', '最大内存不能小于初始内存')
        first = 'defaultMemory'
      }
    }
    if (first) {
      const target = fields[first]
      if (target) {
        target.scrollIntoView({ block: 'center' })
        target.querySelector('input, select, textarea')?.focus({ preventScroll: true })
      }
      toast('请检查无效的数值设置', 'err')
      setStatus('有无效的设置项', 'err')
      return false
    }
    return true
  }

  function buildPatch() {
    return {
      root: String(draft.root || '').trim(),
      source: SOURCES.some(([value]) => value === draft.source) ? draft.source : 'auto',
      concurrency: Math.round(Number(draft.concurrency)),
      retries: Math.round(Number(draft.retries)),
      verify: draft.verify !== false,
      defaultMinMemory: Math.round(Number(draft.defaultMinMemory)),
      defaultMemory: Math.round(Number(draft.defaultMemory)),
      defaultWidth: Math.round(Number(draft.defaultWidth)),
      defaultHeight: Math.round(Number(draft.defaultHeight)),
      jvmArgs: String(draft.jvmArgs || '').trim(),
      gameArgs: String(draft.gameArgs || '').trim(),
      defaultJava: String(draft.defaultJava || '').trim(),
      msClientId: String(draft.msClientId || '').trim(),
      closeOnLaunch: draft.closeOnLaunch === true,
      downloadAssets: draft.downloadAssets !== false,
      showLog: draft.showLog !== false
    }
  }

  async function save() {
    if (saving) return
    if (!validate()) return
    saving = true
    updateDirtyState()
    setStatus('保存中…')
    let next = null
    try {
      next = await api.saveSettings(buildPatch())
      if (closed) return
      dirty = false
      applyData(next, { reset: true })
      setStatus('已保存 · ' + new Date().toLocaleTimeString(), 'ok')
      toast('启动器设置已保存', 'ok')
    } catch (e) {
      if (!closed) {
        setStatus('保存失败：' + e.message, 'err')
        toast('保存启动器设置失败：' + e.message, 'err')
      }
      return
    } finally {
      saving = false
      if (!closed) updateDirtyState()
    }
    if (next && !closed) {
      try {
        if (typeof ctx.onSaved === 'function') await ctx.onSaved(next)
        else await ctx.reload?.()
      } catch (e) {
        if (!closed) toast('设置已保存，但刷新启动器状态失败：' + e.message, 'warn')
      }
    }
  }

  async function pullSettings({ initial: isInitial = false } = {}) {
    if (!isInitial) setStatus('正在读取最新设置…')
    try {
      const data = await api.settings()
      if (closed) return
      if (isInitial) {
        if (loadingEl.isConnected) loadingEl.remove()
        applyData(data, { reset: true })
        buildForm()
        setStatus('')
        focusSection()
      } else if (!dirty) {
        applyData(data, { reset: true })
        setStatus('')
      } else {
        setStatus('有未保存的更改')
      }
    } catch (e) {
      if (closed) return
      if (isInitial) {
        if (loadingEl.isConnected) loadingEl.remove()
        clear(body)
        body.appendChild(h('div', { class: 'lp-main-error' },
          icon('warning', { size: 24 }),
          h('b', {}, '读取启动器设置失败'),
          h('p', {}, e.message),
          btn('重试', {
            variant: 'primary',
            onClick: () => {
              clear(body)
              body.appendChild(loadingEl)
              pullSettings({ initial: true })
            }
          })
        ))
      } else {
        setStatus('读取最新设置失败：' + e.message, 'err')
        toast('读取启动器设置失败：' + e.message, 'err')
      }
    }
  }

  function focusSection() {
    if (!initial) return
    const id = SECTION_ALIASES[initial] || String(initial).replace(/^lp-settings-/, '')
    const target = body.querySelector('#lp-settings-' + id) || body.querySelector('#' + initial)
    if (!target) return
    requestAnimationFrame(() => {
      try { target.scrollIntoView({ block: 'start' }) } catch {}
    })
  }

  /* ---------------- shell ---------------- */

  if (snapshot) {
    buildForm()
  } else {
    body.appendChild(loadingEl)
  }

  modal = openModal({
    title: '启动器设置',
    size: 'xl',
    body,
    buttons: [openRootBtn, saveBtn, closeBtn],
    onClose: () => { closed = true }
  })

  if (modal?.foot) modal.foot.insertBefore(statusEl, modal.foot.firstChild)

  if (snapshot) {
    updateDirtyState()
    focusSection()
    pullSettings()
  } else {
    pullSettings({ initial: true })
  }

  return modal
}
