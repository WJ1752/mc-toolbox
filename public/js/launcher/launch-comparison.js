import { h, fmtDateTime } from '../core/dom.js'
import { openModal } from '../core/modal.js'
import { btn } from '../ui/kit.js'
import { launcherApi } from './api.js'
import { showModUpdateBackup } from './mod-update-backup.js'

const statusText = {
  preparing: '准备中', captured: '已记录启动配置', running: '运行中', 'window-ready': '等待确认就绪',
  failed: '启动失败', success: '成功启动', stopped: '已停止',
  cancelled: '已取消', exited: '已退出', 'snapshot-error': '快照读取失败'
}

function settingValue(key, value) {
  if (value === null || value === undefined || value === '') return '未设置'
  if (typeof value === 'boolean') return value ? '开启' : '关闭'
  return key.startsWith('memory.') ? value + ' MB' : String(value)
}

// 仅使用快照中的文件名和模组声明的 ID，避免把 sodium-extra 的报错归给 sodium。
function evidenceFor(items, evidence) {
  const names = new Set(items.flatMap(item => [
    item.relPath.split('/').pop().replace(/\.disabled$/i, ''), item.modid, ...(item.modids || [])
  ]).filter(Boolean))
  const patterns = [...names].map(name => {
    const literal = name.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')
    return new RegExp('(?:^|[^\\p{L}\\p{N}_-])' + literal + '(?=$|[^\\p{L}\\p{N}_-])', 'iu')
  })
  return evidence.find(entry => patterns.some(pattern => pattern.test(entry.text || entry)))
}

function modChanges(mods, evidence) {
  const rows = []
  function add(label, items, description) {
    rows.push({ label, description, evidence: evidenceFor(items, evidence) })
  }
  for (const item of mods.added) add('新增', [item], item.relPath)
  for (const item of mods.removed) add('移除', [item], item.relPath)
  for (const { before, after } of mods.changed) {
    const label = before.enabled !== after.enabled ? (after.enabled ? '启用' : '禁用') : '变更'
    const name = before.relPath === after.relPath ? after.relPath : before.relPath + ' → ' + after.relPath
    const version = before.version && after.version && before.version !== after.version
      ? '（' + before.version + ' → ' + after.version + '）'
      : before.sha1 !== after.sha1 ? '（文件内容已变化）' : ''
    add(label, [before, after], name + version)
  }
  return rows.sort((a, b) => Number(!!b.evidence) - Number(!!a.evidence))
}

export function openLaunchComparison(inst) {
  const body = h('div', { class: 'lp-launch-comparison col gap' })
  let closed = false
  openModal({
    title: '对比上次成功启动 · ' + inst.name, size: 'lg', body,
    buttons: [{ label: '关闭' }], onClose: () => { closed = true }
  })

  async function load() {
    if (closed) return
    body.replaceChildren(h('p', { role: 'status' }, '正在读取本实例的启动记录…'))
    try {
      const { attempt, baseline, comparison, undo } = await launcherApi.launchComparison(inst.id)
      if (closed) return
      if (!attempt) {
        body.replaceChildren(h('p', {}, '这个实例还没有启动记录。使用工具箱成功启动一次游戏后，就可以和之后的启动对比。'))
        return
      }
      const status = statusText[attempt.status]
      body.replaceChildren(h('p', {}, '本次启动 · ' + fmtDateTime(attempt.startedAt) + (status ? ' · ' + status : '')))
      if (attempt.error?.message) body.append(h('p', { class: 'lp-hint' }, attempt.error.message))
      if (!baseline) {
        body.append(h('p', {}, '此次启动前没有可用的成功记录。' + (attempt.status === 'success' ? '这次记录可供下次对比。' : '需要先用工具箱成功启动此实例一次。')))
        return
      }
      body.append(h('p', {}, '上次成功启动 · ' + fmtDateTime(baseline.capturedAt || baseline.succeededAt)))
      if (!comparison) {
        body.append(h('p', {}, '本次启动没有完整快照，无法比较模组和设置。'))
        return
      }
      const rows = modChanges(comparison.mods, attempt.error?.evidence || [])
      const settings = comparison.settings
      if (!rows.length && !settings.length && !comparison.jvmArgsChanged) {
        body.append(h('p', {}, '两次启动记录的模组、Java 和启动设置一致。'))
        return
      }
      if (rows.length) {
        body.append(h('strong', {}, '模组变化（' + rows.length + '）'),
          h('div', { class: 'lp-list' }, rows.map(row => h('div', { class: 'lp-row' },
            h('span', { class: 'lp-chip' }, row.label),
            h('div', { class: 'lp-row-main' }, h('span', {}, row.description),
              row.evidence ? h('div', {}, h('small', {}, '本次报错原文提及' +
                (row.evidence.file && row.evidence.line ? ' · ' + row.evidence.file.split(/[\\/]/).pop() + ' 第 ' + row.evidence.line + ' 行' : '')),
                h('pre', { class: 'mono' }, row.evidence.text || row.evidence)) : null)))))
      }
      if (settings.length || comparison.jvmArgsChanged) {
        body.append(h('strong', {}, '启动设置'),
          h('div', { class: 'lp-list' }, settings.map(item => h('div', { class: 'lp-row' },
            h('b', {}, item.label), h('span', {}, settingValue(item.key, item.before) + ' → ' + settingValue(item.key, item.after)))),
          comparison.jvmArgsChanged ? h('div', { class: 'lp-row' }, '自定义 JVM 参数已变化') : null))
      }
      if (undo?.available) {
        body.append(btn('查看可撤销的模组更新', { onClick: () => showModUpdateBackup(inst.id, undo, { onUndo: load }) }))
      }
    } catch (error) {
      if (!closed) body.replaceChildren(h('p', {}, '读取启动对比失败：' + error.message), btn('重试', { onClick: load }))
    }
  }
  void load()
}
