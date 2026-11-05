// 整合包的 Fabric Loader 覆盖声明应与 JAR 依赖一起生效，并随配置变化刷新缓存。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { readModMeta } from '../src/server/mods.js'
import { listMods } from '../src/server/launcher/content.js'
import { makeZip } from './helpers/zip.mjs'

function fabricJar(id, extra = {}) {
  return makeZip([['fabric.mod.json', JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', ...extra })]])
}

test('整合包移除的前置不再误报，真实缺失保留，改动或删除覆盖文件会刷新缓存', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-fabric-overrides-'))
  const gameDir = path.join(root, 'game')
  const modsDir = path.join(gameDir, 'mods')
  const config = path.join(gameDir, 'config', 'fabric_loader_dependencies.json')
  const inst = { id: 'test', root, gameDir, mc: '1.20.1', loader: 'fabric' }
  try {
    await fs.mkdir(modsDir, { recursive: true })
    await fs.mkdir(path.dirname(config))
    for (const [id, depends] of [
      ['ships', { betterend: '*' }],
      ['quests', { ftbquests: '>=1' }],
      ['rivers', { terrablender: '*' }],
      ['portal', { 'balm-fabric': '>=7' }]
    ]) await fs.writeFile(path.join(modsDir, id + '.jar'), fabricJar(id, { depends }))
    const overrides = {
      quests: { '-depends': { ftbquests: 'IGNORED' } },
      rivers: { '-depends': { terrablender: 'IGNORED' } },
      portal: { '-depends': { 'balm-fabric': 'IGNORED' } }
    }
    await fs.writeFile(config, JSON.stringify({ version: 1, overrides }))
    const first = await listMods(inst)
    assert.deepEqual(first.missingDependencies, ['betterend'])
    assert.deepEqual(first.items.find(i => i.modid === 'portal').dependencies, [])

    overrides.quests = { depends: { real_api: ['>=2', '1.5'] } }
    await fs.writeFile(config, JSON.stringify({ version: 1, overrides }))
    const changed = await listMods(inst)
    assert.deepEqual(changed.missingDependencies.sort(), ['betterend', 'real_api'])
    const dep = changed.items.find(i => i.modid === 'quests').dependencies[0]
    assert.equal(dep.range, '>=2 || 1.5')
    assert.equal(dep.source, 'config/fabric_loader_dependencies.json')

    await fs.unlink(config)
    const restored = await listMods(inst)
    assert.deepEqual(restored.missingDependencies.sort(), ['balm-fabric', 'betterend', 'ftbquests', 'terrablender'])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('覆盖按依赖类别执行：替换优先于加减，移除后追加，内嵌模组也使用自己的覆盖', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-fabric-override-kinds-'))
  const file = path.join(root, 'parent.jar')
  try {
    await fs.writeFile(file, makeZip([
      ['fabric.mod.json', JSON.stringify({
        id: 'parent', version: '1.0', depends: { old: '*' }, recommends: { optional_api: '*' },
        breaks: { bad: '*' }, conflicts: { warning: '*' }, jars: [{ file: 'META-INF/jars/child.jar' }]
      })],
      ['META-INF/jars/child.jar', fabricJar('child', { depends: { removed_child_api: '*' } })]
    ]))
    const meta = await readModMeta(file, {
      loader: 'fabric',
      dependencyOverrides: {
        parent: {
          '+depends': { ignored: '*' }, '-depends': { replacement: 'IGNORED' }, depends: { replacement: '>=2' },
          '+recommends': { optional_api: '>=3' }, '-recommends': { optional_api: 'IGNORED' },
          '-breaks': { bad: 'IGNORED' }, conflicts: {}
        },
        child: { '-depends': { removed_child_api: 'IGNORED' }, '+depends': { nested_api: '*' } }
      }
    })
    assert.deepEqual(meta.dependencies.map(d => [d.id, d.range, d.optional]), [
      ['replacement', '>=2', false], ['optional_api', '>=3', true], ['nested_api', '*', false]
    ])
    assert.deepEqual(meta.conflicts, [])
    assert.deepEqual(meta.topLevelModIds, ['parent'])
    assert.ok(meta.nestedModIds.includes('child'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
