import fsp from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { instancePaths } from './state.js'

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/

function worldName(value) {
  if (typeof value !== 'string' || !value || /[\\/:<>|"?*\x00-\x1f]/.test(value) || /[. ]$/.test(value)) {
    throw new Error('世界目录名无效')
  }
  return value
}

async function directory(parent, name, create = false) {
  const dir = path.join(parent, name)
  if (create) await fsp.mkdir(dir).catch(error => { if (error.code !== 'EEXIST') throw error })
  if (!(await fsp.lstat(dir)).isDirectory()) throw new Error('目录包含链接或类型不正确：' + name)
  return dir
}

async function backupRoot(inst, create = false) {
  const { root } = instancePaths(inst)
  const backups = await directory(root, 'backups', create)
  const worlds = await directory(backups, 'worlds', create)
  return directory(worlds, createHash('sha256').update(inst.id).digest('hex'), create)
}

async function copyWorld(source, dest) {
  if (!(await fsp.lstat(path.join(source, 'level.dat'))).isFile()) throw new Error('世界缺少有效的 level.dat')
  let bytes = 0
  let files = 0
  await fsp.cp(source, dest, {
    recursive: true, force: false, errorOnExist: true, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE,
    filter: async (file) => {
      if (file === path.join(source, 'session.lock')) return false
      const stat = await fsp.lstat(file)
      if (stat.isDirectory()) return true
      if (!stat.isFile()) throw new Error('存档中包含链接或特殊文件：' + path.relative(source, file))
      bytes += stat.size
      files++
      return true
    }
  })
  return { files, bytes }
}

async function readBackup(root, id) {
  if (!UUID.test(id)) throw new Error('备份编号无效')
  const dir = await directory(root, id)
  const file = path.join(dir, 'info.json')
  const stat = await fsp.lstat(file)
  if (!stat.isFile() || stat.size > 8192) throw new Error('备份清单无效')
  const info = JSON.parse(await fsp.readFile(file, 'utf8'))
  worldName(info.world)
  if (info.id !== id || !Number.isFinite(info.createdAt) || !Number.isSafeInteger(info.bytes) ||
      info.bytes < 0 || !Number.isSafeInteger(info.files) || info.files < 1) throw new Error('备份清单无效')
  return info
}

export async function listWorldBackups(inst) {
  let root
  try { root = await backupRoot(inst) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const backups = []
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && UUID.test(entry.name)) backups.push(await readBackup(root, entry.name))
  }
  return backups.sort((a, b) => b.createdAt - a.createdAt)
}

export async function backupWorld(inst, name, checkIdle) {
  const { gameDir } = instancePaths(inst)
  const saves = await directory(gameDir, 'saves')
  const world = worldName(name)
  const source = await directory(saves, world)
  const root = await backupRoot(inst, true)
  const id = randomUUID()
  const staging = await fsp.mkdtemp(path.join(root, '.pending-'))
  try {
    const counts = await copyWorld(source, path.join(staging, 'world'))
    await checkIdle?.()
    const info = { id, world, createdAt: Date.now(), ...counts }
    await fsp.writeFile(path.join(staging, 'info.json'), JSON.stringify(info), { flag: 'wx' })
    await fsp.rename(staging, path.join(root, id))
    return info
  } finally { await fsp.rm(staging, { recursive: true, force: true }) }
}

export async function restoreWorldBackup(inst, id, checkIdle) {
  const root = await backupRoot(inst)
  const info = await readBackup(root, id)
  const source = await directory(path.join(root, id), 'world')
  const saves = await directory(instancePaths(inst).gameDir, 'saves', true)
  // 用同一卷的临时子目录准备完整副本。世界列表只看到最后原子发布的目录。
  const staging = await fsp.mkdtemp(path.join(saves, '.restore-'))
  try {
    const pending = path.join(staging, 'world')
    const counts = await copyWorld(source, pending)
    if (counts.files !== info.files || counts.bytes !== info.bytes) throw new Error('备份文件数量或大小已经变化')
    await checkIdle?.()
    const name = info.world.slice(0, 40) + '-恢复-' + randomUUID()
    await fsp.rename(pending, path.join(saves, name))
    return { name }
  } finally { await fsp.rm(staging, { recursive: true, force: true }) }
}
