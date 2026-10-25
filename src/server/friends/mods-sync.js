// 模组清单对比与「对称配置」补齐。
//
// 目标：两个人比对同一 MC 版本 + 同一加载器的实例，一眼看出谁多/谁少/版本不同，
// 然后按「暂存区 → Modrinth → 对端直传」的顺序把缺的 jar 补齐，最终两边完全一致。
// 这里只放纯逻辑（可单测）；下载、直传、落盘由 node.js / manager 执行。
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { sanitizeFileName } from './transfer.js'

const SHA1_RE = /^[0-9a-f]{40}$/

export function normalizeModId(value) {
  return String(value || '').toLowerCase().replace(/[-_\s]/g, '')
}

function itemKey(item) {
  return SHA1_RE.test(String(item?.sha1 || '')) ? String(item.sha1) : 'file:' + String(item?.relPath || item?.file || '').toLowerCase()
}

/** 把实例内容接口的结果转成可传输的清单（只保留对比需要的字段）。 */
export function manifestFromItems(items) {
  if (!Array.isArray(items)) return []
  return items.map((item) => ({
    file: String(item.file || item.relPath || ''),
    relPath: String(item.relPath || item.file || ''),
    size: Number(item.size) || 0,
    sha1: String(item.sha1 || '').toLowerCase(),
    modid: String(item.modid || ''),
    name: String(item.name || ''),
    version: String(item.version || ''),
    enabled: item.disabled !== true && item.enabled !== false,
    loader: String(item.loader || '')
  })).filter((item) => item.file && SHA1_RE.test(item.sha1))
}

/**
 * 对比两份清单。
 * - same：SHA-1 完全一致（含启用状态也一致）
 * - different：同一个 modid（或同名文件）但 SHA-1 / 启用状态不同
 * - onlyMine / onlyPeer：只在一侧存在
 */
export function diffManifests(mine, peer) {
  const mineItems = Array.isArray(mine) ? mine : []
  const peerItems = Array.isArray(peer) ? peer : []
  const peerBySha = new Map()
  for (const item of peerItems) peerBySha.set(itemKey(item), item)
  const usedPeer = new Set()
  const same = []
  const different = []
  const onlyMine = []

  for (const item of mineItems) {
    const peerItem = peerBySha.get(itemKey(item))
    if (peerItem) {
      usedPeer.add(peerItem)
      if (peerItem.enabled === item.enabled) same.push({ mine: item, peer: peerItem })
      else different.push({ mine: item, peer: peerItem, reason: 'enabled' })
      continue
    }
    const sameId = peerItems.find((candidate) => !usedPeer.has(candidate)
      && item.modid && candidate.modid && normalizeModId(item.modid) === normalizeModId(candidate.modid))
    if (sameId) {
      usedPeer.add(sameId)
      different.push({ mine: item, peer: sameId, reason: 'version' })
      continue
    }
    const sameName = peerItems.find((candidate) => !usedPeer.has(candidate)
      && String(candidate.file).toLowerCase() === String(item.file).toLowerCase())
    if (sameName) {
      usedPeer.add(sameName)
      different.push({ mine: item, peer: sameName, reason: 'version' })
      continue
    }
    onlyMine.push(item)
  }
  const onlyPeer = peerItems.filter((item) => !usedPeer.has(item))

  return {
    same,
    different,
    onlyMine,
    onlyPeer,
    counts: {
      same: same.length,
      different: different.length,
      onlyMine: onlyMine.length,
      onlyPeer: onlyPeer.length,
      symmetric: different.length === 0 && onlyMine.length === 0 && onlyPeer.length === 0
    }
  }
}

/**
 * 生成补齐动作。v1 只提供「以对方为准」这一个收敛方向：
 * - acquire：对方独有的、以及版本不同的对方文件，全部拿过来
 * - toggle：同一个 jar 但启用状态不同，按对方状态切换
 * - disable：我这边对方没有的、以及被对方版本替换掉的旧文件，改名为 .disabled
 * 执行完后两边的（文件名 + SHA-1 + 启用状态）集合完全一致，也就是「对称配置」。
 *
 * send 方向只是把「我独有的文件」发给对方暂存区，由对方决定是否应用；
 * 不在本机远端写入，也不替对方做删除/停用。
 */
