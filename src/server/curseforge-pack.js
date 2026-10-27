import fsp from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { RUNTIME_DIR } from './paths.js'
import { httpFetch } from './http.js'
import { downloadVerified } from './verified-download.js'

// CurseForge 清单里的 classId → 实例内目录。只列客户端整合包会用到的类型；
// 未知类型跳过并记录，而不是让整个整合包安装失败。
const CLASS_FOLDERS = {
  6: 'mods',
  12: 'resourcepacks',
  6552: 'shaderpacks',
  6945: 'datapacks',
  17: 'saves'
}

// 作者禁止第三方下载时，这些内容缺失不会让整合包无法启动：直接跳过并给出清单。
// mods（6）缺失则会缺代码，必须让用户补齐后再装，不能静默继续。
const OPTIONAL_FOLDERS = new Set(['resourcepacks', 'shaderpacks', 'datapacks'])

// Pin every download to the export's file ID; never substitute a newer mod.
export async function hydrateCurseForgeFiles(root, onProgress, signal, { apiKey = '', cacheDir, fetcher = httpFetch, download = downloadVerified } = {}) {
  const manifestPath = path.join(root, 'manifest.json')
  let raw
  try {
    raw = await fsp.readFile(manifestPath, 'utf8')
  } catch (e) {
    // 没有 manifest 说明不是 CurseForge 包（转换器会用它探测）；读不出来则要报错。
    if (e?.code === 'ENOENT') return { downloaded: 0 }
    throw new Error('读取 manifest.json 失败：' + (e?.message || '未知错误'))
  }
  let manifest
  try {
    manifest = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('manifest.json 无法解析，整合包可能已损坏')
  }
  if (manifest?.manifestType !== 'minecraftModpack') return { downloaded: 0 }
  if (!Array.isArray(manifest.files)) throw new Error('manifest.json 的 files 字段格式无效')

  const files = manifest.files
  const cache = cacheDir || path.join(RUNTIME_DIR, 'pack-downloads', 'curseforge')
  await fsp.mkdir(cache, { recursive: true })
  await fsp.mkdir(path.join(root, 'mods'), { recursive: true })
  let done = 0
  let next = 0
  const errors = []
  const skipped = []
  const blocked = []
  const destinations = new Map()
  const projectCache = new Map()

  const apiBase = () => (apiKey || process.env.CURSEFORGE_API_KEY ? 'https://api.curseforge.com/v1' : 'https://api.curse.tools/v1/cf')
  const headersFor = () => {
    const key = apiKey || process.env.CURSEFORGE_API_KEY
    return key ? { 'x-api-key': key } : {}
  }
  const request = async (url) => {
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetcher(url, {
          headers: headersFor(),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
        })
        if (!response.ok) throw new Error(`清单查询失败 HTTP ${response.status}`)
        return await response.json()
      } catch (e) {
        if (signal?.aborted) throw e
        lastError = e
      }
    }
    throw lastError || new Error('清单查询失败')
  }

  /** 非 .jar 文件需要按 classId 决定落到哪个目录；顺带拿到项目名与网页地址（用于手动下载清单）。 */
  const resolveProject = async (projectId) => {
    if (projectCache.has(projectId)) return projectCache.get(projectId)
    const body = await request(`${apiBase()}/mods/${projectId}`)
    const data = body?.data || {}
    const info = {
      folder: CLASS_FOLDERS[Number(data.classId)] || '',
      title: String(data.name || ''),
      url: String(data.links?.websiteUrl || '')
    }
    projectCache.set(projectId, info)
    return info
  }

  const looksValid = async (file, sha) => {
    try {
      const stat = await fsp.stat(file)
      if (!stat.isFile() || !stat.size) return false
      const digest = crypto.createHash('sha1')
      for await (const chunk of fsSync.createReadStream(file)) {
        signal?.throwIfAborted()
        digest.update(chunk)
      }
      return digest.digest('hex') === sha
    } catch {
      return false
    }
  }

  const worker = async () => {
    while (next < files.length) {
      signal?.throwIfAborted()
      const index = next++
      const item = files[index]
      if (!item || typeof item !== 'object') {
        errors.push(`清单第 ${index + 1} 项格式无效`)
        done++
        continue
      }
      const projectId = Number(item.projectID)
      const fileId = Number(item.fileID)
      const id = `${item.projectID}/${item.fileID}`
      let skip = ''
      let meta = null
      try {
        if (!Number.isSafeInteger(projectId) || !Number.isSafeInteger(fileId)) throw new Error('无效的项目 / 文件编号')
        const metaFile = path.join(cache, `${projectId}-${fileId}.json`)
        try { meta = JSON.parse(await fsp.readFile(metaFile, 'utf8')) } catch {}
        if (!meta) {
          const body = await request(`${apiBase()}/mods/${projectId}/files/${fileId}`)
          meta = body?.data
          if (meta?.id !== fileId || meta?.modId !== projectId) throw new Error('文件编号校验失败')
          await fsp.writeFile(metaFile, JSON.stringify(meta))
        }
        if (meta?.id !== fileId || meta?.modId !== projectId) throw new Error('缓存文件编号校验失败')
        if (!meta.fileName || path.basename(meta.fileName) !== meta.fileName || /[\\/:]/.test(meta.fileName)) throw new Error('无效的文件名')
        const sha = meta.hashes?.find(h => h.algo === 1)?.value
        if (!sha) throw new Error('缺少 SHA-1 校验值')

        let folder = 'mods'
        let project = null
        if (!/\.jar$/i.test(meta.fileName)) {
          project = await resolveProject(projectId)
          folder = project.folder
          if (!folder) {
            // 世界/数据包等客户端整合包很少用到的类目：跳过，不让整包安装失败。
            skip = '未知文件类型'
            skipped.push(`${id}（${meta.fileName}）`)
            throw new Error('__skip__')
          }
        }

        // 同名文件只有落在同一目录才算冲突（mod 与资源包同名是允许的）。
        const destinationKey = `${folder}/${meta.fileName.toLowerCase()}`
        if (destinations.has(destinationKey) && destinations.get(destinationKey) !== sha) {
          throw new Error('清单含有同名但内容不同的文件：' + meta.fileName)
        }
        destinations.set(destinationKey, sha)

        const cacheFile = path.join(cache, `${fileId}-${meta.fileName}`)
        const localCandidates = [
          cacheFile,
          path.join(root, folder, meta.fileName),
          path.join(root, 'mods', meta.fileName),
          path.join(root, 'resourcepacks', meta.fileName),
          path.join(root, 'shaderpacks', meta.fileName)
        ]
        let cached = ''
        for (const candidate of localCandidates) {
          if (await looksValid(candidate, sha)) { cached = candidate; break }
        }
        if (!cached && !meta.downloadUrl) {
          // 作者禁止第三方启动器自动下载。用户若已手动放入同 SHA-1 的文件，
          // 上面的候选路径会命中；否则记录下来交给调用方汇总成可操作清单。
          blocked.push({
            id,
            projectId,
            fileId,
            fileName: meta.fileName,
            folder,
            title: project?.title || '',
            url: project?.url || ''
          })
          throw new Error('__blocked__')
        }
        if (!cached) {
          cached = cacheFile
          await download(meta.downloadUrl, cached, {
            signal,
            hash: sha,
            algorithm: 'sha1',
            onProgress: ({ received, total }) => onProgress?.({ stage: 'mods-download', progress: 28 + done / files.length * 15, detail: `CurseForge ${done}/${files.length}：${meta.fileName} · ${Math.round(received / 1024)} / ${Math.round(total / 1024)} KB` })
          })
        }
        await fsp.mkdir(path.join(root, folder), { recursive: true })
        await fsp.copyFile(cached, path.join(root, folder, meta.fileName))
      } catch (e) {
        signal?.throwIfAborted()
        if (e.message === '__skip__') { if (!skip) skipped.push(`${id}（${meta?.fileName || '未知文件'}）`) }
        else if (e.message !== '__blocked__') errors.push(`${id}：${e.message}`)
      }
      done++
      onProgress?.({ stage: 'mods-download', progress: 28 + done / files.length * 15, detail: `已处理 CurseForge 文件 ${done}/${files.length}` })
    }
  }
  const settled = await Promise.allSettled(Array.from({ length: 4 }, worker))
  signal?.throwIfAborted()
  for (const r of settled) if (r.status === 'rejected') throw r.reason
  if (skipped.length) onProgress?.({ stage: 'mods-download', progress: 43, detail: `已跳过 ${skipped.length} 个未知类型文件：${skipped.slice(0, 3).join('、')}` })
  // 缺失的只有光影 / 资源包 / 数据包时，整合包仍然可以启动：跳过它们并在任务日志里
  // 给出完整清单，而不是把已经下好的几十 GB 内容连带实例一起丢掉。
  const requiredBlocked = blocked.filter((item) => !OPTIONAL_FOLDERS.has(item.folder))
  if (blocked.length && (requiredBlocked.length || errors.length)) {
    const error = new Error(blockedFilesMessage(blocked, errors))
    error.code = requiredBlocked.length ? 'CF_RESTRICTED' : 'CF_FILES'
    error.blocked = blocked
    throw error
  }
  if (errors.length) {
    throw new Error(`CurseForge 整合包有 ${errors.length} 个文件未能补齐。请检查网络后重试（已下载文件会复用），或改用 CurseForge 官方启动器安装。\n${errors.join('\n')}`)
  }
  if (blocked.length) {
    onProgress?.({ stage: 'mods-blocked', progress: 43, detail: `有 ${blocked.length} 个文件被作者禁止第三方下载，已跳过` })
  }
  return {
    downloaded: done,
    skipped: skipped.length,
    blocked,
    metadataSource: (apiKey || process.env.CURSEFORGE_API_KEY)
      ? 'CurseForge 官方 API'
      : 'curse.tools 公共元数据服务；文件来自作者提供的下载地址并校验 SHA-1'
  }
}

