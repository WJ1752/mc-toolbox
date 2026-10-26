// 好友功能编排层（中心服务器模式）：
// - 用启动器里已登录的正版 MC 账户换取好友服务器会话；
// - 好友/在线状态/聊天/文件传输全部走服务器；
// - 整合包与模组文件只做临时中转，接收方下载完成后服务器自动删除。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { CONFIG_DIR, DATA_DIR } from '../paths.js'
import { PRODUCT_VERSION } from '../build-meta.js'
import { httpFetch } from '../http.js'
import { ClientStore } from './client-store.js'
import { FriendsServerClient } from './server-client.js'
import { resolveFriendsServer, sameFriendsServer } from './config.js'
import * as content from '../launcher/content.js'
import { findInstance, instancePaths } from '../launcher/state.js'
import { listSessions } from '../launcher/launch.js'
import { startPackExport, getExportJob } from '../launcher/pack-export.js'
import * as accounts from '../launcher/accounts.js'
import { applyJar, diffManifests, fillPlan, findStagedBySha, manifestFromItems, sha1File } from './mods-sync.js'
import { sanitizeFileName, uniqueFileName } from './transfer.js'

const RECEIVED_ROOT = process.env.MC_TOOLBOX_FRIENDS_RECEIVED || path.join(DATA_DIR, 'friends', 'received')
const MODRINTH_VERSION_FILE = 'https://api.modrinth.com/v2/version_file'
const USER_AGENT = `MC-Toolbox/${PRODUCT_VERSION} (friends-server)`
const HEARTBEAT_MS = 25000

let store = null
let client = null
let receivedRoot = RECEIVED_ROOT
let cache = null
let cacheAt = 0
let refreshing = null
let heartbeatTimer = null
const events = []
const uploads = new Map()
const downloads = new Map()
const jobs = new Map()
const hashCache = new Map()

function logEvent(text, kind = 'info') {
  events.unshift({ at: Date.now(), text: String(text).slice(0, 300), kind })
  if (events.length > 60) events.length = 60
}

function getStore() {
  if (!store) store = new ClientStore(process.env.MC_TOOLBOX_FRIENDS_CONFIG || path.join(CONFIG_DIR, 'friends.json'), { logger: console })
  return store
}

/** 把服务器地址/指纹锁定为启动器内置值；旧配置里的自定义地址会被覆盖。 */
function ensureLockedServer() {
  const desired = resolveFriendsServer()
  const state = getStore()
  const current = state.get().server
  if (!sameFriendsServer(current, desired)) {
    state.setServer(desired)
    client = null
    cache = null
    cacheAt = 0
  }
  return desired
}

function getClient() {
  ensureLockedServer()
  const state = getStore().get()
  if (!state.server.url) return null
  if (!client || client.url !== state.server.url || client.fingerprint !== state.server.fingerprint || client.token !== state.session.token) {
    client = new FriendsServerClient({
      url: state.server.url,
      fingerprint: state.server.fingerprint,
      token: state.session.token
    })
  }
  return client
}

function requireClient() {
  const instance = getClient()
  if (!instance) throw Object.assign(new Error('还没有配置好友服务器'), { code: 'NO_SERVER' })
  return instance
}

function activity() {
  try {
    const session = listSessions().find((item) => item && !item.endedAt && item.status !== 'failed')
    if (!session) return null
    const inst = findInstance(session.instanceId)
    if (!inst) return null
    return { instanceName: inst.name, mc: inst.mc, loader: inst.loader, since: session.startedAt || 0 }
  } catch {
    return null
  }
}

function selectedMcAccount() {
  const account = accounts.getSelectedAccount()
  if (!account) throw Object.assign(new Error('启动器里还没有账户，请先登录微软账户'), { code: 'NO_MC_ACCOUNT' })
  if (account.type !== 'microsoft') {
    throw Object.assign(new Error('好友功能只支持正版微软账户（离线/第三方账户无法通过正版校验）'), { code: 'ONLY_PREMIUM' })
  }
  return account
}

async function mcAccessToken() {
  const account = selectedMcAccount()
  const fresh = await accounts.getAccountForLaunch(account.id)
  if (!fresh?.accessToken) throw Object.assign(new Error('无法获取正版令牌，请重新登录微软账户'), { code: 'NO_MC_TOKEN' })
  return fresh
}

function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : []
  const results = new Array(list.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(Math.max(1, limit), list.length || 1) }, async () => {
    while (cursor < list.length) {
      const index = cursor++
      results[index] = await worker(list[index], index)
    }
  })
  return Promise.all(runners).then(() => results)
}

async function sha1For(file, size, mtime) {
  const key = path.resolve(file)
  const cached = hashCache.get(key)
  if (cached && cached.size === size && cached.mtime === mtime) return cached.sha1
  const sha1 = await sha1File(file)
  hashCache.set(key, { size, mtime, sha1 })
  return sha1
}