export function fillPlan(diff, direction = 'acquire') {
  const send = direction === 'send'
  const acquire = []
  const toggle = []
  const disable = []
  if (send) {
    for (const item of diff?.onlyMine || []) acquire.push({ item, enabled: item.enabled })
    for (const pair of diff?.different || []) {
      if (pair.reason === 'version') acquire.push({ item: pair.mine, enabled: pair.mine.enabled })
    }
    return { mode: 'send', acquire, toggle, disable }
  }
  for (const item of diff?.onlyPeer || []) acquire.push({ item, enabled: item.enabled })
  for (const item of diff?.onlyMine || []) disable.push({ item })
  for (const pair of diff?.different || []) {
    if (pair.reason === 'enabled') {
      toggle.push({ item: pair.mine, enabled: pair.peer.enabled })
      continue
    }
    acquire.push({ item: pair.peer, enabled: pair.peer.enabled })
    disable.push({ item: pair.mine })
  }
  return { mode: 'acquire', acquire, toggle, disable }
}

/** 暂存区路径：本机固定目录，绝不由对端文件名参与拼接。 */
export function stagingDirFor(rootDir, transferId) {
  const text = String(transferId || '')
  const safeId = text.replace(/[^a-zA-Z0-9_-]/g, '')
  // 传输 id 由服务端生成；出现非法字符说明调用方拼错了参数，宁可报错也不要静默改名。
  if (!safeId || safeId !== text) throw new Error('传输 id 无效')
  return path.join(rootDir, safeId)
}

export async function sha1File(file) {
  const hash = crypto.createHash('sha1')
  const stream = fs.createReadStream(file)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

/**
 * 把已校验的 jar 放进实例 mods 目录。
 * 目标文件已存在且内容不同：旧文件改名为 .disabled（不删除，用户可以手动恢复），
 * 再写入新文件 —— 「对称配置」不应该以删掉用户文件为代价。
 */
export async function applyJar({ sourceFile, targetDir, filename, sha1, enabled = true }) {
  if (!SHA1_RE.test(String(sha1 || ''))) throw new Error('缺少有效的 SHA-1')
  const actual = await sha1File(sourceFile)
  if (actual !== sha1) throw new Error(`模组校验失败：${path.basename(sourceFile)}`)
  await fsp.mkdir(targetDir, { recursive: true })
  // 对端清单里的 file 可能带 .disabled 后缀；启停状态以 enabled 字段为准，
  // 否则会写出 x.jar.disabled.disabled 这种双重后缀。
  const base = sanitizeFileName(filename, { fallback: 'mod.jar', maxLength: 160 }).replace(/\.disabled$/i, '')
  const safe = enabled ? base : base + '.disabled'
  const target = path.join(targetDir, safe)
  let disabledExisting = ''
  if (fs.existsSync(target)) {
    const existing = await sha1File(target)
    if (existing === sha1) return { file: target, skipped: true, disabledExisting: '' }
    const backup = target + '.disabled'
    if (fs.existsSync(backup)) {
      disabledExisting = backup
    } else {
      await fsp.rename(target, backup)
      disabledExisting = backup
    }
  }
  const tmp = target + '.part'
  await fsp.copyFile(sourceFile, tmp)
  await fsp.rename(tmp, target)
  return { file: target, skipped: false, disabledExisting }
}

/** 按 SHA-1 在暂存目录里找已经收到的文件（不递归太深，避免误扫用户目录）。 */
export async function findStagedBySha(dir, sha1) {
  if (!dir || !SHA1_RE.test(String(sha1 || ''))) return ''
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return ''
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!/\.jar(\.disabled)?$/i.test(entry.name)) continue
    const file = path.join(dir, entry.name)
    try {
      if (await sha1File(file) === sha1) return file
    } catch {}
  }
  return ''
}

export async function fileMeta(file) {
  const stat = await fsp.stat(file)
  return { size: stat.size, sha1: await sha1File(file), name: path.basename(file) }
}

