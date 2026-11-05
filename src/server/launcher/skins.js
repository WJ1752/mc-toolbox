import crypto from 'node:crypto'
import { store } from '../store.js'
import { applyAccountSkin } from './accounts.js'

const KEY = 'launcherSkins'
const library = () => store.get(KEY, [])
const prefix = 'data:image/png;base64,'

export function readSkinPng(data) {
  if (typeof data !== 'string' || !data.startsWith(prefix) || data.length > 128 * 1024) {
    throw new Error('请选择 64×64 或 64×32 的 PNG 皮肤')
  }
  const png = Buffer.from(data.slice(prefix.length), 'base64')
  if (png.length < 45 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR' ||
      png.readUInt32BE(16) !== 64 || ![32, 64].includes(png.readUInt32BE(20)) ||
      png.toString('ascii', png.length - 8, png.length - 4) !== 'IEND') {
    throw new Error('皮肤必须是 64×64 或 64×32 的 PNG')
  }
  return png
}

export function registerSkinApi(on, readBody) {
  on('GET', '/api/launcher/skins', () => ({ items: library() }))
  on('POST', '/api/launcher/skins', async req => {
    const { name, data, model } = await readBody(req)
    const png = readSkinPng(data)
    const variant = model === 'slim' && png.readUInt32BE(20) === 64 ? 'slim' : 'classic'
    const id = crypto.createHash('sha256').update(png).update(variant).digest('hex')
    const item = { id, name: String(name || '自定义皮肤').trim().slice(0, 80), model: variant, data: prefix + png.toString('base64') }
    const items = library().filter(skin => skin.id !== id)
    if (items.length >= 128) throw new Error('衣柜已满，请先移除一款皮肤')
    store.set(KEY, [...items, item])
    return { item }
  })
  on('DELETE', '/api/launcher/skins/:id', (_req, { id }) => {
    store.set(KEY, library().filter(skin => skin.id !== id))
    return { ok: true }
  })
  on('POST', '/api/launcher/accounts/:id/skin', async (req, { id }) => {
    const { skinId } = await readBody(req)
    const skin = library().find(item => item.id === skinId)
    if (!skin) throw new Error('请选择衣柜中的皮肤')
    return applyAccountSkin(id, skin, readSkinPng(skin.data))
  })
}
