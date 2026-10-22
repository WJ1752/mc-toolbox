// 服务端核心下载：解析各加载器的版本与下载地址（零第三方依赖）
import { httpFetch, getProxy } from './http.js'
const UA = 'mc-toolbox/1.0 (local toolbox)'
const TIMEOUT = 25000

const MC_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const BMCL_API = 'https://bmclapi2.bangbang93.com'
const MC_MANIFESTS = [`${BMCL_API}/mc/game/version_manifest_v2.json`, MC_MANIFEST]
const FABRIC_META = 'https://meta.fabricmc.net/v2'
const QUILT_META = 'https://meta.quiltmc.org/v3'
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge'
const NEO_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge'
// Paper v2 已下线（410 sunset），改用 fill.papermc.io v3
const PAPER_API = 'https://fill.papermc.io/v3/projects/paper'

export const LOADERS = [
  ['vanilla', '官方原版'],
  ['fabric', 'Fabric'],
  ['forge', 'Forge'],
  ['cleanroom', 'Cleanroom (1.12.2)'],
  ['neoforge', 'NeoForge'],
  ['quilt', 'Quilt'],
  ['paper', 'Paper']
]

async function request(url, { json = true, signal, timeout = TIMEOUT } = {}) {
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await httpFetch(url, {
        headers: { 'User-Agent': UA, Accept: json ? 'application/json' : '*/*' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
        redirect: 'follow'
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        const error = new Error(`HTTP ${res.status} ${text.slice(0, 120)}`)
        error.status = res.status
        throw error
      }
      return json ? res.json() : res.text()
    } catch (e) {
      if (signal?.aborted) throw e
      lastError = e
      // 4xx 重试没有意义；超时已经等满设定时间，再重试只会更慢。
      if (e?.status && e.status >= 400 && e.status < 500) break
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') break
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  throw lastError || new Error('请求失败：' + url)
}

/** 版本清单优先走 BMCLAPI 镜像，官方地址兜底（与启动器使用同一数据源）。 */
async function requestManifest(signal) {
  let lastError = null
  for (const url of MC_MANIFESTS) {
    try {
      return await request(url, { signal })
    } catch (e) {
      if (signal?.aborted) throw e
      lastError = e
    }
  }
  throw new Error('获取 MC 版本清单失败：' + (lastError?.message || '网络不可用'))
}

/** 版本 JSON（piston-meta）同样先镜像；按版本号构造 BMCLAPI 地址。 */
async function requestVersionJson(mc, url, signal) {
  const urls = [...new Set([`${BMCL_API}/version/${encodeURIComponent(mc)}/json`, url].filter(Boolean))]
  let lastError = null
  for (const target of urls) {
    try {
      return await request(target, { signal })
    } catch (e) {
      if (signal?.aborted) throw e
      lastError = e
    }
  }
  throw new Error(`获取 Minecraft ${mc} 版本信息失败：${lastError?.message || '网络不可用'}`)
}

// ---------------- MC 版本清单（带内存缓存） ----------------
let mcCache = { at: 0, releases: null }

export async function listGameVersions() {
  if (mcCache.releases && Date.now() - mcCache.at < 10 * 60 * 1000) return mcCache.releases
  const data = await requestManifest()
  const releases = (data.versions || [])
    .filter((v) => v.type === 'release')
    .map((v) => ({ id: v.id, type: v.type }))
  mcCache = { at: Date.now(), releases }
  return releases
}

async function findManifestEntry(mc, signal) {
  const data = await requestManifest(signal)
  const v = (data.versions || []).find((x) => x.id === mc)
  if (!v) throw new Error('未找到 MC 版本：' + mc)
  return v
}

// ---------------- 各加载器版本列表 ----------------

/** Fabric / Quilt：取该 MC 版本可用的加载器版本（新→旧，正式版优先） */
async function fabricLikeLoaders(baseUrl, mc) {
  const arr = await request(`${baseUrl}/versions/loader/${encodeURIComponent(mc)}`)
  const out = (Array.isArray(arr) ? arr : [])
    .map((x) => ({
      version: x.loader?.version || x.version,
      stable: x.loader?.stable !== false
    }))
    .filter((x) => x.version)
  // 去重
  const seen = new Set()
  const uniq = out.filter((x) => (seen.has(x.version) ? false : seen.add(x.version)))
  // 正式版优先，再按版本号倒序
  return uniq.sort((a, b) => {
    const ap = a.version.includes('-') ? 1 : 0
    const bp = b.version.includes('-') ? 1 : 0
    if (ap !== bp) return ap - bp
    return compareVersionDesc(a.version.split('-')[0], b.version.split('-')[0])
  })
}

/** Forge：BMCL 版本接口 + 官方 maven 元数据 + promotions_slim 合并。 */
async function forgeLoaders(mc) {
  // BMCLAPI 的 Forge 版本接口对国内网络最稳定，且覆盖所有 MC 版本；
  // 官方 maven 元数据作为回退，promotions 只用于标记 recommended / latest。
  // 三者都加短超时，任何一个不可达都不会拖住整个版本列表。
  const [bmcl, metadata, promotions] = await Promise.allSettled([
    request(`https://bmclapi2.bangbang93.com/forge/minecraft/${encodeURIComponent(mc)}`, { timeout: 10000 }),
    request(`${FORGE_MAVEN}/maven-metadata.xml`, { json: false, timeout: 12000 }),
    request(FORGE_PROMOS, { timeout: 6000 })
  ])
  const promos = promotions.status === 'fulfilled' ? promotions.value.promos || {} : {}
  const latest = promos[`${mc}-latest`]
  const recommended = promos[`${mc}-recommended`]
  const versions = new Set()
  if (bmcl.status === 'fulfilled' && Array.isArray(bmcl.value)) {
    for (const item of bmcl.value) {
      const version = String(item?.version || '')
      if (version) versions.add(version)
    }
  }
  if (metadata.status === 'fulfilled') {
    for (const match of String(metadata.value).matchAll(/<version>([^<]+)<\/version>/g)) {
      const full = match[1]
      if (full.startsWith(mc + '-')) versions.add(full.slice(mc.length + 1))
    }
  }
  if (recommended) versions.add(recommended)
  if (latest) versions.add(latest)
  if (!versions.size) {
    const reason = [bmcl, metadata].find((item) => item.status === 'rejected')?.reason?.message || ''
    throw new Error(`该 MC 版本没有可用的 Forge：${mc}${reason ? '（' + reason + '）' : ''}`)
  }
  const out = []
  if (recommended) out.push({ version: recommended, stable: true, label: 'recommended' })
  if (latest && latest !== recommended) out.push({ version: latest, stable: false, label: 'latest' })
  for (const version of [...versions].sort(compareVersionDesc)) {
    if (out.some((item) => item.version === version)) continue
    out.push({ version, stable: true })
  }
  return out
}

// NeoForge 的 maven 目录：1.20.1 发布在 net/neoforged/forge（版本号 1.20.1-47.1.x），
// 1.20.2+ 才移到 net/neoforged/neoforge（版本号 20.2.x / 21.1.x …）。
// 官方 maven.neoforged.net 在中国大陆经常整段不可达，所以先走 BMCLAPI 镜像再回退官方。
const NEO_MAVEN_BASES = [
  'https://bmclapi2.bangbang93.com/maven/net/neoforged',
  'https://maven.neoforged.net/releases/net/neoforged'
]

async function neoforgeMetadata(group) {
  let lastError = null
  for (const base of NEO_MAVEN_BASES) {
    try {
      return await request(`${base}/${group}/maven-metadata.xml`, { json: false, timeout: 12000 })
    } catch (e) {
      lastError = e
    }
  }
  throw new Error(`NeoForge 版本元数据获取失败（官方 maven 与 BMCLAPI 镜像都不可用）：${lastError?.message || ''}`)
}

/** NeoForge：maven-metadata 里按 MC 前缀筛选 */
async function neoforgeLoaders(mc) {
  const legacy = String(mc) === '1.20.1'
  const xml = await neoforgeMetadata(legacy ? 'forge' : 'neoforge')
  const versions = []
  const re = /<version>([^<]+)<\/version>/g
  let m
  while ((m = re.exec(xml)) !== null) versions.push(m[1])
  const prefix = `${mcVersionToNeoPrefix(mc)}.`
  const matched = versions
    .map((raw) => (legacy ? (raw.startsWith(`${mc}-`) ? raw.slice(mc.length + 1) : '') : raw))
    .filter((v) => v && v.startsWith(prefix) && !v.includes('-'))
  if (!matched.length) throw new Error(`该 MC 版本没有可用的 NeoForge：${mc}`)
  // 版本号倒序（新的在前）
  matched.sort(compareVersionDesc)
  return [...new Set(matched)].slice(0, 30).map((v) => ({ version: v, stable: true }))
}

/** 1.21.1 -> 21.1 ；1.21 -> 21.0 ；1.20.4 -> 20.4 ；1.20.1 是唯一的 Forge 编号 47.1 */
function mcVersionToNeoPrefix(mc) {
  const clean = String(mc)
  if (clean === '1.20.1') return '47.1'
  // NeoForge 没有 20.3 分支，1.20.3 与 1.20.4 共用 20.4.x
  if (clean === '1.20.3') return '20.4'
  let p = clean.replace(/^1\./, '')
  if (!p.includes('.')) p += '.0'
  return p
}

function compareVersionDesc(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0)
    if (d) return d
  }
  return 0
}

