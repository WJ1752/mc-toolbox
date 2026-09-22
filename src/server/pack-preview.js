import fs from 'node:fs/promises'
import path from 'node:path'
import { inflateRaw } from 'node:zlib'
import { promisify } from 'node:util'
import { readPackMetadata, recommendPackMemory } from '../../public/js/core/pack-preview.js'
import { detectPackRuntime, detectRuntimeRecords } from './pack-runtime.js'

const inflate = promisify(inflateRaw)
export async function inspectMetadata(records, summary = records?.summary) {
  if (!Array.isArray(records) || records.length > 2000) throw new Error('版本信息无效或过多')
  let total = 0, compressed = 0
  const decoded = []
  for (const r of records) {
    if (typeof r.name !== 'string' || r.name.length > 4096 || typeof r.data !== 'string' || !Number.isInteger(r.size) || r.size < 0 || r.size > 2 * 1024 ** 2) throw new Error('版本清单无效')
    total += r.size; compressed += r.data.length
    if (total > 16 * 1024 ** 2 || compressed > 12 * 1024 ** 2) throw new Error('版本清单过大')
    const data = Buffer.from(r.data, 'base64')
    const out = r.method === 0 ? data : r.method === 8 ? await inflate(data, { maxOutputLength: Math.max(1, r.size) }) : null
    if (!out || out.length !== r.size) throw new Error('版本清单解压校验失败')
    decoded.push({ name: r.name, text: out.toString('utf8') })
  }
  const runtime = detectRuntimeRecords(decoded)
  return runtime ? { ...runtime, modCount: Number(summary?.modCount) || 0, recommendedMemory: recommendPackMemory(summary) } : null
}

export async function inspectPack(source) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('请选择整合包或目录')
  const stat = await fs.stat(source)
  if (stat.isDirectory()) {
    const summary = { modCount: 0, modBytes: 0 }
    async function count(dir, depth, inMods = false) {
      if (depth > 10) return
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory() && !/^(assets|saves|world|logs|libraries|runtime|resourcepacks|config)$/i.test(entry.name)) await count(full, depth + 1, inMods || entry.name.toLowerCase() === 'mods')
        else if (inMods && entry.isFile() && /\.jar$/i.test(entry.name)) { summary.modCount++; summary.modBytes += (await fs.stat(full)).size }
      }
    }
    const runtime = await detectPackRuntime(source)
    await count(source, 0)
    return runtime ? { ...runtime, modCount: summary.modCount, recommendedMemory: recommendPackMemory(summary) } : null
  }
  if (!stat.isFile()) throw new Error('请选择普通文件或目录')
  const file = await fs.open(source, 'r')
  try {
    const records = await readPackMetadata(stat.size, async (offset, length) => {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await file.read(buffer, 0, length, offset)
      return buffer.subarray(0, bytesRead)
    })
    return await inspectMetadata(records)
  } finally { await file.close() }
}