function instanceSummary(inst) {
  return { id: inst.id, name: inst.name, mc: inst.mc, loader: inst.loader, loaderVersion: inst.loaderVersion || '' }
}

async function manifestForInstance(inst) {
  const data = await content.listMods(inst)
  const items = await mapLimit(data.items, 8, async (item) => {
    try {
      item.sha1 = await sha1For(path.resolve(data.dir, item.relPath), Number(item.size) || 0, Number(item.mtime) || 0)
    } catch {
      item.sha1 = ''
    }
    return item
  })
  return {
    instance: instanceSummary(inst),
    dir: data.dir,
    items: manifestFromItems(items),
    counts: { total: data.total, enabled: data.enabled, disabled: data.disabled }
  }
}

function pickPeerInstance(peerInstances, mine) {
  const entries = Object.entries(peerInstances || {}).map(([key, value]) => ({ key, ...value }))
  if (!entries.length) return null
  const loader = String(mine.loader || '').toLowerCase()
  const same = entries.filter((entry) => String(entry.instance?.mc) === String(mine.mc)
    && String(entry.instance?.loader || '').toLowerCase() === loader)
  if (!same.length) return null
  same.sort((a, b) => {
    const aName = a.instance?.name === mine.name ? 0 : 1
    const bName = b.instance?.name === mine.name ? 0 : 1
    return aName - bName || (b.updatedAt || 0) - (a.updatedAt || 0)
  })
  return same[0]
}

export function configurePaths({ received = '' } = {}) {
  if (received) receivedRoot = path.resolve(received)
}

function invalidate() {
  cache = null
  cacheAt = 0
}

