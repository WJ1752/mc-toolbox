import { h, clear } from '../core/dom.js'
import { openModal } from '../core/modal.js'
import { api } from '../core/api.js'
import { btn, input, select } from '../ui/kit.js'

export function openPackUpdate(inst) {
  const route = '/api/launcher/instances/' + encodeURIComponent(inst.id) + '/pack-update'
  let closed = false, timer
  const body = h('div', { class: 'col gap' })
  const message = h('div', { class: 'lp-hint', role: 'status' })
  const panel = h('div', { class: 'col gap' })
  body.append(message, panel)
  const modal = openModal({
    title: '整合包更新 · ' + inst.name, size: 'lg', body,
    buttons: [{ label: '关闭', class: 'btn-ghost' }],
    onClose: () => { closed = true; clearTimeout(timer) }
  })
  function action(label, fn, primary = false) {
    const button = btn(label, { variant: primary ? 'primary' : '', onClick: async () => {
      button.disabled = true
      try { await fn() } catch (error) { message.textContent = error.message }
      finally { button.disabled = false }
    } })
    return button
  }
  function list(title, values) {
    return h('details', {}, h('summary', {}, title + '（' + values.length + '）'),
      h('pre', { style: { maxHeight: '220px', overflow: 'auto', whiteSpace: 'pre-wrap' } }, values.join('\n') || '无'))
  }
  function diff(title, data) {
    if (!data) return h('p', {}, title + '：旧实例缺少安装时清单，无法可靠比较。')
    return h('div', {}, h('b', {}, title), list('新增', data.added), list('变更', data.changed), list('移除', data.removed))
  }
  async function poll() {
    if (closed) return
    try {
      const result = await api.get(route + '/review')
      if (closed) return
      renderJob(result)
    } catch (error) {
      message.textContent = error.message
      clear(panel)
      panel.append(action('重试', poll))
    }
  }
  function renderJob({ job, preview, approved }) {
    clear(panel)
    if (!job) { message.textContent = '预览已结束。'; panel.append(action('重新检查', check)); return }
    if (['done', 'failed', 'cancelled'].includes(job.status)) {
      message.textContent = job.error || job.detail || job.status
      panel.append(action('重新检查', check))
      return
    }
    if (approved) {
      message.textContent = '已开始安装升级副本，可在下载中心查看进度。'
      return
    }
    const cancel = action('取消预览', async () => {
      await api.post(route + '/cancel', { jobId: job.id })
      clearTimeout(timer)
      await poll()
    })
    if (!preview) {
      message.textContent = [job.phase, job.detail].filter(Boolean).join(' · ')
      panel.append(cancel)
      timer = setTimeout(poll, 1200)
      return
    }
    message.textContent = preview.current.version + ' → ' + preview.latest.version
    const keep = h('input', { type: 'checkbox', checked: true })
    const actual = preview.installedComparison
    if (actual) {
      panel.append(h('b', {}, '当前实例文件与新版清单对照'),
        h('p', {}, '旧包缺少历史基线。以下按实际文件路径和可用的 SHA-1 比较；改名文件可能分别出现在两侧。'),
        list('本机未匹配到新版路径', actual.localOnly), list('新版路径在本机缺失', actual.targetOnly),
        list('同路径但内容不同', actual.different), list('本机已禁用', actual.disabled))
      if (actual.unverified.length) panel.append(list('同路径但缺少可比哈希', actual.unverified))
      if (actual.unmapped.length) panel.append(list('官方清单未提供本地路径，无法匹配', actual.unmapped))
    }
    panel.append(h('p', {}, 'Minecraft ' + preview.mc.join(' → ') + ' · ' + preview.loader.join(' → ')),
      diff('官方清单的模组 / 依赖', preview.manifest), diff('官方覆盖配置', preview.configs),
      diff('原实例中改动的模组与配置', preview.local))
    if (preview.conflicts) panel.append(list('本地与新版均有改动的配置', preview.conflicts))
    if (preview.modReview) {
      panel.append(list('本地修改、删除或禁用且新版也有改动的模组', preview.modReview.conflicts))
      if (preview.modReview.unmapped.length) panel.append(list('新版 CurseForge 文件名待安装时解析，目标路径冲突未知', preview.modReview.unmapped))
    }
    panel.append(h('p', {}, '新版安装到独立实例。旧存档、自加模组和自定义配置保留在原实例。'),
      h('label', {}, keep, ' 将原实例按键、鼠标、音量、语言和显示偏好合并到新版'),
      h('div', { class: 'row wrap' }, cancel, action('确认安装升级副本', async () => {
        await api.post(route + '/apply', { jobId: job.id, keepOptions: keep.checked })
        clear(panel)
        message.textContent = '已开始安装升级副本，请在下载中心查看进度。'
      }, true)))
  }
  async function check() {
    clear(panel)
    message.textContent = '正在查询整合包官方来源…'
    const result = await api.get(route)
    if (closed) return
    if (result.active) { renderJob(result.active); return }
    if (result.untracked) {
      message.textContent = result.bindable
        ? '此整合包没有官方版本记录。请按原下载页面填写当前已安装版本；历史模组与配置差异将标记为未知。'
        : '此实例没有可追踪的整合包安装记录。可从「新建实例 → 整合包」选择官方版本并作为独立实例安装。'
      if (!result.bindable) return
      const source = select([['modrinth', 'Modrinth'], ['curseforge', 'CurseForge']], 'modrinth')
      const project = input({ placeholder: '官方项目 ID' })
      const version = input({ placeholder: '当前已安装版本 ID / 文件 ID' })
      panel.append(source, project, version, action('关联当前已安装版本', async () => {
        await api.post(route + '/bind', { source: source.value, projectId: project.value.trim(), versionId: version.value.trim() })
        await check()
      }))
      return
    }
    message.textContent = result.available
      ? result.current.version + ' → ' + result.latest.version
      : '当前版本 ' + result.current.version + '，官方来源没有更晚的推荐版本。'
    if (result.available) panel.append(action('下载新版整包并预览差异', async () => {
      const data = await api.post(route + '/prepare', { versionId: result.latest.versionId })
      if (!closed) renderJob(data)
    }, true))
  }
  check().catch(error => {
    if (!closed) { message.textContent = error.message; panel.append(action('重试', check)) }
  })
  return modal
}
