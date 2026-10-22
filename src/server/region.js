// 区块（.mca 区域文件）读取 / 修改 —— 配合 save-editor 的区块编辑功能
//
// .mca 结构（4KB 对齐扇区）：
//   [0    ) 位置表 1024 × 4B：高 3B = 起始扇区号，低 1B = 扇区数
//   [4096 ) 时间戳 1024 × 4B
//   [8192 ) 数据扇区：每区块 = 4B 长度(大端) + 1B 压缩类型(1=gzip 2=zlib) + 数据
//
// 区块 NBT（1.18+）：sections 列表，每节 { Y, block_states: { palette, data }, ... }
//   palette 元素 = { Name: 'minecraft:xxx', Properties?: {...} }
//   data = LongArray，位宽 = max(4, ceil(log2(palette.len)))，索引顺序 y*256+z*16+x，
//   1.16+（DataVersion ≥ 2529）每个 long 内装整数个索引、不跨 long。
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { parse as nbtParse, write as nbtWrite, NbtNum, TAG } from './nbt.js'

const SECTOR = 4096
const NON_STRADDLE_DATA_VERSION = 2529 // 1.16 (20w45a 之前仍跨 long，暂不支持)

function listEntries(dir, ext) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(ext)).map((e) => e.name) } catch { return [] }
}

// ---------------- 区域文件 ----------------

export async function listRegions(worldPath) {
  const dim = path.join(worldPath, 'region')
  const items = []
  for (const name of listEntries(dim, '.mca')) {
    const st = fs.statSync(path.join(dim, name))
    items.push({ name, size: st.size, mtime: st.mtimeMs })
  }
  items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return { dir: dim, items }
}

// 区域文件内的区块索引：传入的是全局区块坐标，必须先取模到 0..31，
// 否则 r.1.0 这类区域的读写会落到错误的槽位（甚至越界读不到区块）。
function regionIndex(cx, cz) {
  const lx = ((Math.trunc(cx) % 32) + 32) % 32
  const lz = ((Math.trunc(cz) % 32) + 32) % 32
  return lz * 32 + lx
}

function locAt(buf, idx) {
  const v = buf.readUInt32BE(idx * 4)
  return { offset: v >>> 8, count: v & 0xff }
}

function readRegionHeader(file) {
  const buf = fs.readFileSync(file)
  if (buf.length < 2 * SECTOR) throw new Error('区域文件损坏（小于 8KB）')
  const exists = new Array(1024)
  for (let i = 0; i < 1024; i++) {
    const { offset, count } = locAt(buf, i)
    exists[i] = offset > 0 && count > 0
  }
  return { buf, exists }
}

// 区块存在位图（32×32，索引 = cz*32+cx）
export function regionBitmap(worldPath, fileName) {
  const { exists } = readRegionHeader(resolveRegionFile(worldPath, fileName))
  const bitmap = []
  for (let cz = 0; cz < 32; cz++) {
    for (let cx = 0; cx < 32; cx++) bitmap.push(exists[cz * 32 + cx])
  }
  return { bitmap }
}

function rawChunkPayload(headerBuf, file, cx, cz) {
  const { offset, count } = locAt(headerBuf, regionIndex(cx, cz))
  if (offset === 0 || count === 0) throw new Error(`区块 (${cx},${cz}) 在此区域文件中不存在`)
  const fd = fs.openSync(file, 'r')
  try {
    const start = offset * SECTOR
    const lenBuf = Buffer.alloc(4)
    fs.readSync(fd, lenBuf, 0, 4, start)
    const len = lenBuf.readUInt32BE(0)
    if (len < 2 || len > (count + 1) * SECTOR) throw new Error('区块数据长度异常')
    const body = Buffer.alloc(len - 1)
    fs.readSync(fd, body, 0, len - 1, start + 5) // 跳过 1B 压缩类型
    return body
  } finally { fs.closeSync(fd) }
}

