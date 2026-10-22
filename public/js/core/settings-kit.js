// 设置页通用控件：整页设置（工具箱）与启动器设置共用同一套外观与行为。
// 这里只负责“长什么样、什么时候提交”，具体数据由调用方的 get/set + commit 决定。
import { h } from './dom.js'
import { btn, input, seg, toggle } from '../ui/kit.js'
import { pickDir, pickFile } from './dirpicker.js'

/**
 * @param {{commit:Function, pickDir?:Function, pickFile?:Function}} options
 * @returns {{row:Function, card:Function, panel:Function, actionRow:Function,
 *            numField:Function, textField:Function, monoField:Function,
 *            pathField:Function, segField:Function, switchField:Function}}
 */
export function createSettingsKit({ commit, pickDir: pickDirFn = pickDir, pickFile: pickFileFn = pickFile } = {}) {
  const save = typeof commit === 'function' ? commit : () => {}

  function row(label, desc, control, extraClass = '') {
    return h('div', { class: 'setting-row' + (extraClass ? ' ' + extraClass : '') },
      h('div', { class: 'info' }, h('b', {}, label), desc ? h('span', {}, desc) : null),
      h('div', { class: 'ctrl' }, control)
    )
  }

  function card(title, desc, ...children) {
    return h('section', { class: 'settings-card' },
      h('div', { class: 'settings-card-head' },
        h('h3', {}, title),
        desc ? h('span', { class: 'muted' }, desc) : null
      ),
      h('div', { class: 'settings-card-body' }, ...children.filter(Boolean))
    )
  }

  function numField(get, set, { min = 0, max = 999999, step = 1, suffix = '', width = '' } = {}) {
    const inp = input({ type: 'number', value: get(), min, max, step, class: width })
    const apply = () => {
      let v = Number(inp.value)
      if (!Number.isFinite(v)) v = get()
      v = Math.min(max, Math.max(min, v))
      inp.value = String(v)
      set(v)
      save()
    }
    inp.addEventListener('change', apply)
    inp.addEventListener('blur', apply)
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply() } })
    return suffix
      ? h('div', { class: 'input-group', style: { width: '150px' } }, inp, h('span', { class: 'unit' }, suffix))
      : inp
  }

  function textField(get, set, placeholder = '', width = '') {
    const inp = input({ value: get() || '', placeholder, class: width })
    inp.addEventListener('change', () => { set(inp.value.trim()); save() })
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); set(inp.value.trim()); save(); inp.blur() } })
    return inp
  }

  function monoField(get, set, placeholder = '', width = '') {
    const inp = input({ value: get() || '', placeholder, mono: true, class: width })
    inp.addEventListener('change', () => { set(inp.value.trim()); save() })
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); set(inp.value.trim()); save(); inp.blur() } })
    return inp
  }

  function textareaField(get, set, { rows = 2, placeholder = '', mono = true } = {}) {
    const node = h('textarea', {
      class: 'input' + (mono ? ' mono' : ''),
      rows: String(rows),
      placeholder,
      spellcheck: 'false'
    })
    node.value = get() || ''
    node.addEventListener('change', () => { set(node.value); save() })
    return node
  }

  function pathField(get, set, placeholder = '', { fileMode = false, exts = [], title = '选择目录' } = {}) {
    const inp = input({ value: get() || '', placeholder, mono: true })
    const apply = () => { set(inp.value.trim()); save() }
    inp.addEventListener('change', apply)
    const browse = btn('浏览', {
      size: 'sm',
      onClick: async () => {
        const picked = fileMode
          ? await pickFileFn(inp.value || '', { title, exts })
          : await pickDirFn(inp.value || '', { title })
        if (picked) {
          inp.value = picked
          apply()
        }
      }
    })
    return h('div', { class: 'row', style: { gap: '5px', flexWrap: 'wrap' } }, inp, browse)
  }

  function segField(get, set, options, onChange) {
    return seg(options, get(), (v) => {
      set(v)
      save()
      onChange?.(v)
    })
  }

  function switchField(get, set, onChange) {
    return toggle(!!get(), (v) => {
      set(v)
      save()
      onChange?.(v)
    })
  }

  function panel(title, desc, ...children) {
    return h('div', { class: 'settings-panel' },
      h('div', { class: 'settings-title' }, h('h2', {}, title)),
      desc ? h('p', { class: 'settings-desc' }, desc) : null,
      ...children
    )
  }

  function actionRow(...nodes) {
    return h('div', { class: 'settings-actions' }, ...nodes)
  }

  return { row, card, panel, actionRow, numField, textField, monoField, textareaField, pathField, segField, switchField }
}
