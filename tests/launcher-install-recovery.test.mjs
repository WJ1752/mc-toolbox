// v1.9.4 安装恢复与下载中心联动的纯逻辑测试。
// 覆盖：安装器网络错误判定、错误文案、下载中心整合包路径、
// 以及 JAR 单条目补丁（不改动其他条目、可被再次读取）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  isTransientInstallerError, installerFailureMessage
} from '../src/server/launcher/install.js'
import {
  isSeedableMojmapsProfile, patchJarEntry, patchMojmapsProcessor, readJarJson, resolveMojmapsCoordinate
} from '../src/server/launcher/jar-patch.js'
import { isInstallablePackJob, packDownloadPath } from '../public/js/launcher/downloads.js'
import { readJarEntries } from '../src/server/zip.js'
import { makeZip } from './helpers/zip.mjs'

const FORGE_PROFILE = {
  data: {
    MOJMAPS: { client: '[net.minecraft:client:1.20.1-20230612.114412:mappings@txt]' }
  },
  processors: [
    {
      jar: 'net.minecraftforge:installertools:1.4.1',
      args: ['--task', 'DOWNLOAD_MOJMAPS', '--version', '1.20.1', '--side', '{SIDE}', '--output', '{MOJMAPS}']
    },
    { jar: 'net.minecraftforge:jarsplitter:1.1.4', args: ['--input', '{MINECRAFT_JAR}'] }
  ]
}

test('isTransientInstallerError：只把网络类错误视为可重试', () => {
  assert.equal(isTransientInstallerError('Failed to run processor: java.net.SocketException:Connection reset'), true)
  assert.equal(isTransientInstallerError('java.net.ConnectException: Connect timed out'), true)
  assert.equal(isTransientInstallerError('SSLException: Remote host terminated the handshake'), true)
  assert.equal(isTransientInstallerError('HTTP 502 Bad Gateway'), true)
  assert.equal(isTransientInstallerError('Unsupported class file major version 69'), false)
  assert.equal(isTransientInstallerError('There was an error during installation'), false)
  assert.equal(isTransientInstallerError(''), false)
})

test('installerFailureMessage：网络失败给出原因与重试次数，非网络失败不误报', () => {
  const output = [
    'Downloading library from https://maven.minecraftforge.net/...',
    'java.net.SocketException: Connection reset',
    'Failed to run processor: java.net.SocketException:Connection reset',
    'There was an error during installation'
  ].join('\n')
  const msg = installerFailureMessage(1, output, 3)
  assert.match(msg, /网络中断/)
  assert.match(msg, /已自动重试 2 次/)
  assert.match(msg, /Connection reset/)
  assert.match(msg, /BMCLAPI/)

  const javaMsg = installerFailureMessage(1, 'Unsupported class file major version 69', 1)
  assert.match(javaMsg, /非零退出码/)
  assert.doesNotMatch(javaMsg, /已自动重试/)
  assert.match(javaMsg, /Unsupported class file/)
  // 非网络失败不该建议换下载源：换源对 Java 版本 / 签名问题没有任何帮助。
  assert.doesNotMatch(javaMsg, /BMCLAPI/)
})

test('installerFailureMessage：安装器静默中止时直接说明与下载源无关', () => {
  const output = [
    'JVM info: Oracle Corporation - 17.0.2',
    'Target Directory: C:\\Users\\HP\\Desktop\\1222\\.minecraft',
    'A problem installing was detected, install cannot continue'
  ].join('\n')
  const msg = installerFailureMessage(1, output, 1)
  assert.match(msg, /启动阶段/)
  assert.match(msg, /签名/)
  assert.match(msg, /与下载源无关/)
  assert.doesNotMatch(msg, /切换为 BMCLAPI/)
})

test('isSeedableMojmapsProfile：只对原样复制 TSRG 的安装器预取', () => {
  assert.equal(isSeedableMojmapsProfile(FORGE_PROFILE), true)
  const sanitize = structuredClone(FORGE_PROFILE)
  sanitize.processors[0].args.push('--sanitize')
  assert.equal(isSeedableMojmapsProfile(sanitize), false)
  const srg = structuredClone(FORGE_PROFILE)
  srg.processors[0].args.push('--format', 'SRG')
  assert.equal(isSeedableMojmapsProfile(srg), false)
  const twice = structuredClone(FORGE_PROFILE)
  twice.processors.push(structuredClone(FORGE_PROFILE.processors[0]))
  assert.equal(isSeedableMojmapsProfile(twice), false)
  assert.equal(isSeedableMojmapsProfile({}), false)
})

test('resolveMojmapsCoordinate / patchMojmapsProcessor：只改 DOWNLOAD_MOJMAPS', () => {
  const profile = structuredClone(FORGE_PROFILE)
  assert.equal(resolveMojmapsCoordinate(profile, 'client'), '[net.minecraft:client:1.20.1-20230612.114412:mappings@txt]')
  assert.equal(resolveMojmapsCoordinate({ processors: [] }), '')
  assert.equal(patchMojmapsProcessor(profile), true)
  assert.deepEqual(profile.processors[0].args.slice(-1), ['--skipIfExists'])
  // 再次打补丁是幂等的
  assert.equal(patchMojmapsProcessor(profile), false)
  assert.equal(profile.processors[0].args.filter((arg) => arg === '--skipIfExists').length, 1)
})

