#!/usr/bin/env node
// MCtoolbox 好友服务器（中心式，可选自建）。
//
// 身份：客户端把启动器已登录的「正版 Minecraft 访问令牌」发来，服务器向
// api.minecraftservices.com 校验后拿到 UUID/正版 ID；不保存访问令牌，只发一个
// 30 天的会话令牌（哈希存盘）。好友能看到正版 ID，昵称可自定义。
//
// 数据：好友关系 / 在线状态 / 离线聊天 / 群聊 / 模组清单长期保存；整合包、
// 模组与聊天图片只做临时中转——接收方全部下载后 10 分钟删除，未下载最长
// 12 小时；总缓存 10 GB，超出时按创建时间删除最旧的文件。
//
// 传输：默认 HTTPS（自签证书 + 客户端指纹固定）；测试可用 --http。
//
// 启动示例：
//   node tools/friends-server.mjs --port 443 --cert /etc/mctb-friends/cert.pem \
//     --key /etc/mctb-friends/key.pem --data /var/lib/mctb-friends --invite <邀请码>
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SERVER_NAME = 'mc-toolbox-friends'
const SERVER_VERSION = 2
const SESSION_DAYS = 30
const MAX_JSON_BODY = 1024 * 1024
const MAX_MESSAGE = 2000
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const DEFAULT_QUOTA_PER_USER = 10 * 1024 * 1024 * 1024
// 云端中转总缓存 10 GB：超出时优先删除最早的文件，最多保留 12 小时。
const DEFAULT_GLOBAL_QUOTA = 10 * 1024 * 1024 * 1024
const FILE_TTL_MS = 12 * 60 * 60 * 1000
const DELIVERED_TTL_MS = 10 * 60 * 1000
const ONLINE_WINDOW = 70 * 1000
const MAX_FRIENDS = 200
const MAX_GROUP_MEMBERS = 50
const MAX_GROUPS_PER_USER = 50
const MAX_MANIFEST_ITEMS = 500

function now() { return Date.now() }
function randomId(prefix = '') { return prefix + crypto.randomBytes(12).toString('base64url') }
function sha256(text) { return crypto.createHash('sha256').update(String(text)).digest('hex') }
function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''))
  const right = Buffer.from(String(b || ''))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}
function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max)
}
function cleanMessage(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, MAX_MESSAGE)
}
/** 聊天图片附件只保留文件 id 与尺寸，真实字节走文件中转接口。 */
function cleanMessageImage(value) {
  if (!value || typeof value !== 'object') return null
  const id = String(value.id || '')
  if (!/^f_[A-Za-z0-9_-]{6,60}$/.test(id)) return null
  return {
    id,
    name: sanitizeFileName(value.name || 'image.png'),
    width: Math.max(0, Math.min(20000, Number(value.width) || 0)),
    height: Math.max(0, Math.min(20000, Number(value.height) || 0)),
    size: Math.max(0, Number(value.size) || 0)
  }
}
function imageMime(name) {
  const ext = path.extname(String(name || '')).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return ''
}
function sanitizeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').trim().replace(/[. ]+$/g, '')
  return (base || 'file').slice(0, 160)
}
function pairKey(a, b) {
  return [String(a), String(b)].sort().join('_')
}
function validUuid(value) {
  return /^[0-9a-fA-F-]{32,36}$/.test(String(value || ''))
}
function validSha1(value) {
  return /^[0-9a-f]{40}$/.test(String(value || ''))
}
function friendView(account) {
  return {
    uuid: account.uuid,
    mcName: account.mcName,
    nickname: account.nickname,
    online: now() - (account.lastSeenAt || 0) < ONLINE_WINDOW,
    lastSeenAt: account.lastSeenAt || 0,
    activity: account.activity || null
  }
}

class Store {
  constructor(dir, { logger = console, quotaPerUser = DEFAULT_QUOTA_PER_USER, globalQuota = DEFAULT_GLOBAL_QUOTA } = {}) {
    this.dir = dir
    this.logger = logger
    this.quotaPerUser = quotaPerUser
    this.globalQuota = globalQuota
    this.accountsFile = path.join(dir, 'accounts.json')
    this.sessionsFile = path.join(dir, 'sessions.json')
    this.groupsFile = path.join(dir, 'groups.json')
    this.filesDir = path.join(dir, 'files')
    this.filesIndex = path.join(this.filesDir, 'index.json')
    this.messagesDir = path.join(dir, 'messages')
    this.groupMessagesDir = path.join(this.messagesDir, 'groups')
    this.modsDir = path.join(dir, 'mods')
    this.accounts = new Map()
    this.sessions = new Map()
    this.groups = new Map()
    this.files = new Map()
    this.messages = new Map()
    this.groupMessages = new Map()
    this.timers = []
  }

  async init() {
    for (const dir of [this.dir, this.filesDir, this.messagesDir, this.groupMessagesDir, this.modsDir]) await fsp.mkdir(dir, { recursive: true })
    await this.loadJson(this.accountsFile, (data) => {
      for (const account of Array.isArray(data) ? data : []) {
        if (!account?.uuid) continue
        this.accounts.set(account.uuid, {
          friends: [],
          incoming: [],
          outgoing: [],
          reads: {},
          groupReads: {},
          ...account
        })
      }
    })
    await this.loadJson(this.groupsFile, (data) => {
      for (const group of Array.isArray(data) ? data : []) {
        if (!group?.id || !Array.isArray(group.members)) continue
        this.groups.set(group.id, {
          owner: '',
          name: '群聊',
          createdAt: 0,
          updatedAt: 0,
          ...group,
          members: group.members.filter((uuid) => this.accounts.has(uuid))
        })
      }
    })
    await this.loadJson(this.sessionsFile, (data) => {
      const at = now()
      for (const [hash, session] of Object.entries(data || {})) {
        if (session?.uuid && session.expiresAt > at && this.accounts.has(session.uuid)) this.sessions.set(hash, session)
      }
    })
    await this.loadJson(this.filesIndex, (data) => {
      for (const file of Array.isArray(data) ? data : []) {
        if (!file?.id) continue
        if (file.status !== 'expired' && file.status !== 'deleted') this.files.set(file.id, file)
      }
    })
    this.timers.push(setInterval(() => this.cleanup().catch((error) => this.logger.warn?.('[friends-server] 清理失败：' + error.message)), 60 * 1000))
    for (const timer of this.timers) timer.unref?.()
    await this.cleanup()
  }

