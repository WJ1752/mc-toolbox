import { h } from './dom.js'
import { api } from './api.js'
import { openModal } from './modal.js'

export function recommendedJava(runtime = {}) {
  if (runtime.loader === 'cleanroom') return /^0\.[0-5]\./.test(runtime.loaderVersion || '') ? 21 : 25
  const [, minor, patch = '0'] = /^1\.(\d+)(?:\.(\d+))?$/.exec(runtime.mc || '') || []
  return Number(minor) > 20 || (Number(minor) === 20 && Number(patch) >= 5) ? 21 : Number(minor) >= 18 ? 17 : Number(minor) === 17 ? 16 : 8
}

export function javaDownloadButton({ getRuntime, isLocked = () => false, onReady }) {
  const panel = h('div')
  const version = h('select', { class: 'input', 'aria-label': '下载 Java 大版本' }, ...[8, 16, 17, 21, 25].map(n => h('option', { value: String(n) }, `Java ${n}（64 位）`)))
  const detail = h('div', { class: 'muted', 'aria-live': 'polite', style: { overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', marginTop: '10px' } }, '从 Eclipse Temurin 官方来源下载，校验完整性和版本后自动加入工具箱。支持 Windows x64 / ARM64。')
  const fill = h('i', { style: { width: '0%' } })
  const bar = h('div', { class: 'bar', style: { display: 'none', marginTop: '8px' } }, fill)
  const start = h('button', { class: 'btn btn-primary' }, '下载 / 使用此版本')
  const cancel = h('button', { class: 'btn btn-danger', style: { display: 'none' } }, '中止下载')
  const use = h('button', { class: 'btn', style: { display: 'none' } }, '使用已下载的 Java')
  let id = '', busy = false, readyPath = '', cancelRequested = false
  const apply = () => {
    if (isLocked()) { detail.textContent += '\nJava 已保存在工具箱中。请等当前任务结束后再点击“使用已下载的 Java”。'; return }
    onReady(readyPath)
  }
  use.onclick = apply
  cancel.onclick = async () => {
    cancelRequested = true; cancel.disabled = true
    if (id) await api.post(`/api/java/download/${id}/cancel`).catch(e => { detail.textContent = e.message })
  }
  start.onclick = async () => {
    if (busy) return
    busy = true; cancelRequested = false; start.disabled = true; version.disabled = true
    cancel.disabled = false; cancel.style.display = ''; use.style.display = 'none'; bar.style.display = ''
    try {
      let job = await api.post('/api/java/download', { major: Number(version.value) }); id = job.id
      if (cancelRequested && id) await api.post(`/api/java/download/${id}/cancel`)
      for (;;) {
        detail.textContent = job.detail + (job.progress == null ? '' : `（${Math.floor(job.progress)}%）`)
        bar.classList.toggle('indeterminate', job.progress == null)
        fill.style.width = job.progress == null ? '35%' : `${job.progress}%`
        if (job.status === 'done') { readyPath = job.path; use.style.display = ''; detail.textContent += `\n${readyPath}`; apply(); break }
        if (['failed', 'cancelled'].includes(job.status)) break
        await new Promise(resolve => setTimeout(resolve, 500))
        job = await api.get(`/api/java/download/${id}`)
      }
    } catch (e) { detail.textContent = e.message }
    finally { busy = false; start.disabled = false; version.disabled = false; cancel.style.display = 'none'; id = '' }
  }
  panel.append(h('p', {}, '选择服务端所需的 Java 大版本。已有可用版本会直接复用；关闭此窗口不会停止下载。'), version,
    h('div', { class: 'row wrap', style: { marginTop: '10px' } }, start, cancel, use), detail, bar)
  return h('button', { class: 'btn btn-sm', onclick: () => {
    if (!busy) version.value = String(recommendedJava(getRuntime?.()))
    openModal({ title: '下载 Java', body: panel })
  } }, '下载 Java…')
}
