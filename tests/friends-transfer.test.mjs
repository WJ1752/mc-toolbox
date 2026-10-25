// 文件名消毒与传输台账：对端文件名只能影响文件名，不能影响目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TransferBook, sanitizeFileName, uniqueFileName } from '../src/server/friends/transfer.js'

test('文件名消毒：路径、穿越、控制字符、保留名、结尾点', () => {
  assert.equal(sanitizeFileName('../../evil.jar'), 'evil.jar')
  assert.equal(sanitizeFileName('C:\\Windows\\system32\\bad.jar'), 'bad.jar')
  assert.equal(sanitizeFileName('a\u0000b.jar'), 'a_b.jar')
  assert.equal(sanitizeFileName('CON.jar'), '_CON.jar')
  assert.equal(sanitizeFileName('name...'), 'name')
  assert.equal(sanitizeFileName('   '), 'file')
  assert.equal(sanitizeFileName('..'), 'file')
  assert.equal(sanitizeFileName('a/b/c.jar'), 'c.jar')
})

test('文件名消毒：保留扩展名并限制长度', () => {
  const long = 'x'.repeat(300) + '.jar'
  const safe = sanitizeFileName(long, { maxLength: 40 })
  assert.ok(safe.length <= 40)
  assert.ok(safe.endsWith('.jar'))
})

test('同名文件自动加序号，不覆盖已有文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mctb-friends-name-'))
  fs.writeFileSync(path.join(dir, 'pack.mrpack'), 'a')
  fs.writeFileSync(path.join(dir, 'pack-2.mrpack'), 'b')
  assert.equal(uniqueFileName(dir, 'pack.mrpack'), 'pack-3.mrpack')
  assert.equal(uniqueFileName(dir, 'other.mrpack'), 'other.mrpack')
})

test('传输台账：进度累计不超过总大小，终态带时间', () => {
  const book = new TransferBook()
  const transfer = book.create({
    direction: 'in',
    kind: 'pack',
    peerId: 'f_0123456789',
    peerName: '老王',
    name: 'SkyFactory.mrpack',
    files: [{ name: 'SkyFactory.mrpack', size: 1000, sha1: 'a'.repeat(40) }]
  })
  assert.equal(transfer.status, 'offered')
  assert.equal(transfer.totalBytes, 1000)
  book.addBytes(transfer.id, 600)
  book.addBytes(transfer.id, 600)
  assert.equal(book.get(transfer.id).transferredBytes, 1000)
  book.finish(transfer.id, 'done')
  assert.ok(book.get(transfer.id).finishedAt > 0)
  assert.equal(book.active().length, 0)
})

test('传输台账：已完成记录只保留最近 40 条', () => {
  const book = new TransferBook({ limit: 40 })
  for (let index = 0; index < 45; index++) {
    const transfer = book.create({ direction: 'out', kind: 'pack', name: 'p' + index, files: [] })
    book.finish(transfer.id, 'done')
  }
  assert.equal(book.list().length, 40)
})

test('传输快照不向发送方暴露本机路径', () => {
  const book = new TransferBook()
  book.create({
    direction: 'out',
    kind: 'mods',
    name: '模组',
    files: [{ name: 'a.jar', size: 10, sha1: 'b'.repeat(40), path: 'C:\\secret\\a.jar' }]
  })
  const inbound = book.create({
    direction: 'in',
    kind: 'mods',
    name: '模组',
    files: [{ name: 'a.jar', size: 10, sha1: 'b'.repeat(40), path: 'C:\\received\\a.jar' }]
  })
  const snapshot = book.snapshot()
  const out = snapshot.find((item) => item.direction === 'out')
  const inc = snapshot.find((item) => item.direction === 'in' && item.id === inbound.id)
  assert.equal(out.files[0].path, '')
  assert.equal(inc.files[0].path, 'C:\\received\\a.jar')
})
