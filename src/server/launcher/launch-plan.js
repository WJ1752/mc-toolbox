// 启动计划（纯函数）—— 版本继承、规则判断、库解析、参数拼装。
//
// 这里不碰网络和磁盘，便于单元测试；真正的下载 / 解压 / 启动在 launch.js、
// install.js 中完成。Minecraft 的版本 JSON 规则参考官方启动器文档与
// HMCL / Prism 的公开实现，但所有代码均为本项目自行编写。
import crypto from 'node:crypto'
import path from 'node:path'

const DEFAULT_LIBRARY_BASE = 'https://libraries.minecraft.net/'

/* ------------------------------------------------------------------ */
/* OS / rules                                                          */
/* ------------------------------------------------------------------ */

export function normalizeOs({ platform = process.platform, arch = process.arch, release = '' } = {}) {
  const name = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : platform === 'linux' ? 'linux' : platform
  const normalizedArch = arch === 'x64' ? 'x86_64' : arch === 'ia32' ? 'x86' : arch === 'arm64' ? 'arm64' : arch
  return { name, arch: normalizedArch, version: String(release || '') }
}

function osMatches(rule, os) {
  if (!rule) return true
  if (rule.name && rule.name !== os.name) return false
  if (rule.arch) {
    // Mojang used "x86" for 32-bit and "x86_64" (or absent) for 64-bit.
    if (rule.arch === 'x86' && os.arch !== 'x86') return false
    if (rule.arch === 'x86_64' && os.arch !== 'x86_64') return false
    if (!['x86', 'x86_64'].includes(rule.arch) && rule.arch !== os.arch) return false
  }
  if (rule.version) {
    try {
      if (!new RegExp(rule.version).test(os.version)) return false
    } catch { return false }
  }
  return true
}

/**
 * Evaluate Mojang's rule list. No rules = allowed. Rules are applied in order;
 * a matching disallow wins over earlier allows (same as the official launcher).
 */
export function rulesAllow(rules, { os = normalizeOs(), features = {} } = {}) {
  if (!Array.isArray(rules) || !rules.length) return true
  let allowed = false
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue
    if (rule.os && !osMatches(rule.os, os)) continue
    if (rule.features) {
      let ok = true
      for (const [key, value] of Object.entries(rule.features)) {
        if (!!features[key] !== !!value) { ok = false; break }
      }
      if (!ok) continue
    }
    // The official launcher treats a rule with no action as "allow".
    if (rule.action === 'disallow') allowed = false
    else allowed = true
  }
  return allowed
}

/* ------------------------------------------------------------------ */
/* Version inheritance                                                 */
/* ------------------------------------------------------------------ */

/**
 * Merge a child version over its parent (both already parsed).
 * Libraries and arguments are concatenated (child first), while scalar fields
 * prefer the child and fall back to the parent. Empty `logging` objects from
 * Forge installers must not erase the parent's log4j configuration.
 */
export function combineVersions(child, parent = null) {
  if (!parent) {
    const only = { ...child }
    only.libraries = (child.libraries || []).map((lib) => ({ ...lib }))
    only.arguments = {
      jvm: [...(child.arguments?.jvm || [])],
      game: [...(child.arguments?.game || [])]
    }
    only.jar = child.jar || child.id
    return only
  }

  const merged = { ...parent, ...child }
  merged.id = child.id || parent.id
  merged.mainClass = child.mainClass || parent.mainClass
  merged.type = child.type || parent.type
  merged.assetIndex = child.assetIndex || parent.assetIndex
  merged.assets = child.assets || parent.assets
  merged.clientVersion = child.clientVersion || parent.clientVersion
  merged.javaVersion = child.javaVersion || parent.javaVersion
  merged.logging = { ...(parent.logging || {}), ...(child.logging || {}) }
  if (!merged.logging.client) merged.logging = parent.logging || child.logging || {}
  merged.downloads = child.downloads || parent.downloads
  merged.jar = child.jar || parent.jar || parent.id

  const seen = new Set()
  const libraries = []
  for (const lib of [...(child.libraries || []), ...(parent.libraries || [])]) {
    if (!lib || !lib.name) continue
    const key = String(lib.name).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    libraries.push({ ...lib })
  }
  merged.libraries = libraries
  merged.arguments = {
    jvm: [...(parent.arguments?.jvm || []), ...(child.arguments?.jvm || [])],
    game: [...(parent.arguments?.game || []), ...(child.arguments?.game || [])]
  }
  merged.minecraftArguments = child.minecraftArguments || parent.minecraftArguments
  return merged
}

