import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { instancePaths, MOD_UPDATE_DIR } from './state.js'
import { isProcessAlive } from './running-processes.js'
import { resolveModPath } from './mod-dedupe.js'
import { sha1File } from './download.js'
import { invalidateModUpdates } from './updates.js'

const active = new Set()
const SHA1 = /^[a-f0-9]{40}$/
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const keyOf = (file) => process.platform === 'win32' ? file.toLowerCase() : file
const busy = () => new Error('模组文件正被另一个操作使用，请稍后重试')

// 先发布自己的唯一声明再检查其他声明。同时竞争时允许双方均返回忙，
// 但不可能同时进入事务。只清理死进程的唯一文件，避免误删后继持锁者。
async function claimDirectory(key) {
  const locks = path.join(os.tmpdir(), 'mc-toolbox-mod-locks')
  const prefix = createHash('sha256').update(key).digest('hex') + '-'
  const own = prefix + process.pid + '-' + randomUUID()
  await fs.mkdir(locks, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(locks, own), '', { flag: 'wx' })
  const release = () => fs.rm(path.join(locks, own), { force: true })
  try {
    for (const name of await fs.readdir(locks)) {
      if (name === own || !name.startsWith(prefix)) continue
      const pid = Number(name.slice(prefix.length).split('-')[0])
      if (pid !== process.pid && isProcessAlive(pid)) throw busy()
      await fs.rm(path.join(locks, name), { force: true })
    }
    return release
  } catch (error) {
    await release()
    throw error
  }
}

async function stat(file) {
  try { return await fs.lstat(file) }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null }
}

// 旧 JAR、新 JAR 和清单都在游戏目录的同一卷，rename 不跨磁盘。
// 两个导入记录指向同一个游戏目录时共享同一份备份和锁。
async function withDirectory(inst, task) {
  const { gameDir } = instancePaths(inst)
  const game = await fs.realpath(gameDir).catch((error) => {
    if (error.code !== 'ENOENT') throw error
    return path.resolve(gameDir)
  })
  const key = keyOf(game)
  if (active.has(key)) throw busy()
  active.add(key)
  let release
  try {
    release = await claimDirectory(key)
    const dir = path.join(game, MOD_UPDATE_DIR)
    const info = await stat(dir)
    if (info && !info.isDirectory()) throw new Error('模组备份目录异常')
    const ctx = { dir, mods: path.join(game, 'mods'), file: path.join(dir, 'state.json') }
    const state = await readState(ctx)
    await recover(ctx, state)
    return await task(ctx, state)
  } finally {
    try { await release?.() } finally { active.delete(key) }
  }
}

