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
  const { offset, count } = locAt(headerBuf, cz * 32 + cx)
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

// ---------------- 写回区域文件（含 .mca 备份） ----------------

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

  const { offset, count } = locAt(buf, cz * 32 + cx)
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
