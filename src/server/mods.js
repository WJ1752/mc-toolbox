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

const RUNTIME_DEPENDENCIES = new Set([
  'minecraft', 'forge', 'neoforge', 'fabricloader', 'quilt_loader', 'quilt-loader', 'java',
  'minecraftforge', 'mod_minecraftforge', 'forge_loader'
])

function dependency(id, range = '', optional = false) {
  const modid = String(id || '').trim()
  if (!modid || RUNTIME_DEPENDENCIES.has(modid.toLowerCase())) return null
  return { id: modid, range: String(range || '').trim(), required: !optional, optional: !!optional }
}

function addDependency(out, value, defaults = {}) {
  if (typeof value === 'string') {
    let text = value.trim()
    const relation = /^(?:required|required-after|after-required|before-required)\s*:\s*(.+)$/i.exec(text)
    if (relation) text = relation[1]
    // Legacy metadata often stores a comma-separated dependency list in one
    // string. Do not split commas inside Maven ranges such as [1.0,).
    const parts = text.split(/,(?=[A-Za-z0-9_.-]+(?:@|$))/)
    for (const part of parts) {
      const raw = part.trim()
      const at = raw.indexOf('@')
      const id = at >= 0 ? raw.slice(0, at) : raw
      const range = at >= 0 ? raw.slice(at + 1) : defaults.range
      const item = dependency(id, range, defaults.optional)
      if (item) out.push(item)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) addDependency(out, entry, defaults)
    return
  }
  if (!value || typeof value !== 'object') return
  const id = value.modId || value.modid || value.id || value.name
  if (!id) return
  let range = value.versionRange || value.version || value.range || value.version_constraint || defaults.range || ''
  if (typeof range === 'object') range = range.any || range.required || range || ''
  const optional = value.optional === true || value.mandatory === false || defaults.optional === true
  const item = dependency(id, typeof range === 'string' ? range : '', optional)
  if (item) out.push(item)
}

function uniqueDependencies(items) {
  const map = new Map()
  for (const item of items) {
    const key = item.id.toLowerCase()
    const old = map.get(key)
    if (!old || (old.optional && !item.optional)) map.set(key, item)
  }
  return [...map.values()]
}

function parseDependencyMap(value, out, defaults = {}) {
  if (!value || typeof value !== 'object') return
  for (const [id, spec] of Object.entries(value)) {
    if (Array.isArray(spec)) {
      for (const entry of spec) addDependency(out, { id, ...(typeof entry === 'object' ? entry : { version: entry }) }, defaults)
    } else if (typeof spec === 'object') {
      addDependency(out, { id, ...spec }, defaults)
    } else addDependency(out, { id, version: spec }, defaults)
  }
}

function parseFabricMeta(buf) {
  const obj = jsonParseLoose(buf.toString('utf8'))
  if (!obj) return null
  const dependencies = []
  parseDependencyMap(obj.depends, dependencies)
  parseDependencyMap(obj.recommends, dependencies, { optional: true })
  parseDependencyMap(obj.suggests, dependencies, { optional: true })
  return {
    modid: obj.id || null,
    name: obj.name || obj.id || null,
    version: obj.version || null,
    loader: 'fabric',
    environment: obj.environment || (obj.entrypoints && obj.entrypoints.client ? 'client' : '*'),
    dependencies: uniqueDependencies(dependencies)
  }
}

function parseQuiltMeta(buf) {
  const obj = jsonParseLoose(buf.toString('utf8'))
  if (!obj) return null
  const ql = obj.quilt_loader || {}
  const id = typeof ql.id === 'string' ? ql.id : ql.id?.id || null
  const meta = ql.metadata || {}
  const dependencies = []
  const qdeps = ql.depends || ql.dependencies || []
  if (Array.isArray(qdeps)) {
    for (const item of qdeps) {
      if (typeof item === 'string') addDependency(dependencies, item)
      else if (item && typeof item === 'object') {
        const id = item.id || item.modId || item.name
        const version = item.version || item.versionRange || item.range
        addDependency(dependencies, { id, version, optional: item.optional === true })
      }
    }
  } else parseDependencyMap(qdeps, dependencies)
  return {
    modid: id,
    name: meta.name || id,
    version: ql.version || null,
    loader: 'quilt',
    environment: obj.minecraft?.environment || '*',
    dependencies: uniqueDependencies(dependencies)
  }
}

function parseModsToml(buf) {
  const text = buf.toString('utf8')
  const modId = /^\s*modId\s*=\s*["']([^"']+)["']/m.exec(text)
  const displayName = /^\s*displayName\s*=\s*["']([^"']+)["']/m.exec(text)
  const version = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(text)
  if (!modId) return null
  const isNeo = /neoforge/i.test(text) || / NeoForge/i.test(text)
  const dependencies = []
  // Forge/NeoForge use repeated [[dependencies.<modid>]] blocks. Parsing the
  // blocks instead of the whole file also handles multiple mods in one jar.
  const blocks = [...text.matchAll(/\[\[dependencies\.[^\]]+\]\]([\s\S]*?)(?=\n\s*\[\[|$)/gi)]
  for (const match of blocks) {
    const block = match[1]
    const id = /^\s*modId\s*=\s*["']([^"']+)["']/im.exec(block)?.[1]
    if (!id) continue
    const range = /^\s*versionRange\s*=\s*["']([^"']*)["']/im.exec(block)?.[1] || ''
    const mandatory = /^\s*mandatory\s*=\s*(true|false)/im.exec(block)?.[1]
    addDependency(dependencies, { id, versionRange: range, mandatory: mandatory !== 'false' })
  }
  return {
    modid: modId[1],
    name: displayName ? displayName[1] : modId[1],
    version: version ? version[1].replace(/\$\{[^}]+\}/g, '') : null,
    loader: isNeo ? 'neoforge' : 'forge',
    environment: '*',
    dependencies: uniqueDependencies(dependencies)
  }
}

