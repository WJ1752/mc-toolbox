// 账户系统：离线、微软（设备码 OAuth）、authlib-injector 第三方登录。
//
// 令牌只保存在本机的 launcherAccounts.json（Windows 下尽量收紧文件权限），
// API 只返回脱敏后的账户信息，绝不会把 accessToken / refreshToken 发给前端。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { CONFIG_DIR } from '../paths.js'
import { store } from '../store.js'
import { httpFetch } from '../http.js'
import { downloadVerified } from '../verified-download.js'
import { getSettings, launcherRoot } from './state.js'
import { offlineUuid } from './launch-plan.js'

const STORE_KEY = 'launcherAccounts'
const MS_AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'
const MS_SCOPE = 'XboxLive.signin offline_access'
// PCL2 / 多款社区启动器使用的微软公共客户端。它由微软自己维护，
// 走 Live Connect 设备码流程，用户无需注册 Azure 应用；填了自己的
// Azure 客户端 ID 时优先使用 Azure v2 设备码流程。
const MS_BUILTIN_CLIENT_ID = '00000000402b5328'
const MS_LIVE_DEVICE = 'https://login.live.com/oauth20_connect.srf'
const MS_LIVE_TOKEN = 'https://login.live.com/oauth20_token.srf'

const pending = new Map()

/** Resolve the effective Microsoft OAuth application and endpoint family. */
export function microsoftAuthConfig() {
  const configured = String(getSettings().msClientId || process.env.MC_TOOLBOX_MS_CLIENT_ID || '').trim()
  if (configured) {
    return {
      clientId: configured,
      flow: 'azure',
      deviceCodeUrl: `${MS_AUTH}/devicecode`,
      tokenUrl: `${MS_AUTH}/token`
    }
  }
  return {
    clientId: MS_BUILTIN_CLIENT_ID,
    flow: 'live',
    deviceCodeUrl: MS_LIVE_DEVICE,
    tokenUrl: MS_LIVE_TOKEN
  }
}

function load() {
  const data = store.get(STORE_KEY, { version: 1, selected: '', items: [] })
  if (!Array.isArray(data.items)) data.items = []
  if (!data.selected) data.selected = data.items[0]?.id || ''
  return data
}

function save(data) {
  store.set(STORE_KEY, data)
  try { fs.chmodSync(path.join(CONFIG_DIR, 'launcherAccounts.json'), 0o600) } catch {}
  return data
}

function newId() {
  return 'acct_' + crypto.randomBytes(8).toString('hex')
}

export function validateOfflineName(name) {
  const text = String(name || '').trim()
  if (!/^[\p{L}\p{N}_]{3,16}$/u.test(text)) {
    throw new Error('玩家名需要 3–16 个字符，只能包含字母、数字、下划线或文字')
  }
  return text
}

function textureInfo(textures) {
  try {
    const decoded = JSON.parse(Buffer.from(textures, 'base64').toString('utf8'))
    return {
      skin: decoded?.textures?.SKIN?.url || '',
      cape: decoded?.textures?.CAPE?.url || ''
    }
  } catch { return { skin: '', cape: '' } }
}

function parseProperties(properties = []) {
  const item = (properties || []).find((prop) => prop?.name === 'textures')
  return item ? textureInfo(item.value) : { skin: '', cape: '' }
}

export function publicAccount(account, selected = '') {
  if (!account) return null
  return {
    id: account.id,
    type: account.type,
    name: account.name,
    uuid: account.uuid,
    selected: account.id === selected,
    skin: account.skin || '',
    cape: account.cape || '',
    authlibServer: account.authlibServer || '',
    createdAt: account.createdAt || 0,
    lastUsed: account.lastUsed || 0,
    expiresAt: account.expiresAt || 0,
    needsRefresh: account.type === 'microsoft' && account.expiresAt > 0 && account.expiresAt < Date.now() + 5 * 60 * 1000
  }
}

export function listAccounts() {
  const data = load()
  return {
    selected: data.selected || '',
    items: data.items.map((item) => publicAccount(item, data.selected))
  }
}

