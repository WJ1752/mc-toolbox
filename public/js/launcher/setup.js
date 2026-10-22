// 首次启动：选择游戏目录（.minecraft）。
//
// 默认位置与 PCL / HMCL 一致：启动器所在目录下的 .minecraft。
// 用户也可以选择任意文件夹，启动器会在其中创建 / 使用 .minecraft。
import { h } from '../core/dom.js'
import { openModal } from '../core/modal.js'
import { pickDir } from '../core/dirpicker.js'
import { btn } from '../ui/kit.js'
import { icon } from '../ui/icons.js'
import { launcherApi } from './api.js'
import { suggestGameRoot } from '../core/settings-launcher.js'

/**
 * @param {{settings?:object, onDone?:Function, onCancel?:Function}} options
 * @returns {{close:Function}|undefined}
 */
export function openGameDirSetup({ settings = {}, onDone, onCancel } = {}) {
  const fallback = settings.defaultRoot || settings.root || ''
  // 还没确认过目录时优先推荐新的默认位置（exe 同级 .minecraft），
  // 而不是旧版自动写入的 data/minecraft。
  let target = settings.defaultRoot || settings.root || fallback
  let closed = false

  const pathEl = h('b', {}, target || '—')
  const errorEl = h('div', { class: 'error', hidden: true })

  function showError(text) {
    errorEl.textContent = text
    errorEl.hidden = false
  }

  async function chooseDir() {
    let picked = ''
    try {
      picked = await pickDir(target || fallback, { title: '选择启动器文件夹' })
    } catch (e) {
      showError('无法打开目录选择器：' + e.message)
      return
    }
    if (!picked) return
    target = suggestGameRoot(picked)
    pathEl.textContent = target
    errorEl.hidden = true
  }

  const primary = btn('使用此目录', {
    variant: 'primary',
    iconName: 'check',
    onClick: async () => {
      if (!target) {
        showError('请先选择一个文件夹')
        return
      }
      primary.disabled = true
      primary.classList.add('loading')
      errorEl.hidden = true
      try {
        const next = await launcherApi.saveSettings({ root: target })
        closed = true
        modal?.close()
        onDone?.(next)
      } catch (e) {
        showError('无法使用这个目录：' + e.message)
        primary.disabled = false
        primary.classList.remove('loading')
      }
    }
  })

  const body = h('div', { class: 'lp-setup' },
    h('p', { class: 'lp-setup-lead' }, '启动器需要一个游戏目录。默认会在启动器旁边使用 .minecraft（和 PCL / HMCL 一样），也可以选择其它文件夹。'),
    h('div', { class: 'lp-setup-path' }, icon('folder', { size: 15 }), pathEl),
    h('div', { class: 'hint' }, '如果文件夹里已经有 .minecraft 会直接使用；没有的话会创建 versions / libraries / assets / instances。'),
    h('div', { class: 'hint' }, '已有实例会继续使用它们原来的目录，不会被移动；之后也可以在「设置 → 游戏目录」里更换。'),
    errorEl,
    h('div', { class: 'lp-setup-actions' }, btn('选择其它文件夹…', { iconName: 'folder-open', onClick: chooseDir }))
  )

  const modal = openModal({
    title: '选择游戏目录',
    size: 'md',
    body,
    buttons: [primary],
    onClose: () => {
      if (!closed) onCancel?.()
    }
  })

  return modal
}
