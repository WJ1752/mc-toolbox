import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { readJarEntries } from './zip.js'

const META_FILES = [
  'fabric.mod.json',
  'quilt.mod.json',
  'META-INF/mods.toml',
  'META-INF/neoforge.mods.toml',
  'mcmod.info'
]

function jsonParseLoose(text) {
  try {
    return JSON.parse(text)
  } catch {
    // mcmod.info / mods.toml 有时带 BOM 或注释
    const cleaned = text.replace(/^\uFEFF/, '')
    const start = cleaned.search(/[[{]/)
    if (start > 0) {
      try {
        return JSON.parse(cleaned.slice(start))
      } catch {
        /* fallthrough */
      }
    }
    return null
  }
}

function parseFabricMeta(buf) {
  const obj = jsonParseLoose(buf.toString('utf8'))
  if (!obj) return null
  return {
    modid: obj.id || null,
    name: obj.name || obj.id || null,
    version: obj.version || null,
    loader: 'fabric',
    environment: obj.environment || (obj.entrypoints && obj.entrypoints.client ? 'client' : '*')
  }
}

function parseQuiltMeta(buf) {
  const obj = jsonParseLoose(buf.toString('utf8'))
  if (!obj) return null
  const ql = obj.quilt_loader || {}
  const id = typeof ql.id === 'string' ? ql.id : ql.id?.id || null
  const meta = ql.metadata || {}
  return {
    modid: id,
    name: meta.name || id,
    version: ql.version || null,
    loader: 'quilt',
    environment: obj.minecraft?.environment || '*'
  }
}

function parseModsToml(buf) {
  const text = buf.toString('utf8')
  const modId = /^\s*modId\s*=\s*["']([^"']+)["']/m.exec(text)
  const displayName = /^\s*displayName\s*=\s*["']([^"']+)["']/m.exec(text)
  const version = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(text)
  if (!modId) return null
  const isNeo = /neoforge/i.test(text) || / NeoForge/i.test(text)
  return {
    modid: modId[1],
    name: displayName ? displayName[1] : modId[1],
    version: version ? version[1].replace(/\$\{[^}]+\}/g, '') : null,
    loader: isNeo ? 'neoforge' : 'forge',
    environment: '*'
  }
}

function parseMcmodInfo(buf) {
  const obj = jsonParseLoose(buf.toString('utf8'))
  if (!obj) return null
  const first = Array.isArray(obj) ? obj[0] : obj.modList ? obj.modList[0] : obj
  if (!first) return null
  return {
    modid: first.modid || null,
    name: first.name || first.modid || null,
    version: first.version || null,
    loader: 'legacy-forge',
    environment: '*'
  }
}

export async function readModMeta(filePath) {
  const entries = await readJarEntries(filePath, META_FILES)
  for (const [file, buf] of Object.entries(entries)) {
    if (!buf) continue
    try {
      if (file === 'fabric.mod.json') return parseFabricMeta(buf)
      if (file === 'quilt.mod.json') return parseQuiltMeta(buf)
      if (file.endsWith('mods.toml')) return parseModsToml(buf)
      if (file === 'mcmod.info') return parseMcmodInfo(buf)
    } catch {
      /* 继续尝试下一个 */
    }
  }
  return null
}

export async function scanModsDir(dir, opts = {}) {
  const { recursive = true, includeDisabled = true } = opts
  // 整合包常把实例、.minecraft、mods 和分类子目录层层嵌套。
  // 保留上限避免误选用户目录时无限遍历，但默认深度足够覆盖常见启动器结构。
  const requestedDepth = Number(opts.maxDepth)
  const maxDepth = Number.isFinite(requestedDepth) ? Math.max(0, Math.min(64, requestedDepth)) : 24
  if (!dir || !fs.existsSync(dir)) throw new Error('目录不存在：' + dir)
  const stat = await fsp.stat(dir)
  if (!stat.isDirectory()) throw new Error('不是目录：' + dir)

  const results = []
  const walk = async (current, depth) => {
    const items = await fsp.readdir(current, { withFileTypes: true })
    for (const it of items) {
      opts.signal?.throwIfAborted()
      const full = path.join(current, it.name)
      if (it.isDirectory()) {
        const ignoredDir = it.name === '.git' || it.name === '.mc-i18n' || it.name === 'node_modules' || it.name.startsWith('$')
        if (recursive && depth < maxDepth && !ignoredDir) {
          await walk(full, depth + 1).catch(e => { if (opts.signal?.aborted) throw e })
        }
        continue
      }
      const lower = it.name.toLowerCase()
      const isJar = lower.endsWith('.jar')
      const isDisabled = lower.endsWith('.jar.disabled')
      if (!isJar && !(includeDisabled && isDisabled)) continue

      const st = await fsp.stat(full).catch(() => null)
      const meta = await readModMeta(full).catch(() => null)
      results.push({
        file: it.name,
        path: full,
        relPath: path.relative(dir, full),
        size: st ? st.size : 0,
        mtime: st ? st.mtimeMs : 0,
        disabled: isDisabled,
        modid: meta?.modid || null,
        name: meta?.name || it.name.replace(/\.jar(\.disabled)?$/i, ''),
        version: meta?.version || null,
        loader: meta?.loader || null,
        environment: meta?.environment || '*',
        hasMeta: !!meta
      })
    }
  }
  await walk(dir, 0)
  results.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return results
}

export function defaultBackupDir(modsDir) {
  return path.join(path.dirname(modsDir || os.homedir()), 'client-mods-backup')
}

export async function moveModsToBackup(files, backupDir) {
  await fsp.mkdir(backupDir, { recursive: true })
  const done = []
  const failed = []
  for (const f of files) {
    try {
      const dest = path.join(backupDir, path.basename(f))
      let finalDest = dest
      let i = 1
      while (fs.existsSync(finalDest)) finalDest = dest.replace(/(\.jar(\.disabled)?)$/i, `.${i++}$1`)
      await fsp.rename(f, finalDest)
      done.push({ from: f, to: finalDest })
    } catch (e) {
      failed.push({ file: f, error: e.message })
    }
  }
  return { done, failed }
}

export async function deleteMods(files) {
  const done = []
  const failed = []
  for (const f of files) {
    try {
      await fsp.unlink(f)
      done.push({ from: f })
    } catch (e) {
      failed.push({ file: f, error: e.message })
    }
  }
  return { done, failed }
}

/** 禁用：把 xxx.jar 改名为 xxx.jar.disabled（可逆） */
export async function disableMods(files) {
  const done = []
  const failed = []
  for (const f of files) {
    try {
      if (/\.jar\.disabled$/i.test(f)) {
        failed.push({ file: f, error: '已经是禁用状态' })
        continue
      }
      if (!fs.existsSync(f)) {
        failed.push({ file: f, error: '文件不存在' })
        continue
      }
      const base = f.replace(/\.jar$/i, '')
      let dest = base + '.jar.disabled'
      let i = 1
      while (fs.existsSync(dest)) dest = `${base}.${i++}.jar.disabled`
      await fsp.rename(f, dest)
      done.push({ from: f, to: dest })
    } catch (e) {
      failed.push({ file: f, error: e.message })
    }
  }
  return { done, failed }
}

/** 启用：把 xxx.jar.disabled 改回 xxx.jar */
export async function enableMods(files) {
  const done = []
  const failed = []
  for (const f of files) {
    try {
      const m = /^(.*)\.jar\.disabled$/i.exec(f)
      if (!m) {
        failed.push({ file: f, error: '不是被禁用的文件' })
        continue
      }
      if (!fs.existsSync(f)) {
        failed.push({ file: f, error: '文件不存在' })
        continue
      }
      let dest = m[1] + '.jar'
      let i = 1
      while (fs.existsSync(dest)) dest = `${m[1]}.${i++}.jar`
      await fsp.rename(f, dest)
      done.push({ from: f, to: dest })
    } catch (e) {
      failed.push({ file: f, error: e.message })
    }
  }
  return { done, failed }
}

export async function restoreMods(files) {
  const done = []
  const failed = []
  for (const f of files) {
    try {
      const original = path.basename(f)
      // 备份目录与 mods 目录同级推断：由调用方传入目标目录
      done.push({ from: f, name: original })
    } catch (e) {
      failed.push({ file: f, error: e.message })
    }
  }
  return { done, failed }
}

// 目录浏览（给前端做路径选择器）
export async function listDir(dir, exts) {
  const target = dir && dir.trim() ? dir.trim() : os.homedir()
  if (!fs.existsSync(target)) throw new Error('目录不存在：' + target)
  const st = await fsp.stat(target)
  if (!st.isDirectory()) throw new Error('不是目录：' + target)
  const items = await fsp.readdir(target, { withFileTypes: true })
  const dirs = items
    .filter((i) => i.isDirectory() && !i.name.startsWith('$') && i.name !== 'System Volume Information')
    .map((i) => ({ name: i.name, path: path.join(target, i.name), type: 'dir' }))
    .sort((a, b) => a.name.localeCompare(b.name))
  // 默认只列 jar；传入 exts 时按扩展名过滤（如 bat,sh,cmd 供脚本选择器使用）
  const allowExt = Array.isArray(exts) && exts.length
    ? exts.map((e) => String(e).toLowerCase().replace(/^\./, ''))
    : ['jar', 'jar.disabled']
  const matchExt = (name) => {
    const lower = name.toLowerCase()
    return allowExt.some((e) => lower === e || lower.endsWith('.' + e))
  }
  const files = items
    .filter((i) => i.isFile() && matchExt(i.name))
    .map((i) => ({ name: i.name, path: path.join(target, i.name), type: 'file' }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const parent = path.dirname(target)
  return {
    path: target,
    parent: parent !== target ? parent : null,
    dirs: dirs.slice(0, 500),
    files: files.slice(0, 200)
  }
}

export function guessModsDirs() {
  const home = os.homedir()
  const out = []
  const candidates = [
    path.join(home, 'AppData', 'Roaming', '.minecraft', 'mods'),
    path.join(home, '.minecraft', 'mods'),
    path.join(home, 'curseforge', 'minecraft', 'Instances'),
    path.join(home, 'Documents', 'Curseforge', 'Minecraft', 'Instances'),
    path.join(process.cwd(), 'mods')
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) out.push(c)
  }
  return out
}
