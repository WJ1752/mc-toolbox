// 下载任务的统一口径：启动器任务、社区下载任务、服务端核心任务共用。
//
// 三个界面（启动器下载中心、工作台下载磁贴、状态栏任务数）过去各自计算
// 百分比：社区任务没有 progress 字段，于是永远显示不确定动画；启动器
// 任务又把 detail 里的字节与 received/total 混用。这里把「状态、进度、
// 字节、速度、耗时」收敛成纯函数，服务端只需要保证字段本身准确。
import { fmtBytes, fmtDuration } from './dom.js'

const ACTIVE = new Set(['queued', 'running', 'installing', 'cancelling'])
const FINISHED = new Set(['done', 'failed', 'cancelled'])
const STATUS_LABEL = {
  queued: '排队中',
  running: '下载中',
  installing: '安装中',
  cancelling: '取消中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消'
}

export { ACTIVE as ACTIVE_JOB_STATUSES, FINISHED as FINISHED_JOB_STATUSES }

export function isActiveJob(job) {
  return !!job && ACTIVE.has(job.status)
}

export function isFinishedJob(job) {
  return !!job && FINISHED.has(job.status)
}

export function jobStatusLabel(job) {
  return STATUS_LABEL[job?.status] || job?.status || '未知'
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value))
}

/**
 * 0–100 的确定进度；null 表示没有真实进度，界面应显示不确定动画。
 * 优先级：完成 100 → 安装百分比 → 终态已知进度 → 服务端 progress → 字节比例。
 */
export function jobProgress(job) {
  if (!job) return null
  if (job.status === 'done') return 100
  if (job.status === 'installing') {
    // 服务端在安装器还没输出百分比时给 null；Number(null) === 0 会把
    // 「未知」误判成 0%，所以必须先判空。
    if (job.installProgress === null || job.installProgress === undefined) return null
    const install = Number(job.installProgress)
    return Number.isFinite(install) ? clampPercent(install) : null
  }
  const total = num(job.total)
  if (isFinishedJob(job)) {
    // 失败 / 取消的任务不应该继续播放「进行中」的不确定动画。
    const failedPct = Number(job.progress)
    if (job.progress !== null && job.progress !== undefined && Number.isFinite(failedPct)) {
      return clampPercent(failedPct)
    }
    if (total > 0) return clampPercent((num(job.received) / total) * 100)
    return 0
  }
  if (job.status === 'queued') return null
  if (job.status === 'cancelling') {
    const cancelPct = Number(job.progress)
    if (job.progress !== null && job.progress !== undefined && Number.isFinite(cancelPct)) {
      return clampPercent(cancelPct)
    }
    return total > 0 ? clampPercent((num(job.received) / total) * 100) : null
  }
  if (job.indeterminate === true) return null
  const progress = Number(job.progress)
  if (job.progress !== null && job.progress !== undefined && Number.isFinite(progress)) {
    return clampPercent(progress)
  }
  if (total > 0) return clampPercent((num(job.received) / total) * 100)
  return null
}

export function jobPercentText(job) {
  if (!job) return ''
  if (job.status === 'queued' || job.status === 'cancelling') return ''
  if (isFinishedJob(job) && job.status !== 'done') {
    // 失败/取消任务只有在服务端确实报过比例或收到过字节时才显示百分比；
    // 否则 0% 会像「还在进行」一样误导。
    const hasProgress = job.progress !== null && job.progress !== undefined && Number.isFinite(Number(job.progress))
    const hasBytes = num(job.total) > 0
    if (!hasProgress && !hasBytes) return ''
  }
  const pct = jobProgress(job)
  return pct === null ? '' : Math.round(pct) + '%'
}

export function jobBytes(job) {
  const received = Math.max(0, num(job?.received))
  const total = Math.max(0, num(job?.total))
  return { received, total }
}

/** `581 MB / 599 MB` 或 `581 MB`；没有字节返回 ''。已知总量时夹紧已下载值。 */
export function jobBytesText(job) {
  const { received, total } = jobBytes(job)
  if (total > 0) return `${fmtBytes(Math.min(received, total))} / ${fmtBytes(total)}`
  if (received > 0) return fmtBytes(received)
  return ''
}

export function jobSpeedText(job) {
  if (job?.status !== 'running') return ''
  const speed = num(job.speed)
  if (speed <= 0) return ''
  if (speed >= 1024 * 1024) return (speed / 1024 / 1024).toFixed(1) + ' MB/s'
  if (speed >= 1024) return (speed / 1024).toFixed(1) + ' KB/s'
  return Math.round(speed) + ' B/s'
}

/**
 * 运行耗时（秒）：完成用 finishedAt-start，运行中用 now-start。
 * startedAt 由服务端在真正开跑时写入，排队时间不计入。
 */
