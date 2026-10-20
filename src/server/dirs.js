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
//
// 一键迁移（changeRoot）在上述流程之上把三类目录一起搬进同一个文件夹：
//   <target>\config / <target>\client-mods / <target>\data
// 三类各自复制 + 校验，全部通过后才 applyDirs；任何一步失败都保留原目录，
// 并清掉本次新建的目标子目录（只删自己创建/复制的内容，用户原有文件不动）。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { getDirs, applyDirs } from './paths.js'
import { store } from './store.js'

const WHICHES = ['configDir', 'clientModsDir', 'dataDir']
const LABELS = { configDir: '配置目录', clientModsDir: 'mod 库目录', dataDir: '运行数据目录' }
// 一键迁移后的固定子目录名（三类目录的「家」）
const ROOT_SUBDIRS = { configDir: 'config', clientModsDir: 'client-mods', dataDir: 'data' }

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
    const owner = FILE_OWNERS[name] || 'dataDir'
    return owner !== which
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

// 复制 + 校验（changeDir / changeRoot 共用）：
//   逐项复制（已存在即报错，绝不静默覆盖），然后只比对「本次拷贝的条目」的
//   文件数与总字节数；返回结果由调用方决定是否切换目录（此阶段原目录仍未动）。
//   这里用异步 fsp.cp 而不是 fs.cpSync：Node 22.18 的 cpSync 在 Windows 上复制
//   目录时，只要【源路径含非 ASCII 字符】（本项目的 F:\DS数据\…）就会直接 fastfail
//   杀掉进程；异步实现没有该问题，选项与「不覆盖」语义保持完全一致。
async function copyAndVerify(from, to, entries) {
  for (const ent of entries) {
    await fsp.cp(path.join(from, ent.name), path.join(to, ent.name), { recursive: true, force: false, errorOnExist: true })
  }
  const copiedNames = new Set(entries.map((e) => e.name))
  const src = walkStats(from, entries)
  const dstEntries = fs.readdirSync(to, { withFileTypes: true }).filter((e) => copiedNames.has(e.name))
  const dst = walkStats(to, dstEntries)
  return { ok: src.files === dst.files && src.bytes === dst.bytes, src, dst }
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
    const sharedTarget = target === dirs.defaults[which] || WHICHES.some(key => key !== which && path.resolve(dirs[key]) === target)
    const existing = fs.readdirSync(target).filter(n => !sharedTarget || !skip(n))
    if (existing.length) return { error: '目标目录不是空的（存在：' + existing.slice(0, 3).join('、') + '），请选择一个空目录' }

    const entries = fs.existsSync(current)
      ? fs.readdirSync(current, { withFileTypes: true }).filter((e) => !skip(e.name))
      : []

    store.flushAll() // 未落盘的先写盘，保证迁移的是最新内容

    // 复制 + 校验：不覆盖、不静默跳过；此阶段原目录仍未动
    let moved
    try {
      moved = await copyAndVerify(current, target, entries)
    } catch (e) {
      return { error: '复制失败（原目录未受影响）：' + e.message }
    }
    if (!moved.ok) {
      return { error: `校验失败（源 ${moved.src.files} 文件/${moved.src.bytes}B，目标 ${moved.dst.files} 文件/${moved.dst.bytes}B），已中止，原目录未受影响` }
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
      files: moved.dst.files,
      bytes: moved.dst.bytes,
      note: isReset ? '已恢复默认目录' : '文件已完整转移，立即生效'
    }
  } catch (e) {
    return { error: '迁移失败（原目录未受影响）：' + e.message }
  } finally {
    busy = false
  }
}