async function refresh({ force = false } = {}) {
  const state = getStore().get()
  if (!state.server.url || !state.session.token) return null
  if (!force && cache && Date.now() - cacheAt < 1200) return cache
  if (refreshing) {
    await refreshing.catch(() => {})
    if (!force && cache && Date.now() - cacheAt < 1200) return cache
  }
  if (refreshing) return refreshing
  refreshing = (async () => {
    const instance = requireClient()
    try {
      const [friends, files] = await Promise.all([
        instance.request('GET', '/api/friends'),
        instance.request('GET', '/api/files')
      ])
      cache = { friends, files }
      cacheAt = Date.now()
      return cache
    } catch (error) {
      if (error.code === 'SESSION_EXPIRED') {
        getStore().clearSession()
        logEvent('登录已失效，请重新登录', 'warn')
      }
      throw error
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

async function heartbeat() {
  const state = getStore().get()
  if (!state.server.url || !state.session.token) return
  try {
    const instance = getClient()
    if (!instance) return
    await instance.request('POST', '/api/heartbeat', {
      body: { activity: state.prefs.showActivity ? activity() : null }
    })
  } catch (error) {
    if (error.code === 'SESSION_EXPIRED') getStore().clearSession()
  }
}

function ensureHeartbeat() {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => { heartbeat().catch(() => {}) }, HEARTBEAT_MS)
  heartbeatTimer.unref?.()
}

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    phase: job.phase,
    detail: job.detail,
    progress: job.progress,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.result || null,
    logs: job.logs.slice(-60)
  }
}

function pushJobLog(job, text, kind = '') {
  job.logs.push({ at: Date.now(), text: String(text).slice(0, 400), kind })
  if (job.logs.length > 200) job.logs.shift()
  job.updatedAt = Date.now()
}

function pruneJobs() {
  const finished = [...jobs.values()].filter((job) => ['done', 'failed', 'cancelled'].includes(job.status))
  for (const job of finished.sort((a, b) => a.createdAt - b.createdAt).slice(0, Math.max(0, jobs.size - 10))) jobs.delete(job.id)
}

// ---------------- 服务器配置与登录 ----------------

export async function login({ invite = '' } = {}) {
  ensureLockedServer()
  const state = getStore().get()
  if (!state.server.url) throw Object.assign(new Error('内置好友服务器不可用，请更新启动器'), { code: 'NO_SERVER' })
  const account = await mcAccessToken()
  const instance = requireClient()
  const result = await instance.request('POST', '/api/auth/minecraft', {
    body: { accessToken: account.accessToken, invite }
  })
  getStore().setSession({
    token: result.token,
    expiresAt: result.expiresAt,
    profile: result.profile
  })
  if (!state.prefs.nickname && result.profile?.nickname) getStore().setPrefs({ nickname: result.profile.nickname })
  client = null
  cache = null
  ensureHeartbeat()
  await heartbeat()
  logEvent(`已登录好友服务器：${result.profile?.mcName || ''}`)
  return { profile: result.profile, expiresAt: result.expiresAt }
}

export async function logout() {
  try {
    await getClient()?.request('POST', '/api/auth/logout', {})
  } catch {}
  getStore().clearSession()
  cache = null
  client = null
  logEvent('已退出好友服务器')
  return { ok: true }
}

export async function saveSelf(patch = {}) {
  const state = getStore().get()
  if (state.session.token) {
    const instance = requireClient()
    const body = {}
    if (patch.nickname !== undefined) body.nickname = patch.nickname
    if (patch.showActivity !== undefined) body.activity = patch.showActivity ? activity() : null
    if (Object.keys(body).length) await instance.request('PUT', '/api/me', { body })
    if (body.nickname && state.session.profile) {
      state.session.profile.nickname = body.nickname
      getStore().setSession(state.session)
    }
  }
  const prefs = getStore().setPrefs({
    nickname: patch.nickname !== undefined ? patch.nickname : state.prefs.nickname,
    showActivity: patch.showActivity !== undefined ? patch.showActivity : state.prefs.showActivity,
    allowPull: patch.allowPull !== undefined ? patch.allowPull : state.prefs.allowPull,
    downloadDir: patch.downloadDir !== undefined ? patch.downloadDir : state.prefs.downloadDir,
    autoApplyMods: patch.autoApplyMods !== undefined ? patch.autoApplyMods : state.prefs.autoApplyMods
  })
  return { prefs }
}

// ---------------- 好友 ----------------

export async function addFriend(mcName) {
  const instance = requireClient()
  await instance.request('POST', '/api/friends/request', { body: { mcName: String(mcName || '').trim() } })
  invalidate()
  await refresh({ force: true })
  return { ok: true }
}

export async function respondFriend(uuid, accept) {
  const instance = requireClient()
  await instance.request('POST', '/api/friends/respond', { body: { uuid, accept: !!accept } })
  invalidate()
  await refresh({ force: true })
  return { ok: true }
}

export async function removeFriend(uuid) {
  const instance = requireClient()
  await instance.request('DELETE', '/api/friends/' + encodeURIComponent(uuid))
  invalidate()
  await refresh({ force: true })
  return { ok: true }
}

// ---------------- 聊天 ----------------

export async function messages(uuid, { after = 0, markRead: read = false } = {}) {
  const instance = requireClient()
  const result = await instance.request('GET', `/api/messages?with=${encodeURIComponent(uuid)}&after=${Number(after) || 0}`)
  if (read && result.items?.length) {
    await instance.request('POST', '/api/read', { body: { with: uuid, upTo: result.items[result.items.length - 1].at } }).catch(() => {})
  }
  return result
}

export async function sendMessage(uuid, text) {
  const instance = requireClient()
  const result = await instance.request('POST', '/api/messages', {
    body: { to: uuid, text: String(text || ''), clientId: 'm_' + crypto.randomBytes(9).toString('base64url').slice(0, 16) }
  })
  invalidate()
  return result
}

export async function markRead(uuid, upTo = 0) {
  const instance = requireClient()
  await instance.request('POST', '/api/read', { body: { with: uuid, upTo: Number(upTo) || Date.now() } })
  return { ok: true }
}

// ---------------- 文件传输 ----------------

function fileTargetPath(file) {
  const safe = sanitizeFileName(file.name, { fallback: file.kind === 'mod' ? 'mod.jar' : 'pack.mrpack' })
  return path.join(receivedRoot, file.id, safe)
}

/** 校验并解析用户指定的下载目录；空值表示「使用默认接收目录」。 */
function resolveDownloadDir(customDir) {
  const raw = String(customDir || '').trim()
  if (!raw) return ''
  const abs = path.resolve(raw)
  let stat
  try {
    stat = fs.statSync(abs)
  } catch {
    throw Object.assign(new Error('下载目录不存在：' + abs), { code: 'DIR_NOT_FOUND' })
  }
  if (!stat.isDirectory()) throw Object.assign(new Error('不是文件夹：' + abs), { code: 'NOT_A_DIR' })
  return abs
}

/**
 * 决定这次下载落到哪里：请求显式指定 > 设置里的下载目录 > 默认接收目录。
 * 设置里的目录被删除/改名时回退到默认目录，而不是让下载直接失败。
 */
function preferredDownloadDir(customDir) {
  const explicit = String(customDir || '').trim()
  if (explicit) return resolveDownloadDir(explicit)
  const saved = String(getStore().get().prefs.downloadDir || '').trim()
  if (!saved) return ''
  try {
    return resolveDownloadDir(saved)
  } catch {
    logEvent('设置的下载目录不可用，已回退到默认接收目录', 'warn')
    return ''
  }
}

function downloadTargetFor(file, dir) {
  if (!dir) return fileTargetPath(file)
  return path.join(dir, uniqueFileName(dir, file.name))
}

async function findPeerFile(id) {
  if (cache?.files?.incoming) {
    const found = cache.files.incoming.find((file) => file.id === id)
    if (found) return found
  }
  const instance = requireClient()
  const files = await instance.request('GET', '/api/files')
  cache = { ...(cache || {}), files }
  return files.incoming?.find((file) => file.id === id) || null
}

function peerName(uuid) {
  const friend = (cache?.friends?.friends || []).find((item) => item.uuid === uuid)
  return friend?.nickname || friend?.mcName || ''
}

/**
 * 下载对端文件。
 * - 默认落到「接收目录」，然后记录到「已接收」；
 * - 传 dir 时直接落到用户选择的目录（另存为/自定义下载目录）；
 * - 对模组文件传 instanceId 时，下载完成后直接校验 SHA-1 并放进该实例的 mods 目录，
 *   不再让用户自己去中转目录里手动搬运。
 */
export async function downloadFile(id, { dir = '', instanceId = '' } = {}) {
  const file = await findPeerFile(id)
  if (!file) throw new Error('文件不存在或已被清理')
  if (downloads.get(id)?.status === 'downloading') return { ok: true, already: true }

  const inst = instanceId ? findInstance(String(instanceId)) : null
  if (instanceId && !inst) throw new Error('实例不存在')
  const applyToInstance = file.kind === 'mod' && !!inst
  const downloadDir = applyToInstance ? '' : preferredDownloadDir(dir)
  const target = applyToInstance ? fileTargetPath(file) : downloadTargetFor(file, downloadDir)
  const record = {
    id,
    kind: file.kind,
    name: file.name,
    size: file.size,
    sha1: file.sha1,
    path: target,
    targetDir: downloadDir,
    appliedTo: applyToInstance ? inst.id : '',
    status: 'downloading',
    progress: 0,
    peer: file.peer,
    error: '',
    startedAt: Date.now()
  }
  downloads.set(id, record)
  const instance = requireClient()
  instance.downloadFile(id, target, {
    onProgress: ({ loaded, total, ratio }) => {
      record.progress = ratio * 100
      record.loaded = loaded
      record.total = total
    }
  }).then(async (result) => {
    record.progress = 100
    let finalPath = result.path
    let finalName = path.basename(result.path)
    if (applyToInstance) {
      const applied = await applyJar({
        sourceFile: result.path,
        targetDir: instancePaths(inst).modsDir,
        filename: file.name,
        sha1: file.sha1 || result.sha1,
        enabled: true
      })
      finalPath = applied.file
      finalName = path.basename(applied.file)
      // 已经进了实例 mods 目录，中转区的临时副本就没用了。
      try {
        if (path.resolve(path.dirname(result.path)).startsWith(path.resolve(receivedRoot) + path.sep)) {
          await fsp.rm(path.dirname(result.path), { recursive: true, force: true })
        }
      } catch {}
    }
    record.status = 'done'
    record.path = finalPath
    record.finishedAt = Date.now()
    getStore().addReceived({
      id: file.id,
      kind: file.kind,
      name: file.name,
      peerName: peerName(file.peer),
      instanceId: applyToInstance ? inst.id : '',
      instanceName: applyToInstance ? inst.name : '',
      at: Date.now(),
      files: [{ name: finalName, path: finalPath, size: result.size, sha1: result.sha1 }]
    })
    invalidate()
    logEvent(applyToInstance ? `已接收 ${file.name}，并加入实例「${inst.name}」` : `已接收 ${file.name}`)
    await refresh({ force: true })
  }).catch((error) => {
    record.status = 'failed'
    record.error = error.message
    record.finishedAt = Date.now()
    logEvent(`接收 ${file.name} 失败：${error.message}`, 'err')
  })
  return { ok: true, id }
}

/** 把「已接收」里的文件另存到用户选择的目录（复制，不移动原文件）。 */
export async function saveReceivedAs(id, { dir = '', name = '' } = {}) {
  const record = (getStore().get().received || []).find((item) => item.id === id)
  if (!record) throw new Error('接收记录不存在')
  const src = record.files[0]
  if (!src?.path || !fs.existsSync(src.path)) throw new Error('文件已被移动或删除')
  const targetDir = resolveDownloadDir(dir)
  if (!targetDir) throw new Error('请选择保存目录')
  const fileName = uniqueFileName(targetDir, name || path.basename(src.path))
  const target = path.join(targetDir, fileName)
  await fsp.copyFile(src.path, target)
  logEvent(`已另存 ${fileName}`)
  return { ok: true, path: target, dir: targetDir, name: fileName }
}

/** 把已接收的模组文件直接放进某个实例的 mods 目录。 */
export async function applyReceivedToInstance(id, instanceId) {
  const record = (getStore().get().received || []).find((item) => item.id === id)
  if (!record) throw new Error('接收记录不存在')
  if (record.kind !== 'mod') throw new Error('只有模组文件可以加入实例')
  const src = record.files[0]
  if (!src?.path || !fs.existsSync(src.path)) throw new Error('文件已被移动或删除')
  const inst = findInstance(String(instanceId || ''))
  if (!inst) throw new Error('实例不存在')
  const applied = await applyJar({
    sourceFile: src.path,
    targetDir: instancePaths(inst).modsDir,
    filename: record.name || src.name,
    sha1: src.sha1 || await sha1File(src.path),
    enabled: true
  })
  record.instanceId = inst.id
  record.instanceName = inst.name
  getStore().addReceived(record)
  logEvent(`已把 ${record.name} 加入实例「${inst.name}」`)
  return { ok: true, file: applied.file, instance: instanceSummary(inst) }
}

export async function cancelFile(id) {
  const instance = requireClient()
  await instance.request('DELETE', '/api/files/' + encodeURIComponent(id))
  uploads.delete(id)
  downloads.delete(id)
  await refresh({ force: true })
  return { ok: true }
}

/** 清掉本地已结束的传输记录（正在进行的、以及服务器上等待接收的不动）。 */
export function clearFinishedTransfers() {
  const finished = new Set(['done', 'failed', 'cancelled'])
  let removed = 0
  for (const [id, record] of uploads) {
    if (finished.has(record.status)) { uploads.delete(id); removed += 1 }
  }
  for (const [id, record] of downloads) {
    if (finished.has(record.status)) { downloads.delete(id); removed += 1 }
  }
  return { ok: true, removed }
}

// 真正在动的传输（导出/上传/接收中）；「等待对方接收」不算提示，避免角标长期不消。
function activeTransferCount() {
  const uploading = [...uploads.values()].filter((record) => ['exporting', 'uploading'].includes(record.status)).length
  const downloading = [...downloads.values()].filter((record) => record.status === 'downloading').length
  return uploading + downloading
}

/** 侧边栏提示用的轻量计数：好友请求、未读消息、待接收文件、进行中的传输。 */
export async function notifications() {
  ensureLockedServer()
  const state = getStore().get()
  const loggedIn = !!state.session.token && state.session.expiresAt > Date.now()
  const empty = { loggedIn, requests: 0, unread: 0, incoming: 0, activeTransfers: 0, error: '' }
  if (!loggedIn) return { ...empty, activeTransfers: activeTransferCount() }
  let data
  try {
    data = await refresh()
  } catch (error) {
    return { ...empty, activeTransfers: activeTransferCount(), error: error.message }
  }
  const friends = data?.friends || {}
  const files = data?.files || {}
  const requests = (friends.incoming || []).length
  const unread = (friends.friends || []).reduce((sum, friend) => sum + (Number(friend.unread) || 0), 0)
  const incoming = (files.incoming || []).filter((file) => file.status === 'ready').length
  return { loggedIn, requests, unread, incoming, activeTransfers: activeTransferCount(), error: '' }
}

async function uploadToFriend({ friendId, kind, filePath, name, size, sha1, instanceKey = '' }) {
  const instance = requireClient()
  const created = await instance.request('POST', '/api/files', {
    body: { to: friendId, kind, name, size, sha1, instanceKey }
  })
  const file = created.file
  const record = {
    id: file.id,
    kind,
    name,
    size,
    sha1,
    status: 'uploading',
    progress: 0,
    loaded: 0,
    total: size,
    peer: friendId,
    error: '',
    startedAt: Date.now()
  }
  uploads.set(file.id, record)
  instance.uploadFile(file.id, filePath, {
    size,
    onProgress: ({ loaded, total, ratio }) => {
      record.progress = ratio * 100
      record.loaded = loaded
      record.total = total
    }
  }).then(async () => {
    record.status = 'ready'
    record.progress = 100
    record.finishedAt = Date.now()
    invalidate()
    logEvent(`已上传 ${name}`)
    await refresh({ force: true })
  }).catch((error) => {
    record.status = 'failed'
    record.error = error.message
    record.finishedAt = Date.now()
    logEvent(`上传 ${name} 失败：${error.message}`, 'err')
    instance.request('DELETE', '/api/files/' + encodeURIComponent(record.id)).catch(() => {})
  })
  return record
}

// ---------------- 分享整合包 ----------------

export async function sharePack({ friendId, instanceId, format = 'mrpack', includeSaves = false, includeScreenshots = false } = {}) {
  const inst = findInstance(String(instanceId || ''))
  if (!inst) throw new Error('实例不存在')
  const friend = (cache?.friends?.friends || []).find((item) => item.uuid === friendId)
  if (!friend) throw new Error('好友不存在')
  const exported = startPackExport(inst.id, { format, includeSaves, includeScreenshots })
  const record = {
    id: 'local_' + Date.now().toString(36),
    kind: 'pack',
    name: inst.name,
    size: 0,
    status: 'exporting',
    progress: 0,
    peer: friendId,
    error: '',
    startedAt: Date.now(),
    exportJobId: exported.job.id
  }
  uploads.set(record.id, record)
  ;(async () => {
    try {
      const deadline = Date.now() + 30 * 60 * 1000
      while (Date.now() < deadline) {
        const job = getExportJob(exported.job.id)
        if (!job) throw new Error('导出任务不存在')
        record.progress = Number(job.progress) || 0
        record.name = job.name || record.name
        if (job.status === 'failed') throw new Error(job.error || '导出失败')
        if (job.status === 'cancelled') throw new Error('导出已取消')
        if (job.status === 'done') {
          if (!job.file || !fs.existsSync(job.file)) throw new Error('导出完成但没有找到文件')
          const stat = await fsp.stat(job.file)
          const sha1 = await sha1For(job.file, stat.size, stat.mtimeMs)
          uploads.delete(record.id)
          await uploadToFriend({
            friendId,
            kind: 'pack',
            filePath: job.file,
            name: path.basename(job.file),
            size: stat.size,
            sha1
          })
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 700))
      }
      throw new Error('导出超时')
    } catch (error) {
      record.status = 'failed'
      record.error = error.message
      record.finishedAt = Date.now()
      logEvent('分享整合包失败：' + error.message, 'err')
    }
  })()
  return { ok: true, id: record.id }
}

