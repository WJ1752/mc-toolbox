// 启动器更新提示：右下角常驻卡片 + 更新弹窗（版本说明 / 下载进度 / 自动重启）。
//
// 与服务端 app-update.js 对应：
//   GET  /api/launcher/update/check     检查 GitHub Releases
//   POST /api/launcher/update/download  下载新 exe
//   GET  /api/launcher/update/state     下载进度
//   POST /api/launcher/update/apply     交给独立脚本替换并重启
//   POST /api/launcher/update/skip      忽略某个版本
import { h, fmtBytes } from '../core/dom.js'
import { launcherApi } from './api.js'
import { toast } from '../core/toast.js'
import { openModal } from '../core/modal.js'
import { icon } from '../ui/icons.js'
import { btn, iconBtn } from '../ui/kit.js'
import { progressBar, formatDate } from './ui.js'

let cardEl = null
let lastInfo = null
let checking = null
let autoTimer = null

function toastRoot() {
  return document.getElementById('toastRoot') || document.body
}

function hideCard() {
  cardEl?.remove()
  cardEl = null
}

/** 关闭启动器窗口：WebView2 宿主会顺带通知后端退出，替换脚本随后重启新版。 */
export function closeAppWindow() {
  const webview = window.chrome?.webview
  if (webview) {
    try { webview.postMessage('close'); return } catch {}
  }
  try { navigator.sendBeacon('/api/shutdown') } catch {}
  setTimeout(() => { try { window.close() } catch {} }, 300)
}

function renderCard(info) {
  cardEl?.remove()
  cardEl = h('div', { class: 'lp-update-card', role: 'status', 'aria-live': 'polite' })
  cardEl.append(
    h('div', { class: 'lp-update-badge' }, icon('refresh', { size: 16 })),
    h('div', { class: 'lp-update-copy' },
      h('b', {}, `启动器有新版本 v${info.latest}`),
      h('span', {}, `当前 v${info.current}${info.release?.publishedAt ? ' · 发布于 ' + formatDate(info.release.publishedAt) : ''}`)
    ),
    h('div', { class: 'lp-update-card-actions' },
      btn('立即更新', { variant: 'primary', size: 'sm', onClick: () => openUpdateDialog(info) }),
      btn('稍后', { variant: 'ghost', size: 'sm', onClick: hideCard }),
      iconBtn('close', { label: '关闭更新提示', size: 12, class: 'lp-update-card-close', onClick: hideCard })
    )
  )
  toastRoot().appendChild(cardEl)
}

