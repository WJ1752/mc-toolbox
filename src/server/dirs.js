// 存储目录变更 + 文件迁移
//
// 流程（changeDir）：
//   1) 校验目标（绝对路径、不嵌套、目标为空）
//   2) 把未落盘的配置立即写盘（flushAll）
//   3) 逐项复制 旧目录 → 新目录（fs.cpSync，已存在即报错，绝不静默覆盖）
//   4) 校验文件数 + 总字节数完全一致，不一致则中止并保留原目录
//   5) 校验通过后清空旧目录，applyDirs() 切换（ESM 实时绑定，store.js 等惰性读取方立即指向新目录）
//   6) 再 flushAll 一次，把内存缓存重写到新目录，消除迁移间隙的写入竞态
//
// 归属规则（dev 模式三个目录物理上是同一个 data/，必须按文件归属拆分，避免误搬别人的文件）：
//   dirs.json 永不迁移（引导文件，固定在默认数据目录）
//   settings.json / monitors.json → configDir 专属
//   clientmods.json → clientModsDir 专属
//   history.json / *.log → dataDir 专属
import fs from 'node:fs'
import path from 'node:path'
import { getDirs, applyDirs } from './paths.js'
import { store } from './store.js'

const WHICHES = ['configDir', 'clientModsDir', 'dataDir']
const LABELS = { configDir: '配置目录', clientModsDir: 'mod 库目录', dataDir: '运行数据目录' }

const FILE_OWNERS = {
  'settings.json': 'configDir',
  'monitors.json': 'configDir',
  'clientmods.json': 'clientModsDir',
  'history.json': 'dataDir'
}

let busy = false

function excludesFor(which) {
  return (name) => {
    if (name === 'dirs.json') return true // 引导文件固定不动
    const owner = FILE_OWNERS[name] || (name.endsWith('.log') ? 'dataDir' : undefined)
    return owner !== undefined && owner !== which
  }
}

function walkStats(dir, entries) {
  let files = 0
  let bytes = 0
  const list = entries || fs.readdirSync(dir, { withFileTypes: true })
  for (const ent of list) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      const s = walkStats(p)
      files += s.files
      bytes += s.bytes
    } else {
      files++
      bytes += fs.statSync(p).size
    }
  }
  return { files, bytes }
}

const isInside = (parent, child) => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function listDirs() {
  const d = getDirs()
  return {
    ...d,
    labels: LABELS,
    movable: WHICHES,
    custom: {
      configDir: d.configDir !== d.defaults.configDir,
      clientModsDir: d.clientModsDir !== d.defaults.clientModsDir,
      dataDir: d.dataDir !== d.defaults.dataDir
    }
  }
}

export async function changeDir(which, targetArg) {
  if (!WHICHES.includes(which)) return { error: '未知目录类型：' + which }
  if (busy) return { error: '正在迁移中，请稍候' }

  const dirs = getDirs()
  const current = dirs[which]
  const isReset = targetArg === null || targetArg === undefined || targetArg === ''
  const target = isReset ? dirs.defaults[which] : path.resolve(String(targetArg).trim())

  if (path.resolve(current) === target) return { error: '新目录与当前目录相同' }
  if (isInside(current, target)) return { error: '新目录不能在当前目录内部' }
  if (isInside(target, current)) return { error: '当前目录不能在新目录内部' }

  busy = true
  try {
    fs.mkdirSync(target, { recursive: true })
    // 归属排除：dev 模式下三类目录共用同一个物理目录，不能把别的类别的文件搬走；
    // 目标里已有的「他类/引导」文件不算冲突（本次迁移不会碰它们）
    const skip = excludesFor(which)
    const existing = fs.readdirSync(target).filter((n) => !skip(n))
    if (existing.length) return { error: '目标目录不是空的（存在：' + existing.slice(0, 3).join('、') + '），请选择一个空目录' }

    const entries = fs.existsSync(current)
      ? fs.readdirSync(current, { withFileTypes: true }).filter((e) => !skip(e.name))
      : []

    store.flushAll() // 未落盘的先写盘，保证迁移的是最新内容

    // 复制（不覆盖，出错即中止；此时原目录未动）
    try {
      for (const ent of entries) {
        fs.cpSync(path.join(current, ent.name), path.join(target, ent.name), { recursive: true, force: false, errorOnExist: true })
      }
    } catch (e) {
      return { error: '复制失败（原目录未受影响）：' + e.message }
    }

    // 校验：文件数 + 字节数必须完全一致（只比对本次拷贝的内容）
    const copiedNames = new Set(entries.map((e) => e.name))
    const srcStat = walkStats(current, entries)
    const dstEntries = fs.readdirSync(target, { withFileTypes: true }).filter((e) => copiedNames.has(e.name))
    const dstStat = walkStats(target, dstEntries)
    if (srcStat.files !== dstStat.files || srcStat.bytes !== dstStat.bytes) {
      return { error: `校验失败（源 ${srcStat.files} 文件/${srcStat.bytes}B，目标 ${dstStat.files} 文件/${dstStat.bytes}B），已中止，原目录未受影响` }
    }

    // 切换 + 清空旧目录 + 缓存重写到新目录
    applyDirs({ [which]: isReset || target === dirs.defaults[which] ? null : target })
    for (const ent of entries) {
      fs.rmSync(path.join(current, ent.name), { recursive: true, force: true })
    }
    store.flushAll()

    return {
      ok: true,
      which,
      from: current,
      target,
      files: dstStat.files,
      bytes: dstStat.bytes,
      note: isReset ? '已恢复默认目录' : '文件已完整转移，立即生效'
    }
  } catch (e) {
    return { error: '迁移失败（原目录未受影响）：' + e.message }
  } finally {
    busy = false
  }
}

export function resetDir(which) {
  return changeDir(which, null)
}
