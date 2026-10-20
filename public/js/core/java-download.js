import { h } from './dom.js'
import { api } from './api.js'
import { openModal } from './modal.js'
import { toast } from './toast.js'
import { progress, select, btn } from '../ui/kit.js'

export function recommendedJava(runtime = {}) {
  if (runtime.loader === 'cleanroom') return /^0\.[0-5]\./.test(runtime.loaderVersion || '') ? 21 : 25
  const [, minor, patch = '0'] = /^1\.(\d+)(?:\.(\d+))?$/.exec(runtime.mc || '') || []
  return Number(minor) > 20 || (Number(minor) === 20 && Number(patch) >= 5) ? 21 : Number(minor) >= 18 ? 17 : Number(minor) === 17 ? 16 : 8
}

/**
 * Shared "download / pick Java" control used by client2server, server-core
 * and server-manager.
 */
export function javaDownloadButton({ getRuntime, isLocked = () => false, onReady }) {
  const majors = Array.from({ length: 18 }, (_, i) => i + 8)
  const version = select(majors.map((n) => [String(n), `Java ${n}（64 位）`]), '21', { ariaLabel: '下载 Java 大版本' })
  const installed = select([['', '正在扫描本机 Java…']], '', { ariaLabel: '本机已发现的 Java' })
  installed.style.marginTop = '8px'
  const useInstalled = btn('使用选中的本机 Java', { size: 'sm', disabled: true })
  useInstalled.style.marginTop = '8px'
  const detail = h('div', {
    class: 'muted',
    'aria-live': 'polite',
    style: { overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', marginTop: '10px', fontSize: '11.5px', lineHeight: '1.6' }
  }, '可下载 Java 8–25；也可以直接选择本机已安装的任意 64 位 Java。启动前仍会检查版本是否适合当前 MC / 加载器。')
  const bar = progress(0)
  bar.el.style.marginTop = '8px'
  bar.el.style.display = 'none'
  const start = btn('下载 / 使用此版本', { variant: 'primary' })
  const cancel = btn('中止下载', { variant: 'danger', class: 'btn-sm' })
  cancel.style.display = 'none'
  const use = btn('使用已下载的 Java', { size: 'sm' })
  use.style.display = 'none'

  let id = ''
  let busy = false
  let readyPath = ''
  let cancelRequested = false

  function clearOptions(sel) {
    while (sel.firstChild) sel.removeChild(sel.firstChild)
  }

  async function loadInstalled() {
    try {
      const data = await api.get('/api/java/available')
      clearOptions(installed)
      const items = data.items || []
      installed.appendChild(h('option', { value: '' }, items.length ? '选择本机 Java（可搜索）' : '未发现本机 Java'))
      for (const item of items) {
        installed.appendChild(h('option', { value: item.path }, `Java ${item.major} · ${item.version || '未知版本'} · ${item.path}`))
      }
      useInstalled.disabled = !items.length
    } catch (e) {
      clearOptions(installed)
      installed.appendChild(h('option', { value: '' }, '本机 Java 扫描失败'))
      detail.textContent = e.message
    }
  }

  useInstalled.onclick = () => {
    const p = installed.value
    if (!p) return
    readyPath = p
    apply()
  }

  function apply() {
    if (isLocked()) {
      detail.textContent += '\nJava 已保存在工具箱中。请等当前任务结束后再点击「使用已下载的 Java」。'
      return
    }
    onReady(readyPath)
  }

  use.onclick = apply

  cancel.onclick = async () => {
    cancelRequested = true
    cancel.disabled = true
    if (id) {
      await api.post(`/api/java/download/${id}/cancel`).catch((e) => { detail.textContent = e.message })
    }
  }

  start.onclick = async () => {
    if (busy) return
    busy = true
    cancelRequested = false
    start.disabled = true
    version.disabled = true
    cancel.disabled = false
    cancel.style.display = ''
    use.style.display = 'none'
    bar.el.style.display = ''
    bar.set(0)
    try {
      let job = await api.post('/api/java/download', { major: Number(version.value) })
      id = job.id
      if (cancelRequested && id) await api.post(`/api/java/download/${id}/cancel`)
      for (;;) {
        detail.textContent = job.detail + (job.progress == null ? '' : `（${Math.floor(job.progress)}%）`)
        bar.set(job.progress)
        if (job.status === 'done') {
          readyPath = job.path
          use.style.display = ''
          detail.textContent += `\n${readyPath}`
          apply()
          break
        }
        if (['failed', 'cancelled'].includes(job.status)) break
        await new Promise((resolve) => setTimeout(resolve, 500))
        job = await api.get(`/api/java/download/${id}`)
      }
    } catch (e) {
      detail.textContent = e.message
    } finally {
      busy = false
      start.disabled = false
      version.disabled = false
      cancel.style.display = 'none'
      id = ''
    }
  }

  const panel = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    h('div', { class: 'fx-note' }, '选择服务端所需的 Java 大版本。已有可用版本会直接复用；关闭此窗口不会停止下载。'),
    h('div', { class: 'field' }, h('label', {}, '目标大版本'), version),
    h('div', { class: 'field' }, h('label', {}, '本机已安装'), installed, useInstalled),
    h('div', { class: 'row wrap', style: { marginTop: '4px' } }, start, cancel, use),
    bar.el,
    detail
  )

  return h('button', {
    class: 'btn btn-sm',
    type: 'button',
    onclick: () => {
      if (!busy) version.value = String(recommendedJava(getRuntime?.()))
      loadInstalled()
      openModal({ title: '下载 Java', size: 'md', body: panel })
    }
  }, '下载 Java…')
}