  async loadJson(file, apply) {
    try {
      const raw = await fsp.readFile(file, 'utf8')
      apply(JSON.parse(raw))
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger.warn?.(`[friends-server] 读取 ${path.basename(file)} 失败：${error.message}`)
    }
  }

  async writeJson(file, value) {
    const tmp = file + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await fsp.rename(tmp, file)
  }

  saveAccounts() {
    return this.writeJson(this.accountsFile, [...this.accounts.values()]).catch((error) => this.logger.warn?.('[friends-server] 保存账户失败：' + error.message))
  }

  saveSessions() {
    return this.writeJson(this.sessionsFile, Object.fromEntries(this.sessions)).catch((error) => this.logger.warn?.('[friends-server] 保存会话失败：' + error.message))
  }

  saveFiles() {
    return this.writeJson(this.filesIndex, [...this.files.values()]).catch((error) => this.logger.warn?.('[friends-server] 保存文件索引失败：' + error.message))
  }

  saveGroups() {
    return this.writeJson(this.groupsFile, [...this.groups.values()]).catch((error) => this.logger.warn?.('[friends-server] 保存群聊失败：' + error.message))
  }

  createGroup(owner, { name, members }) {
    const group = {
      id: randomId('g_'),
      name,
      owner,
      members: [...new Set([owner, ...members])].slice(0, MAX_GROUP_MEMBERS),
      createdAt: now(),
      updatedAt: now()
    }
    this.groups.set(group.id, group)
    return group
  }

  groupsFor(account) {
    return [...this.groups.values()].filter((group) => group.members.includes(account.uuid))
  }

  groupMessagesFor(group) {
    if (!this.groupMessages.has(group.id)) {
      let items = []
      try {
        items = fs.readFileSync(path.join(this.groupMessagesDir, group.id + '.jsonl'), 'utf8')
          .split('\n').filter(Boolean).map((line) => {
            try { return JSON.parse(line) } catch { return null }
          }).filter(Boolean)
      } catch {}
      this.groupMessages.set(group.id, items)
    }
    return this.groupMessages.get(group.id)
  }

  async appendGroupMessage(group, message) {
    const items = this.groupMessagesFor(group)
    items.push(message)
    group.updatedAt = message.at
    await fsp.appendFile(path.join(this.groupMessagesDir, group.id + '.jsonl'), JSON.stringify(message) + '\n', 'utf8')
    return message
  }

  groupReadsFor(account, groupId) {
    return account.groupReads?.[groupId] || 0
  }

  unreadForGroup(account, group) {
    const readAt = this.groupReadsFor(account, group.id)
    return this.groupMessagesFor(group).filter((message) => message.from !== account.uuid && message.at > readAt).length
  }

  lastGroupMessage(group) {
    const items = this.groupMessagesFor(group)
    return items.length ? items[items.length - 1] : null
  }

  createAccount({ uuid, mcName, nickname }) {
    const account = {
      uuid,
      mcName,
      nickname: nickname || mcName,
      createdAt: now(),
      lastSeenAt: now(),
      activity: null,
      friends: [],
      incoming: [],
      outgoing: [],
      reads: {},
      groupReads: {}
    }
    this.accounts.set(uuid, account)
    return account
  }

  issueSession(uuid) {
    const token = crypto.randomBytes(32).toString('base64url')
    const hash = sha256(token)
    this.sessions.set(hash, { uuid, createdAt: now(), expiresAt: now() + SESSION_DAYS * 24 * 60 * 60 * 1000 })
    return { token, expiresAt: this.sessions.get(hash).expiresAt }
  }

  accountByToken(token) {
    if (!token) return null
    const hash = sha256(token)
    const session = this.sessions.get(hash)
    if (!session) return null
    if (session.expiresAt <= now()) {
      this.sessions.delete(hash)
      return null
    }
    return this.accounts.get(session.uuid) || null
  }

  accountByMcName(name) {
    const target = String(name || '').toLowerCase()
    for (const account of this.accounts.values()) {
      if (account.mcName.toLowerCase() === target) return account
    }
    return null
  }

