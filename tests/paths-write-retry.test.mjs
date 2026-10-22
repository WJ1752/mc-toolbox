import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { writeFileWithRetry } from '../src/server/paths.js'

// 重新构建的 exe 会在旧版本仍在运行时重新解压 runtime，其中 host.exe 正被占用。
// 期望行为：把占用中的旧文件改名让位，再写入新内容（而不是抛 EBUSY 让启动失败）。
test('writeFileWithRetry：目标被运行中的程序占用时改名让位后仍能写入', {
  skip: process.platform !== 'win32'
}, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-write-retry-'))
  const dest = path.join(dir, 'locker.exe')
  await fsp.copyFile(process.execPath, dest)
  const child = spawn(dest, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'ignore', windowsHide: true })
  try {
    await new Promise((r) => setTimeout(r, 1500))
    // 先确认前提：文件确实被占用，直接写会失败。
    await assert.rejects(fsp.writeFile(dest, 'direct'), (e) => ['EBUSY', 'EPERM', 'EACCES'].includes(e.code))

    await writeFileWithRetry(dest, 'new-content')
    assert.equal(await fsp.readFile(dest, 'utf8'), 'new-content')

    const leftovers = (await fsp.readdir(dir)).filter((name) => name.startsWith('locker.exe.old-'))
    assert.equal(leftovers.length, 1, '占用中的旧文件应被改名保留')
  } finally {
    try { child.kill() } catch {}
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
