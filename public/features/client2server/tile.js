import { h, clear, fmtBytes } from '/js/core/dom.js'
import { api } from '/js/core/api.js'
import { openModal, confirmDialog } from '/js/core/modal.js'
import { toast } from '/js/core/toast.js'
import { pickDir, pickFile } from '/js/core/dirpicker.js'
import { readPackMetadata } from '/js/core/pack-preview.js'

let ctxRef = null
let dirInput = null
let summaryEl = null
let tableWrap = null
let convertProgress = null
let state = { dir: '', items: [], library: [], selected: new Set(), mode: null, busy: false, showMatchedOnly: false, convertSource: '', convertFile: null, convertBusy: false }
let btnFilter = null

export default {
  renderExpanded(container, { ctx } = {}) {
    c2sExpanded(container, ctx)
  },
  async mount(ctx) {
    ctxRef = ctx
    const s = ctx.settings()
    state.dir = s.client2server.modsDir || ''
    state.mode = s.client2server.defaultAction || 'backup'

    dirInput = h('input', { class: 'input mono', placeholder: '选择或输入 mods 目录', value: state.dir })
    summaryEl = h('div', { class: 'muted' }, '尚未扫描。')
    tableWrap = h('div', { class: 'scroll-y', style: { maxHeight: '320px', border: '1px solid var(--line)', borderRadius: '8px' } })

    const modeSel = h('select', { class: 'input', style: { width: '150px' } },
      h('option', { value: 'backup' }, '移入备份目录'),
      h('option', { value: 'disable' }, '禁用（改后缀名）'),
      h('option', { value: 'enable' }, '启用（恢复 .jar）'),
      h('option', { value: 'delete' }, '直接删除'))
    modeSel.value = state.mode
    modeSel.onchange = () => { state.mode = modeSel.value }

    const btnScan = h('button', { class: 'btn btn-primary btn-sm', onclick: () => scan() }, '扫描')
    const btnExec = h('button', { class: 'btn btn-sm btn-danger', onclick: () => apply() }, '处理选中项')

    // 整合包转换：目录走本地路径，拖入的压缩包在浏览器无法暴露路径时改为上传到本地服务。
    const convertInput = h('input', { class: 'input mono', readonly: true, placeholder: '拖入或选择客户端整合包 / 客户端目录' })
    const outputInput = h('input', { class: 'input mono', readonly: true, placeholder: '输出文件夹（可选）' })
    const runtimeMcInput = h('input', { class: 'input mono', id: 'convert-mc', placeholder: '例如 1.12.2' })
    const runtimeLoaderSel = h('select', { class: 'input', id: 'convert-loader' },
      h('option', { value: '' }, '请选择加载器'),
      h('option', { value: 'vanilla' }, '原版 Vanilla'),
      h('option', { value: 'fabric' }, 'Fabric'),
      h('option', { value: 'forge' }, 'Forge'),
      h('option', { value: 'neoforge' }, 'NeoForge'),
      h('option', { value: 'quilt' }, 'Quilt'),
      h('option', { value: 'paper' }, 'Paper'))
    const runtimeLoaderVersionInput = h('input', { class: 'input mono', id: 'convert-loader-version', placeholder: '识别后自动填写' })
    const versionOptions = h('select', { class: 'input', 'aria-label': '选择在线加载器版本' }, h('option', { value: '' }, '在线候选版本'))
    const versionHint = h('div', { class: 'muted' }, '模组加载器必须指定版本；可以手动填写历史版本。')
    const detectHint = h('div', { class: 'muted', style: { overflowWrap: 'anywhere', lineHeight: '1.6' }, 'aria-live': 'polite' }, '选择整合包后自动读取 MC、加载器和加载器版本。')
    const memoryInput = h('input', { class: 'input mono', id: 'convert-memory', type: 'number', min: '1', max: '256', step: '1', value: '4' })
    const minMemoryInput = h('input', { class: 'input mono', id: 'convert-min-memory', type: 'number', min: '1', max: '256', step: '1', value: '1' })
    const javaInput = h('input', { class: 'input mono', id: 'convert-java', placeholder: '自动选择兼容的 Java', readonly: true })
    const javaHint = h('div', { class: 'muted', style: { overflowWrap: 'anywhere' }, 'aria-live': 'polite' }, '根据 MC 版本检查 Java；旧版 Forge 1.12.2 需要 Java 8。')
    const bundleJavaInput = h('input', { type: 'checkbox', checked: true })
    const memoryHint = h('div', { class: 'muted' }, '最大内存是上限，不应占满物理内存；请为系统和其他程序保留空间。')
    const javaPick = h('button', { class: 'btn btn-sm', onclick: async () => {
      const p = await pickFile('', { title: '选择 Java 可执行文件', exts: ['.exe'] })
      if (p && !state.convertBusy) { javaInput.value = p; checkJava() }
    } }, '选择 Java')
    const javaAuto = h('button', { class: 'btn btn-sm', onclick: () => { javaInput.value = ''; checkJava() } }, '自动选择')
    let inspectSerial = 0, versionSerial = 0, javaSerial = 0, inspecting = false, memoryEdited = false
    memoryInput.oninput = () => { memoryEdited = true }
    const runtimeControls = [runtimeMcInput, runtimeLoaderSel, runtimeLoaderVersionInput]
    const labeled = (label, control) => h('div', { class: 'field', style: { flex: '1 1 180px', minWidth: '0', margin: '0' } }, h('label', { for: control.id }, label), control)
    function updateDisabled() {
      btnConvert.disabled = state.convertBusy || inspecting
      for (const el of [...runtimeControls, versionOptions, memoryInput, minMemoryInput, bundleJavaInput, javaPick, javaAuto, btnPackage, btnFolder, btnOutput]) el.disabled = state.convertBusy || inspecting
      if (!state.convertBusy && !inspecting && runtimeLoaderSel.value === 'vanilla') { runtimeLoaderVersionInput.disabled = true; versionOptions.disabled = true }
    }
    async function checkJava() {
      const serial = ++javaSerial
      if (!runtimeMcInput.value || !runtimeLoaderSel.value) { javaHint.textContent = '先确定 MC 版本和加载器，再检查兼容的 Java。'; return }
      javaHint.textContent = '正在检查本机 Java…'
      try {
        const r = await api.post('/api/mods/java', { runtime: { mc: runtimeMcInput.value, loader: runtimeLoaderSel.value }, javaPath: javaInput.value })
        if (serial !== javaSerial) return
        javaHint.textContent = `已找到 Java ${r.major}（64 位）：${r.path}。此版本服务端使用 Java ${r.required}。`
      } catch (e) { if (serial === javaSerial) javaHint.textContent = e.message }
    }
    async function refreshVersions() {
      const serial = ++versionSerial
      clear(versionOptions); versionOptions.appendChild(h('option', { value: '' }, '选择在线版本（可手动输入）'))
      const loader = runtimeLoaderSel.value, mc = runtimeMcInput.value.trim()
      runtimeLoaderVersionInput.disabled = state.convertBusy || inspecting || loader === 'vanilla'
      versionOptions.disabled = state.convertBusy || inspecting || loader === 'vanilla'
      if (loader === 'vanilla') {
        runtimeLoaderVersionInput.value = ''; runtimeLoaderVersionInput.placeholder = '原版无需加载器版本'
        versionHint.textContent = '原版服务端不需要加载器版本。'; versionOptions.disabled = true; return
      }
      runtimeLoaderVersionInput.placeholder = '填写准确版本号'
      if (!loader || !mc) { versionHint.textContent = '先填写 MC 版本并选择加载器；模组加载器版本必填。'; return }
      const current = runtimeLoaderVersionInput.value.trim()
      if (current) versionOptions.appendChild(h('option', { value: current }, `${current}（当前版本）`))
      versionHint.textContent = '正在获取在线候选；当前版本不会被自动替换。'
      try {
        const r = await api.get('/api/servercore/loaderversions?' + new URLSearchParams({ loader, mc }))
        if (serial !== versionSerial) return
        for (const item of r.items || []) if (String(item.version) !== current) versionOptions.appendChild(h('option', { value: item.version }, `${item.version}${item.label ? '（' + ({ recommended: '推荐', latest: '最新' }[item.label] || item.label) + '）' : ''}`))
        versionHint.textContent = loader === 'forge' ? '在线列表提供推荐 / 最新版；整合包应优先保持已识别的准确版本，历史版本可直接填写。' : '请选择与整合包一致的版本，也可以直接填写；不会自动升级。'
      } catch (e) { if (serial === versionSerial) versionHint.textContent = '在线列表暂不可用，仍可使用已识别版本或手动填写。' }
    }
    versionOptions.onchange = () => { if (versionOptions.value) runtimeLoaderVersionInput.value = versionOptions.value }
    const runtimeChanged = () => { runtimeLoaderVersionInput.value = ''; detectHint.textContent = '已手动更改运行环境，请重新确定对应的加载器版本。'; refreshVersions(); checkJava() }
    runtimeMcInput.oninput = () => { ++versionSerial; ++javaSerial; runtimeLoaderVersionInput.value = ''; clear(versionOptions) }
    runtimeMcInput.onchange = runtimeChanged
    runtimeLoaderSel.onchange = runtimeChanged
    const convertStatus = h('div', { class: 'muted', style: { marginTop: '6px', lineHeight: '1.5' } },
      '未选择输出文件夹时：目录或已选择的压缩包会在客户端原文件夹生成；直接拖入的文件会生成到系统“下载”文件夹。原文件不会被修改。')
    convertProgress = h('div', { style: { display: 'none', marginTop: '8px' } },
      h('div', { class: 'row', style: { justifyContent: 'space-between', marginBottom: '4px' } },
        h('span', { class: 'muted', 'data-role': 'convert-detail' }, ''),
        h('span', { class: 'muted mono', 'data-role': 'convert-percent' }, '0%')),
      h('div', { class: 'bar' }, h('i', { 'data-role': 'convert-bar', style: { width: '0%' } })))
    const drop = h('div', { class: 'drop-zone', tabindex: '0', style: { marginTop: '8px' } }, '将客户端 ZIP / .mrpack 拖到这里，或点击选择文件')
    const btnPackage = h('button', { class: 'btn btn-sm', onclick: async () => {
      const p = await pickFile('', { title: '选择客户端整合包', exts: ['.zip', '.mrpack'] })
      if (p && !state.convertBusy) setConvertSource(p, null)
    } }, '选择安装包')
    const btnFolder = h('button', { class: 'btn btn-sm', onclick: async () => {
      const p = await pickDir('', { title: '选择客户端整合包目录' })
      if (p && !state.convertBusy) setConvertSource(p, null)
    } }, '选择文件夹')
    const btnOutput = h('button', { class: 'btn btn-sm', onclick: async () => {
      const p = await pickDir(outputInput.value || '', { title: '选择服务端包输出文件夹' })
      if (p) { outputInput.value = p; convertStatus.textContent = `服务端包将生成到：${p}。原客户端文件不会被修改。` }
    } }, '选择输出文件夹')
    const btnConvert = h('button', { class: 'btn btn-sm btn-primary', onclick: convertPack }, '转换为服务端包')
    let activeConvertJobId = ''
    let activeUploadXhr = null
    let cancelRequested = false
    let lastProgress = 0
    const btnCancelConvert = h('button', { class: 'btn btn-sm btn-danger', style: { display: 'none' }, onclick: cancelConvert }, '中止转换')
    drop.onclick = () => btnPackage.click()
    async function setConvertSource(source, file) {
      if (state.convertBusy) return
      const serial = ++inspectSerial
      ++versionSerial; ++javaSerial
      inspecting = true
      for (const el of runtimeControls) el.value = ''
      clear(versionOptions)
      detectHint.textContent = '正在读取整合包版本信息…（只读取清单，不解压整个包）'
      updateDisabled()
      state.convertSource = source || ''
      state.convertFile = file || null
      convertInput.value = source || file?.name || ''
      const suffix = file ? '（将上传到本地工具箱处理）' : ''
      convertStatus.textContent = `已选择：${source || file?.name || '未选择'}${suffix} 原文件不会被修改。`
      if (!memoryEdited) memoryInput.value = '4'
      memoryHint.textContent = '将按模组数量和体积提供内存建议；最大内存不应占满物理内存。'
      try {
        const records = file ? await readPackMetadata(file.size, (offset, length) => {
          if (serial !== inspectSerial) throw new Error('选择已更新')
          return file.slice(offset, offset + length).arrayBuffer()
        }) : null
        if (serial !== inspectSerial) return
        const r = await api.post('/api/mods/inspect', records ? { records, summary: records.summary } : { source })
        if (serial !== inspectSerial) return
        if (r.runtime) {
          if (!memoryEdited) memoryInput.value = String(r.runtime.recommendedMemory || 4)
          memoryHint.textContent = `检测到 ${r.runtime.modCount || 0} 个模组文件，按规模建议最大 ${r.runtime.recommendedMemory || 4} GB；请按人数和实测调整，并为系统保留内存。这不是最低内存保证。`
          runtimeMcInput.value = r.runtime.mc
          runtimeLoaderSel.value = r.runtime.loader
          runtimeLoaderVersionInput.value = r.runtime.loaderVersion || ''
          detectHint.textContent = `已识别：Minecraft ${r.runtime.mc} · ${r.runtime.loader} ${r.runtime.loaderVersion || ''}；来源：${r.runtime.source}`
        } else detectHint.textContent = '未找到有效版本信息，请手动填写下方 MC、加载器及其版本后再转换。'
      } catch (e) { if (serial === inspectSerial) detectHint.textContent = '自动识别失败：' + e.message + '。可以手动填写版本。' }
      finally {
        if (serial === inspectSerial) { inspecting = false; updateDisabled(); refreshVersions(); checkJava() }
      }
    }
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over') })
    drop.addEventListener('dragleave', () => drop.classList.remove('over'))
    drop.addEventListener('drop', (e) => {
      e.preventDefault()
      drop.classList.remove('over')
      const file = e.dataTransfer?.files?.[0]
      if (!file) return
      if (!/\.(zip|mrpack)$/i.test(file.name)) { toast('请拖入 .zip 或 .mrpack 客户端整合包', 'err'); return }
      // 某些 WebView 会提供 file.path；标准浏览器没有路径时仍可上传文件内容。
      setConvertSource(file.path || '', file.path ? null : file)
    })
    ctx.body.appendChild(h('div', { class: 'section c2s-convert', style: { marginBottom: '10px' } },
      h('div', { class: 'row wrap' }, h('b', {}, '整合包转服务端'), h('span', { class: 'muted' }, '保留原包，生成新的服务端 ZIP')),
      drop,
      h('div', { class: 'row wrap', style: { marginTop: '8px' } },
        h('div', { class: 'grow', style: { minWidth: '220px' } }, convertInput), btnPackage, btnFolder),
      h('div', { class: 'row wrap', style: { marginTop: '6px' } },
        h('div', { class: 'grow', style: { minWidth: '220px' } }, outputInput), btnOutput, btnConvert, btnCancelConvert),
      h('div', { style: { marginTop: '12px' } }, h('b', {}, '核心识别'), detectHint),
      h('div', { class: 'row wrap', style: { alignItems: 'flex-start', marginTop: '8px' } },
        labeled('Minecraft 版本', runtimeMcInput), labeled('加载器类型', runtimeLoaderSel), labeled('加载器版本（模组服必填）', runtimeLoaderVersionInput)),
      h('div', { style: { marginTop: '6px' } }, versionOptions, versionHint),
      h('div', { style: { marginTop: '12px' } }, h('b', {}, '启动设置')),
      h('div', { class: 'row wrap', style: { marginTop: '6px' } }, labeled('最大内存（GB）', memoryInput), labeled('初始内存（GB）', minMemoryInput)),
      memoryHint,
      h('div', { class: 'row wrap', style: { marginTop: '6px' } }, labeled('Java 路径（自动匹配或手动选择）', javaInput), javaPick, javaAuto), javaHint,
      h('label', { class: 'row wrap', style: { marginTop: '8px' } }, bundleJavaInput, '将兼容的 Java 一起打包（增加体积；Windows 运行时仅适用于 Windows）'),
      convertStatus, convertProgress))

    ctx.body.appendChild(h('div', { class: 'field' }, h('label', {}, 'mods 目录'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, dirInput),
        h('button', { class: 'btn btn-sm', onclick: async () => {
          const p = await pickDir(dirInput.value || '')
          if (p) {
            dirInput.value = p
            state.dir = p
            await api.put('/api/settings', { client2server: { modsDir: p } })
            ctx.settings().client2server.modsDir = p
            scan()
          }
        } }, '浏览'),
        btnScan)))
    btnFilter = h('button', {
      class: 'btn btn-sm' + (state.showMatchedOnly ? ' active' : ''),
      title: '只列出匹配到的仅客户端 mod',
      onclick: () => {
        state.showMatchedOnly = !state.showMatchedOnly
        btnFilter.classList.toggle('active', state.showMatchedOnly)
        render()
      }
    }, '👁 仅显示匹配项')

    ctx.body.appendChild(h('div', { class: 'row wrap' },
      h('button', { class: 'btn btn-sm', onclick: () => selectAll(true) }, '全选'),
      h('button', { class: 'btn btn-sm', onclick: () => selectAll(false) }, '取消选择'),
      h('button', { class: 'btn btn-sm', onclick: () => selectMatched() }, '仅选匹配项'),
      btnFilter,
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted' }, '处理方式'),
      modeSel,
      btnExec))
    ctx.body.appendChild(h('div', { class: 'row wrap' },
      h('button', { class: 'btn btn-sm', onclick: () => openLibrary() }, '📚 管理仅客户端 mod 库'),
      h('button', { class: 'btn btn-sm', onclick: () => openModsDir() }, '📂 打开库目录'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted', id: 'c2sCount' }, '')))

    // 绑定启动脚本：选择一个 .bat/.cmd/.sh（例如服务端核心生成的 start.bat），点「运行」拉起
    const scriptPath = (s.client2server && s.client2server.scriptPath) || ''
    const scriptInput = h('input', { class: 'input mono', readonly: true, placeholder: '未绑定启动脚本（可选：服务端核心下载生成的 start.bat）', value: scriptPath, title: scriptPath })
    const btnSel = h('button', { class: 'btn btn-sm', onclick: pickScript }, '选择')
    const btnRun = h('button', { class: 'btn btn-sm btn-primary', disabled: !scriptPath, onclick: runScript }, '▶ 运行')
    const btnClear = h('button', { class: 'btn btn-sm', onclick: clearScript }, '✕')
    ctx.body.appendChild(h('div', { class: 'row wrap', style: { gap: '6px', alignItems: 'center', margin: '2px 0 6px' } },
      h('span', { class: 'muted' }, '启动脚本：'), h('div', { class: 'grow', style: { minWidth: '180px' } }, scriptInput),
      btnSel, btnRun, btnClear))

    function setScript(p) {
      scriptInput.value = p || ''
      scriptInput.title = p || ''
      btnRun.disabled = !p
      try { if (ctx.settings().client2server) ctx.settings().client2server.scriptPath = p || '' } catch {}
      api.put('/api/settings', { client2server: { scriptPath: p || '' } }).catch(() => {})
    }
    async function pickScript() {
      const cur = scriptInput.value || ''
      const startDir = cur ? cur.replace(/[\\/][^\\/]*$/, '') : ''
      const p = await pickFile(startDir || '', { title: '选择要绑定的启动脚本' })
      if (p) { setScript(p); toast('已绑定：' + p, 'ok') }
    }
    async function runScript() {
      const p = scriptInput.value.trim()
      if (!p) { toast('请先选择启动脚本', 'err'); return }
      btnRun.disabled = true
      try {
        const r = await api.post('/api/scripts/run', { path: p })
        if (r.error) { toast(r.error, 'err'); return }
        toast('已在新窗口运行脚本', 'ok')
      } catch (e) { toast('运行失败：' + e.message, 'err') } finally { btnRun.disabled = false }
    }
    function clearScript() { setScript(''); toast('已解除绑定', 'ok') }

    ctx.body.appendChild(summaryEl)
    ctx.body.appendChild(tableWrap)

    await loadLibrary()
    if (state.dir) scan()

    async function convertPack() {
      if (state.convertBusy || inspecting) return
      if (!state.convertSource && !state.convertFile) { toast('请先拖入或选择客户端整合包 / 目录', 'err'); return }
      if (state.convertFile?.size > 2 * 1024 * 1024 * 1024) { toast('整合包超过 2 GB，请先解压并使用“选择文件夹”', 'err'); return }
      const memory = Number(memoryInput.value), minMemory = Number(minMemoryInput.value)
      if (!Number.isInteger(memory) || !Number.isInteger(minMemory) || minMemory < 1 || memory < minMemory || memory > 256) { toast('内存请输入 1–256 的整数，初始内存不能大于最大内存', 'err'); return }
      if (!/^1\.\d+(?:\.\d+)?$/.test(runtimeMcInput.value.trim()) || !runtimeLoaderSel.value || (runtimeLoaderSel.value !== 'vanilla' && !runtimeLoaderVersionInput.value.trim())) { toast('请先补全 MC 版本、加载器及加载器版本', 'err'); return }
      cancelRequested = false
      lastProgress = 0
      state.convertBusy = true
      updateDisabled()
      btnCancelConvert.style.display = ''
      btnCancelConvert.disabled = false
      setConvertProgress({ stage: 'queued', progress: null, detail: '正在提交转换任务…' })
      try {
        const selectedJava = await api.post('/api/mods/java', { runtime: { mc: runtimeMcInput.value.trim(), loader: runtimeLoaderSel.value }, javaPath: javaInput.value })
        if (cancelRequested) throw new Error('转换已中止')
        let job
        if (state.convertFile) {
          const q = new URLSearchParams({ memory: memory + 'G', minMemory: minMemory + 'G', javaPath: selectedJava.path, bundleJava: String(bundleJavaInput.checked) })
          if (outputInput.value.trim()) q.set('outputDir', outputInput.value.trim())
          if (runtimeMcInput.value.trim()) q.set('mc', runtimeMcInput.value.trim())
          if (runtimeLoaderSel.value) q.set('loader', runtimeLoaderSel.value)
          if (runtimeLoaderVersionInput.value.trim()) q.set('loaderVersion', runtimeLoaderVersionInput.value.trim())
          job = await uploadConvertFile('/api/mods/convert-upload?' + q, state.convertFile)
        } else {
          const runtime = { mc: runtimeMcInput.value.trim(), loader: runtimeLoaderSel.value, loaderVersion: runtimeLoaderVersionInput.value.trim() }
          job = await api.post('/api/mods/convert', { source: state.convertSource, outputDir: outputInput.value.trim(), runtime, memory: memory + 'G', minMemory: minMemory + 'G', javaPath: selectedJava.path, bundleJava: bundleJavaInput.checked })
        }
        if (job.error) throw new Error(job.error)
        if (!job.id) throw new Error('转换任务创建失败')
        activeConvertJobId = job.id
        if (cancelRequested) await cancelConvert()
        let result
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 350))
          const current = await api.get('/api/mods/convert/jobs/' + encodeURIComponent(job.id))
          setConvertProgress(current)
          if (current.status === 'done') { result = current.result; break }
          if (current.status === 'cancelled') throw new Error('转换已中止')
          if (current.status === 'failed') throw new Error(current.error || '转换失败')
        }
        const warning = (result.warnings || []).map((x) => h('div', { class: 'result-bad' }, x))
        const detail = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
          h('div', { class: 'result-ok' }, `转换完成：移除 ${result.removedCount || 0} 个仅客户端 mod`),
          h('div', { class: 'mono', style: { wordBreak: 'break-all' } }, result.output),
          h('div', { class: 'muted' }, `扫描 ${result.totalMods || 0} 个 mod · 输出 ${fmtBytes(result.packed?.bytes || 0)}`),
          result.core && h('div', { class: 'muted' }, `Java ${result.core.javaMajor} · 初始 ${result.core.minMemory} / 最大 ${result.core.memory} · ${result.core.bundledJava ? '已包含 Java 运行时' : '使用本机 Java'}`),
          ...warning)
        openModal({
          title: '服务端整合包已生成',
          body: detail,
          buttons: [{ label: '打开输出文件夹', onClick: async () => { await api.post('/api/fs/open', { path: result.outputDir }); } }, { label: '关闭', class: 'btn-primary' }]
        })
        toast('服务端整合包已生成', 'ok')
      } catch (e) {
        const cancelled = e.message === '转换已中止' || e.message === '客户端整合包上传已取消'
        toast(cancelled ? '已中止转换' : '转换失败：' + e.message, cancelled ? 'warn' : 'err')
        setConvertProgress({ status: cancelled ? 'cancelled' : 'failed', stage: cancelled ? 'cancelled' : 'failed', progress: lastProgress, detail: cancelled ? '转换已中止' : e.message })
      } finally {
        state.convertBusy = false
        updateDisabled()
        btnCancelConvert.style.display = 'none'
        activeConvertJobId = ''
        activeUploadXhr = null
      }
    }

    async function cancelConvert() {
      if (!state.convertBusy) return
      cancelRequested = true
      btnCancelConvert.disabled = true
      setConvertProgress({ status: 'cancelling', progress: null, detail: '正在请求中止，请等待后台停止并清理…' })
      if (activeUploadXhr) {
        activeUploadXhr.abort()
        return
      }
      if (activeConvertJobId) {
        try { await api.post('/api/mods/convert/jobs/' + encodeURIComponent(activeConvertJobId) + '/cancel') }
        catch (e) { btnCancelConvert.disabled = false; toast('中止请求失败：' + e.message, 'err') }
      }
    }

    function uploadConvertFile(url, file) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        activeUploadXhr = xhr
        xhr.open('POST', url)
        xhr.setRequestHeader('Content-Type', file.type || 'application/zip')
        xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name))
        xhr.onloadend = () => { if (activeUploadXhr === xhr) activeUploadXhr = null }
        xhr.upload.onload = () => setConvertProgress({ stage: 'upload', progress: null, detail: '上传完成，正在等待本地工具箱创建任务…' })
        xhr.upload.onprogress = (event) => {
          if (!event.lengthComputable) {
            setConvertProgress({ stage: 'upload', progress: null, detail: `正在上传到本机 · 已传 ${fmtBytes(event.loaded)}` })
            return
          }
          const ratio = Math.max(0, Math.min(1, event.loaded / event.total))
          const uploaded = `${fmtBytes(event.loaded)} / ${fmtBytes(event.total)}`
          setConvertProgress({ stage: 'upload', progress: ratio * 100, detail: `上传到本机（上传阶段） · ${uploaded}` })
        }
        xhr.onerror = () => reject(new Error('客户端整合包上传失败，请检查文件是否仍可读取'))
        xhr.onabort = () => reject(new Error('客户端整合包上传已取消'))
        xhr.onload = () => {
          let data = null
          try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null } catch { reject(new Error('上传接口返回了无效响应')); return }
          if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(data?.error || `上传失败（HTTP ${xhr.status}）`)); return }
          setConvertProgress({ stage: 'queued', progress: null, detail: '上传完成，正在启动转换任务…' })
          resolve(data)
        }
        xhr.send(file)
      })
    }

    function setConvertProgress(job) {
      if (!convertProgress) return
      convertProgress.style.display = 'block'
      const detail = convertProgress.querySelector('[data-role="convert-detail"]')
      const percent = convertProgress.querySelector('[data-role="convert-percent"]')
      const bar = convertProgress.querySelector('[data-role="convert-bar"]')
      const known = typeof job.progress === 'number' && Number.isFinite(job.progress)
      const p = known ? Math.max(0, Math.min(100, job.progress)) : 0
      if (known) lastProgress = p
      if (detail) detail.textContent = job.detail || job.stage || '处理中…'
      if (percent) percent.textContent = ['failed', 'cancelled'].includes(job.status) ? (job.status === 'cancelled' ? '已中止' : '失败') : known ? `${Math.round(p)}%` : '处理中'
      if (bar) { bar.style.width = known ? `${p}%` : ''; bar.parentElement.classList.toggle('indeterminate', !known) }
      if (job.status === 'done') convertStatus.textContent = '转换完成。已校验服务端核心和启动文件，原客户端文件未修改。'
      else if (job.status === 'failed') convertStatus.textContent = `转换失败：${job.error || job.detail || '未知错误'}`
    }
  }
}