// ---------------- 模组清单与对称补齐 ----------------

async function uploadManifest(inst) {
  const manifest = await manifestForInstance(inst)
  const instance = requireClient()
  await instance.request('PUT', '/api/mods/' + encodeURIComponent(inst.id), {
    body: { instance: manifest.instance, items: manifest.items }
  })
  return manifest
}

export async function compareMods({ friendId, instanceId } = {}) {
  const inst = findInstance(String(instanceId || ''))
  if (!inst) throw new Error('实例不存在')
  const mine = await uploadManifest(inst)
  const instance = requireClient()
  const peer = await instance.request('GET', '/api/mods?uuid=' + encodeURIComponent(friendId))
  const chosen = pickPeerInstance(peer.instances, inst)
  if (!chosen) throw new Error('对方还没有上传相同 MC 版本与加载器的模组清单（让对方先打开「模组同步」）')
  const peerManifest = { instance: chosen.instance, items: chosen.items || [] }
  const diff = diffManifests(mine.items, peerManifest.items)
  return {
    mine: { instance: mine.instance, counts: mine.counts, items: mine.items },
    peer: peerManifest,
    diff
  }
}

async function resolveModrinthFile(sha1) {
  const cacheDir = path.join(DATA_DIR, 'friends', 'mods-cache')
  const cacheFile = path.join(cacheDir, `${sha1}.jar`)
  if (fs.existsSync(cacheFile)) {
    try {
      if (await sha1File(cacheFile) === sha1) return cacheFile
    } catch {}
    await fsp.rm(cacheFile, { force: true }).catch(() => {})
  }
  const response = await httpFetch(`${MODRINTH_VERSION_FILE}/${sha1}?algorithm=sha1`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) throw new Error(`Modrinth 查询失败（HTTP ${response.status}）`)
  const data = await response.json()
  const file = (data.files || []).find((entry) => String(entry.hashes?.sha1 || '').toLowerCase() === sha1)
  if (!file?.url) throw new Error('Modrinth 没有返回可下载地址')
  const download = await httpFetch(file.url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(120000)
  })
  if (!download.ok) throw new Error(`模组下载失败（HTTP ${download.status}）`)
  const buffer = Buffer.from(await download.arrayBuffer())
  const actual = crypto.createHash('sha1').update(buffer).digest('hex')
  if (actual !== sha1) throw new Error('模组下载校验失败')
  await fsp.mkdir(cacheDir, { recursive: true })
  await fsp.writeFile(cacheFile, buffer)
  return cacheFile
}

