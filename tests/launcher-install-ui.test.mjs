// 前端整合包搜索 / 导入 / 下载中心纯逻辑测试（不依赖 DOM）。
// 只覆盖 public/js/launcher/install.js 与 downloads.js 导出的辅助函数。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mcSourceLabel, needsManualMc, validateImportMc, packVersionGroups,
  describeCommunityError, describeOnlineInstallError, installJobSummary
} from '../public/js/launcher/install.js'
import {
  launcherTypeLabel, exportJobTarget, exportJobSummary, mergeLauncherJobs, jobRowSummary, jobProgressView
} from '../public/js/launcher/downloads.js'

const NOW = 1_800_000_000_000

const versions = [
  {
    id: 'ver-old', name: '1.0.0', number: '1.0.0', type: 'release',
    date: '2024-01-01T00:00:00Z', gameVersions: ['1.21.8', '1.21.7'],
    files: [{ name: 'pack-old.mrpack', size: 1024, primary: true }]
  },
  {
    id: 'ver-new', name: '2.0.0-beta', number: '2.0.0-beta', type: 'beta',
    date: '2025-02-01T00:00:00Z', gameVersions: ['1.21.8'],
    files: [{ name: 'pack-new.mrpack', size: 2048, primary: true }]
  },
  {
    id: 'ver-other', name: '3.0.0', number: '3.0.0', type: 'release',
    date: '2025-03-01T00:00:00Z', gameVersions: ['1.20.1'],
    files: [{ name: 'pack-other.mrpack', size: 4096, primary: true }]
  }
]

test('packVersionGroups：兼容版本优先、推荐正式版、其他版本折叠', () => {
  const group = packVersionGroups(versions, { mc: '1.21.8' })
  assert.deepEqual(group.compatible.map((item) => item.id), ['ver-new', 'ver-old'])
  assert.deepEqual(group.others.map((item) => item.id), ['ver-other'])
  // beta 更新但推荐仍是兼容组里的正式版
  assert.equal(group.recommendedId, 'ver-old')
  assert.equal(group.mc, '1.21.8')
})

test('packVersionGroups：没有兼容版本时全部进入其他版本', () => {
  const group = packVersionGroups(versions, { mc: '1.21.9' })
  assert.equal(group.compatible.length, 0)
  assert.equal(group.others.length, 3)
  assert.equal(group.recommendedId, '')
})

test('packVersionGroups：全部版本模式不做兼容过滤，仍按时间倒序', () => {
  const group = packVersionGroups(versions, { mc: '' })
  assert.deepEqual(group.compatible.map((item) => item.id), ['ver-other', 'ver-new', 'ver-old'])
  assert.equal(group.others.length, 0)
  assert.equal(group.recommendedId, 'ver-other')
})

test('mcSourceLabel：识别来源中文说明', () => {
  assert.equal(mcSourceLabel('inheritsFrom'), '继承识别')
  assert.equal(mcSourceLabel('jar'), 'JAR 识别')
  assert.equal(mcSourceLabel('assetIndex'), '资源索引识别')
  assert.equal(mcSourceLabel('unknown'), '')
  assert.equal(mcSourceLabel(''), '')
})

test('needsManualMc：空值 / 非法值需要手动填写，合法 MC 版本不需要', () => {
  assert.equal(needsManualMc({ mc: '', needsMc: true }), true)
  assert.equal(needsManualMc({ mc: 'Minecraft 1.21' }), true)
  assert.equal(needsManualMc({ mc: 'M1182rebirth' }), true)
  assert.equal(needsManualMc({ mc: '1.21.8' }), false)
  assert.equal(needsManualMc({ mc: '24w14a' }), false)
  assert.equal(needsManualMc(null), false)
})

test('validateImportMc：非法格式就地提示，合法值去除首尾空格', () => {
  const empty = validateImportMc('   ')
  assert.equal(empty.ok, false)
  assert.match(empty.error, /请填写/)
  const invalid = validateImportMc('Minecraft 1.21')
  assert.equal(invalid.ok, false)
  assert.match(invalid.error, /不是有效的 MC 版本号/)
  const ok = validateImportMc(' 1.21.8 ')
  assert.deepEqual(ok, { ok: true, mc: '1.21.8', error: '' })
  assert.equal(validateImportMc('26.3').ok, true)
  assert.equal(validateImportMc('1.20.1-pre1').ok, true)
})