// ---------------- 数据 ----------------
async function loadLibrary() {
  try {
    const data = await api.get('/api/mods/client-list')
    state.library = data.items
  } catch (e) {
    toast('读取 mod 库失败：' + e.message, 'err')
  }
}

function libMap() {
  const m = new Map()
  for (const it of state.library) m.set(String(it.modid).toLowerCase(), it)
  return m
}

function classify(mod) {
  if (!mod.modid) return null
  const hit = libMap().get(String(mod.modid).toLowerCase())
  if (hit) return { kind: 'lib', label: 'modid 库', note: hit.name || hit.modid }
  if (mod.environment === 'client' && ctxRef?.settings().client2server.autoDetectEnv !== false) {
    return { kind: 'auto', label: '自动识别', note: 'fabric/quilt 声明为 client' }
  }
  return null
}

// ---------------- 扫描 ----------------
async function scan() {
  if (state.busy) return
  const dir = dirInput.value.trim()
  if (!dir) {
    toast('请先选择 mods 目录', 'err')
    return
  }
  state.dir = dir
  state.busy = true
  clear(tableWrap)
  tableWrap.appendChild(h('div', { class: 'muted center', style: { padding: '20px' } }, '扫描中…'))
  try {
    const data = await api.post('/api/mods/scan', { dir })
    if (data.error) throw new Error(data.error)
    await loadLibrary()
    state.items = data.items
    state.selected = new Set(state.items.filter((m) => classify(m)).map((m) => m.path))
    render()
    toast(`扫描完成：${data.items.length} 个文件`, 'ok')
  } catch (e) {
    clear(tableWrap)
    tableWrap.appendChild(h('div', { class: 'result-bad', style: { padding: '12px' } }, '扫描失败：' + e.message))
  } finally {
    state.busy = false
  }
}

