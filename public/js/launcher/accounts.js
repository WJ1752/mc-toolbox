// 账户管理：离线登录、微软设备码 OAuth、authlib-injector 第三方登录。
//
// 令牌只保存在后端（launcherAccounts.json），本模块只处理脱敏后的账户信息。
// 微软登录的 device code 轮询与倒计时在弹窗关闭时必须停止。
import { h, clear, copyText, escapeHtml } from '../core/dom.js'
import { btn, input, seg, spinner } from '../ui/kit.js'
import { toast as defaultToast } from '../core/toast.js'
import { openModal as coreOpenModal, confirmDialog } from '../core/modal.js'
import { launcherApi } from './api.js'
import * as launcherUi from './ui.js'

const ADD_TYPES = [['offline', '离线'], ['microsoft', '微软'], ['authlib', '第三方']]
const MS_HINT = '默认使用内置公共客户端（与 PCL/HMCL 相同的微软设备码登录），无需注册 Azure 应用。也可以在启动器设置 → 账户中填写自己的 Azure 客户端 ID 覆盖。'

const helpers = (ctx) => Object.assign({}, launcherUi, ctx?.ui || {})
const apiOf = (ctx) => ctx?.api || launcherApi
const rawState = (ctx) => (typeof ctx?.getState === 'function' ? ctx.getState() : null)

function settingsOf(ctx) {
  const state = rawState(ctx)
  if (!state) return null
  return state.settings && typeof state.settings === 'object' ? state.settings : state
}

function normalizeAccounts(value) {
  if (!value) return { selected: '', items: [] }
  if (Array.isArray(value)) {
    return { selected: value.find((item) => item?.selected)?.id || value[0]?.id || '', items: value.filter(Boolean) }
  }
  const items = Array.isArray(value.items) ? value.items.filter(Boolean) : []
  return { selected: value.selected || items.find((item) => item.selected)?.id || '', items }
}

function initialAccounts(ctx) {
  const value = rawState(ctx)?.accounts
  if (!value || (!Array.isArray(value) && !Array.isArray(value.items))) return null
  return normalizeAccounts(value)
}

function shortUuid(uuid) {
  const text = String(uuid || '').replace(/-/g, '')
  return text ? text.slice(0, 8) : '—'
}

function hostOf(url) {
  try { return new URL(String(url)).host } catch { return String(url || '') }
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return /^https?:$/.test(url.protocol) ? url.toString() : ''
  } catch { return '' }
}

function validateOfflineName(name) {
  return /^[\p{L}\p{N}_]{3,16}$/u.test(String(name || '').trim())
    ? ''
    : '玩家名需要 3–16 个字符，只能包含字母、数字、下划线或文字'
}