/** Paper：该 MC 版本的所有构建号（v3 直接返回数组） */
async function paperBuilds(mc) {
  const data = await request(`${PAPER_API}/versions/${encodeURIComponent(mc)}/builds`)
  const builds = Array.isArray(data) ? data : data.builds || []
  if (!builds.length) throw new Error(`该 MC 版本没有可用的 Paper：${mc}`)
  return builds
    .map((b) => ({ id: Number(b.id ?? b.build ?? b), channel: b.channel || '' }))
    .filter((b) => Number.isFinite(b.id))
    .sort((a, b) => b.id - a.id)
    .slice(0, 30)
    .map((b) => ({ version: String(b.id), stable: b.channel !== 'EXPERIMENTAL' }))
}

export async function listLoaderVersions(loader, mc) {
  if (!mc) throw new Error('缺少 MC 版本')
  switch (loader) {
    case 'vanilla':
      return [{ version: 'official', stable: true }]
    case 'fabric':
      return fabricLikeLoaders(FABRIC_META, mc)
    case 'quilt':
      return fabricLikeLoaders(QUILT_META, mc)
    case 'cleanroom':
      if (mc !== '1.12.2') throw new Error('Cleanroom 仅支持 Minecraft 1.12.2')
      return (await request('https://api.github.com/repos/CleanroomMC/Cleanroom/releases?per_page=50')).filter(r => !r.draft && r.assets?.some(a => /-installer\.jar$/.test(a.name))).map(r => ({ version: r.tag_name, stable: !r.prerelease }))
    case 'forge':
      return forgeLoaders(mc)
    case 'neoforge':
      return neoforgeLoaders(mc)
    case 'paper':
      return paperBuilds(mc)
    default:
      throw new Error('不支持的加载器：' + loader)
  }
}

