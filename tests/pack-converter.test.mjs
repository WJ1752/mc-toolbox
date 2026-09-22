import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { convertPack, detectPackRuntime } from '../src/server/pack-converter.js'

const assert = (cond, msg) => { if (!cond) { console.error('✗ ' + msg); process.exit(1) } console.log('✓ ' + msg) }
const assertRejects = async (promise, msg) => {
  try { await promise; console.error('✗ ' + msg); process.exit(1) } catch { console.log('✓ ' + msg) }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let i = 0; i < 8; i++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function makeZip(entries) {
  const local = [], central = []
  let offset = 0
  for (const [nameText, content] of entries) {
    const name = Buffer.from(nameText)
    const data = Buffer.from(content)
    const crc = crc32(data)
    const lh = Buffer.alloc(30 + name.length)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(name.length, 26); name.copy(lh, 30)
    local.push(lh, data)
    const ch = Buffer.alloc(46 + name.length)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8)
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42); name.copy(ch, 46)
    central.push(ch)
    offset += lh.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, cd, end])
}

const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-tb-pack-test-'))
try {
  const clientJar = makeZip([['fabric.mod.json', JSON.stringify({ id: 'sodium', name: 'Sodium', environment: 'client' })]])
  const serverJar = makeZip([['fabric.mod.json', JSON.stringify({ id: 'servermod', name: 'Server Mod', environment: '*' })]])
  const source = path.join(base, 'pack')
  await fsp.mkdir(path.join(source, 'overrides', 'mods'), { recursive: true })
  await fsp.writeFile(path.join(source, 'overrides', 'mods', 'sodium.jar'), clientJar)
  await fsp.writeFile(path.join(source, 'overrides', 'mods', 'servermod.jar'), serverJar)

  const dirResult = await convertPack({ source, outputDir: base, clientModIds: ['sodium'] })
  assert(dirResult.removedCount === 1, '目录转换移除 1 个客户端 mod')
  assert(fs.existsSync(dirResult.output), '目录转换生成服务端 ZIP')

  const archive = path.join(base, 'client-pack.zip')
  await fsp.writeFile(archive, makeZip([
    ['overrides/mods/sodium.jar', clientJar],
    ['overrides/mods/servermod.jar', serverJar],
    ['config/options.txt', Buffer.from('keep')]
  ]))
  const archiveResult = await convertPack({ source: archive, outputDir: base, clientModIds: ['sodium'] })
  assert(archiveResult.removedCount === 1, 'ZIP 转换移除 1 个客户端 mod')
  assert(fs.existsSync(archive), 'ZIP 原始客户端安装包保持不变')
  const outputBytes = await fsp.readFile(archiveResult.output)
  assert(outputBytes.includes(Buffer.from('servermod.jar')) && !outputBytes.includes(Buffer.from('sodium.jar')), '服务端 ZIP 保留服务端 mod 并移除客户端 mod')

  const manifestRoot = path.join(base, 'manifest-pack')
  await fsp.mkdir(path.join(manifestRoot, 'overrides', 'mods'), { recursive: true })
  await fsp.writeFile(path.join(manifestRoot, 'manifest.json'), JSON.stringify({
    minecraft: { version: '1.20.1', modLoaders: [{ id: 'fabric-loader-0.15.11', primary: true }] }
  }))
  await fsp.writeFile(path.join(manifestRoot, 'start.bat'), 'java -jar forge-1.12.2.jar')
  await fsp.writeFile(path.join(manifestRoot, 'overrides', 'mods', 'servermod.jar'), serverJar)
  const runtime = await detectPackRuntime(manifestRoot)
  assert(runtime?.loader === 'fabric' && runtime?.mc === '1.20.1' && runtime?.loaderVersion === '0.15.11', '从整合包清单识别 MC 与加载器版本')
  const normalizedResult = await convertPack({ source: manifestRoot, outputDir: base, clientModIds: [] })
  const normalizedBytes = await fsp.readFile(normalizedResult.output)
  assert(!normalizedBytes.includes(Buffer.from('start.bat')), '服务端包不携带客户端启动脚本')

  // 客户端库被列为可移除项时，仍被服务端模组依赖的库必须保留。
  const dependencyRoot = path.join(base, 'dependency-pack')
  await fsp.mkdir(path.join(dependencyRoot, 'mods'), { recursive: true })
  const jeiJar = makeZip([['mcmod.info', JSON.stringify([{ modid: 'jei', name: 'JEI', version: '4.15.0' }])]])
  const jeiAddonJar = makeZip([['mcmod.info', JSON.stringify([{ modid: 'jeiaddon', name: 'JEI Addon', version: '1.0', requiredMods: ['jei'] }])]])
  await fsp.writeFile(path.join(dependencyRoot, 'mods', 'jei.jar'), jeiJar)
  await fsp.writeFile(path.join(dependencyRoot, 'mods', 'jei-addon.jar'), jeiAddonJar)
  const dependencyResult = await convertPack({ source: dependencyRoot, outputDir: base, clientModIds: ['jei'] })
  assert(dependencyResult.removedCount === 0, '被服务端模组依赖的客户端库不会被误删')
  const dependencyBytes = await fsp.readFile(dependencyResult.output)
  assert(dependencyBytes.includes(Buffer.from('jei.jar')) && dependencyBytes.includes(Buffer.from('jei-addon.jar')), '服务端 ZIP 保留依赖库和依赖方')

  const brokenRoot = path.join(base, 'broken-dependency-pack')
  await fsp.mkdir(path.join(brokenRoot, 'mods'), { recursive: true })
  const brokenJar = makeZip([['mcmod.info', JSON.stringify([{ modid: 'brokenmod', name: 'Broken Mod', version: '1.0', requiredMods: ['not-installed'] }])]])
  await fsp.writeFile(path.join(brokenRoot, 'mods', 'broken.jar'), brokenJar)
  await assertRejects(convertPack({ source: brokenRoot, outputDir: base }), '生成前阻止缺少必需依赖的服务端包')
  console.log('✓ 整合包转服务端测试全部通过')
} finally {
  await fsp.rm(base, { recursive: true, force: true })
}