function mmss(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function notifyAccounts(ctx, payload) {
  try { ctx?.onChanged?.(payload) } catch (e) { console.warn('[accounts] onChanged', e) }
}

/**
 * Open the account manager modal.
 * @param {{api:object,ui:object,toast:Function,confirm:Function,openModal:Function,
 *          getState?:Function,onChanged?:Function}} ctx
 * @returns {object} the modal handle from openModal()
 */
export function openAccountManager(ctx = {}) {
  const api = apiOf(ctx)
  const U = helpers(ctx)
  const toast = ctx.toast || defaultToast
  const confirm = ctx.confirm || confirmDialog
  const openModal = ctx.openModal || coreOpenModal

  let closed = false
  let loading = false
  let loadError = ''
  let accounts = initialAccounts(ctx) || { selected: '', items: [] }
  let addType = 'offline'
  let msClientId = String(settingsOf(ctx)?.msClientId || '')

  /* Microsoft device-code state — all timers are stopped by cleanup(). */
  let msSession = null
  let msTicker = null
  let msExpiresAt = 0
  let msNextPollAt = 0
  let msInterval = 5
  let msPolling = false
  let msStarting = false

  const countEl = h('span', { class: 'lp-hint' })
  const listEl = h('div', { class: 'lp-account-list', role: 'list', 'aria-label': '已保存的账户' })
  const listFoot = h('div', { class: 'lp-hint' })
  const listRefresh = btn('刷新列表', { size: 'sm', variant: 'ghost', iconName: 'refresh', onClick: () => loadAccounts() })

  /* ---------------- offline ---------------- */
  const offlineName = input({ placeholder: '例如 Steve_2024' })
  offlineName.maxLength = 16
  const offlineError = h('div', { class: 'error', hidden: true })
  const offlineAdd = btn('添加离线账户', { variant: 'primary', iconName: 'add', onClick: () => addOffline() })
  let offlineBusy = false

  const offlinePanel = h('div', { class: 'lp-account-form', dataset: { type: 'offline' } },
    h('div', { class: 'lp-hint' }, '离线账户只在本机保存一个名字，适合单机或离线服务器；无需密码，也不验证正版所有权。'),
    h('div', { class: 'field' },
      h('label', {}, '玩家名'), offlineName,
      h('div', { class: 'hint' }, '3–16 个字符，支持字母、数字、下划线或中文。同名账户会自动选中已有账户。'),
      offlineError
    ),
    h('div', { class: 'lp-row' }, offlineAdd)
  )
  offlineName.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); addOffline() }
  })

  function showOfflineError(message) {
    offlineError.textContent = message || ''
    offlineError.hidden = !message
    offlineName.closest('.field')?.classList.toggle('invalid', !!message)
  }

  async function addOffline() {
    if (offlineBusy) return
    const name = offlineName.value.trim()
    const problem = validateOfflineName(name)
    if (problem) { showOfflineError(problem); offlineName.focus(); return }
    offlineBusy = true
    offlineAdd.disabled = true
    offlineAdd.classList.add('loading')
    showOfflineError('')
    try {
      const result = await api.addOffline(name)
      if (closed) return
      setAccounts(normalizeAccounts(result.accounts))
      offlineName.value = ''
      toast(`已添加离线账户 ${result.account?.name || name}`, 'ok')
    } catch (e) {
      // 后端对同名离线账户会先选中再报错，这里同步一次列表。
      if (/已为你选中/.test(e.message)) {
        toast(e.message, 'warn')
        await loadAccounts({ silent: true })
      } else {
        showOfflineError(e.message)
        toast('添加离线账户失败：' + e.message, 'err')
      }
    } finally {
      offlineBusy = false
      offlineAdd.disabled = false
      offlineAdd.classList.remove('loading')
    }
  }

  /* ---------------- microsoft ---------------- */
  const msHint = h('div', { class: 'lp-hint lp-account-ms-hint' })
  const msCode = h('div', { class: 'lp-auth-code lp-ms-code', 'aria-live': 'polite' })
  const msUri = h('div', { class: 'lp-hint mono lp-ms-uri' })
  const msLink = h('a', { class: 'btn btn-sm', target: '_blank', rel: 'noopener noreferrer', hidden: true }, '打开验证页面')
  const msCountdown = h('span', { class: 'lp-hint lp-ms-countdown' })
  const msCodeBox = h('div', { class: 'lp-account-ms-code', hidden: true },
    h('div', { class: 'lp-hint' }, '在打开的微软页面中输入下面的验证码：'),
    msCode, msUri,
    h('div', { class: 'lp-row' },
      btn('复制验证码', { size: 'sm', iconName: 'copy', onClick: () => copyCode() }),
      msLink
    ),
    msCountdown
  )
  const msStatus = h('div', { class: 'lp-row lp-account-ms-status', hidden: true },
    spinner(13), h('span', {}, '等待你在浏览器中完成登录…'))
  const msSuccess = h('div', { class: 'lp-account-ms-success', hidden: true })
  const msError = h('div', { class: 'error', hidden: true })
  const msStart = btn('获取验证码', { variant: 'primary', iconName: 'external', onClick: () => startMs() })
  const msCancel = btn('取消登录', { size: 'sm', variant: 'ghost', onClick: () => cancelMs() })
  msCancel.hidden = true

  const msPanel = h('div', { class: 'lp-account-form', dataset: { type: 'microsoft' } },
    h('div', { class: 'lp-hint' }, '微软登录使用设备代码：启动器只显示验证码，密码与二次验证都在微软官方页面完成，启动器不会接触密码。'),
    msHint,
    h('div', { class: 'lp-row' }, msStart, msCancel),
    msCodeBox, msStatus, msSuccess, h('div', { class: 'field' }, msError)
  )

  function syncMsHint() {
    clear(msHint)
    const configured = !!msClientId
    msHint.append(
      h('span', { class: 'badge ok' }, configured ? '使用自定义 Azure 客户端' : '内置公共客户端'),
      h('span', {}, configured ? '登录时会提示打开验证页面，验证码有效期约 15 分钟。' : MS_HINT)
    )
  }

  function setMsError(message) {
    msError.textContent = message || ''
    msError.hidden = !message
  }

  function resetMsView() {
    msCodeBox.hidden = true
    msStatus.hidden = true
    msSuccess.hidden = true
    msCancel.hidden = true
    setMsError('')
    msStart.textContent = '获取验证码'
  }

  function stopMs() {
    if (msTicker) clearInterval(msTicker)
    msTicker = null
    msSession = null
    msPolling = false
  }

  function failMs(message, kind = 'err') {
    stopMs()
    msCodeBox.hidden = true
    msStatus.hidden = true
    msCancel.hidden = true
    msStart.textContent = '重新获取验证码'
    setMsError(message)
    toast(message, kind)
  }

  async function copyCode() {
    const code = msCode.textContent || ''
    if (!code) return
    const ok = await copyText(code)
    toast(ok ? '验证码已复制' : '复制失败，请手动选择验证码', ok ? 'ok' : 'err')
  }

  function updateCountdown() {
    if (!msSession) return
    const left = msExpiresAt - Date.now()
    msCountdown.textContent = left > 0
      ? `验证码剩余 ${mmss(left)} 过期，请尽快完成登录。`
      : '验证码已过期，请重新获取。'
  }

  function startMsTicker() {
    if (msTicker) clearInterval(msTicker)
    msTicker = setInterval(() => {
      if (closed || !msSession) { stopMs(); return }
      updateCountdown()
      if (Date.now() >= msExpiresAt) { failMs('验证码已过期，请重新获取。', 'warn'); return }
      if (!msPolling && Date.now() >= msNextPollAt) pollMs()
    }, 1000)
  }

  function cancelMs() {
    stopMs()
    resetMsView()
    toast('已取消微软登录', 'info')
  }

  async function startMs() {
    if (msStarting) return
    stopMs()
    msStarting = true
    resetMsView()
    msStart.disabled = true
    msStart.classList.add('loading')
    try {
      const session = await api.msStart()
      if (closed) return
      msSession = session
      msInterval = Math.max(3, Number(session.interval) || 5)
      msExpiresAt = Date.now() + Math.max(30, Number(session.expiresIn) || 900) * 1000
      msCode.textContent = session.userCode || '--------'
      const url = safeExternalUrl(session.verificationUri)
      msLink.hidden = !url
      if (url) msLink.href = url
      msUri.textContent = url
      msCodeBox.hidden = false
      msStatus.hidden = false
      msCancel.hidden = false
      msStart.textContent = '重新获取验证码'
      msNextPollAt = Date.now() + msInterval * 1000
      updateCountdown()
      startMsTicker()
    } catch (e) {
      if (!closed) {
        setMsError(e.message)
        toast('获取微软验证码失败：' + e.message, 'err')
      }
    } finally {
      msStarting = false
      msStart.disabled = false
      msStart.classList.remove('loading')
    }
  }

  async function pollMs() {
    if (!msSession || msPolling || closed) return
    const sessionId = msSession.id
    msPolling = true
    try {
      const result = await api.msPoll(sessionId)
      if (closed || !msSession || msSession.id !== sessionId) return
      if (result.status === 'pending') {
        if (Number(result.interval)) msInterval = Math.max(3, Number(result.interval))
        msNextPollAt = Date.now() + msInterval * 1000
        return
      }
      if (result.status === 'done') { await finishMs(result); return }
      failMs(result.error || (result.status === 'denied' ? '你拒绝了微软登录授权。' : '验证码已过期，请重新获取。'), 'warn')
    } catch (e) {
      if (!closed) failMs(e.message)
    } finally {
      msPolling = false
    }
  }

  async function finishMs(result) {
    const name = result.account?.name || '微软账户'
    stopMs()
    msCodeBox.hidden = true
    msStatus.hidden = true
    msCancel.hidden = true
    msStart.textContent = '再添加一个微软账户'
    setMsError('')
    clear(msSuccess)
    msSuccess.append(h('span', { class: 'badge ok' }, '登录成功'), h('span', {}, `已添加 ${name}，并设为当前账户。`))
    msSuccess.hidden = false
    toast(`微软登录成功：${name}`, 'ok')
    try {
      const payload = await api.accounts()
      if (!closed) setAccounts(normalizeAccounts(payload))
    } catch (e) {
      if (!closed) toast('账户已登录，但刷新列表失败：' + e.message, 'warn')
    }
  }

  /* ---------------- authlib-injector ---------------- */
  const authServer = input({ value: 'https://littleskin.cn/api/yggdrasil', mono: true, placeholder: 'https://example.com/api/yggdrasil' })
  const authUser = input({ placeholder: '邮箱或用户名' })
  const authPass = input({ type: 'password', placeholder: '密码' })
  authPass.setAttribute('autocomplete', 'off')
  const authError = h('div', { class: 'error', hidden: true })
  const authSubmit = btn('登录第三方账户', { variant: 'primary', iconName: 'user', onClick: () => submitAuthlib() })
  let authBusy = false

  const authPanel = h('div', { class: 'lp-account-form', dataset: { type: 'authlib' } },
    h('div', { class: 'lp-hint' }, '适用于 authlib-injector 皮肤站（Yggdrasil API）。密码只会发送到你填写的认证服务器，不会保存在本机；启动器只保存返回的登录令牌。'),
    h('div', { class: 'lp-form-grid' },
      h('div', { class: 'field span-2' },
        h('label', {}, '认证服务器地址'), authServer,
        h('div', { class: 'hint' }, '示例：https://littleskin.cn/api/yggdrasil（LittleSkin）。可省略末尾的 /authserver。')
      ),
      h('div', { class: 'field' }, h('label', {}, '用户名 / 邮箱'), authUser),
      h('div', { class: 'field' },
        h('label', {}, '密码'), authPass,
        h('div', { class: 'hint' }, '仅本次登录使用，不会写入启动器配置。')
      )
    ),
    h('div', { class: 'field' }, authError),
    h('div', { class: 'lp-row' }, authSubmit)
  )
  for (const node of [authServer, authUser, authPass]) {
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); submitAuthlib() }
    })
  }

  function showAuthError(message) {
    authError.textContent = message || ''
    authError.hidden = !message
  }

  async function submitAuthlib() {
    if (authBusy) return
    const server = authServer.value.trim()
    const username = authUser.value.trim()
    const password = authPass.value
    if (!server) { showAuthError('请填写认证服务器地址'); authServer.focus(); return }
    if (!username) { showAuthError('请填写用户名或邮箱'); authUser.focus(); return }
    if (!password) { showAuthError('请填写密码'); authPass.focus(); return }
    authBusy = true
    authSubmit.disabled = true
    authSubmit.classList.add('loading')
    showAuthError('')
    try {
      const result = await api.authlibLogin({ server, username, password })
      if (closed) return
      authPass.value = ''
      setAccounts(normalizeAccounts(result.accounts))
      toast(`第三方登录成功：${result.account?.name || username}`, 'ok')
    } catch (e) {
      if (!closed) {
        showAuthError(e.message)
        toast('第三方登录失败：' + e.message, 'err')
      }
    } finally {
      authBusy = false
      authSubmit.disabled = false
      authSubmit.classList.remove('loading')
    }
  }

  /* ---------------- list ---------------- */
  function setAccounts(payload, notify = true) {
    accounts = normalizeAccounts(payload)
    renderList()
    if (notify) notifyAccounts(ctx, accounts)
    updateFooter()
  }

  async function loadAccounts({ silent = false } = {}) {
    loading = true
    loadError = ''
    renderList()
    try {
      const payload = await api.accounts()
      if (closed) return
      setAccounts(normalizeAccounts(payload))
    } catch (e) {
      if (closed) return
      loadError = e.message
      if (!silent) toast('读取账户失败：' + e.message, 'err')
    } finally {
      loading = false
      if (!closed) renderList()
    }
  }

  function accountRow(account) {
    const actions = h('div', { class: 'lp-account-actions lp-account-row-actions' })
    const useBtn = btn(account.selected ? '使用中' : '使用', {
      size: 'sm',
      variant: account.selected ? 'ghost' : 'primary',
      disabled: !!account.selected,
      onClick: () => useAccount(account, useBtn)
    })
    actions.appendChild(useBtn)
    if (account.type !== 'offline') {
      const refreshBtn = btn('刷新', { size: 'sm', iconName: 'refresh', onClick: () => refreshAccount(account, refreshBtn) })
      actions.appendChild(refreshBtn)
    }
    actions.appendChild(btn('删除', { size: 'sm', variant: 'danger', onClick: () => deleteAccount(account) }))

    const meta = [`UUID ${shortUuid(account.uuid)}`]
    if (account.authlibServer) meta.push(hostOf(account.authlibServer))
    if (account.needsRefresh) meta.push('登录令牌即将过期')
    return h('div', {
      class: 'lp-account-row' + (account.selected ? ' active selected' : ''),
      role: 'listitem',
      title: account.name || ''
    },
      U.playerAvatar(account, { size: 34 }),
      h('div', { class: 'lp-account-main' },
        h('div', { class: 'lp-row lp-account-name' },
          h('b', {}, account.name || '未知账户'),
          h('strong', { class: 'badge ' + (account.type === 'microsoft' ? 'info' : account.type === 'authlib' ? 'accent' : '') }, U.accountTypeLabel(account.type)),
          account.selected ? h('strong', { class: 'badge ok' }, '当前') : null
        ),
        h('div', { class: 'lp-account-meta mono' }, meta.join(' · '))
      ),
      actions
    )
  }

  async function useAccount(account, button) {
    if (account.selected) return
    button.disabled = true
    button.classList.add('loading')
    try {
      const payload = await api.selectAccount(account.id)
      if (closed) return
      setAccounts(normalizeAccounts(payload))
      toast(`已切换到 ${account.name}`, 'ok')
    } catch (e) {
      toast('切换账户失败：' + e.message, 'err')
      button.disabled = false
      button.classList.remove('loading')
    }
  }

  async function refreshAccount(account, button) {
    button.disabled = true
    button.classList.add('loading')
    try {
      const payload = await api.refreshAccount(account.id)
      if (closed) return
      setAccounts(normalizeAccounts(payload))
      toast(`已刷新 ${account.name}`, 'ok')
    } catch (e) {
      toast('刷新账户失败：' + e.message, 'err')
      button.disabled = false
      button.classList.remove('loading')
    }
  }

  async function deleteAccount(account) {
    const ok = await confirm(
      `删除账户「${escapeHtml(account.name || '')}」？\n只删除本机保存的登录令牌与账户信息，不会影响该账户本身。`,
      { title: '删除账户', danger: true, okText: '删除' }
    )
    if (!ok) return
    try {
      const payload = await api.deleteAccount(account.id)
      if (closed) return
      setAccounts(normalizeAccounts(payload))
      toast('账户已删除', 'ok')
    } catch (e) {
      toast('删除账户失败：' + e.message, 'err')
    }
  }

  function renderList() {
    clear(listEl)
    countEl.textContent = accounts.items.length ? `共 ${accounts.items.length} 个账户` : '尚未添加账户'
    listFoot.textContent = accounts.items.length ? '启动游戏时使用带「当前」标记的账户；第三方账户启动时会自动加载 authlib-injector。' : ''
    listRefresh.disabled = loading
    if (loadError && !accounts.items.length) {
      listEl.appendChild(h('div', { class: 'lp-account-error' },
        h('span', { class: 'badge bad' }, '读取失败'), h('span', {}, loadError),
        btn('重试', { size: 'sm', onClick: () => loadAccounts() })
      ))
      return
    }
    if (loading && !accounts.items.length) {
      listEl.appendChild(h('div', { class: 'lp-account-loading' }, spinner(14), '正在读取账户…'))
      return
    }
    if (!accounts.items.length) {
      listEl.appendChild(U.emptyBlock('还没有账户',
        '添加一个离线账户即可开始游戏；正版用户可以使用微软登录，皮肤站用户可以使用第三方登录。', null, 'user'))
      return
    }
    for (const account of accounts.items) listEl.appendChild(accountRow(account))
  }

  /* ---------------- shell ---------------- */
  const typeSeg = seg(ADD_TYPES, addType, (value) => { addType = value; paintAddPanels() })
  function paintAddPanels() {
    offlinePanel.hidden = addType !== 'offline'
    msPanel.hidden = addType !== 'microsoft'
    authPanel.hidden = addType !== 'authlib'
  }
  paintAddPanels()
  syncMsHint()

  if (accounts.items.length) renderList()
  else loadAccounts()

  const body = h('div', { class: 'lp-accounts' },
    h('div', { class: 'lp-subhead' }, h('b', {}, '账户'), countEl, h('span', { class: 'spacer' }), listRefresh),
    listEl,
    listFoot,
    h('div', { class: 'lp-subhead' }, '添加账户'),
    typeSeg, offlinePanel, msPanel, authPanel
  )

  const footerSummary = h('span', { class: 'lp-hint', style: { marginRight: 'auto' } })
  let modal = null

  function updateFooter() {
    const current = accounts.items.find((item) => item.selected || item.id === accounts.selected)
    footerSummary.textContent = current ? `当前账户：${current.name}` : '当前未选择账户'
  }
  updateFooter()

  modal = openModal({
    title: '账户',
    size: 'lg',
    body,
    buttons: [{ label: '关闭', class: 'btn-ghost', onClick: () => modal?.close() }],
    onClose: () => { closed = true; stopMs() }
  })
  if (modal?.foot) {
    modal.foot.insertBefore(h('span', { class: 'lp-account-foot' }, footerSummary), modal.foot.firstChild)
  }
  return modal
}

