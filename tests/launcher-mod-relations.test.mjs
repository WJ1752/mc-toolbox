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