export function getInternalAccount(id = '') {
  const data = load()
  const target = id || data.selected
  const account = data.items.find((item) => item.id === target) || data.items[0] || null
  return account
}

export function getSelectedAccount(id = '') {
  return getInternalAccount(id)
}

export async function getAccountForLaunch(id = '') {
  const account = getInternalAccount(id)
  if (!account) return null
  return ensureFreshAccount(account)
}

export function selectAccount(id) {
  const data = load()
  if (!data.items.some((item) => item.id === id)) throw new Error('账户不存在')
  data.selected = id
  save(data)
  return listAccounts()
}

export function removeAccount(id) {
  const data = load()
  data.items = data.items.filter((item) => item.id !== id)
  if (data.selected === id) data.selected = data.items[0]?.id || ''
  save(data)
  return listAccounts()
}

function addAccount(account, { select = true } = {}) {
  const data = load()
  const existing = data.items.findIndex((item) => item.id === account.id)
  account.lastUsed = Date.now()
  if (existing >= 0) data.items[existing] = { ...data.items[existing], ...account }
  else data.items.push(account)
  if (select || !data.selected) data.selected = account.id
  save(data)
  return publicAccount(account, data.selected)
}

/* ------------------------------------------------------------------ */
/* Offline                                                             */
/* ------------------------------------------------------------------ */

export function addOfflineAccount(name) {
  const clean = validateOfflineName(name)
  const uuid = offlineUuid(clean)
  const existing = load().items.find((item) => item.type === 'offline' && item.uuid === uuid)
  if (existing) {
    selectAccount(existing.id)
    throw new Error('已存在同名离线账户，已为你选中它')
  }
  return addAccount({
    id: newId(),
    type: 'offline',
    name: clean,
    uuid,
    accessToken: crypto.randomBytes(16).toString('hex'),
    clientToken: crypto.randomBytes(16).toString('hex'),
    createdAt: Date.now()
  })
}

/* ------------------------------------------------------------------ */
/* Microsoft                                                           */
/* ------------------------------------------------------------------ */

async function postForm(url, body, { signal } = {}) {
  const response = await httpFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
  })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  return { ok: response.ok, status: response.status, data }
}

async function postJson(url, body, { signal, headers = {} } = {}) {
  const response = await httpFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'MC-Toolbox/1.9.0', ...headers },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
  })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  return { ok: response.ok, status: response.status, data }
}

function xstsError(code) {
  const map = {
    2148916233: '该微软账户尚未创建 Xbox 档案，请先在 Xbox 官网登录一次。',
    2148916235: 'Xbox Live 在此地区不可用。',
    2148916236: '该账户需要完成年龄验证。',
    2148916237: '该账户需要家长同意。',
    2148916238: '儿童账户需要先加入 Xbox 家庭组。'
  }
  return map[Number(code)] || `Xbox 认证失败（XErr ${code}）`
}