async function findReceivedBySha(sha1) {
  let entries = []
  try {
    entries = await fsp.readdir(receivedRoot, { withFileTypes: true })
  } catch {
    return ''
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findStagedBySha(path.join(receivedRoot, entry.name), sha1)
    if (found) return found
  }
  return ''
}

export function startModsFill({ friendId, instanceId } = {}) {
  const inst = findInstance(String(instanceId || ''))
  if (!inst) throw new Error('实例不存在')
  const job = {
    id: 'mods_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    type: 'modsFill',
    status: 'queued',
    phase: '准备',
    detail: '等待开始…',
    progress: 0,
    error: '',
    createdAt: Date.now(),
    startedAt: 0,
    finishedAt: 0,
    logs: [],
    friendId,
    instanceId: inst.id,
    instanceName: inst.name,
    result: null
  }
  jobs.set(job.id, job)
  pruneJobs()
  setImmediate(() => runModsFill(job).catch((error) => {
    if (job.cancelled) {
      job.status = 'cancelled'
      job.phase = '已取消'
    } else {
      job.status = 'failed'
      job.error = error.message
      job.phase = '失败'
      pushJobLog(job, '补齐失败：' + error.message, 'err')
    }
    job.finishedAt = Date.now()
  }))
  return publicJob(job)
}

