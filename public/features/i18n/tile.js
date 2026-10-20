import { h, clear, copyText } from '/js/core/dom.js'
import { api } from '/js/core/api.js'
import { toast } from '/js/core/toast.js'
import { icon } from '/js/ui/icons.js'
import { btn, emptyState } from '/js/ui/kit.js'

let timer = null

export default {
  async mount(ctx) {
    buildConsole(ctx, ctx.body, { expanded: false })
  },
  unmount() {
    if (timer) clearInterval(timer)
    timer = null
  },
  renderExpanded(container, { ctx } = {}) {
    buildConsole(ctx, container, { expanded: true })
  }
}

function statusLabel(st) {
  if (!st?.available) return '运行时不可用'
  if (st.starting) return '启动中'
  if (st.running) return '已运行'
  return '未启动'
}

function lampClass(st) {
  if (!st) return ''
  if (!st.available) return 'unavailable'
  if (st.starting) return 'starting'
  if (st.running) return 'on'
  return ''
}

function buildConsole(ctx, container, { expanded }) {
  if (!ctx) return
  const settings = ctx.settings() || {}
  let lastStatus = null
  let dead = false
  let missingNotified = false

  const lamp = h('span', { class: 'i18n-lamp' })
  const stateTitle = h('b', {}, '检查中…')
  const stateDetail = h('span', {}, '正在检查 mc-i18n 运行时')
  const stateLine = h('div', { class: 'i18n-state' }, stateTitle, stateDetail)

  const btnStart = btn('启动翻译工作台', { size: 'sm', variant: 'primary', iconName: 'play' })
  const btnOpen = btn('打开工作台', { size: 'sm', iconName: 'external', disabled: true })
  const btnStop = btn('停止引擎', { size: 'sm', iconName: 'stop', disabled: true })

  const addressLine = h('div', { class: 'ss-foot' })
  const errorBox = h('div', { class: 'fx-danger', hidden: true })

  const consoleCard = h('div', { class: 'i18n-console' },
    h('div', { class: 'i18n-lampline' }, lamp, stateLine),
    h('div', { class: 'i18n-actions' }, btnStart, btnOpen, btnStop),
    addressLine,
    errorBox
  )

  const notes = h('div', { class: 'col', style: { gap: '6px' } },
    h('div', { class: 'fx-note' }, '翻译工作台由 mc-i18n 提供：语言文件扫描、批量翻译、任务书、术语表、校对与资源包打包。'),
    h('div', { class: 'fx-note' }, '启动后会在浏览器的新窗口中打开工作台；翻译项目文件仍然保存在你选择的整合包目录。')
  )

  container.append(
    h('div', { class: 'col', style: { gap: '10px' } },
      consoleCard,
      expanded ? notes : null
    )
  )

  btnStart.onclick = startEngine
  btnOpen.onclick = openWorkbench
  btnStop.onclick = stopEngine

  async function refresh() {
    if (dead) return
    try {
      lastStatus = await api.get('/api/i18n/status')
      render(lastStatus)
    } catch (e) {
      stateDetail.textContent = '无法读取翻译引擎状态：' + e.message
      lamp.className = 'i18n-lamp unavailable'
      stateTitle.textContent = '状态不可用'
      btnStart.disabled = true
      btnOpen.disabled = true
      btnStop.disabled = true
    }
  }

  function render(st) {
    lamp.className = 'i18n-lamp ' + lampClass(st)
    stateTitle.textContent = statusLabel(st)
    btnStart.disabled = !st.available || st.starting || st.running
    btnOpen.disabled = !st.running
    btnStop.disabled = !st.running && !st.starting
    errorBox.hidden = true
    clear(addressLine)

    if (!st.available) {
      stateDetail.textContent = '未找到内置 mc-i18n 源码。开发模式需要 Python 3.10+，打包版可放置 mc-i18n.exe。'
      ctx.setBadge('需配置', 'bad')
      if (!missingNotified) {
        missingNotified = true
        ctx.setBadge('需配置', 'bad')
      }
      return
    }
    missingNotified = false
    if (st.starting) {
      stateDetail.textContent = '正在启动翻译工作台，请稍候…'
      ctx.setBadge('启动中', 'info')
      return
    }
    if (st.running) {
      stateDetail.textContent = '翻译工作台已就绪，可扫描、翻译、校对并打包语言文件。'
      ctx.setBadge('已就绪', 'ok')
      if (st.url) {
        addressLine.append(
          icon('link', { size: 12 }),
          h('span', { class: 'mono' }, st.url),
          h('span', { class: 'spacer' }),
          btn('复制地址', { size: 'xs', iconName: 'copy', onClick: async () => {
            const ok = await copyText(st.url)
            toast(ok ? '地址已复制' : '复制失败', ok ? 'ok' : 'err')
          } })
        )
      }
      if (st.port) addressLine.appendChild(h('span', { class: 'badge info' }, `端口 ${st.port}`))
      return
    }
    stateDetail.textContent = '支持语言文件扫描、批量翻译、任务书、术语表、校对和资源包打包。'
    ctx.setBadge('', '')
    addressLine.append(h('span', { class: 'muted', style: { fontSize: '10.5px' } },
      `Python：${settings.i18n?.pythonPath || '系统 PATH 中的 python'}`))
  }

  async function startEngine() {
    if (!lastStatus?.available) {
      toast('未找到 mc-i18n 运行时，请先配置 Python 3.10+ 或放置打包的 mc-i18n.exe', 'err')
      return
    }
    btnStart.disabled = true
    btnStart.classList.add('loading')
    try {
      lastStatus = await api.post('/api/i18n/start', { i18n: ctx.settings().i18n || {} })
      render(lastStatus)
      toast('翻译工作台已启动', 'ok')
      if (lastStatus.running) openWorkbench()
    } catch (e) {
      toast('翻译引擎启动失败：' + e.message, 'err')
      errorBox.hidden = false
      clear(errorBox)
      errorBox.append(icon('warning', { size: 13 }), h('span', {}, '启动失败：' + e.message))
      await refresh()
    } finally {
      btnStart.classList.remove('loading')
    }
  }

  async function stopEngine() {
    btnStop.disabled = true
    try {
      await api.post('/api/i18n/stop')
      await refresh()
      toast('翻译引擎已停止', 'ok')
    } catch (e) {
      toast('停止翻译引擎失败：' + e.message, 'err')
      errorBox.hidden = false
      clear(errorBox)
      errorBox.append(icon('warning', { size: 13 }), h('span', {}, '停止失败：' + e.message))
    } finally {
      btnStop.disabled = false
    }
  }

  function openWorkbench() {
    if (!lastStatus?.running || !lastStatus.url) {
      toast('请先启动翻译工作台', 'err')
      return
    }
    const w = window.open(lastStatus.url, '_blank', 'noopener')
    if (!w) {
      toast('浏览器拦截了新窗口，请允许弹出窗口后重试，或复制工作台地址', 'warn', 5000)
      return
    }
    toast('已在新窗口打开翻译工作台', 'ok')
  }

  refresh()
  const iv = setInterval(refresh, 3000)
  if (!expanded) timer = iv

  // stop polling once this console leaves the DOM (tile unmount or bench close)
  const observer = new MutationObserver(() => {
    if (!document.body.contains(container)) {
      dead = true
      clearInterval(iv)
      observer.disconnect()
      if (!expanded) timer = null
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })

  // auto-start only after the first status is known; settings may also start it at boot
  setTimeout(() => {
    if (dead) return
    if (settings.i18n?.autoStart && lastStatus?.available && !lastStatus.running && !lastStatus.starting) {
      startEngine()
    }
  }, 600)
}
