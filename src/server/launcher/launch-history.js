import crypto from 'node:crypto'
import { store } from '../store.js'
import { instancePaths, LAUNCH_HISTORY_KEY } from './state.js'
import { getModUpdateBackup } from './mod-update-transaction.js'
import { scanModsDir } from '../mods.js'
import { sha1OfFile } from './updates.js'
import { runPool } from './download.js'

const EMPTY = { instances: {} }
const sha1Re = /^[a-f0-9]{40}$/
const keyOf = (value) => process.platform === 'win32' ? String(value).toLowerCase() : String(value)

function historyStore() {
  const data = store.get(LAUNCH_HISTORY_KEY, EMPTY)
  if (!data || typeof data !== 'object' || !data.instances || typeof data.instances !== 'object') return { ...EMPTY }
  return data
}

function saveRecord(inst, record) {
  const data = historyStore()
  data.instances[inst.id] = record
  store.set(LAUNCH_HISTORY_KEY, data)
  return record
}

async function readMods(inst, { signal } = {}) {
  const { modsDir, gameDir } = instancePaths(inst)
  const scanned = await scanModsDir(modsDir, {
    recursive: true,
    includeDisabled: true,
    gameDir,
    runtime: { mc: inst.mc, loader: inst.loader, loaderVersion: inst.loaderVersion },
    signal
  })
  const items = new Array(scanned.length)
  await runPool(scanned, async (item, index) => {
    const sha1 = await sha1OfFile(item.path, { signal })
    if (!sha1Re.test(sha1)) throw new Error(`无法计算模组校验值：${item.relPath}`)
    items[index] = {
      file: item.file,
      relPath: String(item.relPath || '').replace(/\\/g, '/'),
      sha1,
      size: Number(item.size) || 0,
      enabled: item.disabled !== true,
      modid: item.modid || '',
      modids: [...new Set([item.modid, ...(Array.isArray(item.topLevelModIds) ? item.topLevelModIds : [])].filter(Boolean))],
      name: String(item.name || item.file || ''),
      version: String(item.version || '')
    }
  }, 8, signal)
  return items
}

function makeSnapshot(inst, runtime, capturedAt = Date.now(), { signal } = {}) {
  return readMods(inst, { signal }).then((mods) => ({
    schema: 1,
    instanceId: inst.id,
    capturedAt,
    runtime: {
      mc: String(inst.mc || ''),
      loader: String(inst.loader || 'vanilla'),
      loaderVersion: String(inst.loaderVersion || ''),
      versionId: String(inst.versionId || inst.mc || '')
    },
    java: {
      path: String(runtime.javaPath || ''),
      major: Number(runtime.javaMajor) || 0
    },
    memory: {
      min: Number(inst.memory?.min) || 0,
      max: Number(inst.memory?.max) || 0
    },
    display: {
      width: Number(inst.width) || 0,
      height: Number(inst.height) || 0,
      fullscreen: inst.fullscreen === true
    },
    jvmArgsHash: crypto.createHash('sha1').update(String(runtime.jvmArgs ?? inst.jvmArgs ?? '')).digest('hex'),
    mods
  }))
}

export function beginLaunchAttempt(inst, startedAt = Date.now()) {
  const data = historyStore()
  const id = crypto.randomUUID()
  const previousBaseline = data.instances[inst.id]?.baseline || null
  const record = {
    baseline: previousBaseline,
    attempt: {
      id,
      status: 'preparing',
      startedAt,
      capturedAt: 0,
      snapshot: null,
      previousBaseline,
      previousBaselineId: previousBaseline?.id || '',
      previousSnapshot: previousBaseline?.snapshot || null,
      error: null
    }
  }
  saveRecord(inst, record)
  return id
}

