import fs from 'node:fs/promises'
import path from 'node:path'

const mcPattern = /^1\.\d+(?:\.\d+)?$/
const loaders = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge' }
const ignored = new Set(['mods', 'assets', 'saves', 'logs', 'config', 'resourcepacks', '.git', 'node_modules'])

export function mergeRuntime(detected, manual = {}) {
  const result = { ...detected }
  // Changing game/loader invalidates a version inferred for a different runtime.
  if ((manual.mc && manual.mc !== result.mc) || (manual.loader && manual.loader !== result.loader)) result.loaderVersion = ''
  for (const key of ['mc', 'loader', 'loaderVersion']) if (manual[key]?.trim()) result[key] = manual[key].trim()
  return result
}

export async function detectPackRuntime(root, { signal } = {}) {
  const records = []
  async function walk(dir, depth) {
    signal?.throwIfAborted()
    if (depth > 10) return
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (!ignored.has(ent.name.toLowerCase())) await walk(file, depth + 1)
      } else if (ent.isFile()) {
        const name = path.relative(root, file)
        if (/^forge-.*\.jar$/i.test(ent.name)) records.push({ name, text: '' })
        if (/\.(json|bat|cmd|sh)$/i.test(ent.name) && (await fs.stat(file)).size <= 2 * 1024 * 1024) {
          records.push({ name, text: await fs.readFile(file, { encoding: 'utf8', signal }) })
        }
      }
    }
  }
  await walk(root, 0)
  return detectRuntimeRecords(records)
}

export function detectRuntimeRecords(records) {
  const candidates = []
  const add = (value, file, priority) => {
    if (!mcPattern.test(value.mc || '') || !value.loaderVersion) return
    candidates.push({ ...value, source: file, priority })
  }
  const forge = (value, file, priority) => {
    const m = /(?:^|[^a-z])forge[-:](1\.\d+(?:\.\d+)?)-(\d+(?:\.\d+){2,}(?:-1\.\d+(?:\.\d+)?)?)(?=$|[^\d])/i.exec(value)
    if (m) add({ mc: m[1], loader: 'forge', loaderVersion: m[2] }, file, priority)
  }
  for (const { name: file, text = '' } of records) {
    if (/^forge-.*\.jar$/i.test(path.basename(file))) forge(path.basename(file), file, 30)
    if (!/\.json$/i.test(file)) { forge(text, file, 40); continue }
    let d
    try { d = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { continue }
    if (!d || typeof d !== 'object') continue
    // HMCL exports use addons, despite sharing the manifest.json filename.
    const addons = Array.isArray(d.addons) ? d.addons : []
    const game = addons.find(x => x?.id === 'game')?.version
    for (const [id, loader] of Object.entries({ ...loaders, fabric: 'fabric', quilt: 'quilt' })) {
      const version = addons.find(x => x?.id === id)?.version
      if (version) add({ mc: game, loader, loaderVersion: version }, file, 100)
    }
    if (d.minecraft?.version && Array.isArray(d.minecraft.modLoaders)) {
      const l = d.minecraft.modLoaders.find(x => x?.primary) || d.minecraft.modLoaders[0]
      const m = /^(forge|neoforge|fabric(?:-loader)?|quilt(?:-loader)?)-(.+)$/.exec(l?.id || '')
      if (m) add({ mc: d.minecraft.version, loader: m[1].replace('-loader', ''), loaderVersion: m[2] }, file, 100)
    }
    for (const [id, loader] of Object.entries(loaders)) {
      if (d.dependencies?.[id]) add({ mc: d.dependencies.minecraft, loader, loaderVersion: d.dependencies[id] }, file, 100)
    }
    const components = Array.isArray(d.components) ? d.components : []
    const mc = components.find(x => x?.uid === 'net.minecraft')?.version
    for (const [uid, loader] of [['net.minecraftforge', 'forge'], ['net.neoforged', 'neoforge'], ['net.fabricmc.fabric-loader', 'fabric'], ['org.quiltmc.quilt-loader', 'quilt']]) {
      const version = components.find(x => x?.uid === uid)?.version
      if (version) add({ mc, loader, loaderVersion: version }, file, 100)
    }
    // HMCL/PCL/official launcher version JSON: inheritsFrom + Maven coordinates.
    for (const lib of Array.isArray(d.libraries) ? d.libraries : []) {
      const name = lib?.name || ''
      forge(name, file, 80)
      const m = /^(net\.fabricmc:fabric-loader|org\.quiltmc:quilt-loader|net\.neoforged:neoforge):([^:]+)/.exec(name)
      if (m) add({ mc: d.inheritsFrom, loader: m[1].includes('fabric') ? 'fabric' : m[1].includes('quilt') ? 'quilt' : 'neoforge', loaderVersion: m[2] }, file, 80)
      const modernForge = /^net\.minecraftforge:forge:([^:]+)$/.exec(name)
      if (modernForge && !modernForge[1].startsWith('1.')) add({ mc: d.inheritsFrom, loader: 'forge', loaderVersion: modernForge[1] }, file, 80)
    }
  }
  if (!candidates.length) return null
  const top = candidates.filter(x => x.priority === Math.max(...candidates.map(x => x.priority)))
  const unique = new Map(top.map(x => [`${x.mc}/${x.loader}/${x.loaderVersion}`, x]))
  if (unique.size > 1) throw new Error('检测到多个游戏版本：' + [...unique.keys()].join('、') + '。请选择具体实例目录，或手动填写完整的 MC、加载器及版本。')
  const { priority, ...result } = top[0]
  return result
}

// Pick the actual game directory, including wrapper folders and isolated launcher instances.
export async function findPackRoot(root, runtime, signal) {
  if (runtime?.source && /(?:manifest|modrinth\.index)\.json$/i.test(runtime.source)) return path.dirname(path.join(root, runtime.source))
  if (runtime?.source) {
    let dir = path.dirname(path.join(root, runtime.source))
    while (dir.startsWith(root)) {
      if ((await fs.stat(path.join(dir, 'mods')).catch(() => null))?.isDirectory()) return dir
      if (dir === root) break
      dir = path.dirname(dir)
    }
  }
  const found = []
  async function walk(dir, depth) {
    signal?.throwIfAborted()
    if (depth > 8) return
    const entries = await fs.readdir(dir, { withFileTypes: true })
    if (entries.some(e => e.isDirectory() && e.name === 'mods')) { found.push(dir); return }
    for (const e of entries) if (e.isDirectory() && !ignored.has(e.name.toLowerCase()) && e.name !== 'client-overrides') await walk(path.join(dir, e.name), depth + 1)
  }
  await walk(root, 0)
  if (found.length > 1) throw new Error('发现多个 mods 实例目录，请选择需要转换的具体实例文件夹。')
  return found[0] || root
}