export function getModsJob(id) {
  const job = jobs.get(String(id || ''))
  return job ? publicJob(job) : null
}

export function cancelModsJob(id) {
  const job = jobs.get(String(id || ''))
  if (!job || ['done', 'failed', 'cancelled'].includes(job.status)) return false
  job.cancelled = true
  pushJobLog(job, '用户取消', 'warn')
  return true
}

async function runModsFill(job) {
  const inst = findInstance(job.instanceId)
  if (!inst) throw new Error('实例不存在')
  job.status = 'running'
  job.startedAt = Date.now()
  job.phase = '读取模组清单'
  pushJobLog(job, `开始对比「${inst.name}」`)
  const mine = await uploadManifest(inst)
  job.phase = '读取对方清单'
  const instance = requireClient()
  const peer = await instance.request('GET', '/api/mods?uuid=' + encodeURIComponent(job.friendId))
  const chosen = pickPeerInstance(peer.instances, inst)
  if (!chosen) throw new Error('对方还没有上传相同 MC 版本与加载器的模组清单')
  const peerManifest = { instance: chosen.instance, items: chosen.items || [] }
  const diff = diffManifests(mine.items, peerManifest.items)
  const plan = fillPlan(diff, 'acquire')
  if (!plan.acquire.length && !plan.toggle.length) {
    job.progress = 100
    job.status = 'done'
    job.phase = '完成'
    job.detail = diff.counts.symmetric ? '两边配置已经一致，无需补齐' : '没有需要补齐的模组'
    job.result = { applied: 0, disabled: 0, toggled: 0, missing: [], counts: diff.counts }
    job.finishedAt = Date.now()
    return
  }

  const resolved = new Map()
  const missing = []
  for (const entry of plan.acquire) {
    if (job.cancelled) return
    const item = entry.item
    const staged = await findReceivedBySha(item.sha1)
    if (staged) {
      resolved.set(item.sha1, staged)
      pushJobLog(job, `使用已收到的 ${item.file}`)
      continue
    }
    try {
      job.phase = '从 Modrinth 补齐'
      const downloaded = await resolveModrinthFile(item.sha1)
      resolved.set(item.sha1, downloaded)
      pushJobLog(job, `已从 Modrinth 下载 ${item.file}`)
    } catch {
      missing.push(item)
      pushJobLog(job, `缺少 ${item.file}：需要对方点「发送模组」`, 'warn')
    }
  }

  job.phase = '写入实例'
  const modsDir = instancePaths(inst).modsDir
  let applied = 0
  let disabled = 0
  let toggled = 0
  for (const entry of plan.disable) {
    if (entry.item.enabled === false) continue
    if (await content.setModEnabled(inst, entry.item.relPath, false).catch(() => null) !== null) disabled += 1
  }
  for (const entry of plan.acquire) {
    const source = resolved.get(entry.item.sha1)
    if (!source) continue
    try {
      const result = await applyJar({
        sourceFile: source,
        targetDir: modsDir,
        filename: entry.item.file,
        sha1: entry.item.sha1,
        enabled: entry.enabled !== false
      })
      applied += 1
      if (result.disabledExisting) disabled += 1
    } catch (error) {
      pushJobLog(job, `${entry.item.file} 写入失败：${error.message}`, 'err')
    }
  }
  for (const entry of plan.toggle) {
    if (await content.setModEnabled(inst, entry.item.relPath, entry.enabled !== false).catch(() => null) !== null) toggled += 1
  }

  const after = await uploadManifest(inst)
  const finalDiff = diffManifests(after.items, peerManifest.items)
  job.progress = 100
  job.status = 'done'
  job.phase = '完成'
  job.detail = finalDiff.counts.symmetric
    ? `已与对方一致（${applied} 个文件）`
    : missing.length
      ? `完成，但缺 ${missing.length} 个文件（让对方发送）`
      : `完成，仍有 ${finalDiff.counts.onlyPeer} 个缺失`
  job.result = {
    applied,
    disabled,
    toggled,
    missing: missing.map((item) => item.file),
    counts: finalDiff.counts
  }
  job.finishedAt = Date.now()
  pushJobLog(job, job.detail, finalDiff.counts.symmetric ? 'ok' : 'warn')
}

