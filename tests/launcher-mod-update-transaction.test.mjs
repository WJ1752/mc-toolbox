import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fetchToFile } from '../src/server/launcher/download.js'
import { applyModUpdate, getModUpdateBackup, recoverModUpdate, undoModUpdate, withModUpdateLock } from '../src/server/launcher/mod-update-transaction.js'

const hash = (text) => createHash('sha1').update(text).digest('hex')
const item = (relPath, filename, before, after) => ({ relPath, filename, oldSha1: hash(before), sha1: hash(after), body: after })
const download = (entry, target) => fetchToFile('data:application/octet-stream,' + entry.body, target, { sha1: entry.sha1 })

async function fixture(t) {
  const gameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-batch-'))
  t.after(() => fs.rm(gameDir, { recursive: true, force: true }))
  const mods = path.join(gameDir, 'mods')
  await fs.mkdir(path.join(mods, 'nested'), { recursive: true })
  await fs.writeFile(path.join(mods, 'nested/a.jar.disabled'), 'a1')
  await fs.writeFile(path.join(mods, 'b.jar'), 'b1')
  return { inst: { id: randomUUID(), gameDir }, mods }
}

test('整批校验后替换，保留嵌套目录和禁用状态；只可撤销最近一批', async (t) => {
  const { inst, mods } = await fixture(t)
  const a = item('nested/a.jar.disabled', 'a2.jar', 'a1', 'a2')
  const b = item('b.jar', 'b.jar', 'b1', 'b2')
  await assert.rejects(applyModUpdate(inst, [a, { ...b, body: 'wrong' }], { download }), /SHA-1/)
  assert.equal(await fs.readFile(path.join(mods, a.relPath), 'utf8'), 'a1')
  assert.deepEqual(await getModUpdateBackup(inst), { backup: null })
  await applyModUpdate(inst, [a, b], { download })
  const { backup: first } = await getModUpdateBackup(inst)
  assert.equal(await fs.readFile(path.join(mods, first.items[0].after), 'utf8'), 'a2')
  assert.equal(first.items[0].after, 'nested/a2.jar.disabled')
  await assert.rejects(applyModUpdate(inst, [b], { download }), /变化/)
  assert.equal((await getModUpdateBackup(inst)).backup.id, first.id)

  await applyModUpdate(inst, [item('b.jar', 'b3.jar', 'b2', 'b3')], { download })
  const { backup } = await getModUpdateBackup(inst)
  await assert.rejects(undoModUpdate(inst, first.id), /备份已变化/)
  await fs.writeFile(path.join(mods, 'b3.jar'), 'manual')
  await assert.rejects(undoModUpdate(inst, backup.id), /变化/)
  assert.equal(await fs.readFile(path.join(mods, 'b3.jar'), 'utf8'), 'manual')
  await fs.writeFile(path.join(mods, 'b3.jar'), 'b3')
  assert.deepEqual(await undoModUpdate(inst, backup.id), { ok: true })
  assert.equal(await fs.readFile(path.join(mods, 'b.jar'), 'utf8'), 'b2')
  assert.deepEqual(await getModUpdateBackup(inst), { backup: null })
})

test('共享目录的实例互斥；更新目标冲突时保留原件', async (t) => {
  const { inst, mods } = await fixture(t)
  const alias = { ...inst, id: randomUUID() }
  const b = item('b.jar', 'b2.jar', 'b1', 'b2')
  await withModUpdateLock(inst, () => assert.rejects(applyModUpdate(alias, [b], { download }), /另一个操作/))
  await fs.writeFile(path.join(mods, 'b2.jar'), 'manual')
  await assert.rejects(applyModUpdate(inst, [b], { download }), /目标文件已存在/)
  assert.equal(await fs.readFile(path.join(mods, 'b.jar'), 'utf8'), 'b1')
  assert.equal(await fs.readFile(path.join(mods, 'b2.jar'), 'utf8'), 'manual')
})

test('多开启动器不能恢复在途更新；进程终止后可接管并清理暂存', { timeout: 15000 }, async (t) => {
  const { inst, mods } = await fixture(t)
  const moduleUrl = new URL('../src/server/launcher/mod-update-transaction.js', import.meta.url).href
  const source = `
    import { applyModUpdate } from ${JSON.stringify(moduleUrl)}
    const [inst, item] = JSON.parse(process.argv[1])
    await applyModUpdate(inst, [item], { download: async () => {
      process.send('staging')
      await new Promise(() => setInterval(() => {}, 1000))
    } })
  `
  const b = item('b.jar', 'b2.jar', 'b1', 'b2')
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify([inst, b])], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true
  })
  t.after(() => { if (child.exitCode === null && !child.killed) child.kill() })
  const exit = once(child, 'exit')
  const ready = await Promise.race([once(child, 'message'), exit])
  assert.equal(ready[0], 'staging')
  await assert.rejects(getModUpdateBackup(inst), /另一个操作/)
  child.kill('SIGKILL')
  await exit
  assert.deepEqual(await getModUpdateBackup(inst), { backup: null })
  assert.equal(await fs.readFile(path.join(mods, 'b.jar'), 'utf8'), 'b1')
})

test('重启恢复已经替换的 JAR 和只移出了原件的 JAR；恢复可重复', async (t) => {
  const { inst, mods } = await fixture(t)
  const dir = path.join(inst.gameDir, '.mc-toolbox-mod-updates')
  const id = randomUUID()
  const batch = { id, phase: 'applying', createdAt: Date.now(), items: [
    { before: 'nested/a.jar.disabled', after: 'nested/new.jar.disabled', oldSha1: hash('a1'), sha1: hash('a2') },
    { before: 'b.jar', after: 'b.jar', oldSha1: hash('b1'), sha1: hash('b2') }
  ] }
  await fs.mkdir(path.join(dir, id), { recursive: true })
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ backup: null, pending: batch }))
  for (const [i, entry] of batch.items.entries()) await fs.rename(path.join(mods, entry.before), path.join(dir, id, i + '.old'))
  await fs.writeFile(path.join(mods, batch.items[0].after), 'a2')
  await recoverModUpdate(inst)
  await recoverModUpdate(inst)
  assert.deepEqual(await fs.readdir(path.join(mods, 'nested')), ['a.jar.disabled'])
  assert.equal(await fs.readFile(path.join(mods, 'b.jar'), 'utf8'), 'b1')
  assert.equal(await fs.readFile(path.join(mods, batch.items[0].before), 'utf8'), 'a1')
})
