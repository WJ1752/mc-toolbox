import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { inspectServer, splitArguments } from '../src/server/server-inspection.js'
import { prepareServer, getPreparation, cancelPreparation, startServer, getServer, stopServer, sendServerCommand, shutdownServers, buildJvmArgs } from '../src/server/server-manager.js'
import { makeZip } from './helpers/zip.mjs'

const exec = promisify(execFile), root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-manager-'))
const manifest = 'Manifest-Version: 1.0\r\nMain-Class: Main\r\n\r\n'
async function jar(dir, name, version = '') {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, name), makeZip([['META-INF/MANIFEST.MF', manifest], ['version.json', JSON.stringify({ id: version })]]))
}
async function until(read, predicate, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const result = read(); if (predicate(result)) return result; await new Promise(resolve => setTimeout(resolve, 30)) }
  throw new Error('Timed out: ' + JSON.stringify(read()))
}
try {
  assert.deepEqual(splitArguments('-Dmessage="hello world" -Dpath="C:/Java Path"'), ['-Dmessage=hello world', '-Dpath=C:/Java Path'])
  assert.throws(() => splitArguments('"bad'), /引号/)
  const args = buildJvmArgs({ memory: '8G', minMemory: '1G', optimization: 'g1', jvmArgs: '-Dcustom=true' }, ['-Xmx2G', '-XX:+UseParallelGC', '-Dkeep=true'])
  assert.ok(args.includes('-XX:+UseG1GC') && args.includes('-Dkeep=true') && args.includes('-Dcustom=true'))
  assert.ok(!args.includes('-Xmx2G') && !args.includes('-XX:+UseParallelGC'))
  assert.throws(() => buildJvmArgs({ memory: '8G', minMemory: '1G', jvmArgs: '-Xmx16G' }), /内存/)

  const legacy = path.join(root, 'legacy')
  await jar(legacy, 'forge-1.12.2-14.23.5.2855.jar')
  await jar(legacy, 'minecraft_server.1.12.2.jar', '1.12.2')
  await fs.writeFile(path.join(legacy, 'start.bat'), 'java -Xms2G -Xmx6G -Drequired=true -jar forge-1.12.2-14.23.5.2855.jar nogui')
  const old = await inspectServer(legacy)
  assert.equal(old.selected, 'forge-1.12.2-14.23.5.2855.jar')
  assert.equal(old.plans.find(p => p.id === old.selected).runtime.loaderVersion, '14.23.5.2855')
  assert.ok(old.plans.find(p => p.id === old.selected).jvm.includes('-Drequired=true'))
  for (const [name, loader] of [['fabric-server-launch.jar', 'fabric'], ['quilt-server-launch.jar', 'quilt'], ['paper-1.20.4.jar', 'paper'], ['purpur-1.20.4.jar', 'purpur'], ['spigot-1.20.4.jar', 'spigot']]) {
    const dir = path.join(root, loader)
    await jar(dir, name)
    if (['fabric', 'quilt'].includes(loader)) await jar(dir, 'server.jar', '1.20.4')
    const found = await inspectServer(dir), plan = found.plans.find(p => p.id === found.selected)
    assert.equal(plan.runtime.loader, loader); assert.equal(plan.runtime.mc, '1.20.4')
  }
  const modern = path.join(root, 'modern')
  const rel = 'libraries/net/neoforged/neoforge/21.1.1/'
  await fs.mkdir(path.join(modern, rel), { recursive: true })
  await fs.writeFile(path.join(modern, rel, process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt'), '--fml.mcVersion 1.21.1\n--fml.neoForgeVersion 21.1.1')
  await fs.writeFile(path.join(modern, 'user_jvm_args.txt'), '# comment\n-Xmx12G\n-Dkeep=true\n')
  const neo = await inspectServer(modern)
  assert.equal(neo.plans[0].runtime.mc, '1.21.1')
  assert.ok(neo.plans[0].jvm.includes('-Dkeep=true'))

  const archive = path.join(root, 'server.zip')
  await fs.writeFile(archive, makeZip([['nested/server.jar', await fs.readFile(path.join(root, 'fabric/server.jar'))]]))
  const prep = prepareServer({ source: archive, destination: path.join(root, 'imports') })
  const done = await until(() => getPreparation(prep.id), item => ['done', 'failed'].includes(item.status))
  assert.equal(done.status, 'done'); assert.ok(done.result.root.endsWith('nested'))
  const cancel = prepareServer({ source: archive, destination: path.join(root, 'cancelled') })
  cancelPreparation(cancel.id)
  assert.equal((await until(() => getPreparation(cancel.id), item => item.status === 'cancelled')).status, 'cancelled')
  assert.deepEqual(await fs.readdir(path.join(root, 'cancelled')), [])
  console.log('✓ Forge / NeoForge / Fabric / Quilt / Paper / Purpur / Spigot 通用识别；原包参数保留、G1 替换、嵌套 ZIP 导入与中止')

  // Real Java process fixture; no Minecraft world or EULA is used by this test program.
  const liveRoot = path.join(root, '测试服务端 with spaces')
  await fs.mkdir(liveRoot)
  await fs.writeFile(path.join(liveRoot, 'Main.java'), `import java.io.*; public class Main { public static void main(String[] args) throws Exception { System.out.println("ARGS="+java.util.Arrays.toString(args)); System.out.println("HEAP="+Runtime.getRuntime().maxMemory()); System.out.println("Done (0.1s)! For help, type help"); BufferedReader in = new BufferedReader(new InputStreamReader(System.in)); String line; while ((line=in.readLine())!=null) { System.out.println("COMMAND="+line); if (line.equals("stop")) { System.out.println("Saving fixture"); break; } } } }`)
  await exec('javac', ['--release', '8', 'Main.java'], { cwd: liveRoot, windowsHide: true })
  await fs.writeFile(path.join(liveRoot, 'server.jar'), makeZip([['META-INF/MANIFEST.MF', manifest], ['Main.class', await fs.readFile(path.join(liveRoot, 'Main.class'))], ['version.json', '{"id":"1.12.2"}']]))
  const listener = net.createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  const options = { root: liveRoot, planId: 'server.jar', mc: '1.12.2', memory: '512M', minMemory: '256M', optimization: 'g1', port, host: '127.0.0.1', maxPlayers: 5 }
  await assert.rejects(startServer(options), /占用/)
  await new Promise(resolve => listener.close(resolve))
  await assert.rejects(startServer(options), /EULA/)
  assert.equal(await fs.stat(path.join(liveRoot, 'server.properties')).catch(() => null), null)
  await fs.writeFile(path.join(liveRoot, 'eula.txt'), 'eula=true\n')
  await fs.writeFile(path.join(liveRoot, 'server.properties'), 'motd=preserved\nserver-port=25565\n')
  const session = await startServer(options)
  const running = await until(() => getServer(session.id), item => item.status === 'running')
  const heap = Number(running.logs.find(line => line.text.startsWith('HEAP='))?.text.slice(5))
  assert.ok(heap > 400 * 1024 ** 2 && heap <= 512 * 1024 ** 2, 'selected heap limit reaches the real JVM')
  await assert.rejects(startServer(options), /已经/)
  sendServerCommand(session.id, 'list')
  await until(() => getServer(session.id), item => item.logs.some(line => line.text === 'COMMAND=list'))
  stopServer(session.id)
  const stopped = await until(() => getServer(session.id), item => item.status === 'stopped')
  assert.equal(stopped.exitCode, 0)
  assert.ok(stopped.logs.some(line => line.text === 'Saving fixture'))
  assert.ok((await fs.readFile(path.join(liveRoot, 'server.properties'), 'utf8')).includes('motd=preserved'))
  assert.ok((await fs.readFile(path.join(liveRoot, 'server.properties.mc-toolbox.bak'), 'utf8')).includes('server-port=25565'))
  const second = await startServer(options)
  await until(() => getServer(second.id), item => item.status === 'running')
  stopServer(second.id, true)
  await until(() => getServer(second.id), item => item.status === 'stopped')
  console.log('✓ 真实 Java 子进程启动、实时日志、控制台命令、正常保存退出、强制停止；端口冲突/重复开服/EULA 前置校验；配置备份')
} finally { await shutdownServers(); await fs.rm(root, { recursive: true, force: true }) }
