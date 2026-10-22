// 版本识别：判断 MC 版本号、读取版本 JSON、识别加载器、推断运行时版本。
//
// PCL2 / HMCL 的自定义版本 JSON 里 `id` 往往是实例名（例如 M1182rebirth），
// 绝不能直接当成 Minecraft 版本：先沿 inheritsFrom 找继承链根版本，再从
// jar / clientVersion / assetIndex / assets / 本地版本目录依次兜底，所有
// 候选值都必须通过版本号格式校验，识别失败时返回空串而不是瞎猜。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

// 与前端 public/js/launcher/version-picker.js 保持完全一致。
const VERSION_RE = /^(?:\d+\.\d+(?:\.\d+)?(?:-(?:pre|rc)\d+)?|\d{2}w\d{2}[a-z])$/i
const MAX_INHERIT_DEPTH = 12

/** 是否为合法的 Minecraft 版本号（1.20.1 / 1.21 / 26.3 / 1.20.1-pre1 / 24w14a）。 */
export function isMinecraftVersion(value) {
  return VERSION_RE.test(String(value ?? '').trim())
}

/** 版本目录内是否包含非法路径片段（防止 ../ 读取到版本目录之外）。 */
function safeVersionId(value) {
  const id = String(value ?? '').trim()
  if (!id || id === '.' || id === '..') return ''
  if (id.includes('/') || id.includes('\\') || id.includes('\0')) return ''
  return id
}

/** 读取 versions/<id>/<id>.json；不存在、损坏或 id 非法时返回 null，不抛错。 */
export async function readVersionJson(versionsDir, id) {
  const base = String(versionsDir ?? '').trim()
  const versionId = safeVersionId(id)
  if (!base || !versionId) return null
  const root = path.resolve(base)
  const file = path.resolve(path.join(root, versionId, `${versionId}.json`))
  if (file !== path.join(root, versionId, `${versionId}.json`) || !file.startsWith(root + path.sep)) return null
  try {
    const json = JSON.parse(await fsp.readFile(file, 'utf8'))
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null
    return json
  } catch {
    return null
  }
}

/** 从库名列表里取第一个匹配到的版本号。 */
function libraryVersion(names, re) {
  for (const name of names) {
    const match = re.exec(name)
    if (match && match[1]) return match[1]
  }
  return ''
}

/** 去掉 Forge 系「<mc>-<loader>」里前缀的 MC 版本。 */
function stripMinecraftPrefix(value) {
  const text = String(value ?? '').trim()
  return /^\d+\.\d+(?:\.\d+)?-(.+)$/.exec(text)?.[1] || text
}

/** 从版本 id 里按数字版本号提取（避免把 -1.21.1 之类的后缀一起吞掉）。 */
function matchVersion(text, re) {
  const match = re.exec(String(text ?? ''))
  return match && match[1] ? match[1] : ''
}

/**
 * 识别加载器。优先看 mainClass 与实际库名（可靠），再看版本 id 命名（兜底）。
 * @returns {{loader:'vanilla'|'fabric'|'quilt'|'forge'|'neoforge', loaderVersion:string}}
 */