/** Build a display-friendly identity for a version JSON. */
export function versionIdentity(json = {}) {
  return {
    id: json.id || '',
    mainClass: json.mainClass || '',
    inheritsFrom: json.inheritsFrom || null,
    type: json.type || 'release',
    javaMajor: Number(json.javaVersion?.majorVersion) || null,
    assetIndex: json.assetIndex?.id || json.assets || null
  }
}

/* ------------------------------------------------------------------ */
/* Maven coordinates / libraries                                       */
/* ------------------------------------------------------------------ */

/** Parse `group:artifact:version[:classifier][@ext]` into a structured object. */
export function parseMavenName(name) {
  const raw = String(name || '').trim()
  if (!raw) return null
  let ext = 'jar'
  let body = raw
  const at = body.lastIndexOf('@')
  if (at > 0) { ext = body.slice(at + 1) || 'jar'; body = body.slice(0, at) }
  const parts = body.split(':')
  if (parts.length < 3) return null
  const [group, artifact, version, ...rest] = parts
  return { group, artifact, version, classifier: rest.join(':') || '', ext, name: raw }
}

/** `group:artifact:version:classifier@ext` → relative path inside `libraries/`. */
export function mavenPath(coord) {
  const parsed = typeof coord === 'string' ? parseMavenName(coord) : coord
  if (!parsed) return null
  const base = `${parsed.group.replace(/\./g, '/')}/${parsed.artifact}/${parsed.version}/${parsed.artifact}-${parsed.version}`
  return `${base}${parsed.classifier ? '-' + parsed.classifier : ''}.${parsed.ext || 'jar'}`
}

function artifactFromName(lib, coord, { urlBase = DEFAULT_LIBRARY_BASE, classifier = '' } = {}) {
  const parsed = typeof coord === 'string' ? parseMavenName(coord) : coord
  if (!parsed) return null
  const path = mavenPath(parsed)
  const base = String(urlBase || DEFAULT_LIBRARY_BASE)
  return {
    name: lib.name || `${parsed.group}:${parsed.artifact}:${parsed.version}`,
    path,
    url: base.replace(/\/?$/, '/') + path,
    sha1: lib.sha1 || '',
    size: Number(lib.size) || 0,
    classifier,
    legacyNative: false,
    extract: lib.extract || null
  }
}

function normalizeDownload(download, fallbackName) {
  if (!download || !download.path) return null
  return {
    name: fallbackName,
    path: String(download.path).replace(/\\/g, '/'),
    url: download.url || '',
    sha1: download.sha1 || '',
    size: Number(download.size) || 0,
    classifier: '',
    legacyNative: false,
    extract: null
  }
}

/**
 * Resolve one library entry for the current OS.
 * Returns an array because legacy libraries have both a classpath artifact and
 * a separate natives classifier JAR.
 */
export function libraryArtifacts(lib, { os = normalizeOs(), features = {} } = {}) {
  if (!lib || !lib.name) return []
  if (!rulesAllow(lib.rules, { os, features })) return []
  const out = []

  const base = normalizeDownload(lib.downloads?.artifact, lib.name)
  if (base) out.push(base)
  else {
    const fromName = artifactFromName(lib, lib.name, { urlBase: lib.url || DEFAULT_LIBRARY_BASE })
    if (fromName) out.push(fromName)
  }

  // Legacy natives (pre-1.19): `natives` maps OS name to a classifier.
  if (lib.natives && typeof lib.natives === 'object') {
    const template = lib.natives[os.name]
    if (template) {
      const classifier = String(template)
        .replace('${arch}', os.arch === 'x86' ? '32' : '64')
        .replace('${arch64}', os.arch === 'x86' ? '32' : '64')
      const downloads = normalizeDownload(lib.downloads?.classifiers?.[classifier], lib.name)
      if (downloads) {
        downloads.classifier = classifier
        downloads.legacyNative = true
        downloads.extract = lib.extract || null
        out.push(downloads)
      } else {
        const coord = parseMavenName(lib.name)
        if (coord) {
          const nativeCoord = { ...coord, classifier }
          const native = artifactFromName(lib, nativeCoord, { urlBase: lib.url || DEFAULT_LIBRARY_BASE })
          if (native) {
            native.classifier = classifier
            native.legacyNative = true
            native.extract = lib.extract || null
            out.push(native)
          }
        }
      }
    }
  }
  return out
}

