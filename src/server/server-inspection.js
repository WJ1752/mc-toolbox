import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { readZipIndex } from './pack-converter.js'
import { detectPackRuntime } from './pack-runtime.js'
import { probeJava, requiredJava, resolveJava } from './server-launch.js'
import { recommendPackMemory } from '../../public/js/core/pack-preview.js'

const inflate = promisify(zlib.inflateRaw)
const exists = async file => (await fs.stat(file).catch(() => null))?.isFile()
export function splitArguments(text) {
  if (typeof text !== 'string' || text.length > 16000 || /[\r\n\0]/.test(text)) throw new Error('启动参数必须为单行文本，最多 16000 字符')
  const args = []
  let value = '', quote = '', active = false
  for (const char of text) {
    if (quote) { if (char === quote) quote = ''; else value += char; active = true }
    else if (char === '"' || char === "'") { quote = char; active = true }
    else if (/\s/.test(char)) { if (active) { args.push(value); value = ''; active = false } }
    else { value += char; active = true }
  }
  if (quote) throw new Error('启动参数引号未闭合')
  if (active) args.push(value)
  return args
}
export const joinArguments = args => args.map(arg => /\s/.test(arg) ? '"' + arg.replace(/"/g, '') + '"' : arg).join(' ')

async function jarInfo(file) {
  const index = await readZipIndex(file)
  const result = {}
  const handle = await fs.open(file, 'r')
  try {
    for (const entry of index.entries.filter(e => /^(version\.json|META-INF\/MANIFEST.MF|fabric-server-launch.properties|patch.properties)$/i.test(e.name) && e.size <= 1024 * 1024 && e.compressedSize <= 2 * 1024 * 1024)) {
      const header = Buffer.alloc(30)
      await handle.read(header, 0, 30, entry.offset)
      if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('核心 JAR 文件头无效')
      const bytes = Buffer.alloc(entry.compressedSize)
      await handle.read(bytes, 0, bytes.length, entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28))
      const out = entry.method === 0 ? bytes : entry.method === 8 ? await inflate(bytes, { maxOutputLength: Math.max(1, entry.size) }) : null
      if (out) result[entry.name.toLowerCase()] = out.toString('utf8')
    }
  } finally { await handle.close() }
  return result
}

export async function inspectCore(file) {
  const name = path.basename(file)
  const info = await jarInfo(file)
  const manifest = (info['meta-inf/manifest.mf'] || '').replace(/\r?\n /g, '')
  if (!/^Main-Class:\s*\S+/im.test(manifest)) return null
  if (/installer/i.test(name) || /Main-Class:.*(?:installer|installertools)/i.test(manifest)) return null
  let mc = '', loader = 'vanilla', loaderVersion = ''
  try { const v = JSON.parse(info['version.json']); mc = v.id || v.name || '' } catch {}
  const forge = /^forge-(1\.\d+(?:\.\d+)?)-(\d+(?:\.\d+)+(?:-1\.\d+(?:\.\d+)?)?)/i.exec(name)
  if (/cleanroom/i.test(name + manifest)) { mc = '1.12.2'; loader = 'cleanroom'; loaderVersion = /cleanroom-(.+)\.jar$/i.exec(name)?.[1] || '' }
  else if (forge) { mc = forge[1]; loader = 'forge'; loaderVersion = forge[2] }
  else if (/fabric/i.test(name + manifest)) loader = 'fabric'
  else if (/quilt/i.test(name + manifest)) loader = 'quilt'
  else if (/neoforge/i.test(name + manifest)) loader = 'neoforge'
  else if (/paper|purpur|spigot|craftbukkit/i.test(name + manifest)) loader = /purpur/i.test(name + manifest) ? 'purpur' : /paper/i.test(name + manifest) ? 'paper' : 'spigot'
  if (!/^1\.\d+(?:\.\d+)?$/.test(mc)) mc = /(?:^|[^\d])(1\.\d+(?:\.\d+)?)(?=[^\d]|$)/.exec(name)?.[1] || /(?:Minecraft-Version:|MC:|minecraftVersion=|version=)\s*(1\.\d+(?:\.\d+)?)/i.exec(manifest + '\n' + (info['patch.properties'] || ''))?.[1] || ''
  return { mc, loader, loaderVersion }
}

function runtimeFromCoreName(name) {
  const clean = /cleanroom-(.+)\.jar$/i.exec(name)
  if (clean) return { mc: '1.12.2', loader: 'cleanroom', loaderVersion: clean[1] }
  const forge = /(?:^|[\\/])forge-(1\.\d+(?:\.\d+)?)-(\d+(?:\.\d+)+(?:-1\.\d+(?:\.\d+)?)?)(?:-server)?\.jar$/i.exec(name)
  if (forge) return { mc: forge[1], loader: 'forge', loaderVersion: forge[2] }
  const neo = /(?:^|[\\/])neoforge-(\d+(?:\.\d+)+)(?:-server)?\.jar$/i.exec(name)
  if (neo) return { mc: '', loader: 'neoforge', loaderVersion: neo[1] }
  const mc = /(?:^|[\\/])(?:minecraft_server|server)[._-](1\.\d+(?:\.\d+)?)(?:\.jar)?$/i.exec(name)
  if (mc) return { mc: mc[1], loader: 'vanilla', loaderVersion: '' }
  if (/fabric/i.test(name)) return { mc: '', loader: 'fabric', loaderVersion: '' }
  if (/quilt/i.test(name)) return { mc: '', loader: 'quilt', loaderVersion: '' }
  if (/purpur/i.test(name)) return { mc: /1\.\d+(?:\.\d+)?/.exec(name)?.[0] || '', loader: 'purpur', loaderVersion: '' }
  if (/paper/i.test(name)) return { mc: /1\.\d+(?:\.\d+)?/.exec(name)?.[0] || '', loader: 'paper', loaderVersion: '' }
  if (/spigot|craftbukkit/i.test(name)) return { mc: /1\.\d+(?:\.\d+)?/.exec(name)?.[0] || '', loader: 'spigot', loaderVersion: '' }
  return null
}

function readProperties(text) {
  return Object.fromEntries(text.split(/\r?\n/).filter(line => line.trim() && !/^\s*[#!]/.test(line)).map(line => {
    const at = line.indexOf('='); return at < 0 ? [line.trim(), ''] : [line.slice(0, at).trim(), line.slice(at + 1).trim()]
  }))
}

async function plansAt(root) {
  const plans = [], warnings = []
  const configPath = path.join(root, 'server-launch.json')
  let config
  if (await exists(configPath)) {
    try {
      config = JSON.parse(await fs.readFile(configPath, 'utf8'))
      if (!Array.isArray(config.args) || !config.args.every(arg => typeof arg === 'string' && !/[\r\n\0]/.test(arg))) throw new Error('args 无效')
      const jarAt = config.args.indexOf('-jar')
      const prefix = jarAt >= 0 ? config.args.slice(0, jarAt) : []
      plans.push({ id: 'saved', label: '已保存的服务端启动配置', args: jarAt >= 0 ? config.args.slice(jarAt) : config.args, runtime: {}, memory: config.memory, minMemory: config.minMemory, javaPath: config.javaPath || '', jvm: prefix })
    } catch (e) { warnings.push('server-launch.json 无法使用：' + e.message); config = null }
  }
  for (const [prefix, loader] of [['net/minecraftforge/forge', 'forge'], ['net/neoforged/neoforge', 'neoforge']]) {
    const base = path.join(root, 'libraries', prefix)
    for (const version of await fs.readdir(base).catch(() => [])) {
      const rel = 'libraries/' + prefix + '/' + version + '/' + (process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt')
      if (!(await exists(path.join(root, rel)))) continue
      const text = await fs.readFile(path.join(root, rel), 'utf8')
      const mc = /--fml\.mcVersion\s+(1\.\d+(?:\.\d+)?)/.exec(text)?.[1] || /^(1\.\d+(?:\.\d+)?)-/.exec(version)?.[1] || ''
      const loaderVersion = /--fml\.(?:forgeVersion|neoForgeVersion)\s+([^\s]+)/.exec(text)?.[1] || version.replace(/^1\.\d+(?:\.\d+)?-/, '')
      let jvm = []
      if (await exists(path.join(root, 'user_jvm_args.txt'))) {
        const lines = (await fs.readFile(path.join(root, 'user_jvm_args.txt'), 'utf8')).split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join(' ')
        try { jvm = splitArguments(lines) } catch { warnings.push('user_jvm_args.txt 参数格式复杂，请核对自定义 JVM 参数。') }
      }
      plans.push({ id: rel, label: `${loader} ${version}（参数文件）`, args: ['@' + rel, 'nogui'], jvm, runtime: { mc, loader, loaderVersion } })
    }
  }
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.jar$/i.test(entry.name)) continue
    try {
      const runtime = await inspectCore(path.join(root, entry.name))
      if (runtime) plans.push({ id: entry.name, label: entry.name, args: ['-jar', entry.name, 'nogui'], jvm: [], runtime })
    } catch (e) { warnings.push(`${entry.name} 读取失败：${e.message}`) }
  }
  // Preserve literal JVM arguments in standard launch scripts. Never execute script text as a shell command.
  for (const name of ['start.bat', 'run.bat', 'run-windows.bat', 'startserver.bat', 'ServerStart.bat', 'start.sh', 'run.sh', 'run-linux.sh']) {
    if (!(await exists(path.join(root, name)))) continue
    const script = await fs.readFile(path.join(root, name), 'utf8')
    for (const line of script.split(/\r?\n/)) {
      if (/^\s*(?:rem\s|::|#)/i.test(line)) continue
      const match = /^\s*(?:@?java(?:\.exe)?|"[^"\r\n]*java(?:\.exe)?")\s+(.+)$/i.exec(line)
      if (!match) continue
      if (/[%$]|[<>|&]/.test(match[1])) { warnings.push(`${name} 使用变量或脚本逻辑，请核对并补充展开后的 JVM 参数；工具箱不自动执行未知脚本。`); continue }
      try {
        const args = splitArguments(match[1]), at = args.indexOf('-jar')
        if (at < 0) continue
        const plan = plans.find(p => p.id === args[at + 1])
        if (plan) { plan.jvm = args.slice(0, at); plan.args = args.slice(at); plan.script = name }
        else {
          const jarName = args[at + 1]
          const runtime = runtimeFromCoreName(jarName) || { mc: '', loader: 'vanilla', loaderVersion: '' }
          plans.push({ id: jarName, label: `${name} → ${jarName}（脚本引用的核心）`, args: args.slice(at), jvm: args.slice(0, at), script: name, runtime, missingCore: !(await exists(path.resolve(root, jarName))) })
        }
      } catch { warnings.push(`${name} 参数无法完整识别，请手动核对。`) }
    }
  }
  if (config) {
    const saved = plans[0]
    const jar = config.args[config.args.indexOf('-jar') + 1]
    const inferred = plans.find(p => p.id === jar || config.args.includes('@' + p.id))
    if (inferred) { saved.runtime = inferred.runtime; saved.jvm = [...inferred.jvm, ...saved.jvm] }
  }
  return { plans, warnings }
}

export async function inspectServer(source, corePath = '') {
  const stat = await fs.stat(source)
  let root = stat.isDirectory() ? source : path.dirname(source)
  if (stat.isFile() && /\.jar$/i.test(source)) corePath = source
  if (!corePath) {
    try {
      const saved = JSON.parse(await fs.readFile(path.join(root, '.mc-toolbox-server.json'), 'utf8'))
      if (saved.corePath && await exists(saved.corePath)) corePath = saved.corePath
    } catch {}
  }
  let found = await plansAt(root)
  if (!found.plans.length && !corePath) {
    const candidates = []
    async function walk(dir, depth) {
      if (depth > 3) return
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || /^(mods|libraries|runtime|assets|world|config|logs|plugins)$/i.test(entry.name)) continue
        const next = path.join(dir, entry.name), result = await plansAt(next)
        if (result.plans.length) candidates.push({ root: next, ...result })
        else await walk(next, depth + 1)
      }
    }
    await walk(root, 0)
    if (candidates.length > 1) throw new Error('包含多个服务端实例，请选择具体的服务端文件夹')
    if (candidates.length === 1) { root = candidates[0].root; found = candidates[0] }
  }
  root = await fs.realpath(root)
  if (corePath) {
    corePath = await fs.realpath(corePath)
    const runtime = await inspectCore(corePath)
    if (!runtime) throw new Error('所选 JAR 不是可直接启动的服务端核心（可能是安装器或依赖库）')
    const id = path.dirname(corePath) === root ? path.basename(corePath) : corePath
    if (!found.plans.some(plan => plan.id === id)) found.plans.push({ id, label: path.basename(corePath), runtime, args: ['-jar', corePath, 'nogui'], jvm: [] })
    found.selected = id
  }
  let detected = null
  try { detected = await detectPackRuntime(root) } catch (e) { found.warnings.push(e.message) }
  // A neighboring vanilla jar supplies the game version for Fabric/Quilt launcher jars.
  const vanilla = found.plans.find(p => p.runtime?.loader === 'vanilla' && p.runtime.mc)
  for (const plan of found.plans) {
    if (!plan.runtime?.mc && detected && (!plan.runtime?.loader || plan.runtime.loader === detected.loader)) plan.runtime = { ...detected, ...plan.runtime, mc: detected.mc }
    if (!plan.runtime?.mc && ['fabric', 'quilt'].includes(plan.runtime?.loader) && vanilla) plan.runtime.mc = vanilla.runtime.mc
  }
  const meaningful = found.plans.filter(p => !['vanilla'].includes(p.runtime?.loader) && p.id !== 'saved')
  const selected = found.selected || (found.plans.some(p => p.id === 'saved') ? 'saved' : meaningful.length === 1 ? meaningful[0].id : found.plans.length === 1 ? found.plans[0].id : '')
  const properties = readProperties(await fs.readFile(path.join(root, 'server.properties'), 'utf8').catch(() => ''))
  const eulaAccepted = /^\s*eula\s*=\s*true\s*$/im.test(await fs.readFile(path.join(root, 'eula.txt'), 'utf8').catch(() => ''))
  const summary = { modCount: 0, modBytes: 0 }
  async function countMods(dir, depth = 0) {
    if (depth > 4) return
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await countMods(full, depth + 1)
      else if (entry.isFile() && /\.jar$/i.test(entry.name)) { summary.modCount++; summary.modBytes += (await fs.stat(full)).size }
    }
  }
  await countMods(path.join(root, 'mods'))
  return { root, ...found, selected, properties, eulaAccepted, ...summary, recommendedMemory: recommendPackMemory(summary) }
}

export async function resolveServerJava(root, runtime, preferred = '') {
  if (preferred) return resolveJava(runtime, path.isAbsolute(preferred) ? preferred : path.resolve(root, preferred))
  const executable = process.platform === 'win32' ? 'java.exe' : 'java'
  for (const rel of ['runtime/bin', 'jre/bin', 'java/bin', 'jdk/bin']) {
    const candidate = path.join(root, rel, executable)
    const info = await probeJava(candidate)
    if (info?.bits === 64 && info.major === requiredJava(runtime)) return info
  }
  return resolveJava(runtime)
}
