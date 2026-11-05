import test from 'node:test'
import assert from 'node:assert/strict'
import { detectSkinModel, normalizeSkin } from '../public/js/launcher/skin-texture.js'

test('皮肤基础层补足透明度，外层保留透明度；旧式不透明帽子按游戏规则隐藏', () => {
  const previous = globalThis.document
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, 'canvas')
      let pixels
      return {
        setAttribute(key, value) { this[key] = Number(value) },
        getContext() {
          return {
            drawImage(image) { pixels = new Uint8ClampedArray(image.pixels) },
            getImageData() { return { data: pixels } },
            putImageData(image) { pixels = image.data }
          }
        },
        get pixels() { return pixels }
      }
    }
  }
  const texture = (height, opacity = 0) => {
    const pixels = new Uint8ClampedArray(64 * height * 4)
    for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 80; pixels[i + 3] = opacity }
    return { width: 64, height, pixels }
  }
  const at = (image, x, y) => image.pixels[(y * 64 + x) * 4 + 3]
  try {
    const modern = texture(64)
    modern.pixels[(8 * 64 + 40) * 4 + 3] = 127
    const normalized = normalizeSkin(modern)
    for (const [x, y] of [[8,8], [20,20], [44,20], [20,52], [36,52]]) assert.equal(at(normalized, x, y), 255)
    assert.equal(at(normalized, 40, 8), 127)
    assert.equal(at(normalized, 20, 36), 0)
    assert.equal(at(modern, 8, 8), 0, '不得改写原始导入纹理')
    const legacy = texture(32, 255)
    assert.equal(at(normalizeSkin(legacy), 40, 8), 0)
    assert.equal(at(normalizeSkin(legacy), 44, 20), 255)
    legacy.pixels[(8 * 64 + 40) * 4 + 3] = 0
    assert.equal(at(normalizeSkin(legacy), 41, 8), 255, '具有透明像素的有效帽子仍应显示')
    const slim = texture(64, 255)
    for (const [left, top, right, bottom] of [[50,16,52,20], [54,20,56,32], [42,48,44,52], [46,52,48,64]]) {
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) slim.pixels[(y * 64 + x) * 4 + 3] = 0
      }
    }
    assert.equal(detectSkinModel(slim), 'slim')
    assert.equal(detectSkinModel(texture(64, 255)), 'classic')
    assert.equal(detectSkinModel(texture(64)), 'classic', '完全透明纹理不足以推断窄臂')
    assert.equal(detectSkinModel(legacy), 'classic')
    slim.pixels[(16 * 64 + 50) * 4 + 3] = 255
    assert.equal(detectSkinModel(slim), 'classic', '窄臂留白不完整时不覆盖宽臂默认值')
  } finally { globalThis.document = previous }
})