/**
 * Collect classpath artifacts and legacy native JARs for a merged version.
 * Duplicate paths keep the first occurrence (child version overrides parent).
 */
export function collectLibraries(version, options = {}) {
  const os = options.os || normalizeOs()
  const features = options.features || {}
  const classpath = []
  const natives = []
  const seen = new Set()
  for (const lib of version.libraries || []) {
    for (const artifact of libraryArtifacts(lib, { os, features })) {
      const key = artifact.path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      if (artifact.legacyNative) natives.push(artifact)
      else classpath.push(artifact)
    }
  }
  return { classpath, natives }
}

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

/** Flatten a version `arguments` value (string | string[] | rule objects). */
export function flattenArguments(entries, { os = normalizeOs(), features = {} } = {}) {
  const out = []
  const visit = (entry) => {
    if (entry === null || entry === undefined) return
    if (typeof entry === 'string') { out.push(entry); return }
    if (Array.isArray(entry)) { for (const item of entry) visit(item); return }
    if (typeof entry === 'object') {
      if ('value' in entry) {
        if (!rulesAllow(entry.rules, { os, features })) return
        visit(entry.value)
      }
    }
  }
  for (const entry of entries || []) visit(entry)
  return out
}

/** Split a command line string while honouring single/double quotes. */
export function splitArgs(input) {
  const text = String(input || '')
  const out = []
  let current = ''
  let quote = ''
  let escaped = false
  let has = false
  for (const ch of text) {
    if (escaped) { current += ch; escaped = false; has = true; continue }
    if (ch === '\\' && quote === '"') { escaped = true; continue }
    if (quote) {
      if (ch === quote) quote = ''
      else { current += ch; has = true }
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue }
    if (/\s/.test(ch)) {
      if (has) { out.push(current); current = ''; has = false }
      continue
    }
    current += ch
    has = true
  }
  if (quote) throw new Error('参数中存在未闭合的引号')
  if (has) out.push(current)
  return out
}

export function substitute(value, vars) {
  return String(value ?? '').replace(/\$\{([^}]+)\}/g, (whole, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return String(vars[key] ?? '')
    return ''
  })
}

/* ------------------------------------------------------------------ */
/* Java compatibility                                                  */
/* ------------------------------------------------------------------ */

export function requiredJavaMajor(version, mc = '') {
  const declared = Number(version?.javaVersion?.majorVersion)
  if (Number.isFinite(declared) && declared > 0) return declared
  const modern = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(mc || version?.id || ''))
  if (modern && Number(modern[1]) >= 2) return Number(modern[1]) >= 26 ? 25 : 21
  const legacy = /^1\.(\d+)(?:\.(\d+))?$/.exec(String(mc || version?.id || ''))
  if (!legacy) return 8
  const minor = Number(legacy[1])
  const patch = Number(legacy[2] || 0)
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21
  if (minor >= 18) return 17
  if (minor === 17) return 16
  return 8
}

/** A Java major is usable when it is in the game's supported range. */
export function javaCompatible(required, major) {
  const req = Number(required)
  const got = Number(major)
  if (!Number.isFinite(req) || !Number.isFinite(got)) return false
  if (req <= 8) return got === 8
  if (req === 16) return got === 16 || got === 17
  if (req === 17) return got >= 17
  return got >= req
}

/* ------------------------------------------------------------------ */
/* JVM / game arguments                                                */
/* ------------------------------------------------------------------ */

export const LAUNCHER_BRAND = 'MC-Toolbox'
export const LAUNCHER_VERSION = '1.9.0'

export function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest()
  md5[6] = (md5[6] & 0x0f) | 0x30
  md5[8] = (md5[8] & 0x3f) | 0x80
  const hex = md5.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function splitServerAddress(input) {
  const raw = String(input || '').trim()
  if (!raw) return { host: '', port: '' }
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw)
  if (v6) return { host: v6[1], port: v6[2] || '' }
  const colon = raw.lastIndexOf(':')
  if (colon > 0 && raw.indexOf(':') === colon) {
    const port = raw.slice(colon + 1)
    if (/^\d{1,5}$/.test(port)) return { host: raw.slice(0, colon), port }
  }
  return { host: raw, port: '' }
}

