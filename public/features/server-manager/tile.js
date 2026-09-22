import { h, clear, fmtBytes } from '/js/core/dom.js'
import { api } from '/js/core/api.js'
import { pickDir, pickFile } from '/js/core/dirpicker.js'
import { toast } from '/js/core/toast.js'
import { confirmDialog, openModal } from '/js/core/modal.js'

let timer = null
let removeDropGuards = null
let retained = { inspection: null, sessionId: '', corePath: '' }
const labels = { starting: '启动中', running: '运行中', stopping: '正在保存并停止', stopped: '已停止', failed: '启动失败 / 异常退出' }

export default {
  renderExpanded(container, { ctx }) {
    const original = ctx.body
    const nodes = [...original.childNodes]
    container.append(...nodes)
    const observer = new MutationObserver(() => {
      if (!container.isConnected) { original.append(...nodes); observer.disconnect() }
    })
    observer.observe(document.body, { childList: true, subtree: true })
  },
  unmount() { clearInterval(timer); timer = null; removeDropGuards?.(); removeDropGuards = null },
  async mount(ctx) {
    clearInterval(timer)
    let inspection = retained.inspection, sessionId = retained.sessionId, corePath = retained.corePath
    let preparing = false, submitting = false, currentStatus = '', prepId = '', xhr = null, cancelling = false, after = 0, javaSerial = 0
    let pendingSource = '', pendingFile = null
    const input = (placeholder, value = '') => h('input', { class: 'input mono', placeholder, value })
    const field = (label, control) => h('label', { class: 'field', style: { display: 'block', flex: '1 1 160px', minWidth: '0', margin: '0' } }, h('span', {}, label), control)
    const row = (...children) => h('div', { class: 'row wrap', style: { marginTop: '8px', alignItems: 'flex-end' } }, ...children)
    const directory = input('选择或拖入服务端包 / 文件夹'); directory.readOnly = true
    const destination = input('压缩包解压位置（留空由工具箱管理）'); destination.readOnly = true
    const plan = h('select', { class: 'input', 'aria-label': '服务端启动入口' }, h('option', { value: '' }, '请先导入服务端'))
    const mc = input('识别后自动填写')
    const java = input('留空：优先随包 Java，其次本机兼容 Java'); java.readOnly = true
    const javaHint = h('div', { class: 'muted', style: { overflowWrap: 'anywhere' }, 'aria-live': 'polite' }, '先识别 Minecraft 版本，再检查 Java。')
    const memory = h('input', { class: 'input mono', type: 'number', min: '1', max: '256', value: '4' })
    const minMemory = h('input', { class: 'input mono', type: 'number', min: '1', max: '256', value: '1' })
    const optimization = h('select', { class: 'input', 'aria-label': '启动优化方案' },
      h('option', { value: 'original' }, '保留原包参数（默认）'), h('option', { value: 'g1' }, 'G1 保守优化'), h('option', { value: 'custom' }, '原包参数 + 自定义参数'))
    const jvmArgs = input('例如 -Dfile.encoding=UTF-8')
    const serverArgs = input('追加服务端参数（默认已含 nogui）')
    const port = input('25565', '25565'); port.type = 'number'; port.min = '1'; port.max = '65535'
    const host = input('留空：所有网卡')
    const players = input('20', '20'); players.type = 'number'
    const online = h('select', { class: 'input', 'aria-label': '正版验证' }, h('option', { value: 'true' }, '开启'), h('option', { value: 'false' }, '关闭'))
    const eula = h('input', { type: 'checkbox' })
    const eulaLabel = h('label', { class: 'row wrap', style: { marginTop: '8px' } }, eula, '我已阅读并同意 ', h('a', { href: 'https://www.minecraft.net/eula', target: '_blank', rel: 'noopener' }, 'Minecraft EULA'))
    const hint = h('div', { class: 'muted', style: { overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', lineHeight: '1.6' }, 'aria-live': 'polite' }, '拖入或选择后只暂存文件，不会立即解压。先选择解压位置，再点击“开始识别并导入”；导入后还要核对参数并点击启动。')
    const status = h('div', { class: 'muted', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }, 'aria-live': 'polite' }, '未启动')
    const progressBar = h('i', { style: { width: '0%' } })
    const progress = h('div', { class: 'bar', style: { display: 'none' } }, progressBar)
    const log = h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '320px', minHeight: '100px', overflow: 'auto', background: 'var(--bg)', padding: '8px', borderRadius: '8px', fontSize: '12px' }, 'aria-label': '服务端实时日志' })
    const command = input('输入控制台命令，例如 list（不用 /）')
    const sessions = h('select', { class: 'input', 'aria-label': '查看服务端会话' }, h('option', { value: '' }, '选择已有运行会话'))
    const editable = [plan, mc, java, memory, minMemory, optimization, jvmArgs, serverArgs, port, host, players, online, eula]
    const setPending = (source, file = null) => {
      pendingSource = source || ''
      pendingFile = file || null
      directory.value = source || file?.name || ''
      directory.title = source || file?.name || ''
      inspection = null; retained.inspection = null; corePath = ''; retained.corePath = ''
      clear(plan); plan.appendChild(h('option', { value: '' }, '请先开始识别'))
      status.textContent = '文件已暂存，等待开始识别并导入。'
      hint.textContent = file ? `已暂存文件：${file.name}\n请选择解压位置（可留空），然后点击“开始识别并导入”；此时还没有上传或解压。` : `已暂存路径：${source}\n确认路径和解压位置后，点击“开始识别并导入”。`
      controls()
    }
    const pickPackage = h('button', { class: 'btn btn-sm', onclick: async () => { const file = await pickFile('', { title: '选择服务端 ZIP 或核心 JAR', exts: ['.zip', '.mrpack', '.jar'] }); if (file) setPending(file) } }, '选择服务端包')
    const pickFolder = h('button', { class: 'btn btn-sm', onclick: async () => { const dir = await pickDir('', { title: '选择已有服务端文件夹' }); if (dir) setPending(dir) } }, '选择文件夹')
    const pickDestination = h('button', { class: 'btn btn-sm', onclick: async () => { const dir = await pickDir(destination.value, { title: '选择解压位置（将在里面新建服务端目录）' }); if (dir) destination.value = dir } }, '解压位置')
    const pickCore = h('button', { class: 'btn btn-sm', onclick: async () => {
      const file = await pickFile(inspection?.root || '', { title: '选择要调用的服务端核心', exts: ['.jar'] })
      if (file) { corePath = file; retained.corePath = file; await prepare(inspection?.root || file, null, true) }
    } }, '选择核心 JAR')
    const beginImport = h('button', { class: 'btn btn-primary btn-sm', onclick: beginImportNow }, '开始识别并导入')
    const pickJava = h('button', { class: 'btn btn-sm', onclick: async () => { const file = await pickFile('', { title: '选择兼容 Java', exts: ['.exe'] }); if (file) { java.value = file; checkJava() } } }, '选择 Java')
    const autoJava = h('button', { class: 'btn btn-sm', onclick: () => { java.value = ''; checkJava() } }, '自动匹配')
    const btnStart = h('button', { class: 'btn btn-primary btn-sm', onclick: launchServer }, '▶ 启动服务端')
    const stop = h('button', { class: 'btn btn-sm', onclick: async () => { try { await api.post(`/api/server-manager/sessions/${sessionId}/stop`); await poll() } catch (e) { toast(e.message, 'err') } } }, '■ 正常停服')
    const force = h('button', { class: 'btn btn-danger btn-sm', onclick: async () => {
      if (!(await confirmDialog('强制停止可能丢失尚未保存的世界数据。确定强制停止这个服务端？', { danger: true }))) return
      try { await api.post(`/api/server-manager/sessions/${sessionId}/stop`, { force: true }); await poll() } catch (e) { toast(e.message, 'err') }
    } }, '强制停止')
    const cancel = h('button', { class: 'btn btn-sm btn-danger', style: { display: 'none' }, onclick: async () => {
      cancelling = true; cancel.disabled = true
      if (xhr) xhr.abort()
      if (prepId) await api.post(`/api/server-manager/prepare/${prepId}/cancel`).catch(e => toast(e.message, 'err'))
    } }, '中止导入')
    const send = h('button', { class: 'btn btn-sm', onclick: async () => {
      try { await api.post(`/api/server-manager/sessions/${sessionId}/command`, { command: command.value }); command.value = ''; await poll() } catch (e) { toast(e.message, 'err') }
    } }, '发送命令')
    command.onkeydown = event => { if (event.key === 'Enter') send.click() }
    const drop = h('div', { class: 'drop-zone', tabindex: '0' }, '拖入服务端 ZIP / .mrpack / 核心 JAR，或点击选择')
    drop.onclick = () => pickPackage.click()
    drop.onkeydown = event => { if (event.key === 'Enter') pickPackage.click() }
    drop.ondragover = event => { event.preventDefault(); drop.classList.add('over') }
    drop.ondragleave = () => drop.classList.remove('over')
    drop.ondrop = event => {
      event.preventDefault(); drop.classList.remove('over')
      if (preparing || submitting || ['starting', 'running', 'stopping'].includes(currentStatus)) return
      const file = event.dataTransfer?.files?.[0]
      if (file?.path) setPending(file.path)
      else if (file && /\.(zip|mrpack|jar)$/i.test(file.name)) setPending('', file)
      else toast('请拖入 ZIP / .mrpack / JAR；文件夹请使用“选择文件夹”', 'err')
    }
    const advanced = h('details', {}, h('summary', { style: { cursor: 'pointer', marginTop: '10px' } }, '更多启动参数与网络设置'),
      row(field('自定义 JVM 参数（不含 -Xms / -Xmx）', jvmArgs)), row(field('追加服务端参数', serverArgs)),
      row(field('服务端端口', port), field('监听 IP', host)), row(field('最大玩家数', players), field('正版验证', online)),
      h('div', { class: 'muted' }, 'G1 预设仅调整垃圾回收选项，不保证每个整合包都会更快；有专用参数的整合包建议先保留原包配置。'))
    ctx.body.append(drop, row(directory), row(pickPackage, pickFolder, pickCore, beginImport), row(destination, pickDestination),
      hint, row(field('启动入口 / 核心', plan)), row(field('Minecraft 版本', mc)),
      row(field('最大内存（GB）', memory), field('初始内存（GB）', minMemory)),
      row(field('启动优化', optimization)), row(field('Java 路径', java)), row(pickJava, autoJava), javaHint,
      advanced, eulaLabel, row(btnStart, stop, force, cancel), status, progress,
      row(sessions, h('button', { class: 'btn btn-sm', onclick: refreshSessions }, '刷新会话')),
      log, row(command, send), row(
        h('button', { class: 'btn btn-sm', onclick: () => openModal({ title: '服务端实时日志', size: 'lg', body: h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: '65vh', overflow: 'auto' } }, log.textContent) }) }, '放大当前日志'),
        h('button', { class: 'btn btn-sm', onclick: async () => { const root = inspection?.root; if (root) await api.post('/api/fs/open', { path: root }) } }, '打开服务端目录')),
      h('div', { class: 'muted', style: { marginTop: '8px' } }, '关闭工具箱会发送正常停服命令并等待保存；超过 45 秒仍未退出将终止进程。重要世界请先正常停服，再关闭工具箱。'))

    function controls() {
      const active = ['starting', 'running', 'stopping'].includes(currentStatus)
      for (const el of [...editable, pickPackage, pickFolder, pickCore, pickJava, autoJava, pickDestination]) el.disabled = preparing || submitting || active
      beginImport.disabled = preparing || submitting || active || (!pendingSource && !pendingFile)
      btnStart.disabled = preparing || submitting || active || !inspection || !plan.value
      stop.disabled = !active || currentStatus === 'stopping'; force.disabled = !active
      send.disabled = !active || currentStatus === 'stopping'; command.disabled = send.disabled
      cancel.style.display = preparing ? '' : 'none'
      sessions.disabled = preparing || submitting
    }
    function setProgress(value) {
      progress.style.display = ''
      progress.classList.toggle('indeterminate', value == null)
      progressBar.style.width = value == null ? '35%' : `${Math.max(0, Math.min(100, value))}%`
    }
    function applyPlan() {
      const selected = inspection?.plans.find(item => item.id === plan.value)
      if (!selected) { controls(); return }
      mc.value = selected.runtime?.mc || ''
      java.value = selected.javaPath || ''
      if (selected.memory && /G$/i.test(selected.memory)) memory.value = parseInt(selected.memory, 10)
      if (selected.minMemory && /G$/i.test(selected.minMemory)) minMemory.value = parseInt(selected.minMemory, 10)
      const args = selected.jvm?.join(' ') || '无附加 JVM 参数'
      hint.textContent = `服务端目录：${inspection.root}\n识别 ${inspection.modCount} 个模组；按规模建议最大 ${inspection.recommendedMemory} GB，可按实测调整。\n原包 JVM 参数：${args}\n${selected.missingCore ? `启动脚本引用的核心不存在：${selected.args[selected.args.indexOf('-jar') + 1] || ''}。请点击“选择核心 JAR”，不会自动把安装器当核心。\n` : ''}${inspection.warnings.join('\n')}`
      controls(); checkJava()
    }
    function showInspection(value) {
      inspection = value; retained.inspection = value
      directory.value = value.root; directory.title = value.root
      clear(plan); plan.appendChild(h('option', { value: '' }, value.plans.length ? '选择启动入口' : '未找到可启动核心，请选择核心 JAR'))
      for (const item of value.plans) plan.appendChild(h('option', { value: item.id }, item.label))
      plan.value = value.selected || ''
      memory.value = value.recommendedMemory || 4; minMemory.value = 1
      port.value = value.properties['server-port'] || '25565'; host.value = value.properties['server-ip'] || ''
      players.value = value.properties['max-players'] || '20'; online.value = value.properties['online-mode'] === 'false' ? 'false' : 'true'
      eula.checked = value.eulaAccepted
      applyPlan()
      const s = value.settings
      if (s && value.plans.some(item => item.id === s.planId)) {
        plan.value = s.planId; applyPlan()
        mc.value = s.mc || mc.value; java.value = s.javaPath || ''
        memory.value = parseInt(s.memory, 10) || memory.value; minMemory.value = parseInt(s.minMemory, 10) || 1
        optimization.value = s.optimization || 'original'; jvmArgs.value = s.jvmArgs || ''; serverArgs.value = s.serverArgs || ''
      }
      if (!value.plans.length || !plan.value) hint.textContent = `服务端目录：${value.root}\n${value.plans.length ? '发现多个启动入口，请明确选择，避免运行错误版本。' : '未找到可以直接启动的核心；安装器不能当作服务端核心。请先安装核心，或点击“选择核心 JAR”。'}\n${value.warnings.join('\n')}`
      controls(); checkJava()
    }
    plan.onchange = applyPlan; mc.onchange = checkJava
    async function checkJava() {
      const serial = ++javaSerial, selected = inspection?.plans.find(item => item.id === plan.value)
      if (!inspection || !mc.value || !selected) { javaHint.textContent = '请先选择核心并补全 MC 版本。'; return }
      javaHint.textContent = '正在检查随包及本机 Java…'
      try {
        const result = await api.post('/api/server-manager/java', { root: inspection.root, runtime: { ...selected.runtime, mc: mc.value }, javaPath: java.value })
        if (serial === javaSerial) javaHint.textContent = `Java ${result.major}（64 位）：${result.path}`
      } catch (e) { if (serial === javaSerial) javaHint.textContent = e.message }
    }
    async function beginImportNow() {
      if (!pendingSource && !pendingFile) { toast('请先选择或拖入服务端包 / 文件夹', 'err'); return }
      const source = pendingSource, file = pendingFile
      pendingSource = ''; pendingFile = null
      await prepare(source, file)
    }
    async function prepare(source, file = null, keepCore = false) {
      if (preparing || submitting || ['starting', 'running', 'stopping'].includes(currentStatus)) return
      preparing = true; cancelling = false; cancel.disabled = false; controls()
      if (!keepCore) { corePath = ''; retained.corePath = '' }
      status.textContent = file ? '正在上传服务端文件…' : '正在导入服务端…'; setProgress(null)
      try {
        const job = file ? await upload(file) : await api.post('/api/server-manager/prepare', { source, destination: destination.value, corePath })
        prepId = job.id
        if (cancelling) await api.post(`/api/server-manager/prepare/${prepId}/cancel`)
        for (;;) {
          const current = await api.get(`/api/server-manager/prepare/${prepId}`)
          setProgress(current.progress)
          status.textContent = current.detail + (current.progress == null ? '' : `（${Math.floor(current.progress)}%）`)
          if (current.status === 'done') { sessionId = ''; retained.sessionId = ''; currentStatus = ''; showInspection(current.result); break }
          if (['failed', 'cancelled'].includes(current.status)) throw new Error(current.error || current.detail)
          await new Promise(resolve => setTimeout(resolve, 400))
        }
      } catch (e) { status.textContent = e.message; toast(e.message, cancelling ? 'warn' : 'err') }
      finally { preparing = false; prepId = ''; xhr = null; controls() }
    }
    function upload(file) {
      if (file.size > 2 * 1024 ** 3) throw new Error('压缩包超过 2 GB，请先解压并选择文件夹')
      return new Promise((resolve, reject) => {
        xhr = new XMLHttpRequest(); xhr.open('POST', '/api/server-manager/upload?' + new URLSearchParams({ destination: destination.value }))
        xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name))
        xhr.upload.onprogress = event => { setProgress(event.lengthComputable ? event.loaded / event.total * 100 : null); status.textContent = `上传到本机：${fmtBytes(event.loaded)} / ${fmtBytes(event.total || file.size)}` }
        xhr.upload.onload = () => { status.textContent = '上传完成，正在创建导入任务…'; setProgress(null) }
        xhr.onabort = () => reject(new Error('已中止上传'))
        xhr.onerror = () => reject(new Error('上传失败'))
        xhr.onload = () => { try { const result = JSON.parse(xhr.responseText); if (result.error || xhr.status >= 400) reject(new Error(result.error || '上传失败')); else resolve(result) } catch { reject(new Error('上传响应无效')) } }
        xhr.send(file)
      })
    }
    async function launchServer() {
      if (!inspection || !plan.value || submitting) return
      if (!Number.isInteger(Number(memory.value)) || !Number.isInteger(Number(minMemory.value))) { toast('内存请填写整数 GB', 'err'); return }
      if (!eula.checked) { toast('请先阅读并确认 Minecraft EULA', 'err'); return }
      submitting = true; controls(); status.textContent = '正在校验核心、Java、内存和端口…'; setProgress(null)
      try {
        const result = await api.post('/api/server-manager/start', { root: inspection.root, corePath, planId: plan.value, mc: mc.value.trim(), javaPath: java.value, memory: memory.value + 'G', minMemory: minMemory.value + 'G', optimization: optimization.value, jvmArgs: jvmArgs.value, serverArgs: serverArgs.value, port: Number(port.value), host: host.value, maxPlayers: Number(players.value), onlineMode: online.value === 'true', acceptEula: eula.checked })
        sessionId = result.id; retained.sessionId = sessionId; after = 0; log.textContent = ''; await poll(); await refreshSessions()
      } catch (e) { status.textContent = e.message; progress.style.display = 'none'; toast(e.message, 'err') }
      finally { submitting = false; controls() }
    }

    // 文件拖到页面其他位置时，浏览器默认会打开/下载文件；只允许本磁贴的 drop-zone 接收。
    const preventOutsideFileDrop = event => {
      const files = event.dataTransfer?.files
      if (!files?.length) return
      if (!event.target.closest?.('.drop-zone')) { event.preventDefault(); event.stopPropagation() }
    }
    document.addEventListener('dragover', preventOutsideFileDrop, true)
    document.addEventListener('drop', preventOutsideFileDrop, true)
    removeDropGuards = () => {
      document.removeEventListener('dragover', preventOutsideFileDrop, true)
      document.removeEventListener('drop', preventOutsideFileDrop, true)
    }
    let polling = false
    async function poll() {
      if (!sessionId || polling) return
      polling = true
      try {
        const result = await api.get(`/api/server-manager/sessions/${sessionId}?after=${after}`)
        currentStatus = result.status
        status.textContent = `${labels[result.status] || result.status} · ${Math.floor(result.elapsed / 1000)} 秒 · 端口 ${result.port}`
        if (result.status === 'starting' || result.status === 'stopping') setProgress(null)
        else progress.style.display = 'none'
        if (result.logs.length) {
          const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 70
          log.textContent = (log.textContent + result.logs.map(line => line.text).join('\n') + '\n').slice(-180000)
          after = result.logs.at(-1).seq
          if (follow) log.scrollTop = log.scrollHeight
        }
        controls()
      } catch (e) { status.textContent = '日志读取失败：' + e.message }
      finally { polling = false }
    }
    async function refreshSessions() {
      try {
        const result = await api.get('/api/server-manager/sessions')
        clear(sessions); sessions.appendChild(h('option', { value: '' }, '选择已有运行会话'))
        for (const item of result.items) sessions.appendChild(h('option', { value: item.id }, `${labels[item.status]} · ${item.root}`))
        sessions.value = sessionId
      } catch (e) { toast(e.message, 'err') }
    }
    sessions.onchange = async () => {
      if (!sessions.value) return
      sessionId = sessions.value; retained.sessionId = sessionId; after = 0; log.textContent = ''
      const current = await api.get(`/api/server-manager/sessions/${sessionId}`)
      corePath = current.settings.corePath || ''; retained.corePath = corePath
      const value = await api.post('/api/server-manager/inspect', { source: current.root, corePath })
      showInspection({ ...value, settings: current.settings }); await poll()
    }
    if (inspection) showInspection(inspection)
    controls(); await refreshSessions(); await poll()
    timer = setInterval(poll, 1000)
  }
}
