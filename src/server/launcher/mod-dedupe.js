// 实例 mods 目录去重：
//  - 同一个 modId 的多个文件（不同版本、启用/禁用各一份、重命名复制品）归为一组；
//  - 内容完全相同的 jar 归为一组（同文件换了名字，没有元数据也能认出来）；
//  - 完全没有元数据的 jar 按「去掉版本号的规范文件名」兜底，避免把不同版本当成不同模组。
// 每组给出建议保留项（启用优先 → 版本高优先 → 文件名规范 → 修改时间新），
// 清理时只删除/禁用同组内的多余文件，保留项必须真实存在，路径不能越出 mods 目录。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

const VERSION_START = /^v?\d/i
const PRE_RELEASE = new Set(['alpha', 'beta', 'rc', 'pre', 'preview', 'snapshot', 'dev', 'nightly'])
const COPY_SUFFIX = /\s*\(\d+\)$/

export function normalizeModId(value) {
  // Forge / Fabric 的 modId 大小写不敏感，分隔符也不可靠：yumi-commons-core = yumi_commons_core。
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** 去掉 .jar / .jar.disabled、复制后缀与首尾空白，保留原始大小写。 */
export function fileStem(name) {
  return String(name || '')
    .replace(/\.jar\.disabled$/i, '')
    .replace(/\.jar$/i, '')
    .replace(/\.disabled$/i, '')
    .replace(COPY_SUFFIX, '')
    .trim()
}

/** 用于「没有元数据」兜底的比较键：sodium-fabric-0.5.8 → sodium-fabric。 */
export function canonicalFileStem(name) {
  const stem = fileStem(name).toLowerCase()
  const tokens = stem.split(/[\s._+-]+/).filter(Boolean)
  const kept = tokens.filter((token) => !VERSION_START.test(token))
  return kept.join('-')
}

function versionTokens(value) {
  return String(value || '').toLowerCase().match(/\d+|[a-z]+/g) || []
}

/**
 * 比较两个模组版本号。返回 >0 表示 a 更新。
 * 1.2.10 > 1.2.9；1.20.1-1.1.8-hotfix > 1.20.1-1.1.8；2.0.0 > 2.0.0-rc1。
 */
export function compareModVersions(a, b) {
  const left = versionTokens(a)
  const right = versionTokens(b)
  if (!left.length && !right.length) return 0
  if (!left.length) return -1
  if (!right.length) return 1
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]
    const y = right[i]
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const diff = Number(x) - Number(y)
      if (diff) return diff > 0 ? 1 : -1
      continue
    }
    if (nx !== ny) return nx ? 1 : -1
    return x > y ? 1 : -1
  }
  if (left.length === right.length) return 0
  const longer = left.length > right.length ? left : right
  const extra = longer[Math.min(left.length, right.length)]
  const sign = left.length > right.length ? 1 : -1
  // 1.0.0-rc1 比 1.0.0 旧；1.0.0-hotfix 比 1.0.0 新。
  return PRE_RELEASE.has(extra) ? -sign : sign
}

function hasCopySuffix(file) {
  const stem = String(file || '')
    .replace(/\.jar\.disabled$/i, '')
    .replace(/\.jar$/i, '')
    .replace(/\.disabled$/i, '')
    .trim()
  return /\(\d+\)$/.test(stem)
}

/** 没有元数据时，从文件名尾部取出版本号（sodium-fabric-0.5.9 → 0.5.9）。 */
export function versionFromName(name) {
  const stem = fileStem(name).toLowerCase()
  const match = /(?:^|[-_ ])(v?\d[\w.+-]*)$/.exec(stem)
  return match ? match[1] : ''
}

function itemVersion(item) {
  return item.version || versionFromName(item.file)
}