// 解析一个区块的 NBT（自动识别 zlib/gzip）
function readChunkNbt(file, cx, cz) {
  const header = readRegionHeader(file)
  const body = rawChunkPayload(header.buf, file, cx, cz)
  return nbtParse(body)
}

// ---------------- 区块内容 → 俯视图 ----------------

const AIR = 'minecraft:air'

function sectionKey(sec, modern) {
  // 1.18+: block_states.palette / block_states.data；1.17-: Palette / BlockStates
  const bs = modern ? (sec.block_states || {}) : sec
  const palette = bs.palette || bs.Palette
  const data = bs.data || bs.BlockStates
  return { palette, data }
}

function paletteName(entry) {
  return entry && typeof entry.Name === 'string' ? entry.Name : AIR
}

function isModern(root) {
  // 1.18+ 顶层 sections 元素带 block_states；1.17- 直接在 section 上有 Palette
  const sections = root.value.sections
  if (!Array.isArray(sections) || !sections.length) return true
  for (const s of sections) {
    if (s && typeof s === 'object' && ('block_states' in s || 'Palette' in s)) return !('Palette' in s)
  }
  return true
}

function dataVersionOf(root) {
  const dv = root.value.DataVersion
  return dv instanceof NbtNum ? dv.value : (typeof dv === 'number' ? dv : null)
}

// 读取一个区块：返回 16×16 俯视图数据（每列顶层非空气方块）+ 基本信息
export function readChunkDetail(worldPath, fileName, cx, cz) {
  const file = resolveRegionFile(worldPath, fileName)
  const root = readChunkNbt(file, cx, cz)
  const modern = isModern(root)
  const dv = dataVersionOf(root)
  const sections = Array.isArray(root.value.sections) ? root.value.sections : []

  // 每列自上而下找第一个非空气
  const top = new Array(256).fill(null)
  const sorted = sections.slice().sort((a, b) => numOf(b.Y) - numOf(a.Y))
  for (const sec of sorted) {
    const { palette, data } = sectionKey(sec, modern)
    if (!Array.isArray(palette) || !palette.length) continue
    const names = palette.map(paletteName)
    const onlyAir = names.every((n) => n === AIR)
    if (onlyAir && !data) continue
    const indices = decodeIndices(data, names.length, dv)
    const secY = numOf(sec.Y)
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        const col = z * 16 + x
        if (top[col]) continue
        for (let y = 15; y >= 0; y--) {
          const idx = indices[y * 256 + z * 16 + x] || 0
          const name = names[idx] || AIR
          if (name !== AIR) { top[col] = { x, z, y: secY * 16 + y, name }; break }
        }
      }
    }
    if (top.every(Boolean)) break
  }

  const counts = {}
  for (const t of top) if (t) counts[t.name] = (counts[t.name] || 0) + 1
  const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([name, count]) => ({ name, count }))

  return {
    cx, cz,
    dataVersion: dv,
    status: typeof root.value.Status === 'string' ? root.value.Status : (root.value.Status && root.value.Status.value) || '',
    top: top.map((t, col) => t || { x: col % 16, z: Math.floor(col / 16), y: null, name: AIR }),
    summary
  }
}

function numOf(v) { return v instanceof NbtNum ? v.value : (typeof v === 'number' ? v : 0) }

// 方块属性（compound）→ 普通对象（NbtNum→number，BigInt→安全范围 number 否则字符串）
function plainProps(v, depth = 0) {
  if (v instanceof NbtNum) return v.value
  if (typeof v === 'bigint') { const n = Number(v); return Number.isSafeInteger(n) ? n : v.toString() }
  if (Array.isArray(v)) return depth > 4 ? '[…]' : v.map((x) => plainProps(x, depth + 1))
  if (v && typeof v === 'object') {
    if (depth > 4) return '{…}'
    const out = {}
    for (const [k, x] of Object.entries(v)) out[k] = plainProps(x, depth + 1)
    return out
  }
  return v
}