test('describeCommunityError：CurseForge 无 Key 时给出设置引导', () => {
  const info = describeCommunityError(new Error('未配置 CurseForge API Key（设置 → 社区资源 → CurseForge API Key）'))
  assert.equal(info.cfKey, true)
  assert.match(info.message, /设置 → 社区资源/)
  assert.match(info.message, /Modrinth/)
  const generic = describeCommunityError(new Error('网络连接失败'))
  assert.equal(generic.cfKey, false)
  assert.equal(generic.message, '网络连接失败')
})

test('describeOnlineInstallError：路由未接入时给出中文指引', () => {
  const info = describeOnlineInstallError(new Error('请求失败 404'))
  assert.equal(info.cfKey, false)
  assert.match(info.message, /在线安装接口暂不可用/)
  const cf = describeOnlineInstallError(new Error('未配置 CurseForge API Key'))
  assert.equal(cf.cfKey, true)
})

test('downloads：导出任务标签、打开位置与格式大小说明', () => {
  assert.equal(launcherTypeLabel('export'), '导出整合包')
  assert.equal(launcherTypeLabel('pack'), '整合包')
  assert.equal(launcherTypeLabel('unknown'), '任务')
  const job = { type: 'export', id: 'e1', output: 'C:/launcher/exports', file: 'C:/launcher/exports/a.mrpack', format: 'mrpack', size: 2 * 1024 * 1024 }
  assert.equal(exportJobTarget(job), 'C:/launcher/exports')
  assert.equal(exportJobTarget({ type: 'export', file: 'C:/x/a.zip' }), 'C:/x/a.zip')
  assert.equal(exportJobTarget({ type: 'pack', output: 'C:/x' }), '')
  assert.match(exportJobSummary(job), /\.mrpack/)
  assert.match(exportJobSummary(job), /MB/)
  assert.equal(exportJobSummary({ type: 'export' }), '')
  assert.equal(exportJobSummary({ type: 'install', format: 'zip' }), '')
})

test('downloads：合并独立导出任务时去重、标记 type 并支持本地隐藏', () => {
  const jobs = [
    { id: 'a', type: 'install', startedAt: 3 },
    { id: 'b', type: 'export', startedAt: 2 }
  ]
  const exports = [
    { id: 'b', startedAt: 2 },
    { id: 'c', startedAt: 1 }
  ]
  const merged = mergeLauncherJobs(jobs, exports)
  assert.deepEqual(merged.map((job) => job.id).sort(), ['a', 'b', 'c'])
  assert.equal(merged.find((job) => job.id === 'c').type, 'export')
  assert.equal(merged.find((job) => job.id === 'b').type, 'export')
  const hidden = mergeLauncherJobs(jobs, exports, { hiddenExports: new Set(['c']) })
  assert.deepEqual(hidden.map((job) => job.id).sort(), ['a', 'b'])
  assert.deepEqual(mergeLauncherJobs(null, null), [])
})

test('downloads：进度条统一走 jobProgress，社区任务不再永远 indeterminate', () => {
  // 社区任务没有 progress，只有 received / total。
  assert.deepEqual(jobProgressView({ status: 'running', received: 50, total: 200 }), { value: 25, state: '' })
  // 安装阶段用 installProgress，且优先于字节比例。
  assert.deepEqual(
    jobProgressView({ status: 'installing', installProgress: 80, received: 10, total: 100 }),
    { value: 80, state: '' }
  )
  assert.deepEqual(jobProgressView({ status: 'done', progress: 12 }), { value: 100, state: 'ok' })
  assert.deepEqual(jobProgressView({ status: 'failed', received: 5, total: 10 }), { value: 50, state: 'bad' })
  // 只有服务端明确 indeterminate 或确实没有进度时才显示不确定动画。
  assert.deepEqual(
    jobProgressView({ status: 'running', indeterminate: true, received: 50, total: 200 }),
    { value: null, state: '' }
  )
  assert.deepEqual(jobProgressView({ status: 'running', received: 50, total: 0 }), { value: null, state: '' })
  // 已取消且没有已知进度时显示 0% 的终止条，而不是持续播放的不确定动画。
  assert.deepEqual(jobProgressView({ status: 'cancelled' }), { value: 0, state: '' })
  assert.deepEqual(jobProgressView(null), { value: null, state: '' })
})