// 当前应显示的行（受「仅显示匹配项」过滤影响）
function visibleItems() {
  return state.showMatchedOnly ? state.items.filter((m) => classify(m)) : state.items
}

function render() {
  const matched = state.items.filter((m) => classify(m))
  const unknown = state.items.filter((m) => !m.modid)
  const visible = visibleItems()
  clear(summaryEl)
  const filterPart = state.showMatchedOnly ? ` · 当前显示 ${visible.length} 个` : ''
  summaryEl.textContent = `共 ${state.items.length} 个文件 · 识别为仅客户端 ${matched.length} 个 · 无法识别 modid ${unknown.length} 个 · 已选 ${state.selected.size} 个${filterPart}`
  ctxRef.setBadge(matched.length ? `${matched.length} 个待处理` : '', matched.length ? 'warn' : '')

  clear(tableWrap)
  if (!state.items.length) {
    tableWrap.appendChild(h('div', { class: 'muted center', style: { padding: '20px' } }, '该目录下没有 jar 文件'))
    return
  }
  if (!visible.length) {
    tableWrap.appendChild(h('div', { class: 'muted center', style: { padding: '20px' } },
      '没有匹配到的仅客户端 mod。', h('br'), '可点击「👁 仅显示匹配项」关闭过滤查看全部。'))
    return
  }
  const table = h('table', { class: 'tbl' })
  table.appendChild(h('thead', {}, h('tr', {},
    h('th', { style: { width: '32px' } }, ''),
    h('th', {}, '文件'),
    h('th', {}, 'modid'),
    h('th', {}, '名称 / 版本'),
    h('th', {}, '加载器'),
    h('th', { class: 'num' }, '大小'),
    h('th', {}, '匹配规则'))))
  const tbody = h('tbody')
  for (const m of visible) {
    const c = classify(m)
    const cb = h('input', {
      class: 'checkbox', type: 'checkbox', checked: state.selected.has(m.path),
      onchange: (e) => {
        if (e.target.checked) state.selected.add(m.path)
        else state.selected.delete(m.path)
        const cnt = document.getElementById('c2sCount')
        if (cnt) cnt.textContent = `已选 ${state.selected.size} 个`
      }
    })
    tbody.appendChild(h('tr', { class: c ? 'mod-row danger' : 'mod-row' },
      h('td', {}, cb),
      h('td', { class: 'mono', title: m.relPath }, m.file),
      h('td', { class: 'mono' }, m.modid || h('span', { class: 'muted' }, '(未知)')),
      h('td', {}, m.name || '-', m.version ? h('span', { class: 'muted' }, ' · ' + m.version) : null),
      h('td', {}, h('span', { class: 'pill' }, m.loader || '-')),
      h('td', { class: 'num' }, fmtBytes(m.size)),
      h('td', {}, c ? h('span', { class: 'badge ' + (c.kind === 'auto' ? 'info' : 'warn') }, c.label) : h('span', { class: 'muted' }, '-'))))
  }
  table.appendChild(tbody)
  tableWrap.appendChild(table)
  const cnt = document.getElementById('c2sCount')
  if (cnt) cnt.textContent = `已选 ${state.selected.size} 个`
}

