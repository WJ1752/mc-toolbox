import { h, clear, debounce, escapeHtml } from './dom.js'
import { api } from './api.js'
import { openModal } from './modal.js'
import { toast } from './toast.js'

// Windows 风格路径拆段（盘符为第一段），POSIX 直接按 / 拆
function splitPath(p) {
  if (!p) return []
  const m = String(p).match(/^([A-Za-z]:)([\\\/].*)?$/)
  if (m) {
    const rest = (m[2] || '').split(/[\\/]/).filter(Boolean)
    return [m[1].toUpperCase(), ...rest]
  }
  return String(p).split(/[\\/]/).filter(Boolean)
}

// 从一段段路径片段拼回到完整路径（Windows 自动用 \\，POSIX 用 /）
function joinSegments(segs, isWin) {
  if (!segs.length) return ''
  if (isWin && /^[A-Z]:$/i.test(segs[0])) {
    let p = segs[0]
    for (let i = 1; i < segs.length; i++) p += '\\' + segs[i]
    return p.endsWith('\\') && segs.length > 1 ? p : (segs.length === 1 ? p + '\\' : p)
  }
  return '/' + segs.join('/')
}

/** 目录选择器（带面包屑、盘符切换、新建文件夹、过滤）。
 *  fileMode=true 时额外列出匹配 exts 的文件，单击选中、双击或「选择此文件」确认。 */