/**
 * 作者禁止第三方下载的文件清单：编号 + 文件名（错误提示会进 toast，保持简短），
 * 完整清单（含项目网页地址）由安装任务逐条写进日志和实例目录。
 */
export function blockedFilesMessage(blocked, errors = [], { limit = 5 } = {}) {
  const list = Array.isArray(blocked) ? blocked : []
  const shown = list.slice(0, limit).map((item) => `${item.id}（${item.fileName}）`)
  const more = list.length > shown.length ? ` 等 ${list.length} 个` : ''
  const total = list.length + (Array.isArray(errors) ? errors.length : 0)
  const parts = [`CurseForge 整合包有 ${total} 个文件未能补齐。`]
  if (list.length) {
    parts.push(
      `其中 ${list.length} 个文件被作者设置为「禁止第三方启动器自动下载」：${shown.join('、')}${more}。` +
      '请用 CurseForge 官方启动器安装一次，或在浏览器中手动下载后放入实例的 mods / resourcepacks / shaderpacks 目录。' +
      '已下载的文件与实例会保留，补齐后重新安装不会重复下载；完整清单与网页地址见任务日志和实例目录 .mc-toolbox-missing-files.txt。'
    )
  }
  if (Array.isArray(errors) && errors.length) parts.push(errors.join('\n'))
  return parts.join('\n')
}