async function completeMicrosoft(msToken, refreshToken, clientId, flow = 'azure') {
  const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msToken}` },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT'
  })
  if (!xbl.ok || !xbl.data?.Token) throw new Error('Xbox Live 认证失败：' + (xbl.data?.Message || `HTTP ${xbl.status}`))

  const xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.data.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT'
  })
  if (!xsts.ok || !xsts.data?.Token) {
    const xerr = xsts.data?.XErr
    throw new Error(xerr ? xstsError(xerr) : 'Xbox 安全令牌获取失败：' + (xsts.data?.Message || `HTTP ${xsts.status}`))
  }
  const uhs = xsts.data?.DisplayClaims?.xui?.[0]?.uhs
  if (!uhs) throw new Error('Xbox 认证返回缺少用户标识')

  const login = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox',
    { identityToken: `XBL3.0 x=${uhs};${xsts.data.Token}` },
    { headers: { Accept: 'application/json' } })
  if (!login.ok || !login.data?.access_token) {
    throw new Error('Minecraft 登录失败：' + (login.data?.errorMessage || login.data?.error || `HTTP ${login.status}`))
  }

  const profileRes = await httpFetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: 'Bearer ' + login.data.access_token, Accept: 'application/json', 'User-Agent': 'MC-Toolbox/1.9.0' },
    signal: AbortSignal.timeout(30000)
  })
  const profile = await profileRes.json().catch(() => null)
  if (!profileRes.ok) {
    const message = profile?.errorMessage || profile?.error || `HTTP ${profileRes.status}`
    if (/does not own|not entitled|NO_PROFILE|NOT_FOUND/i.test(message) || profileRes.status === 404) {
      throw new Error('该微软账户没有 Minecraft: Java Edition 的档案/所有权，无法启动正版游戏。')
    }
    throw new Error('获取 Minecraft 档案失败：' + message)
  }

  const skin = profile.skins?.find((item) => item.state === 'ACTIVE')?.url || profile.skins?.[0]?.url || ''
  const cape = profile.capes?.find((item) => item.state === 'ACTIVE')?.url || ''
  return {
    id: 'ms_' + String(profile.id || '').replace(/-/g, ''),
    type: 'microsoft',
    name: profile.name,
    uuid: profile.id,
    accessToken: login.data.access_token,
    refreshToken,
    clientId,
    msFlow: flow,
    xuid: xsts.data?.DisplayClaims?.xui?.[0]?.xid || '',
    expiresAt: Date.now() + (Number(login.data.expires_in) || 86400) * 1000,
    skin,
    cape,
    createdAt: Date.now()
  }
}

export async function startMicrosoftLogin() {
  const auth = microsoftAuthConfig()
  // Live Connect 设备码端点用 response_type=device_code；Azure v2 由 scope 决定。
  const body = auth.flow === 'live'
    ? { client_id: auth.clientId, scope: MS_SCOPE, response_type: 'device_code' }
    : { client_id: auth.clientId, scope: MS_SCOPE }
  const result = await postForm(auth.deviceCodeUrl, body)
  if (!result.ok) throw new Error('获取微软设备代码失败：' + (result.data?.error_description || `HTTP ${result.status}`))
  const data = result.data || {}
  const id = 'msdev_' + crypto.randomBytes(8).toString('hex')
  const interval = Math.max(3, Number(data.interval) || 5)
  const expiresAt = Date.now() + (Number(data.expires_in) || 900) * 1000
  pending.set(id, { deviceCode: data.device_code, clientId: auth.clientId, flow: auth.flow, interval, expiresAt, status: 'pending' })
  // Clean stale sessions so a long-running toolbox does not leak memory.
  for (const [key, item] of pending) if (item.expiresAt < Date.now()) pending.delete(key)
  return {
    id,
    userCode: data.user_code,
    verificationUri: data.verification_uri || 'https://microsoft.com/link',
    expiresIn: Number(data.expires_in) || 900,
    interval,
    // 内置公共客户端不需要用户注册 Azure 应用；前端据此显示更准确的提示。
    flow: auth.flow,
    builtinClient: auth.flow === 'live',
    message: data.message || ''
  }
}

export async function pollMicrosoftLogin(id) {
  const session = pending.get(id)
  if (!session) throw new Error('登录会话已过期，请重新获取验证码')
  if (session.expiresAt < Date.now()) {
    pending.delete(id)
    return { status: 'expired', error: '验证码已过期，请重新获取' }
  }
  const tokenUrl = session.flow === 'live' ? MS_LIVE_TOKEN : `${MS_AUTH}/token`
  const result = await postForm(tokenUrl, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: session.clientId,
    device_code: session.deviceCode
  })
  const data = result.data || {}
  if (!result.ok) {
    if (data.error === 'authorization_pending') return { status: 'pending', interval: session.interval }
    if (data.error === 'slow_down') {
      session.interval += 5
      return { status: 'pending', interval: session.interval, slowDown: true }
    }
    if (data.error === 'expired_token') {
      pending.delete(id)
      return { status: 'expired', error: '验证码已过期，请重新获取' }
    }
    if (data.error === 'authorization_declined' || data.error === 'access_denied') {
      pending.delete(id)
      return { status: 'denied', error: '用户拒绝了微软登录授权' }
    }
    throw new Error('微软登录失败：' + (data.error_description || data.error || `HTTP ${result.status}`))
  }
  if (!data.access_token) throw new Error('微软没有返回访问令牌')
  const account = await completeMicrosoft(data.access_token, data.refresh_token || '', session.clientId, session.flow)
  pending.delete(id)
  return { status: 'done', account: addAccount(account) }
}

export async function refreshMicrosoftAccount(account) {
  if (!account?.refreshToken) {
    const error = new Error('微软账户缺少刷新令牌，请重新登录')
    error.code = 'AUTH_REFRESH_FAILED'
    throw error
  }
  const flow = account.msFlow || (account.clientId === MS_BUILTIN_CLIENT_ID ? 'live' : 'azure')
  const clientId = account.clientId || microsoftAuthConfig().clientId
  const tokenUrl = flow === 'live' ? MS_LIVE_TOKEN : `${MS_AUTH}/token`
  const result = await postForm(tokenUrl, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: account.refreshToken,
    scope: MS_SCOPE
  })
  if (!result.ok || !result.data?.access_token) {
    const error = new Error('微软登录状态已过期，请重新登录账户')
    error.code = 'AUTH_REFRESH_FAILED'
    error.detail = result.data?.error_description || result.data?.error || ''
    throw error
  }
  const next = await completeMicrosoft(result.data.access_token, result.data.refresh_token || account.refreshToken, clientId, flow)
  addAccount({ ...account, ...next, id: account.id, createdAt: account.createdAt }, { select: false })
  return getInternalAccount(account.id)
}

/* ------------------------------------------------------------------ */
/* authlib-injector / Yggdrasil                                        */
/* ------------------------------------------------------------------ */

export function normalizeAuthServer(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('缺少第三方认证服务器地址')
  let url
  try { url = new URL(raw) } catch { throw new Error('认证服务器地址不是合法的 URL') }
  if (!/^https?:$/.test(url.protocol)) throw new Error('认证服务器必须使用 http 或 https')
  let pathname = url.pathname.replace(/\/+$/, '')
  if (pathname.endsWith('/authserver')) pathname = pathname.slice(0, -'/authserver'.length)
  if (pathname.endsWith('/sessionserver')) pathname = pathname.slice(0, -'/sessionserver'.length)
  url.pathname = pathname || '/'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

async function fetchAuthlibProfile(server, uuid, { signal } = {}) {
  try {
    const response = await httpFetch(`${server}/sessionserver/session/minecraft/profile/${uuid}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'MC-Toolbox/1.9.0' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)
    })
    if (!response.ok) return { skin: '', cape: '' }
    return parseProperties((await response.json())?.properties)
  } catch { return { skin: '', cape: '' } }
}

