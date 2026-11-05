import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { runPool, sha1File } from './download.js'

const markerName = '.mc-toolbox-pack.json'

export function packIdentity(pack) {
  return {
    source: pack.source, projectId: pack.project.id, versionId: pack.version.id,
    version: pack.version.number || pack.version.name, date: pack.version.date
  }
}

export function packOverrides(meta, directory, dirs) {
  // 与实际复制顺序一致：后复制的 client-overrides / 自定义目录可覆盖同路径文件。
  const prefixes = dirs.map(dir => dir + '/')
  const normalized = new Map([...directory].map(([key, entry]) => [key.replace(/\\/g, '/'), entry]))
  if (meta.kind === 'curseforge' && ![...normalized.keys()].some(key => prefixes.some(prefix => key.startsWith(prefix)))) {
    prefixes.push('')
  }
  const mods = new Map(), configs = new Map()
  for (const item of meta.index?.files || []) {
    if (item?.env?.client !== 'unsupported' && /^(options\.txt$|(?:config|defaultconfigs)\/)/i.test(item?.path)) {
      configs.set(item.path, { key: item.path, label: item.path, digest: item.hashes?.sha1 || item.hashes?.sha512 || String(item.fileSize) })
    }
  }
  for (const prefix of prefixes) {
    for (const [name, entry] of normalized) {
      if (!name.startsWith(prefix) || name.endsWith('/')) continue
      const key = name.slice(prefix.length)
      const item = { key, label: key, digest: 'zip:' + entry.crc32 }
      if (/^mods\/.*\.jar$/i.test(key)) mods.set(key, item)
      else if (/^(options\.txt$|(?:config|defaultconfigs)\/)/i.test(key)) configs.set(key, item)
    }
  }
  return { overrideMods: [...mods.values()], overrideConfigs: [...configs.values()] }
}

