// 启动器 API 客户端：所有 /api/launcher 请求集中在这里，页面模块不拼 URL。
import { api } from '../core/api.js'

const qs = (params = {}) => {
  const sp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') sp.set(key, String(value))
  }
  const text = sp.toString()
  return text ? '?' + text : ''
}

function upload(url, file, { onProgress, fieldHeaders = {} } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name))
    for (const [key, value] of Object.entries(fieldHeaders)) xhr.setRequestHeader(key, value)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.({ loaded: event.loaded, total: event.total, ratio: event.loaded / event.total })
    }
    xhr.onerror = () => reject(new Error('上传失败（网络错误）'))
    xhr.onabort = () => reject(new Error('上传已中止'))
    xhr.onload = () => {
      let data = null
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null } catch {}
      if (xhr.status < 200 || xhr.status >= 300 || data?.error) {
        reject(new Error(data?.error || `上传失败 HTTP ${xhr.status}`))
        return
      }
      resolve(data)
    }
    xhr.send(file)
  })
}

export const launcherApi = {
  bootstrap: () => api.get('/api/launcher/bootstrap'),
  status: () => api.get('/api/launcher/status'),
  settings: () => api.get('/api/launcher/settings'),
  saveSettings: (patch) => api.put('/api/launcher/settings', patch),

  instances: () => api.get('/api/launcher/instances'),
  instance: (id) => api.get(`/api/launcher/instances/${encodeURIComponent(id)}`),
  updateInstance: (id, patch) => api.put(`/api/launcher/instances/${encodeURIComponent(id)}`, patch),
  deleteInstance: (id) => api.del(`/api/launcher/instances/${encodeURIComponent(id)}`),
  duplicateInstance: (id, name = '') => api.post(`/api/launcher/instances/${encodeURIComponent(id)}/duplicate`, { name }),
  selectInstance: (id) => api.post(`/api/launcher/instances/${encodeURIComponent(id)}/select`),
  repairInstance: (id) => api.post(`/api/launcher/instances/${encodeURIComponent(id)}/repair`),

  launch: (id, accountId = '') => api.post(`/api/launcher/instances/${encodeURIComponent(id)}/launch`, { accountId }),
  stop: (id, force = true) => api.post(`/api/launcher/instances/${encodeURIComponent(id)}/stop`, { force }),
  preview: (id) => api.get(`/api/launcher/instances/${encodeURIComponent(id)}/preview`),
  instanceStatus: (id) => api.get(`/api/launcher/instances/${encodeURIComponent(id)}/status`),
  liveLog: (id, after = 0) => api.get(`/api/launcher/instances/${encodeURIComponent(id)}/log?after=${Number(after) || 0}`),
  savedLog: (id, file = '') => api.get(`/api/launcher/instances/${encodeURIComponent(id)}/log?saved=1${file ? '&file=' + encodeURIComponent(file) : ''}`),
  crash: (id, file = '') => api.get(`/api/launcher/instances/${encodeURIComponent(id)}/crash${file ? '?file=' + encodeURIComponent(file) : ''}`),

  content: (id, type, extra = {}) => api.get(`/api/launcher/instances/${encodeURIComponent(id)}/content${qs({ type, ...extra })}`),
  toggleMod: (id, path, enabled) => api.post(`/api/launcher/instances/${encodeURIComponent(id)}/mods/toggle`, { path, enabled }),
  deleteMod: (id, path) => api.post(`/api/launcher/instances/${encodeURIComponent(id)}/mods/delete`, { path }),
  modUpdates: (id, force = false) => api.get(`/api/launcher/instances/${encodeURIComponent(id)}/mods/updates${force ? '?force=1' : ''}`),
  updateMods: (id, items) => api.post(`/api/launcher/instances/${encodeURIComponent(id)}/mods/update`, { items }),
  missingDependencies: (id) => api.get(`/api/launcher/instances/${encodeURIComponent(id)}/mods/missing`),
  deleteContent: (id, type, name) => api.post(`/api/launcher/instances/${encodeURIComponent(id)}/content/delete`, { type, name }),
  setResourcePack: (id, name, enabled) => api.post(`/api/launcher/instances/${encodeURIComponent(id)}/resourcepack`, { name, enabled }),
  serverAction: (id, payload) => api.post(`/api/launcher/instances/${encodeURIComponent(id)}/servers`, payload),
  upload: (id, type, file, { onProgress } = {}) => upload(`/api/launcher/instances/${encodeURIComponent(id)}/upload?type=${encodeURIComponent(type)}`, file, { onProgress }),

  versions: (params = {}) => api.get('/api/launcher/versions' + qs(params)),
  loaders: () => api.get('/api/launcher/loaders'),
  loaderVersions: (loader, mc) => api.get(`/api/launcher/loaders/${encodeURIComponent(loader)}/versions${qs({ mc })}`),
  install: (payload) => api.post('/api/launcher/install', payload),
  jobs: () => api.get('/api/launcher/jobs'),
  job: (id, after = 0) => api.get(`/api/launcher/jobs/${encodeURIComponent(id)}${qs({ after })}`),
  cancelJob: (id) => api.post(`/api/launcher/jobs/${encodeURIComponent(id)}/cancel`),
  clearJobs: () => api.post('/api/launcher/jobs/clear'),
  communityJobs: () => api.get('/api/community/jobs'),

  java: (refresh = false, mc = '') => api.get('/api/launcher/java' + qs({ refresh: refresh ? 1 : '', mc })),
  requiredJava: (mc) => api.get('/api/launcher/java/required' + qs({ mc })),
  downloadJava: (major) => api.post('/api/java/download', { major }),
  javaJob: (id) => api.get(`/api/java/download/${encodeURIComponent(id)}`),
  cancelJavaJob: (id) => api.post(`/api/java/download/${encodeURIComponent(id)}/cancel`),

  accounts: () => api.get('/api/launcher/accounts'),
  addOffline: (name) => api.post('/api/launcher/accounts/offline', { name }),
  msStart: () => api.post('/api/launcher/accounts/ms/start'),
  msPoll: (id) => api.post('/api/launcher/accounts/ms/poll', { id }),
  authlibLogin: (payload) => api.post('/api/launcher/accounts/authlib', payload),
  selectAccount: (id) => api.post(`/api/launcher/accounts/${encodeURIComponent(id)}/select`),
  refreshAccount: (id) => api.post(`/api/launcher/accounts/${encodeURIComponent(id)}/refresh`),
  deleteAccount: (id) => api.del(`/api/launcher/accounts/${encodeURIComponent(id)}`),

  importScan: (dir = '') => api.get('/api/launcher/import/scan' + qs({ dir })),
  importVersion: (payload) => api.post('/api/launcher/import', payload),

  packInspect: (source) => api.post('/api/launcher/packs/inspect', { source }),
  packInstall: (payload) => api.post('/api/launcher/packs/install', payload),
  packUpload: (file, { onProgress, name = '', maxMemory = 0 } = {}) =>
    upload(`/api/launcher/packs/upload${qs({ name, maxMemory })}`, file, { onProgress }),

  news: (refresh = false) => api.get('/api/launcher/news' + (refresh ? '?refresh=1' : ''))
}

export { qs }
