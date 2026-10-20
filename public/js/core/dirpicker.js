import { h, clear, escapeHtml } from './dom.js'
import { api } from './api.js'
import { openModal } from './modal.js'
import { toast } from './toast.js'
import { icon } from '../ui/icons.js'

// Windows-style path split (drive letter is the first segment); POSIX by "/".
function splitPath(p) {
  if (!p) return []
  const m = String(p).match(/^([A-Za-z]:)([\\\/].*)?$/)
  if (m) {
    const rest = (m[2] || '').split(/[\\/]/).filter(Boolean)
    return [m[1].toUpperCase(), ...rest]
  }
  return String(p).split(/[\\/]/).filter(Boolean)
}

function joinSegments(segs, isWin) {
  if (!segs.length) return ''
  if (isWin && /^[A-Z]:$/i.test(segs[0])) {
    let p = segs[0]
    for (let i = 1; i < segs.length; i++) p += '\\' + segs[i]
    return p.endsWith('\\') && segs.length > 1 ? p : (segs.length === 1 ? p + '\\' : p)
  }
  return '/' + segs.join('/')
}

/**
 * Directory picker with drives, breadcrumbs, quick places, presets and
 * optional file mode. Resolves an absolute path, or null when cancelled.
 */
export function pickDir(current, { title = '选择目录', fileMode = false, exts = [] } = {}) {
  return new Promise((resolve) => {
    let path = current || ''
    let finished = false
    let roots = []
    let specials = []
    let isWin = false
    let filter = ''
    let homePath = ''
    let curDirs = []
    let curFiles = []
    let selFile = null

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
      placeholder: fileMode ? '过滤文件…' : '过滤文件夹…',
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
          h('button', { class: 'dp-seg' + (last ? ' active' : ''), title: segPath, onclick: () => load(segPath) }, seg)
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
          h('button', { class: 'dp-drive' + (active ? ' active' : ''), title: r.path, onclick: () => load(r.path) },
            (r.kind === 'drive' ? r.name + ':' : r.name))
        )
      }
      if (homePath) {
        drivesBar.appendChild(
          h('button', { class: 'dp-drive home', title: homePath, onclick: () => load(homePath) }, '主目录')
        )
      }
    }

    function renderSpecials(currentPath) {
      clear(specialsBar)
      if (!specials.length) return
      specialsBar.appendChild(h('span', { class: 'dp-specials-label' }, '快速访问'))
      for (const s of specials) {
        const active = currentPath && (currentPath.toLowerCase() === s.path.toLowerCase())
        const b = h('button', { class: 'dp-special' + (active ? ' active' : ''), title: s.path, onclick: () => load(s.path) },
          icon('pin', { size: 12 }), h('span', {}, s.name))
        specialsBar.appendChild(b)
      }
    }

    function renderList() {
      clear(list)
      const q = filter
      const dirs = q ? curDirs.filter((d) => d.name.toLowerCase().includes(q)) : curDirs
      const files = fileMode ? (q ? curFiles.filter((f) => f.name.toLowerCase().includes(q)) : curFiles) : []
      if (!dirs.length && !files.length) {
        list.appendChild(h('div', { class: 'muted center', style: { padding: '14px', gridColumn: '1 / -1' } },
          q ? `没有匹配「${escapeHtml(q)}」的${fileMode ? '文件/文件夹' : '文件夹'}` : (fileMode ? '该目录下没有匹配的文件' : '该目录下没有子文件夹')))
        return
      }
      for (const d of dirs) {
        list.appendChild(h('div', {
          class: 'mon-card dp-dir',
          title: '单击进入 · 双击选择此目录',
          onclick: () => load(d.path),
          ondblclick: () => {
            if (finished) return
            finished = true
            resolve(d.path)
            modal.close()
          }
        }, h('div', { class: 'mc-top' }, icon('folder', { size: 14 }), h('span', { class: 'mc-name' }, d.name))))
      }
      for (const f of files) {
        const card = h('div', {
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
        }, h('div', { class: 'mc-top' }, icon('file', { size: 14 }), h('span', { class: 'mc-name' }, f.name)))
        if (selFile === f.path) card.classList.add('sel')
        list.appendChild(card)
      }
    }

    function renderPresets(items) {
      clear(presetsRow)
      const arr = (items || []).filter((p) => p && p !== path)
      if (!arr.length) return
      presetsRow.appendChild(h('span', { class: 'muted dp-presets-label' }, '常用'))
      for (const pz of arr) {
        const label = pz.length > 38 ? '…' + pz.slice(-37) : pz
        presetsRow.appendChild(h('button', { class: 'pill', title: pz, onclick: () => load(pz) }, label))
      }
    }

    async function load(p) {
      status.textContent = '加载中…'
      list.style.opacity = '0.45'
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
        renderDrives(path)
        renderSpecials(path)
        renderList()
        renderPresets(data.presets)
        const fileWord = fileMode ? `${curFiles.length} 个文件` : `${curFiles.length} 个 jar`
        status.textContent = `${curDirs.length} 个文件夹 · ${fileWord} · 当前「${path}」`
      } catch (e) {
        status.textContent = '无法打开：' + e.message
        clear(list)
        list.appendChild(h('div', { class: 'muted center', style: { padding: '14px', gridColumn: '1 / -1' } }, '无法打开该路径'))
      } finally {
        list.style.opacity = ''
      }
    }

    async function newFolder() {
      const name = window.prompt('新建文件夹名称（将在当前目录下创建）：')
      if (!name) return
      if (/[\/\\:*?"<>|]/.test(name)) {
        toast('名称含非法字符', 'err')
        return
      }
      const target = (path || '').replace(/[\\/]+$/, '') + (isWin ? '\\' : '/') + name
      try {
        const r = await api.post('/api/fs/mkdir', { path: target })
        if (r.error) throw new Error(r.error)
        toast('已创建：' + name, 'ok')
        load(path)
      } catch (e) {
        toast('创建失败：' + e.message, 'err')
      }
    }

    const okBtn = h('button', { class: 'btn btn-sm btn-primary' }, icon('check', { size: 13 }), fileMode ? '选择此文件' : '选择此目录')
    okBtn.onclick = () => {
      if (finished) return
      if (fileMode) {
        const v = (selFile || pathInput.value.trim() || '').trim()
        if (!v) { toast('请先在列表中单击选中一个文件，或直接粘贴路径', 'err'); return }
        if (exts.length && !exts.some((e) => v.toLowerCase().endsWith(e))) { toast('请选择 ' + exts.join(' / ') + ' 文件', 'err'); return }
        finished = true
        resolve(v)
      } else {
        finished = true
        resolve(pathInput.value.trim())
      }
      modal.close()
    }

    const upBtn = () => {
      const segs = splitPath(path)
      if (!segs.length) return isWin ? 'C:\\' : '/'
      return joinSegments(segs.slice(0, -1), isWin) || (isWin ? 'C:\\' : '/')
    }

    const toolbar = h('div', { class: 'dp-toolbar' },
      h('button', { class: 'btn btn-sm', onclick: () => load(upBtn()) }, icon('arrow-left', { size: 13 }), '上级'),
      h('button', { class: 'btn btn-sm', onclick: () => load(pathInput.value) }, '打开'),
      h('button', { class: 'btn btn-sm', onclick: () => pathInput.select() }, '编辑路径'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm', onclick: newFolder }, icon('add', { size: 13 }), '新建文件夹'),
      okBtn
    )

    const body = h('div', { class: 'dp-body' },
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
        { label: '取消', class: 'btn-ghost', onClick: () => { finished = true; resolve(null); modal.close() } }
      ],
      onClose: () => { if (!finished) resolve(null) }
    })

    ;(async () => {
      try {
        const r = await api.get('/api/fs/roots')
        roots = r.roots || []
        specials = r.specials || []
        homePath = r.home || ''
        isWin = roots.some((x) => x.kind === 'drive' && /^[A-Z]:[\\/]?$/i.test(x.path)) || /^[A-Za-z]:/.test(current || '')
        renderDrives(path)
        renderSpecials(path)
        await load(path)
      } catch {
        await load(path)
      }
    })()
  })
}

/** File picker for scripts / jars / archives. */
export function pickFile(current, { title = '选择文件', exts = ['.bat', '.cmd', '.sh'] } = {}) {
  return pickDir(current, { title, fileMode: true, exts })
}
