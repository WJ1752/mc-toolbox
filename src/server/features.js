import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { FEATURES_DIR } from './paths.js'
import { store } from './store.js'

// 磁贴功能注册表：扫描 public/features/<id>/manifest.json
// 新增功能 = 新建一个目录（manifest.json + tile.js），无需改动任何已有代码
export async function scanFeatures() {
  const settings = store.get('settings', null)
  const overrides = (settings && settings.features) || {}
  if (!fs.existsSync(FEATURES_DIR)) return []

  const dirs = await fsp.readdir(FEATURES_DIR, { withFileTypes: true })
  const list = []
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dir = path.join(FEATURES_DIR, d.name)
    const manifestPath = path.join(dir, 'manifest.json')
    if (!fs.existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
      const id = manifest.id || d.name
      const ov = overrides[id] || {}
      list.push({
        id,
        name: manifest.name || id,
        desc: manifest.desc || '',
        icon: manifest.icon || '🧩',
        color: manifest.color || '#5ec96a',
        version: manifest.version || '1.0.0',
        author: manifest.author || '',
        size: manifest.size || { w: 1, h: 1 },
        sizes: manifest.sizes || null,
        builtin: manifest.builtin !== false,
        entry: manifest.entry || 'tile.js',
        enabled: ov.enabled !== undefined ? ov.enabled : manifest.enabled !== false,
        visible: ov.visible !== undefined ? ov.visible : true,
        dir: d.name
      })
    } catch (e) {
      console.warn('[features] 解析 manifest 失败', d.name, e.message)
    }
  }
  return list
}

export async function removeFeature(id) {
  const all = await scanFeatures()
  const f = all.find((x) => x.id === id)
  if (!f) return { ok: false, error: '功能不存在' }
  if (f.builtin) return { ok: false, error: '内置功能不可删除，可隐藏或禁用' }
  const target = path.join(FEATURES_DIR, f.dir)
  const trash = path.join(FEATURES_DIR, '..', 'features_disabled')
  await fsp.mkdir(trash, { recursive: true })
  const dest = path.join(trash, f.dir + '-' + Date.now())
  await fsp.rename(target, dest)
  return { ok: true, movedTo: dest }
}
