import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { startInstall } from './install.js'
import { launcherRoot } from './state.js'
import { isMinecraftVersion } from './version-detect.js'

const COMPONENTS = new Set(['net.minecraft', 'net.fabricmc.fabric-loader', 'net.fabricmc.intermediary', 'org.lwjgl', 'org.lwjgl3'])
const CONTENT = new Set(['mods', 'config', 'defaultconfigs', 'saves', 'resourcepacks', 'shaderpacks',
  'screenshots', 'datapacks', 'kubejs', 'scripts', 'options.txt', 'servers.dat'])

async function entry(file) {
  try { return await fsp.lstat(file) } catch (e) { if (e.code !== 'ENOENT') throw e; return null }
}

async function readMetadata(file) {
  const stat = await entry(file)
  if (!stat) return ''
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('无效的元数据文件：' + path.basename(file))
  return (await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '')
}

async function readInstance(dir) {
  const raw = await readMetadata(path.join(dir, 'mmc-pack.json'))
  if (!raw) throw new Error('缺少 mmc-pack.json')
  const pack = JSON.parse(raw)
  if (pack?.formatVersion !== 1 || !Array.isArray(pack.components)) throw new Error('不支持的 mmc-pack.json 格式')
  const versions = new Map()
  for (const component of pack.components) {
    const uid = component?.uid
    if (!COMPONENTS.has(uid) || component.disabled || versions.has(uid)) throw new Error('不支持的组件组合：' + (uid || '未知组件'))
    versions.set(uid, String(component.version || component.cachedVersion || ''))
  }
  const mc = versions.get('net.minecraft')
  if (!isMinecraftVersion(mc)) throw new Error('未能识别 Minecraft 版本')
  const fabric = versions.has('net.fabricmc.fabric-loader')
  const loaderVersion = versions.get('net.fabricmc.fabric-loader') || ''
  if (fabric && !/^\d[\w.+-]{0,63}$/.test(loaderVersion)) throw new Error('无效的 Fabric Loader 版本')
  const intermediary = versions.get('net.fabricmc.intermediary')
  if (versions.has('net.fabricmc.intermediary') && (!fabric || (intermediary && intermediary !== mc))) throw new Error('Fabric 映射与游戏版本不匹配')
  for (const sub of ['patches', 'jarmods']) {
    const file = path.join(dir, sub)
    const stat = await entry(file)
    if (stat && (!stat.isDirectory() || (await fsp.readdir(file)).length)) throw new Error('含有自定义 ' + sub + '，无法用标准安装器重建')
  }
  const cfg = await readMetadata(path.join(dir, 'instance.cfg'))
  const name = /^name=([^\r\n]+)/m.exec(cfg)?.[1].trim() || path.basename(dir)
  // Prism 优先使用 minecraft，旧实例可能只含 .minecraft；首次启动前两者都可以为空。
  let gameDir = ''
  let content = []
  for (const folder of ['minecraft', '.minecraft']) {
    const candidate = path.join(dir, folder)
    const stat = await entry(candidate)
    if (!stat) continue
    if (!stat.isDirectory()) throw new Error('游戏目录不是普通目录：' + folder)
    gameDir = candidate
    content = (await fsp.readdir(candidate)).filter((item) => CONTENT.has(item)).sort()
    break
  }
  return { dir, name, mc, loader: fabric ? 'fabric' : 'vanilla', loaderVersion, gameDir, content }
}

async function selectedDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('请选择 Prism / MultiMC 的绝对目录路径')
  return fsp.realpath(value)
}