export async function captureLaunchAttempt(inst, attemptId, runtime = {}, { signal } = {}) {
  const current = historyStore().instances[inst.id]
  if (!current?.attempt || current.attempt.id !== attemptId) return { ok: false, stale: true }
  try {
    const snapshot = await makeSnapshot(inst, runtime, Date.now(), { signal })
    const latest = historyStore().instances[inst.id]
    if (!latest?.attempt || latest.attempt.id !== attemptId) return { ok: false, stale: true }
    latest.attempt.snapshot = snapshot
    latest.attempt.capturedAt = snapshot.capturedAt
    latest.attempt.status = 'captured'
    saveRecord(inst, latest)
    return { ok: true, snapshot }
  } catch (error) {
    const latest = historyStore().instances[inst.id]
    if (latest?.attempt?.id === attemptId) {
      latest.attempt.status = 'snapshot-error'
      latest.attempt.error = { code: 'SNAPSHOT_FAILED', message: String(error?.message || error).slice(0, 500), evidence: [] }
      saveRecord(inst, latest)
    }
    return { ok: false, error }
  }
}
function safeEvidence(failure = {}) {
  const evidence = []
  const redact = (line) => String(line || '').slice(0, 1000)
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/ig, '$1[已隐藏]')
    .replace(/((?:access|refresh|client|session)[_-]?token|password|secret)(\s*[=:]\s*)[^\s,;]+/ig, '$1$2[已隐藏]')
  for (const hint of (Array.isArray(failure.hints) ? failure.hints : []).filter((item) => ['mods', 'deps'].includes(item?.kind)).slice(0, 4)) {
    for (const line of Array.isArray(hint?.evidence) ? hint.evidence.slice(0, 3) : []) {
      const text = redact(typeof line === 'string' ? line : line?.text)
      if (text) evidence.push({ text, file: String(line?.file || '').slice(0, 512), line: Number(line?.line) || null })
    }
  }
  const unique = new Map(evidence.map((item) => [`${item.file}:${item.line}:${item.text}`, item]))
  return [...unique.values()].slice(0, 12)
}

export function updateLaunchAttempt(inst, attemptId, { status, failure = null } = {}) {
  const record = historyStore().instances[inst.id]
  if (!record?.attempt || record.attempt.id !== attemptId) return false
  record.attempt.status = String(status || record.attempt.status)
  if (failure) {
    if (status === 'failed' && record.baseline?.id === attemptId) record.baseline = record.attempt.previousBaseline || null
    record.attempt.endedAt = Number(failure.endedAt) || Date.now()
    record.attempt.error = {
      code: String(failure.code || ''),
      message: String(failure.message || '').slice(0, 1000),
      evidence: safeEvidence(failure)
    }
  }
  saveRecord(inst, record)
  return true
}

export function promoteLaunchAttempt(inst, attemptId, succeededAt = Date.now()) {
  const record = historyStore().instances[inst.id]
  if (!record?.attempt || record.attempt.id !== attemptId || record.attempt.status !== 'window-ready' || !record.attempt.snapshot) return false
  const snapshot = record.attempt.snapshot
  record.baseline = { id: attemptId, capturedAt: snapshot.capturedAt, succeededAt, snapshot }
  record.attempt.status = 'success'
  record.attempt.succeededAt = succeededAt
  saveRecord(inst, record)
  return true
}