export async function loginAuthlib({ server, username, password }) {
  const base = normalizeAuthServer(server)
  const result = await postJson(`${base}/authserver/authenticate`, {
    username: String(username || ''),
    password: String(password || ''),
    clientToken: crypto.randomBytes(16).toString('hex'),
    agent: { name: 'Minecraft', version: 1 },
    requestUser: true
  })
  if (!result.ok || !result.data?.accessToken) {
    const message = result.data?.errorMessage || result.data?.error || `HTTP ${result.status}`
    if (/invalid credentials/i.test(message)) throw new Error('第三方账户或密码错误')
    throw new Error('第三方登录失败：' + message)
  }
  const profile = result.data.selectedProfile
  if (!profile?.id) throw new Error('该账户没有可用的 Minecraft 档案（服务器可能要求先创建角色）')
  const textures = await fetchAuthlibProfile(base, profile.id)
  return addAccount({
    id: 'authlib_' + profile.id.replace(/-/g, '') + '_' + crypto.createHash('sha1').update(base).digest('hex').slice(0, 8),
    type: 'authlib',
    name: profile.name,
    uuid: profile.id,
    accessToken: result.data.accessToken,
    clientToken: result.data.clientToken || '',
    authlibServer: base,
    ...textures,
    createdAt: Date.now()
  })
}