export async function sendModsToFriend({ friendId, instanceId } = {}) {
  const inst = findInstance(String(instanceId || ''))
  if (!inst) throw new Error('实例不存在')
  const mine = await uploadManifest(inst)
  const instance = requireClient()
  const peer = await instance.request('GET', '/api/mods?uuid=' + encodeURIComponent(friendId))
  const chosen = pickPeerInstance(peer.instances, inst)
  if (!chosen) throw new Error('对方还没有上传相同 MC/加载器的清单')
  const diff = diffManifests(mine.items, { items: chosen.items || [] })
  const plan = fillPlan(diff, 'send')
  if (!plan.acquire.length) throw new Error('没有需要发给对方的模组')
  const modsDir = instancePaths(inst).modsDir
  let sent = 0
  for (const entry of plan.acquire) {
    const item = entry.item
    const source = path.join(modsDir, item.relPath)
    if (!fs.existsSync(source)) continue
    const stat = await fsp.stat(source)
    const sha1 = await sha1For(source, stat.size, stat.mtimeMs)
    await uploadToFriend({
      friendId,
      kind: 'mod',
      filePath: source,
      name: item.file,
      size: stat.size,
      sha1,
      instanceKey: inst.id
    })
    sent += 1
  }
  if (!sent) throw new Error('本地模组文件已被删除，无法发送')
  return { ok: true, count: sent }
}

