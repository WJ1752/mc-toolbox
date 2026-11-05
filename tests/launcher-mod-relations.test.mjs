import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { makeZip } from './helpers/zip.mjs'
import { listMods } from '../src/server/launcher/content.js'
import { buildModRelations } from '../public/js/launcher/mod-relations.js'

test('独立 mod ID 不被连接，准确声明优先于同名文件及分隔符推断', () => {
  const mod = id => ({ modid: id, relPath: id + '.jar', hasMeta: true, providedModIds: [id] })
  const owner = { ...mod('owner'), dependencies: [{ id: 'mod_a' }, { id: 'unknown' }] }
  const accurate = mod('mod_a'), distinct = mod('moda'), alternate = mod('mod-a')
  const guessed = { relPath: 'unknown-1.0.jar', hasMeta: false, providedModIds: ['unknown', 'mod_a'] }
  const graph = buildModRelations([owner, accurate, distinct, alternate, guessed])
  assert.deepEqual(graph(owner).needs.map(n => n.target), [accurate, guessed])
  assert.equal(graph(distinct).usedBy.length, 0)
  assert.equal(graph(alternate).usedBy.length, 0)
  assert.match(graph(guessed).usedBy[0].lines[0], /文件名推测/)
  assert.equal(buildModRelations([owner, distinct])(owner).needs[0].target, null)
})

test('整包云图共享关系数据：可聚焦缺失前置并回溯宿主，过滤平台和内嵌自循环', () => {
  const owner = { modid: 'owner', relPath: 'owner.jar', hasMeta: true, providedModIds: ['owner', 'embedded'],
    dependencies: [{ id: 'missing', range: '>=2' }, { id: 'disabled' }, { id: 'optional', optional: true }, { id: 'embedded' }, { id: 'minecraft' }, { id: 'java' }, { id: 'fabricloader' }, { id: 'fabric' }, { id: 'quilt' }],
    missingDependencies: ['missing', 'disabled'], conflicts: [{ id: 'incompatible' }] }
  const disabled = { modid: 'disabled', relPath: 'disabled.jar.disabled', disabled: true, hasMeta: true, providedModIds: ['disabled'] }
  const other = { modid: 'other', relPath: 'other.jar', hasMeta: true, providedModIds: ['other', 'embedded'], dependencies: [{ id: 'embedded' }] }
  const graph = buildModRelations([owner, disabled, other])
  const missing = graph.find('missing')
  assert.equal(missing.requiredMissing, true)
  assert.equal(missing.relationMissing, true)
  assert.equal(graph(missing).usedBy[0].target, owner)
  assert.match(graph(missing).usedBy[0].lines[0], /缺少必需依赖.*>=2/)
  assert.equal(graph.find('disabled'), disabled)
  assert.equal(graph.find('optional').requiredMissing, false)
  assert.equal(graph(graph.find('incompatible')).conflicts[0].target, owner)
  assert.ok(graph.edges.some(edge => edge.owner === owner && edge.target === missing))
  assert.ok(graph.edges.every(edge => edge.owner !== edge.target))
  assert.equal(graph(owner).needs.find(node => node.id === 'embedded').target, owner)
  assert.equal(graph(other).needs[0].target, other)
  assert.equal(graph.edges.some(edge => edge.id === 'embedded'), false)
  assert.equal(graph.nodes.some(node => ['java', 'minecraft', 'fabricloader', 'fabric', 'quilt'].includes(node.modid)), false)
  assert.equal(graph.edges.find(edge => edge.id === 'optional').optional, true)
})

test('已安装 JAR 到依赖视图：双向关系、禁用前置、声明冲突、已安装版本的平台声明', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mtb-relations-'))
  try {
    const inst = { id: 'test', folder: 'relation', root, loader: 'fabric', mc: '1.20.1' }
    const modsDir = path.join(root, 'versions', inst.folder, 'mods')
    await fs.mkdir(modsDir, { recursive: true })
    for (const [file, meta] of [
      ['api.jar', { id: 'api', provides: ['api_alias'] }],
      ['disabled.jar.disabled', { id: 'disabled' }],
      ['extra.jar', { id: 'extra', depends: { api_alias: ['1.0', '2.0'], disabled: '*', missing: '>=3' }, breaks: { api: '<1.0' } }]
    ]) {
      await fs.writeFile(path.join(modsDir, file), makeZip([['fabric.mod.json', JSON.stringify({ schemaVersion: 1, name: meta.id, version: '2.0', ...meta })]]))
    }
    const { items, missingDependencies } = await listMods(inst)
    assert.deepEqual(missingDependencies.sort(), ['disabled', 'missing'])
    const extra = items.find(i => i.modid === 'extra')
    const api = items.find(i => i.modid === 'api')
    const project = (item, id, deps = []) => ({ relPath: item.relPath, size: item.size, mtime: item.mtime, projectId: id, versionId: id + '2', version: '2', dependencies: deps })
    const graph = buildModRelations(items, [project(api, 'platform-api'), project(extra, 'platform-extra', [
      { projectId: 'platform-api', type: 'required' }, { projectId: 'unknown', type: 'incompatible' }
    ])])
    const { needs, conflicts } = graph(extra)
    assert.equal(needs.length, 3)
    assert.equal(graph(api).usedBy[0].target, extra)
    assert.deepEqual(graph(api).usedBy[0].lines, needs.find(n => n.target === api).lines)
    assert.match(graph(api).usedBy[0].lines.join(' '), /1.0 \|\| 2.0.*fabric.mod.json.*Modrinth/)
    assert.match(needs.find(n => n.id === 'disabled').lines[0], /缺少必需依赖/)
    assert.match(conflicts.find(n => n.target === api).lines[0], /范围 · 需核对/)
    assert.match(conflicts.find(n => !n.target).lines[0], /本地未确认/)
    const stale = { ...project(extra, 'old', [{ projectId: 'unknown', type: 'required' }]), mtime: 0 }
    assert.equal(buildModRelations(items, [stale])(extra).needs.length, 3)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
