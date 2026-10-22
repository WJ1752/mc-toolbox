// 启动器共享版本选择器：PCL 风格可输入 MC 版本下拉框 + 版本兼容分组。
// 供「安装模组 / 资源包 / 光影」与「新建实例 → 整合包」共用；纯 DOM，无框架。
import { h, clear, fmtAgo, fmtBytes } from '../core/dom.js'
import { icon } from '../ui/icons.js'
import { input } from '../ui/kit.js'
import { loaderInfo } from './ui.js'

const VERSION_RE = /^(?:\d+\.\d+(?:\.\d+)?(?:-(?:pre|rc)\d+)?|\d{2}w\d{2}[a-z])$/i
const SNAPSHOT_RE = /^\d{2}w\d{2}[a-z]$/i

/** 是否为合法的 Minecraft 版本号（1.20.1 / 1.21 / 26.3 / 1.20.1-pre1 / 24w14a）。 */
export function isMinecraftVersion(value) {
  return VERSION_RE.test(String(value || '').trim())
}

/** 版本号比较（新 → 旧），用于版本列表排序。 */
export function compareVersionsDesc(a, b) {
  const pa = String(a || '').split(/[.+-]/)
  const pb = String(b || '').split(/[.+-]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? ''
    const y = pb[i] ?? ''
    const nx = Number(x)
    const ny = Number(y)
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return ny - nx
    } else if (x !== y) {
      return y.localeCompare(x, undefined, { numeric: true })
    }
  }
  return 0
}

function dateOf(value) {
  const ts = typeof value === 'number' ? value : Date.parse(String(value || ''))
  return Number.isFinite(ts) ? ts : 0
}

function versionDate(version) {
  return dateOf(version?.date || version?.published || version?.releaseTime || 0)
}

/** 单个版本是否与实例 MC + 加载器兼容。 */
export function compatibleVersion(version, { mc = '', loader = '', kind = 'mods' } = {}) {
  if (!version) return false
  const targetMc = String(mc || '').trim()
  const list = Array.isArray(version.gameVersions) ? version.gameVersions.map(String) : []
  if (!targetMc || !isMinecraftVersion(targetMc)) return false
  if (list.length && !list.includes(targetMc)) return false
  if (kind === 'mods' && loader && loader !== 'vanilla') {
    const loaders = Array.isArray(version.loaders) ? version.loaders.map((item) => String(item).toLowerCase()) : []
    // CurseForge 旧接口不返回 loaders：无法判断时按兼容处理，避免误藏结果。
    if (loaders.length && !loaders.includes(String(loader).toLowerCase())) return false
  }
  return true
}

/**
 * 拆分版本列表：兼容项（发布时间倒序）与其它版本。
 * @returns {{compatible: object[], others: object[], recommendedId: string, mc: string, loader: string}}
 */
export function partitionVersions(versions, { mc = '', loader = '', kind = 'mods' } = {}) {
  const all = Array.isArray(versions) ? versions.filter(Boolean) : []
  const sort = (list) => [...list].sort((a, b) => versionDate(b) - versionDate(a))
  const compatible = []
  const others = []
  for (const version of all) {
    if (compatibleVersion(version, { mc, loader, kind })) compatible.push(version)
    else others.push(version)
  }
  const sortedCompatible = sort(compatible)
  const recommended = sortedCompatible.find((version) => {
    const type = String(version.type || '').toLowerCase()
    return !type || type === 'release'
  }) || sortedCompatible[0]
  return {
    compatible: sortedCompatible,
    others: sort(others),
    recommendedId: String(recommended?.id || ''),
    mc: String(mc || ''),
    loader: String(loader || '')
  }
}

/** 结果区顶部的筛选条件文案。 */
export function filterSummary({ mc = '', loader = '', kind = 'mods' } = {}) {
  const versionText = mc && isMinecraftVersion(mc) ? mc : '全部 MC 版本'
  const parts = [`筛选：${versionText}`]
  if (kind === 'mods' && loader && loader !== 'vanilla') parts.push(loaderInfo(loader).label)
  return parts.join(' · ')
}

/** 给版本行生成徽章：适配 / 当前实例可用 / 推荐。 */
export function versionTagBadges(version, { mc = '', loader = '', kind = 'mods', recommended = false, current = false } = {}) {
  const out = []
  const target = String(mc || '')
  if (current) out.push({ text: '当前实例可用', tone: 'accent', title: '与当前实例的 MC 版本和加载器匹配' })
  else if (target && compatibleVersion(version, { mc: target, loader, kind })) {
    out.push({ text: `适配 ${target}`, tone: 'ok', title: `该版本支持 Minecraft ${target}` })
  }
  if (recommended) out.push({ text: '推荐', tone: 'accent', title: '最新兼容的正式版' })
  const loaders = Array.isArray(version.loaders) ? version.loaders : []
  if (kind === 'mods' && loader && loader !== 'vanilla' && loaders.length && loaders.includes(String(loader).toLowerCase())
    && compatibleVersion(version, { mc, loader, kind })) {
    out.push({ text: loaderInfo(loader).label, tone: 'info', title: '与当前实例加载器一致' })
  }
  return out
}

