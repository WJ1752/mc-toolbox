import { h, clear } from '../core/dom.js'

const UNIT = 6
// Minecraft UV 展开顺序：右、前、左、后，上下两面位于其上方。
function box(image, { x, y, w, h: height, d, u, v, outer = 0, mirror = false }) {
  const node = h('div', { class: 'skin-box', style: { transform: `translate3d(${x * UNIT}px,${y * UNIT}px,0) scaleX(${mirror ? -1 : 1})` } })
  const dx = (w / 2 + outer) * UNIT, dy = (height / 2 + outer) * UNIT, dz = (d / 2 + outer) * UNIT
  const faces = [
    [u + d, v + d, w, height, 'rotateY(0deg)', dz],
    [u + 2*d + w, v + d, w, height, 'rotateY(180deg)', dz],
    [u, v + d, d, height, 'rotateY(-90deg)', dx],
    [u + d + w, v + d, d, height, 'rotateY(90deg)', dx],
    [u + d, v, w, d, 'rotateX(90deg)', dy],
    [u + d + w, v, w, d, 'rotateX(-90deg)', dy]
  ]
  for (const [sx, sy, sw, sh, rotate, depth] of faces) {
    const width = (sw + 2*outer) * UNIT, faceHeight = (sh + 2*outer) * UNIT
    const canvas = h('canvas', { width: sw, height: sh, style: {
      width: width + 'px', height: faceHeight + 'px', left: -width / 2 + 'px', top: -faceHeight / 2 + 'px',
      transform: rotate + ' translateZ(' + depth + 'px)'
    } })
    canvas.getContext('2d').drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh)
    node.appendChild(canvas)
  }
  return node
}

export function drawSkin(model, image, slim) {
  clear(model)
  const legacy = image.height === 32
  const arm = slim && !legacy ? 3 : 4
  const parts = [
    [0,-12,8,8,8,0,0,32,0],
    [0,-2,8,12,4,16,16,16,32],
    [-4-arm/2,-2,arm,12,4,40,16,40,32],
    [4+arm/2,-2,arm,12,4,legacy ? 40 : 32,legacy ? 16 : 48,48,48,legacy],
    [-2,10,4,12,4,0,16,0,32],
    [2,10,4,12,4,legacy ? 0 : 16,legacy ? 16 : 48,0,48,legacy]
  ]
  for (const [x,y,w,height,d,u,v,ou,ov,mirror] of parts) {
    model.append(box(image,{x,y,w,h:height,d,u,v,mirror}))
    if (!legacy || v === 0) model.append(box(image,{x,y,w,h:height,d,u:ou,v:ov,outer:v === 0 ? 0.5 : 0.25}))
  }
}

export function skinPreview() {
  let yaw = -22, pitch = -8, drag = null
  const model = h('div', { class: 'skin-model' })
  const scene = h('div', { class: 'skin-scene', tabindex: '0', role: 'group', 'aria-label': '3D 角色预览，拖动或按方向键旋转' }, model)
  const rotate = () => { model.style.transform = `rotateX(${pitch}deg) rotateY(${yaw}deg)` }
  rotate()
  scene.onpointerdown = event => {
    drag = [event.clientX,event.clientY]
    scene.setPointerCapture(event.pointerId)
  }
  scene.onpointermove = event => {
    if (!drag) return
    yaw += (event.clientX - drag[0]) * 0.8
    pitch = Math.max(-80,Math.min(80,pitch - (event.clientY - drag[1]) * 0.6))
    drag = [event.clientX,event.clientY]
    rotate()
  }
  scene.onlostpointercapture = () => { drag = null }
  scene.onkeydown = event => {
    if (!['ArrowRight','ArrowLeft','ArrowUp','ArrowDown'].includes(event.key)) return
    event.preventDefault()
    yaw += event.key === 'ArrowRight' ? 15 : event.key === 'ArrowLeft' ? -15 : 0
    pitch = Math.max(-80, Math.min(80, pitch + (event.key === 'ArrowUp' ? 10 : event.key === 'ArrowDown' ? -10 : 0)))
    rotate()
  }
  return { scene, model }
}

// 无账户纹理时显示一个可旋转的示例角色。
export function sampleSkin() {
  const canvas = h('canvas', { width: 64, height: 64 })
  const c = canvas.getContext('2d')
  const fill = (color,x,y,w,h) => { c.fillStyle = color; c.fillRect(x,y,w,h) }
  fill('#b77850',0,0,32,16)
  fill('#553d31',0,0,32,10)
  fill('#553d31',24,8,8,8)
  fill('#322e34',9,11,2,1)
  fill('#322e34',13,11,2,1)
  fill('#8f5848',11,14,3,1)
  fill('#2f9193',16,16,24,16)
  for (const [x,y] of [[40,16],[32,48]]) {
    fill('#b77850',x,y,16,16)
    fill('#2f9193',x,y,16,8)
  }
  for (const [x,y] of [[0,16],[16,48]]) {
    fill('#42567d',x,y,16,16)
    fill('#333a47',x,y+14,16,2)
  }
  return canvas
}
