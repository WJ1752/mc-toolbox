// 存档编辑器端到端测试：合成存档 → 起服务 → 打全部 API → 校验写入与备份
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { parse, write, num, NbtNum, TAG } from '../src/server/nbt.js'
import { fileURLToPath } from 'node:url'

const BASE = path.join(os.tmpdir(), 'mc-tb-savetest')
const MC = path.join(BASE, '.minecraft')
const WORLD = path.join(MC, 'saves', 'TestWorld')
const PORT = 8798
const J = (r) => r.json()

const assert = (cond, msg) => { if (!cond) { console.error('✗ ' + msg); process.exit(1) } console.log('✓ ' + msg) }

// ---------- 1. 合成存档 ----------
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(WORLD, { recursive: true })
fs.mkdirSync(path.join(WORLD, 'playerdata'), { recursive: true })

const levelTree = {
  name: '',
  value: {
    Data: {
      LevelName: '原始名字',
      GameType: num.int(0),
      Difficulty: num.int(2),
      hardcore: num.byte(0),
      allowCommands: num.byte(0),
      DifficultyLocked: num.byte(0),
      SpawnX: num.int(0), SpawnY: num.int(64), SpawnZ: num.int(0),
      Time: 1000n, DayTime: 1000n,
      raining: num.byte(0), thundering: num.byte(0),
      rainTime: num.int(100), thunderTime: num.int(100),
      BorderSize: new NbtNum(TAG.DOUBLE, 59999968),
      BorderCenterX: new NbtNum(TAG.DOUBLE, 0),
      BorderCenterZ: new NbtNum(TAG.DOUBLE, 0),
      LastPlayed: 1726200000000n,
      Version: { Name: '1.20.1', Id: num.int(763) },
      WorldGenSettings: { seed: 123456789012345n },
      Player: {
        Health: new NbtNum(TAG.FLOAT, 20),
        foodLevel: num.int(20),
        foodSaturationLevel: new NbtNum(TAG.FLOAT, 5),
        XpLevel: num.int(30), XpP: new NbtNum(TAG.FLOAT, 0.5), XpTotal: num.int(999),
        playerGameType: num.int(0),
        Pos: [new NbtNum(TAG.DOUBLE, 8.5), new NbtNum(TAG.DOUBLE, 70), new NbtNum(TAG.DOUBLE, -3.25)],
        Rotation: [new NbtNum(TAG.FLOAT, 90), new NbtNum(TAG.FLOAT, 15.5)],
        Invulnerable: num.byte(0),
        abilities: { mayfly: num.byte(0), instabuild: num.byte(0), flySpeed: new NbtNum(TAG.FLOAT, 0.05), walkSpeed: new NbtNum(TAG.FLOAT, 0.1) },
        Attributes: [
          { Name: 'generic.max_health', Base: new NbtNum(TAG.DOUBLE, 20) },
          { Name: 'generic.movement_speed', Base: new NbtNum(TAG.DOUBLE, 0.1) }
        ],
        Inventory: [
          { Slot: num.byte(0), id: 'minecraft:diamond_pickaxe', Count: num.byte(1) },
          { Slot: num.byte(4), id: 'minecraft:bread', Count: num.byte(12) }
        ]
      }
    }
  }
}
fs.writeFileSync(path.join(WORLD, 'level.dat'), write(levelTree))

const playerTree = {
  name: '',
  value: {
    Health: new NbtNum(TAG.FLOAT, 12.5),
    foodLevel: num.int(18),
    foodSaturationLevel: new NbtNum(TAG.FLOAT, 2),
    XpLevel: num.int(10), XpP: new NbtNum(TAG.FLOAT, 0.2), XpTotal: num.int(200),
    playerGameType: num.int(1),
    Pos: [new NbtNum(TAG.DOUBLE, 1.5), new NbtNum(TAG.DOUBLE, 65), new NbtNum(TAG.DOUBLE, 2.5)],
    Rotation: [new NbtNum(TAG.FLOAT, 0), new NbtNum(TAG.FLOAT, 0)],
    Invulnerable: num.byte(0),
    abilities: { mayfly: num.byte(0), instabuild: num.byte(0), flySpeed: new NbtNum(TAG.FLOAT, 0.05), walkSpeed: new NbtNum(TAG.FLOAT, 0.1) },
    Attributes: [{ Name: 'generic.max_health', Base: new NbtNum(TAG.DOUBLE, 20) }],
    Inventory: [{ Slot: num.byte(1), id: 'minecraft:stick', Count: num.byte(3) }]
  }
}
fs.writeFileSync(path.join(WORLD, 'playerdata', '1111-2222.dat'), write(playerTree))
console.log('合成存档已生成:', WORLD)

// ---------- 2. 起服务 ----------
const child = spawn(process.execPath, ['server.js', '--no-open', '--port=' + PORT], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
child.stdout.on('data', (d) => { log += d })
child.stderr.on('data', (d) => { log += d })

const base = 'http://127.0.0.1:' + PORT
const waitListen = async () => {
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/bootstrap'); return } catch { await new Promise((r) => setTimeout(r, 250)) }
  }
  throw new Error('服务启动失败\n' + log)
}

