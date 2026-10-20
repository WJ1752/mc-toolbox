// 启动器 REST API —— 由 src/server/api.js 注册到现有路由表。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  LOADERS,
  getSettings,
  updateSettings,
  listInstances,
  findInstance,
  publicInstance,
  updateInstance,
  deleteInstance,
  duplicateInstance,
  setSelectedInstance,
  getSelectedInstanceId,
  launcherRoot
} from './state.js'
import {
  listGameVersions,
  listLoaderVersions,
  getVersionMeta,
  supportedLoaders
} from './meta.js'
import {
  startInstall,
  startRepair,
  startPackInstall,
  startModUpdates,
  getJob,
  getJobDelta,
  listJobs,
  cancelJob,
  clearFinishedJobs,
  readPackSummary
} from './install.js'
import { findModUpdates, resolveMissingDependencies } from './updates.js'
import {
  prepareLaunch,
  startInstance,
  stopInstance,
  getSessionSnapshot,
  launchStatus,
  readLog,
  readSavedLog,
  listSessions,
  hasRunningGame
} from './launch.js'
import { discoverJava, clearJavaCache } from './java.js'
import { requiredJavaMajor } from './launch-plan.js'
import * as accounts from './accounts.js'
import * as content from './content.js'
import { scanExisting, importExisting, defaultMinecraftDirs } from './import.js'
import { getNews } from './news.js'
import { receiveUploadedPack } from '../pack-converter.js'
import { RUNTIME_DIR } from '../paths.js'

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8'
}

function instanceOf(id) {
  const inst = findInstance(id)
  if (!inst) throw new Error('实例不存在')
  return inst
}

