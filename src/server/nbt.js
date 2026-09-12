// NBT (Named Binary Tag) 读写 —— 零依赖纯 Node 实现
//
// 覆盖 Minecraft 存档用到的全部 13 种标签；容器支持 gzip（level.dat / playerdata）
// 与 zlib（region 内 chunk，保留能力）及裸字节流。
//
// 值的 JS 表示（写回时据此还原精确类型，往返零损失）：
//   TAG_Byte/Short/Int/Float/Double → NbtNum 包装类（保留原始标签类型）
//   TAG_Long                        → BigInt
//   TAG_Byte_Array                  → Uint8Array
//   TAG_Int_Array                   → Int32Array
//   TAG_Long_Array                  → BigInt64Array
//   TAG_String                      → string（Java 修改版 UTF-8 / CESU-8 编解码）
//   TAG_List                        → 普通数组（元素类型写入时按首元素推断）
//   TAG_Compound                    → 普通对象
import zlib from 'node:zlib'

export const TAG = {
  END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6,
  BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12
}

// 带类型的小数值包装：读入保留原始标签类型，改值时沿用，避免 byte/short/int/float/double 混淆
export class NbtNum {
  constructor(tagType, value) {
    this.tagType = tagType
    this.value = Number(value)
  }
}

// 便捷构造器：int(3) / long 直接传 BigInt / float(5) / double(6) / byte(1)
export const num = {
  byte: (v) => new NbtNum(TAG.BYTE, v),
  short: (v) => new NbtNum(TAG.SHORT, v),
  int: (v) => new NbtNum(TAG.INT, v),
  float: (v) => new NbtNum(TAG.FLOAT, v),
  double: (v) => new NbtNum(TAG.DOUBLE, v)
}

// ---------------- Java 修改版 UTF-8（CESU-8）----------------
// 与标准 UTF-8 的差异：NUL 编码为 C0 80；补充平面字符按 UTF-16 代理对拆成两个 3 字节序列。
// 世界名 / MOTD 里的 emoji 走的就是代理对编码，用标准 UTF-8 解码会得到 U+FFFD 乱码。

export function decodeCesu8(b) {
  let out = ''
  const n = b.length
  for (let i = 0; i < n;) {
    const c = b[i]
    if (c < 0x80) { out += String.fromCharCode(c); i += 1 }
    else if ((c & 0xE0) === 0xC0 && i + 1 < n) { out += String.fromCharCode(((c & 0x1F) << 6) | (b[i + 1] & 0x3F)); i += 2 }
    else if ((c & 0xF0) === 0xE0 && i + 2 < n) {
      out += String.fromCharCode(((c & 0x0F) << 12) | ((b[i + 1] & 0x3F) << 6) | (b[i + 2] & 0x3F)); i += 3
    } else { out += '\ufffd'; i += 1 }
  }
  return out
}

export function encodeCesu8(s) {
  const out = []
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0)
    if (cp === 0) { out.push(0xC0, 0x80) }                     // Java 修改版 UTF-8 的 NUL
    else if (cp <= 0x7F) out.push(cp)
    else if (cp <= 0x7FF) out.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F))
    else if (cp <= 0xFFFF) out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F))
    else {
      // 补充平面：拆成高低代理，各编为 3 字节（CESU-8）
      const v = cp - 0x10000
      const hi = 0xD800 + (v >> 10)
      const lo = 0xDC00 + (v & 0x3FF)
      out.push(0xE0 | (hi >> 12), 0x80 | ((hi >> 6) & 0x3F), 0x80 | (hi & 0x3F))
      out.push(0xE0 | (lo >> 12), 0x80 | ((lo >> 6) & 0x3F), 0x80 | (lo & 0x3F))
    }
  }
  return Buffer.from(out)
}

// ---------------- 读取 ----------------