const enc = encodeURIComponent
try {
  await waitListen()
  console.log('服务已启动')

  // presets（本机可能没有默认 .minecraft，只验证结构）
  const presets = await fetch(base + '/api/saveeditor/presets').then(J)
  assert(Array.isArray(presets.items), 'presets 返回数组')

  // worlds
  const worlds = await fetch(base + '/api/saveeditor/worlds?mcDir=' + enc(MC)).then(J)
  assert(!worlds.error, 'worlds 无错误: ' + (worlds.error || ''))
  assert(worlds.worlds.length === 1, 'worlds 数量 1')
  const w = worlds.worlds[0]
  assert(w.levelName === '原始名字', 'worlds.LevelName=' + w.levelName)
  assert(w.version === '1.20.1', 'worlds.Version=' + w.version)
  assert(w.seed === '123456789012345', 'worlds.seed=' + w.seed)

  // world 详情
  const world = await fetch(base + '/api/saveeditor/world?world=' + enc(WORLD)).then(J)
  assert(!world.error, 'world 无错误')
  assert(world.fields.LevelName === '原始名字', 'world.fields.LevelName')
  assert(world.fields.Time === 1000, 'world.fields.Time=1000')
  assert(world.players.length === 2 && world.players[0].key === 'level' && world.players[1].key === '1111-2222.dat', 'players 清单')

  // player（level.dat 里的单人玩家）
  const p1 = await fetch(base + '/api/saveeditor/player?world=' + enc(WORLD) + '&player=level').then(J)
  assert(p1.fields.Health === 20 && p1.maxHealth === 20, 'player(level).Health/maxHealth')
  assert(p1.fields.PosX === 8.5 && p1.fields.PosZ === -3.25, 'player(level).Pos')
  assert(p1.inventory.length === 2 && p1.inventory[0].id === 'minecraft:diamond_pickaxe', 'player(level).Inventory')

  // player（playerdata 文件）
  const p2 = await fetch(base + '/api/saveeditor/player?world=' + enc(WORLD) + '&player=' + enc('1111-2222.dat')).then(J)
  assert(p2.fields.Health === 12.5 && p2.fields.playerGameType === 1, 'player(file).Health/gameType')

  // 写 level.dat
  const w1 = await fetch(base + '/api/saveeditor/level', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ world: WORLD, edits: { LevelName: '新名字😀', GameType: 1, hardcore: true, Time: '999999999', SpawnX: 123 } }) }).then(J)
  assert(w1.ok, '写 level.dat 成功，备份=' + path.basename(w1.backup || ''))
  const w2 = await fetch(base + '/api/saveeditor/world?world=' + enc(WORLD)).then(J)
  assert(w2.fields.LevelName === '新名字😀', '改后 LevelName 生效')
  assert(w2.fields.GameType === 1 && w2.fields.hardcore === 1, 'GameType/hardcore 生效')
  assert(Number(w2.fields.Time) === 999999999, 'Time 生效（long 精度）: ' + w2.fields.Time)
  assert(w2.fields.SpawnX === 123, 'SpawnX 生效')

  // 写 playerdata 文件玩家
  const w3 = await fetch(base + '/api/saveeditor/player', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ world: WORLD, player: '1111-2222.dat', edits: { Health: 5.5, mayfly: true, PosX: 100.5, maxHealth: 40 } }) }).then(J)
  assert(w3.ok, '写 playerdata 成功')
  const p3 = await fetch(base + '/api/saveeditor/player?world=' + enc(WORLD) + '&player=' + enc('1111-2222.dat')).then(J)
  assert(p3.fields.Health === 5.5, '改后 Health 生效')
  assert(p3.fields.mayfly === 1, 'mayfly 生效')
  assert(p3.fields.PosX === 100.5, 'PosX 生效')
  assert(p3.maxHealth === 40, 'maxHealth 生效')

  // 单人玩家（level.dat）写 Xp
  const w4 = await fetch(base + '/api/saveeditor/player', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ world: WORLD, player: 'level', edits: { XpLevel: 99 } }) }).then(J)
  assert(w4.ok, '写 level 玩家成功')
  const p4 = await fetch(base + '/api/saveeditor/player?world=' + enc(WORLD) + '&player=level').then(J)
  assert(p4.fields.XpLevel === 99, 'level 玩家 XpLevel 生效')

  // 备份文件存在 + 原始内容可还原（level.dat 被写过两次：level 编辑 + level 玩家编辑 → 2 份备份）
  const baks = fs.readdirSync(WORLD).filter((f) => f.startsWith('level.dat.bak-')).sort()
  assert(baks.length === 2, 'level.dat 备份数 = 2（两次写盘各留一份，命名不冲突）')
  const bakParse = parse(fs.readFileSync(path.join(WORLD, baks[0])))
  assert(bakParse.value.Data.LevelName === '原始名字', '最早一份备份 = 修改前的原始值')
  assert(fs.readdirSync(path.join(WORLD, 'playerdata')).filter((f) => f.includes('.bak-')).length === 1, 'playerdata 备份数 = 1')

  // 原始 level.dat 其它字段未被破坏（Version / Inventory 还在）
  const cur = parse(fs.readFileSync(path.join(WORLD, 'level.dat')))
  assert(cur.value.Data.Version.Name === '1.20.1', '未触碰字段 Version 完好')
  assert(cur.value.Data.Player.Inventory.length === 2, '未触碰字段 Inventory 完好')

  console.log('\n✓✓ 存档编辑器端到端测试全部通过')
} catch (e) {
  console.error('\n✗ 测试失败:', e.message)
  console.error(log.slice(-800))
  process.exitCode = 1
} finally {
  child.kill()
}