export function jobElapsedSeconds(job, now = Date.now()) {
  const startedAt = num(job?.startedAt)
  const finishedAt = num(job?.finishedAt)
  if (!startedAt) return 0
  const end = finishedAt > 0 ? finishedAt : (isActiveJob(job) ? now : 0)
  if (!end) return 0
  return Math.max(0, (end - startedAt) / 1000)
}

/** 排队等待（秒）：只对尚未开始的 queued 任务有意义。 */
export function jobWaitSeconds(job, now = Date.now()) {
  if (job?.status !== 'queued') return 0
  const createdAt = num(job.createdAt)
  const startedAt = num(job.startedAt)
  if (startedAt > 0) return 0
  if (!createdAt) return 0
  return Math.max(0, (now - createdAt) / 1000)
}

/**
 * 无进展提示：只有运行中 / 安装中且 2 分钟没有收到心跳的任务才返回秒数。
 * 用于解释「已进行 9.7 小时」这类长时间卡住的任务，而不是把等待时间藏起来。
 */
export function jobIdleSeconds(job, now = Date.now(), threshold = 120) {
  if (!job || !isActiveJob(job)) return 0
  if (job.status === 'queued' || job.status === 'cancelling') return 0
  const updatedAt = num(job.updatedAt)
  if (!updatedAt) return 0
  const idle = Math.max(0, (now - updatedAt) / 1000)
  return idle >= threshold ? idle : 0
}

/** 无进展文案；未达到阈值返回 ''。 */
export function jobIdleText(job, now = Date.now(), threshold = 120) {
  const idle = jobIdleSeconds(job, now, threshold)
  return idle > 0 ? '无进展 ' + fmtDuration(idle) : ''
}

/**
 * 人类可读的耗时文案：
 * - 完成 / 失败 / 取消：`用时 X`
 * - 运行中：`已进行 X`
 * - 排队中：`已排队 X`
 * - 取消中：`取消中`（不再显示持续增长的「已进行」）
 */
export function jobElapsedText(job, now = Date.now()) {
  if (!job) return ''
  if (job.status === 'queued') {
    const wait = jobWaitSeconds(job, now)
    return wait > 0 ? '已排队 ' + fmtDuration(wait) : '排队中'
  }
  if (job.status === 'cancelling') return '取消中'
  const elapsed = jobElapsedSeconds(job, now)
  if (isFinishedJob(job)) return elapsed > 0 ? '用时 ' + fmtDuration(elapsed) : ''
  if (elapsed > 0) return '已进行 ' + fmtDuration(elapsed)
  return ''
}

/**
 * 预计剩余时间（秒）：只有运行中、速度 > 0 且总量已知时才有意义。
 * 速度是服务端返回的平滑值，因此这里不再二次平滑。
 */
export function jobEtaSeconds(job, now = Date.now()) {
  if (!job || job.status !== 'running') return 0
  const speed = num(job.speed)
  const { received, total } = jobBytes(job)
  if (speed <= 0 || total <= 0 || received >= total) return 0
  return Math.max(1, Math.round((total - received) / speed))
}

/** `剩余 2 分` / `剩余 1 分 30 秒`；无法估算时返回 ''。 */
export function jobEtaText(job, now = Date.now()) {
  const seconds = jobEtaSeconds(job, now)
  if (seconds < 2) return ''
  return '剩余 ' + fmtDuration(seconds)
}

/**
 * 下载行的一行摘要：字节、百分比、速度、剩余时间、耗时。
 * 安装任务没有字节时不硬塞 0%；全部为空时回退到状态文案。
 */
export function jobMetaText(job, now = Date.now()) {
  if (!job) return ''
  const parts = []
  const bytes = jobBytesText(job)
  if (bytes) parts.push(bytes)
  if (isActiveJob(job)) {
    const pct = jobPercentText(job)
    if (pct) parts.push(pct)
  }
  const speed = jobSpeedText(job)
  if (speed) parts.push(speed)
  const eta = jobEtaText(job, now)
  if (eta) parts.push(eta)
  const elapsed = jobElapsedText(job, now)
  if (elapsed) parts.push(elapsed)
  const idle = jobIdleText(job, now)
  if (idle) parts.push(idle)
  if (!parts.length) return jobStatusLabel(job)
  return parts.join(' · ')
}

/** 合并多个来源的任务并按最近创建时间倒序；按 id 去重。 */
export function mergeJobs(...lists) {
  const merged = new Map()
  for (const list of lists) {
    for (const job of Array.isArray(list) ? list : []) {
      if (!job?.id) continue
      const prev = merged.get(job.id)
      // 同一任务以字段更完整（例如带 progress / logs）的版本为准。
      if (!prev || Object.keys(job).length >= Object.keys(prev).length) merged.set(job.id, job)
    }
  }
  return [...merged.values()].sort((a, b) => {
    const at = num(a.startedAt) || num(a.createdAt)
    const bt = num(b.startedAt) || num(b.createdAt)
    return bt - at
  })
}