class Reader {
  constructor(buf) { this.buf = buf; this.o = 0 }
  u8() { return this.buf[this.o++] }
  i8() { const v = this.buf.readInt8(this.o); this.o += 1; return v }
  i16() { const v = this.buf.readInt16BE(this.o); this.o += 2; return v }
  u16() { const v = this.buf.readUInt16BE(this.o); this.o += 2; return v }
  i32() { const v = this.buf.readInt32BE(this.o); this.o += 4; return v }
  i64() { const v = this.buf.readBigInt64BE(this.o); this.o += 8; return v }
  f32() { const v = this.buf.readFloatBE(this.o); this.o += 4; return v }
  f64() { const v = this.buf.readDoubleBE(this.o); this.o += 8; return v }
  bytes(n) {
    if (n < 0 || this.o + n > this.buf.length) throw new Error('NBT 数据越界（长度 ' + n + '）')
    const v = this.buf.subarray(this.o, this.o + n)
    this.o += n
    return v
  }
  str() { return decodeCesu8(this.bytes(this.u16())) }
}

function readPayload(r, type) {
  switch (type) {
    case TAG.BYTE: return new NbtNum(TAG.BYTE, r.i8())
    case TAG.SHORT: return new NbtNum(TAG.SHORT, r.i16())
    case TAG.INT: return new NbtNum(TAG.INT, r.i32())
    case TAG.LONG: return r.i64()
    case TAG.FLOAT: return new NbtNum(TAG.FLOAT, r.f32())
    case TAG.DOUBLE: return new NbtNum(TAG.DOUBLE, r.f64())
    case TAG.BYTE_ARRAY: return new Uint8Array(r.bytes(r.i32()))
    case TAG.STRING: return r.str()
    case TAG.LIST: {
      const et = r.u8()
      const n = r.i32()
      const arr = new Array(n)
      for (let i = 0; i < n; i++) arr[i] = readPayload(r, et)
      return arr
    }
    case TAG.COMPOUND: {
      const obj = {}
      for (;;) {
        const t = r.u8()
        if (t === TAG.END) break
        const name = r.str()
        obj[name] = readPayload(r, t)
      }
      return obj
    }
    case TAG.INT_ARRAY: {
      const n = r.i32()
      const a = new Int32Array(n)
      for (let i = 0; i < n; i++) a[i] = r.i32()
      return a
    }
    case TAG.LONG_ARRAY: {
      const n = r.i32()
      const a = new BigInt64Array(n)
      for (let i = 0; i < n; i++) a[i] = r.i64()
      return a
    }
    default: throw new Error('未知 NBT 标签类型 ' + type)
  }
}

// 解析 NBT 字节流（自动识别 gzip / zlib / 裸流），返回 { name, value }（根 Compound）
export function parse(buf) {
  let raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw)
  else if (raw.length > 1 && (raw[0] & 0x0f) === 8 && ((raw[0] << 8 | raw[1]) % 31) === 0) raw = zlib.inflateSync(raw)
  const r = new Reader(raw)
  const t = r.u8()
  if (t !== TAG.COMPOUND) throw new Error('NBT 根节点不是 Compound（type=' + t + '）')
  return { name: r.str(), value: readPayload(r, TAG.COMPOUND) }
}

// ---------------- 写入 ----------------

export function valueType(v) {
  if (v instanceof NbtNum) return v.tagType
  if (typeof v === 'bigint') return TAG.LONG
  if (typeof v === 'number') return TAG.INT
  if (typeof v === 'boolean') return TAG.BYTE
  if (typeof v === 'string') return TAG.STRING
  if (v instanceof Uint8Array) return TAG.BYTE_ARRAY
  if (v instanceof Int32Array) return TAG.INT_ARRAY
  if (v instanceof BigInt64Array) return TAG.LONG_ARRAY
  if (Array.isArray(v)) return TAG.LIST
  if (v && typeof v === 'object') return TAG.COMPOUND
  throw new Error('无法序列化的 NBT 值：' + typeof v)
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)))

