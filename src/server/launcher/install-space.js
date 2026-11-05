import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { runPool } from './download.js'
import { collectLibraries, normalizeOs } from './launch-plan.js'
import { readJsonFile, getVersionMeta, fetchJson } from './meta.js'
import { launcherRoot, getSettings } from './state.js'

export async function availableBytes(targetDirectory) {
  let dir = path.resolve(targetDirectory)
  while (true) {
    try {
      const disk = await fsp.statfs(dir)
      return disk.bavail >= 0 ? disk.bavail * disk.bsize : null
    } catch (error) {
      const parent = path.dirname(dir)
      if (error.code !== 'ENOENT' || dir === parent) return null
      dir = parent
    }
  }
}

export async function estimateInstallFiles(entries, { signal } = {}) {
  const unique = new Map(entries.map((item) => [item.path, item]))
  let downloadBytes = 0, cachedBytes = 0, growthBytes = 0, largestPartBytes = 0, unknownFiles = 0
  let reclaimableBytes = 0
  await runPool(unique.values(), async (item) => {
    const size = Number(item.size)
    if (!(size > 0) || !Number.isSafeInteger(size)) { unknownFiles++; return }
    const stat = await fsp.stat(item.path).catch(() => null)
    const existing = stat?.isFile() ? stat.size : 0
    if (existing === size) { cachedBytes += size; return }
    downloadBytes += size
    growthBytes += size - existing
    reclaimableBytes += Math.max(0, existing - size)
    largestPartBytes = Math.max(largestPartBytes, size)
  }, 24, signal)
  // .part 与旧文件同时存在；考虑其他替换先完成、释放空间的情况，只拦截明确不足。
  const minimumFreeBytes = Math.max(0, growthBytes, largestPartBytes - reclaimableBytes)
  return { downloadBytes, cachedBytes, growthBytes: Math.max(0, growthBytes), largestPartBytes, minimumFreeBytes, unknownFiles }
}

export async function estimateInstallSpace({ mc, loader = 'vanilla' }, {
  root = launcherRoot(), settings = getSettings(), signal,
  version, readRemoteIndex
} = {}) {
  const meta = version || await getVersionMeta(mc, { source: settings.source, signal })
  const files = []
  const notes = []
  const add = (file, size) => files.push({ path: path.join(root, file), size })
  add(path.join('versions', mc, mc + '.jar'), meta.downloads?.client?.size)
  const libraries = collectLibraries(meta, { os: normalizeOs({ release: os.release() }) })
  for (const lib of [...libraries.classpath, ...libraries.natives]) add(path.join('libraries', lib.path), lib.size)
  const logging = meta.logging?.client?.file
  if (logging?.id) add(path.join('assets', 'log_configs', logging.id), logging.size)
  const info = meta.assetIndex
  if (settings.downloadAssets !== false && info?.id) {
    const indexPath = path.join('assets', 'indexes', info.id + '.json')
    add(indexPath, info.size)
    let index = await readJsonFile(path.join(root, indexPath))
    if (!index?.objects && info.url) {
      const options = { source: settings.source, signal }
      index = readRemoteIndex ? await readRemoteIndex(info.url, options)
        : await fetchJson(info.url, options).catch(() => null)
      signal?.throwIfAborted()
    }
    if (index?.objects) {
      for (const { hash, size } of Object.values(index.objects)) {
        if (/^[0-9a-f]{40}$/i.test(hash)) add(path.join('assets', 'objects', hash.slice(0, 2), hash), size)
      }
      if (index.virtual || index.map_to_resources) notes.push('旧版资源副本空间待定')
    } else notes.push('资源索引不可用，资源文件大小待定')
  }
  if (loader !== 'vanilla') notes.push('加载器依赖及安装器解压空间待定')
  const totals = await estimateInstallFiles(files, { signal })
  if (totals.unknownFiles) notes.push(totals.unknownFiles + ' 个文件缺少大小')
  const freeBytes = await availableBytes(root)
  return { ...totals, root, freeBytes, notes, insufficient: freeBytes !== null && totals.minimumFreeBytes > freeBytes }
}
