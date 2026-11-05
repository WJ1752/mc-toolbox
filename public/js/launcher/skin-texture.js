import { h } from '../core/dom.js'

// 老账户可能未保存模型。仅在两条手臂的窄臂留白均明确透明时才推断为 slim；
// 64×32 或无法确认的纹理沿用经典宽臂，显式选择的模型始终优先。
export function detectSkinModel(image) {
  if (image.width !== 64 || image.height !== 64) return 'classic'
  const canvas = h('canvas', { width: 64, height: 64 })
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, 64, 64).data
  const region = (left, top, right, bottom, transparent) => {
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        if ((pixels[(y * 64 + x) * 4 + 3] === 0) !== transparent) return false
      }
    }
    return true
  }
  const gaps = [[50,16,52,20], [54,20,56,32], [42,48,44,52], [46,52,48,64]]
  return gaps.every(area => region(...area, true))
    && region(44,20,47,32,false) && region(36,52,39,64,false) ? 'slim' : 'classic'
}

// 与游戏一致：基础皮肤层不使用透明度，透明像素只属于帽子、外套等外层。
// 旧式 64×32 皮肤的帽子区域若完全不透明，则视为空白外层。
export function normalizeSkin(image) {
  const canvas = h('canvas', { width: 64, height: image.height })
  const context = canvas.getContext('2d')
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, 64, image.height)
  const alpha = (x, y) => (y * 64 + x) * 4 + 3
  const opaque = (left, top, right, bottom) => {
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) pixels.data[alpha(x, y)] = 255
    }
  }
  if (image.height === 32) {
    let emptyHat = true
    for (let y = 0; y < 32 && emptyHat; y++) {
      for (let x = 32; x < 64; x++) {
        if (pixels.data[alpha(x, y)] < 128) { emptyHat = false; break }
      }
    }
    if (emptyHat) {
      for (let y = 0; y < 32; y++) {
        for (let x = 32; x < 64; x++) pixels.data[alpha(x, y)] = 0
      }
    }
  }
  opaque(0, 0, 32, 16)
  opaque(0, 16, 64, 32)
  if (image.height === 64) opaque(16, 48, 48, 64)
  context.putImageData(pixels, 0, 0)
  return canvas
}
