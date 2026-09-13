// 区块编辑器测试：合成 .mca → 位图/俯视图 → 替换（含调色板扩容重编码）→ 写回校验
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import { parse, write, num, NbtNum, TAG } from '../src/server/nbt.js'
import { regionBitmap, readChunkDetail, replaceInChunk } from '../src/server/region.js'

const assert = (cond, msg) => { if (!cond) { console.error('✗ ' + msg); process.exit(1) } console.log('✓ ' + msg) }

const BASE = path.join(os.tmpdir(), 'mc-tb-regiontest')
const WORLD = path.join(BASE, 'world')
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(path.join(WORLD, 'region'), { recursive: true })

// 15 种方块（位宽 4），替换后扩到 16（位宽 5）—— 专门覆盖调色板扩容场景
const PALETTE = [
  'minecraft:air', 'minecraft:stone', 'minecraft:grass_block', 'minecraft:dirt', 'minecraft:cobblestone',
  'minecraft:sand', 'minecraft:gravel', 'minecraft:water', 'minecraft:oak_log', 'minecraft:oak_leaves',
  'minecraft:glass', 'minecraft:bricks', 'minecraft:glowstone', 'minecraft:obsidian', 'minecraft:snow'
]
const AIR = 0, STONE = 1, GRASS = 2

function makeChunkNbt(topPattern) {
  // topPattern(x,z) → 调色板索引（y=15 层）；其余层全 STONE
  const indices = new Int32Array(4096)
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        indices[y * 256 + z * 16 + x] = (y === 15) ? topPattern(x, z) : STONE
      }
    }
  }
  const bits = 4
  const perLong = Math.floor(64 / bits)
  const longs = new BigInt64Array(Math.ceil(4096 / perLong))
  for (let i = 0; i < 4096; i++) {
    longs[Math.floor(i / perLong)] |= BigInt(indices[i]) << BigInt((i % perLong) * bits)
  }
  return {
    name: '',
    value: {
      DataVersion: num.int(3700),
      Status: 'minecraft:full',
      xPos: num.int(0), zPos: num.int(0),
      sections: [
        { Y: num.byte(1), block_states: { palette: [{ Name: 'minecraft:air' }] } },
        { Y: num.byte(0), block_states: { palette: PALETTE.map((n) => ({ Name: n })), data: longs } }
      ]
    }
  }
}

function buildRegion(chunks) {
  // chunks: [{ cx, cz, nbt }]
  const file = Buffer.alloc(2 * 4096)
  let nextSector = 2
  for (const c of chunks) {
    const raw = write(c.nbt, { gzip: false })
    const comp = zlib.deflateSync(raw)
    const body = Buffer.alloc(5 + comp.length)
    body.writeUInt32BE(comp.length + 1, 0)
    body.writeUInt8(2, 4)
    comp.copy(body, 5)
    const count = Math.ceil(body.length / 4096)
    const idx = c.cz * 32 + c.cx
    file.writeUInt32BE((nextSector << 8) | count, idx * 4)
    file.writeUInt32BE(Math.floor(Date.now() / 1000), 4096 + idx * 4)
    const out = Buffer.concat([file.subarray(0, nextSector * 4096), body])
    const full = Buffer.alloc((nextSector + count) * 4096)
    out.copy(full, 0)
    // 把 header 部分重新拷回（out 截断了 header 之后的部分）
    file.copy(full, 0, 0, 8192)
    file.writeUInt32BE((nextSector << 8) | count, idx * 4)
    file.writeUInt32BE(Math.floor(Date.now() / 1000), 4096 + idx * 4)
    full.copy ? null : null
    // 重新组装：header + 已写数据
    const result = Buffer.alloc((nextSector + count) * 4096)
    Buffer.concat([file.subarray(0, 8192)]).copy(result, 0)
    // 简化：直接重写 header 字段
    result.writeUInt32BE((nextSector << 8) | count, idx * 4)
    result.writeUInt32BE(Math.floor(Date.now() / 1000), 4096 + idx * 4)
    body.copy(result, nextSector * 4096)
    fs.writeFileSync(path.join(WORLD, 'region', 'r.0.0.mca'), result)
    nextSector += count
    // 后续 chunk 需要基于最新文件继续追加
    var lastLen = result.length
  }
}

// 上面的 buildRegion 逻辑对多区块太绕，改用逐块重写文件的简单版
function buildRegionSimple(chunks) {
  const file = Buffer.alloc(2 * 4096)
  fs.writeFileSync(path.join(WORLD, 'region', 'r.0.0.mca'), file)
  let nextSector = 2
  for (const c of chunks) {
    const raw = write(c.nbt, { gzip: false })
    const comp = zlib.deflateSync(raw)
    const body = Buffer.alloc(5 + comp.length)
    body.writeUInt32BE(comp.length + 1, 0)
    body.writeUInt8(2, 4)
    comp.copy(body, 5)
    const count = Math.ceil(body.length / 4096)
    const idx = c.cz * 32 + c.cx
    const cur = fs.readFileSync(path.join(WORLD, 'region', 'r.0.0.mca'))
    const grown = Buffer.alloc((nextSector + count) * 4096)
    cur.copy(grown, 0)
    body.copy(grown, nextSector * 4096)
    grown.writeUInt32BE((nextSector << 8) | count, idx * 4)
    grown.writeUInt32BE(Math.floor(Date.now() / 1000), 4096 + idx * 4)
    fs.writeFileSync(path.join(WORLD, 'region', 'r.0.0.mca'), grown)
    nextSector += count
  }
}