export async function refreshAuthlibAccount(account) {
  if (!account?.authlibServer) throw new Error('第三方账户信息不完整，请重新登录')
  const result = await postJson(`${account.authlibServer}/authserver/refresh`, {
    accessToken: account.accessToken,
    clientToken: account.clientToken || '',
    requestUser: true
  })
  if (!result.ok || !result.data?.accessToken) {
    const error = new Error('第三方登录状态已过期，请重新登录账户')
    error.code = 'AUTH_REFRESH_FAILED'
    throw error
  }
  const profile = result.data.selectedProfile || { id: account.uuid, name: account.name }
  const textures = await fetchAuthlibProfile(account.authlibServer, profile.id)
  const next = {
    ...account,
    name: profile.name || account.name,
    uuid: profile.id || account.uuid,
    accessToken: result.data.accessToken,
    clientToken: result.data.clientToken || account.clientToken,
    ...textures,
    validatedAt: Date.now()
  }
  addAccount(next, { select: false })
  return getInternalAccount(account.id)
}

/** Refresh / validate tokens before launch. Throws a clear, user-actionable error. */
export async function ensureFreshAccount(account) {
  if (!account) return null
  if (account.type === 'microsoft') {
    if (account.expiresAt && account.expiresAt > Date.now() + 5 * 60 * 1000) return account
    return await refreshMicrosoftAccount(account)
  }
  if (account.type === 'authlib') {
    if (account.validatedAt && Date.now() - account.validatedAt < 10 * 60 * 1000) return account
    try {
      const result = await postJson(`${account.authlibServer}/authserver/validate`, {
        accessToken: account.accessToken,
        clientToken: account.clientToken || ''
      })
      if (result.ok) {
        addAccount({ ...account, validatedAt: Date.now() }, { select: false })
        return getInternalAccount(account.id)
      }
    } catch {}
    return await refreshAuthlibAccount(account)
  }
  return account
}

let authlibCache = { version: '', jar: '' }

async function sha256Of(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function ensureAuthlibInjector(server, { signal } = {}) {
  const cacheDir = path.join(launcherRoot(), 'cache', 'authlib-injector')
  const metaFile = path.join(cacheDir, 'latest.json')
  let meta = null
  try {
    const response = await httpFetch('https://authlib-injector.yushi.moe/artifact/latest.json', {
      headers: { Accept: 'application/json', 'User-Agent': 'MC-Toolbox/1.9.0' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)
    })
    if (response.ok) meta = await response.json()
    if (meta) {
      await fsp.mkdir(cacheDir, { recursive: true })
      await fsp.writeFile(metaFile, JSON.stringify(meta))
    }
  } catch {}
  if (!meta) {
    try { meta = JSON.parse(await fsp.readFile(metaFile, 'utf8')) } catch { meta = null }
  }
  if (!meta?.version || !meta?.download_url) throw new Error('无法获取 authlib-injector，请检查网络后重试')
  const jar = path.join(cacheDir, `authlib-injector-${meta.version}.jar`)
  let valid = false
  if (fs.existsSync(jar)) {
    valid = !meta.checksums?.sha256 || (await sha256Of(jar).catch(() => '')) === String(meta.checksums.sha256).toLowerCase()
  }
  if (!valid) {
    await downloadVerified(meta.download_url, jar, {
      signal,
      hash: meta.checksums?.sha256 || '',
      algorithm: 'sha256',
      maxBytes: 32 * 1024 ** 2
    })
  }
  authlibCache = { version: meta.version, jar }
  return { jar, version: meta.version, server: normalizeAuthServer(server) }
}

/* ------------------------------------------------------------------ */
/* Public summary                                                      */
/* ------------------------------------------------------------------ */

export function accountsSummary() {
  const data = load()
  const selected = data.items.find((item) => item.id === data.selected) || null
  return {
    selected: data.selected || '',
    account: publicAccount(selected, data.selected),
    items: data.items.map((item) => publicAccount(item, data.selected))
  }
}

export { pending as pendingMicrosoftLogins }
