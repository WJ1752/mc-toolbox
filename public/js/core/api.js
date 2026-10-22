// API client — request shape is part of the contract; do not change.
//
// allowErrorField：部分接口（如安装任务 /api/launcher/jobs/:id）在 200 响应里
// 自带业务字段 error（任务失败原因）。默认把顶层 error 视为请求失败是旧接口的
// 兼容行为，任务轮询必须显式关闭，否则「任务失败」会被误判成「读取任务失败」。
async function request(method, url, body, { allowErrorField = false } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { error: '返回内容不是 JSON' }
  }
  if (!res.ok || (!allowErrorField && data && data.error)) {
    // 保留服务端结构化错误字段（启动失败 / 缺失文件 / 可操作按钮）：
    // 页面可以直接读取 error.code、error.detail、error.paths、error.actions。
    const detail = data && typeof data === 'object' && data.error && typeof data.error === 'object' ? data.error : data
    const err = new Error((detail && (typeof detail.error === 'string' ? detail.error : detail.message)) || '请求失败 ' + res.status)
    if (detail && typeof detail === 'object') {
      for (const key of ['code', 'detail', 'missing', 'missingCount', 'paths', 'actions', 'crash', 'logFile']) {
        if (detail[key] !== undefined) err[key] = detail[key]
      }
      err.status = res.status
    }
    throw err
  }
  return data
}

export const api = {
  get: (u, options) => request('GET', u, undefined, options),
  post: (u, b, options) => request('POST', u, b ?? {}, options),
  put: (u, b, options) => request('PUT', u, b ?? {}, options),
  del: (u, options) => request('DELETE', u, undefined, options)
}
