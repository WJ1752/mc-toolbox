// 传输台账：整合包与模组文件的发送/接收进度、状态机与文件名消毒。
//
// 安全边界：对端发来的文件名一律当「不可信输入」。它只能决定一个经过消毒的文件名，
// 决定不了目录 —— 落盘路径始终由本机生成（received/<transferId>/），避免 ../ 穿越。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const CONTROL = /[\u0000-\u001f\u007f<>:"/\\|?*]/g

export const TRANSFER_ACTIVE = new Set(['offering', 'waiting', 'sending', 'offered', 'receiving', 'verifying'])
export const TRANSFER_FINISHED = new Set(['done', 'failed', 'rejected', 'cancelled'])

/** 只取文件名，去掉路径与非法字符；不改变扩展名。 */
export function sanitizeFileName(name, { fallback = 'file', maxLength = 180 } = {}) {
  let base = String(name || '')
  base = base.split(/[\\/]/).pop() || ''
  base = base.replace(CONTROL, '_').trim()
  base = base.replace(/[. ]+$/g, '')
  if (!base || base === '.' || base === '..') base = fallback
  if (WINDOWS_RESERVED.test(base)) base = '_' + base
  if (base.length > maxLength) {
    const ext = path.extname(base).slice(0, 16)
    base = base.slice(0, Math.max(1, maxLength - ext.length)) + ext
  }
  return base || fallback
}

export function fileSha1(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1')
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export function uniqueFileName(dir, name) {
  const safe = sanitizeFileName(name)
  if (!fs.existsSync(path.join(dir, safe))) return safe
  const ext = path.extname(safe)
  const stem = safe.slice(0, safe.length - ext.length)
  for (let index = 2; index < 1000; index++) {
    const candidate = `${stem}-${index}${ext}`
    if (!fs.existsSync(path.join(dir, candidate))) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

export class TransferBook {
  constructor({ limit = 40, logger = console } = {}) {
    this.limit = limit
    this.logger = logger
    this.map = new Map()
    this.seq = 0
  }

  newId(prefix = 't') {
    this.seq += 1
    return `${prefix}_${Date.now().toString(36)}${this.seq.toString(36)}`
  }

  create(fields) {
    const id = fields.id || this.newId(fields.direction === 'in' ? 'in' : 'out')
    const files = (fields.files || []).map((file) => ({
      name: file.name,
      size: Number(file.size) || 0,
      sha1: String(file.sha1 || ''),
      received: 0,
      path: file.path || '',
      verified: false
    }))
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
    const transfer = {
      id,
      direction: fields.direction === 'in' ? 'in' : 'out',
      kind: fields.kind === 'mods' ? 'mods' : 'pack',
      peerId: String(fields.peerId || ''),
      peerName: String(fields.peerName || ''),
      name: String(fields.name || '').slice(0, 160) || '未命名',
      status: fields.status || (fields.direction === 'in' ? 'offered' : 'offering'),
      files,
      totalBytes,
      transferredBytes: 0,
      createdAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
      error: '',
      instanceId: String(fields.instanceId || ''),
      instanceName: String(fields.instanceName || ''),
      stagingDir: String(fields.stagingDir || '')
    }
    this.map.set(id, transfer)
    this.trim()
    return transfer
  }

  get(id) {
    return this.map.get(id) || null
  }

  list() {
    return [...this.map.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  update(id, patch = {}) {
    const transfer = this.map.get(id)
    if (!transfer) return null
    Object.assign(transfer, patch)
    if (patch.files) transfer.files = patch.files
    return transfer
  }

  addBytes(id, bytes) {
    const transfer = this.map.get(id)
    if (!transfer) return
    transfer.transferredBytes = Math.min(transfer.totalBytes, transfer.transferredBytes + Math.max(0, bytes))
  }

  finish(id, status, error = '') {
    const transfer = this.map.get(id)
    if (!transfer) return null
    transfer.status = status
    transfer.error = error || ''
    transfer.finishedAt = Date.now()
    this.trim()
    return transfer
  }

  active(direction = '') {
    return this.list().filter((item) => TRANSFER_ACTIVE.has(item.status) && (!direction || item.direction === direction))
  }

  trim() {
    const finished = this.list().filter((item) => TRANSFER_FINISHED.has(item.status))
    for (const item of finished.slice(this.limit)) this.map.delete(item.id)
  }

  snapshot() {
    return this.list().map((item) => ({
      id: item.id,
      direction: item.direction,
      kind: item.kind,
      peerId: item.peerId,
      peerName: item.peerName,
      name: item.name,
      status: item.status,
      error: item.error,
      instanceId: item.instanceId,
      instanceName: item.instanceName,
      totalBytes: item.totalBytes,
      transferredBytes: item.transferredBytes,
      fileCount: item.files.length,
      createdAt: item.createdAt,
      finishedAt: item.finishedAt,
      files: item.files.map((file) => ({
        name: file.name,
        size: file.size,
        received: file.received,
        verified: file.verified,
        path: item.direction === 'in' ? file.path : ''
      }))
    }))
  }
}