  messagesFor(a, b) {
    const key = pairKey(a, b)
    if (!this.messages.has(key)) {
      const file = path.join(this.messagesDir, key + '.jsonl')
      let items = []
      try {
        items = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
          try { return JSON.parse(line) } catch { return null }
        }).filter(Boolean)
      } catch {}
      this.messages.set(key, items)
    }
    return this.messages.get(key)
  }

  async appendMessage(a, b, message) {
    const key = pairKey(a, b)
    const items = this.messagesFor(a, b)
    items.push(message)
    await fsp.appendFile(path.join(this.messagesDir, key + '.jsonl'), JSON.stringify(message) + '\n', 'utf8')
    return message
  }

  unreadFor(account, peerUuid) {
    const readAt = account.reads?.[pairKey(account.uuid, peerUuid)] || 0
    return this.messagesFor(account.uuid, peerUuid).filter((m) => m.to === account.uuid && m.at > readAt).length
  }

  lastMessage(a, b) {
    const items = this.messagesFor(a, b)
    return items.length ? items[items.length - 1] : null
  }

  manifestFile(uuid) {
    return path.join(this.modsDir, String(uuid).replace(/[^a-zA-Z0-9-]/g, '') + '.json')
  }

  async readManifests(uuid) {
    try {
      return JSON.parse(await fsp.readFile(this.manifestFile(uuid), 'utf8'))
    } catch {
      return { instances: {} }
    }
  }

  async writeManifests(uuid, data) {
    await this.writeJson(this.manifestFile(uuid), data)
  }

  usedBytes(excludeId = '') {
    let total = 0
    for (const file of this.files.values()) {
      if (file.id === excludeId) continue
      if (['uploading', 'ready', 'downloading', 'delivered'].includes(file.status)) total += Number(file.size) || 0
    }
    return total
  }

  userBytes(uuid, excludeId = '') {
    let total = 0
    for (const file of this.files.values()) {
      if (file.id === excludeId) continue
      if (file.from !== uuid) continue
      if (['uploading', 'ready', 'downloading', 'delivered'].includes(file.status)) total += Number(file.size) || 0
    }
    return total
  }

  async removeFile(id, status = 'deleted') {
    const file = this.files.get(id)
    if (!file) return null
    await fsp.rm(path.join(this.filesDir, id + '.bin'), { force: true }).catch(() => {})
    file.status = status
    file.deletedAt = now()
    this.files.delete(id)
    return file
  }

  /**
   * 为新文件腾空间：总缓存超限时按创建时间删除最旧的文件，
   * 单个账号超限时只删这个账号自己的旧文件。返回是否放得下。
   */
  async makeRoom(size, { excludeId = '', userUuid = '' } = {}) {
    await this.cleanup()
    const need = Math.max(0, Number(size) || 0)
    const active = () => [...this.files.values()]
      .filter((file) => file.id !== excludeId && ['uploading', 'ready', 'downloading', 'delivered'].includes(file.status))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    let globalOk = this.usedBytes(excludeId) + need <= this.globalQuota
    while (!globalOk) {
      const oldest = active()[0]
      if (!oldest) break
      await this.removeFile(oldest.id, 'evicted')
      globalOk = this.usedBytes(excludeId) + need <= this.globalQuota
    }
    let userOk = !userUuid || this.userBytes(userUuid, excludeId) + need <= this.quotaPerUser
    while (!userOk) {
      const oldest = active().find((file) => file.from === userUuid)
      if (!oldest) break
      await this.removeFile(oldest.id, 'evicted')
      userOk = this.userBytes(userUuid, excludeId) + need <= this.quotaPerUser
    }
    return { globalOk, userOk }
  }

  async cleanup() {
    const at = now()
    let changed = false
    for (const [id, file] of [...this.files]) {
      const expired = file.expiresAt && file.expiresAt <= at
      const delivered = file.deleteAt && file.deleteAt <= at
      if (!expired && !delivered) continue
      await fsp.rm(path.join(this.filesDir, id + '.bin'), { force: true }).catch(() => {})
      file.status = expired ? 'expired' : 'deleted'
      file.deletedAt = at
      this.files.delete(id)
      changed = true
    }
    // 兜底：即使没有新上传，也把总缓存压回上限，避免重启后旧数据常驻。
    if (this.usedBytes() > this.globalQuota) {
      const oldest = [...this.files.values()]
        .filter((file) => ['uploading', 'ready', 'downloading', 'delivered'].includes(file.status))
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      while (this.usedBytes() > this.globalQuota && oldest.length) {
        await this.removeFile(oldest.shift().id, 'evicted')
        changed = true
      }
    }
    if (changed) await this.saveFiles()
  }

  async shutdown() {
    for (const timer of this.timers) clearInterval(timer)
    await Promise.all([this.saveAccounts(), this.saveSessions(), this.saveFiles(), this.saveGroups()])
  }
}

async function defaultVerifyMinecraft(accessToken) {
  const response = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
    signal: AbortSignal.timeout(12000)
  })
  if (!response.ok) {
    const error = new Error(response.status === 401 ? '正版令牌无效或已过期，请重新登录微软账户' : `正版校验失败（HTTP ${response.status}）`)
    error.code = 'MC_AUTH_FAILED'
    throw error
  }
  const profile = await response.json()
  if (!profile?.id || !profile?.name) {
    const error = new Error('无法读取 Minecraft 档案')
    error.code = 'MC_AUTH_FAILED'
    throw error
  }
  return { uuid: profile.id.toLowerCase(), name: profile.name }
}

function json(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' })
  res.end(body)
}