test('downloads：运行中摘要含字节、百分比、速度与已进行', () => {
  const job = {
    status: 'running', received: 58 * 1024 ** 2, total: 60 * 1024 ** 2,
    speed: 1024 ** 2, startedAt: NOW - 9000
  }
  const text = jobRowSummary(job, NOW)
  assert.match(text, /58 MB \/ 60 MB/)
  assert.match(text, /97%/)
  assert.match(text, /1\.0 MB\/s/)
  assert.match(text, /已进行 9 秒/)
  assert.equal(jobRowSummary({ status: 'queued', createdAt: NOW - 90000 }, NOW), '已排队 1 分')
})

test('downloads：安装阶段摘要显示安装百分比与已进行', () => {
  const text = jobRowSummary({
    status: 'installing', installProgress: 42.6,
    received: 100 * 1024 ** 2, total: 200 * 1024 ** 2, startedAt: NOW - 5000
  }, NOW)
  assert.match(text, /100 MB \/ 200 MB/)
  assert.match(text, /43%/)
  assert.match(text, /已进行 5 秒/)
})

test('downloads：完成显示 100% 与用时，失败/取消不再显示已进行', () => {
  const done = jobRowSummary({
    status: 'done', received: 63 * 1024 ** 2, total: 63 * 1024 ** 2,
    startedAt: NOW - 120000, finishedAt: NOW - 60000
  }, NOW)
  assert.match(done, /63 MB \/ 63 MB/)
  assert.match(done, /100%/)
  assert.match(done, /用时 1 分/)
  assert.doesNotMatch(done, /已进行/)

  const failed = jobRowSummary({
    status: 'failed', received: 5 * 1024 ** 2, total: 10 * 1024 ** 2,
    startedAt: NOW - 12000, finishedAt: NOW - 6000
  }, NOW)
  assert.match(failed, /50%/)
  assert.match(failed, /用时 6 秒/)
  assert.match(failed, /失败/)
  assert.doesNotMatch(failed, /已进行/)

  // 没有 finishedAt 的失败任务只显示终态，不能继续显示「已进行」。
  assert.equal(jobRowSummary({ status: 'failed', startedAt: NOW - 12000 }, NOW), '失败')

  const cancelled = jobRowSummary({
    status: 'cancelled', received: 1 * 1024 ** 2, total: 2 * 1024 ** 2
  }, NOW)
  assert.match(cancelled, /1\.0 MB \/ 2\.0 MB/)
  assert.match(cancelled, /50%/)
  assert.match(cancelled, /已取消/)
  assert.doesNotMatch(cancelled, /已进行/)

  const doneNoBytes = jobRowSummary({ status: 'done', startedAt: NOW - 60000, finishedAt: NOW - 30000 }, NOW)
  assert.match(doneNoBytes, /100%/)
  assert.match(doneNoBytes, /用时 30 秒/)
})

test('install：内联卡摘要排队/运行/完成/失败取消语义统一', () => {
  assert.equal(installJobSummary({ status: 'queued', createdAt: NOW - 90000 }, NOW), '已排队 1 分')
  const running = installJobSummary({
    status: 'running', received: 10 * 1024 ** 2, total: 20 * 1024 ** 2, startedAt: NOW - 30000
  }, NOW)
  assert.match(running, /10 MB \/ 20 MB/)
  assert.match(running, /50%/)
  assert.match(running, /已进行 30 秒/)

  const done = installJobSummary({
    status: 'done', received: 20 * 1024 ** 2, total: 20 * 1024 ** 2,
    startedAt: NOW - 120000, finishedAt: NOW - 60000
  }, NOW)
  assert.match(done, /20 MB \/ 20 MB/)
  assert.match(done, /用时 1 分/)
  assert.doesNotMatch(done, /已进行/)

  assert.equal(installJobSummary({ status: 'failed', startedAt: NOW - 12000 }, NOW), '失败')
  assert.equal(installJobSummary({ status: 'cancelled' }, NOW), '已取消')
  assert.equal(installJobSummary(null, NOW), '')
})
