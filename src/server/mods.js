import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { readJarEntries } from './zip.js'
import { classAnnotations } from './class-annotations.js'
import { DATA_DIR } from './paths.js'

const META_FILES = [
  'fabric.mod.json',
  'quilt.mod.json',
  'META-INF/mods.toml',
  'META-INF/neoforge.mods.toml',
  'mcmod.info'
]
// 一次打开 jar 需要读取的固定条目：元数据、Manifest 与 jar-in-jar 清单。
// 过去 readModMeta 先读元数据、再读 Manifest/内嵌清单，每个模组要解析两遍
// ZIP 中央目录；模组一多（300+）光是重复索引就要好几秒。
const TOP_LEVEL_FILES = [
  ...META_FILES,
  'META-INF/MANIFEST.MF',
  'META-INF/jarjar/metadata.json',
  'META-INF/jars/metadata.json',
  'META-INF/services/cpw.mods.modlauncher.api.ITransformationService'
]
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i
const META_CACHE_LIMIT = 5000
const META_CACHE_VERSION = 2

/** 模组图标字段可能是字符串，也可能是 Fabric 的 { small, large } 对象。 */
function iconPathOf(value) {
  let raw = ''
  if (typeof value === 'string') raw = value
  else if (value && typeof value === 'object') raw = value.large || value.small || value.icon || ''
  const text = String(raw || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  if (!text || text.includes('..') || /^[a-z][a-z0-9+.-]*:/i.test(text) || !IMAGE_EXT.test(text)) return ''
  return text
}

/** 文件名/元数据缓存键：内容没变就不重新解压 JAR。 */
function metaCacheKey(filePath, stat, runtime = {}) {
  const rt = `${runtime.mc || ''}|${runtime.loader || ''}|${runtime.loaderVersion || ''}`
  return `${process.platform === 'win32' ? path.resolve(filePath).toLowerCase() : path.resolve(filePath)}|${stat.size}|${stat.mtimeMs}|${rt}`
}

const metaCache = new Map()
let diskMeta = null
let diskMetaPath = ''
let diskMetaTimer = null

function metaCacheFile() {
  return path.join(DATA_DIR, 'cache', 'mod-meta-v2.json')
}

/** 磁盘缓存让启动器重启后也不必重新解压 300+ 个 JAR，键里带大小/mtime。 */
function loadDiskMeta() {
  const file = metaCacheFile()
  if (diskMeta && diskMetaPath === file) return diskMeta
  diskMetaPath = file
  diskMeta = new Map()
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw?.version !== META_CACHE_VERSION) return diskMeta
    for (const [key, value] of Object.entries(raw.items || {})) {
      if (value && typeof value === 'object') diskMeta.set(key, value)
    }
  } catch { /* 第一次运行 / 缓存损坏 */ }
  return diskMeta
}

function scheduleDiskMetaSave() {
  if (diskMetaTimer) return
  diskMetaTimer = setTimeout(() => {
    diskMetaTimer = null
    const map = diskMeta || new Map()
    // 只保留最近使用的条目，避免临时目录 / 测试路径无限堆积。
    const entries = [...map.entries()].slice(-META_CACHE_LIMIT)
    const items = Object.fromEntries(entries)
    const file = diskMetaPath || metaCacheFile()
    fsp.mkdir(path.dirname(file), { recursive: true })
      .then(() => fsp.writeFile(file + '.tmp', JSON.stringify({ version: META_CACHE_VERSION, items }), 'utf8'))
      .then(() => fsp.rename(file + '.tmp', file))
      .catch(() => {})
  }, 1500)
  diskMetaTimer.unref?.()
}

export function clearModMetaCache() {
  metaCache.clear()
  diskMeta = null
  diskMetaPath = ''
  if (diskMetaTimer) clearTimeout(diskMetaTimer)
  diskMetaTimer = null
}