function readJson(req, limit = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(Object.assign(new Error('请求不是合法 JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function authToken(req) {
  const header = String(req.headers.authorization || '')
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
}

/**
 * 创建好友服务器。导出给测试用；CLI 在文件末尾。
 * @param {{dataDir:string, verifyMinecraft?:Function, invite?:string, quotaPerUser?:number, globalQuota?:number, logger?:Console}} options
 */
export function createFriendsServer(options = {}) {
  if (!options.dataDir) throw new Error('缺少 dataDir')
  const dataDir = path.resolve(options.dataDir)
  const verifyMinecraft = options.verifyMinecraft || defaultVerifyMinecraft
  const invite = String(options.invite || '')
  const quotaPerUser = Number(options.quotaPerUser) || DEFAULT_QUOTA_PER_USER
  const globalQuota = Number(options.globalQuota) || DEFAULT_GLOBAL_QUOTA
  const logger = options.logger || console
  const store = new Store(dataDir, { logger, quotaPerUser, globalQuota })
  const authAttempts = new Map()
  let ready = null

  function allowAuth(ip) {
    const bucket = authAttempts.get(ip) || []
    const cutoff = now() - 60000
    const recent = bucket.filter((time) => time > cutoff)
    if (recent.length >= 20) {
      authAttempts.set(ip, recent)
      return false
    }
    recent.push(now())
    authAttempts.set(ip, recent)
    return true
  }

  function requireAccount(req, res) {
    const account = store.accountByToken(authToken(req))
    if (!account) {
      json(res, 401, { error: '登录已失效，请重新登录' })
      return null
    }
    account.lastSeenAt = now()
    return account
  }

  function friendOrFail(account, uuid, res) {
    if (!validUuid(uuid) || !account.friends.includes(uuid)) {
      json(res, 404, { error: '对方不是你的好友' })
      return null
    }
    return store.accounts.get(uuid) || null
  }

  function groupView(account, group) {
    return {
      id: group.id,
      name: group.name,
      owner: group.owner,
      memberIds: group.members.slice(),
      members: group.members.map((uuid) => store.accounts.get(uuid)).filter(Boolean).map(friendView),
      createdAt: group.createdAt || 0,
      updatedAt: group.updatedAt || 0,
      unread: store.unreadForGroup(account, group),
      lastMessage: store.lastGroupMessage(group)
    }
  }

  function groupsFor(account) {
    return store.groupsFor(account)
      .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
      .slice(0, MAX_GROUPS_PER_USER)
      .map((group) => groupView(account, group))
  }

  function groupOrFail(account, id, res) {
    const group = store.groups.get(String(id || ''))
    if (!group || !group.members.includes(account.uuid)) {
      json(res, 404, { error: '群聊不存在或你不在群里' })
      return null
    }
    return group
  }

  /**
   * 解析发送目标：好友、群聊、或者两者的组合（群发）。
   * 返回去重后的 targets 和真正的收件人列表。
   */
  function resolveTargets(account, body, res) {
    const raw = []
    if (Array.isArray(body.targets)) raw.push(...body.targets)
    else {
      const list = Array.isArray(body.to) ? body.to : (body.to ? [body.to] : [])
      for (const id of list) raw.push({ type: 'friend', id })
      if (body.groupId) raw.push({ type: 'group', id: body.groupId })
    }
    const targets = []
    const seen = new Set()
    const recipients = new Set()
    for (const entry of raw) {
      const type = entry?.type === 'group' ? 'group' : 'friend'
      const id = String(entry?.id || '')
      const key = type + ':' + id
      if (!id || seen.has(key)) continue
      if (type === 'friend') {
        const peer = store.accounts.get(id)
        if (!peer || !account.friends.includes(id)) {
          json(res, 404, { error: '对方不是你的好友' })
          return null
        }
        recipients.add(id)
      } else {
        const group = store.groups.get(id)
        if (!group || !group.members.includes(account.uuid)) {
          json(res, 404, { error: '群聊不存在或你不在群里' })
          return null
        }
        for (const member of group.members) if (member !== account.uuid) recipients.add(member)
      }
      seen.add(key)
      targets.push({ type, id })
    }
    if (!targets.length) {
      json(res, 400, { error: '请选择至少一个好友或群聊' })
      return null
    }
    if (!recipients.size) {
      json(res, 400, { error: '没有可接收文件的成员' })
      return null
    }
    return { targets, recipients: [...recipients] }
  }

  function fileTargets(file) {
    if (Array.isArray(file.targets) && file.targets.length) return file.targets
    return file.to ? [{ type: 'friend', id: file.to }] : []
  }

  function fileRecipients(file) {
    if (Array.isArray(file.recipients) && file.recipients.length) return file.recipients
    return file.to ? [file.to] : []
  }

  function visibleTargets(file, viewer) {
    const targets = fileTargets(file)
    if (viewer === file.from) return targets
    return targets.filter((target) => target.type === 'friend'
      ? target.id === viewer
      : store.groups.get(target.id)?.members?.includes(viewer))
  }

  function allDelivered(file) {
    const recipients = fileRecipients(file)
    const delivered = file.deliveredBy || {}
    return recipients.length > 0 && recipients.every((uuid) => delivered[uuid])
  }

  function fileStatusFor(file, viewer) {
    if (file.status === 'uploading') return 'uploading'
    if (file.kind === 'image') return file.status === 'ready' ? 'ready' : file.status
    const delivered = file.deliveredBy || {}
    if (viewer === file.from) return allDelivered(file) ? 'delivered' : 'ready'
    return delivered[viewer] ? 'delivered' : (file.status === 'delivered' ? 'ready' : 'ready')
  }

  async function handleAuthMinecraft(req, res) {
    const ip = clientIp(req)
    if (!allowAuth(ip)) return json(res, 429, { error: '登录尝试太频繁，请稍后再试' })
    const body = await readJson(req)
    const accessToken = String(body.accessToken || '')
    if (!accessToken) return json(res, 400, { error: '缺少正版访问令牌' })
    let profile
    try {
      profile = await verifyMinecraft(accessToken)
    } catch (error) {
      return json(res, 401, { error: error.message || '正版校验失败' })
    }
    if (!profile?.uuid || !profile?.name) return json(res, 401, { error: '正版校验没有返回档案' })
    let account = store.accounts.get(String(profile.uuid).toLowerCase())
    if (!account) {
      if (invite && String(body.invite || '') !== invite) {
        return json(res, 403, { error: '注册需要邀请码', code: 'INVITE_REQUIRED' })
      }
      account = store.createAccount({
        uuid: String(profile.uuid).toLowerCase(),
        mcName: cleanText(profile.name, 32),
        nickname: cleanText(body.nickname, 24)
      })
      logger.log?.(`[friends-server] 新账户 ${account.mcName}（${account.uuid}）`)
    } else {
      account.mcName = cleanText(profile.name, 32) || account.mcName
    }
    account.lastSeenAt = now()
    const session = store.issueSession(account.uuid)
    await Promise.all([store.saveAccounts(), store.saveSessions()])
    json(res, 200, {
      token: session.token,
      expiresAt: session.expiresAt,
      profile: { uuid: account.uuid, mcName: account.mcName, nickname: account.nickname },
      requiresInvite: !!invite
    })
  }

  async function handleFriends(account, res) {
    const friends = account.friends.map((uuid) => store.accounts.get(uuid)).filter(Boolean).map((peer) => ({
      ...friendView(peer),
      unread: store.unreadFor(account, peer.uuid),
      lastMessage: store.lastMessage(account.uuid, peer.uuid)
    }))
    const incoming = account.incoming.map((uuid) => store.accounts.get(uuid)).filter(Boolean).map(friendView)
    const outgoing = account.outgoing.map((uuid) => store.accounts.get(uuid)).filter(Boolean).map(friendView)
    json(res, 200, {
      profile: { ...friendView(account), createdAt: account.createdAt },
      friends,
      incoming,
      outgoing,
      groups: groupsFor(account),
      serverTime: now()
    })
  }

  async function handleFileCreate(req, res, account) {
    const body = await readJson(req)
    const resolved = resolveTargets(account, body, res)
    if (!resolved) return
    const { targets, recipients } = resolved
    const kind = ['mod', 'image'].includes(body.kind) ? body.kind : 'pack'
    const size = Number(body.size) || 0
    const sha1 = String(body.sha1 || '').toLowerCase()
    const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES
    if (!validSha1(sha1)) return json(res, 400, { error: '文件 SHA-1 无效' })
    if (size <= 0 || size > maxBytes) {
      return json(res, 400, { error: kind === 'image' ? '图片大小超出限制（最大 10 MB）' : '文件大小超出限制（最大 2 GB）' })
    }
    // 先清理过期文件，再按「总缓存 10 GB、超出删最旧」腾空间。
    const room = await store.makeRoom(size, { userUuid: account.uuid })
    if (!room.globalOk) return json(res, 413, { error: '服务器中转空间已满（10 GB），请稍后再试' })
    if (!room.userOk) return json(res, 413, { error: '你的中转配额已满，请等待已发送文件被接收或清理' })
    const file = {
      id: randomId('f_'),
      from: account.uuid,
      to: recipients.length === 1 ? recipients[0] : '',
      recipients,
      targets,
      groupIds: targets.filter((target) => target.type === 'group').map((target) => target.id),
      kind,
      name: sanitizeFileName(body.name || (kind === 'image' ? 'image.png' : 'file')),
      size,
      sha1,
      width: Math.max(0, Number(body.width) || 0),
      height: Math.max(0, Number(body.height) || 0),
      instanceKey: cleanText(body.instanceKey, 80),
      status: 'uploading',
      deliveredBy: {},
      createdAt: now(),
      expiresAt: now() + FILE_TTL_MS
    }
    store.files.set(file.id, file)
    await store.saveFiles()
    res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ file: publicFile(file, account.uuid) }))
  }

  function publicFile(file, viewer) {
    const targets = visibleTargets(file, viewer)
    const recipients = fileRecipients(file)
    return {
      id: file.id,
      kind: file.kind,
      name: file.name,
      size: file.size,
      sha1: file.sha1,
      width: file.width || 0,
      height: file.height || 0,
      status: fileStatusFor(file, viewer),
      direction: viewer === file.from ? 'out' : 'in',
      peer: viewer === file.from ? (targets.find((target) => target.type === 'friend')?.id || '') : file.from,
      groupId: targets.length === 1 && targets[0].type === 'group' ? targets[0].id : '',
      groupIds: targets.filter((target) => target.type === 'group').map((target) => target.id),
      targets,
      broadcast: targets.length > 1 || (targets.length === 1 && targets[0].type === 'group' && recipients.length > 1),
      recipientCount: recipients.length,
      instanceKey: file.instanceKey || '',
      createdAt: file.createdAt,
      downloadedAt: file.deliveredBy?.[viewer] || 0,
      expiresAt: file.expiresAt || 0
    }
  }

  async function handleFileUpload(req, res, account, id) {
    const file = store.files.get(id)
    if (!file || file.from !== account.uuid) return json(res, 404, { error: '上传任务不存在' })
    if (file.status !== 'uploading') return json(res, 409, { error: '该任务已经上传过' })
    const length = Number(req.headers['content-length'] || 0)
    if (!length || length !== file.size) return json(res, 400, { error: 'Content-Length 与声明大小不一致' })
    const target = path.join(store.filesDir, file.id + '.bin')
    const handle = await fsp.open(target, 'w')
    const hash = crypto.createHash('sha1')
    let received = 0
    try {
      for await (const chunk of req) {
        received += chunk.length
        if (received > file.size) throw new Error('上传超过声明大小')
        hash.update(chunk)
        await handle.write(chunk)
      }
      if (received !== file.size) throw new Error('上传未完整结束')
      if (hash.digest('hex') !== file.sha1) throw new Error('文件 SHA-1 校验失败')
      file.status = 'ready'
      file.readyAt = now()
      await store.saveFiles()
      json(res, 200, { ok: true, file: publicFile(file, account.uuid) })
    } catch (error) {
      await handle.close().catch(() => {})
      await fsp.rm(target, { force: true }).catch(() => {})
      store.files.delete(file.id)
      await store.saveFiles()
      if (!res.headersSent) json(res, 400, { error: error.message })
    } finally {
      await handle.close().catch(() => {})
    }
  }

  async function handleFileDownload(req, res, account, id) {
    const file = store.files.get(id)
    const recipients = file ? fileRecipients(file) : []
    if (!file || (file.from !== account.uuid && !recipients.includes(account.uuid))) return json(res, 404, { error: '文件不存在或已被清理' })
    if (!['ready', 'downloading', 'delivered'].includes(file.status)) return json(res, 409, { error: '文件还没有准备好' })
    const target = path.join(store.filesDir, file.id + '.bin')
    if (!fs.existsSync(target)) return json(res, 404, { error: '文件已被清理' })
    file.status = 'downloading'
    await store.saveFiles()
    res.writeHead(200, {
      'Content-Type': file.kind === 'image' ? (imageMime(file.name) || 'application/octet-stream') : 'application/octet-stream',
      'Content-Length': file.size,
      'X-File-Name': encodeURIComponent(file.name),
      'X-File-Sha1': file.sha1
    })
    const stream = fs.createReadStream(target)
    stream.pipe(res)
    stream.on('error', () => {
      try { res.destroy() } catch {}
    })
    res.on('finish', async () => {
      // 聊天图片要在 12 小时内对所有成员可看，不能因为一个人看过就进入删除倒计时。
      if (file.kind === 'image') {
        file.status = 'ready'
        await store.saveFiles()
        return
      }
      if (account.uuid === file.from) {
        file.status = 'ready'
        await store.saveFiles()
        return
      }
      file.deliveredBy = { ...(file.deliveredBy || {}), [account.uuid]: now() }
      if (allDelivered(file)) {
        file.status = 'delivered'
        file.downloadedAt = now()
        file.deleteAt = now() + DELIVERED_TTL_MS
      } else {
        file.status = 'ready'
      }
      await store.saveFiles()
    })
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const pathname = url.pathname
    const method = req.method
    try {
      if (method === 'GET' && pathname === '/api/health') {
        return json(res, 200, {
          ok: true,
          name: SERVER_NAME,
          version: SERVER_VERSION,
          time: now(),
          requiresInvite: !!invite,
          quotaPerUser,
          globalQuota
        })
      }
      if (method === 'POST' && pathname === '/api/auth/minecraft') return await handleAuthMinecraft(req, res)
      if (method === 'POST' && pathname === '/api/auth/logout') {
        const account = requireAccount(req, res)
        if (!account) return
        const token = authToken(req)
        if (token) store.sessions.delete(sha256(token))
        await store.saveSessions()
        return json(res, 200, { ok: true })
      }
      const account = requireAccount(req, res)
      if (!account) return
      account.lastSeenAt = now()

      if (method === 'POST' && pathname === '/api/heartbeat') {
        const body = await readJson(req)
        if (body.activity !== undefined) account.activity = body.activity && typeof body.activity === 'object'
          ? {
              instanceName: cleanText(body.activity.instanceName, 64),
              mc: cleanText(body.activity.mc, 24),
              loader: cleanText(body.activity.loader, 24),
              since: Number(body.activity.since) || 0
            }
          : null
        await store.saveAccounts()
        return json(res, 200, { ok: true, online: true })
      }
      if (method === 'PUT' && pathname === '/api/me') {
        const body = await readJson(req)
        if (body.nickname !== undefined) account.nickname = cleanText(body.nickname, 24) || account.mcName
        if (body.activity !== undefined) {
          account.activity = body.activity && typeof body.activity === 'object'
            ? {
                instanceName: cleanText(body.activity.instanceName, 64),
                mc: cleanText(body.activity.mc, 24),
                loader: cleanText(body.activity.loader, 24),
                since: Number(body.activity.since) || 0
              }
            : null
        }
        await store.saveAccounts()
        return json(res, 200, { profile: friendView(account) })
      }
      if (method === 'GET' && pathname === '/api/friends') return await handleFriends(account, res)
      if (method === 'POST' && pathname === '/api/friends/request') {
        const body = await readJson(req)
        const target = store.accountByMcName(body.mcName)
        if (!target) return json(res, 404, { error: '没有找到这个正版 ID（对方需要先登录过好友服务器）', code: 'NOT_FOUND' })
        if (target.uuid === account.uuid) return json(res, 400, { error: '不能添加自己' })
        if (account.friends.includes(target.uuid)) return json(res, 200, { ok: true, already: true })
        if (!account.outgoing.includes(target.uuid)) {
          if (account.outgoing.length + account.incoming.length >= MAX_FRIENDS) return json(res, 400, { error: '请求太多，请先处理现有请求' })
          account.outgoing.push(target.uuid)
          target.incoming.push(account.uuid)
        }
        await store.saveAccounts()
        return json(res, 200, { ok: true })
      }
      if (method === 'POST' && pathname === '/api/friends/respond') {
        const body = await readJson(req)
        const peer = store.accounts.get(String(body.uuid || ''))
        if (!peer) return json(res, 404, { error: '请求已失效' })
        account.incoming = account.incoming.filter((uuid) => uuid !== peer.uuid)
        peer.outgoing = peer.outgoing.filter((uuid) => uuid !== account.uuid)
        if (body.accept === true) {
          if (!account.friends.includes(peer.uuid)) account.friends.push(peer.uuid)
          if (!peer.friends.includes(account.uuid)) peer.friends.push(account.uuid)
        }
        await store.saveAccounts()
        return json(res, 200, { ok: true, accepted: body.accept === true })
      }
      if (method === 'DELETE' && pathname.startsWith('/api/friends/')) {
        const uuid = decodeURIComponent(pathname.slice('/api/friends/'.length))
        const peer = store.accounts.get(uuid)
        if (!peer) return json(res, 404, { error: '好友不存在' })
        account.friends = account.friends.filter((item) => item !== uuid)
        peer.friends = peer.friends.filter((item) => item !== account.uuid)
        await store.saveAccounts()
        return json(res, 200, { ok: true })
      }
      if (method === 'GET' && pathname === '/api/messages') {
        const peer = store.accounts.get(String(url.searchParams.get('with') || ''))
        if (!peer || !account.friends.includes(peer.uuid)) return json(res, 404, { error: '对方不是你的好友' })
        const after = Number(url.searchParams.get('after')) || 0
        const items = store.messagesFor(account.uuid, peer.uuid).filter((message) => !after || message.at > after).slice(-500)
        return json(res, 200, {
          with: peer.uuid,
          items,
          unread: store.unreadFor(account, peer.uuid),
          peer: friendView(peer)
        })
      }
      if (method === 'POST' && pathname === '/api/messages') {
        const body = await readJson(req)
        const peer = store.accounts.get(String(body.to || ''))
        if (!peer || !account.friends.includes(peer.uuid)) return json(res, 404, { error: '对方不是你的好友' })
        const text = cleanMessage(body.text)
        const image = cleanMessageImage(body.image)
        if (image) {
          const file = store.files.get(image.id)
          if (!file || file.from !== account.uuid || !fileRecipients(file).includes(peer.uuid)) {
            return json(res, 400, { error: '图片附件无效或已过期' })
          }
        }
        if (!text && !image) return json(res, 400, { error: '消息不能为空' })
        const id = /^[a-zA-Z0-9_-]{6,40}$/.test(String(body.clientId || '')) ? String(body.clientId) : randomId('m_')
        const existing = store.messagesFor(account.uuid, peer.uuid).find((message) => message.id === id)
        if (existing) return json(res, 200, { message: existing })
        const message = { id, from: account.uuid, to: peer.uuid, text, at: now() }
        if (image) message.image = image
        await store.appendMessage(account.uuid, peer.uuid, message)
        return json(res, 200, { message })
      }
      if (method === 'POST' && pathname === '/api/read') {
        const body = await readJson(req)
        const peer = store.accounts.get(String(body.with || ''))
        if (!peer || !account.friends.includes(peer.uuid)) return json(res, 404, { error: '对方不是你的好友' })
        account.reads[pairKey(account.uuid, peer.uuid)] = Number(body.upTo) || now()
        await store.saveAccounts()
        return json(res, 200, { ok: true })
      }
      // ---------------- 群聊 ----------------
      if (method === 'GET' && pathname === '/api/groups') {
        return json(res, 200, { groups: groupsFor(account) })
      }
      if (method === 'POST' && pathname === '/api/groups') {
        const body = await readJson(req)
        const name = cleanText(body.name, 40) || '新群聊'
        if (store.groupsFor(account).length >= MAX_GROUPS_PER_USER) return json(res, 400, { error: '群聊数量已达上限（50 个）' })
        const requested = Array.isArray(body.members) ? [...new Set(body.members.map(String))] : []
        const members = []
        for (const uuid of requested) {
          if (!validUuid(uuid) || !account.friends.includes(uuid)) return json(res, 404, { error: '只能邀请自己的好友加入群聊' })
          members.push(uuid)
        }
        if (members.length + 1 > MAX_GROUP_MEMBERS) return json(res, 400, { error: `群成员上限 ${MAX_GROUP_MEMBERS} 人` })
        const group = store.createGroup(account.uuid, { name, members })
        await store.saveGroups()
        return json(res, 200, { group: groupView(account, group) })
      }
      const groupMemberMatch = pathname.match(/^\/api\/groups\/([A-Za-z0-9_-]+)\/members(?:\/([A-Za-z0-9-]+))?$/)
      if (groupMemberMatch) {
        const group = groupOrFail(account, groupMemberMatch[1], res)
        if (!group) return
        if (method === 'POST' && !groupMemberMatch[2]) {
          const body = await readJson(req)
          const uuid = String(body.uuid || '')
          if (!validUuid(uuid) || !account.friends.includes(uuid)) return json(res, 404, { error: '只能邀请自己的好友加入群聊' })
          if (group.members.length >= MAX_GROUP_MEMBERS) return json(res, 400, { error: `群成员上限 ${MAX_GROUP_MEMBERS} 人` })
          if (!group.members.includes(uuid)) {
            group.members.push(uuid)
            group.updatedAt = now()
            await store.saveGroups()
          }
          return json(res, 200, { ok: true, group: groupView(account, group) })
        }
        if (method === 'DELETE' && groupMemberMatch[2]) {
          const uuid = groupMemberMatch[2]
          if (uuid !== account.uuid && group.owner !== account.uuid) return json(res, 403, { error: '只有群主可以移除其他成员' })
          group.members = group.members.filter((member) => member !== uuid)
          if (group.owner === uuid) group.owner = group.members[0] || ''
          group.updatedAt = now()
          if (!group.members.length) store.groups.delete(group.id)
          await store.saveGroups()
          return json(res, 200, { ok: true })
        }
      }
      if (method === 'DELETE' && pathname.startsWith('/api/groups/')) {
        const group = groupOrFail(account, pathname.slice('/api/groups/'.length), res)
        if (!group) return
        group.members = group.members.filter((member) => member !== account.uuid)
        if (group.owner === account.uuid) group.owner = group.members[0] || ''
        group.updatedAt = now()
        if (!group.members.length) store.groups.delete(group.id)
        await store.saveGroups()
        return json(res, 200, { ok: true })
      }
      if (method === 'GET' && pathname.startsWith('/api/groups/') && pathname.endsWith('/messages')) {
        const id = pathname.slice('/api/groups/'.length, -'/messages'.length)
        const group = groupOrFail(account, id, res)
        if (!group) return
        const after = Number(url.searchParams.get('after')) || 0
        const items = store.groupMessagesFor(group).filter((message) => !after || message.at > after).slice(-500)
        if (url.searchParams.get('markRead') === '1') {
          account.groupReads = { ...(account.groupReads || {}), [group.id]: now() }
          await store.saveAccounts()
        }
        return json(res, 200, { group: groupView(account, group), items, unread: store.unreadForGroup(account, group) })
      }
      if (method === 'POST' && pathname.startsWith('/api/groups/') && pathname.endsWith('/messages')) {
        const id = pathname.slice('/api/groups/'.length, -'/messages'.length)
        const group = groupOrFail(account, id, res)
        if (!group) return
        const body = await readJson(req)
        const text = cleanMessage(body.text)
        const image = cleanMessageImage(body.image)
        if (image) {
          const file = store.files.get(image.id)
          const targetsGroup = file && fileTargets(file).some((target) => target.type === 'group' && target.id === group.id)
          if (!file || file.from !== account.uuid || !targetsGroup) return json(res, 400, { error: '图片附件无效或已过期' })
        }
        if (!text && !image) return json(res, 400, { error: '消息不能为空' })
        const messageId = /^[a-zA-Z0-9_-]{6,40}$/.test(String(body.clientId || '')) ? String(body.clientId) : randomId('m_')
        const existing = store.groupMessagesFor(group).find((message) => message.id === messageId)
        if (existing) return json(res, 200, { message: existing })
        const message = { id: messageId, from: account.uuid, groupId: group.id, text, at: now() }
        if (image) message.image = image
        await store.appendGroupMessage(group, message)
        await store.saveGroups()
        return json(res, 200, { message })
      }
      if (method === 'POST' && pathname.startsWith('/api/groups/') && pathname.endsWith('/read')) {
        const id = pathname.slice('/api/groups/'.length, -'/read'.length)
        const group = groupOrFail(account, id, res)
        if (!group) return
        const body = await readJson(req)
        account.groupReads = { ...(account.groupReads || {}), [group.id]: Number(body.upTo) || now() }
        await store.saveAccounts()
        return json(res, 200, { ok: true })
      }
      if (method === 'POST' && pathname === '/api/files') return await handleFileCreate(req, res, account)
      if (method === 'GET' && pathname === '/api/files') {
        const incoming = []
        const outgoing = []
        for (const file of store.files.values()) {
          const recipients = fileRecipients(file)
          if (file.from === account.uuid) outgoing.push(publicFile(file, account.uuid))
          else if (recipients.includes(account.uuid)) incoming.push(publicFile(file, account.uuid))
        }
        const sort = (list) => list.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50)
        return json(res, 200, { incoming: sort(incoming), outgoing: sort(outgoing) })
      }
      const fileMatch = pathname.match(/^\/api\/files\/([A-Za-z0-9_-]+)(\/download)?$/)
      if (fileMatch) {
        const id = fileMatch[1]
        if (method === 'PUT' && !fileMatch[2]) return await handleFileUpload(req, res, account, id)
        if (method === 'GET' && fileMatch[2]) return await handleFileDownload(req, res, account, id)
        if (method === 'DELETE' && !fileMatch[2]) {
          const file = store.files.get(id)
          if (!file || file.from !== account.uuid) return json(res, 404, { error: '文件不存在' })
          await fsp.rm(path.join(store.filesDir, id + '.bin'), { force: true }).catch(() => {})
          store.files.delete(id)
          await store.saveFiles()
          return json(res, 200, { ok: true })
        }
      }
      if (method === 'PUT' && pathname.startsWith('/api/mods/')) {
        const key = decodeURIComponent(pathname.slice('/api/mods/'.length)).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 80)
        if (!key) return json(res, 400, { error: '实例标识无效' })
        const body = await readJson(req)
        const items = (Array.isArray(body.items) ? body.items : []).slice(0, MAX_MANIFEST_ITEMS).map((item) => ({
          file: sanitizeFileName(item?.file),
          relPath: cleanText(item?.relPath, 240),
          size: Number(item?.size) || 0,
          sha1: String(item?.sha1 || '').toLowerCase(),
          modid: cleanText(item?.modid, 64),
          name: cleanText(item?.name, 120),
          version: cleanText(item?.version, 64),
          enabled: item?.enabled !== false,
          loader: cleanText(item?.loader, 24)
        })).filter((item) => validSha1(item.sha1))
        const manifests = await store.readManifests(account.uuid)
        manifests.instances = manifests.instances || {}
        manifests.instances[key] = {
          instance: {
            name: cleanText(body.instance?.name, 64),
            mc: cleanText(body.instance?.mc, 24),
            loader: cleanText(body.instance?.loader, 24)
          },
          items,
          updatedAt: now()
        }
        await store.writeManifests(account.uuid, manifests)
        return json(res, 200, { ok: true, instanceKey: key, count: items.length })
      }
      if (method === 'GET' && pathname === '/api/mods') {
        const uuid = String(url.searchParams.get('uuid') || account.uuid)
        if (uuid !== account.uuid && !account.friends.includes(uuid)) return json(res, 404, { error: '只能查看好友的模组清单' })
        const manifests = await store.readManifests(uuid)
        const peer = store.accounts.get(uuid)
        return json(res, 200, { profile: peer ? friendView(peer) : null, instances: manifests.instances || {} })
      }
      return json(res, 404, { error: '接口不存在：' + pathname })
    } catch (error) {
      logger.warn?.(`[friends-server] ${req.method} ${pathname} 失败：${error.message}`)
      if (!res.headersSent) json(res, Number(error.status) || 500, { error: error.message || '服务器内部错误' })
      else { try { res.destroy() } catch {} }
    }
  }

  const server = options.http ? http.createServer(handle) : https.createServer(options.tls || {}, handle)
  server.store = store
  server.ready = async () => {
    if (!ready) ready = store.init()
    await ready
    return server
  }
  return server
}