function resolveRegionFile(worldPath, fileName) {
  if (!/^r\.-?\d+\.-?\d+\.mca$/.test(fileName)) throw new Error('非法的区域文件名')
  const file = path.join(worldPath, 'region', fileName)
  if (!fs.existsSync(file)) throw new Error('区域文件不存在：' + fileName)
  return file
}

// ---------------- 位压缩编解码（1.16+ 不跨 long） ----------------

function bitsFor(paletteLen) { return Math.max(4, Math.ceil(Math.log2(Math.max(2, paletteLen)))) }

function decodeIndices(data, paletteLen, dv) {
  const indices = new Int32Array(4096)
  if (!data || (data instanceof BigInt64Array && data.length === 0)) return indices // 全 0（单元素调色板）
  if (dv != null && dv < NON_STRADDLE_DATA_VERSION) throw new Error('不支持 1.16 之前的区块数据打包格式（DataVersion ' + dv + '）')
  const bits = bitsFor(paletteLen)
  const perLong = Math.floor(64 / bits)
  const mask = (1n << BigInt(bits)) - 1n
  for (let i = 0; i < 4096; i++) {
    const li = Math.floor(i / perLong)
    if (li >= data.length) break
    const bit = BigInt((i % perLong) * bits)
    indices[i] = Number((data[li] >> bit) & mask)
  }
  return indices
}

function encodeIndices(indices, paletteLen) {
  const bits = bitsFor(paletteLen)
  const perLong = Math.floor(64 / bits)
  const longs = Math.ceil(4096 / perLong)
  const out = new BigInt64Array(longs)
  for (let i = 0; i < 4096; i++) {
    const li = Math.floor(i / perLong)
    out[li] |= BigInt(indices[i] & ((1 << bits) - 1)) << BigInt((i % perLong) * bits)
  }
  return out
}

// ---------------- 替换方块 ----------------

function sectionIndices(sec, modern, dv) {
  const { palette, data } = sectionKey(sec, modern)
  if (!Array.isArray(palette) || !palette.length) return null
  return { palette, indices: decodeIndices(data, palette.length, dv) }
}

function writeSectionBack(sec, modern, palette, indices) {
  const container = modern ? (sec.block_states ||= {}) : sec
  container.palette = palette
  // 索引数组按「当前调色板长度」的位宽重新编码（调色板扩容导致位宽提升也自动正确）
  const dataKey = modern ? 'data' : 'BlockStates'
  container[dataKey] = indices.some((x) => x !== 0)
    ? encodeIndices(indices, palette.length)
    : new BigInt64Array(Math.ceil(4096 / Math.floor(64 / bitsFor(palette.length))))
}

// 单区块替换：把 palette 中名字为 from 的条目替换为 to；opts.backup=false 跳过备份（批量时由调用方备份一次）
export function replaceInChunk(worldPath, fileName, cx, cz, from, to, { backup = true } = {}) {
  const file = resolveRegionFile(worldPath, fileName)
  if (backup) backupMca(file)
  const root = readChunkNbt(file, cx, cz)
  const modern = isModern(root)
  const dv = dataVersionOf(root)
  const sections = Array.isArray(root.value.sections) ? root.value.sections : []
  if (!sections.length) return { ok: true, replaced: 0, note: '区块没有 sections' }

  let replaced = 0
  let touched = 0
  for (const sec of sections) {
    const s = sectionIndices(sec, modern, dv)
    if (!s) continue
    const fromIdx = s.palette.findIndex((p) => paletteName(p) === from)
    if (fromIdx < 0) continue
    const toIdx = s.palette.findIndex((p) => paletteName(p) === to)

    let palette = s.palette
    let indices = s.indices
    if (toIdx >= 0) {
      // 目标已在调色板：改索引指向（含 from==to 的退化情况）
      if (fromIdx === toIdx) continue
      for (let i = 0; i < indices.length; i++) if (indices[i] === fromIdx) { indices[i] = toIdx; replaced++ }
    } else {
      // 目标不在调色板：追加条目（目标方块用默认属性），索引改指新条目
      const newIdx = palette.length
      palette = palette.concat([{ Name: to }])
      for (let i = 0; i < indices.length; i++) if (indices[i] === fromIdx) { indices[i] = newIdx; replaced++ }
    }
    writeSectionBack(sec, modern, palette, indices)
    touched++
  }

  if (!touched) return { ok: true, replaced: 0, note: '区块中没有需要替换的方块' }
  if (!replaced) return { ok: true, replaced: 0, note: '没有匹配的方块' }

  writeChunkBack(file, cx, cz, root)
  return { ok: true, replaced, touched }
}