export async function scanPrismInstances(value) {
  const root = await selectedDirectory(value)
  let dirs = [root]
  if (!await entry(path.join(root, 'mmc-pack.json'))) {
    const instances = path.join(root, 'instances')
    const base = (await entry(instances))?.isDirectory() ? instances : root
    dirs = []
    for (const child of await fsp.readdir(base, { withFileTypes: true })) {
      const dir = path.join(base, child.name)
      if (child.isDirectory() && await entry(path.join(dir, 'mmc-pack.json'))) dirs.push(dir)
    }
  }
  const items = []
  for (const dir of dirs.sort()) {
    try { items.push(await readInstance(dir)) }
    catch (e) { items.push({ dir, name: path.basename(dir), error: e.message }) }
  }
  return { items }
}

function contains(parent, child) {
  const rel = path.relative(parent, child)
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

function destination(dir) {
  // 首次安装时目标根目录可能还未创建，沿已有父目录解析目录联接、查询目标盘。
  const selected = launcherRoot()
  let ancestor = selected
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor)
  const existing = fs.realpathSync(ancestor)
  const root = path.resolve(existing, path.relative(ancestor, selected))
  if (contains(dir, root) || contains(root, dir)) throw new Error('源实例目录和启动器游戏根目录必须相互独立')
  return { root, existing }
}

async function* contentEntries(dir, names, signal, rel = '') {
  if (names.length && !(await fsp.lstat(dir)).isDirectory()) throw new Error('游戏内容目录已改变：' + dir)
  for (const name of names) {
    signal?.throwIfAborted()
    const from = path.join(dir, name)
    const relative = path.join(rel, name)
    const stat = await fsp.lstat(from)
    if (!stat.isDirectory() && !stat.isFile()) throw new Error('无法迁移链接或特殊文件：' + relative)
    yield { from, relative, stat }
    if (stat.isDirectory()) yield* contentEntries(from, await fsp.readdir(from), signal, relative)
  }
}

async function measure(instance, target, signal) {
  let bytes = 0
  let files = 0
  for await (const { stat } of contentEntries(instance.gameDir, instance.content, signal)) {
    if (stat.isFile()) { bytes += stat.size; files++ }
  }
  const disk = await fsp.statfs(target.existing).catch(() => null)
  return { bytes, files, freeBytes: disk ? disk.bavail * disk.bsize : null, root: target.root }
}

export async function previewPrismMigration(value) {
  const dir = await selectedDirectory(value)
  return measure(await readInstance(dir), destination(dir))
}

export async function startPrismMigration(value) {
  const dir = await selectedDirectory(value)
  const instance = await readInstance(dir)
  const target = destination(dir)
  // 只把解析出的 MC 和加载器版本交给安装器；不沿用源启动器的路径、JVM 参数或启动命令。
  return startInstall(instance, async (job, gameDir) => {
    job.phaseLabel('检查迁移空间', dir)
    job.set(null, dir, { indeterminate: true })
    const { bytes, freeBytes } = await measure(instance, target, job.signal)
    if (freeBytes !== null && bytes > freeBytes) throw new Error('目标盘剩余空间不足，无法复制实例内容')
    job.phaseLabel('迁移实例内容', dir)
    let copied = 0
    for await (const { from, relative, stat } of contentEntries(instance.gameDir, instance.content, job.signal)) {
      const to = path.join(gameDir, relative)
      if (stat.isDirectory()) { await fsp.mkdir(to, { recursive: true }); continue }
      job.set(null, '正在复制 ' + relative, { indeterminate: true })
      await pipeline(fs.createReadStream(from), fs.createWriteStream(to, { flags: 'wx' }), { signal: job.signal })
      copied += stat.size
      job.bytes(copied, bytes)
    }
    job.log('实例内容复制完成，准备重建游戏运行环境')
  })
}

export function registerPrismMigrationApi(on, readBody) {
  on('GET', '/api/launcher/import/prism/scan', async (_req, _params, query) => scanPrismInstances(query.dir))
  on('GET', '/api/launcher/import/prism/preview', async (_req, _params, query) => previewPrismMigration(query.dir))
  on('POST', '/api/launcher/import/prism', async (req) => startPrismMigration((await readBody(req)).dir))
}