function readCertFingerprint(certPem) {
  try {
    return new crypto.X509Certificate(certPem).fingerprint256
  } catch {
    return ''
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, '').split('=')
    return [key, rest.join('=') || '1']
  }))
  const port = Number(args.port) || 443
  const host = args.host || '0.0.0.0'
  const dataDir = args.data || '/var/lib/mc-toolbox-friends'
  const httpMode = args.http === '1' || args.http === true
  let tls = null
  if (!httpMode) {
    if (!args.cert || !args.key) {
      console.error('缺少 --cert / --key；本地测试可用 --http')
      process.exit(1)
    }
    tls = { cert: fs.readFileSync(args.cert), key: fs.readFileSync(args.key) }
  }
  const server = createFriendsServer({
    dataDir,
    tls,
    http: httpMode,
    invite: args.invite || process.env.MCTB_FRIENDS_INVITE || '',
    quotaPerUser: Number(args['quota-mb']) * 1024 * 1024 || undefined,
    globalQuota: Number(args['global-mb']) * 1024 * 1024 || undefined
  })
  server.ready().then(() => {
    server.listen(port, host, () => {
      const scheme = httpMode ? 'http' : 'https'
      console.log(`[friends-server] 已启动：${scheme}://${host}:${port}（数据 ${dataDir}）`)
      if (!httpMode && args.cert) {
        const pem = fs.readFileSync(args.cert, 'utf8')
        console.log(`[friends-server] 证书指纹 SHA-256：${readCertFingerprint(pem)}`)
      }
      console.log(`[friends-server] 注册邀请码：${args.invite || process.env.MCTB_FRIENDS_INVITE ? '已启用' : '未设置（任何正版账号可注册）'}`)
    })
  }).catch((error) => {
    console.error('[friends-server] 启动失败：' + error.message)
    process.exit(1)
  })
  const shutdown = async () => {
    console.log('[friends-server] 正在退出…')
    server.close()
    await server.store.shutdown().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
