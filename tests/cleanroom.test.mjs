import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { makeZip } from './helpers/zip.mjs'
import { readModMeta } from '../src/server/mods.js'
import { detectRuntimeRecords, mergeRuntime } from '../src/server/pack-runtime.js'
import { requiredJava } from '../src/server/server-launch.js'
import { writeServerScripts, planModRemoval } from '../src/server/pack-converter.js'
import { DEFAULT_CLIENT_MODS, upgradeClientModLibrary } from '../src/server/defaults.js'
import { clientTooltipScript, serverRemovalReason } from '../src/server/server-compatibility.js'

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/forge-annotations.json', import.meta.url)))
const cls = name => [name, Buffer.from(fixture.classes[name], 'base64')]
test('real Java annotations, multiple IDs and embedded core libraries preserve required gameplay dependencies', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-class-test-'))
  try {
    const file = path.join(root, 'gameplay.jar')
    const embedded = makeZip([cls('example/EmbeddedCore.class')])
    await fs.writeFile(file, makeZip([
      ['mcmod.info', JSON.stringify([{ modid: 'gameplay', version: '1.12.2-6.1.BETA26' }])],
      ['META-INF/mods.toml', '[[mods]]\nmodId="wrong_modern_metadata"\nversion="1.0"'],
      ['META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\nContainedDeps: embedded.jar\n'],
      ['embedded.jar', embedded], cls('example/Gameplay.class'), cls('example/Api.class'), cls('example/Library.class')
    ]))
    const meta = await readModMeta(file, { mc: '1.12.2', loader: 'cleanroom' })
    assert.equal(meta.modid, 'gameplay')
    assert.equal(meta.version, '6.1.BETA26')
    assert.equal(meta.environment, '*')
    assert.equal(meta.providedVersions.library, '4.1.0')
    assert.ok(meta.modids.includes('embeddedcore'))
    assert.deepEqual(meta.dependencies.map(d => d.id), ['library'])
    await fs.writeFile(file, makeZip([cls('example/Client.class')]))
    assert.equal((await readModMeta(file, { mc: '1.12.2' })).environment, 'client')
    const lib = { path: 'lib.jar', modid: 'library', modids: ['library', 'embeddedcore'], version: '4.1.0' }
    const game = { path: 'game.jar', modid: 'game', dependencies: [{ id: 'embeddedcore', required: true }] }
    const result = planModRemoval([{ items: [lib, game] }], ['library'], true, { loader: 'cleanroom' })
    assert.equal(result.remove.size, 0)
    assert.throws(() => planModRemoval([{ items: [game] }], [], true), /embeddedcore/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('Cleanroom detection and official modded server entrypoint, with explicit Forge override', async () => {
  const records = [
    { name: 'manifest.json', text: JSON.stringify({ minecraft: { version: '1.12.2', modLoaders: [{ id: 'forge-14.23.5.2860' }] } }) },
    { name: 'overrides/config/forge_early.cfg', text: 'com.cleanroommc.configanytime.ConfigAnytimePlugin' }
  ]
  const detected = detectRuntimeRecords(records)
  assert.equal(detected.loader, 'cleanroom')
  assert.equal(requiredJava({ ...detected, loaderVersion: '0.6.13-alpha' }), 25)
  assert.equal(requiredJava({ loader: 'cleanroom', loaderVersion: '0.5.0-alpha' }), 21)
  const manual = mergeRuntime(detected, { loader: 'forge', loaderVersion: '14.23.5.2860' })
  assert.equal(manual.cleanroom, false)
  assert.equal(requiredJava(manual), 8)
  assert.equal(detectRuntimeRecords([{ name: 'cleanroom-0.6.13-alpha-installer.jar' }]).loaderVersion, '0.6.13-alpha')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-cleanroom-launch-'))
  try {
    await fs.writeFile(path.join(root, 'cleanroom-0.6.13-alpha.jar'), 'fixture')
    await writeServerScripts(root, { ...detected, loaderVersion: '0.6.13-alpha' }, {}, { minMemory: '2G', memory: '12G' })
    const config = JSON.parse(await fs.readFile(path.join(root, 'server-launch.json')))
    assert.deepEqual(config.args, ['-jar', 'cleanroom-0.6.13-alpha.jar', 'nogui'])
    assert.equal(config.javaMajor, 25)
    assert.equal(config.memory, '12G')
    assert.ok(!(await fs.readFile(path.join(root, 'start.ps1'), 'utf8')).includes('MainServer'))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('builtin migration retains server-capable mods and preserves explicit custom rules', () => {
  for (const id of ['ferritecore', 'ftbchunks', 'craftingtweaks', 'theoneprobe']) assert.ok(!DEFAULT_CLIENT_MODS.some(m => m.modid === id))
  const library = upgradeClientModLibrary({ items: [{ modid: 'ftbchunks', source: 'builtin' }, { modid: 'theoneprobe', source: 'user' }] })
  assert.ok(!library.items.some(m => m.modid === 'ftbchunks'))
  assert.ok(library.items.some(m => m.modid === 'theoneprobe'))
  assert.ok(library.items.some(m => m.modid === 'bdht'))
})

test('compatibility rules are limited to inspected versions and pure client scripts', () => {
  assert.ok(clientTooltipScript('import mods.tieredtooltips;\nimport mods.ItemStages;\ntieredtooltips.colorStage("stage", "color");\nItemStages.stageTooltip("stage", game.localize("key"));'))
  assert.equal(clientTooltipScript('import mods.tieredtooltips;\ntieredtooltips.colorStage("s", "c");\nrecipes.remove(<minecraft:stone>);'), false)
  assert.equal(clientTooltipScript('#sideonly server\ntieredtooltips.colorStage("s", "c");'), false)
  const mod = { modid: 'dsurround', version: '3.6.1.0' }
  assert.ok(serverRemovalReason(mod, { loader: 'cleanroom', loaderVersion: '0.6.13-alpha' }))
  assert.equal(serverRemovalReason(mod, { loader: 'forge', loaderVersion: '14.23.5.2860' }), '')
  assert.equal(serverRemovalReason({ ...mod, version: '4.0' }, { loader: 'cleanroom', loaderVersion: '0.6.13-alpha' }), '')
})
