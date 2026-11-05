import { h, clear } from '../core/dom.js'
import { normalizeSkin } from './skin-texture.js'

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
  image = normalizeSkin(image)
  const legacy = image.height === 32
  const arm = slim && !legacy ? 3 : 4
  const parts = [
    ['head',0,-12,8,8,8,0,0,32,0],
    ['body',0,-2,8,12,4,16,16,16,32],
    ['right-arm',-4-arm/2,-8,arm,12,4,40,16,40,32],
    ['left-arm',4+arm/2,-8,arm,12,4,legacy ? 40 : 32,legacy ? 16 : 48,48,48,legacy],
    ['right-leg',-2,4,4,12,4,0,16,0,32],
    ['left-leg',2,4,4,12,4,legacy ? 0 : 16,legacy ? 16 : 48,0,48,legacy]
  ]
  for (const [name,x,y,w,height,d,u,v,ou,ov,mirror] of parts) {
    const limb = /arm|leg/.test(name)
    const joint = h('div', { class: 'skin-part skin-' + name, style: { transform: `translate3d(${x * UNIT}px,${y * UNIT}px,0)` } })
    const shape = h('div', { class: 'skin-limb' })
    shape.append(box(image,{x:0,y:limb ? height/2 : 0,w,h:height,d,u,v,mirror}))
    if (!legacy || v === 0) shape.append(box(image,{x:0,y:limb ? height/2 : 0,w,h:height,d,u:ou,v:ov,outer:v === 0 ? 0.5 : 0.25}))
    joint.append(shape)
    model.append(joint)
  }
}

export function setSkinPose(model, pose) {
  model.dataset.pose = ['walking', 'running'].includes(pose) ? pose : 'standing'
}

export function skinPreview() {
  let yaw = -22, pitch = -8, drag = null
  const model = h('div', { class: 'skin-model', dataset: { pose: 'standing' } })
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