function parseMcmodInfo(buf) {
  const obj = jsonParseLoose(buf.toString('utf8'))
  if (!obj) return null
  const entries = Array.isArray(obj) ? obj : obj.modList ? obj.modList : [obj]
  const first = entries.find((item) => item && (item.modid || item.modId))
  if (!first) return null
  const dependencies = []
  // In legacy mcmod.info, `dependencies` is primarily an ordering list
  // (Forge calls it After). `requiredMods` is the hard requirement list;
  // annotation metadata is merged below for mods that declare required-after.
  for (const item of entries) {
    addDependency(dependencies, item?.dependencies, { optional: true })
    addDependency(dependencies, item?.requiredMods)
    addDependency(dependencies, item?.requiredmods)
  }
  // A few 1.7–1.12 mods put dependency declarations in a keyed object.
  for (const item of entries) {
    if (!Array.isArray(item?.dependencies)) parseDependencyMap(item?.dependencies, dependencies, { optional: true })
    if (!Array.isArray(item?.requiredMods)) parseDependencyMap(item?.requiredMods, dependencies)
  }
  return {
    modid: first.modid || null,
    name: first.name || first.modid || null,
    version: first.version || null,
    loader: 'legacy-forge',
    environment: '*',
    modids: entries.map((item) => item?.modid || item?.modId).filter(Boolean),
    dependencies: uniqueDependencies(dependencies)
  }
}

export async function readForgeAnnotationInfo(filePath) {
  const entries = await readJarEntries(filePath, ['*.class'], { maxBytes: 8 * 1024 * 1024, maxEntries: 256 })
  const dependencies = []
  let modid = null
  let version = null
  for (const buf of Object.values(entries)) {
    if (!buf) continue
    // Forge 1.7–1.12 stores @Mod(dependencies = "required-after:foo")
    // in the class constant pool rather than mcmod.info. Class bytes are
    // safe to inspect as latin1 because annotation values are ASCII IDs.
    const text = buf.toString('latin1')
    const isForgeModClass = /net\/minecraftforge\/fml\/common\/Mod;/.test(text)
    if (!isForgeModClass) continue
    if (!modid) modid = /modid[\u0000-\u001f]{1,4}([A-Za-z][A-Za-z0-9_.-]{1,63})/i.exec(text)?.[1] || null
    if (!version) version = /version[\u0000-\u001f]{1,4}([A-Za-z0-9][A-Za-z0-9_.+\-]{1,63})/i.exec(text)?.[1] || null
    const re = /(?:^|[\u0000;,)])[-_\s]*(required|required-after|after-required|before-required)\s*:\s*([A-Za-z0-9_.-]+)(?:@([^;\u0000\x01]+))?/gi
    for (const match of text.matchAll(re)) addDependency(dependencies, { id: match[2], versionRange: match[3] || '' })
  }
  return { modid, version, dependencies: uniqueDependencies(dependencies) }
}

export async function readModMeta(filePath) {
  const entries = await readJarEntries(filePath, META_FILES)
  for (const [file, buf] of Object.entries(entries)) {
    if (!buf) continue
    try {
      if (file === 'fabric.mod.json') return parseFabricMeta(buf)
      if (file === 'quilt.mod.json') return parseQuiltMeta(buf)
      if (file.endsWith('mods.toml')) return parseModsToml(buf)
      if (file === 'mcmod.info') {
        const meta = parseMcmodInfo(buf)
        if (meta) {
          const info = await readForgeAnnotationInfo(filePath)
          meta.dependencies = uniqueDependencies([...(meta.dependencies || []), ...info.dependencies])
          if (info.modid) {
            meta.modid = info.modid
            meta.modids = [...new Set([...(meta.modids || []), info.modid])]
          }
          if (info.version && (!meta.version || meta.version === '0.0.1' || meta.modid === info.modid)) meta.version = info.version
          return meta
        }
      }
    } catch {
      /* 继续尝试下一个 */
    }
  }
  const info = await readForgeAnnotationInfo(filePath).catch(() => ({ modid: null, version: null, dependencies: [] }))
  return info.dependencies.length || info.modid
    ? { modid: info.modid, modids: info.modid ? [info.modid] : [], name: path.basename(filePath).replace(/\.jar(?:\.disabled)?$/i, ''), version: info.version, loader: 'legacy-forge', environment: '*', dependencies: info.dependencies }
    : null
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
      const stem = it.name.replace(/\.jar(?:\.disabled)?$/i, '')
      const filenameModIds = [...new Set([
        stem,
        stem.split(/[-_ ](?=\d|mc\d|v?\d)/i)[0]
      ].filter((value) => /^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(value)).map((value) => value.toLowerCase()))]
      results.push({
        file: it.name,
        path: full,
        relPath: path.relative(dir, full),
        size: st ? st.size : 0,
        mtime: st ? st.mtimeMs : 0,
        disabled: isDisabled,
        modid: meta?.modid || null,
        modids: [...new Set([...(meta?.modids || (meta?.modid ? [meta.modid] : [])), ...filenameModIds])],
        name: meta?.name || it.name.replace(/\.jar(\.disabled)?$/i, ''),
        version: meta?.version || null,
        loader: meta?.loader || null,
        environment: meta?.environment || '*',
        dependencies: meta?.dependencies || [],
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