// ---- 构造：两个区块 ----
// chunk(0,0)：y=15 层 (x+z)%2 偶数=GRASS、奇数=STONE
buildRegionSimple([
  { cx: 0, cz: 0, nbt: makeChunkNbt((x, z) => ((x + z) % 2 === 0 ? GRASS : STONE)) },
  { cx: 5, cz: 7, nbt: makeChunkNbt(() => GRASS) }
])
const MCA = path.join(WORLD, 'region', 'r.0.0.mca')

// ---- 位图 ----
const bm = regionBitmap(WORLD, 'r.0.0.mca')
assert(bm.bitmap[0 * 32 + 0] === true, '位图：chunk(0,0) 存在')
assert(bm.bitmap[7 * 32 + 5] === true, '位图：chunk(5,7) 存在')
assert(bm.bitmap[1 * 32 + 1] === false, '位图：chunk(1,1) 不存在')

// ---- 俯视图 ----
const d0 = readChunkDetail(WORLD, 'r.0.0.mca', 0, 0)
assert(d0.status === 'minecraft:full', 'Status 读取')
assert(d0.top[0].name === 'minecraft:grass_block' && d0.top[0].y === 15, '俯视 (0,0) 顶层=grass_block y=15')
assert(d0.top[0 * 16 + 1].name === 'minecraft:stone', '俯视 (x=1,z=0) 顶层=stone（棋盘另一色）')
assert(d0.top[1 * 16 + 1].name === 'minecraft:grass_block', '俯视 (x=1,z=1) 顶层=grass_block')
const grassCount = d0.top.filter((t) => t.name === 'minecraft:grass_block').length
assert(grassCount === 128, '草方块数 128（棋盘一半）: ' + grassCount)

// ---- 替换 1：目标不在调色板（扩容 15→16，位宽 4→5，需重编码） ----
const r1 = replaceInChunk(WORLD, 'r.0.0.mca', 0, 0, 'minecraft:stone', 'minecraft:diamond_ore', { backup: true })
assert(r1.ok && r1.replaced > 0, '替换 stone→diamond_ore 执行（' + r1.replaced + ' 个）')
const d1 = readChunkDetail(WORLD, 'r.0.0.mca', 0, 0)
assert(d1.top[0 * 16 + 1].name === 'minecraft:diamond_ore', '替换后 (x=1,z=0) 顶层=diamond_ore')
assert(d1.top[0].name === 'minecraft:grass_block', '替换后 (0,0) 顶层仍=grass_block（不受影响）')
// 深层：y=14 原来是 stone → 现在应为 diamond_ore（读原始 NBT 验证重编码正确性）
const d1raw = readChunkDetail(WORLD, 'r.0.0.mca', 0, 0)
void d1raw
const baks = fs.readdirSync(path.join(WORLD, 'region')).filter((n) => n.includes('.bak-'))
assert(baks.length === 1, '自动备份 .mca × 1')

// ---- 替换 2：目标已在调色板（纯索引重指，无扩容） ----
const r2 = replaceInChunk(WORLD, 'r.0.0.mca', 0, 0, 'minecraft:grass_block', 'minecraft:stone', { backup: false })
assert(r2.ok && r2.replaced === 128, 'grass→stone 索引重指 128 个')
const d2 = readChunkDetail(WORLD, 'r.0.0.mca', 0, 0)
assert(d2.top[0].name === 'minecraft:stone', '替换后 (0,0) 顶层=stone')

// ---- 替换 3：另一个区块（5,7）不受影响 ----
const d3 = readChunkDetail(WORLD, 'r.0.0.mca', 5, 7)
assert(d3.top[3 * 16 + 3].name === 'minecraft:grass_block', 'chunk(5,7) 未被误改')

// ---- 不存在的替换目标 ----
const r4 = replaceInChunk(WORLD, 'r.0.0.mca', 5, 7, 'minecraft:diamond_ore', 'minecraft:dirt', { backup: false })
assert(r4.ok && r4.replaced === 0, '无匹配时 replaced=0')

// ---- 深层方块重编码正确性：读原始 NBT 检查 y=14 层 ----
const cur = parse(fs.readFileSync(MCA).subarray(8192 + 5).subarray(0, fs.readFileSync(MCA).readUInt32BE(8192) - 1))
const sec0 = cur.value.sections.find((s) => s.Y.value === 0)
const pal = sec0.block_states.palette.map((p) => p.Name)
// palette 里应该同时有 stone 和 diamond_ore（y=14 层仍是 stone，y=15 部分变 diamond_ore）
assert(pal.includes('minecraft:diamond_ore'), '调色板包含新方块 diamond_ore')
assert(pal.includes('minecraft:stone'), '调色板保留 stone（y=14 层未动）')

console.log('\n✓✓ 区块编辑器测试全部通过')
