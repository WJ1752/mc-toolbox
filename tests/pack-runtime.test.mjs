import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { detectPackRuntime, mergeRuntime, findPackRoot } from '../src/server/pack-runtime.js'
import { convertPack, startConvertJob, cancelConvertJob, getConvertJob, receiveUploadedPack } from '../src/server/pack-converter.js'
import { Readable } from 'node:stream'

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-runtime-test-'))
async function json(rel, value) {
  const file = path.join(base, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(value))
}
try {
  await json('hmcl/wrapper/manifest.json', { manifestType: 'minecraftModpack', version: '1.35.2.118.0', addons: [{ id: 'game', version: '1.12.2' }, { id: 'forge', version: '14.23.5.2855' }, { id: 'optifine', version: 'HD_U_G5' }] })
  const hmcl = await detectPackRuntime(path.join(base, 'hmcl'))
  assert.equal(hmcl.mc, '1.12.2')
  assert.equal(hmcl.loaderVersion, '14.23.5.2855')
  assert.equal(await findPackRoot(path.join(base, 'hmcl'), hmcl), path.join(base, 'hmcl/wrapper'))
  await json('pcl/.minecraft/versions/GreedyCraft/GreedyCraft.json', { inheritsFrom: '1.12.2', libraries: [{ name: 'net.minecraftforge:forge:1.12.2-14.23.5.2855' }] })
  await fs.mkdir(path.join(base, 'pcl/.minecraft/versions/GreedyCraft/mods'))
  const pcl = await detectPackRuntime(path.join(base, 'pcl'))
  assert.equal(pcl.mc, hmcl.mc)
  assert.equal(pcl.loaderVersion, hmcl.loaderVersion)
  assert.equal(await findPackRoot(path.join(base, 'pcl'), pcl), path.join(base, 'pcl/.minecraft/versions/GreedyCraft'))
  await json('multi/mmc-pack.json', { components: [{ uid: 'net.minecraft', version: '1.20.1' }, { uid: 'net.fabricmc.fabric-loader', version: '0.15.11' }] })
  assert.equal((await detectPackRuntime(path.join(base, 'multi'))).loader, 'fabric')
  await json('mr/modrinth.index.json', { dependencies: { minecraft: '1.21.1', neoforge: '21.1.1' } })
  assert.equal((await detectPackRuntime(path.join(base, 'mr'))).loader, 'neoforge')
  await fs.mkdir(path.join(base, 'official'))
  await fs.writeFile(path.join(base, 'official/run-windows.bat'), 'java -jar forge-1.12.2-14.23.5.2855.jar nogui')
  assert.equal((await detectPackRuntime(path.join(base, 'official'))).loaderVersion, hmcl.loaderVersion)
  await fs.mkdir(path.join(base, 'ambiguous/GreedyCraft-1.35.2.118.0'), { recursive: true })
  assert.equal(await detectPackRuntime(path.join(base, 'ambiguous')), null)
  await json('conflict/one/manifest.json', { minecraft: { version: '1.12.2', modLoaders: [{ id: 'forge-14.23.5.2855' }] } })
  await json('conflict/two/manifest.json', { minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.3.0' }] } })
  await assert.rejects(detectPackRuntime(path.join(base, 'conflict')), /多个游戏版本/)
  assert.equal(mergeRuntime(hmcl, { loader: 'forge' }).loaderVersion, hmcl.loaderVersion)
  assert.equal(mergeRuntime(hmcl, { loader: 'fabric' }).loaderVersion, '')
  console.log('✓ HMCL、嵌套清单、隔离实例、MultiMC、Modrinth、Forge 脚本识别；冲突和整合包版本误识别防护')

  const out = path.join(base, 'out')
  await fs.mkdir(out)
  const src = path.join(base, 'hmcl')
  const job = startConvertJob({ source: src, outputDir: out })
  assert.equal(cancelConvertJob(job.id), true)
  const deadline = Date.now() + 5000
  while (!['cancelled', 'done', 'failed'].includes(getConvertJob(job.id).status) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
  assert.equal(getConvertJob(job.id).status, 'cancelled')
  assert.deepEqual(await fs.readdir(out), [])
  assert.equal('controller' in getConvertJob(job.id), false)
  for (const stage of ['extract', 'scan', 'mods', 'pack', 'publishing']) {
    const controller = new AbortController()
    await assert.rejects(convertPack({ source: src, outputDir: out, signal: controller.signal, onProgress: p => { if (p.stage === stage) { controller.abort(); controller.signal.throwIfAborted() } } }))
    assert.deepEqual(await fs.readdir(out), [])
  }
  const upload = Readable.from([Buffer.from('first'), Buffer.from('second')]); upload.headers = {}
  const uploaded = await receiveUploadedPack(upload, 'fixture.zip')
  assert.equal(await fs.readFile(uploaded.file, 'utf8'), 'firstsecond')
  await fs.rm(uploaded.dir, { recursive: true })
  const before = new Set((await fs.readdir(os.tmpdir())).filter(x => x.startsWith('mc-toolbox-upload-')))
  const broken = Readable.from((async function* () { yield Buffer.from('partial'); throw new Error('connection closed') })()); broken.headers = {}
  await assert.rejects(receiveUploadedPack(broken, 'fixture.zip'), /connection closed/)
  const after = new Set((await fs.readdir(os.tmpdir())).filter(x => x.startsWith('mc-toolbox-upload-')))
  assert.deepEqual(after, before)
  console.log('✓ 排队、复制、识别、扫描、打包中止不留下输出；上传流完整落盘，断流清理临时文件')
} finally { await fs.rm(base, { recursive: true, force: true }) }
