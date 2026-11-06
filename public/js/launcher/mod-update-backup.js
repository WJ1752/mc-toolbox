import { h, fmtDateTime } from '../core/dom.js'
import { openModal } from '../core/modal.js'
import { toast } from '../core/toast.js'
import { btn } from '../ui/kit.js'
import { launcherApi } from './api.js'

export function showModUpdateBackup(instanceId, backup, {
  api = launcherApi, modal = openModal, notify = toast, onUndo
} = {}) {
  const undo = btn('撤销这次更新', { variant: 'danger', onClick: async () => {
    undo.disabled = true
    try {
      await api.undoModUpdate(instanceId, backup.id)
    } catch (error) {
      notify('撤销失败：' + error.message, 'err')
      undo.disabled = false
      return
    }
    dialog.close()
    notify('已恢复更新前的模组和启停状态', 'ok')
    await onUndo?.()
  } })
  const dialog = modal({
    title: '最近一次模组更新', size: 'lg',
    body: h('div', {},
      h('p', { class: 'lp-hint' }, `${fmtDateTime(backup.createdAt)} · ${backup.items.length} 个模组。撤销整批更新将恢复左侧文件。`),
      h('div', { class: 'lp-list' }, backup.items.map(item =>
        h('div', { class: 'lp-row' }, h('span', { class: 'lp-row-meta' }, item.before + ' → ' + item.after))))),
    buttons: [{ label: '关闭' }, undo]
  })
}