/**
 * PCL 风格可输入下拉框。
 *
 * @param {{
 *   value?: string,            // '' = 全部版本
 *   instanceMc?: string,
 *   versions?: string[]|{id:string}[],
 *   onChange?: (value:string)=>void,
 *   title?: string,
 *   placeholder?: string,
 *   allLabel?: string,
 *   currentLabel?: string,
 *   limit?: number
 * }} opts
 * @returns {{el: HTMLElement, getValue:Function, setValue:Function, setVersions:Function, setError:Function, focus:Function, destroy:Function}}
 */
export function versionCombo({
  value = '',
  instanceMc = '',
  versions = [],
  onChange,
  title = 'Minecraft 版本',
  placeholder = '全部版本',
  allLabel = '全部版本',
  currentLabel = '当前实例',
  limit = 80
} = {}) {
  let current = String(value || '')
  let list = normalizeVersions(versions)
  let instance = String(instanceMc || '').trim()
  let open = false
  let activeIndex = 0
  let error = ''
  const menu = h('div', { class: 'lp-vc-menu', role: 'listbox', 'aria-label': title, hidden: true })
  const field = input({
    value: current,
    placeholder,
    class: 'lp-vc-input',
    title,
    onInput: () => {
      error = ''
      paintError()
      if (!open) toggle(true)
      else renderMenu()
    },
    onKeyDown: (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (!open) { toggle(true); return }
        const size = menuItems().length
        if (!size) return
        activeIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : size - 1)) % size
        syncActive()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        commitFromInput()
      } else if (event.key === 'Escape') {
        if (open) { event.preventDefault(); toggle(false) }
      } else if (event.key === 'Tab') {
        toggle(false)
      }
    },
    onFocus: () => toggle(true)
  })
  field.addEventListener('focus', () => toggle(true))
  field.setAttribute('role', 'combobox')
  field.setAttribute('aria-expanded', 'false')
  field.setAttribute('aria-autocomplete', 'list')
  const errorEl = h('div', { class: 'lp-vc-hint', hidden: true })
  const wrap = h('div', { class: 'lp-vc' }, field, h('span', { class: 'lp-vc-caret' }, icon('chevron-down', { size: 12 })), menu, errorEl)
  const onDocDown = (event) => {
    if (!wrap.isConnected) { cleanup(); return }
    if (!wrap.contains(event.target)) toggle(false)
  }
  document.addEventListener('pointerdown', onDocDown, true)

  function cleanup() {
    document.removeEventListener('pointerdown', onDocDown, true)
  }
  function normalizeVersions(items) {
    const seen = new Set()
    const out = []
    for (const item of items || []) {
      const id = String(typeof item === 'string' ? item : item?.id || '').trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
    return out
  }
  function paintError() {
    errorEl.hidden = !error
    errorEl.textContent = error
    field.classList.toggle('is-invalid', !!error)
    field.setAttribute('aria-invalid', String(!!error))
  }
  function setError(text = '') {
    error = String(text || '')
    paintError()
  }
  function currentVersions() {
    const q = String(field.value || '').trim().toLowerCase()
    const pool = list.filter((id) => !q || id.toLowerCase().includes(q))
    return pool.slice(0, limit)
  }
  function menuItems() {
    const items = [{ type: 'all', value: '' }]
    if (instance && isMinecraftVersion(instance)) items.push({ type: 'instance', value: instance })
    for (const id of currentVersions()) {
      if (id === instance) continue
      items.push({ type: 'version', value: id })
    }
    const typed = String(field.value || '').trim()
    if (typed && isMinecraftVersion(typed) && !items.some((item) => item.value === typed)) {
      items.push({ type: 'manual', value: typed })
    }
    return items
  }
  function renderMenu() {
    const items = menuItems()
    if (activeIndex >= items.length) activeIndex = Math.max(0, items.length - 1)
    clear(menu)
    let lastGroup = ''
    items.forEach((item, index) => {
      const group = item.type === 'all' ? 'all' : item.type === 'instance' ? 'instance' : 'versions'
      if (group !== lastGroup) {
        lastGroup = group
        menu.appendChild(h('div', { class: 'lp-vc-group' },
          group === 'all' ? '版本范围' : group === 'instance' ? '当前实例' : 'Minecraft 版本'))
      }
      const label = item.type === 'all'
        ? allLabel
        : item.type === 'instance'
          ? `${currentLabel}：${item.value}`
          : item.type === 'manual'
            ? `使用 “${item.value}”`
            : item.value
      const badges = []
      if (item.type === 'all') badges.push({ text: '不限', tone: '' })
      if (item.type === 'instance') badges.push({ text: '推荐', tone: 'accent' })
      if (item.type === 'manual') badges.push({ text: '手动输入', tone: 'warn' })
      const row = h('button', {
        class: 'lp-vc-item' + (item.value === current ? ' is-active' : '') + (item.type === 'instance' ? ' is-current' : ''),
        type: 'button', role: 'option', 'aria-selected': String(item.value === current), dataset: { index: String(index) },
        onclick: () => apply(item.value),
        onmousemove: () => { activeIndex = index; syncActive() }
      }, h('span', { class: 'lp-vc-item-text' }, label),
      badges.length ? h('span', { class: 'lp-vc-badges' }, ...badges.map((b) => h('span', { class: 'lp-vc-badge ' + (b.tone || '') }, b.text))) : null)
      menu.appendChild(row)
    })
    if (!items.length) menu.appendChild(h('div', { class: 'lp-vc-hint' }, '没有匹配的版本'))
    syncActive()
  }
  function syncActive() {
    const rows = [...menu.querySelectorAll('.lp-vc-item')]
    rows.forEach((row, index) => row.classList.toggle('is-focus', index === activeIndex))
  }
  function toggle(next) {
    open = next === undefined ? !open : !!next
    menu.hidden = !open
    field.setAttribute('aria-expanded', String(open))
    wrap.classList.toggle('is-open', open)
    if (open) {
      activeIndex = 0
      renderMenu()
    }
  }
  function apply(next, { silent = false } = {}) {
    const text = String(next ?? '').trim()
    current = text
    field.value = text
    setError('')
    toggle(false)
    field.blur?.()
    if (!silent) onChange?.(text)
  }
  function commitFromInput() {
    const typed = String(field.value || '').trim()
    if (!typed) { apply(''); return }
    if (!isMinecraftVersion(typed)) {
      setError(`「${typed}」不是有效的 MC 版本号，请输入类似 1.21.8 或 26.3 的版本。`)
      return
    }
    apply(typed)
  }
  renderMenu()
  paintError()
  return {
    el: wrap,
    getValue: () => current,
    setValue: (next, options) => apply(next, options),
    setVersions: (items) => { list = normalizeVersions(items); if (open) renderMenu() },
    setInstanceMc: (next) => { instance = String(next || '').trim(); if (open) renderMenu() },
    setError,
    focus: () => field.focus(),
    destroy: cleanup
  }
}

