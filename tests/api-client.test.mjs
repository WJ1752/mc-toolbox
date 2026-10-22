// 前端 API 客户端：200 响应里带业务 error 字段时的判定规则。
// 安装任务 / 导出任务对象本身就有 error（失败原因），轮询时必须当作数据返回，
// 否则「任务失败」会被误判成「读取任务状态失败」，界面还会停止轮询。
import test from 'node:test'
import assert from 'node:assert/strict'
import { api } from '../public/js/core/api.js'

function withFetch(payload, { status = 200 } = {}) {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload))
  })
  return () => { globalThis.fetch = original }
}

test('任务对象自带的 error 字段不应被当成请求失败', async () => {
  const restore = withFetch({
    id: 'job_1',
    status: 'failed',
    error: '26.3.jar 下载失败：fetch failed',
    logs: []
  })
  try {
    const data = await api.get('/api/launcher/jobs/job_1', { allowErrorField: true })
    assert.equal(data.status, 'failed')
    assert.match(data.error, /fetch failed/)
  } finally { restore() }
})

test('普通接口的 200 错误响应仍然抛出', async () => {
  const restore = withFetch({ error: '缺少项目 ID' })
  try {
    await assert.rejects(
      () => api.get('/api/community/project'),
      /缺少项目 ID/
    )
  } finally { restore() }
})

test('非 2xx 响应即使开启 allowErrorField 也必须抛出', async () => {
  const restore = withFetch({ error: '任务不存在' }, { status: 500 })
  try {
    await assert.rejects(
      () => api.get('/api/launcher/jobs/nope', { allowErrorField: true }),
      /任务不存在/
    )
  } finally { restore() }
})

test('HTTP 错误仍保留结构化字段', async () => {
  const restore = withFetch({ error: '缺少文件', code: 'MISSING_LIB', missing: ['a.jar'] }, { status: 500 })
  try {
    await assert.rejects(
      () => api.post('/api/launcher/instances/x/launch', {}),
      (err) => err.code === 'MISSING_LIB' && err.missing[0] === 'a.jar' && err.status === 500
    )
  } finally { restore() }
})
