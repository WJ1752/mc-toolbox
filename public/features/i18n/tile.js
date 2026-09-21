import { h, clear } from '/js/core/dom.js'
import { api } from '/js/core/api.js'
import { toast } from '/js/core/toast.js'

let ctxRef = null
let timer = null
let els = {}
let lastStatus = null

function statusLabel(status) {
  if (!status?.available) return '运行时不可用'
  if (status.starting) return '启动中'
  if (status.running) return '已运行'
  return '未启动'
}

function statusClass(status) {
  if (!status?.available) return 'bad'
  if (status.starting || status.running) return 'info'
  return ''
}

function settingsOf(ctx) {
  return (ctx?.settings?.() || {})
}

export default {
  async mount(ctx) {
    ctxRef = ctx
    const statusEl = h('span', { class: 'badge' }, '检查中…')
    const detailEl = h('div', { class: 'muted', style: { minHeight: '30px' } }, '正在检查 mc-i18n 运行时')
    const btnStart = h('button', { class: 'btn btn-sm btn-primary' }, '▶ 启动翻译工作台')
    const btnOpen = h('button', { class: 'btn btn-sm', disabled: true }, '↗ 打开工作台')
    const btnStop = h('button', { class: 'btn btn-sm', disabled: true }, '■ 停止引擎')
    els = { statusEl, detailEl, btnStart, btnOpen, btnStop }

    btnStart.onclick = startEngine
    btnOpen.onclick = () => openWorkbench(lastStatus)
    btnStop.onclick = stopEngine

    ctx.body.appendChild(h('div', { class: 'row' },
      h('b', {}, 'Minecraft 整合包翻译'),
      h('span', { class: 'spacer' }),
      statusEl))
    ctx.body.appendChild(detailEl)
    ctx.body.appendChild(h('div', { class: 'row wrap', style: { marginTop: '8px' } }, btnStart, btnOpen, btnStop))

    await refresh()
    if (settingsOf(ctx).i18n?.autoStart && lastStatus?.available && !lastStatus.running) {
      await startEngine()
    }
    timer = setInterval(refresh, 3000)
  },

  unmount() {
    if (timer) clearInterval(timer)
    timer = null
  },

  renderExpanded(container) {
    openWorkbench(lastStatus, container)
  }
}

async function refresh() {
  if (!els.statusEl) return
  try {
    lastStatus = await api.get('/api/i18n/status')
    renderStatus(lastStatus)
  } catch (e) {
    els.detailEl.textContent = '无法读取翻译引擎状态：' + e.message
  }
}

function renderStatus(status) {
  const label = statusLabel(status)
  els.statusEl.className = 'badge ' + statusClass(status)
  els.statusEl.textContent = label
  els.btnStart.disabled = !status.available || status.starting || status.running
  els.btnOpen.disabled = !status.running
  els.btnStop.disabled = !status.running && !status.starting
  if (!status.available) {
    els.detailEl.textContent = '未找到内置 mc-i18n 源码。开发模式需要 Python 3.10+，打包版可放置 mc-i18n.exe。'
    ctxRef?.setBadge('需配置', 'bad')
  } else if (status.starting) {
    els.detailEl.textContent = '正在启动翻译工作台，请稍候…'
    ctxRef?.setBadge('启动中', 'info')
  } else if (status.running) {
    els.detailEl.textContent = `翻译工作台已就绪${status.port ? ` · 端口 ${status.port}` : ''}`
    ctxRef?.setBadge('已就绪', 'ok')
  } else {
    els.detailEl.textContent = '支持语言文件扫描、批量翻译、任务书、术语表、校对和资源包打包。'
    ctxRef?.setBadge('', '')
  }
}

async function startEngine() {
  if (!lastStatus?.available) {
    toast('未找到 mc-i18n 运行时，请先配置 Python 3.10+ 或放置打包的 mc-i18n.exe', 'err')
    return
  }
  els.btnStart.disabled = true
  try {
    lastStatus = await api.post('/api/i18n/start', { i18n: settingsOf(ctxRef).i18n || {} })
    renderStatus(lastStatus)
    toast('翻译工作台已启动', 'ok')
    openWorkbench(lastStatus)
  } catch (e) {
    toast('翻译引擎启动失败：' + e.message, 'err')
    await refresh()
  }
}

async function stopEngine() {
  try {
    await api.post('/api/i18n/stop')
    await refresh()
    toast('翻译引擎已停止', 'ok')
  } catch (e) {
    toast('停止翻译引擎失败：' + e.message, 'err')
  }
}

function openWorkbench(status, providedContainer = null) {
  if (!status?.running || !status.url) {
    toast('请先启动翻译工作台', 'err')
    return
  }
  const frame = h('iframe', {
    title: 'mc-i18n 翻译工作台',
    src: status.url,
    style: {
      width: '100%',
      height: 'min(78vh, 920px)',
      minHeight: '640px',
      border: '1px solid var(--line)',
      borderRadius: '6px',
      background: 'var(--panel)'
    }
  })
  if (providedContainer) {
    clear(providedContainer)
    providedContainer.appendChild(frame)
    return
  }
  ctxRef?.expand((container) => container.appendChild(frame), { size: 'xl' })
}