/** 在一组重复文件里挑出建议保留项，并给出理由。 */
export function recommendKeep(items) {
  const sorted = [...items].sort((a, b) => {
    if (!!a.disabled !== !!b.disabled) return a.disabled ? 1 : -1
    const byVersion = compareModVersions(itemVersion(b), itemVersion(a))
    if (byVersion) return byVersion
    const copyA = hasCopySuffix(a.file) ? 1 : 0
    const copyB = hasCopySuffix(b.file) ? 1 : 0
    if (copyA !== copyB) return copyA - copyB
    if ((b.mtime || 0) !== (a.mtime || 0)) return (b.mtime || 0) - (a.mtime || 0)
    return String(a.relPath).localeCompare(String(b.relPath))
  })
  const keep = sorted[0]
  const others = sorted.slice(1)
  const enabledCount = items.filter((item) => !item.disabled).length
  const keepVersion = itemVersion(keep)
  let reason = '推荐保留'
  if (enabledCount === 1 && !keep.disabled) reason = '唯一启用'
  else if (keepVersion && others.some((item) => itemVersion(item) && compareModVersions(keepVersion, itemVersion(item)) > 0)) reason = '版本更高'
  else if (others.some((item) => hasCopySuffix(item.file)) && !hasCopySuffix(keep.file)) reason = '文件名更规范'
  else if (enabledCount > 1 || !keep.disabled) reason = '文件更新'
  else reason = '保留禁用项'
  return { keep, reason }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * 同一目录里大小相同的文件才需要算哈希；内容相同的复制品大小必然相同。
 * @returns {Promise<Map<string,string>>} relPath → sha256
 */
export async function hashSameSize(items) {
  const bySize = new Map()
  for (const item of items) {
    if (!item?.path || !item?.size) continue
    const list = bySize.get(item.size) || []
    list.push(item)
    bySize.set(item.size, list)
  }
  const hashes = new Map()
  for (const list of bySize.values()) {
    if (list.length < 2) continue
    await Promise.all(list.map(async (item) => {
      try { hashes.set(item.relPath, await sha256File(item.path)) } catch { /* 读不到就不参与哈希比对 */ }
    }))
  }
  return hashes
}

function groupItems(items, { hashes = null } = {}) {
  const parent = items.map((_, index) => index)
  const find = (index) => {
    let current = index
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]]
      current = parent[current]
    }
    return current
  }
  const union = (a, b) => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent[rootB] = rootA
  }

  const byId = new Map()
  const byHash = new Map()
  const byStem = new Map()
  items.forEach((item, index) => {
    const ids = new Set(
      [item.modid, ...(item.modids || [])]
        .map(normalizeModId)
        .filter(Boolean)
    )
    for (const id of ids) {
      if (byId.has(id)) union(index, byId.get(id))
      else byId.set(id, index)
    }
    const digest = hashes?.get(item.relPath)
    if (digest) {
      if (byHash.has(digest)) union(index, byHash.get(digest))
      else byHash.set(digest, index)
    }
    // 只对「完全没有元数据」的 jar 按文件名兜底，避免把不同模组误并到一组。
    if (item.hasMeta !== false) return
    const stem = canonicalFileStem(item.file)
    if (!stem) return
    if (byStem.has(stem)) union(index, byStem.get(stem))
    else byStem.set(stem, index)
  })

  const buckets = new Map()
  items.forEach((item, index) => {
    const root = find(index)
    const list = buckets.get(root) || []
    list.push(item)
    buckets.set(root, list)
  })
  return [...buckets.values()]
}

/**
 * 把扫描结果分组成重复项。items 需要 file / relPath / size / mtime / disabled / version / modid / modids / hasMeta。
 * @returns {Array<object>} 只返回确实有 2 个以上文件的组
 */
