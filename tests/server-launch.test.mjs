import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { requiredJava, validateMemory, resolveJava, bundleJavaRuntime } from '../src/server/server-launch.js'
import { writeServerScripts } from '../src/server/pack-converter.js'

const exec = promisify(execFile)
assert.equal(requiredJava({ mc: '1.12.2' }), 8)
assert.equal(requiredJava({ mc: '1.17.1' }), 16)
assert.equal(requiredJava({ mc: '1.20.4' }), 17)
assert.equal(requiredJava({ mc: '1.20.5' }), 21)
assert.throws(() => validateMemory('2G', '8G'), /初始内存/)
assert.throws(() => validateMemory('8G & echo unsafe'), /格式/)
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-launch-'))
const runtime = { mc: '1.12.2', loader: 'forge', loaderVersion: '14.23.5.2855' }
try {
  const jar = 'forge-1.12.2-14.23.5.2855.jar'
  await fs.writeFile(path.join(root, jar), 'fixture')
  await writeServerScripts(root, runtime, {}, { memory: '8G', minMemory: '1G' })
  const config = JSON.parse(await fs.readFile(path.join(root, 'server-launch.json'), 'utf8'))
  assert.equal(config.javaMajor, 8)
  assert.equal(config.memory, '8G')
  assert.deepEqual(config.args, ['-jar', jar, 'nogui'])
  const sh = await fs.readFile(path.join(root, 'start.sh'), 'utf8')
  assert.ok(sh.includes('-Xms1G -Xmx8G'))
  assert.ok(sh.includes('Java 8 (64-bit) required'))
  if (process.platform === 'win32') {
    const java = await resolveJava(runtime)
    assert.equal(java.major, 8)
    await assert.rejects(resolveJava({ mc: '1.21.1' }, java.path), /不兼容/)
    const bundle = await bundleJavaRuntime(root, java.path)
    assert.ok(bundle.bytes > 0)
    await writeServerScripts(root, runtime, {}, { memory: '8G', minMemory: '1G', javaPath: bundle.path })
    // Move to a path with spaces and Unicode, retaining only the bundled Java preference.
    const moved = root + ' 移动后'
    await fs.rename(root, moved)
    try {
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(moved, 'start.ps1')], {
        cwd: os.tmpdir(), env: { ...process.env, MC_SERVER_JAVA: '', MC_TOOLBOX_LAUNCH_CHECK: '1' }, windowsHide: true, timeout: 30000
      })
      assert.match(stdout, /runtime[\\/]bin[\\/]java.exe/)
      assert.ok(stdout.includes('-Xms1G -Xmx8G -jar'))
      console.log('✓ 本机 Java 8 自动选择、拒绝不兼容 Java、复制真实运行时、移动目录后启动检查通过')
    } finally { await fs.rename(moved, root) }
  }
  const modern = path.join(root, 'modern')
  await fs.mkdir(path.join(modern, 'libraries/net/minecraftforge/forge/1.20.1-47.3.0'), { recursive: true })
  const argDir = 'libraries/net/minecraftforge/forge/1.20.1-47.3.0/'
  await fs.writeFile(path.join(modern, 'run.bat'), `java @user_jvm_args.txt @${argDir}win_args.txt %*`)
  await fs.writeFile(path.join(modern, 'user_jvm_args.txt'), '-Xms2G\n-Xmx2G\n-Dkeep=true\n')
  await fs.writeFile(path.join(modern, argDir + 'win_args.txt'), 'fixture')
  await fs.writeFile(path.join(modern, argDir + 'unix_args.txt'), 'fixture')
  await fs.writeFile(path.join(modern, argDir + 'forge-1.20.1-47.3.0-server.jar'), 'do not launch directly')
  const launch = await writeServerScripts(modern, { mc: '1.20.1', loader: 'forge' }, {}, { memory: '12G', minMemory: '2G' })
  assert.equal(launch.mode, 'installer-script')
  assert.equal(launch.javaMajor, 17)
  assert.equal(await fs.readFile(path.join(modern, 'user_jvm_args.txt'), 'utf8'), '\n\n-Dkeep=true\n')
  assert.ok((await fs.readFile(path.join(modern, 'start.sh'), 'utf8')).includes('@' + argDir + 'unix_args.txt'))
  console.log('✓ 新旧 Forge 启动脚本均应用内存参数；新版优先使用安装器参数文件')
} finally { await fs.rm(root, { recursive: true, force: true }) }
