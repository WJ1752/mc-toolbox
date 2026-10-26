// 好友客户端本地状态：服务器地址/指纹、会话令牌、偏好与接收记录。
//
// 令牌能直接登录好友服务器，文件权限按 0600 处理；服务器指纹固定后，
// 每次 HTTPS 响应都会比对证书，指纹变化直接拒绝。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const CLIENT_VERSION = 2

export function defaultState() {
  return {
    v: CLIENT_VERSION,
    server: { url: '', fingerprint: '', requiresInvite: false },
    session: { token: '', expiresAt: 0, profile: null },
    prefs: { nickname: '', showActivity: true, allowPull: true, downloadDir: '', autoApplyMods: true },
    received: []
  }
}

function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max)
}

function normalize(raw) {
  const base = defaultState()
  if (!raw || typeof raw !== 'object') return base
  const server = raw.server && typeof raw.server === 'object' ? raw.server : {}
  const session = raw.session && typeof raw.session === 'object' ? raw.session : {}
  const prefs = raw.prefs && typeof raw.prefs === 'object' ? raw.prefs : {}
  return {
    v: CLIENT_VERSION,
    server: {
      url: cleanText(server.url, 300).replace(/\/+$/, ''),
      fingerprint: cleanText(server.fingerprint, 100),
      requiresInvite: server.requiresInvite === true
    },
    session: {
      token: String(session.token || ''),
      expiresAt: Number(session.expiresAt) || 0,
      profile: session.profile && typeof session.profile === 'object'
        ? {
            uuid: cleanText(session.profile.uuid, 64),
            mcName: cleanText(session.profile.mcName, 32),
            nickname: cleanText(session.profile.nickname, 24)
          }
        : null
    },
    prefs: {
      nickname: cleanText(prefs.nickname, 24),
      showActivity: prefs.showActivity !== false,
      allowPull: prefs.allowPull !== false,
      // 下载目录：留空表示使用工具箱默认接收目录；非空时必须是绝对路径。
      downloadDir: path.isAbsolute(String(prefs.downloadDir || '')) ? String(prefs.downloadDir) : '',
      autoApplyMods: prefs.autoApplyMods !== false
    },
    received: (Array.isArray(raw.received) ? raw.received : [])
      .map((item) => ({
        id: String(item?.id || ''),
        kind: item?.kind === 'mod' ? 'mod' : 'pack',
        name: cleanText(item?.name, 160),
        peerName: cleanText(item?.peerName, 64),
        instanceId: String(item?.instanceId || ''),
        instanceName: cleanText(item?.instanceName, 80),
        at: Number(item?.at) || 0,
        files: (Array.isArray(item?.files) ? item.files : []).map((file) => ({
          name: cleanText(file?.name, 160),
          path: String(file?.path || ''),
          size: Number(file?.size) || 0,
          sha1: String(file?.sha1 || '')
        })).filter((file) => file.path)
      }))
      .filter((item) => item.id && item.files.length)
      .slice(0, 40)
  }
}

export class ClientStore {
  constructor(file, { logger = console } = {}) {
    this.file = file
    this.logger = logger
    this.state = defaultState()
    this.loaded = false
    this.timer = null
  }

  load() {
    if (this.loaded) return this.state
    this.loaded = true
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      this.state = normalize(JSON.parse(raw))
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger.warn?.('[friends] 读取本地配置失败：' + error.message)
    }
    return this.state
  }

  get() {
    return this.load()
  }

  setServer({ url, fingerprint, requiresInvite = false }) {
    const state = this.load()
    state.server = {
      url: cleanText(url, 300).replace(/\/+$/, ''),
      fingerprint: cleanText(fingerprint, 100),
      requiresInvite: requiresInvite === true
    }
    // 换服务器必须重新登录。
    state.session = { token: '', expiresAt: 0, profile: null }
    this.scheduleSave()
    return state.server
  }

  setSession(session) {
    const state = this.load()
    state.session = {
      token: String(session?.token || ''),
      expiresAt: Number(session?.expiresAt) || 0,
      profile: session?.profile || null
    }
    this.scheduleSave()
    return state.session
  }

  clearSession() {
    const state = this.load()
    state.session = { token: '', expiresAt: 0, profile: null }
    this.scheduleSave()
  }

  setPrefs(patch = {}) {
    const state = this.load()
    const next = normalize({ ...state, prefs: { ...state.prefs, ...patch } })
    state.prefs = next.prefs
    this.scheduleSave()
    return state.prefs
  }

  addReceived(entry) {
    const state = this.load()
    // 同一次接收重复下载/换目录时只保留最新记录，避免列表里出现两条同名文件。
    state.received = state.received.filter((item) => item.id !== entry.id)
    state.received.unshift(entry)
    state.received = state.received.slice(0, 40)
    this.scheduleSave()
    return entry
  }

  removeReceived(id) {
    const state = this.load()
    const before = state.received.length
    state.received = state.received.filter((item) => item.id !== id)
    if (state.received.length !== before) this.scheduleSave()
    return state.received.length !== before
  }

  /** 清空全部接收记录，返回清掉的条数。 */
  clearReceived() {
    const state = this.load()
    const removed = state.received.length
    if (removed) {
      state.received = []
      this.scheduleSave()
    }
    return removed
  }

  saveNow() {
    this.load()
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
      fs.renameSync(tmp, this.file)
      try { fs.chmodSync(this.file, 0o600) } catch {}
    } catch (error) {
      this.logger.warn?.('[friends] 写入本地配置失败：' + error.message)
    }
  }

  scheduleSave(delay = 300) {
    if (this.timer) return
    const timer = setTimeout(() => {
      this.timer = null
      this.saveNow()
    }, delay)
    timer.unref?.()
    this.timer = timer
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.saveNow()
    await fsp.access(this.file).catch(() => {})
  }
}