test('patchJarEntry：只替换 install_profile.json，其他条目字节不变', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-jar-patch-'))
  try {
    const source = path.join(dir, 'installer.jar')
    const target = path.join(dir, 'installer.patched.jar')
    const other = Buffer.from('version-json-content', 'utf8')
    await fs.writeFile(source, makeZip([
      ['version.json', other],
      ['install_profile.json', Buffer.from(JSON.stringify(FORGE_PROFILE), 'utf8')],
      ['data/client.lzma', Buffer.from([1, 2, 3, 4])]
    ]))
    const result = await patchJarEntry(source, 'install_profile.json', (raw) => {
      const next = JSON.parse(raw.toString('utf8'))
      if (!patchMojmapsProcessor(next)) return null
      return Buffer.from(JSON.stringify(next))
    }, target)
    assert.equal(result.changed, true)
    const patched = await readJarJson(target, 'install_profile.json')
    assert.ok(patched.processors[0].args.includes('--skipIfExists'))
    assert.equal(patched.processors[1].args.includes('--skipIfExists'), false)
    // 其余条目必须逐字节保持原样（安装器还要从 JAR 里解压 data/client.lzma）。
    const entries = await readJarEntries(target, ['version.json', 'data/client.lzma'])
    assert.equal(entries['version.json'].toString('utf8'), 'version-json-content')
    assert.deepEqual([...entries['data/client.lzma']], [1, 2, 3, 4])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('patchJarEntry：签名安装器打补丁时移除签名，否则安装器会静默退出', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-jar-signed-'))
  try {
    const source = path.join(dir, 'signed-installer.jar')
    const target = path.join(dir, 'signed-installer.patched.jar')
    const manifest = Buffer.from('Manifest-Version: 1.0\n', 'utf8')
    await fs.writeFile(source, makeZip([
      ['META-INF/MANIFEST.MF', manifest],
      ['META-INF/FORGE.SF', Buffer.from('Signature-Version: 1.0\n', 'utf8')],
      ['META-INF/FORGE.RSA', Buffer.from([0x30, 0x82, 0x01, 0x02])],
      ['install_profile.json', Buffer.from(JSON.stringify(FORGE_PROFILE), 'utf8')]
    ]))
    const result = await patchJarEntry(source, 'install_profile.json', (raw) => {
      const next = JSON.parse(raw.toString('utf8'))
      if (!patchMojmapsProcessor(next)) return null
      return Buffer.from(JSON.stringify(next))
    }, target)
    assert.equal(result.changed, true)
    assert.equal(result.signatureRemoved, true)
    assert.deepEqual([...result.removedSignatures].sort(), ['META-INF/FORGE.RSA', 'META-INF/FORGE.SF'])
    // 补丁条目可读，签名条目必须消失（残留 .SF 会让 JVM 拿摘要校验被改过的条目，
    // 抛 SecurityException 后 Forge 安装器只打印一句「A problem installing…」）。
    const patched = await readJarJson(target, 'install_profile.json')
    assert.ok(patched.processors[0].args.includes('--skipIfExists'))
    const entries = await readJarEntries(target, ['META-INF/MANIFEST.MF', 'META-INF/FORGE.SF', 'META-INF/FORGE.RSA'])
    assert.deepEqual(entries['META-INF/MANIFEST.MF'], manifest)
    // readJarEntries 对缺失的条目返回 null
    assert.equal(entries['META-INF/FORGE.SF'], null)
    assert.equal(entries['META-INF/FORGE.RSA'], null)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('patchJarEntry：未签名安装器保持原样，不误删 META-INF 其它条目', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-jar-unsigned-'))
  try {
    const source = path.join(dir, 'installer.jar')
    const target = path.join(dir, 'installer.patched.jar')
    const extra = Buffer.from('extra', 'utf8')
    await fs.writeFile(source, makeZip([
      ['META-INF/MANIFEST.MF', Buffer.from('Manifest-Version: 1.0\n', 'utf8')],
      ['META-INF/services/foo', extra],
      ['install_profile.json', Buffer.from(JSON.stringify(FORGE_PROFILE), 'utf8')]
    ]))
    const result = await patchJarEntry(source, 'install_profile.json', (raw) => {
      const next = JSON.parse(raw.toString('utf8'))
      if (!patchMojmapsProcessor(next)) return null
      return Buffer.from(JSON.stringify(next))
    }, target)
    assert.equal(result.signatureRemoved, false)
    assert.deepEqual(result.removedSignatures, [])
    const entries = await readJarEntries(target, ['META-INF/services/foo'])
    assert.deepEqual(entries['META-INF/services/foo'], extra)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('下载中心：已完成整合包可一键转入新建实例', () => {
  const done = {
    id: 'c1', status: 'done', filename: 'BattleArmory TACZ-26.0.5.mrpack',
    dir: 'C:\\Users\\HP\\Downloads\\整合包', path: '', meta: { type: 'modpack' }
  }
  assert.equal(isInstallablePackJob(done), true)
  assert.equal(
    packDownloadPath(done),
    'C:\\Users\\HP\\Downloads\\整合包\\BattleArmory TACZ-26.0.5.mrpack'
  )
  assert.equal(packDownloadPath({ ...done, path: 'D:\\packs\\a.zip' }), 'D:\\packs\\a.zip')
  assert.equal(isInstallablePackJob({ ...done, status: 'running' }), false)
  assert.equal(isInstallablePackJob({ ...done, meta: { type: 'mod' } }), false)
  assert.equal(isInstallablePackJob({ ...done, filename: 'pack.jar' }), false)
  assert.equal(isInstallablePackJob(null), false)
  assert.equal(packDownloadPath({ ...done, dir: '', path: '' }), '')
  // 路径分隔符跟随 dir，Windows 反斜杠不会混入正斜杠
  assert.equal(packDownloadPath({ ...done, dir: 'C:/packs/' }), 'C:/packs/BattleArmory TACZ-26.0.5.mrpack')
})
