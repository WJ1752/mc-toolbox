// 游戏进程必须独立于启动器进程树（Windows 作业对象回归）。
//
// 背景：Windows 上 Node/libuv 会把非 detached 的子进程和父进程放进同一个
// kill-on-close 作业对象。启动器一键更新需要退出并替换自身 exe，作业关闭时
// 正在玩的 MC 会被一起 TerminateProcess（表现为 latest.log 没有 Stopping）。
// 这里既校验 spawn 选项，也起一个真实的「伪启动器 → 伪游戏」进程对，
// 确认父进程退出后子进程仍存活。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gameSpawnOptions } from '../src/server/launcher/launch.js'

// 伪启动器在子进程里 import 生产模块，所以这里用绝对 file URL，不依赖测试进程的 cwd。
const LAUNCH_MODULE = pathToFileURL(fileURLToPath(new URL('../src/server/launcher/launch.js', import.meta.url))).href

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate, timeoutMs, stepMs = 50) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return false
}

function killQuietly(pid) {
  if (!pid) return
  try { process.kill(pid) } catch {}
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch {}
  }
}

test('gameSpawnOptions：detached 启动，日志仍走管道，工作目录与标记环境变量保留', () => {
  const opts = gameSpawnOptions('C:/game-dir')
  assert.equal(opts.detached, true, '游戏进程必须 detached，否则会随启动器退出被作业对象杀掉')
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(opts.windowsHide, true)
  assert.equal(opts.cwd, 'C:/game-dir')
  assert.equal(opts.env.MC_TOOLBOX_LAUNCHER, '1')
})

test('父进程（启动器）退出后，用 gameSpawnOptions 拉起的子进程仍然存活', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-detach-'))
  const pidFile = path.join(dir, 'child.json')
  const launcherScript = path.join(dir, 'fake-launcher.mjs')
  // 伪启动器：用生产代码的 spawn 选项拉起一个长期存活的「伪游戏」，记录 PID 后立刻退出。
  const launcherSource = `
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { gameSpawnOptions } from ${JSON.stringify(LAUNCH_MODULE)}
const options = gameSpawnOptions(${JSON.stringify(dir)})
const child = spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000)'], options)
fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: child.pid }), 'utf8')
setTimeout(() => process.exit(0), 400)
`
  await fsp.writeFile(launcherScript, launcherSource, 'utf8')

  let childPid = 0
  try {
    const launcher = spawn(process.execPath, [launcherScript], { stdio: 'ignore', windowsHide: true })
    const exitCode = await new Promise((resolve) => {
      launcher.on('exit', (code) => resolve(code))
      launcher.on('error', () => resolve(null))
    })
    assert.equal(exitCode, 0, '伪启动器应当正常退出')

    const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'))
    childPid = Number(record.pid) || 0
    assert.ok(childPid > 0, '伪游戏应当拿到 PID')

    // 父进程退出后给系统一点时间执行作业清理，再确认子进程还活着。
    assert.equal(alive(childPid), true, '伪启动器退出时伪游戏就已经被结束')
    const died = await waitFor(() => !alive(childPid), 2500)
    assert.equal(died, false, '父进程退出后子进程被执行作业对象清理掉了（detached 未生效）')
  } finally {
    killQuietly(childPid)
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