/** 版本列表里的一行通用骨架：调用方传入右侧动作与附加徽章。 */
export function versionRowShell({
  version, mc = '', loader = '', kind = 'mods', recommended = false, current = false,
  action = null, extraBadges = [], showChangelog = false
} = {}) {
  const badges = [
    ...versionTagBadges(version, { mc, loader, kind, recommended, current }).map((item) => h('span', { class: 'badge ' + (item.tone || ''), title: item.title }, item.text)),
    ...extraBadges
  ]
  const type = String(version?.type || '')
  const typeLabel = type === 'release' ? '正式版' : type === 'beta' ? '测试版' : type === 'alpha' ? '预览版' : ''
  const size = Number(version?.files?.[0]?.size || version?.size || 0)
  const gameVersions = Array.isArray(version?.gameVersions) ? version.gameVersions : []
  const loaders = Array.isArray(version?.loaders) ? version.loaders : []
  const date = versionDate(version)
  return h('div', { class: 'lp-row lp-mod-version' + (current ? ' is-current' : '') + (recommended ? ' is-recommended' : '') },
    h('div', { class: 'lp-mod-main' },
      h('div', { class: 'lp-mod-title' },
        h('b', { title: version?.name || version?.number || '' }, version?.name || version?.number || '未命名版本'),
        typeLabel ? h('span', { class: 'badge' }, typeLabel) : null,
        ...badges,
        size ? h('span', { class: 'lp-chip mono' }, fmtBytes(size)) : null),
      h('div', { class: 'lp-mod-meta mono' },
        [gameVersions.join(', '), loaders.join(', '), date ? '发布于 ' + fmtAgo(date) : ''].filter(Boolean).join(' · ')),
      version?.files?.[0]?.name
        ? h('div', { class: 'lp-hint mono', title: version.files[0].name }, version.files[0].name)
        : (showChangelog && version?.changelog ? h('div', { class: 'lp-hint' }, String(version.changelog).slice(0, 200)) : null)
    ),
    h('div', { class: 'lp-mod-actions' }, action)
  )
}