function selectAll(v) {
  // 只作用于当前可见的行，与用户所见一致
  const visible = visibleItems()
  if (v) for (const m of visible) state.selected.add(m.path)
  else for (const m of visible) state.selected.delete(m.path)
  render()
}
function selectMatched() {
  state.selected = new Set(state.items.filter((m) => classify(m)).map((m) => m.path))
  render()
}

// ---------------- 执行处理 ----------------
async function apply() {
  const files = Array.from(state.selected)
  if (!files.length) {
    toast('没有选中任何文件', 'err')
    return
  }
  const names = files.map((f) => f.split(/[\\/]/).pop())
  const mode = state.mode
  const s = ctxRef.settings()
  const MODE_TEXT = {
    delete: { verb: '删除', tail: '<b class="result-bad">删除后无法恢复！</b>', ok: '确认删除' },
    disable: { verb: '禁用', tail: '文件会被改名为 <b class="mono">.jar.disabled</b>，Minecraft 将不再加载它；把后缀改回 <b class="mono">.jar</b> 即可恢复。', ok: '确认禁用' },
    backup: { verb: '移出', tail: '文件将被移动到备份目录，可在备份目录手动恢复。', ok: '确认处理' }
  }
  const mt = MODE_TEXT[mode] || MODE_TEXT.backup
  const ok = await ctxRef.confirm(
    `<div>即将${mt.verb} <b>${files.length}</b> 个文件：</div>
     <div class="mono" style="margin:8px 0;max-height:180px;overflow:auto">${names.map((n) => '· ' + n).join('<br>')}</div>
     <div>${mt.tail}</div>`
    , { danger: mode === 'delete', okText: mt.ok })
  if (!ok) return

  state.busy = true
  try {
    const r = await api.post('/api/mods/apply', { files, mode, dir: state.dir, backupDir: s.client2server.backupDir })
    if (r.error) throw new Error(r.error)
    const okCount = r.done?.length || 0
    const failCount = r.failed?.length || 0
    openModal({
      title: '处理完成',
      body: h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', {}, `成功 ${okCount} 个，失败 ${failCount} 个。`),
        r.backupDir ? h('div', { class: 'muted mono' }, '备份目录：' + r.backupDir) : null,
        failCount ? h('div', { class: 'result-bad mono', style: { fontSize: '12px' } }, r.failed.map((f) => `${f.file}：${f.error}`).join('\n')) : null),
      buttons: [{ label: '好的', class: 'btn-primary' }]
    })
    toast(`处理完成：成功 ${okCount} 个`, 'ok')
    await scan()
  } catch (e) {
    toast('处理失败：' + e.message, 'err')
  } finally {
    state.busy = false
  }
}