function notesBlock(text) {
  const box = h('div', { class: 'lp-update-notes' })
  const content = String(text || '').trim()
  if (!content) {
    box.appendChild(h('div', { class: 'lp-update-notes-empty' }, '这个版本没有附带更新说明。'))
    return box
  }
  // 纯文本渲染：不解释 Markdown/HTML，发布说明里的标签不会被当成 DOM 执行。
  for (const raw of content.split(/\r?\n/)) {
    const text = raw.replace(/^#{1,6}\s*/, '')
    box.appendChild(h('div', { class: text.trim() ? 'lp-update-line' : 'lp-update-gap' }, text))
  }
  return box
}

/**
 * 打开更新弹窗。下载 / 替换 / 重启都在弹窗内完成。
 * @param {object} info check 接口返回的对象
 */
export function openUpdateDialog(info) {
  if (!info?.updateAvailable) {
    toast(info?.latest ? `已是最新版本 v${info.current}` : '还没有可用发布', 'ok')
    return null
  }

  const session = { alive: true }
  const progress = progressBar(0)
  const progressWrap = h('div', { class: 'lp-update-progress', hidden: true }, progress.el)
  const status = h('div', { class: 'lp-update-status' })
  const errorEl = h('div', { class: 'lp-update-error', hidden: true })

  let modal = null
  const ui = { progress, progressWrap, status, errorEl, startBtn: null, laterBtn: null, skipBtn: null, session }

  ui.startBtn = btn('下载并更新', {
    variant: 'primary',
    iconName: 'download',
    onClick: () => runUpdate(modal, info, ui)
  })
  ui.laterBtn = btn('稍后', { variant: 'ghost', onClick: () => modal?.close() })
  ui.skipBtn = btn('忽略此版本', {
    variant: 'ghost',
    size: 'sm',
    title: '以后不再提示这个版本',
    onClick: async () => {
      try {
        await launcherApi.updateSkip(info.latest)
        hideCard()
        modal?.close()
        toast(`已忽略 v${info.latest}`, 'ok')
      } catch (e) {
        toast('忽略失败：' + e.message, 'err')
      }
    }
  })
  const releaseBtn = h('a', {
    class: 'btn btn-sm btn-ghost',
    href: info.release?.htmlUrl || `https://github.com/${info.repo}/releases`,
    target: '_blank',
    rel: 'noopener noreferrer'
  }, icon('external', { size: 13 }), '发布页')

  const assetText = info.asset
    ? `${info.asset.name}${info.asset.size ? ' · ' + fmtBytes(info.asset.size) : ''}`
    : '（发布里没有 exe，请到发布页手动下载）'

  modal = openModal({
    title: '启动器更新',
    size: 'md',
    body: h('div', { class: 'lp-update-dialog' },
      h('div', { class: 'lp-update-versions' },
        h('span', { class: 'lp-update-from' }, 'v' + info.current),
        icon('arrow-right', { size: 14 }),
        h('span', { class: 'lp-update-to' }, 'v' + info.latest)
      ),
      h('div', { class: 'lp-update-meta' },
        `${info.repo} · ${info.release?.prerelease ? '预发布' : '正式发布'} · ${assetText}`
      ),
      notesBlock(info.release?.notes),
      progressWrap,
      status,
      errorEl
    ),
    buttons: [releaseBtn, ui.skipBtn, ui.laterBtn, ui.startBtn],
    onClose: () => { session.alive = false }
  })

  if (!info.canApply) {
    // 只禁用「下载并更新」；稍后 / 忽略 / 发布页仍要让用户能正常退出。
    ui.startBtn.disabled = true
    status.textContent = '当前是开发模式或非 Windows 环境：可以在发布页手动下载，无法自动替换正在运行的程序。'
  }
  return modal
}

function resetButtons(ui, { enabled = true } = {}) {
  ui.startBtn.disabled = !enabled
  ui.laterBtn.disabled = !enabled
  ui.skipBtn.disabled = !enabled
}

async function runUpdate(modal, info, ui) {
  if (!info.canApply) return
  resetButtons(ui, { enabled: false })
  ui.progressWrap.hidden = false
  ui.errorEl.hidden = true
  ui.status.textContent = '正在准备下载…'
  ui.progress.set(0, true)

  try {
    await launcherApi.updateDownload()
  } catch (e) {
    ui.status.textContent = ''
    ui.progressWrap.hidden = true
    ui.errorEl.hidden = false
    ui.errorEl.textContent = '开始下载失败：' + e.message
    resetButtons(ui)
    return
  }

  await new Promise((resolve) => setTimeout(resolve, 500))
  pollDownload(ui)
}

async function pollDownload(ui) {
  if (!ui.session.alive) return
  let state
  try {
    state = await launcherApi.updateState()
  } catch (e) {
    ui.errorEl.hidden = false
    ui.errorEl.textContent = '读取下载进度失败：' + e.message
    resetButtons(ui)
    return
  }
  if (!ui.session.alive) return

  if (state.status === 'downloading') {
    const total = Number(state.total) || 0
    const received = Number(state.received) || 0
    const pct = total ? Math.min(100, Math.round((received / total) * 100)) : 0
    ui.progress.set(pct, !total)
    ui.status.textContent = total
      ? `正在下载更新包 ${fmtBytes(received)} / ${fmtBytes(total)}（${pct}%）`
      : `正在下载更新包 ${fmtBytes(received)}`
    setTimeout(() => pollDownload(ui), 600)
    return
  }

  if (state.status === 'error') {
    ui.progressWrap.hidden = true
    ui.status.textContent = ''
    ui.errorEl.hidden = false
    ui.errorEl.textContent = '下载失败：' + (state.error || '未知错误')
    resetButtons(ui)
    return
  }

  if (state.status === 'ready') {
    await applyNow(ui)
    return
  }

  setTimeout(() => pollDownload(ui), 600)
}

async function applyNow(ui) {
  ui.progress.set(100)
  ui.status.textContent = '下载完成，正在替换程序…'
  await new Promise((resolve) => setTimeout(resolve, 400))
  try {
    const res = await launcherApi.updateApply()
    if (!res?.restarting) throw new Error('启动替换脚本失败')
    ui.progressWrap.hidden = true
    ui.status.textContent = '更新完成，启动器正在重启…'
    setTimeout(closeAppWindow, 1500)
  } catch (e) {
    ui.progressWrap.hidden = true
    ui.status.textContent = ''
    ui.errorEl.hidden = false
    ui.errorEl.textContent = '自动更新失败：' + e.message
    resetButtons(ui)
  }
}

/**
 * 检查更新。silent=true 时只在有新版本时弹卡片，不弹错误提示。
 * @returns {Promise<object|null>}
 */
export async function checkForUpdates({ silent = true, force = false } = {}) {
  if (checking) return checking
  checking = (async () => {
    try {
      const info = await launcherApi.updateCheck(force)
      lastInfo = info
      if (info.updateAvailable && !info.skipped) renderCard(info)
      else hideCard()
      if (!silent) {
        if (info.updateAvailable) openUpdateDialog(info)
        else if (!info.latest) toast('仓库里还没有发布版本', 'info')
        else toast(`已是最新版本 v${info.current}`, 'ok')
      }
      return info
    } catch (e) {
      hideCard()
      // 自动检查失败不打扰用户，但要留在控制台方便排查。
      console.warn('[update] 检查更新失败：' + (e?.message || e))
      if (!silent) toast('检查更新失败：' + e.message, 'err')
      return null
    } finally {
      checking = null
    }
  })()
  return checking
}

/** 设置页「关于」用的手动检查入口。 */
export function checkForUpdatesManual() {
  return checkForUpdates({ silent: false, force: true })
}

export function getLastUpdateInfo() {
  return lastInfo
}

/**
 * 初始化：启动器加载完成后按设置自动检查一次。
 * @param {{autoCheck?: boolean, delay?: number}} [options]
 */
export function initUpdateChecker({ autoCheck = true, delay = 1500 } = {}) {
  if (autoTimer) clearTimeout(autoTimer)
  autoTimer = null
  if (autoCheck) {
    autoTimer = setTimeout(() => {
      autoTimer = null
      checkForUpdates({ silent: true }).catch(() => {})
    }, delay)
  }
  return { check: checkForUpdates }
}

/** 页面卸载时清掉定时器与卡片（避免反复初始化堆积）。 */
export function disposeUpdateChecker() {
  if (autoTimer) clearTimeout(autoTimer)
  autoTimer = null
  hideCard()
}

// 供调试/测试使用：当前是否有可见的更新卡片。
export function isUpdateCardVisible() {
  return !!(cardEl && cardEl.isConnected)
}