// ---------------- 世界坐标 → 区块/区域文件 ----------------

export function worldToChunk(X, Z) {
  const cx = Math.floor(X / 16)
  const cz = Math.floor(Z / 16)
  const rx = Math.floor(cx / 32)
  const rz = Math.floor(cz / 32)
  return { rx, rz, fileName: `r.${rx}.${rz}.mca`, cx, cz, lx: X - cx * 16, lz: Z - cz * 16 }
}

function findSection(root, modern, sy) {
  const sections = Array.isArray(root.value.sections) ? root.value.sections : []
  return sections.find((s) => numOf(s.Y) === sy) || null
}

// 查询世界坐标处的方块
export function getBlockAt(worldPath, X, Y, Z) {
  const p = worldToChunk(X, Z)
  const file = resolveRegionFile(worldPath, p.fileName)
  const root = readChunkNbt(file, p.cx, p.cz)
  const modern = isModern(root)
  const sy = Math.floor(Y / 16)
  const sec = findSection(root, modern, sy)
  const out = { x: X, y: Y, z: Z, name: AIR, properties: null, region: p.fileName, chunk: [p.cx, p.cz] }
  if (!sec) return out
  const { palette, data } = sectionKey(sec, modern)
  if (!Array.isArray(palette) || !palette.length) return out
  const indices = decodeIndices(data, palette.length, dataVersionOf(root))
  const entry = palette[indices[(Y - sy * 16) * 256 + p.lz * 16 + p.lx]]
  if (entry) {
    out.name = paletteName(entry)
    if (entry.Properties && typeof entry.Properties === 'object') {
      out.properties = plainProps(entry.Properties)
    }
  }
  return out
}

// 设置单个方块（按坐标）
export function setBlockAt(worldPath, X, Y, Z, to) {
  const p = worldToChunk(X, Z)
  const file = resolveRegionFile(worldPath, p.fileName)
  const root = readChunkNbt(file, p.cx, p.cz)
  const modern = isModern(root)
  const dv = dataVersionOf(root)
  const sy = Math.floor(Y / 16)
  let sec = findSection(root, modern, sy)
  const backupPath = backupMca(file)

  if (!sec) {
    if (to === AIR) return { ok: true, from: AIR, replaced: 0, backup: backupPath, note: '目标位置所在 section 不存在，本来就是空气' }
    // 创建新 section：调色板 [air, to]，全部索引 0（air），仅目标位指向 to
    sec = { Y: new NbtNum(TAG.BYTE, sy), block_states: { palette: [{ Name: AIR }, { Name: to }] } }
    const sections = root.value.sections ||= []
    sections.push(sec)
    const modern2 = isModern(root)
    const indices = new Int32Array(4096)
    indices[(Y - sy * 16) * 256 + p.lz * 16 + p.lx] = 1
    writeSectionBack(sec, modern2, sec.block_states.palette, indices)
    writeChunkBack(file, p.cx, p.cz, root)
    return { ok: true, from: AIR, replaced: 1, backup: backupPath }
  }

  const { palette, data } = sectionKey(sec, modern)
  if (!Array.isArray(palette) || !palette.length) return { error: 'section 调色板异常' }
  const indices = decodeIndices(data, palette.length, dv)
  const pos = (Y - sy * 16) * 256 + p.lz * 16 + p.lx
  const from = paletteName(palette[indices[pos]] || { Name: AIR })
  if (from === to) return { ok: true, from, replaced: 0, note: '目标方块与当前相同', backup: backupPath }
  let toIdx = palette.findIndex((e) => paletteName(e) === to)
  if (toIdx < 0) { toIdx = palette.length; palette.push({ Name: to }) }
  indices[pos] = toIdx
  writeSectionBack(sec, modern, palette, indices)
  writeChunkBack(file, p.cx, p.cz, root)
  return { ok: true, from, replaced: 1, backup: backupPath }
}