// ---------------- 仅客户端 mod 库管理 ----------------

async function openModsDir() {
  try {
    const r = await api.post('/api/system/open-path', { which: 'clientModsDir' })
    const p = (r && (r.file || r.target)) || ''
    toast(p ? `已打开：${p}` : '已打开库目录', 'ok')
  } catch (e) { toast(e.message || '打开失败', 'err') }
}

async function openLibrary() {
  await loadLibrary()
  const search = h('input', { class: 'input', placeholder: '搜索 modid 或名称' })
  const addModid = h('input', { class: 'input mono', placeholder: 'modid，例如 sodium' })
  const addName = h('input', { class: 'input', placeholder: '显示名称（可选）' })
  const addNote = h('input', { class: 'input', placeholder: '备注（可选）' })
  const tableWrap2 = h('div', { class: 'scroll-y', style: { maxHeight: '380px', border: '1px solid var(--line)', borderRadius: '8px' } })
  const countEl = h('span', { class: 'muted' }, '')

  // 拉取系统信息，显示库文件真实路径
  let clientModsDir = ''
  try { const info = await api.get('/api/system/info'); clientModsDir = info.clientModsDir || '' } catch {}
  const clientModsFile = clientModsDir ? clientModsDir.replace(/[\\/]+$/, '') + (window.navigator.platform.toLowerCase().includes('win') ? '\\' : '/') + 'clientmods.json' : ''

  const pathBox = h('div', { class: 'mono muted', style: { fontSize: '12px', padding: '6px 8px', background: 'var(--bg-2, transparent)', borderRadius: '6px', wordBreak: 'break-all' } },
    h('span', {}, '💡 库文件位置：'),
    clientModsFile
      ? h('span', { style: { userSelect: 'text' } }, clientModsFile)
      : h('span', {}, '（未获取到）'),
    h('span', { style: { marginLeft: '6px' } }),
    h('button', { class: 'btn btn-xs', style: { marginLeft: '8px', padding: '2px 8px' }, onclick: () => openModsDir() }, '📂 打开此目录')
  )

  function renderTable() {
    const q = search.value.trim().toLowerCase()
    const rows = state.library.filter((x) => !q || x.modid.toLowerCase().includes(q) || (x.name || '').toLowerCase().includes(q))
    clear(tableWrap2)
    const table = h('table', { class: 'tbl' }, h('thead', {}, h('tr', {},
      h('th', {}, 'modid'), h('th', {}, '名称'), h('th', {}, '备注'), h('th', {}, '来源'), h('th', { style: { width: '60px' } }, '操作'))))
    const tbody = h('tbody')
    for (const it of rows.slice(0, 400)) {
      tbody.appendChild(h('tr', {},
        h('td', { class: 'mono' }, it.modid),
        h('td', {}, it.name || '-'),
        h('td', { class: 'muted' }, it.note || '-'),
        h('td', {}, h('span', { class: 'pill' }, it.source === 'builtin' ? '内置' : '自定义')),
        h('td', {}, h('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
          if (ctxRef.settings().general.confirmDanger !== false && !(await confirmDialog(`确定删除记录「${it.modid}」？`, { danger: true }))) return
          await api.del('/api/mods/client-list/' + it.id)
          toast('已删除', 'ok')
          await loadLibrary()
          renderTable()
        } }, '删除'))))
    }
    table.appendChild(tbody)
    tableWrap2.appendChild(table)
    countEl.textContent = `共 ${state.library.length} 条 · 当前显示 ${rows.length} 条`
  }

  async function add() {
    const modid = addModid.value.trim()
    if (!modid) {
      toast('请填写 modid', 'err')
      return
    }
    try {
      const r = await api.post('/api/mods/client-list', { modid, name: addName.value.trim(), note: addNote.value.trim() })
      if (r.error) {
        toast(r.error, 'err')
        return
      }
      addModid.value = ''
      addName.value = ''
      addNote.value = ''
      await loadLibrary()
      renderTable()
      toast('已添加：' + modid, 'ok')
    } catch (e) {
      toast('添加失败：' + e.message, 'err')
    }
  }

  search.oninput = renderTable

  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    pathBox,
    h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, search), countEl),
    h('div', { class: 'section', style: { padding: '10px' } },
      h('div', { class: 'muted', style: { marginBottom: '6px' } }, '新增记录：按 modid 精确匹配（忽略大小写）'),
      h('div', { class: 'row wrap' }, h('div', { class: 'grow', style: { minWidth: '150px' } }, addModid),
        h('div', { class: 'grow', style: { minWidth: '140px' } }, addName),
        h('div', { class: 'grow', style: { minWidth: '140px' } }, addNote),
        h('button', { class: 'btn btn-primary btn-sm', onclick: add }, '＋ 添加'))),
    tableWrap2)

  const modal = openModal({
    title: '仅客户端 mod 库',
    size: 'lg',
    body,
    buttons: [{ label: '重新扫描目录', onClick: () => { modal.close(); scan() } }, { label: '关闭', class: 'btn-primary' }]
  })
  renderTable()
}