function normalizeAccount(account = {}) {
  const type = account.type === 'microsoft' ? 'microsoft' : account.type === 'authlib' ? 'authlib' : 'offline'
  return {
    name: String(account.name || 'Player'),
    uuid: String(account.uuid || account.profile?.id || '').replace(/-/g, ''),
    accessToken: String(account.accessToken || account.token || '0'.repeat(32)),
    type,
    xuid: String(account.xuid || '0'),
    clientId: String(account.clientId || ''),
    userType: type === 'microsoft' ? 'msa' : type === 'authlib' ? 'mojang' : 'legacy',
    userProperties: '{}'
  }
}

/**
 * Pure launch-plan builder.
 *
 * @param {object} opts
 * @param {object} opts.version merged version JSON
 * @param {object} opts.paths { libraries, assets, assetIndexId, gameDir, nativesDir, clientJar, versionName, logConfigFile }
 * @param {object} opts.options instance launch options
 * @param {object} [opts.account]
 * @param {object} [opts.os]
 * @param {object} [opts.features]
 */
export function buildLaunchPlan({
  version,
  paths,
  options = {},
  account = {},
  os = normalizeOs(),
  features = {}
}) {
  if (!version || !version.mainClass) throw new Error('版本 JSON 缺少 mainClass，无法启动')

  const accountInfo = normalizeAccount(account)
  const width = Number(options.width) || 0
  const height = Number(options.height) || 0
  const effectiveFeatures = {
    has_custom_resolution: width > 0 && height > 0,
    ...(options.features || {}),
    ...features
  }

  const libraries = collectLibraries(version, { os, features: effectiveFeatures })
  const classpath = [
    ...libraries.classpath.map((item) => path.join(paths.libraries, ...String(item.path).split('/'))),
    paths.clientJar
  ].filter(Boolean)

  const server = splitServerAddress(options.server)
  const vars = {
    auth_player_name: accountInfo.name,
    auth_uuid: accountInfo.uuid,
    auth_access_token: accountInfo.accessToken,
    auth_session: accountInfo.accessToken,
    auth_xuid: accountInfo.xuid,
    user_type: accountInfo.userType,
    user_properties: accountInfo.userProperties,
    clientid: accountInfo.clientId,
    version_name: paths.versionName || version.id || '',
    version_type: version.type || options.versionType || 'release',
    game_directory: paths.gameDir,
    assets_root: paths.assets,
    assets_index_name: paths.assetIndexId || version.assetIndex?.id || version.assets || '',
    game_assets: paths.assets,
    natives_directory: paths.nativesDir,
    launcher_name: LAUNCHER_BRAND,
    launcher_version: LAUNCHER_VERSION,
    library_directory: paths.libraries,
    classpath_separator: os.name === 'windows' ? ';' : ':',
    classpath: classpath.join(os.name === 'windows' ? ';' : ':'),
    resolution_width: width || 854,
    resolution_height: height || 480,
    user_language: 'zh-CN'
  }

  // --- JVM args: heap first, then version args (which include -cp). ---
  const jvm = []
  const minMemory = Number(options.minMemory) || 0
  const maxMemory = Number(options.maxMemory) || 0
  if (minMemory > 0) jvm.push(`-Xms${minMemory}M`)
  if (maxMemory > 0) jvm.push(`-Xmx${maxMemory}M`)
  const userJvm = Array.isArray(options.jvmArgs) ? options.jvmArgs : splitArgs(options.jvmArgs || '')
  for (const arg of userJvm) if (arg) jvm.push(arg)

  const versionJvm = flattenArguments(version.arguments?.jvm, { os, features: effectiveFeatures }).map((arg) => substitute(arg, vars))
  jvm.push(...versionJvm)

  // Forge's module layer must ignore the actual vanilla client JAR. The version
  // JSON only knows `${version_name}.jar`, which is the Forge version id, while
  // the client jar is still named after the base version (1.20.1.jar). Append
  // the real file name so ModLauncher does not load it as an automatic module.
  const clientJarName = paths.clientJar ? path.basename(paths.clientJar) : ''
  if (clientJarName) {
    for (let i = 0; i < jvm.length; i++) {
      if (!jvm[i].startsWith('-DignoreList=')) continue
      const list = jvm[i].slice('-DignoreList='.length).split(',').filter(Boolean)
      if (!list.includes(clientJarName)) {
        list.push(clientJarName)
        jvm[i] = '-DignoreList=' + list.join(',')
      }
    }
  }

  if (paths.logConfigFile && version.logging?.client?.argument) {
    jvm.push(substitute(version.logging.client.argument, { ...vars, path: paths.logConfigFile }))
  }
  if (!jvm.some((arg) => arg === '-cp' || arg === '-classpath' || arg.startsWith('-Djava.library.path'))) {
    jvm.push('-cp', vars.classpath)
  }
  if (!jvm.some((arg) => arg.startsWith('-Djava.library.path'))) {
    jvm.push(`-Djava.library.path=${paths.nativesDir}`)
  }
  if (!jvm.some((arg) => arg.startsWith('-Dminecraft.launcher.brand'))) {
    jvm.push(`-Dminecraft.launcher.brand=${LAUNCHER_BRAND}`, `-Dminecraft.launcher.version=${LAUNCHER_VERSION}`)
  }

  // --- Game args ---
  let game = []
  if (Array.isArray(version.arguments?.game) && version.arguments.game.length) {
    game = flattenArguments(version.arguments.game, { os, features: effectiveFeatures }).map((arg) => substitute(arg, vars))
  } else if (version.minecraftArguments) {
    game = splitArgs(version.minecraftArguments).map((arg) => substitute(arg, vars))
  } else {
    game = [
      '--username', vars.auth_player_name,
      '--version', vars.version_name,
      '--gameDir', vars.game_directory,
      '--assetsDir', vars.assets_root,
      '--assetIndex', vars.assets_index_name,
      '--uuid', vars.auth_uuid,
      '--accessToken', vars.auth_access_token,
      '--userType', vars.user_type,
      '--versionType', vars.version_type
    ]
  }

  // Server auto-connect. Quick Play is deliberately not enabled: the classic
  // --server/--port pair works across the widest range of versions.
  if (server.host && options.server !== false) {
    if (!game.includes('--server')) game.push('--server', server.host)
    if (server.port && !game.includes('--port')) game.push('--port', server.port)
  }
  if (width > 0 && height > 0) {
    if (!game.includes('--width')) game.push('--width', String(width))
    if (!game.includes('--height')) game.push('--height', String(height))
  }
  if (options.fullscreen === true && !game.includes('--fullscreen')) game.push('--fullscreen')
  const userGame = Array.isArray(options.gameArgs) ? options.gameArgs : splitArgs(options.gameArgs || '')
  for (const arg of userGame) if (arg) game.push(arg)

  return {
    mainClass: version.mainClass,
    classpath,
    nativeJars: libraries.natives,
    jvmArgs: jvm,
    gameArgs: game,
    vars,
    javaMajor: requiredJavaMajor(version, options.mc || ''),
    features: effectiveFeatures
  }
}

