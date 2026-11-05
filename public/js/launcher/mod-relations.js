import { h } from '../core/dom.js'
import { badge } from '../ui/kit.js'

const key = id => String(id || '').trim().toLowerCase()
const active = item => item && !item.disabled && !item.loaderMismatch

/** Build edges once per dialog. Platform IDs are only compared to exact installed-file hash matches. */
export function buildModRelations(items, projects = []) {
  const byId = new Map(), byPath = new Map(), byProject = new Map(), byVersion = new Map()
  const bySeparator = new Map(), byFilename = new Map()
  const add = (map, id, item) => {
    if (!id) return
    if (!map.has(id)) map.set(id, [])
    map.get(id).push(item)
  }
  for (const item of items) {
    byPath.set(item.relPath, item)
    const ids = new Set([item.modid, ...(item.providedModIds || []), ...Object.keys(item.providedVersions || {})].map(key))
    if (item.hasMeta || item.modid) {
      for (const id of ids) {
        add(byId, id, item)
        if (/[-_]/.test(id)) add(bySeparator, id.replace(/-/g, '_'), item)
      }
    } else {
      for (const id of ids) add(byFilename, id, item)
    }
  }
  const known = projects.filter(p => {
    const item = byPath.get(p.relPath)
    return item && item.size === p.size && item.mtime === p.mtime
  })
  for (const p of known) {
    add(byProject, p.projectId, byPath.get(p.relPath))
    add(byVersion, p.versionId, byPath.get(p.relPath))
  }
  const outgoing = new Map(), incoming = new Map()
  function connect(owner, providers, detail) {
    for (const target of providers?.length ? providers : [null]) {
      const edge = { owner, target, ...detail }
      add(outgoing, owner.relPath, edge)
      if (target) add(incoming, target.relPath, edge)
    }
  }
  for (const item of items) {
    for (const [kind, deps] of [['needs', item.dependencies], ['conflicts', item.conflicts]]) {
      for (const dep of deps || []) {
        const id = key(dep.id)
        const exact = byId.get(id)
        const similar = bySeparator.get(id.replace(/-/g, '_'))
        const inferred = byFilename.get(id)
        const uncertain = exact ? '' : similar ? 'ID 分隔符不同，关联待核对' : inferred ? '文件名推测，关联待核对' : ''
        connect(item, exact || similar || inferred, {
          kind, id: dep.id, optional: dep.optional, range: dep.range,
          source: dep.source || item.metadataSource || '本地 JAR',
          uncertain,
          missing: kind === 'needs' && item.missingDependencies?.includes(dep.id)
        })
      }
    }
  }
  for (const p of known) {
    for (const dep of p.dependencies || []) {
      if (!['required', 'optional', 'incompatible', 'embedded'].includes(dep.type)) continue
      const providers = dep.versionId ? byVersion.get(dep.versionId) : byProject.get(dep.projectId)
      connect(byPath.get(p.relPath), providers, {
        kind: dep.type === 'incompatible' ? 'conflicts' : 'needs', optional: dep.type === 'optional',
        id: dep.projectId || dep.versionId, range: dep.versionId ? '版本 ID ' + dep.versionId : '',
        source: 'Modrinth · ' + (p.version || p.versionId), platform: true, embedded: dep.type === 'embedded'
      })
    }
  }
  return (item) => {
    const groups = { needs: new Map(), usedBy: new Map(), conflicts: new Map() }
    function record(edge, target, direction) {
      const group = groups[direction]
      const id = target?.relPath || (edge.platform ? '平台:' : '本地:') + edge.id
      const node = group.get(id) || { target, id: edge.id, lines: [] }
      const status = edgeStatus(edge)
      const line = [status, edge.id, edge.range, edge.source].filter(Boolean).join(' · ')
      if (!node.lines.includes(line)) node.lines.push(line)
      group.set(id, node)
    }
    for (const edge of outgoing.get(item.relPath) || []) record(edge, edge.target, edge.kind)
    for (const edge of incoming.get(item.relPath) || []) {
      if (edge.owner !== item) record(edge, edge.owner, edge.kind === 'conflicts' ? 'conflicts' : 'usedBy')
    }
    return Object.fromEntries(Object.entries(groups).map(([name, map]) => [name, [...map.values()]]))
  }
}