export function detectLoader(json, versionId = '') {
  const source = json && typeof json === 'object' ? json : {}
  const id = String(versionId || source.id || '').trim()
  const libraries = Array.isArray(source.libraries) ? source.libraries : []
  const libNames = libraries
    .map((lib) => (typeof lib === 'string' ? lib : String(lib?.name || '')))
    .filter(Boolean)
  // mainClass + 库名是最可靠的加载器特征；实例名/版本名只作最后兜底。
  const strong = [source.mainClass || '', ...libNames].join(' ').toLowerCase()
  const idText = id.toLowerCase()

  let loader = 'vanilla'
  if (/fabric/.test(strong)) loader = 'fabric'
  else if (/quilt/.test(strong)) loader = 'quilt'
  else if (/neoforge/.test(strong)) loader = 'neoforge'
  else if (/minecraftforge|cpw\.mods\.modlauncher|forge/.test(strong)) loader = 'forge'
  else if (/fabric[-_/]?loader|fabric[-_]\d/.test(idText)) loader = 'fabric'
  else if (/quilt[-_/]?loader|quilt[-_]\d/.test(idText)) loader = 'quilt'
  else if (/neo[-_]?forge/.test(idText)) loader = 'neoforge'
  else if (/(?:^|[-_ ])forge[-_ ]?\d/.test(idText)) loader = 'forge'

  let loaderVersion = ''
  if (loader === 'fabric') {
    loaderVersion = libraryVersion(libNames, /net\.fabricmc:fabric-loader:([^:\s]+)/i)
      || stripMinecraftPrefix(matchVersion(id, /fabric-loader[-_](\d+\.\d+(?:\.\d+)?)/i))
      || matchVersion(id, /(?:^|[-_])fabric[-_](\d+\.\d+(?:\.\d+)?)/i)
  } else if (loader === 'quilt') {
    loaderVersion = libraryVersion(libNames, /org\.quiltmc:quilt-loader:([^:\s]+)/i)
      || matchVersion(id, /quilt-loader[-_](\d+\.\d+(?:\.\d+)?)/i)
      || matchVersion(id, /(?:^|[-_])quilt[-_](\d+\.\d+(?:\.\d+)?)/i)
  } else if (loader === 'neoforge') {
    loaderVersion = stripMinecraftPrefix(libraryVersion(libNames, /net\.neoforged:neoforge:([^:\s]+)/i))
      || stripMinecraftPrefix(libraryVersion(libNames, /net\.neoforged:forge:([^:\s]+)/i))
      || stripMinecraftPrefix(matchVersion(id, /neo[-_]?forge[-_](\d+(?:\.\d+)+(?:-[\d.]+)*)/i))
  } else if (loader === 'forge') {
    loaderVersion = stripMinecraftPrefix(libraryVersion(libNames, /net\.minecraftforge:forge:([^:\s]+)/i))
      || stripMinecraftPrefix(matchVersion(id, /forge[-_](\d+(?:\.\d+)+)/i))
  }
  return { loader, loaderVersion: String(loaderVersion || '') }
}

/** 跟随 inheritsFrom 读取整条继承链（自身在前，根版本在后）。 */
async function readVersionChain(json, versionsDir, versionId) {
  const entries = []
  if (!json || typeof json !== 'object') return entries
  const seen = new Set()
  let currentJson = json
  let currentId = String(versionId || json.id || '').trim()
  while (currentJson && entries.length < MAX_INHERIT_DEPTH) {
    const key = currentId.toLowerCase()
    // 空 id 或循环继承直接停止，保证不会无限递归。
    if (!currentId || seen.has(key)) break
    seen.add(key)
    entries.push({ id: currentId, json: currentJson })
    const parentId = String(currentJson.inheritsFrom || '').trim()
    if (!parentId || !versionsDir) break
    const parent = await readVersionJson(versionsDir, parentId)
    if (!parent) break
    currentJson = parent
    currentId = parentId
  }
  return entries
}

/** versions/<候选>/<候选>.jar 是否存在（只认文件）。 */
function clientJarExists(versionsDir, versionName) {
  if (!versionsDir || !versionName) return false
  if (versionName.includes('/') || versionName.includes('\\')) return false
  try {
    return fs.statSync(path.join(versionsDir, versionName, `${versionName}.jar`)).isFile()
  } catch {
    return false
  }
}

/**
 * 推断版本的 MC 版本、加载器与客户端 JAR 版本。
 *
 * 优先级（命中即返回，值必须通过 isMinecraftVersion）：
 *   1. inheritsFrom 链根 id
 *   2. json.jar → json.clientVersion
 *   3. json.assetIndex.id → json.assets
 *   4. 本地 versions/<id>/<id>.json 里真实存在的原版版本
 *   5. json.id（仅格式合法时兜底）
 *   6. 仍无法判断：mc = ''、needsMc = true
 *
 * @param {object} json 版本 JSON
 * @param {{versionsDir?: string, versionId?: string}} options
 */