/** Human-readable command preview (never includes the real access token). */
export function previewCommand(plan, javaPath = 'java') {
  const mask = (list) => list.map((arg) => {
    if (/^(--accessToken|--clientId|--xuid)$/.test(arg)) return arg
    return arg
  }).map((arg, index, list) => {
    if (index > 0 && /^(--accessToken)$/.test(list[index - 1])) return '<access token>'
    if (index > 0 && /^(--clientId)$/.test(list[index - 1])) return '<client id>'
    if (index > 0 && /^(--xuid)$/.test(list[index - 1])) return '<xuid>'
    return arg
  })
  const jvm = plan.jvmArgs.map((arg) => {
    if (arg.length > 220) return arg.slice(0, 220) + '…'
    return arg
  })
  return [javaPath, ...jvm, plan.mainClass, ...mask(plan.gameArgs)].map(quoteArg).join(' ')
}

function quoteArg(value) {
  const text = String(value)
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text
}

/* ------------------------------------------------------------------ */
/* Crash / log analysis                                                */
/* ------------------------------------------------------------------ */

/** Turn a crash report / latest.log tail into actionable hints. */
export function analyzeCrash(text, { javaMajor = 0, mc = '', memory = 0 } = {}) {
  const raw = String(text || '')
  const lower = raw.toLowerCase()
  const hints = []
  const add = (kind, title, detail, suggestion) => {
    if (hints.some((item) => item.kind === kind)) return
    hints.push({ kind, title, detail, suggestion })
  }

  if (/outofmemoryerror|java heap space|gc overhead limit exceeded/.test(lower)) {
    add('memory', '内存不足', '游戏在分配堆内存时失败，通常发生在大型整合包或高视距场景。',
      memory ? `当前最大内存 ${Math.round(memory / 1024)} GB，可在实例设置里调高（建议 6–12 GB），并关闭占用内存的程序。` : '在实例设置里调高最大内存（建议 6–12 GB），并关闭占用内存的程序。')
  }
  if (/unsupportedclassversionerror|has been compiled by a more recent version of the java runtime/.test(lower)) {
    add('java', 'Java 版本不匹配', '某个模组或加载器要求的 Java 版本高于当前运行时。',
      javaMajor ? `当前使用 Java ${javaMajor}。请换用更高版本（例如 Java 17/21）或降低模组要求的版本。` : '请换用更高版本的 Java，或在实例设置里指定合适的 Java。')
  }
  if (/nosuchmethoderror|noclassdeffounderror|classnotfoundexception|abstractmethoderror|incompatibleclasschangeerror/.test(lower)) {
    add('mods', '模组或库不兼容', '游戏在加载类时找不到预期的方法/类，常见于模组版本与 MC/加载器不匹配，或缺少前置。',
      '检查崩溃报告顶部的模组列表，移除刚安装或版本不匹配的模组，并补齐前置依赖。')
  }
  if (/modresolutionexception|missing or unsupported mandatory dependencies|mod dependency|incompatible mod set|failed to load mods/.test(lower)) {
    add('deps', '模组依赖不完整', '加载器无法满足某个模组的依赖声明。',
      '查看日志中 "Mod ID:" / "requires" 行，安装对应前置，或确认所有模组支持当前 MC 与加载器版本。')
  }
  if (/pixel format not accelerated|glfw error|opengl|failed to create window|renderer/.test(lower)) {
    add('graphics', '图形驱动问题', '游戏无法创建 OpenGL 上下文或窗口。',
      '更新显卡驱动；笔记本可尝试在显卡控制面板中指定独显运行 java.exe；远程桌面/虚拟机可能没有可用的 OpenGL。')
  }
  if (/java\.lang\.securityexception|accessdeniedexception/.test(lower)) {
    add('permission', '文件权限被拒绝', '启动器或游戏无法读取/写入文件。',
      '检查杀毒软件是否拦截了目录；避免把游戏目录放在受保护的系统目录中。')
  }
  if (/failed to download|connection reset|unknownhostexception|sockettimeoutexception|sslhandshakeexception/.test(lower)) {
    add('network', '网络连接失败', '游戏或启动器访问资源服务器时出错。',
      '检查网络与代理设置；离线安装完成后再启动，或重新执行“检查并修复文件”。')
  }
  if (/crash report|game crashed|exit code: -?\d+/.test(lower) && !hints.length) {
    add('generic', '游戏异常退出', '日志中没有匹配到已知的典型错误，需要查看完整堆栈。',
      '打开日志或 crash-reports 目录，搜索 "Caused by" 与第一个 "at ..." 行定位问题。')
  }
  if (mc && /requires java ?(\d+)/.test(lower)) {
    const need = Number(/requires java ?(\d+)/i.exec(raw)[1])
    add('java-req', `需要 Java ${need}`, raw.match(/requires java ?\d+[^\n]*/i)?.[0] || '', `请安装 64 位 Java ${need} 并在实例设置中选择。`)
  }
  return hints
}

/* ------------------------------------------------------------------ */
/* Misc helpers                                                        */
/* ------------------------------------------------------------------ */

export function compareVersionsDesc(a, b) {
  const pa = String(a || '').split(/[.+\-]/)
  const pb = String(b || '').split(/[.+\-]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? ''
    const y = pb[i] ?? ''
    const nx = Number(x)
    const ny = Number(y)
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return ny - nx
    } else if (x !== y) {
      return y.localeCompare(x, undefined, { numeric: true })
    }
  }
  return 0
}

export function safeName(name, fallback = 'instance') {
  const text = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()
  return text || fallback
}
