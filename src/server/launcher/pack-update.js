import { store } from '../store.js'
import { findInstance, instancePaths } from './state.js'
import { resolveOnlinePack } from './pack-online.js'
import { startOnlinePackInstall, getJobDelta, cancelJob } from './install.js'
import {
  packIdentity, manifestMods, modConflicts, compareEntries, compareInstalledMods, localPackFiles, readPackMarker, writePackMarker, carryPlayerOptions
} from './pack-baseline.js'

const reviews = new Map()

async function instancePack(id, includeBaseline = false) {
  const inst = findInstance(id)
  if (!inst) throw new Error('实例不存在')
  const dir = instancePaths(inst).gameDir
  return { inst, dir, marker: await readPackMarker(dir, { includeBaseline }) }
}

function resolve(origin, versionId) {
  return resolveOnlinePack({
    source: origin.source, projectId: origin.projectId, versionId,
    apiKey: store.get('settings', {})?.community?.cfApiKey || ''
  })
}

export function isNewerPack(current, latest) {
  if (String(current.versionId) === String(latest.versionId)) return false
  const before = Date.parse(current.date), after = Date.parse(latest.date)
  return Number.isFinite(before) && Number.isFinite(after) && after > before
}

function reviewStatus(id) {
  const entry = reviews.get(id)
  if (!entry) return null
  const job = getJobDelta(entry.jobId, Number.MAX_SAFE_INTEGER)
  if (!job || ['done', 'failed', 'cancelled'].includes(job.status)) {
    reviews.delete(id)
    return job ? { job } : null
  }
  return { job, preview: entry.preview, approved: entry.approved }
}

async function check(id) {
  const active = reviewStatus(id)
  if (active && !['done', 'failed', 'cancelled'].includes(active.job.status)) return { active }
  const { inst, marker } = await instancePack(id)
  if (!marker?.origin) return { untracked: true, bindable: !!marker && !inst.external }
  const latest = packIdentity(await resolve(marker.origin, ''))
  if (latest.projectId !== marker.origin.projectId) throw new Error('官方返回的项目与安装记录不一致')
  return { current: marker.origin, latest, available: isNewerPack(marker.origin, latest) }
}

async function bind(id, body) {
  const { inst, dir, marker } = await instancePack(id)
  if (!marker || inst.external || marker.origin) throw new Error('仅可关联缺少来源记录的本地整合包实例')
  if (!body.projectId || !body.versionId) throw new Error('请填写官方项目 ID 与当前已安装的版本 ID')
  const pack = await resolve(body, body.versionId)
  if (pack.version.gameVersions?.length && !pack.version.gameVersions.includes(inst.mc)) throw new Error('所选官方版本与实例的 Minecraft 版本不一致')
  await writePackMarker(dir, { ...marker, origin: packIdentity(pack) })
  return { ok: true }
}

async function prepare(id, body) {
  const { inst, dir, marker } = await instancePack(id, true)
  if (!marker?.origin) throw new Error('缺少整合包来源记录')
  const { current, latest, available, active } = await check(id)
  if (active) return active
  if (!available || body.versionId !== latest.versionId || current.versionId !== marker.origin.versionId) {
    throw new Error('可更新版本已改变，请重新检查')
  }
  const already = reviews.get(id)
  if (already) return reviewStatus(id)
  const entry = { jobId: '', preview: null, approved: false, accept: null }
  const { job } = startOnlinePackInstall({
    source: current.source, projectId: current.projectId, versionId: latest.versionId,
    name: inst.name + ' · ' + latest.version, memory: inst.memory, javaPath: inst.javaPath, group: inst.group
  }, {
    review: async (task, meta) => {
      const files = await localPackFiles(dir, task.signal)
      task.signal.throwIfAborted()
      const local = Array.isArray(marker.local) ? compareEntries(marker.local, files) : null
      const configs = Array.isArray(marker.configs) ? compareEntries(marker.configs, meta.overrideConfigs || []) : null
      const localPaths = new Set(local ? [...local.added, ...local.changed, ...local.removed] : [])
      const mods = manifestMods(meta)
      const modReview = Array.isArray(marker.manifest) && local ? modConflicts(marker.manifest, mods, local) : null
      entry.preview = {
        current, latest, mc: [inst.mc, meta.mc], loader: [inst.loader + ' ' + inst.loaderVersion, meta.loader + ' ' + meta.loaderVersion],
        manifest: Array.isArray(marker.manifest) ? compareEntries(marker.manifest, mods) : null,
        local, configs, modReview, installedComparison: modReview ? null : compareInstalledMods(files, mods),
        conflicts: configs && local ? [...configs.added, ...configs.changed, ...configs.removed].filter(name => localPaths.has(name)) : null
      }
      task.phaseLabel('审阅整合包差异', '等待确认后创建新实例')
      await new Promise((ok, fail) => {
        const abort = () => finish(() => fail(new Error('已取消整合包更新预览')))
        const timer = setTimeout(() => finish(() => fail(new Error('差异预览已过期，请重新检查'))), 30 * 60 * 1000)
        timer.unref()
        const finish = (end) => {
          clearTimeout(timer)
          task.signal.removeEventListener('abort', abort)
          entry.accept = null
          end()
        }
        task.signal.addEventListener('abort', abort, { once: true })
        entry.accept = () => finish(ok)
      })
    },
    afterContents: async (task, target) => {
      if (entry.keepOptions) {
        await carryPlayerOptions(dir, target)
        task.log('已合并原实例的玩家按键、声音及显示偏好')
      }
    }
  })
  entry.jobId = job.id
  reviews.set(id, entry)
  return { job }
}

export function registerPackUpdateApi(on, { readBody }) {
  const route = '/api/launcher/instances/:id/pack-update'
  on('GET', route, (_req, p) => check(p.id))
  on('POST', route + '/bind', async (req, p) => bind(p.id, await readBody(req)))
  on('POST', route + '/prepare', async (req, p) => prepare(p.id, await readBody(req)))
  on('GET', route + '/review', (_req, p) => reviewStatus(p.id) || {})
  on('POST', route + '/apply', async (req, p) => {
    const body = await readBody(req)
    const entry = reviews.get(p.id)
    if (!entry?.accept || body.jobId !== entry.jobId) throw new Error('预览已失效，请重新检查')
    entry.keepOptions = body.keepOptions !== false
    entry.approved = true
    entry.preview = null
    entry.accept()
    return { jobId: entry.jobId }
  })
  on('POST', route + '/cancel', async (req, p) => {
    const body = await readBody(req)
    const entry = reviews.get(p.id)
    if (!entry || body.jobId !== entry.jobId || entry.approved) throw new Error('预览已结束')
    cancelJob(entry.jobId)
    return { ok: true }
  })
}
