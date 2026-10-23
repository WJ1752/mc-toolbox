// 已运行实例接管：命令行解析、按 gameDir 匹配、缓存与 PID 关闭。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  extractCommandArgument,
  isMinecraftJavaProcess,
  gameDirKey,
  parseWindowsProcesses,
  mapProcessesToInstances,
  createRunningGameTracker,
  terminateProcess,
  isProcessAlive
} from '../src/server/launcher/running-processes.js'

const GAME_DIR = String.raw`C:\Users\HP\Desktop\1222\.minecraft\versions\BattleArmory TACZ`
const COMMAND = String.raw`F:\java17\bin\java.exe -Xmx4096M -cp C:\libs\a.jar net.minecraft.client.main.Main --username Player --version 1.20.1-forge-47.4.22 --gameDir "C:\Users\HP\Desktop\1222\.minecraft\versions\BattleArmory TACZ" --assetsDir C:\assets --assetIndex 5 --accessToken secret-token`

test('extractCommandArgument：引号路径 / = 形式 / 大小写', () => {
  assert.equal(extractCommandArgument(COMMAND, '--gameDir'), GAME_DIR)
  assert.equal(extractCommandArgument('java --gameDir=C:\\Games\\A --version 1.20.1', '--gamedir'), 'C:\\Games\\A')
  assert.equal(extractCommandArgument('java --gameDir "C:\\Games\\A B"', '--gameDir'), 'C:\\Games\\A B')
  assert.equal(extractCommandArgument('java -Dfoo=--gameDir C:\\fake', '--gameDir'), '')
  assert.equal(extractCommandArgument('java --gameDir', '--gameDir'), '')
})

test('isMinecraftJavaProcess：只认带 Minecraft 启动参数的 Java 进程', () => {
  assert.equal(isMinecraftJavaProcess(COMMAND), true)
  assert.equal(isMinecraftJavaProcess('java -jar server.jar --gameDir C:\\x --version 1.0'), false)
  assert.equal(isMinecraftJavaProcess('java -cp app.jar com.example.Main --gameDir C:\\x'), false)
  assert.equal(isMinecraftJavaProcess('java -Dminecraft.launcher.brand=X net.minecraft.client.main.Main --gameDir C:\\x'), true)
})

test('gameDirKey：Windows 路径大小写与尾部分隔符不敏感', () => {
  assert.equal(gameDirKey(GAME_DIR), gameDirKey(GAME_DIR.toLowerCase() + '\\'))
  assert.equal(gameDirKey(GAME_DIR), gameDirKey(`"${GAME_DIR}"`))
  assert.equal(gameDirKey(''), '')
})

test('parseWindowsProcesses：单对象 / 数组、过滤非游戏进程、失败抛错', () => {
  const record = {
    ProcessId: 23040,
    ParentProcessId: 37184,
    ExecutablePath: 'F:\\java17\\bin\\java.exe',
    CommandLine: COMMAND,
    StartedAt: '2026-10-23T03:00:46.9457030Z'
  }
  const [parsed] = parseWindowsProcesses(JSON.stringify(record))
  assert.equal(parsed.pid, 23040)
  assert.equal(parsed.gameDir, GAME_DIR)
  assert.equal(parsed.versionId, '1.20.1-forge-47.4.22')
  assert.ok(parsed.startedAt > 0)

  const rows = parseWindowsProcesses(JSON.stringify([
    record,
    { ProcessId: 9, CommandLine: 'java -jar app.jar --gameDir C:\\x' },
    { ProcessId: 10, CommandLine: null }
  ]))
  assert.equal(rows.length, 1)
  assert.deepEqual(parseWindowsProcesses(''), [])
  assert.throws(() => parseWindowsProcesses('not-json'), /无法解析/)
})

test('mapProcessesToInstances：按 gameDir 精确匹配并忽略未添加的实例', () => {
  const processes = parseWindowsProcesses(JSON.stringify([{
    ProcessId: 23040,
    CommandLine: COMMAND,
    StartedAt: '2026-10-23T03:00:46Z'
  }]))
  const instances = [
    { id: 'bat', name: 'BattleArmory TACZ', gameDir: GAME_DIR, lastPlayed: 10 },
    { id: 'other', name: 'Other', gameDir: 'C:\\Other', lastPlayed: 20 }
  ]
  const mapped = mapProcessesToInstances(processes, instances)
  assert.deepEqual([...mapped.keys()], ['bat'])
  assert.equal(mapped.get('bat').instanceName, 'BattleArmory TACZ')

  const duplicate = mapProcessesToInstances(processes, [
    { ...instances[0], lastPlayed: 1 },
    { ...instances[0], id: 'bat-2', lastPlayed: 99 }
  ])
  assert.deepEqual([...duplicate.keys()], ['bat-2'], '同一个 gameDir 优先最近游玩的实例')
})

test('createRunningGameTracker：TTL 缓存、强制刷新、失败保留上次结果、实例映射更新', async () => {
  let calls = 0
  let fail = false
  let now = 1000
  const processRow = {
    pid: 4321,
    ppid: 1,
    executablePath: 'C:\\Java\\bin\\java.exe',
    commandLine: COMMAND,
    startedAt: 100,
    gameDir: GAME_DIR,
    versionId: '1.20.1',
    brand: ''
  }
  const tracker = createRunningGameTracker({
    scan: async () => {
      calls++
      if (fail) throw new Error('powershell unavailable')
      return [processRow]
    },
    ttlMs: 10000,
    errorTtlMs: 10000,
    now: () => now
  })
  const instances = [{ id: 'bat', name: 'BattleArmory TACZ', gameDir: GAME_DIR }]
  let result = await tracker.refresh({ instances })
  assert.equal(result.items.length, 1)
  assert.equal(calls, 1)
  assert.equal(tracker.get('bat').pid, 4321)

  now += 1000
  result = await tracker.refresh({ instances })
  assert.equal(result.cached, true)
  assert.equal(calls, 1, 'TTL 内不重复启动 PowerShell')

  await tracker.refresh({ instances, force: true })
  assert.equal(calls, 2, 'force 必须重新扫描')

  fail = true
  now += 20000
  result = await tracker.refresh({ instances })
  assert.match(result.error, /检测失败/)
  assert.equal(result.items.length, 1, '扫描失败时保留上次运行状态')
  assert.equal(tracker.status().stale, true)

  fail = false
  now += 20000
  const added = [
    { ...instances[0], lastPlayed: 1 },
    { id: 'new', name: 'New', gameDir: GAME_DIR, lastPlayed: 99 }
  ]
  result = await tracker.refresh({ instances: added })
  assert.equal(calls, 4)
  assert.equal(tracker.get('new').pid, 4321, '同一个 gameDir 重新匹配时优先最近游玩的实例')
  assert.equal(tracker.get('bat'), null)

  tracker.forget('new')
  assert.equal(tracker.get('new'), null)
  tracker.clear()
  assert.equal(tracker.list().length, 0)
})

test('terminateProcess：真实子进程可被强制结束', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true
  })
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    assert.equal(isProcessAlive(child.pid), true)
    const result = await terminateProcess(child.pid, { force: true })
    assert.equal(result.ok, true)
    assert.equal(isProcessAlive(child.pid), false)
  } finally {
    try { child.kill() } catch {}
  }
})