// 一键迁移：三类目录一起搬进 <target>\config|client-mods|data。
// 与 changeDir 共用 busy 锁，两个迁移不能并发（否则会互相搬走对方正在复制的文件）。
export async function changeRoot(targetArg) {
  if (busy) return { error: '正在迁移中，请稍候' }

  const raw = String(targetArg ?? '').trim()
  if (!raw) return { error: '缺少目标文件夹' }
  if (!path.isAbsolute(raw)) return { error: '目标必须是绝对路径：' + raw }
  const target = path.resolve(raw)
  const dirs = getDirs()

  // 目标与三类目录（当前 + 默认）互相包含都不行：否则新布局会嵌在旧布局里，
  // 目标子目录可能正好就是某个源目录，也就无法「先复制、后清空」。
  for (const which of WHICHES) {
    for (const [p, label] of [[dirs[which], LABELS[which]], [dirs.defaults[which], '默认' + LABELS[which]]]) {
      const abs = path.resolve(p)
      if (abs === target) return { error: '目标不能与现有目录相同：' + abs }
      if (isInside(abs, target)) return { error: `目标不能位于${label}内部（${abs}）` }
      if (isInside(target, abs)) return { error: `目标不能包含${label}（${abs}）` }
    }
  }

  busy = true
  let committed = false
  let files = 0
  let bytes = 0
  const plan = []

  // 失败回滚：只清掉本次新建的目录 / 本次复制进去的条目，用户原有文件一律不动
  const rollback = () => {
    if (committed) return
    for (const step of plan) {
      try {
        if (!fs.existsSync(step.dest)) continue
        if (step.created) {
          fs.rmSync(step.dest, { recursive: true, force: true })
          continue
        }
        for (const ent of step.entries) fs.rmSync(path.join(step.dest, ent.name), { recursive: true, force: true })
      } catch {}
    }
  }
  const abandon = (error) => {
    rollback()
    return { error }
  }

  const nextDirs = {
    configDir: path.join(target, ROOT_SUBDIRS.configDir),
    clientModsDir: path.join(target, ROOT_SUBDIRS.clientModsDir),
    dataDir: path.join(target, ROOT_SUBDIRS.dataDir)
  }

  try {
    if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) return { error: '目标不是文件夹：' + target }
    fs.mkdirSync(target, { recursive: true })

    store.flushAll() // 未落盘的先写盘，保证三类迁移的都是最新内容

    // 1) 规划 + 空目录校验：三类目标都检查完再开始复制，避免留下半成品
    for (const which of WHICHES) {
      const from = dirs[which]
      const dest = nextDirs[which]
      const created = !fs.existsSync(dest)
      if (!created && !fs.statSync(dest).isDirectory()) return abandon('目标子目录不是文件夹：' + dest)
      // 归属排除：dev 模式三类目录物理上是同一个 data/，只搬属于本类的条目；
      // 目标里已有的「他类 / 引导」文件不算冲突（本次迁移不会碰它们），与 changeDir 一致。
      const skip = excludesFor(which)
      const shared = WHICHES.some((key) => key !== which && path.resolve(dirs[key]) === path.resolve(dest)) ||
        path.resolve(dirs.defaults[which]) === path.resolve(dest)
      const existing = created ? [] : fs.readdirSync(dest).filter((n) => !shared || !skip(n))
      if (existing.length) {
        return abandon(`目标子目录不是空的（存在：${existing.slice(0, 3).join('、')}）：${dest}，请换一个空文件夹`)
      }
      const entries = fs.existsSync(from)
        ? fs.readdirSync(from, { withFileTypes: true }).filter((e) => !skip(e.name))
        : []
      if (created) fs.mkdirSync(dest, { recursive: true })
      plan.push({ which, from, dest, entries, created })
    }

    // 2) 逐类复制 + 校验：三类全部通过才允许切换（此时原目录仍完整）
    for (const step of plan) {
      let r
      try {
        r = await copyAndVerify(step.from, step.dest, step.entries)
      } catch (e) {
        return abandon('复制失败（原目录未受影响）：' + e.message)
      }
      if (!r.ok) {
        return abandon(`校验失败（${LABELS[step.which]}：源 ${r.src.files} 文件/${r.src.bytes}B，目标 ${r.dst.files} 文件/${r.dst.bytes}B），已中止，原目录未受影响`)
      }
      files += r.dst.files
      bytes += r.dst.bytes
    }

    // 3) 全部校验通过后才切换：applyDirs → 删除旧位置已迁移的条目 → 缓存重写到新目录。
    //    切换失败要先把内存里的路径恢复回旧目录，否则回滚会删掉进程正在使用的副本。
    try {
      applyDirs(nextDirs)
    } catch (e) {
      const prev = {}
      for (const which of WHICHES) prev[which] = dirs[which] === dirs.defaults[which] ? null : dirs[which]
      try { applyDirs(prev) } catch {}
      return abandon('切换目录失败（原目录未受影响）：' + e.message)
    }
    committed = true

    let left = 0
    for (const step of plan) {
      for (const ent of step.entries) {
        try { fs.rmSync(path.join(step.from, ent.name), { recursive: true, force: true }) } catch { left++ }
      }
    }
    store.flushAll()

    return {
      ok: true,
      root: target,
      dirs: nextDirs,
      from: { configDir: dirs.configDir, clientModsDir: dirs.clientModsDir, dataDir: dirs.dataDir },
      files,
      bytes,
      note: left
        ? `目录已切换，但有 ${left} 项旧文件未能删除，可稍后手动清理`
        : '三类目录已迁移到同一文件夹，立即生效'
    }
  } catch (e) {
    if (committed) {
      // 已切换：文件只在新目录，回滚反而会丢数据，只能把收尾失败如实回报
      return {
        ok: true,
        root: target,
        dirs: nextDirs,
        from: { configDir: dirs.configDir, clientModsDir: dirs.clientModsDir, dataDir: dirs.dataDir },
        files,
        bytes,
        note: '目录已切换，但收尾失败：' + e.message
      }
    }
    return abandon('迁移失败（原目录未受影响）：' + e.message)
  } finally {
    busy = false
  }
}

export function resetDir(which) {
  return changeDir(which, null)
}