function writePayload(type, v) {
  switch (type) {
    case TAG.BYTE: {
      const n = typeof v === 'boolean' ? (v ? 1 : 0) : Number(rawNum(v))
      return Buffer.from([clampInt(n, -128, 127) & 0xff])
    }
    case TAG.SHORT: {
      const b = Buffer.alloc(2)
      b.writeInt16BE(clampInt(rawNum(v), -32768, 32767))
      return b
    }
    case TAG.INT: {
      const b = Buffer.alloc(4)
      b.writeInt32BE(clampInt(rawNum(v), -2147483648, 2147483647))
      return b
    }
    case TAG.LONG: {
      const b = Buffer.alloc(8)
      b.writeBigInt64BE(typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v)) || 0))
      return b
    }
    case TAG.FLOAT: {
      const b = Buffer.alloc(4)
      b.writeFloatBE(Number(rawNum(v)))
      return b
    }
    case TAG.DOUBLE: {
      const b = Buffer.alloc(8)
      b.writeDoubleBE(Number(rawNum(v)))
      return b
    }
    case TAG.BYTE_ARRAY: {
      const u = v instanceof Uint8Array ? v : new Uint8Array(v || [])
      const head = Buffer.alloc(4)
      head.writeInt32BE(u.length)
      return Buffer.concat([head, Buffer.from(u.buffer, u.byteOffset, u.byteLength)])
    }
    case TAG.STRING: {
      const enc = encodeCesu8(String(v))
      const head = Buffer.alloc(2)
      head.writeUInt16BE(Math.min(65535, enc.length))
      return Buffer.concat([head, enc])
    }
    case TAG.LIST: {
      const arr = Array.isArray(v) ? v : []
      const et = arr.length ? valueType(arr[0]) : TAG.END
      const head = Buffer.alloc(5)
      head.writeUInt8(et, 0)
      head.writeInt32BE(arr.length, 1)
      const parts = arr.map((x) => writePayload(et, x))
      return Buffer.concat([head, ...parts])
    }
    case TAG.COMPOUND: {
      const parts = []
      for (const [k, val] of Object.entries(v || {})) {
        const t = valueType(val)
        const name = encodeCesu8(k)
        const nh = Buffer.alloc(3)
        nh.writeUInt8(t, 0)
        nh.writeUInt16BE(Math.min(65535, name.length), 1)
        parts.push(Buffer.concat([nh, name, writePayload(t, val)]))
      }
      parts.push(Buffer.from([TAG.END]))
      return Buffer.concat(parts)
    }
    case TAG.INT_ARRAY: {
      const arr = v instanceof Int32Array ? v : (Array.isArray(v) ? v : [])
      const head = Buffer.alloc(4)
      head.writeInt32BE(arr.length)
      const body = Buffer.alloc(arr.length * 4)
      for (let i = 0; i < arr.length; i++) body.writeInt32BE(arr[i], i * 4)
      return Buffer.concat([head, body])
    }
    case TAG.LONG_ARRAY: {
      const arr = v instanceof BigInt64Array ? v : (Array.isArray(v) ? v : [])
      const head = Buffer.alloc(4)
      head.writeInt32BE(arr.length)
      const body = Buffer.alloc(arr.length * 8)
      for (let i = 0; i < arr.length; i++) body.writeBigInt64BE(typeof arr[i] === 'bigint' ? arr[i] : BigInt(arr[i] || 0), i * 8)
      return Buffer.concat([head, body])
    }
    default: throw new Error('无法写入的 NBT 标签类型 ' + type)
  }
}

function rawNum(v) { return v instanceof NbtNum ? v.value : (typeof v === 'boolean' ? (v ? 1 : 0) : v) }

// 序列化根 Compound，{ gzip: true }（默认）输出 gzip 压缩（level.dat / playerdata 格式）
export function write(root, { gzip = true } = {}) {
  const name = encodeCesu8(root.name || '')
  const head = Buffer.alloc(3)
  head.writeUInt8(TAG.COMPOUND, 0)
  head.writeUInt16BE(Math.min(65535, name.length), 1)
  const buf = Buffer.concat([head, name, writePayload(TAG.COMPOUND, root.value)])
  return gzip ? zlib.gzipSync(buf) : buf
}
