// 存储目录迁移端到端测试：更改目录 → 文件完整转移 → 立即生效 → 恢复默认
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SOURCE = fileURLToPath(new URL('..', import.meta.url))
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tb-isolated-dirs-'))
// 用异步复制：Node 22.18 的 fs.cpSync 在 Windows 上复制目录时，只要源路径含非 ASCII
// 字符（本仓库位于 F:\DS数据\...）就会整进程 fastfail（0xC0000409），无任何堆栈。
for (const name of ['src', 'public', 'server.js', 'package.json']) {
  await fsp.cp(path.join(SOURCE, name), path.join(ROOT, name), { recursive: true })
}
const PORT = 8791
const BASE = 'http://127.0.0.1:' + PORT
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tb-dirs-destination-'))
const J = (r) => r.json()
const assert = (cond, msg) => { if (!cond) { console.error('✗ ' + msg); process.exit(1) } console.log('✓ ' + msg) }

fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
// 幂等：清掉上次运行遗留的自定义目录记录，让测试从「全默认」状态开始
fs.rmSync(path.join(ROOT, 'data', 'dirs.json'), { force: true })

let child = spawn(process.execPath, ['server.js', '--no-open', '--port=' + PORT], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
child.stdout.on('data', (d) => { log += d })
child.stderr.on('data', (d) => { log += d })

for (let i = 0; i < 60; i++) {
  try { await fetch(BASE + '/api/bootstrap'); break } catch { await new Promise((r) => setTimeout(r, 250)) }
}

const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(J)

try {
  // 初始状态：全部默认
  const d0 = await fetch(BASE + '/api/dirs').then(J)
  assert(d0.configDir && d0.defaults.configDir, 'GET /api/dirs 返回当前+默认')
  assert(!d0.custom.configDir && !d0.custom.dataDir && !d0.custom.clientModsDir, '初始全部为默认目录')
  const defCfg = d0.defaults.configDir

  // 产生配置文件
  await fetch(BASE + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ general: { tileColumns: 7 } }) }).then(J)
  assert(fs.existsSync(path.join(defCfg, 'settings.json')), 'settings.json 已生成于默认配置目录')

  // ---- 迁移 configDir ----
  const dirA = path.join(TMP, 'cfg')
  const r1 = await post('/api/dirs/change', { which: 'configDir', target: dirA })
  assert(r1.ok, 'configDir 迁移成功（' + r1.files + ' 文件）')
  assert(fs.existsSync(path.join(dirA, 'settings.json')), 'settings.json 已转移到新目录')
  assert(!fs.existsSync(path.join(defCfg, 'settings.json')), '原目录 settings.json 已清空')
  assert(JSON.parse(fs.readFileSync(path.join(dirA, 'settings.json'), 'utf8')).general.tileColumns === 7, '内容完整（tileColumns=7）')
  const d1 = await fetch(BASE + '/api/dirs').then(J)
  assert(d1.configDir === dirA && d1.custom.configDir, '/api/dirs 立即反映新目录')
  const s1 = await fetch(BASE + '/api/settings').then(J)
  assert(s1.general.tileColumns === 7, '运行时设置读取不受迁移影响')
  // 运行时写入落到新目录
  await fetch(BASE + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ general: { tileColumns: 8 } }) }).then(J)
  assert(JSON.parse(fs.readFileSync(path.join(dirA, 'settings.json'), 'utf8')).general.tileColumns === 8, '迁移后写入落在新目录')

  // ---- 错误路径 ----
  const e1 = await post('/api/dirs/change', { which: 'configDir', target: dirA })
  assert(e1.error && e1.error.includes('相同'), '同目录被拒绝')
  const e2 = await post('/api/dirs/change', { which: 'configDir', target: path.join(dirA, 'sub') })
  assert(e2.error && e2.error.includes('内部'), '目标在当前目录内被拒绝')
  const nonEmpty = path.join(TMP, 'nonempty')
  fs.mkdirSync(nonEmpty)
  fs.writeFileSync(path.join(nonEmpty, 'x.txt'), 'x')
  const e3 = await post('/api/dirs/change', { which: 'configDir', target: nonEmpty })
  assert(e3.error && e3.error.includes('不是空的'), '非空目标被拒绝')
  const e4 = await post('/api/dirs/change', { which: 'bogus', target: path.join(TMP, 'x') })
  assert(e4.error, '未知目录类型被拒绝')

  // ---- 迁移 clientModsDir（dev 模式与 configDir 同盘同目录，验证归属拆分） ----
  await post('/api/mods/client-list', { modid: 'testmod' })
  const dirB = path.join(TMP, 'mods')
  const r2 = await post('/api/dirs/change', { which: 'clientModsDir', target: dirB })
  assert(r2.ok, 'clientModsDir 迁移成功')
  assert(fs.existsSync(path.join(dirB, 'clientmods.json')), 'clientmods.json 已转移')
  assert(fs.existsSync(path.join(dirA, 'settings.json')), 'configDir 的 settings.json 未被误搬（归属隔离，仍在 dirA）')
  assert(!fs.existsSync(path.join(dirB, 'settings.json')), 'settings.json 没有跟着 mod 库走')
  const cl = await fetch(BASE + '/api/mods/client-list').then(J)
  assert(cl.items.some((x) => x.modid === 'testmod'), 'mod 库数据迁移后仍可读')

  // ---- 迁移 dataDir（dirs.json 引导文件必须留在默认位置） ----
  const dirsFile = d1.dirsFile
  const dirC = path.join(TMP, 'data')
  const r3 = await post('/api/dirs/change', { which: 'dataDir', target: dirC })
  assert(r3.ok, 'dataDir 迁移成功')
  assert(fs.existsSync(dirsFile), '引导文件 dirs.json 留在默认位置')
  assert(!fs.existsSync(path.join(dirC, 'dirs.json')), 'dirs.json 没有被搬到新数据目录')
  const d3 = await fetch(BASE + '/api/dirs').then(J)
  assert(d3.dataDir === dirC, 'dataDir 已切换')

  // ---- 重启后自定义目录仍然生效（引导文件持久化） ----
  child.kill()
  await new Promise((r) => setTimeout(r, 500))
  const child2 = spawn(process.execPath, ['server.js', '--no-open', '--port=' + PORT], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  child2.stdout.on('data', (d) => { log += d })
  child2.stderr.on('data', (d) => { log += d })
  child = child2
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/api/bootstrap'); break } catch { await new Promise((r) => setTimeout(r, 250)) }
  }
  const d4 = await fetch(BASE + '/api/dirs').then(J)
  assert(d4.configDir === dirA && d4.clientModsDir === dirB && d4.dataDir === dirC, '重启后三个自定义目录全部生效')
  const s4 = await fetch(BASE + '/api/settings').then(J)
  assert(s4.general.tileColumns === 8, '重启后配置仍从自定义目录读取')

  // ---- 全部恢复默认 ----
  for (const which of ['configDir', 'clientModsDir', 'dataDir']) {
    const r = await post('/api/dirs/reset', { which })
    assert(r.ok, '恢复默认：' + which)
  }
  const d5 = await fetch(BASE + '/api/dirs').then(J)
  assert(!d5.custom.configDir && !d5.custom.clientModsDir && !d5.custom.dataDir, '全部恢复默认')
  assert(fs.existsSync(path.join(defCfg, 'settings.json')), 'settings.json 已迁回默认目录')
  assert(fs.readdirSync(dirA).length === 0, '自定义目录已清空')
  assert(JSON.parse(fs.readFileSync(path.join(defCfg, 'settings.json'), 'utf8')).general.tileColumns === 8, '迁回后内容完整')
  const persist = JSON.parse(fs.readFileSync(dirsFile, 'utf8'))
  assert(!persist.configDir && !persist.clientModsDir && !persist.dataDir, '引导文件已清空自定义项')

  console.log('\n✓✓ 存储目录迁移端到端测试全部通过')
} catch (e) {
  console.error('\n✗ 测试失败:', e.message)
  console.error(log.slice(-600))
  process.exitCode = 1
} finally {
  child.kill()
}
