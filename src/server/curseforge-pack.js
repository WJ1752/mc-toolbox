import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { RUNTIME_DIR } from './paths.js'
import { httpFetch } from './http.js'
import { downloadVerified } from './verified-download.js'

// Pin every download to the export's file ID; never substitute a newer mod.
export async function hydrateCurseForgeFiles(root, onProgress, signal, { apiKey = '', cacheDir, fetcher = httpFetch, download = downloadVerified } = {}) {
  let manifest
  try { manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')) } catch { return { downloaded: 0 } }
  if (manifest.manifestType !== 'minecraftModpack' || !Array.isArray(manifest.files)) return { downloaded: 0 }
  const files = manifest.files
  const cache = cacheDir || path.join(RUNTIME_DIR, 'pack-downloads', 'curseforge')
  await fs.mkdir(cache, { recursive: true })
  await fs.mkdir(path.join(root, 'mods'), { recursive: true })
  let done = 0, next = 0
  const errors = []
  const destinations = new Map()
  const worker = async () => {
    while (next < files.length) {
      signal?.throwIfAborted()
      const item = files[next++]
      const id = `${item.projectID}/${item.fileID}`
      try {
        if (!Number.isSafeInteger(item.projectID) || !Number.isSafeInteger(item.fileID)) throw new Error('无效的项目 / 文件编号')
        const metaFile = path.join(cache, `${item.projectID}-${item.fileID}.json`)
        let meta
        try { meta = JSON.parse(await fs.readFile(metaFile, 'utf8')) } catch {}
        if (!meta) {
          const key = apiKey || process.env.CURSEFORGE_API_KEY
          const base = key ? 'https://api.curseforge.com' : 'https://api.curse.tools/v1/cf'
          const url = key ? `${base}/v1/mods/${id.replace('/', '/files/')}` : `${base}/mods/${id.replace('/', '/files/')}`
          const response = await fetcher(url, { headers: key ? { 'x-api-key': key } : {}, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) })
          if (!response.ok) throw new Error(`清单查询失败 HTTP ${response.status}`)
          meta = (await response.json()).data
          if (meta?.id !== item.fileID || meta?.modId !== item.projectID) throw new Error('文件编号校验失败')
          await fs.writeFile(metaFile, JSON.stringify(meta))
        }
        if (meta?.id !== item.fileID || meta?.modId !== item.projectID) throw new Error('缓存文件编号校验失败')
        if (!meta.fileName || path.basename(meta.fileName) !== meta.fileName || /[\\/:]/.test(meta.fileName)) throw new Error('无效的文件名')
        if (!meta.downloadUrl) throw new Error('作者未开放自动下载，请在启动器安装后选择实例文件夹')
        const sha = meta.hashes?.find(h => h.algo === 1)?.value
        if (!sha) throw new Error('缺少 SHA-1 校验值')
        const destinationKey = meta.fileName.toLowerCase()
        if (destinations.has(destinationKey) && destinations.get(destinationKey) !== sha) throw new Error('清单含有同名但内容不同的文件：' + meta.fileName)
        destinations.set(destinationKey, sha)
        const cached = path.join(cache, `${item.fileID}-${meta.fileName}`)
        const existing = await fs.readFile(cached).catch(() => null)
        if (!existing || crypto.createHash('sha1').update(existing).digest('hex') !== sha) {
          await download(meta.downloadUrl, cached, { signal, size: meta.fileLength, hash: sha, algorithm: 'sha1', onProgress: ({ received, total }) => onProgress?.({ stage: 'mods-download', progress: 28 + done / files.length * 15, detail: `CurseForge ${done}/${files.length}：${meta.fileName} · ${Math.round(received / 1024)} / ${Math.round(total / 1024)} KB` }) })
        }
        let folder = 'mods'
        if (!/\.jar$/i.test(meta.fileName)) {
          const key = apiKey || process.env.CURSEFORGE_API_KEY
          const base = key ? 'https://api.curseforge.com/v1' : 'https://api.curse.tools/v1/cf'
          const r = await fetcher(`${base}/mods/${item.projectID}`, { headers: key ? { 'x-api-key': key } : {}, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) })
          if (!r.ok) throw new Error('无法识别清单文件类型')
          const project = (await r.json()).data
          folder = ({ 12: 'resourcepacks', 6552: 'shaderpacks' })[project?.classId]
          if (!folder) throw new Error('清单文件类型暂不支持，请先在启动器安装后选择实例文件夹')
        }
        await fs.mkdir(path.join(root, folder), { recursive: true })
        await fs.copyFile(cached, path.join(root, folder, meta.fileName))
      } catch (e) { signal?.throwIfAborted(); errors.push(`${id}：${e.message}`) }
      done++
      onProgress?.({ stage: 'mods-download', progress: 28 + done / files.length * 15, detail: `已处理 CurseForge 文件 ${done}/${files.length}` })
    }
  }
  const settled = await Promise.allSettled(Array.from({ length: 4 }, worker))
  signal?.throwIfAborted()
  for (const r of settled) if (r.status === 'rejected') throw r.reason
  if (errors.length) throw new Error(`CurseForge 安装包有 ${errors.length} 个文件未能补齐，不能生成完整服务端。请重试（已下载文件会复用）或在启动器安装后选择实例文件夹。\n${errors.join('\n')}`)
  return { downloaded: done, metadataSource: (apiKey || process.env.CURSEFORGE_API_KEY) ? 'CurseForge 官方 API' : 'curse.tools 公共元数据服务；文件来自作者提供的下载地址并校验 SHA-1' }
}