function compareSnapshots(before, after) {
  const oldItems = before?.mods || []
  const newItems = after?.mods || []
  const oldByPath = new Map(oldItems.map((item) => [keyOf(item.relPath), item]))
  const newByPath = new Map(newItems.map((item) => [keyOf(item.relPath), item]))
  const usedOld = new Set()
  const usedNew = new Set()
  const pairs = []
  for (const current of newItems) {
    const old = oldByPath.get(keyOf(current.relPath))
    if (!old) continue
    usedOld.add(old)
    usedNew.add(current)
    pairs.push({ before: old, after: current })
  }
  const uniqueLookup = (items, getKey) => {
    const hits = new Map()
    const duplicates = new Set()
    for (const item of items) {
      const key = getKey(item)
      if (!key) continue
      if (hits.has(key)) duplicates.add(key)
      else hits.set(key, item)
    }
    for (const key of duplicates) hits.delete(key)
    return hits
  }
  const remainingOld = () => oldItems.filter((item) => !usedOld.has(item))
  const remainingNew = () => newItems.filter((item) => !usedNew.has(item))
  const pairUnique = (getKey) => {
    const old = uniqueLookup(remainingOld(), getKey)
    const current = uniqueLookup(remainingNew(), getKey)
    for (const [key, oldItem] of old) {
      const newItem = current.get(key)
      if (!newItem) continue
      usedOld.add(oldItem)
      usedNew.add(newItem)
      pairs.push({ before: oldItem, after: newItem })
    }
  }
  pairUnique((item) => String(item.modid || '').trim().toLowerCase())
  pairUnique((item) => item.sha1)
  const added = []
  const removed = []
  const changed = []
  for (const current of newItems) if (!usedNew.has(current)) added.push(current)
  for (const old of oldItems) if (!usedOld.has(old)) removed.push(old)
  for (const { before: old, after: item } of pairs) {
    const changes = []
    if (keyOf(old.relPath) !== keyOf(item.relPath)) changes.push('path')
    if (old.sha1 !== item.sha1) changes.push('content')
    if (old.enabled !== item.enabled) changes.push('enabled')
    if (changes.length) changed.push({ before: old, after: item, changes })
  }

  const settings = []
  const scalar = [
    ['mc', 'Minecraft 版本', before?.runtime?.mc, after?.runtime?.mc],
    ['loader', '加载器', before?.runtime?.loader, after?.runtime?.loader],
    ['loaderVersion', '加载器版本', before?.runtime?.loaderVersion, after?.runtime?.loaderVersion],
    ['versionId', '客户端版本 ID', before?.runtime?.versionId, after?.runtime?.versionId],
    ['java.path', 'Java 路径', before?.java?.path, after?.java?.path],
    ['java.major', 'Java 主版本', before?.java?.major, after?.java?.major],
    ['memory.min', '最小内存', before?.memory?.min, after?.memory?.min],
    ['memory.max', '最大内存', before?.memory?.max, after?.memory?.max],
    ['display.width', '窗口宽度', before?.display?.width, after?.display?.width],
    ['display.height', '窗口高度', before?.display?.height, after?.display?.height],
    ['display.fullscreen', '全屏', before?.display?.fullscreen, after?.display?.fullscreen]
  ]
  for (const [key, label, oldValue, newValue] of scalar) {
    const same = key === 'java.path' ? keyOf(oldValue) === keyOf(newValue) : oldValue === newValue
    if (!same) settings.push({ key, label, before: oldValue ?? null, after: newValue ?? null })
  }
  const jvmArgsChanged = before && after && before.jvmArgsHash !== after.jvmArgsHash
  return { mods: { added, removed, changed }, settings, jvmArgsChanged }
}

async function undoForComparison(inst, before, after) {
  if (!before || !after) return { available: false, reason: '缺少完整的前后模组快照' }
  let backup
  try { backup = (await getModUpdateBackup(inst, { verify: true, includeHashes: true })).backup }
  catch { return { available: false, reason: '无法读取模组更新备份' } }
  if (!backup) return { available: false, reason: '没有可用的模组更新备份' }
  const oldByPath = new Map(before.mods.map((item) => [keyOf(item.relPath), item]))
  const newByPath = new Map(after.mods.map((item) => [keyOf(item.relPath), item]))
  const matches = backup.items.every((item) => {
    const prior = oldByPath.get(keyOf(item.before))
    const current = newByPath.get(keyOf(item.after))
    return prior && current && prior.sha1 === item.oldSha1 && current.sha1 === item.sha1
  })
  if (!matches) return { available: false, reason: '当前模组与这批更新的前后文件不完全匹配' }
  return { available: true, id: backup.id, createdAt: backup.createdAt,
    items: backup.items.map(({ before: oldPath, after: newPath }) => ({ before: oldPath, after: newPath })) }
}

export async function getLaunchComparison(inst, { attemptId = '' } = {}) {
  const record = historyStore().instances[inst.id]
  const attempt = record?.attempt && (!attemptId || record.attempt.id === attemptId) ? record.attempt : null
  const before = attempt?.previousSnapshot || null
  const after = attempt?.snapshot || null
  const comparison = before && after ? compareSnapshots(before, after) : null
  const undo = await undoForComparison(inst, before, after)
  return {
    instanceId: inst.id,
    baseline: before ? {
      id: attempt.previousBaselineId || '',
      capturedAt: before.capturedAt,
      succeededAt: attempt.previousBaseline?.succeededAt || 0
    } : null,
    latestSuccessful: record?.baseline ? { id: record.baseline.id, capturedAt: record.baseline.capturedAt, succeededAt: record.baseline.succeededAt } : null,
    attempt: attempt ? {
      id: attempt.id,
      status: attempt.status,
      startedAt: attempt.startedAt,
      capturedAt: attempt.capturedAt,
      endedAt: attempt.endedAt || 0,
      succeededAt: attempt.succeededAt || 0,
      error: attempt.error,
    } : null,
    comparison,
    undo
  }
}