function safeInt(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

function filterSettings(settings) {
  return {
    ...settings,
    root: launcherRoot(),
    java: {
      default: settings.defaultJava || ''
    }
  }
}

async function launcherStatusPayload() {
  const instances = listInstances()
  const accountsInfo = accounts.listAccounts()
  return {
    instances,
    accounts: accountsInfo,
    selectedInstance: getSelectedInstanceId() || instances[0]?.id || '',
    sessions: listSessions(),
    jobs: listJobs(),
    running: hasRunningGame(),
    root: launcherRoot(),
    loaders: LOADERS
  }
}

export function registerLauncherApi(on, { readBody, readRawBody }) {
  /* ---------------- bootstrap / settings ---------------- */
  on('GET', '/api/launcher/bootstrap', async () => {
    const data = await launcherStatusPayload()
    return {
      ...data,
      settings: filterSettings(getSettings()),
      defaultDirs: defaultMinecraftDirs(),
      system: {
        platform: process.platform,
        arch: process.arch,
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        cpus: os.cpus()?.length || 0
      }
    }
  })

  on('GET', '/api/launcher/settings', async () => filterSettings(getSettings()))
  on('PUT', '/api/launcher/settings', async (req) => {
    const body = await readBody(req)
    const allowed = [
      'root', 'source', 'concurrency', 'retries', 'verify', 'defaultMemory', 'defaultMinMemory',
      'defaultJava', 'jvmArgs', 'gameArgs', 'closeOnLaunch', 'showLog', 'msClientId', 'downloadAssets',
      'defaultWidth', 'defaultHeight', 'defaultGroup'
    ]
    const patch = {}
    for (const key of allowed) if (body[key] !== undefined) patch[key] = body[key]
    const settings = updateSettings(patch)
    return filterSettings(settings)
  })

  /* ---------------- status / sessions ---------------- */
  on('GET', '/api/launcher/status', async () => await launcherStatusPayload())
  on('GET', '/api/launcher/sessions', async () => ({ items: listSessions() }))

  /* ---------------- instances ---------------- */
  on('GET', '/api/launcher/instances', async () => ({ items: listInstances() }))
  on('GET', '/api/launcher/instances/:id', async (_req, params) => {
    const inst = instanceOf(params.id)
    return {
      instance: publicInstance(inst),
      status: await launchStatus(inst.id),
      summary: await content.instanceContentSummary(inst).catch((e) => ({ error: e.message }))
    }
  })
  on('PUT', '/api/launcher/instances/:id', async (req, params) => {
    const body = await readBody(req)
    const allowed = ['name', 'group', 'memory', 'javaPath', 'jvmArgs', 'gameArgs', 'width', 'height', 'fullscreen', 'server', 'autoConnect', 'checkFiles', 'notes', 'icon']
    const patch = {}
    for (const key of allowed) if (body[key] !== undefined) patch[key] = body[key]
    return publicInstance(updateInstance(params.id, patch))
  })
  on('DELETE', '/api/launcher/instances/:id', async (_req, params) => {
    instanceOf(params.id)
    return deleteInstance(params.id)
  })
  on('POST', '/api/launcher/instances/:id/duplicate', async (req, params) => {
    const body = await readBody(req)
    return await duplicateInstance(params.id, { name: body.name || '' })
  })
  on('POST', '/api/launcher/instances/:id/select', async (_req, params) => {
    instanceOf(params.id)
    return { selectedInstance: setSelectedInstance(params.id) }
  })
  on('POST', '/api/launcher/instances/:id/repair', async (_req, params) => {
    instanceOf(params.id)
    return startRepair(params.id)
  })

  /* ---------------- launch / stop / logs ---------------- */
  on('POST', '/api/launcher/instances/:id/launch', async (req, params) => {
    const body = await readBody(req)
    const session = await startInstance(params.id, { accountId: body.accountId || '' })
    return { ok: true, session }
  })
  on('POST', '/api/launcher/instances/:id/stop', async (req, params) => {
    const body = await readBody(req)
    return await stopInstance(params.id, { force: body.force === true })
  })
  on('GET', '/api/launcher/instances/:id/preview', async (_req, params) => {
    const plan = await prepareLaunch(params.id)
    return {
      preview: plan.preview,
      java: { path: plan.java.path, major: plan.java.major, version: plan.java.version },
      requiredJava: plan.javaMajor,
      missing: plan.missing,
      account: plan.account?.name || '',
      versionName: plan.vars?.version_name || '',
      notes: [
        plan.missing.length ? `缺少 ${plan.missing.length} 个文件，请先修复。` : '',
        plan.clientJar ? '' : '未找到客户端 JAR',
        plan.javaagent ? '将加载 authlib-injector。' : ''
      ].filter(Boolean)
    }
  })
  on('GET', '/api/launcher/instances/:id/status', async (_req, params) => await launchStatus(params.id))
  on('GET', '/api/launcher/instances/:id/log', async (_req, params, query) => {
    const inst = instanceOf(params.id)
    if (query.saved === '1' || query.source) {
      return await readSavedLog(inst.id, query.file || '')
    }
    const live = readLog(inst.id, safeInt(query.after))
    if (!live.lines.length && !live.running) {
      const disk = await readSavedLog(inst.id).catch(() => null)
      if (disk) return { ...live, lines: disk.lines, saved: disk.name }
    }
    return live
  })
  on('GET', '/api/launcher/instances/:id/crash', async (_req, params, query) => {
    const inst = instanceOf(params.id)
    return await content.readCrashReport(inst, query.file || '')
  })

  /* ---------------- content ---------------- */
  on('GET', '/api/launcher/instances/:id/content', async (_req, params, query) => {
    const inst = instanceOf(params.id)
    switch (query.type) {
      case 'mods': return await content.listMods(inst)
      case 'resourcepacks': return await content.listResourcePacks(inst)
      case 'shaderpacks': return await content.listShaderPacks(inst)
      case 'worlds': return await content.listInstanceWorlds(inst)
      case 'screenshots': return await content.listScreenshots(inst)
      case 'servers': return await content.readServers(inst)
      case 'logs': return await content.listLogs(inst)
      case 'summary': return await content.instanceContentSummary(inst)
      case 'log': return await content.readLogFile(inst, query.source || 'launcher', query.file || '')
      case 'crash': return await content.readCrashReport(inst, query.file || '')
      default: throw new Error('未知的内容类型：' + (query.type || '空'))
    }
  })

  on('POST', '/api/launcher/instances/:id/mods/toggle', async (req, params) => {
    const body = await readBody(req)
    const inst = instanceOf(params.id)
    if (!body.path) throw new Error('缺少模组路径')
    return await content.setModEnabled(inst, body.path, body.enabled !== false)
  })
  on('POST', '/api/launcher/instances/:id/mods/delete', async (req, params) => {
    const body = await readBody(req)
    const inst = instanceOf(params.id)
    if (!body.path) throw new Error('缺少模组路径')
    return await content.deleteMod(inst, body.path)
  })
  on('GET', '/api/launcher/instances/:id/mods/updates', async (_req, params, query) => {
    const inst = instanceOf(params.id)
    return await findModUpdates(inst, { force: query.force === '1' })
  })
  on('POST', '/api/launcher/instances/:id/mods/update', async (req, params) => {
    const body = await readBody(req)
    instanceOf(params.id)
    const items = (Array.isArray(body.items) ? body.items : []).map((item) => ({
      relPath: String(item?.relPath || ''),
      name: String(item?.name || ''),
      url: String(item?.url || ''),
      filename: String(item?.filename || ''),
      sha1: String(item?.sha1 || '').toLowerCase(),
      size: Number(item?.size) || 0
    })).filter((item) => item.relPath && item.url)
    return startModUpdates(params.id, items)
  })
  on('GET', '/api/launcher/instances/:id/mods/missing', async (_req, params) => {
    const inst = instanceOf(params.id)
    return await resolveMissingDependencies(inst)
  })
  on('POST', '/api/launcher/instances/:id/content/delete', async (req, params) => {
    const body = await readBody(req)
    const inst = instanceOf(params.id)
    return await content.deleteContent(inst, body.type, body.name)
  })
  on('POST', '/api/launcher/instances/:id/resourcepack', async (req, params) => {
    const body = await readBody(req)
    const inst = instanceOf(params.id)
    return await content.setResourcePackEnabled(inst, body.name, body.enabled !== false)
  })
  on('POST', '/api/launcher/instances/:id/servers', async (req, params) => {
    const body = await readBody(req)
    const inst = instanceOf(params.id)
    if (body.action === 'add') return await content.addServer(inst, body)
    if (body.action === 'update') return await content.updateServer(inst, Number(body.index), body)
    if (body.action === 'delete') return await content.deleteServer(inst, Number(body.index))
    throw new Error('未知的服务器操作')
  })
  on('POST', '/api/launcher/instances/:id/upload', async (req, params, query) => {
    const inst = instanceOf(params.id)
    const type = String(query.type || '')
    const name = decodeURIComponent(String(req.headers['x-file-name'] || ''))
    const buffer = await readRawBody(req, 512 * 1024 ** 2)
    if (!buffer.length) throw new Error('没有收到文件内容')
    return await content.writeUpload(inst, type, name, buffer)
  })
  on('GET', '/api/launcher/instances/:id/file', async (_req, params, query, res) => {
    const inst = instanceOf(params.id)
    const scope = String(query.scope || 'screenshots')
    if (scope !== 'screenshots') throw new Error('不支持的文件范围')
    const file = content.screenshotPath(inst, query.path || '')
    if (!/\.(png|jpe?g|webp|gif)$/i.test(file)) throw new Error('只支持图片文件')
    const stat = await fsp.stat(file)
    const ext = path.extname(file).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store'
    })
    res.end(await fsp.readFile(file))
    return null
  })

  /* ---------------- versions / installation ---------------- */
  on('GET', '/api/launcher/versions', async (_req, _params, query) => {
    const data = await listGameVersions()
    const type = query.type || 'release'
    let versions = data.versions || []
    if (type !== 'all') versions = versions.filter((item) => item.type === type)
    if (query.q) {
      const q = String(query.q).toLowerCase()
      versions = versions.filter((item) => item.id.toLowerCase().includes(q))
    }
    const installed = new Set(listInstances().map((item) => item.versionId))
    return {
      latest: data.latest,
      total: versions.length,
      items: versions.slice(0, safeInt(query.limit, 240)).map((item) => ({
        ...item,
        installed: installed.has(item.id)
      }))
    }
  })
  on('GET', '/api/launcher/loaders', async () => ({ items: LOADERS, supported: supportedLoaders() }))
  on('GET', '/api/launcher/loaders/:loader/versions', async (_req, params, query) => {
    try {
      const items = await listLoaderVersions(params.loader, query.mc || '')
      return { items }
    } catch (e) {
      return { items: [], error: e.message }
    }
  })
  on('POST', '/api/launcher/install', async (req) => {
    const body = await readBody(req)
    return startInstall({
      name: body.name || '',
      mc: body.mc,
      loader: body.loader || 'vanilla',
      loaderVersion: body.loaderVersion || '',
      memory: body.memory || {},
      minMemory: body.minMemory,
      javaPath: body.javaPath || '',
      jvmArgs: body.jvmArgs || '',
      group: body.group || ''
    })
  })
  on('GET', '/api/launcher/jobs', async () => ({ items: listJobs() }))
  on('POST', '/api/launcher/jobs/clear', async () => ({ ok: true, removed: clearFinishedJobs() }))
  on('GET', '/api/launcher/jobs/:id', async (_req, params, query) => {
    const job = getJobDelta(params.id, safeInt(query.after))
    if (!job) throw new Error('任务不存在')
    return job
  })
  on('POST', '/api/launcher/jobs/:id/cancel', async (_req, params) => ({ ok: cancelJob(params.id) }))

  /* ---------------- Java ---------------- */
  on('GET', '/api/launcher/java', async (_req, _p, query) => {
    if (query.refresh === '1') { clearJavaCache() }
    const items = await discoverJava({ force: query.refresh === '1' })
    const settings = getSettings()
    return {
      items: items.map((item) => ({
        ...item,
        bundled: String(item.path).toLowerCase().startsWith(String(RUNTIME_DIR).toLowerCase()),
        selected: settings.defaultJava && settings.defaultJava.toLowerCase() === item.path.toLowerCase()
      })),
      default: settings.defaultJava || '',
      required: query.mc ? requiredJavaMajor({}, String(query.mc)) : 0
    }
  })
  on('GET', '/api/launcher/java/required', async (_req, _p, query) => {
    const mc = String(query.mc || '')
    let required = 0
    try {
      const meta = await getVersionMeta(mc)
      required = requiredJavaMajor(meta, mc)
    } catch {
      required = requiredJavaMajor({}, mc)
    }
    return { mc, required }
  })

  /* ---------------- accounts ---------------- */
  on('GET', '/api/launcher/accounts', async () => accounts.listAccounts())
  on('POST', '/api/launcher/accounts/offline', async (req) => {
    const body = await readBody(req)
    const account = accounts.addOfflineAccount(body.name)
    return { account, accounts: accounts.listAccounts() }
  })
  on('POST', '/api/launcher/accounts/ms/start', async () => await accounts.startMicrosoftLogin())
  on('POST', '/api/launcher/accounts/ms/poll', async (req) => {
    const body = await readBody(req)
    return await accounts.pollMicrosoftLogin(body.id)
  })
  on('POST', '/api/launcher/accounts/authlib', async (req) => {
    const body = await readBody(req)
    const account = await accounts.loginAuthlib({
      server: body.server,
      username: body.username,
      password: body.password
    })
    return { account, accounts: accounts.listAccounts() }
  })
  on('POST', '/api/launcher/accounts/:id/select', async (_req, params) => {
    const data = accounts.selectAccount(params.id)
    return data
  })
  on('POST', '/api/launcher/accounts/:id/refresh', async (_req, params) => {
    const account = accounts.getInternalAccount(params.id)
    if (!account) throw new Error('账户不存在')
    if (account.type === 'microsoft') await accounts.refreshMicrosoftAccount(account)
    else if (account.type === 'authlib') await accounts.refreshAuthlibAccount(account)
    return accounts.listAccounts()
  })
  on('DELETE', '/api/launcher/accounts/:id', async (_req, params) => accounts.removeAccount(params.id))

  /* ---------------- import existing installations ---------------- */
  on('GET', '/api/launcher/import/scan', async (_req, _p, query) => await scanExisting({ dir: query.dir || '' }))
  on('POST', '/api/launcher/import', async (req) => {
    const body = await readBody(req)
    return await importExisting({
      dir: body.dir,
      versionId: body.versionId,
      name: body.name || '',
      group: body.group || ''
    })
  })

  /* ---------------- modpacks ---------------- */
  on('POST', '/api/launcher/packs/inspect', async (req) => {
    const body = await readBody(req)
    if (!body.source) throw new Error('缺少整合包路径')
    const meta = await readPackSummary(body.source)
    return {
      name: meta.name,
      kind: meta.kind,
      mc: meta.mc,
      loader: meta.loader,
      loaderVersion: meta.loaderVersion
    }
  })
  on('POST', '/api/launcher/packs/install', async (req) => {
    const body = await readBody(req)
    return startPackInstall({
      source: body.source,
      name: body.name || '',
      memory: body.memory || {},
      minMemory: body.minMemory,
      javaPath: body.javaPath || '',
      group: body.group || ''
    })
  })
  on('POST', '/api/launcher/packs/upload', async (req, _p, query, res) => {
    const name = decodeURIComponent(String(req.headers['x-file-name'] || 'pack.mrpack'))
    const uploaded = await receiveUploadedPack(req, name)
    try {
      return startPackInstall({
        source: uploaded.file,
        name: query.name || '',
        memory: { max: safeInt(query.maxMemory, 0) || undefined },
        uploaded: true
      })
    } catch (e) {
      await fsp.rm(uploaded.dir, { recursive: true, force: true }).catch(() => {})
      throw e
    }
  })

  /* ---------------- news ---------------- */
  on('GET', '/api/launcher/news', async (_req, _p, query) => await getNews({ force: query.refresh === '1' }))

  /* ---------------- small helpers ---------------- */
  on('GET', '/api/launcher/meta', async () => ({
    root: launcherRoot(),
    loaders: LOADERS,
    java: { default: getSettings().defaultJava || '' },
    platform: process.platform,
    accounts: accounts.listAccounts()
  }))
}