// ---------------- 下载地址解析 ----------------

/** 构造 java 命令（注入代理 JVM 参数，让安装器也能走代理） */
function javaCmd(args) {
  const proxy = getProxy()
  const jvm = []
  if (proxy) {
    const h = proxy.host
    const p = proxy.port
    if (proxy.protocol === 'socks5') {
      jvm.push(`-DsocksProxyHost=${h}`, `-DsocksProxyPort=${p}`)
    } else {
      jvm.push(`-Dhttp.proxyHost=${h}`, `-Dhttp.proxyPort=${p}`, `-Dhttps.proxyHost=${h}`, `-Dhttps.proxyPort=${p}`)
      if (proxy.auth) {
        const [u, pw] = proxy.auth.split(':')
        jvm.push(`-Dhttp.proxyUser=${u}`, `-Dhttp.proxyPassword=${pw}`, `-Dhttps.proxyUser=${u}`, `-Dhttps.proxyPassword=${pw}`)
      }
    }
  }
  return ['java', ...jvm, '-jar', '{jar}', ...args]
}

export async function resolveDownload({ loader, mc, loaderVersion, cleanroom = false, signal }) {
  if (!loader || !mc) throw new Error('缺少加载器或 MC 版本')

  if (loader === 'vanilla') {
    const entry = await findManifestEntry(mc, signal)
    const meta = await requestVersionJson(mc, entry.url, signal)
    const url = meta?.downloads?.server?.url
    if (!url) throw new Error('该版本没有官方服务端核心')
    const name = `minecraft_server.${mc}.jar`
    return { url, filename: name, note: '官方原版服务端', launchJar: name }
  }

  if (loader === 'fabric') {
    if (!loaderVersion) throw new Error('缺少 Fabric 加载器版本')
    // 下载官方安装器（installer），下载后自动执行：server -dir <dir> -mcversion ... -downloadMinecraft
    const installers = await request(`${FABRIC_META}/versions/installer`, { signal })
    const it = Array.isArray(installers) ? installers[0] : null
    if (!it?.version) throw new Error('获取 Fabric 安装器失败')
    const url = it.url || `https://maven.fabricmc.net/net/fabricmc/fabric-installer/${it.version}/fabric-installer-${it.version}.jar`
    return {
      url,
      filename: `fabric-installer-${it.version}.jar`,
      note: '下载安装器后自动安装服务端到目标目录',
      postCommand: javaCmd(['server', '-dir', '{dir}', '-mcversion', mc, '-loader', loaderVersion, '-downloadMinecraft']),
      launchJar: 'fabric-server-launch.jar'
    }
  }

  if (loader === 'quilt') {
    // 官方安装器；原版 server.jar 改由工具箱引擎下载（可走代理/多线程/带超时），
    // 安装器不再用 --download-server（其 Java 网络栈直连 piston-data 易卡死）
    const installers = await request(`${QUILT_META}/versions/installer`, { signal })
    const it = Array.isArray(installers) ? installers[0] : null
    if (!it?.url) throw new Error('获取 Quilt 安装器失败')
    const entry = await findManifestEntry(mc, signal)
    const meta = await requestVersionJson(mc, entry.url, signal)
    const serverUrl = meta?.downloads?.server?.url
    if (!serverUrl) throw new Error('该版本没有官方服务端核心')
    return {
      url: it.url,
      filename: `quilt-installer-${it.version}.jar`,
      note: '下载安装器与原版核心后自动安装服务端到目标目录',
      postCommand: javaCmd(['install', 'server', mc, loaderVersion, '--install-dir={dir}']),
      extraFiles: [{ url: serverUrl, filename: 'server.jar' }],
      launchJar: 'quilt-server-launch.jar'
    }
  }

  if (loader === 'cleanroom' || cleanroom) {
    if (mc !== '1.12.2') throw new Error('Cleanroom 仅支持 Minecraft 1.12.2')
    const release = await request(`https://api.github.com/repos/CleanroomMC/Cleanroom/releases/${loaderVersion && loader === 'cleanroom' ? 'tags/' + encodeURIComponent(loaderVersion) : 'latest'}`, { signal })
    const asset = release.assets?.find(a => /-installer\.jar$/.test(a.name))
    if (!asset) throw new Error('此 Cleanroom 版本没有服务端安装器')
    return { url: asset.browser_download_url, filename: asset.name, postCommand: javaCmd(['--installServer', '{dir}']), note: `Cleanroom ${release.tag_name}`, launchJar: `cleanroom-${release.tag_name}.jar` }
  }

  if (loader === 'forge') {
    if (!loaderVersion) throw new Error('缺少 Forge 版本')
    const full = `${mc}-${loaderVersion}`
    const relative = `net/minecraftforge/forge/${encodeURIComponent(full)}/forge-${encodeURIComponent(full)}-installer.jar`
    return {
      url: `${FORGE_MAVEN}/${encodeURIComponent(full)}/forge-${encodeURIComponent(full)}-installer.jar`,
      // maven.minecraftforge.net 在国内常被墙，优先走 BMCLAPI 同路径镜像
      mirrors: [`https://bmclapi2.bangbang93.com/maven/${relative}`],
      filename: `forge-${full}-installer.jar`,
      note: '下载安装器后自动安装服务端到目标目录',
      postCommand: javaCmd(['--installServer', '{dir}'])
    }
  }

  if (loader === 'neoforge') {
    if (!loaderVersion) throw new Error('缺少 NeoForge 版本')
    // 1.20.1 的 NeoForge 发布在 net.neoforged:forge（版本号带 MC 前缀），1.20.2+ 才用 neoforge
    const legacy = String(mc) === '1.20.1'
    const group = legacy ? 'forge' : 'neoforge'
    const version = legacy ? `${mc}-${loaderVersion}` : String(loaderVersion)
    const artifact = legacy ? `forge-${version}` : `neoforge-${version}`
    const relative = `net/neoforged/${group}/${encodeURIComponent(version)}/${artifact}-installer.jar`
    return {
      url: `${NEO_MAVEN.replace(/\/neoforge$/, '')}/${group}/${encodeURIComponent(version)}/${artifact}-installer.jar`,
      mirrors: [`https://bmclapi2.bangbang93.com/maven/${relative}`],
      filename: `${artifact}-installer.jar`,
      note: '下载安装器后自动安装服务端到目标目录',
      postCommand: javaCmd(['--installServer', '{dir}'])
    }
  }

  if (loader === 'paper') {
    if (!loaderVersion) throw new Error('缺少 Paper 构建号')
    const emc = encodeURIComponent(mc)
    const ebuild = encodeURIComponent(loaderVersion)
    const detail = await request(`${PAPER_API}/versions/${emc}/builds/${ebuild}`, { signal })
    // v3 的真实下载地址在 downloads 里，约定式 URL 会 404
    const dl = detail?.downloads?.['server:default'] || detail?.downloads?.application
    if (!dl?.url) throw new Error('该构建没有可下载的服务端核心')
    const name = dl.name || `paper-${mc}-${loaderVersion}.jar`
    return {
      url: dl.url,
      filename: name,
      note: '开箱即用的服务端核心',
      launchJar: name
    }
  }

  throw new Error('不支持的加载器：' + loader)
}