export async function inferRuntime(json, options = {}) {
  const opts = options || {}
  const source = json && typeof json === 'object' ? json : {}
  const versionId = String(opts.versionId || source.id || '').trim()
  const versionsDir = opts.versionsDir ? path.resolve(String(opts.versionsDir)) : ''
  const entries = await readVersionChain(source, versionsDir, versionId)
  const chain = entries.map((entry) => entry.id)

  const mcCandidates = []
  let mc = ''
  let mcSource = 'unknown'

  // 记录候选：只保留合法版本号，去重；命中后立即固定结果。
  const tryCandidate = (raw, from) => {
    const text = String(raw ?? '').trim()
    if (!text || !isMinecraftVersion(text)) return false
    if (!mcCandidates.includes(text)) mcCandidates.push(text)
    if (!mc) {
      mc = text
      mcSource = from
    }
    return true
  }

  // 1. 继承链根（只有真的读到父版本时才按继承判断，避免把文件夹名当版本）。
  if (!mc && entries.length > 1) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      const jsonId = String(entry.json?.id ?? '').trim()
      // 先信 JSON 自己的 id；它的 id 不是合法版本时，再用版本文件夹名兜底。
      if (tryCandidate(jsonId, 'inheritsFrom')) break
      if (tryCandidate(entry.id, 'inheritsFrom')) break
    }
  }

  // 2. jar / clientVersion
  if (!mc) tryCandidate(source.jar, 'jar')
  if (!mc) tryCandidate(source.clientVersion, 'clientVersion')

  // 3. 资源索引
  if (!mc) tryCandidate(source.assetIndex?.id, 'assetIndex')
  if (!mc) tryCandidate(source.assets, 'assets')

  // 4. 本地版本目录里真实存在的原版 JSON（不是另一个自定义版本）。
  if (!mc && versionsDir) {
    const candidates = [...mcCandidates]
    if (!candidates.includes(versionId) && isMinecraftVersion(versionId)) candidates.push(versionId)
    for (const candidate of candidates) {
      if (!isMinecraftVersion(candidate)) continue
      const candidateJson = await readVersionJson(versionsDir, candidate)
      if (!candidateJson) continue
      // 该 JSON 自己的 id 或 inheritsFrom 至少有一个是合法 MC 版本，才认作原版。
      const looksVanilla = isMinecraftVersion(candidateJson.id) || isMinecraftVersion(candidateJson.inheritsFrom)
      if (!looksVanilla) continue
      mc = candidate
      mcSource = 'versionDir'
      if (!mcCandidates.includes(candidate)) mcCandidates.push(candidate)
      break
    }
  }

  // 5. json.id 最后兜底（M1182rebirth 这类实例名永远过不了格式校验）。
  if (!mc) tryCandidate(source.id, 'unknown')

  // 客户端 JAR 版本：优先取真实存在的 JAR，否则取第一个合法候选。
  const chainRootId = entries.length ? entries[entries.length - 1].id : ''
  const jarCandidates = []
  for (const raw of [source.jar, source.clientVersion, chainRootId, mc, source.id]) {
    const text = String(raw ?? '').trim()
    if (text && !jarCandidates.includes(text)) jarCandidates.push(text)
  }
  let clientJarVersion = ''
  if (versionsDir) {
    for (const candidate of jarCandidates) {
      if (clientJarExists(versionsDir, candidate)) {
        clientJarVersion = candidate
        break
      }
    }
  }
  if (!clientJarVersion) clientJarVersion = jarCandidates.find((candidate) => isMinecraftVersion(candidate)) || ''

  // 加载器：沿继承链优先取子版本，没有特征时继续看父版本。
  let loader = 'vanilla'
  let loaderVersion = ''
  for (const entry of entries) {
    const detected = detectLoader(entry.json, entry.id)
    if (detected.loader !== 'vanilla') {
      loader = detected.loader
      loaderVersion = detected.loaderVersion
      break
    }
  }

  return {
    mc,
    mcSource: mc ? mcSource : 'unknown',
    mcCandidates,
    needsMc: !mc,
    loader,
    loaderVersion,
    clientJarVersion,
    chain
  }
}