// ---------------- 按坐标范围（长方体）替换 ----------------

// 计划：把世界坐标长方体拆成受影响的区块列表（只含区域文件已存在的）
export function planBox(worldPath, box) {
  const b = normBox(box)
  const items = []
  const regions = new Set()
  const cx1 = Math.floor(b.minX / 16), cx2 = Math.floor(b.maxX / 16)
  const cz1 = Math.floor(b.minZ / 16), cz2 = Math.floor(b.maxZ / 16)
  for (let cx = cx1; cx <= cx2; cx++) {
    for (let cz = cz1; cz <= cz2; cz++) {
      const rx = Math.floor(cx / 32), rz = Math.floor(cz / 32)
      const fileName = `r.${rx}.${rz}.mca`
      const file = path.join(worldPath, 'region', fileName)
      if (!fs.existsSync(file)) continue // 该区域还没生成地形，跳过
      regions.add(fileName)
      items.push({ file: fileName, cx, cz })
    }
  }
  return { box: b, items, regions: [...regions], totalChunks: items.length }
}

function normBox(box) {
  const i = (v) => Math.trunc(Number(v))
  const raw = box && typeof box === 'object' ? box : {}
  // planBox 返回的是 {minX..maxZ}，前端会把它原样传回来；这里两种形状都接受。
  const ranged = ['minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ'].some((key) => raw[key] !== undefined)
  const x1 = i(ranged ? raw.minX : raw.x1)
  const x2 = i(ranged ? raw.maxX : raw.x2)
  const y1 = i(ranged ? raw.minY : raw.y1)
  const y2 = i(ranged ? raw.maxY : raw.y2)
  const z1 = i(ranged ? raw.minZ : raw.z1)
  const z2 = i(ranged ? raw.maxZ : raw.z2)
  if ([x1, x2, y1, y2, z1, z2].some((v) => !Number.isFinite(v))) throw new Error('坐标必须是数字')
  if (y1 < -2032 || y2 > 2031) throw new Error('Y 超出范围（-2032 ~ 2031）')
  return {
    minX: Math.min(x1, x2), maxX: Math.max(x1, x2),
    minY: Math.max(-2032, Math.min(y1, y2)), maxY: Math.max(-2032, Math.max(y1, y2)),
    minZ: Math.min(z1, z2), maxZ: Math.max(z1, z2)
  }
}