export function manifestMods(meta) {
  const mods = new Map()
  if (meta.kind === 'curseforge') {
    for (const item of meta.manifest.files || []) {
      const key = 'CF #' + item.projectID
      mods.set(key, { key, label: key, path: meta.installedPaths?.[item.projectID], digest: String(item.fileID) })
    }
  } else {
    for (const item of meta.index?.files || []) {
      if (item?.env?.client === 'unsupported' || !/^mods\//i.test(item?.path)) continue
      const url = item.downloads?.find(value => /^https:\/\/cdn\.modrinth\.com\/data\/[^/]+\/versions\//i.test(value))
      const key = url ? 'MR ' + url.split('/')[4] + '/' + item.path.split('/').slice(0, -1).join('/') : item.path
      // 同项目可有多个客户端文件，遇到重复时保留独立路径。
      const id = mods.has(key) ? item.path : key
      mods.set(id, { key: id, label: item.path, path: item.path, digest: item.hashes?.sha1 || item.hashes?.sha512 || String(item.fileSize) })
    }
  }
  const byPath = new Map([...mods.values()].map(item => [item.path, item.key]))
  for (const item of meta.overrideMods || []) {
    const key = byPath.get(item.key) || item.key
    mods.set(key, { ...item, key, path: item.key })
  }
  return [...mods.values()]
}

export function compareEntries(before, after) {
  const old = new Map(before.map(item => [item.key, item]))
  const added = [], removed = [], changed = []
  for (const item of after) {
    const prior = old.get(item.key)
    if (!prior) added.push(item.label)
    else if (prior.digest !== item.digest || prior.label !== item.label) {
      if (item.key.startsWith('CF #')) changed.push(item.label + '：文件 ' + prior.digest + ' → ' + item.digest)
      else changed.push(prior.label === item.label ? item.label : prior.label + ' → ' + item.label)
    }
    old.delete(item.key)
  }
  for (const item of old.values()) removed.push(item.label)
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() }
}

export function modConflicts(before, after, local) {
  const paths = new Set([...local.added, ...local.changed, ...local.removed]
    .map(key => key.replace(/\.disabled$/i, '')))
  const original = new Map(before.map(item => [item.key, item]))
  const target = new Map(after.map(item => [item.key, item]))
  const conflicts = [], unmapped = []
  for (const key of new Set([...original.keys(), ...target.keys()])) {
    const a = original.get(key), b = target.get(key)
    if (a && b && a.digest === b.digest && a.label === b.label) continue
    const names = [...new Set([a?.path, b?.path].filter(Boolean))]
    if (names.some(name => paths.has(name))) conflicts.push(key + ' · ' + names.join(' → '))
    if (key.startsWith('CF #') && (!names.length || (b && !b.path))) unmapped.push(key)
  }
  return { conflicts: conflicts.sort(), unmapped: unmapped.sort() }
}

// 旧实例没有安装时的文件基线，只比较实际存在的路径和可对照的 SHA-1。
export function compareInstalledMods(files, mods) {
  const byPath = new Map(mods.filter(item => item.path).map(item => [item.path, item]))
  const matched = new Set(), localOnly = [], different = [], disabled = [], unverified = []
  for (const file of files.filter(item => /^mods\/.*\.jar(?:\.disabled)?$/i.test(item.key))) {
    const key = file.key.replace(/\.disabled$/i, '')
    const target = byPath.get(key)
    if (key !== file.key) disabled.push(file.key)
    if (!target) { localOnly.push(file.key); continue }
    matched.add(key)
    if (!/^[a-f0-9]{40}$/i.test(target.digest)) unverified.push(key)
    else if (target.digest.toLowerCase() !== file.digest) different.push(key)
  }
  return {
    localOnly: localOnly.sort(), targetOnly: [...byPath.keys()].filter(key => !matched.has(key)).sort(),
    different: different.sort(), disabled: disabled.sort(), unverified: unverified.sort(),
    unmapped: mods.filter(item => !item.path).map(item => item.label).sort()
  }
}

export async function localPackFiles(dir, signal) {
  const files = []
  async function visit(rel) {
    signal?.throwIfAborted()
    const target = path.join(dir, rel)
    const stat = await fs.lstat(target).catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (stat?.isFile()) files.push(rel)
    if (stat?.isDirectory()) {
      for (const entry of await fs.readdir(target, { withFileTypes: true })) {
        const child = rel + '/' + entry.name
        if (entry.isFile()) files.push(child)
        else if (entry.isDirectory()) await visit(child)
      }
    }
  }
  for (const rel of ['mods', 'config', 'defaultconfigs', 'options.txt']) await visit(rel)
  const result = []
  await runPool(files, async key => {
    result.push({ key, label: key, digest: await sha1File(path.join(dir, key)) })
  }, 4, signal)
  return result
}

async function readRecord(file) {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile()) throw new Error('整合包安装记录无效')
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

const baselineName = '.mc-toolbox-pack-baseline.json'

export async function readPackMarker(dir, { includeBaseline = false } = {}) {
  const marker = await readRecord(path.join(dir, markerName))
  if (!marker?.hasBaseline || !includeBaseline) return marker
  const baseline = await readRecord(path.join(dir, baselineName))
  return baseline?.versionId === marker.origin?.versionId ? { ...marker, ...baseline } : marker
}

async function writeRecord(file, data) {
  const temp = file + '.' + randomUUID() + '.tmp'
  try {
    await fs.writeFile(temp, JSON.stringify(data), { flag: 'wx' })
    await fs.rename(temp, file)
  } finally { await fs.rm(temp, { force: true }) }
}

export async function writePackMarker(dir, { manifest, configs, local, ...metadata }) {
  if (manifest && local) {
    await writeRecord(path.join(dir, baselineName), { versionId: metadata.origin.versionId, manifest, configs, local })
    metadata.hasBaseline = true
  }
  await writeRecord(path.join(dir, markerName), metadata)
}

const playerOption = /^(key_|soundCategory_|mouseSensitivity$|invertYMouse$|toggleCrouch$|toggleSprint$|autoJump$|touchscreen$|lang$|subtitles$|showSubtitles$|fov$|gamma$|guiScale$)/

export function mergePlayerOptions(original, fresh) {
  const preferences = new Map()
  for (const line of original.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0 && playerOption.test(line.slice(0, i))) preferences.set(line.slice(0, i), line)
  }
  const merged = fresh.trimEnd().split(/\r?\n/).filter(Boolean).map(line => {
    const key = line.slice(0, line.indexOf(':'))
    const preference = preferences.get(key)
    preferences.delete(key)
    return preference || line
  })
  return [...merged, ...preferences.values()].join('\n') + '\n'
}

export async function carryPlayerOptions(oldDir, newDir) {
  async function readOptions(dir) {
    const file = path.join(dir, 'options.txt')
    const stat = await fs.lstat(file).catch(e => { if (e.code !== 'ENOENT') throw e })
    if (!stat) return ''
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('options.txt 无法安全迁移')
    return fs.readFile(file, 'utf8')
  }
  const original = await readOptions(oldDir)
  if (original) await fs.writeFile(path.join(newDir, 'options.txt'), mergePlayerOptions(original, await readOptions(newDir)))
}
