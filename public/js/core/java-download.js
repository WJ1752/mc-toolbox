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
  const majors = Array.from({ length: 18 }, (_, i) => i + 8)
  const version = h('select', { class: 'input', 'aria-label': '下载 Java 大版本' }, ...majors.map(n => h('option', { value: String(n) }, `Java ${n}（64 位）`)))
  const installed = h('select', { class: 'input', 'aria-label': '本机已发现的 Java', style: { marginTop: '8px' } }, h('option', { value: '' }, '正在扫描本机 Java…'))
  const useInstalled = h('button', { class: 'btn btn-sm', disabled: true, style: { marginTop: '8px' } }, '使用选中的本机 Java')
  const detail = h('div', { class: 'muted', 'aria-live': 'polite', style: { overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', marginTop: '10px' } }, '可下载 Java 8–25；也可以直接选择本机已安装的任意 64 位 Java。最终启动前仍会检查它是否适合当前 MC / 加载器。')
  const fill = h('i', { style: { width: '0%' } })
  const bar = h('div', { class: 'bar', style: { display: 'none', marginTop: '8px' } }, fill)
  const start = h('button', { class: 'btn btn-primary' }, '下载 / 使用此版本')
  const cancel = h('button', { class: 'btn btn-danger', style: { display: 'none' } }, '中止下载')
  const use = h('button', { class: 'btn', style: { display: 'none' } }, '使用已下载的 Java')
  let id = '', busy = false, readyPath = '', cancelRequested = false
  async function loadInstalled() {
    try {
      const data = await api.get('/api/java/available')
      clearOptions(installed)
      const items = data.items || []
      installed.appendChild(h('option', { value: '' }, items.length ? '选择本机 Java（可搜索）' : '未发现本机 Java'))
      for (const item of items) installed.appendChild(h('option', { value: item.path }, `Java ${item.major} · ${item.version || '未知版本'} · ${item.path}`))
      useInstalled.disabled = !items.length
    } catch (e) { clearOptions(installed); installed.appendChild(h('option', { value: '' }, '本机 Java 扫描失败')); detail.textContent = e.message }
  }
  const clearOptions = (select) => { while (select.firstChild) select.removeChild(select.firstChild) }
  useInstalled.onclick = () => { const p = installed.value; if (!p) return; readyPath = p; apply() }
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
    installed, useInstalled,
    h('div', { class: 'row wrap', style: { marginTop: '10px' } }, start, cancel, use), detail, bar)
  return h('button', { class: 'btn btn-sm', onclick: () => {
    if (!busy) version.value = String(recommendedJava(getRuntime?.()))
    loadInstalled()
    openModal({ title: '下载 Java', body: panel })
  } }, '下载 Java…')
}