function edgeStatus(edge) {
  const { owner, target } = edge
  if (edge.uncertain) return edge.uncertain
  if (edge.kind === 'conflicts') {
    if (!target) return edge.platform ? '不兼容声明 · 本地未确认' : '不兼容声明 · 未找到目标'
    if (!active(owner) || !active(target)) return '不兼容声明 · 未同时启用'
    if (!edge.platform && (!target.hasMeta || !(target.providedModIds || []).includes(edge.id))) return '不兼容声明 · 目标 ID 待核对'
    if (edge.optional) return '声明不建议共用'
    if (edge.platform || !edge.range || edge.range === '*') return '声明冲突'
    return '不兼容版本范围 · 需核对'
  }
  if (edge.embedded) return '声明已内嵌'
  if (edge.missing) return '缺少必需依赖'
  if (edge.optional) return '可选依赖'
  return target ? '必需依赖' : '必需依赖 · 本地未确认'
}

export function openModRelations({ items, selected, projects, loadProjects, openModal, iconFor }) {
  const body = h('div', { class: 'lp-relations' })
  let graph = buildModRelations(items, projects)
  let current = selected
  let closed = false
  const history = []
  let online = projects ? 'ready' : 'idle'
  let onlineError = ''
  const modal = openModal({ title: '模组依赖关系', size: 'xl', body, buttons: [{ label: '确定', class: 'btn-primary' }], onClose: () => { closed = true } })
  const navigate = (item) => {
    if (item !== current) { history.push(current); current = item; paint() }
  }
  function nodeCard(item, id, lines, center = false) {
    const name = item?.name || id
    const description = [item?.version, item?.disabled ? '已禁用' : '', item?.loaderMismatch ? '加载器不匹配' : ''].filter(Boolean).join(' · ')
    return h(center ? 'div' : 'button', {
      class: 'lp-relation-node' + (center ? ' current' : ''), type: center ? undefined : 'button',
      onclick: center ? undefined : () => item && item !== current ? navigate(item) : openModal({ title: name, body: h('div', {}, ...lines.map(line => h('p', {}, line))), buttons: [{ label: '确定' }] })
    }, iconFor(item), h('span', { class: 'lp-relation-copy' }, h('b', {}, name),
      description ? h('small', {}, description) : null, ...lines.map(line => h('small', {}, line))))
  }
  function column(label, nodes, className) {
    return h('section', { class: 'lp-relation-column ' + className }, h('h4', {}, label),
      nodes.length ? h('div', { class: 'lp-relation-branches' }, ...nodes.map(node => nodeCard(node.target, node.id, node.lines))) : h('small', { class: 'lp-hint' }, '无已知声明'))
  }
  async function supplement() {
    online = 'loading'
    paint()
    try {
      const result = await loadProjects()
      if (closed) return
      graph = buildModRelations(items, result)
      online = 'ready'
    } catch (e) { online = 'failed'; onlineError = e.message }
    if (!closed) paint()
  }
  function paint() {
    const { needs, usedBy, conflicts } = graph(current)
    const back = history.length ? h('button', { class: 'btn btn-xs', onclick: () => { current = history.pop(); paint() } }, '返回上一个模组') : null
    const summary = h('div', { class: 'lp-relation-summary' }, badge('需要 ' + needs.length, 'info'), badge('被依赖 ' + usedBy.length, 'accent'), badge('冲突声明 ' + conflicts.length, conflicts.length ? 'warn' : ''), back)
    body.replaceChildren(h('div', { class: 'lp-relation-grid' },
      column('依赖它的模组', usedBy, 'incoming'),
      h('section', { class: 'lp-relation-center' }, h('h4', {}, '当前模组'), nodeCard(current, current.modid, [current.modid, current.metadataSource || '未识别元数据'].filter(Boolean), true)),
      column('它需要的依赖', needs, 'outgoing')),
      column('冲突与不兼容声明', conflicts, 'conflicts'), summary,
      h('div', { class: 'lp-hint' }, '来源：本地 JAR 元数据' + (online === 'ready' ? '、Modrinth 已匹配的安装版本。' : '。')),
      h('div', {}, online === 'ready' ? null : h('button', { class: 'btn btn-xs', disabled: online === 'loading', onclick: supplement },
        online === 'loading' ? '正在匹配安装版本…' : '从 Modrinth 补充声明'), online === 'failed' ? h('span', { class: 'lp-hint bad' }, onlineError) : null))
    modal.setTitle?.('模组依赖关系 · ' + (current.name || current.file))
  }
  paint()
}