export function pickDir(current, { title = '选择目录', fileMode = false, exts = [] } = {}) {
  return new Promise((resolve) => {
    let path = current || ''
    let finished = false
    let roots = []      // {name, path, kind:'drive'}
    let specials = []   // {name, path, kind:'special', icon}
    let isWin = false
    let filter = ''
    let homePath = ''
    let curDirs = []
    let curFiles = []
    let selFile = null

    // --- 节点 ---
    const pathInput = h('input', {
      class: 'input mono',
      value: path,
      placeholder: '在此粘贴或编辑路径，回车跳转',
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          load(pathInput.value)
        }
      }
    })
    const breadcrumb = h('div', { class: 'dp-crumb' })
    const drivesBar = h('div', { class: 'dp-drives' })
    const specialsBar = h('div', { class: 'dp-specials' })
    const filterInput = h('input', {
      class: 'input',
      placeholder: fileMode ? '🔍 过滤脚本文件…' : '🔍 过滤文件夹…',
      oninput: (e) => { filter = e.target.value.toLowerCase(); renderList() }
    })
    const list = h('div', { class: 'dp-list' })
    const presetsRow = h('div', { class: 'dp-presets' })
    const status = h('div', { class: 'muted dp-status' })

    function renderBreadcrumb(p) {
      clear(breadcrumb)
      const segs = splitPath(p)
      if (!segs.length) {
        breadcrumb.appendChild(h('span', { class: 'muted' }, '（未选择）'))
        return
      }
      segs.forEach((seg, i) => {
        if (i > 0) breadcrumb.appendChild(h('span', { class: 'dp-sep' }, '›'))
        const segPath = joinSegments(segs.slice(0, i + 1), isWin)
        const last = i === segs.length - 1
        breadcrumb.appendChild(
          h('button', {
            class: 'dp-seg' + (last ? ' active' : ''),
            title: segPath,
            onclick: () => load(segPath)
          }, seg)
        )
      })
    }

    function renderDrives(currentPath) {
      clear(drivesBar)
      const segs = splitPath(currentPath)
      const currentDrive = isWin ? (segs[0] || '') : '/'
      const seen = new Set()
      for (const r of roots) {
        if (seen.has(r.path)) continue
        seen.add(r.path)
        const active = r.path === currentDrive || (isWin && r.name === currentDrive)
        drivesBar.appendChild(
          h('button', {
            class: 'dp-drive' + (active ? ' active' : ''),
            onclick: () => load(r.path)
          }, r.name + (r.kind === 'drive' ? ':' : ''))
        )
      }
      if (homePath) {
        drivesBar.appendChild(
          h('button', { class: 'dp-drive home', title: homePath, onclick: () => load(homePath) }, '🏠 主目录')
        )
      }
    }

    function renderSpecials(currentPath) {
      clear(specialsBar)
      if (!specials.length) return
      specialsBar.appendChild(h('span', { class: 'dp-specials-label' }, '快速访问：'))
      for (const s of specials) {
        const active = currentPath && (currentPath.toLowerCase() === s.path.toLowerCase())
        specialsBar.appendChild(
          h('button', {
            class: 'dp-special' + (active ? ' active' : ''),
            title: s.path,
            onclick: () => load(s.path)
          }, (s.icon || '📁') + ' ' + s.name)
        )
      }
    }

    function renderList() {
      clear(list)
      const q = filter
      const dirs = q ? curDirs.filter((d) => d.name.toLowerCase().includes(q)) : curDirs
      const files = fileMode && q ? curFiles.filter((f) => f.name.toLowerCase().includes(q)) : (fileMode ? curFiles : [])
      if (!dirs.length && !files.length) {
        list.appendChild(h('div', { class: 'muted center', style: { padding: '14px' } },
          q ? `没有匹配「${escapeHtml(q)}」的${fileMode ? '脚本/文件夹' : '文件夹'}` : (fileMode ? '该目录下没有匹配的脚本' : '该目录下没有子文件夹')))
        return
      }
      for (const d of dirs) {
        const card = h(
          'div',
          {
            class: 'mon-card dp-dir',
            title: '单击进入 · 双击选择此目录',
            onclick: () => load(d.path),
            ondblclick: () => {
              if (finished) return
              finished = true
              resolve(d.path)
              modal.close()
            }
          },
          h('div', { class: 'mc-top' },
            '📁 ',
            h('span', { class: 'mc-name' }, d.name)
          )
        )
        list.appendChild(card)
      }
      for (const f of files) {
        const card = h(
          'div',
          {
            class: 'mon-card dp-dir dp-file',
            title: '单击选中 · 双击选择此文件',
            onclick: () => {
              list.querySelectorAll('.dp-file.sel').forEach((n) => n.classList.remove('sel'))
              card.classList.add('sel')
              selFile = f.path
            },
            ondblclick: () => {
              if (finished) return
              finished = true
              resolve(f.path)
              modal.close()
            }
          },
          h('div', { class: 'mc-top' },
            '📄 ',
            h('span', { class: 'mc-name' }, f.name)
          )
        )
        list.appendChild(card)
      }
    }

    function renderPresets(items) {
      clear(presetsRow)
      const list = (items || []).filter((p) => p && p !== path)
      if (!list.length) return
      presetsRow.appendChild(h('span', { class: 'muted dp-presets-label' }, '常用：'))
      for (const pz of list) {
        // 截掉过长路径，只显示末段
        const label = pz.length > 38 ? '…' + pz.slice(-37) : pz
        presetsRow.appendChild(
          h('button', { class: 'pill', title: pz, onclick: () => load(pz) }, label)
        )
      }
    }

    async function load(p) {
      status.textContent = '加载中…'
      list.style.opacity = '0.4'
      try {
        const qs = new URLSearchParams({ path: p || '' })
        if (fileMode && exts.length) qs.set('exts', exts.join(','))
        const data = await api.get('/api/fs/list?' + qs.toString())
        if (data.error) throw new Error(data.error)
        path = data.path
        pathInput.value = path
        curDirs = data.dirs || []
        curFiles = data.files || []
        selFile = null
        renderBreadcrumb(path)
        renderSpecials(path)
        renderList()
        renderPresets(data.presets)
        const fileWord = fileMode ? `· ${curFiles.length} 个脚本` : `· ${curFiles.length} 个 jar`
        status.textContent = `${curDirs.length} 个文件夹 ${fileWord} · 当前：「${path}」`
      } catch (e) {
        status.textContent = '❌ ' + e.message
        clear(list)
        list.appendChild(h('div', { class: 'muted center', style: { padding: '14px' } }, '无法打开该路径'))
      } finally {
        list.style.opacity = ''
      }
    }

    async function newFolder() {
      const name = window.prompt('新建文件夹名称（将在当前目录下创建）：')
      if (!name) return
      if (/[\/\\:*?"<>|]/.test(name)) {
        toast('名称含非法字符')
        return
      }
      const target = (path || '').replace(/[\\/]+$/, '') + (isWin ? '\\' : '/') + name
      try {
        const r = await api.post('/api/fs/mkdir', { path: target })
        if (r.error) throw new Error(r.error)
        toast('已创建：' + name)
        if (isWin && /^[A-Z]:$/i.test(splitPath(path)[0] || '')) {
          load(path)
        } else {
          load(path)
        }
      } catch (e) {
        toast('创建失败：' + e.message)
      }
    }

    // --- 布局 ---
    const okBtn = h('button', { class: 'btn btn-sm btn-primary' }, fileMode ? '✓ 选择此文件' : '✓ 选择此目录')
    okBtn.onclick = () => {
      if (finished) return
      if (fileMode) {
        const v = (selFile || pathInput.value.trim() || '').trim()
        if (!v) { toast('请先在列表中单击选中一个脚本，或直接粘贴路径'); return }
        if (exts.length && !exts.some((e) => v.toLowerCase().endsWith(e))) { toast('请选择 ' + exts.join(' / ') + ' 脚本'); return }
        finished = true
        resolve(v)
      } else {
        finished = true
        resolve(pathInput.value.trim())
      }
      modal.close()
    }
    const toolbar = h(
      'div',
      { class: 'dp-toolbar' },
      h('button', { class: 'btn btn-sm', onclick: () => load(path ? path.replace(/[\\/]+$/, '').split(/[\\/]/).slice(0, -1).join(isWin ? '\\' : '/') || (isWin ? 'C:\\' : '/') : (isWin ? 'C:\\' : '/')) }, '↑ 上级'),
      h('button', { class: 'btn btn-sm', onclick: () => load(pathInput.value) }, '打开'),
      h('button', { class: 'btn btn-sm', onclick: () => pathInput.select() }, '编辑路径'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm', onclick: newFolder }, '📁 新建文件夹'),
      okBtn
    )

    const body = h(
      'div',
      { class: 'dp-body' },
      drivesBar,
      specialsBar,
      breadcrumb,
      h('div', { class: 'field' }, pathInput),
      toolbar,
      presetsRow,
      filterInput,
      list,
      status
    )

    const modal = openModal({
      title,
      size: 'lg',
      body,
      buttons: [
        { label: '取消', onClick: () => { finished = true; resolve(null); modal.close() } }
      ],
      onClose: () => { if (!finished) resolve(null) }
    })

    // 初始化：先拉盘符再加载路径
    ;(async () => {
      try {
        const r = await api.get('/api/fs/roots')
        roots = r.roots || []
        specials = r.specials || []
        homePath = r.home || ''
        isWin = roots.some((x) => x.kind === 'drive' && /^[A-Z]:$/i.test(x.name))
        renderDrives(path)
        renderSpecials(path)
        await load(path)
      } catch (e) {
        await load(path)
      }
    })()
  })
}

/** 脚本选择器：在目录里挑 .bat / .cmd / .sh（单击选中、双击确认） */
export function pickFile(current, { title = '选择脚本' } = {}) {
  return pickDir(current, { title, fileMode: true, exts: ['.bat', '.cmd', '.sh'] })
}