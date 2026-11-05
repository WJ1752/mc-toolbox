import { h, clear } from '../core/dom.js'
import { api } from '../core/api.js'
import { btn } from '../ui/kit.js'
import { drawSkin, sampleSkin, skinPreview } from './skin-model.js'

export async function openSkins({ account, openModal, onApplied, toast }) {
  const base = '/api/launcher/skins'
  let items
  try { items = (await api.get(base)).items } catch (e) { toast(e.message, 'err'); return }
  const { scene, model } = skinPreview()
  let texture = sampleSkin(), selected = null, pending = null, epoch = 0, busy = false
  const list = h('select', { class: 'input', 'aria-label': '选择皮肤' })
  const variant = h('select', { class: 'input', 'aria-label': '手臂模型' },
    h('option', { value: 'classic' }, '经典宽臂'), h('option', { value: 'slim' }, '纤细手臂'))
  const status = h('div', { class: 'lp-hint', role: 'status' })
  const fileInput = h('input', { type: 'file', accept: 'image/png', hidden: true })
  const choose = btn('导入 PNG', { onClick: () => fileInput.click() })
  const save = btn('保存到衣柜', { onClick: () => run(async () => {
    const { item } = await api.post(base, { ...pending, model: variant.value })
    items = [...items.filter(entry => entry.id !== item.id), item]
    populate(item.id)
    await select()
  }) })
  const remove = btn('移出衣柜', { onClick: () => run(async () => {
    await api.del(base + '/' + selected.id)
    items = items.filter(item => item.id !== selected.id)
    populate('')
    await select()
  }) })
  const apply = btn(account?.type === 'offline' ? '设为启动器外观' : '应用到 Minecraft 账户', { variant: 'primary',
    onClick: () => run(async () => {
      const result = await api.post('/api/launcher/accounts/' + encodeURIComponent(account.id) + '/skin', { skinId: selected.id })
      account = result.items.find(entry => entry.id === account.id)
      onApplied(result)
      toast('已应用皮肤', 'ok')
    }) })
  function controls() {
    save.hidden = !pending
    remove.hidden = !selected
    apply.hidden = !account || account.type === 'authlib'
    apply.disabled = busy || !selected
    choose.disabled = list.disabled = save.disabled = remove.disabled = busy
    variant.disabled = busy || !pending || texture.height === 32
  }
  async function run(fn) {
    if (busy) return
    busy = true; controls()
    try { await fn() } catch (e) { status.textContent = e.message }
    finally { busy = false; controls() }
  }
  function populate(id) {
    clear(list).append(h('option', { value: '' }, account?.skin ? '当前角色皮肤' : '示例角色'),
      ...items.map(item => h('option', { value: item.id }, item.name + (item.model === 'slim' ? ' · 纤细' : ' · 经典'))))
    list.value = id
  }
  async function select() {
    const token = ++epoch
    selected = items.find(item => item.id === list.value)
    pending = null
    variant.value = selected?.model || account?.model || 'classic'
    texture = sampleSkin()
    drawSkin(model, texture, false)
    status.textContent = ''
    const source = selected?.data || account?.skin
    controls()
    if (!source) return
    try {
      const img = new Image()
      img.src = source
      await img.decode()
      if (token !== epoch) return
      if (img.width !== 64 || ![32,64].includes(img.height)) throw new Error()
      texture = img
      drawSkin(model, texture, variant.value === 'slim')
    } catch { if (token === epoch) status.textContent = '当前纹理无法预览，可导入 64×64 或 64×32 PNG。' }
  }
  list.onchange = select
  variant.onchange = () => drawSkin(model, texture, variant.value === 'slim')
  fileInput.onchange = () => run(async () => {
    const file = fileInput.files[0]
    if (!file) return
    fileInput.value = ''
    if (file.size > 2 * 1024 ** 2) throw new Error('请选择小于 2 MiB 的皮肤 PNG')
    const sig = new Uint8Array(await file.slice(0, 8).arrayBuffer())
    if (sig.join(',') !== '137,80,78,71,13,10,26,10') throw new Error('请选择 PNG 文件')
    const img = new Image()
    const url = URL.createObjectURL(file)
    try {
      img.src = url
      await img.decode()
      if (img.width !== 64 || ![32,64].includes(img.height)) throw new Error('皮肤尺寸应为 64×64 或 64×32')
      const canvas = h('canvas', { width: 64, height: img.height })
      canvas.getContext('2d').drawImage(img, 0, 0)
      ++epoch
      texture = canvas; selected = null
      pending = { name: file.name.replace(/\.png$/i, ''), data: canvas.toDataURL('image/png') }
      list.selectedIndex = -1
      variant.value = 'classic'
      drawSkin(model, canvas, false)
      status.textContent = file.name + ' · 请选择模型后保存'
    } finally { URL.revokeObjectURL(url) }
  })
  populate('')
  const details = h('div', { class: 'skin-controls' }, list, variant,
    h('div', { class: 'lp-row' }, choose, save, remove), fileInput, apply, status,
    account?.type === 'offline' ? h('small', {}, '离线账户的皮肤仅用于启动器头像和预览。') : null,
    account?.type === 'authlib' ? h('small', {}, '此角色由第三方皮肤站管理，可在此预览或收藏本地皮肤。') : null)
  openModal({ title: account ? account.name + ' · 皮肤管理' : '皮肤衣柜', size: 'md',
    body: h('div', { class: 'skin-wardrobe' }, h('div', {}, scene, h('small', {}, '拖动或使用方向键旋转角色')), details),
    buttons: [{ label: '完成' }], onClose: () => { epoch++ } })
  await select()
}