export function groupModDuplicates(items, { hashes = null } = {}) {
  const groups = []
  for (const bucket of groupItems(items, { hashes })) {
    if (bucket.length < 2) continue
    const members = bucket.map((item) => ({ ...item, sha256: hashes?.get(item.relPath) || '' }))
    const hashesInGroup = members.map((item) => item.sha256).filter(Boolean)
    const identical = hashesInGroup.length === members.length
      && new Set(hashesInGroup).size === 1
    const { keep, reason } = recommendKeep(members)
    const versions = new Set(members.map((item) => String(itemVersion(item)).toLowerCase()).filter(Boolean))
    const kind = identical ? 'identical' : versions.size > 1 ? 'version' : 'same'
    const modid = members.find((item) => item.modid)?.modid
      || members.find((item) => (item.modids || []).length)?.modids?.[0]
      || ''
    groups.push({
      id: '',
      label: keep.name || fileStem(keep.file) || keep.relPath,
      modid,
      kind,
      identical,
      keep: keep.relPath,
      keepReason: reason,
      reclaimSize: members
        .filter((item) => item.relPath !== keep.relPath)
        .reduce((sum, item) => sum + (Number(item.size) || 0), 0),
      items: members.map((item) => ({
        relPath: item.relPath,
        file: item.file,
        name: item.name || '',
        version: item.version || '',
        size: Number(item.size) || 0,
        mtime: Number(item.mtime) || 0,
        disabled: item.disabled === true,
        sha256: item.sha256,
        keep: item.relPath === keep.relPath
      }))
    })
  }
  groups.sort((a, b) => a.label.localeCompare(b.label) || a.keep.localeCompare(b.keep))
  groups.forEach((group, index) => { group.id = 'dup-' + (index + 1) })
  return groups
}

/** 扫描结果 → 完整报告（含内容哈希与汇总）。 */
export async function analyzeModDuplicates(items) {
  const hashes = await hashSameSize(items)
  const groups = groupModDuplicates(items, { hashes })
  return {
    groups,
    totalGroups: groups.length,
    duplicateItems: groups.reduce((sum, group) => sum + group.items.length - 1, 0),
    reclaimBytes: groups.reduce((sum, group) => sum + group.reclaimSize, 0)
  }
}

/** 解析并校验 mods 目录内的相对路径；越界直接报错。 */
export function resolveModPath(modsDir, relPath) {
  const base = path.resolve(String(modsDir || ''))
  const raw = String(relPath || '').replace(/\\/g, '/')
  if (!raw || raw.split('/').some((part) => part === '..' || part === '')) throw new Error('非法路径')
  const target = path.resolve(base, ...raw.split('/'))
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error('路径超出目录')
  return target
}

async function freeDisabledName(file) {
  if (!/\.jar$/i.test(file)) return file + '.disabled'
  const base = file.slice(0, -4)
  let target = file + '.disabled'
  let index = 1
  while (fs.existsSync(target)) target = `${base}.${index++}.jar.disabled`
  return target
}

/**
 * 执行清理：按组保留 keep，删除/禁用组内其余文件。
 * @param {string} modsDir
 * @param {{mode?:'delete'|'disable', groups?:Array<{keep:string, remove:string[]}>}} plan
 */
export async function cleanupDuplicateMods(modsDir, { mode = 'delete', groups = [] } = {}) {
  const action = mode === 'disable' ? 'disable' : 'delete'
  const done = []
  const failed = []
  const skipped = []
  let freedBytes = 0
  for (const group of Array.isArray(groups) ? groups : []) {
    const keepRel = String(group?.keep || '')
    if (!keepRel) continue
    let keepAbs
    try { keepAbs = resolveModPath(modsDir, keepRel) } catch (error) {
      failed.push({ relPath: keepRel, error: error.message })
      continue
    }
    const keepStat = await fsp.stat(keepAbs).catch(() => null)
    if (!keepStat?.isFile()) {
      failed.push({ relPath: keepRel, error: '保留的文件不存在' })
      continue
    }
    for (const value of Array.isArray(group.remove) ? group.remove : []) {
      const relPath = String(value || '')
      if (!relPath || relPath === keepRel) continue
      try {
        const file = resolveModPath(modsDir, relPath)
        const stat = await fsp.stat(file).catch(() => null)
        if (!stat?.isFile()) {
          failed.push({ relPath, error: '文件不存在' })
          continue
        }
        if (action === 'disable') {
          if (/\.disabled$/i.test(file)) {
            skipped.push({ relPath, reason: '已经是禁用状态' })
            continue
          }
          const target = await freeDisabledName(file)
          await fsp.rename(file, target)
          done.push({ relPath, action: 'disable', to: path.relative(path.resolve(modsDir), target).split(path.sep).join('/') })
        } else {
          await fsp.unlink(file)
          done.push({ relPath, action: 'delete' })
          freedBytes += stat.size
        }
      } catch (error) {
        failed.push({ relPath, error: error.message })
      }
    }
  }
  return { mode: action, done, failed, skipped, freedBytes }
}