function jarPath(rel) {
  const value = String(rel || '').replace(/\\/g, '/')
  if (!/\.jar(?:\.disabled)?$/i.test(value) || value.split('/').some((part) =>
    !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('模组 JAR 路径无效：' + value)
  return value
}

async function modFile(ctx, rel) {
  const file = resolveModPath(ctx.mods, jarPath(rel))
  if (keyOf(await fs.realpath(path.dirname(file))) !== keyOf(path.dirname(file))) throw new Error('模组路径包含目录链接：' + rel)
  const info = await stat(file)
  if (info && !info.isFile()) throw new Error('只支持常规 JAR 文件：' + rel)
  return { file, exists: Boolean(info) }
}

function validateBatch(batch) {
  if (!UUID.test(batch?.id) || !Array.isArray(batch.items) || !batch.items.length) throw new Error('模组备份清单异常')
  const paths = new Set()
  for (const item of batch.items) {
    if (!SHA1.test(item.oldSha1) || !SHA1.test(item.sha1)) throw new Error('模组校验值无效')
    for (const name of new Set([keyOf(jarPath(item.before)), keyOf(jarPath(item.after))])) {
      if (paths.has(name)) throw new Error('多个更新使用了同一文件：' + name)
      paths.add(name)
    }
  }
}

async function readState(ctx) {
  const info = await stat(ctx.file)
  if (!info) return { backup: null, pending: null }
  if (!info.isFile()) throw new Error('模组备份清单异常')
  const state = JSON.parse(await fs.readFile(ctx.file, 'utf8'))
  if (state.backup) validateBatch(state.backup)
  if (state.pending) {
    validateBatch(state.pending)
    if (!['staging', 'applying', 'undoing'].includes(state.pending.phase)) throw new Error('未知的模组更新阶段')
  }
  return state
}

async function saveState(ctx, state) {
  const tmp = ctx.file + '.' + randomUUID()
  try {
    await fs.writeFile(tmp, JSON.stringify(state), { flag: 'wx' })
    await fs.rename(tmp, ctx.file)
  } finally { await fs.rm(tmp, { force: true }) }
}

async function batchDir(ctx, batch) {
  const dir = path.join(ctx.dir, batch.id)
  if (!(await stat(dir))?.isDirectory()) throw new Error('模组备份目录丢失或异常')
  return dir
}

async function verifyFile(file, hash, label) {
  if (!(await stat(file))?.isFile() || await sha1File(file) !== hash) throw new Error('文件已变化或缺失：' + label)
}

async function checkOriginal(ctx, item) {
  const before = await modFile(ctx, item.before)
  const after = await modFile(ctx, item.after)
  if (keyOf(before.file) !== keyOf(after.file) && after.exists) throw new Error('目标文件已存在：' + item.after)
  await verifyFile(before.file, item.oldSha1, item.before)
  return { before: before.file, after: after.file }
}

// .old 仅在原文件已移出 mods 后存在；恢复成功后它被改回原名，重启可重复执行。
async function restore(ctx, batch) {
  const dir = await batchDir(ctx, batch)
  for (const [i, item] of batch.items.entries()) {
    const saved = path.join(dir, i + '.old')
    if (!await stat(saved)) {
      const before = await modFile(ctx, item.before)
      await verifyFile(before.file, item.oldSha1, item.before)
      continue
    }
    await verifyFile(saved, item.oldSha1, item.before)
    const before = await modFile(ctx, item.before)
    const after = await modFile(ctx, item.after)
    if (keyOf(before.file) !== keyOf(after.file) && before.exists) throw new Error('旧文件名已被占用：' + item.before)
    if (after.exists) {
      await verifyFile(after.file, item.sha1, item.after)
      await fs.unlink(after.file)
    }
    await fs.rename(saved, before.file)
  }
}

async function recover(ctx, state) {
  const batch = state.pending
  if (batch) {
    if (batch.phase !== 'staging') await restore(ctx, batch)
    if (batch.phase === 'undoing') state.backup = null
    state.pending = null
    state.garbage = batch.id
    await saveState(ctx, state)
  }
  if (state.garbage) {
    if (!UUID.test(state.garbage) || state.garbage === state.backup?.id) throw new Error('模组备份清单异常')
    await fs.rm(path.join(ctx.dir, state.garbage), { recursive: true, force: true })
    delete state.garbage
    await saveState(ctx, state)
  }
}

export function withModUpdateLock(inst, task) {
  return withDirectory(inst, () => task())
}

export function recoverModUpdate(inst) {
  return withModUpdateLock(inst, () => {})
}

export function getModUpdateBackup(inst) {
  return withDirectory(inst, (_ctx, { backup }) => ({
    backup: backup && { id: backup.id, createdAt: backup.createdAt, items: backup.items.map(({ before, after }) => ({ before, after })) }
  }))
}

export function applyModUpdate(inst, items, { download, signal, onCommit } = {}) {
  return withDirectory(inst, async (ctx, state) => {
    const batch = { id: randomUUID(), createdAt: Date.now(), items: [] }
    for (const item of items) {
      signal?.throwIfAborted()
      const before = jarPath(item.relPath)
      const filename = jarPath(item.filename || path.posix.basename(before)).replace(/\.disabled$/i, '')
      if (filename.includes('/')) throw new Error('更新文件名非法：' + filename)
      const after = path.posix.join(path.posix.dirname(before), filename + (/\.disabled$/i.test(before) ? '.disabled' : ''))
      const { file } = await modFile(ctx, before)
      const oldSha1 = item.oldSha1 || await sha1File(file)
      batch.items.push({ before, after, oldSha1, sha1: item.sha1 })
    }
    validateBatch(batch)
    for (const item of batch.items) await checkOriginal(ctx, item)
    await fs.mkdir(ctx.dir, { recursive: true })
    state.pending = { ...batch, phase: 'staging' }
    await saveState(ctx, state)
    const dir = path.join(ctx.dir, batch.id)
    try {
      await fs.mkdir(dir)
      for (const [i, item] of items.entries()) {
        signal?.throwIfAborted()
        await download(item, path.join(dir, i + '.new'), i)
      }
      // 下载可能很慢。重新检查原件，避免覆盖期间由用户手动换入的版本。
      for (const item of batch.items) await checkOriginal(ctx, item)
      signal?.throwIfAborted()
      state.pending.phase = 'applying'
      await saveState(ctx, state)
      onCommit?.()
      for (const [i, item] of batch.items.entries()) {
        const old = await modFile(ctx, item.before)
        const target = await modFile(ctx, item.after)
        if (keyOf(old.file) !== keyOf(target.file) && target.exists) throw new Error('目标文件已存在：' + item.after)
        await fs.rename(old.file, path.join(dir, i + '.old'))
        await fs.rename(path.join(dir, i + '.new'), target.file)
      }
      const next = { backup: batch, pending: null, garbage: state.backup?.id }
      await saveState(ctx, next)
      invalidateModUpdates(inst.id)
      // 成功标记已落盘；删除上一批备份失败时，下次访问会继续清理。
      await recover(ctx, next).catch(() => {})
    } catch (error) {
      await recover(ctx, state)
      throw error
    }
  })
}

export function undoModUpdate(inst, id) {
  return withDirectory(inst, async (ctx, state) => {
    const batch = state.backup
    if (!batch || batch.id !== id) throw new Error('备份已变化，请刷新后再撤销')
    const dir = await batchDir(ctx, batch)
    // 撤销前全批验算。保留用户后来替换的文件与新的同名文件。
    for (const [i, item] of batch.items.entries()) {
      const before = await modFile(ctx, item.before)
      const after = await modFile(ctx, item.after)
      if (keyOf(before.file) !== keyOf(after.file) && before.exists) throw new Error('旧文件名已被占用：' + item.before)
      await verifyFile(after.file, item.sha1, item.after)
      await verifyFile(path.join(dir, i + '.old'), item.oldSha1, item.before)
    }
    state.pending = { ...batch, phase: 'undoing' }
    await saveState(ctx, state)
    await recover(ctx, state)
    invalidateModUpdates(inst.id)
    return { ok: true }
  })
}