// 在单个区块内应用长方体替换（box 为世界坐标；from 为空 = 匹配所有方块，等效 /fill）
export function replaceBoxInChunk(worldPath, fileName, cx, cz, box, from, to, { backup = true } = {}) {
  const file = resolveRegionFile(worldPath, fileName)
  const b = normBox(box)
  // 区块世界范围
  const bx1 = cx * 16, bz1 = cz * 16
  const ox1 = Math.max(b.minX, bx1), ox2 = Math.min(b.maxX, bx1 + 15)
  const oz1 = Math.max(b.minZ, bz1), oz2 = Math.min(b.maxZ, bz1 + 15)
  if (ox1 > ox2 || oz1 > oz2) return { ok: true, replaced: 0, note: '范围与该区块不相交' }

  if (backup) backupMca(file)
  const root = readChunkNbt(file, cx, cz)
  const modern = isModern(root)
  const dv = dataVersionOf(root)
  const sections = Array.isArray(root.value.sections) ? root.value.sections : []
  const matchAll = !from || from === '*'
  const fromN = matchAll ? '' : String(from).trim()
  let replaced = 0

  const sy1 = Math.floor(b.minY / 16), sy2 = Math.floor(b.maxY / 16)
  for (const sec of sections) {
    const secY = numOf(sec.Y)
    if (secY < sy1 || secY > sy2) continue
    const { palette, data } = sectionKey(sec, modern)
    if (!Array.isArray(palette) || !palette.length) continue
    const indices = decodeIndices(data, palette.length, dv)
    const names = palette.map(paletteName)
    const toIdx0 = names.indexOf(to)

    let changed = false
    const ly1 = Math.max(0, b.minY - secY * 16), ly2 = Math.min(15, b.maxY - secY * 16)
    for (let y = ly1; y <= ly2; y++) {
      for (let z = oz1 - bz1; z <= oz2 - bz1; z++) {
        for (let x = ox1 - bx1; x <= ox2 - bx1; x++) {
          const pos = y * 256 + z * 16 + x
          const name = names[indices[pos]] || AIR
          if (!matchAll && name !== fromN) continue
          if (name === to) continue
          let tIdx = toIdx0
          if (tIdx < 0) {
            tIdx = palette.length
            palette.push({ Name: to })
            names.push(to)
          }
          indices[pos] = tIdx
          replaced++
          changed = true
        }
      }
    }
    if (changed) writeSectionBack(sec, modern, palette, indices)
  }

  if (replaced) writeChunkBack(file, cx, cz, root)
  return { ok: true, replaced }
}

function backupMca(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23) + '-' + Math.random().toString(36).slice(2, 6)
  const target = file + '.bak-' + stamp
  fs.copyFileSync(file, target)
  // 每个区域文件保留最近 10 份
  try {
    const old = fs.readdirSync(path.dirname(file))
      .filter((n) => n.startsWith(path.basename(file) + '.bak-'))
      .sort().reverse().slice(10)
    for (const n of old) fs.rmSync(path.join(path.dirname(file), n), { force: true })
  } catch {}
  return target
}

function writeChunkBack(file, cx, cz, root) {
  const payload = nbtWrite(root, { gzip: false }) // 区块数据 = zlib 流
  const comp = zlib.deflateSync(payload)
  const body = Buffer.alloc(5 + comp.length)
  body.writeUInt32BE(comp.length + 1, 0)
  body.writeUInt8(2, 4) // 压缩类型 2 = zlib
  comp.copy(body, 5)

  const needSectors = Math.ceil(body.length / SECTOR)
  const buf = fs.readFileSync(file)

  const { offset, count } = locAt(buf, regionIndex(cx, cz))
  if (offset === 0 || count === 0) throw new Error('区块不存在，无法写回')

  if (needSectors > count) {
    // 原位置放不下：追加到文件末尾（旧扇区成为空洞，无害）
    const writeAt = Math.ceil(buf.length / SECTOR)
    const grown = Buffer.alloc((writeAt + needSectors) * SECTOR)
    buf.copy(grown, 0)
    body.copy(grown, writeAt * SECTOR)
    grown.writeUInt32BE((writeAt << 8) | needSectors, (cz * 32 + cx) * 4)
    grown.writeUInt32BE(Math.floor(Date.now() / 1000), SECTOR + (cz * 32 + cx) * 4)
    fs.writeFileSync(file, grown)
  } else {
    body.copy(buf, offset * SECTOR)
    if (needSectors < count) buf.fill(0, offset * SECTOR + body.length, offset * SECTOR + count * SECTOR)
    buf.writeUInt32BE((offset << 8) | needSectors, (cz * 32 + cx) * 4)
    buf.writeUInt32BE(Math.floor(Date.now() / 1000), SECTOR + (cz * 32 + cx) * 4)
    fs.writeFileSync(file, buf)
  }
}

// 区域文件级备份（批量替换前调用一次即可）
export function backupRegion(worldPath, fileName) {
  const file = resolveRegionFile(worldPath, fileName)
  return backupMca(file)
}