function cacheMeta(key, meta) {
  if (metaCache.size >= META_CACHE_LIMIT) {
    // Map 按插入顺序迭代：删掉最早的一批，保留最近扫描过的模组。
    let drop = Math.max(1, Math.floor(META_CACHE_LIMIT / 10))
    for (const old of metaCache.keys()) {
      metaCache.delete(old)
      if (--drop <= 0) break
    }
  }
  metaCache.set(key, meta)
  if (meta) {
    const disk = loadDiskMeta()
    disk.set(key, meta)
    scheduleDiskMetaSave()
  }
  return meta
}

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
  'minecraftforge', 'mod_minecraftforge', 'forge_loader', 'fml'
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
    environment: obj.environment || '*',
    icon: iconPathOf(obj.icon),
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
    icon: iconPathOf(meta.icon || ql.icon || obj.icon),
    dependencies: uniqueDependencies(dependencies)
  }
}

/** 读取 TOML 的单行字符串值；双引号值里允许出现单引号（Xaero's Minimap）。 */
function tomlString(block, key) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'im')
  const match = re.exec(block)
  return match ? (match[1] ?? match[2] ?? '') : ''
}

function parseModsToml(buf, { neo = false } = {}) {
  const text = buf.toString('utf8')
  // 不能从正文里找 “neoforge”：很多 Forge 模组的描述会写 “NeoForge port”。
  // 加载器只由文件名决定（META-INF/neoforge.mods.toml）。
  const isNeo = neo === true
  // 只从 [[mods]] 块里取 modid：TOML 允许 [[dependencies.*]] 排在 [[mods]] 之前，
  // 直接全文找第一个 modId 会把依赖 ID 当成宿主 modid，依赖它的模组全部误报缺失。
  const modBlocks = [...text.matchAll(/\[\[mods\]\]([\s\S]*?)(?=\n\s*\[\[|$)/gi)]
  const mods = []
  for (const match of modBlocks) {
    const block = match[1]
    const id = tomlString(block, 'modId')
    if (!id) continue
    mods.push({
      modid: id,
      name: tomlString(block, 'displayName') || id,
      version: tomlString(block, 'version').replace(/\$\{[^}]+\}/g, ''),
      logo: tomlString(block, 'logoFile')
    })
  }
  if (!mods.length) return null
  const dependencies = []
  // Forge/NeoForge 用重复的 [[dependencies.<modid>]] 块；type / side 必须一起解析，
  // 否则 optional、incompatible、仅客户端依赖都会被当成「必需依赖」。
  // 只接受属于本 jar 已声明 modId 的依赖块：有些 jar 会留下 [[dependencies.子模块]]
  // 却并没有对应的 [[mods]]，把这类块算到宿主头上会造成「xaerolib 缺失」这类误报。
  const owners = new Set(mods.map((item) => String(item.modid).toLowerCase()))
  const blocks = [...text.matchAll(/\[\[dependencies\.([^\]]+)\]\]([\s\S]*?)(?=\n\s*\[\[|$)/gi)]
  for (const match of blocks) {
    const owner = String(match[1] || '').trim().replace(/^["']|["']$/g, '').toLowerCase()
    if (owner && owners.size && !owners.has(owner)) continue
    const block = match[2]
    const id = /^\s*modId\s*=\s*["']([^"']+)["']/im.exec(block)?.[1]
    if (!id) continue
    const range = /^\s*versionRange\s*=\s*["']([^"']*)["']/im.exec(block)?.[1] || ''
    const mandatory = /^\s*mandatory\s*=\s*(true|false)/im.exec(block)?.[1]
    const type = (/^\s*type\s*=\s*["']([^"']+)["']/im.exec(block)?.[1] || '').toLowerCase()
    const side = (/^\s*side\s*=\s*["']([^"']+)["']/im.exec(block)?.[1] || '').toUpperCase()
    // incompatible 的语义是「装了才冲突」，未安装才是正确状态，不能要求存在。
    if (type === 'incompatible' || type === 'discouraged') continue
    const optional = type === 'optional' || mandatory === 'false' || side === 'CLIENT'
    addDependency(dependencies, { id, versionRange: range, mandatory: !optional })
  }
  return {
    modid: mods[0].modid,
    modids: mods.map((item) => item.modid),
    name: mods[0].name,
    version: mods[0].version || null,
    loader: isNeo ? 'neoforge' : 'forge',
    environment: '*',
    icon: iconPathOf(mods.find((item) => item.logo)?.logo || ''),
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
    icon: iconPathOf(first.logoFile || first.logo || ''),
    modids: entries.map((item) => item?.modid || item?.modId).filter(Boolean),
    dependencies: uniqueDependencies(dependencies)
  }
}

export async function readForgeAnnotationInfo(filePath) {
  const entries = await readJarEntries(filePath, ['*.class'], { maxBytes: 64 * 1024 * 1024, maxEntries: 30000 })
  const dependencies = [], mods = []
  for (const buf of Object.values(entries)) {
    if (!buf || (!buf.includes(Buffer.from('net/minecraftforge/fml/common/Mod;')) && !buf.includes(Buffer.from('net/minecraftforge/fml/relauncher/IFMLLoadingPlugin')))) continue
    let annotations
    try { annotations = classAnnotations(buf) } catch { continue }
    if (buf.includes(Buffer.from('net/minecraftforge/fml/relauncher/IFMLLoadingPlugin')) && annotations.constants.MOD_ID) mods.push({ modid: annotations.constants.MOD_ID, version: annotations.constants.VERSION || null })
    for (const annotation of annotations) {
      if (annotation.type !== 'Lnet/minecraftforge/fml/common/Mod;') continue
      const info = annotation.values
      if (info.modid) mods.push(info)
      for (const rule of String(info.dependencies || '').split(';')) {
        const match = /^(required-after|required-before|required):([^@]+)(?:@(.+))?$/.exec(rule.trim())
        if (match) addDependency(dependencies, { id: match[2], versionRange: match[3] || '' })
      }
    }
  }
  return { mods, modid: mods[0]?.modid || null, modids: mods.map(m => m.modid), version: mods[0]?.version || null, environment: mods.length && mods.every(m => m.clientSideOnly === 1) ? 'client' : '*', dependencies: uniqueDependencies(dependencies) }
}

function metaRank(file, runtime = {}) {
  const loader = String(runtime.loader || '').toLowerCase()
  const forgeLike = loader === 'forge' || loader === 'neoforge' || loader === 'cleanroom'
  const fabricLike = loader === 'fabric' || loader === 'quilt' || loader === 'legacy-fabric'
  if (runtime.mc === '1.12.2') {
    if (file === 'mcmod.info') return 0
    if (file.endsWith('mods.toml')) return 1
    if (file === 'fabric.mod.json') return 3
    if (file === 'quilt.mod.json') return 4
    return 9
  }
  if (loader === 'neoforge') {
    if (file === 'META-INF/neoforge.mods.toml') return 0
    if (file === 'META-INF/mods.toml') return 1
    if (file === 'mcmod.info') return 2
    if (file === 'fabric.mod.json') return 5
    if (file === 'quilt.mod.json') return 6
    return 9
  }
  if (forgeLike) {
    if (file === 'META-INF/mods.toml') return 0
    if (file === 'META-INF/neoforge.mods.toml') return 1
    if (file === 'mcmod.info') return 2
    if (file === 'fabric.mod.json') return 5
    if (file === 'quilt.mod.json') return 6
    return 9
  }
  if (fabricLike) {
    if (file === 'fabric.mod.json') return 0
    if (file === 'quilt.mod.json') return 1
    if (file.endsWith('mods.toml')) return 5
    if (file === 'mcmod.info') return 6
    return 9
  }
  // 加载器未知时保持旧行为（Fabric 元数据优先），避免改变客户端模组库扫描结果。
  if (file === 'fabric.mod.json') return 0
  if (file === 'quilt.mod.json') return 1
  if (file === 'META-INF/neoforge.mods.toml') return 2
  if (file === 'META-INF/mods.toml') return 3
  if (file === 'mcmod.info') return 4
  return 9
}

async function readPrimaryModMeta(filePath, runtime = {}, prepared = null) {
  // readModMeta 已经为 MANIFEST / 内嵌清单打开过同一个 jar 一次，这里复用
  // 已读到的条目，避免每个模组重复解析 ZIP 中央目录。
  const entries = prepared || await readJarEntries(filePath, META_FILES)
  // 同一个 jar 可能同时带 fabric.mod.json 与 META-INF/mods.toml（多加载器构建）。
  // 必须按当前实例的加载器选元数据；Forge 实例读 Fabric 的 depends 会凭空
  // 产生 fabric-api / fabric-lifecycle-events 等假依赖。
  const ordered = META_FILES
    .map((name) => [name, entries[name]])
    .sort(([a], [b]) => metaRank(a, runtime) - metaRank(b, runtime))
  for (const [file, buf] of ordered) {
    if (!buf) continue
    try {
      if (file === 'fabric.mod.json') return parseFabricMeta(buf)
      if (file === 'quilt.mod.json') return parseQuiltMeta(buf)
      if (file.endsWith('mods.toml')) return parseModsToml(buf, { neo: file === 'META-INF/neoforge.mods.toml' })
      if (file === 'mcmod.info') {
        const meta = parseMcmodInfo(buf)
        if (meta) {
          const info = await readForgeAnnotationInfo(filePath)
          meta.environment = info.environment
          meta.dependencies = uniqueDependencies([...(meta.dependencies || []), ...info.dependencies])
          if (info.modid) {
            const matched = info.mods.find(m => m.modid === meta.modid) || info.mods[0]
            meta.modid = matched.modid
            meta.modids = [...new Set([...(meta.modids || []), ...info.modids])]
            if (matched.version) meta.version = matched.version
            meta.providedVersions = Object.fromEntries(info.mods.filter(m => m.version).map(m => [m.modid.toLowerCase(), m.version]))
          }
          return meta
        }
      }
    } catch {
      /* 继续尝试下一个 */
    }
  }
  const info = await readForgeAnnotationInfo(filePath).catch(() => ({ modid: null, version: null, dependencies: [] }))
  return info.dependencies.length || info.modid
    ? { modid: info.modid, modids: info.modids || [], name: path.basename(filePath).replace(/\.jar(?:\.disabled)?$/i, ''), version: info.version, loader: 'legacy-forge', environment: info.environment, dependencies: info.dependencies }
    : null
}

export async function readModMeta(filePath, runtime = {}, depth = 0) {
  // 一次读取元数据 + MANIFEST + 内嵌清单；后续解析都复用这份 entries。
  const entries = await readJarEntries(filePath, TOP_LEVEL_FILES)
  let meta = await readPrimaryModMeta(filePath, runtime, entries)
  if (depth >= 3) return meta
  // 有些 fat jar（如 kotlinforforge-*-all.jar）本身没有 mods.toml，真正声明
  // modId 的是 META-INF/jarjar/ 下的子 jar；不能因为没有主元数据就跳过内嵌扫描。
  const synthetic = !meta
  if (!meta) {
    meta = {
      modid: null,
      name: path.basename(filePath).replace(/\.jar(?:\.disabled)?$/i, ''),
      version: null,
      loader: null,
      environment: '*',
      dependencies: [],
      modids: [],
      nestedModIds: [],
      providedVersions: {}
    }
  }
  const manifest = entries['META-INF/MANIFEST.MF']?.toString().replace(/\r?\n /g, '') || ''
  const loaderHints = []
  if (/^FMLCorePlugin:/im.test(manifest) || /^TweakClass:/im.test(manifest) || /^ContainedDeps:/im.test(manifest) || /^FMLModType:/im.test(manifest)) loaderHints.push('forge')
  if (entries['META-INF/services/cpw.mods.modlauncher.api.ITransformationService']) {
    loaderHints.push('forge', 'neoforge')
  }
  if (loaderHints.length) meta.loaderHints = [...new Set([...(meta.loaderHints || []), ...loaderHints])]
  const nested = []
  const addNested = (value) => {
    const text = String(value || '').trim()
      .replace(/^["']|["']$/g, '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
    if (text) nested.push(text)
  }
  for (const value of (/^ContainedDeps:\s*(.+)$/im.exec(manifest)?.[1] || '').trim().split(/\s+/)) addNested(value)
  for (const f of ['fabric.mod.json', 'quilt.mod.json']) {
    const json = entries[f] && jsonParseLoose(entries[f].toString())
    for (const item of json?.jars || json?.quilt_loader?.jars || []) addNested(typeof item === 'string' ? item : item?.file)
  }
  // Forge 1.17+ / NeoForge 的 jar-in-jar 清单：META-INF/jarjar/metadata.json。
  // 旧实现只读 MANIFEST + Fabric/Quilt 元数据，XaeroLib / PuzzlesAccessAPI /
  // MixinExtras 这类内嵌前置会被当成「缺少依赖」。
  for (const f of ['META-INF/jarjar/metadata.json', 'META-INF/jars/metadata.json']) {
    const json = entries[f] && jsonParseLoose(entries[f].toString())
    for (const item of json?.jars || []) addNested(item?.path || item?.file)
  }
  // 元数据缺失的旧 jar 也把标准内嵌目录扫一遍，避免漏掉实际存在的 jar。
  addNested('META-INF/jarjar/*.jar')
  addNested('META-INF/jars/*.jar')
  const nestedPaths = [...new Set(nested)]
  if (!nestedPaths.length) return meta
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-nested-'))
  try {
    const jars = await readJarEntries(filePath, nestedPaths, { maxBytes: 64 * 1024 * 1024, maxEntries: 64 })
    const nestedJars = Object.values(jars).filter(Boolean)
    if (!nestedJars.length) return synthetic ? null : meta
    meta.nestedModIds = [...new Set([
      ...(meta.nestedModIds || []),
      ...(meta.modids || []),
      ...(meta.modid ? [meta.modid] : [])
    ].filter(Boolean))]
    let i = 0
    for (const bytes of nestedJars) {
      const file = path.join(tmp, `${i++}.jar`); await fsp.writeFile(file, bytes)
      const child = await readModMeta(file, runtime, depth + 1)
      if (!child) continue
      if (!meta.modid && child.modid) {
        // fat jar 外壳没有自己的 modId：用真正声明依赖的子模组作为宿主信息。
        meta.modid = child.modid
        meta.name = child.name || meta.name
        meta.version = child.version || meta.version
        meta.loader = child.loader || meta.loader
        meta.environment = child.environment || meta.environment
      }
      const childVisibleIds = [
        ...(child.modids || []),
        ...(child.modid ? [child.modid] : [])
      ].filter(Boolean)
      // 嵌套模块的 ID 全部算作「已被这个 jar 提供」，包括客户端模块；否则
      // 客户端整合包里 lambdynlights_api / spruceui / xaerolib 会被误报缺失。
      meta.nestedModIds = [...new Set([...meta.nestedModIds, ...childVisibleIds, ...(child.nestedModIds || [])])]
      // 纯客户端的嵌套模块不能把宿主拖下水：不把它的 modid 并进服务端转换
      // 使用的 modids，也不把它的客户端依赖强加给服务端转换。
      if (child.environment === 'client') continue
      meta.modids = [...new Set([...(meta.modids || []), ...(meta.modid ? [meta.modid] : []), ...childVisibleIds].filter(Boolean))]
      meta.dependencies = uniqueDependencies([...meta.dependencies, ...child.dependencies])
      meta.providedVersions = { ...meta.providedVersions, [child.modid?.toLowerCase()]: child.version, ...child.providedVersions }
    }
  } finally { await fsp.rm(tmp, { recursive: true, force: true }) }
  if (!meta.modid && !(meta.modids || []).length && !(meta.nestedModIds || []).length) return null
  return meta
}

async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [...items]
  const out = new Array(list.length)
  let next = 0
  const width = Math.max(1, Math.min(list.length || 1, Number(limit) || 1))
  const run = async () => {
    for (;;) {
      const index = next++
      if (index >= list.length) return
      out[index] = await worker(list[index], index)
    }
  }
  await Promise.all(Array.from({ length: width }, run))
  return out
}

export async function scanModsDir(dir, opts = {}) {
  const { recursive = true, includeDisabled = true } = opts
  // 整合包常把实例、.minecraft、mods 和分类子目录层层嵌套。
  // 保留上限避免误选用户目录时无限遍历，但默认深度足够覆盖常见启动器结构。
  const requestedDepth = Number(opts.maxDepth)
  const maxDepth = Number.isFinite(requestedDepth) ? Math.max(0, Math.min(64, requestedDepth)) : 24
  // 目录不存在时返回空列表，而不是把整个游戏目录当成“缺目录”重建出来：
  // 模组页/共置页面触发的扫描是读操作，不应该在桌面上凭空创下文件夹。
  if (!dir || !fs.existsSync(dir)) return []
  const stat = await fsp.stat(dir)
  if (!stat.isDirectory()) throw new Error('不是目录：' + dir)

  // 先收集文件，再按固定并发解析。旧实现边遍历边逐个 await readModMeta：
  // 300+ 个模组时每个 JAR 都要等上一个读完，磁盘和 CPU 大部分时间在空转。
  const files = []
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
      files.push({
        name: it.name,
        path: full,
        relPath: path.relative(dir, full),
        size: st ? st.size : 0,
        mtime: st ? st.mtimeMs : 0,
        disabled: isDisabled
      })
    }
  }
  await walk(dir, 0)
  files.sort((a, b) => a.relPath.localeCompare(b.relPath))

  const runtime = opts.runtime || {}
  let done = 0
  const requestedConcurrency = Number(opts.concurrency)
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.min(32, requestedConcurrency))
    : 8
  const parsed = await mapLimit(files, concurrency, async (entry) => {
    opts.signal?.throwIfAborted()
    const key = metaCacheKey(entry.path, { size: entry.size, mtimeMs: entry.mtime }, runtime)
    let meta
    if (metaCache.has(key)) {
      meta = metaCache.get(key)
    } else {
      const persisted = loadDiskMeta().get(key)
      if (persisted) {
        meta = cacheMeta(key, persisted)
      } else {
        meta = await readModMeta(entry.path, runtime).catch(() => null)
        cacheMeta(key, meta)
      }
    }
    done++
    opts.onProgress?.({ done, file: entry.name })
    return { ...entry, meta }
  })

  const results = parsed.map(({ name, path: full, relPath, size, mtime, disabled, meta }) => {
    const stem = name.replace(/\.jar(?:\.disabled)?$/i, '')
    const filenameModIds = [...new Set([
      stem,
      stem.split(/[-_ ](?=\d|mc\d|v?\d)/i)[0]
    ].filter((value) => /^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(value)).map((value) => value.toLowerCase()))]
    const actualIds = [...new Set([
      ...(meta?.modids || []),
      ...(meta?.modid ? [meta.modid] : [])
    ].filter(Boolean))]
    const nestedIds = [...new Set(meta?.nestedModIds || [])]
    // 依赖是否满足只看真实元数据（含内嵌 jar）。文件名推断只在完全没有元数据时兜底：
    // xaerominimap-forge-... 这种文件名不是可靠的 modid，拿来当「已提供」会掩盖缺失。
    const providedIds = [...new Set([...actualIds, ...nestedIds])]
    return {
      file: name,
      path: full,
      relPath,
      size,
      mtime,
      disabled,
      modid: meta?.modid || null,
      modids: actualIds.length ? actualIds : filenameModIds,
      nestedModIds: nestedIds,
      modIdHints: filenameModIds,
      providedModIds: providedIds.length ? providedIds : filenameModIds,
      name: meta?.name || name.replace(/\.jar(\.disabled)?$/i, ''),
      version: meta?.version || null,
      providedVersions: meta?.providedVersions || {},
      loader: meta?.loader || null,
      loaderHints: meta?.loaderHints || [],
      environment: meta?.environment || '*',
      dependencies: meta?.dependencies || [],
      icon: meta?.icon || '',
      hasMeta: !!meta
    }
  })
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