// ---------------- 展开视图：大屏「仅客户端 mod 库」管理 ----------------
function c2sExpanded(container, ctx) {
  const settings = (ctx && ctx.settings ? ctx.settings() : ctxRef?.settings()) || {}
  container.appendChild(h('div', { class: 'row' },
    h('b', { style: { fontSize: '14px' } }, '仅客户端 mod 库'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn btn-sm', onclick: async () => { try { await api.post('/api/system/open-path', { which: 'clientModsDir' }) } catch (e) { toast(e.message || '打开失败', 'err') } } }, '📂 打开库目录')))

  const search = h('input', { class: 'input', placeholder: '搜索 modid 或名称' })
  const addModid = h('input', { class: 'input mono', placeholder: 'modid，例如 sodium' })
  const addName = h('input', { class: 'input', placeholder: '显示名称（可选）' })
  const addNote = h('input', { class: 'input', placeholder: '备注（可选）' })
  const countEl = h('span', { class: 'muted' }, '')
  const tableWrap = h('div', { class: 'scroll-y', style: { maxHeight: '54vh', border: '1px solid var(--line)', borderRadius: '8px' } })
  let items = []

  const btnAdd = h('button', { class: 'btn btn-primary btn-sm' }, '＋ 添加')
  btnAdd.onclick = async () => {
    const modid = addModid.value.trim()
    if (!modid) { toast('请输入 modid', 'err'); return }
    try {
      const r = await api.post('/api/mods/client-list', { modid, name: addName.value.trim(), note: addNote.value.trim() })
      if (r.error) { toast(r.error, 'err'); return }
      addModid.value = ''; addName.value = ''; addNote.value = ''
      await load()
    } catch (e) { toast('添加失败：' + e.message, 'err') }
  }
  addModid.onkeydown = (e) => { if (e.key === 'Enter') btnAdd.click() }
  search.oninput = () => render()

  container.appendChild(h('div', { class: 'row wrap', style: { margin: '10px 0 8px' } },
    h('div', { class: 'grow', style: { minWidth: '150px' } }, search), countEl))
  container.appendChild(h('div', { class: 'section', style: { padding: '10px' } },
    h('div', { class: 'muted', style: { marginBottom: '6px', fontSize: '12px' } }, '新增记录：按 modid 精确匹配（忽略大小写），库文件可直接编辑 / 分享'),
    h('div', { class: 'row wrap' },
      h('div', { class: 'grow', style: { minWidth: '150px' } }, addModid),
      h('div', { class: 'grow', style: { minWidth: '140px' } }, addName),
      h('div', { class: 'grow', style: { minWidth: '140px' } }, addNote),
      btnAdd)))
  container.appendChild(tableWrap)

  async function load() {
    try {
      const data = await api.get('/api/mods/client-list')
      items = data.items || []
      render()
    } catch (e) { toast('加载库失败：' + e.message, 'err') }
  }

  function render() {
    clear(tableWrap)
    const q = search.value.trim().toLowerCase()
    const list = q ? items.filter((it) => (it.modid + ' ' + (it.name || '')).toLowerCase().includes(q)) : items
    countEl.textContent = list.length + ' / ' + items.length + ' 条'
    if (!list.length) { tableWrap.appendChild(h('div', { class: 'muted center', style: { padding: '30px 0' } }, '（空）')); return }
    for (const it of list) {
      const name = h('input', { class: 'input', value: it.name || '', style: { width: '150px' } })
      const note = h('input', { class: 'input', value: it.note || '', style: { minWidth: '170px', flex: '1' } })
      const btnSave = h('button', { class: 'btn btn-sm btn-primary', style: { display: 'none' }, onclick: async () => {
        try {
          await api.put('/api/mods/client-list/' + it.id, { name: name.value.trim(), note: note.value.trim() })
          await load()
        } catch (e) { toast('保存失败：' + e.message, 'err') }
      } }, '保存')
      const btnEdit = h('button', { class: 'btn btn-sm', onclick: () => { btnEdit.style.display = 'none'; btnSave.style.display = '' } }, '编辑')
      const btnDel = h('button', { class: 'btn btn-sm btn-danger', onclick: async () => {
        if (!(await confirmDialog('删除「' + (it.name || it.modid) + '」？仅从库中移除，不影响本地文件。', { danger: true }))) return
        try {
          await api.del('/api/mods/client-list/' + it.id)
          await load()
        } catch (e) { toast('删除失败：' + e.message, 'err') }
      } }, '删除')
      tableWrap.appendChild(h('div', { class: 'feature-item', style: { padding: '7px 9px' } },
        h('div', { class: 'fi-main' },
          h('div', { class: 'row' }, h('b', { class: 'mono', style: { fontSize: '12px' } }, it.modid),
            h('span', { class: 'badge' }, it.source === 'builtin' ? '内置' : '自定义')),
          h('div', { class: 'row wrap', style: { marginTop: '4px', gap: '6px' } },
            h('label', { class: 'muted', style: { fontSize: '11px' } }, '名称'), name,
            h('label', { class: 'muted', style: { fontSize: '11px' } }, '备注'), note)),
        h('div', { class: 'row', style: { gap: '6px' } }, btnEdit, btnSave, btnDel)))
    }
  }

  load()
}
