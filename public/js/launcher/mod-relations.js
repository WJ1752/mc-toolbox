import { h } from '../core/dom.js'
import { badge } from '../ui/kit.js'

const key = id => String(id || '').trim().toLowerCase()
const active = item => item && !item.disabled && !item.loaderMismatch
const RUNTIME_IDS = new Set(['minecraft', 'java', 'forge', 'neoforge', 'fabricloader', 'fabric', 'quilt', 'quilt_loader', 'quilt-loader', 'cleanroom', 'minecraftforge', 'mod_minecraftforge', 'forge_loader', 'fml'])

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
  const outgoing = new Map(), incoming = new Map(), missingNodes = new Map(), edges = []
  function connect(owner, providers, detail) {
    for (const target of providers?.length ? providers : [null]) {
      const edge = { owner, target, ...detail }
      const absentKey = (detail.platform ? 'platform:' : 'missing:') + key(detail.id)
      if (!target && !missingNodes.has(absentKey)) {
        missingNodes.set(absentKey, {
          relPath: absentKey, modid: detail.id, name: detail.id,
          relationMissing: true, relationPlatform: detail.platform === true, requiredMissing: false
        })
      }
      const node = target || missingNodes.get(absentKey)
      if (!target && detail.missing) node.requiredMissing = true
      add(outgoing, owner.relPath, edge)
      add(incoming, node.relPath, edge)
      if (owner !== node) edges.push({ ...edge, target: node, unresolved: !target, status: edgeStatus(edge) })
    }
  }
  for (const item of items) {
    for (const [kind, deps] of [['needs', item.dependencies], ['conflicts', item.conflicts]]) {
      for (const dep of deps || []) {
        const id = key(dep.id)
        if (!id || RUNTIME_IDS.has(id)) continue
        const exact = byId.get(id)
        const similar = bySeparator.get(id.replace(/-/g, '_'))
        const inferred = byFilename.get(id)
        const uncertain = exact ? '' : similar ? 'ID 分隔符不同，关联待核对' : inferred ? '文件名推测，关联待核对' : ''
        const providers = exact || similar || inferred
        // 宿主已内嵌提供的依赖由自身满足，其他携带同一库的宿主不是它的前置。
        connect(item, kind === 'needs' && providers?.includes(item) ? [item] : providers, {
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
  const relations = (item) => {
    const groups = { needs: new Map(), usedBy: new Map(), conflicts: new Map() }
    function record(edge, target, direction) {
      const group = groups[direction]
      const id = target?.relPath || (edge.platform ? '平台:' : '本地:') + edge.id
      const node = group.get(id) || { target, id: edge.id, platform: edge.platform === true, lines: [] }
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
  // 云图和单模组视图共享同一份关联结果；未安装依赖也能查看其所有宿主。
  relations.nodes = [...items, ...missingNodes.values()]
  relations.edges = edges
  relations.find = (id, platform = false) => byPath.get(id)
    || (!platform && (byId.get(key(id)) || byFilename.get(key(id)))?.[0])
    || missingNodes.get((platform ? 'platform:' : 'missing:') + key(id))
  return relations
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
  let current = typeof selected === 'string' ? graph.find(selected) : selected
  if (!current) return null
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
    const description = [item?.version, item?.relationMissing ? (item.requiredMissing ? '缺少必需依赖' : '本地未安装') : '', item?.disabled ? '已禁用' : '', item?.loaderMismatch ? '加载器不匹配' : ''].filter(Boolean).join(' · ')
    return h(center ? 'div' : 'button', {
      class: 'lp-relation-node' + (center ? ' current' : ''), type: center ? undefined : 'button',
      onclick: center ? undefined : () => item && item !== current ? navigate(item) : openModal({ title: name, body: h('div', {}, ...lines.map(line => h('p', {}, line))), buttons: [{ label: '确定' }] })
    }, iconFor(item), h('span', { class: 'lp-relation-copy' }, h('b', {}, name),
      description ? h('small', {}, description) : null, ...lines.map(line => h('small', {}, line))))
  }
  function column(label, nodes, className) {
    return h('section', { class: 'lp-relation-column ' + className }, h('h4', {}, label),
      nodes.length ? h('div', { class: 'lp-relation-branches' }, ...nodes.map(node => nodeCard(node.target || graph.find(node.id, node.platform), node.id, node.lines))) : h('small', { class: 'lp-hint' }, '无已知声明'))
  }
  async function supplement() {
    online = 'loading'
    paint()
    try {
      const result = await loadProjects()
      if (closed) return
      graph = buildModRelations(items, result)
      current = graph.find(current.relPath) || current
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