/**
 * Small account card for the launcher main page.
 *
 * `render(accounts)` accepts either the `accounts.listAccounts()` payload
 * (`{ selected, items }`) or a plain array; calling it with no argument
 * re-fetches from the API.
 *
 * @param {object} ctx same shape as openAccountManager(); `onChanged(payload)` is optional.
 * @returns {{el: HTMLElement, render: (accounts?: object|Array) => void, refresh: () => Promise<void>}}
 */
export function createAccountCard(ctx = {}) {
  const api = apiOf(ctx)
  const U = helpers(ctx)
  let accounts = initialAccounts(ctx) || { selected: '', items: [] }
  let loading = false
  let loadError = ''
  let token = 0

  const root = h('section', { class: 'lp-card lp-account-card' })
  const body = h('div', { class: 'lp-card-body' })
  root.append(
    h('div', { class: 'lp-card-head' },
      h('div', { class: 'lp-card-title' }, h('b', {}, '账户'), h('span', {}, '离线 / 微软 / 第三方')),
      h('div', { class: 'lp-card-actions' },
        btn('管理', { size: 'sm', variant: 'ghost', iconName: 'settings', onClick: () => openManager() }))
    ),
    body
  )

  function openManager() {
    openAccountManager({
      ...ctx, api, ui: U,
      onChanged: (payload) => { render(payload); notifyAccounts(ctx, payload) }
    })
  }

  function emptyNode(error = '') {
    if (error) {
      return U.emptyBlock('读取账户失败', error, btn('重试', { size: 'sm', onClick: () => load() }), 'warning')
    }
    return U.emptyBlock('未登录', '添加账户后才能启动游戏。',
      btn('添加账户', { variant: 'primary', size: 'sm', iconName: 'add', onClick: openManager }), 'user')
  }

  function paint() {
    clear(body)
    if (loading) {
      body.appendChild(h('div', { class: 'lp-account-loading' }, spinner(13), '读取账户…'))
      return
    }
    if (!accounts.items.length) {
      body.appendChild(emptyNode(loadError))
      return
    }
    const item = accounts.items.find((entry) => entry.selected) || accounts.items[0]
    const meta = [U.accountTypeLabel?.(item.type) || '']
    if (item.authlibServer) meta.push(hostOf(item.authlibServer))
    else meta.push(`UUID ${shortUuid(item.uuid)}`)
    body.appendChild(h('div', { class: 'lp-row lp-account-current' },
      U.playerAvatar(item, { size: 40 }),
      h('div', { class: 'lp-account-main' },
        h('div', { class: 'lp-row lp-account-name' },
          h('b', {}, item.name || '未知账户'),
          h('strong', { class: 'badge ' + (item.type === 'microsoft' ? 'info' : item.type === 'authlib' ? 'accent' : '') }, U.accountTypeLabel(item.type))
        ),
        h('div', { class: 'lp-account-meta mono' }, meta.filter(Boolean).join(' · '))
      ),
      h('span', { class: 'spacer' }),
      btn('切换账户', { size: 'sm', iconName: 'swap', onClick: openManager })
    ))
  }

  async function load() {
    const my = ++token
    loading = true
    loadError = ''
    paint()
    try {
      const payload = await api.accounts()
      if (my !== token) return
      accounts = normalizeAccounts(payload)
    } catch (e) {
      if (my !== token) return
      loadError = e.message
    } finally {
      if (my === token) {
        loading = false
        paint()
      }
    }
  }

  function render(value) {
    if (value === undefined) { load(); return }
    token++
    loading = false
    loadError = ''
    accounts = normalizeAccounts(value)
    paint()
  }

  if (rawState(ctx)?.accounts) paint()
  else load()

  return { el: root, render, refresh: load }
}