// ---------------- 快照 ----------------

export async function snapshot() {
  ensureLockedServer()
  const state = getStore().get()
  const base = {
    configured: !!state.server.url,
    loggedIn: !!state.session.token && state.session.expiresAt > Date.now(),
    server: { locked: true, label: '官方服务器', requiresInvite: state.server.requiresInvite },
    prefs: state.prefs,
    defaultDownloadDir: receivedRoot,
    account: state.session.profile,
    mcAccount: (() => {
      try {
        const account = accounts.getSelectedAccount()
        return account ? { name: account.name, type: account.type, uuid: account.uuid } : null
      } catch {
        return null
      }
    })(),
    events,
    received: state.received,
    jobs: [...jobs.values()].slice(-10).reverse().map(publicJob)
  }
  if (!base.configured) return { ...base, error: '' }
  if (!base.loggedIn) return { ...base, error: state.session.token ? '登录已过期，请重新登录' : '' }
  let error = ''
  try {
    const data = await refresh()
    const files = data?.files || { incoming: [], outgoing: [] }
    const localUploads = [...uploads.values()].map((record) => ({
      id: record.id,
      kind: record.kind,
      name: record.name,
      size: record.size,
      status: record.status,
      progress: record.progress,
      loaded: record.loaded || 0,
      total: record.total || record.size,
      peer: record.peer,
      error: record.error,
      direction: 'out',
      local: true
    }))
    const localDownloads = [...downloads.values()].map((record) => ({
      id: record.id,
      kind: record.kind,
      name: record.name,
      size: record.size,
      status: record.status,
      progress: record.progress,
      loaded: record.loaded || 0,
      total: record.total || record.size,
      peer: record.peer,
      error: record.error,
      path: record.path || '',
      targetDir: record.targetDir || '',
      appliedTo: record.appliedTo || '',
      direction: 'in',
      local: true
    }))
    const serverFiles = [...(files.incoming || []), ...(files.outgoing || [])].map((file) => ({
      ...file,
      progress: file.status === 'delivered' ? 100 : 0
    }))
    const seen = new Set([...localUploads, ...localDownloads].map((item) => item.id))
    return {
      ...base,
      error,
      profile: data?.friends?.profile || state.session.profile,
      friends: data?.friends?.friends || [],
      incoming: data?.friends?.incoming || [],
      outgoing: data?.friends?.outgoing || [],
      files: {
        incoming: serverFiles.filter((file) => file.direction === 'in' && !seen.has(file.id)),
        outgoing: serverFiles.filter((file) => file.direction === 'out' && !seen.has(file.id))
      },
      transfers: { uploads: localUploads, downloads: localDownloads },
      serverTime: data?.friends?.serverTime || 0
    }
  } catch (fetchError) {
    error = fetchError.message
    return { ...base, error }
  }
}

export async function diagnostics() {
  const state = getStore().get()
  return {
    configured: !!state.server.url,
    server: { locked: true, label: '官方服务器', requiresInvite: state.server.requiresInvite },
    loggedIn: !!state.session.token,
    expiresAt: state.session.expiresAt,
    profile: state.session.profile,
    receivedRoot,
    events
  }
}

export async function removeReceived(id) {
  const record = (getStore().get().received || []).find((item) => item.id === id)
  if (!record) return false
  for (const file of record.files) {
    const target = path.resolve(file.path)
    if (!target.startsWith(path.resolve(receivedRoot) + path.sep)) continue
    await fsp.rm(path.dirname(target), { recursive: true, force: true }).catch(() => {})
  }
  getStore().removeReceived(id)
  return true
}

export async function stopFriends() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
  await getStore().flush().catch(() => {})
  store = null
  client = null
  cache = null
}
