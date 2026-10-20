// 开服管理 — 控制台优先视图。
// 行为契约与旧版一致：只暂存文件，导入由后端 prepare 任务完成；启动、停服、
// 会话、日志与控制台命令仍然走 /api/server-manager/*，不新增任何接口。
import { javaDownloadButton } from '/js/core/java-download.js'
import { h, clear, fmtBytes } from '/js/core/dom.js'
import { api } from '/js/core/api.js'
import { pickDir, pickFile } from '/js/core/dirpicker.js'
import { toast } from '/js/core/toast.js'
import { confirmDialog, openModal } from '/js/core/modal.js'
import { icon } from '/js/ui/icons.js'
import { btn, field, input, select, progress, logViewer } from '/js/ui/kit.js'

const LABELS = {
  starting: '启动中',
  running: '运行中',
  stopping: '正在保存并停止',
  stopped: '已停止',
  failed: '启动失败 / 异常退出'
}
const ACTIVE = ['starting', 'running', 'stopping']
const LOG_LIMIT = 180000
const DROP_HINT = '请拖入 ZIP / .mrpack / JAR；文件夹请使用“选择文件夹”'

// 磁贴卸载后重新展开时保留上次识别结果与会话；与旧版一致。
const retained = { inspection: null, sessionId: '', corePath: '' }
const disposers = new Set()

export default {
  async mount(ctx) {
    if (ctx) buildConsole(ctx, ctx.body, { expanded: false })
  },
  unmount() {
    for (const dispose of [...disposers]) dispose()
  },
  renderExpanded(container, { ctx } = {}) {
    if (ctx) buildConsole(ctx, container, { expanded: true })
  }
}

function buildConsole(ctx, container, { expanded }) {
  let inspection = retained.inspection
  let sessionId = retained.sessionId
  let corePath = retained.corePath
  let preparing = false
  let submitting = false
  let currentStatus = ''
  let prepId = ''
  let xhr = null
  let cancelling = false
  let after = 0
  let javaSerial = 0
  let pendingSource = ''
  let pendingFile = null
  let polling = false
  let dead = false
  let disposed = false
  let timer = null
  let observer = null
  let removeDropGuards = null
  let elapsedMs = 0
  let currentPort = null
  let prepPercent = null
  let logText = ''

  const option = (value, label) => h('option', { value }, label)
  const locked = () => preparing || submitting || ACTIVE.includes(currentStatus)
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

  /* ---------------- 状态条 ---------------- */
  const stateDot = h('span', { class: 'dot' })
  const stateText = h('b', { style: { fontSize: 'var(--fs-15)', fontWeight: '600', letterSpacing: '-.01em' } }, '未启动')
  const metaText = h('span', { class: 'mono', hidden: true })
  const errorText = h('span', { class: 'fx-danger', hidden: true })
  const statusBadge = h('span', { class: 'badge info', hidden: true })
  const statusLine = h('div', { class: 'sm-statusline', 'aria-live': 'polite' },
    stateDot, stateText, metaText, h('span', { class: 'spacer' }), errorText, statusBadge)

  const inputHintText = h('span', {})
  const inputHintEl = h('div', { class: 'fx-warn', hidden: true }, icon('info', { size: 12 }), inputHintText)
  const activity = h('div', { class: 'sm-import-hint', 'aria-live': 'polite', hidden: true })

  const bar = progress(0)
  const barWrap = h('div', { class: 'sm-progress', hidden: true }, bar.el)

  /* ---------------- 控制台输入与按钮 ---------------- */
  const command = input({
    placeholder: '输入控制台命令，例如 list（不用 /）',
    mono: true,
    onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); void sendCommand() } }
  })
  command.style.flex = '1'

  const btnStart = btn('启动服务端', { size: 'sm', variant: 'primary', iconName: 'play', onClick: () => { void launchServer() } })
  const btnStop = btn('正常停服', { size: 'sm', iconName: 'stop', onClick: () => { void stopSession(false) } })
  const btnForce = btn('强制停止', { size: 'sm', variant: 'danger', iconName: 'bolt', onClick: () => { void stopSession(true) } })
  const btnLog = btn('放大当前日志', { size: 'sm', iconName: 'expand', onClick: openLogModal })
  const btnOpenDir = btn('打开服务端目录', { size: 'sm', iconName: 'folder-open', onClick: () => { void openServerDir() } })
  const btnRefresh = btn('刷新会话', { size: 'sm', iconName: 'refresh', onClick: () => { void refreshSessions() } })
  const btnSend = btn('发送命令', { size: 'sm', iconName: 'command', onClick: () => { void sendCommand() } })
  const cancel = btn('中止导入', {
    size: 'sm',
    variant: 'danger',
    iconName: 'x-circle',
    onClick: () => { void cancelImport() }
  })
  cancel.style.display = 'none'

  const btnbar = h('div', { class: 'sm-btnbar' },
    btnStart, btnStop, btnForce, cancel,
    h('span', { class: 'spacer' }),
    btnLog, btnOpenDir
  )

  /* ---------------- 日志 ---------------- */
  const log = logViewer({
    title: expanded ? '服务端控制台 · 实时日志' : '服务端控制台',
    height: expanded ? 360 : 150,
    lineNumbers: true,
    maxLines: expanded ? 3000 : 1200,
    ariaLabel: '服务端实时日志'
  })
  log.el.style.height = (expanded ? 360 : 150) + 'px'

  const cmdRow = h('div', { class: 'sm-cmd' }, command, btnSend)

  const sessions = h('select', { class: 'input', 'aria-label': '查看服务端会话' }, option('', '选择已有运行会话'))
  sessions.onchange = () => { void selectSession() }
  const sessionRow = h('div', { class: 'sm-session-row' }, sessions, btnRefresh)

  /* ---------------- 导入向导 ---------------- */
  const directory = input({ placeholder: '选择或拖入服务端包 / 文件夹', readonly: true, mono: true })
  const destination = input({ placeholder: '压缩包解压位置（留空由工具箱管理）', readonly: true, mono: true })

  const pickPackage = btn('选择服务端包', {
    size: 'sm',
    iconName: 'archive',
    onClick: async () => {
      const file = await pickFile('', { title: '选择服务端 ZIP 或核心 JAR', exts: ['.zip', '.mrpack', '.jar'] })
      if (file && !dead) setPending(file)
    }
  })
  const pickFolder = btn('选择文件夹', {
    size: 'sm',
    iconName: 'folder',
    onClick: async () => {
      const dir = await pickDir('', { title: '选择已有服务端文件夹' })
      if (dir && !dead) setPending(dir)
    }
  })
  const pickDestination = btn('解压位置', {
    size: 'sm',
    iconName: 'folder-open',
    onClick: async () => {
      const dir = await pickDir(destination.value, { title: '选择解压位置（将在里面新建服务端目录）' })
      if (dir && !dead) destination.value = dir
    }
  })
  const pickCore = btn('选择核心 JAR', {
    size: 'sm',
    iconName: 'chip',
    onClick: async () => {
      const file = await pickFile(inspection?.root || '', { title: '选择要调用的服务端核心', exts: ['.jar'] })
      if (!file || dead) return
      corePath = file
      retained.corePath = file
      await prepare(inspection?.root || file, null, true)
    }
  })
  const beginImport = btn('开始识别并导入', {
    size: 'sm',
    variant: 'primary',
    iconName: 'cube-scan',
    onClick: () => { void beginImportNow() }
  })

  const importHint = h('div', { class: 'sm-import-hint' },
    '拖入或选择后只暂存文件，不会立即解压。先选择解压位置，再点击“开始识别并导入”；导入后还要核对参数并点击启动。')
  const importStatus = h('div', { class: 'sm-import-hint', 'aria-live': 'polite', hidden: true })
  const importBadge = h('span', { class: 'badge' }, '未选择')

  const stepNodes = ['暂存文件', '识别与导入', '核对并启动'].map((label, index) =>
    h('div', { class: 'wizard-step' }, h('span', { class: 'n' }, String(index + 1)), h('span', { class: 't' }, label)))

  const drop = h('div', {
    class: 'drop-zone',
    tabindex: '0',
    role: 'button',
    'aria-label': '拖入服务端 ZIP、.mrpack 或核心 JAR'
  }, icon('upload', { size: 14 }), h('span', {}, '拖入服务端 ZIP / .mrpack / 核心 JAR，或点击选择'))
  drop.onclick = () => pickPackage.click()
  drop.onkeydown = event => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    pickPackage.click()
  }
  drop.ondragover = event => {
    event.preventDefault()
    if (!locked()) drop.classList.add('over')
  }
  drop.ondragleave = () => drop.classList.remove('over')
  drop.ondrop = handleDrop

  const importPanel = h('details', { class: 'acc' },
    h('summary', {}, icon('upload', { size: 13 }), h('span', {}, '导入服务端'), h('span', { class: 'spacer' }), importBadge),
    h('div', { class: 'acc-body' },
      h('div', { class: 'wizard-steps' }, ...stepNodes),
      drop,
      h('div', { class: 'wizard-panel' },
        field('服务端包 / 文件夹（只读）', directory),
        h('div', { class: 'row wrap', style: { gap: '5px' } }, pickPackage, pickFolder, pickCore),
        field('解压位置（留空由工具箱管理）', destination),
        h('div', { class: 'row wrap', style: { gap: '5px' } }, pickDestination),
        importHint
      ),
      h('div', { class: 'wizard-foot' }, beginImport),
      importStatus
    )
  )
  if (!inspection) importPanel.open = true

  /* ---------------- 启动配置 ---------------- */
  const plan = h('select', { class: 'input', 'aria-label': '服务端启动入口' }, option('', '请先导入服务端'))
  const mc = input({ placeholder: '识别后自动填写', mono: true })
  const java = input({ placeholder: '留空：优先随包 Java，其次本机兼容 Java', readonly: true, mono: true })
  const memory = input({ type: 'number', min: 1, max: 256, value: '4', mono: true })
  const minMemory = input({ type: 'number', min: 1, max: 256, value: '1', mono: true })
  const optimization = select([
    ['original', '保留原包参数（默认）'],
    ['g1', 'G1 保守优化'],
    ['custom', '原包参数 + 自定义参数']
  ], 'original', { ariaLabel: '启动优化方案' })
  const jvmArgs = input({ placeholder: '例如 -Dfile.encoding=UTF-8', mono: true })
  const serverArgs = input({ placeholder: '追加服务端参数（默认已含 nogui）', mono: true })
  const port = input({ placeholder: '25565', value: '25565', type: 'number', min: 1, max: 65535, mono: true })
  const host = input({ placeholder: '留空：所有网卡', mono: true })
  const players = input({ placeholder: '20', value: '20', type: 'number', mono: true })
  const online = select([['true', '开启'], ['false', '关闭']], 'true', { ariaLabel: '正版验证' })
  const eula = h('input', { type: 'checkbox' })
  const eulaRow = h('label', { class: 'sm-eula', style: { gridColumn: '1 / -1' } },
    eula,
    h('span', {}, '我已阅读并同意 ',
      h('a', { href: 'https://www.minecraft.net/eula', target: '_blank', rel: 'noopener' }, 'Minecraft EULA'))
  )

  const planHint = h('div', { class: 'sm-import-hint', 'aria-live': 'polite' })
  const javaHint = h('div', { class: 'sm-import-hint', 'aria-live': 'polite' }, '先识别 Minecraft 版本，再检查 Java。')

  const pickJava = btn('选择 Java', {
    size: 'sm',
    iconName: 'java',
    onClick: async () => {
      const file = await pickFile('', { title: '选择兼容 Java', exts: ['.exe'] })
      if (!file || dead) return
      java.value = file
      checkJava()
    }
  })
  const autoJava = btn('自动匹配', {
    size: 'sm',
    iconName: 'wand',
    onClick: () => {
      if (dead) return
      java.value = ''
      checkJava()
    }
  })
  const javaDownload = javaDownloadButton({
    getRuntime: () => ({ ...inspection?.plans.find(item => item.id === plan.value)?.runtime, mc: mc.value }),
    isLocked: () => preparing || submitting || ACTIVE.includes(currentStatus),
    onReady: path => {
      java.value = path
      checkJava()
    }
  })

  const group = (title, ...children) =>
    h('div', { class: 'col', style: { gap: '6px', minWidth: '0' } }, h('div', { class: 'mini-label' }, title), ...children)

  const coreGroup = group('核心',
    h('div', { class: 'field-grid two' },
      field('启动入口 / 核心', plan),
      field('Minecraft 版本', mc)),
    planHint
  )
  const javaGroup = group('Java 与内存',
    field('Java 路径', java),
    h('div', { class: 'row wrap', style: { gap: '5px' } }, pickJava, autoJava, javaDownload),
    javaHint,
    h('div', { class: 'field-grid two' },
      field('最大内存（GB）', memory),
      field('初始内存（GB）', minMemory))
  )
  const networkGroup = group('网络',
    h('div', { class: 'field-grid two' },
      field('端口', port),
      field('监听 IP', host),
      field('最大玩家数', players),
      field('正版验证', online))
  )
  const argsGroup = group('启动参数',
    field('启动优化', optimization),
    field('自定义 JVM 参数（不含 -Xms / -Xmx）', jvmArgs),
    field('追加服务端参数', serverArgs),
    h('div', { class: 'fx-note' }, 'G1 预设仅调整垃圾回收选项，不保证每个整合包都会更快；有专用参数的整合包建议先保留原包配置。')
  )

  const settingsBadge = h('span', { class: 'badge' }, '未导入')
  const settingsPanel = h('details', { class: 'acc' },
    h('summary', {}, icon('sliders', { size: 13 }), h('span', {}, '设置 · 启动配置'), h('span', { class: 'spacer' }), settingsBadge),
    h('div', {
      class: 'acc-body sm-config',
      style: expanded
        ? { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px', alignItems: 'start' }
        : null
    }, coreGroup, javaGroup, networkGroup, argsGroup, eulaRow)
  )
  if (expanded) settingsPanel.open = true

  /* ---------------- 组装 ---------------- */
  container.append(h('div', { class: 'sm-console' },
    statusLine,
    inputHintEl,
    activity,
    barWrap,
    btnbar,
    h('div', { class: 'sm-logwrap' }, log.el),
    cmdRow,
    sessionRow,
    importPanel,
    settingsPanel,
    h('div', { class: 'fx-note' },
      '关闭工具箱会发送正常停服命令并等待保存；超过 45 秒仍未退出将终止进程。重要世界请先正常停服，再关闭工具箱。')
  ))

  eula.addEventListener('change', updateSettingsBadge)
  plan.onchange = applyPlan
  mc.onchange = checkJava

  /* ---------------- 小工具 ---------------- */
  function setActivity(text, kind = '') {
    if (dead) return
    activity.hidden = !text
    activity.textContent = text || ''
    activity.style.color = kind === 'bad' ? 'var(--redstone)' : kind === 'warn' ? 'var(--gold)' : ''
  }
  function setImportStatus(text) {
    importStatus.hidden = !text
    importStatus.textContent = text || ''
  }
  function setError(text) {
    errorText.hidden = !text
    errorText.textContent = text || ''
  }
  function setInputHint(text) {
    inputHintEl.hidden = !text
    inputHintText.textContent = text || ''
  }
  function setProgress(value) {
    barWrap.hidden = false
    bar.set(value)
    prepPercent = value == null ? null : Number(value)
    renderStatus()
  }
  function hideProgress() {
    barWrap.hidden = true
    prepPercent = null
    renderStatus()
  }
  // logViewer 自身按行裁剪；这里再按字符上限回收最旧的行，避免超长日志撑爆 DOM。
  function trimLogViewer() {
    let guard = 0
    while (log.body.childElementCount > 1 && log.body.textContent.length > LOG_LIMIT && guard++ < 20) {
      const drop = Math.max(1, Math.floor(log.body.childElementCount * 0.15))
      for (let i = 0; i < drop; i++) log.body.firstElementChild?.remove()
    }
  }

  function updateSettingsBadge() {
    let text = '未导入'
    let kind = ''
    if (preparing || submitting) { text = '处理中'; kind = 'info' }
    else if (inspection) {
      if (!eula.checked) { text = '需确认 EULA'; kind = 'warn' }
      else if (sessionId && (currentStatus === 'running' || currentStatus === 'starting')) { text = '运行中'; kind = 'ok' }
      else { text = '参数就绪'; kind = 'ok' }
    }
    settingsBadge.className = 'badge' + (kind ? ' ' + kind : '')
    settingsBadge.textContent = text
  }

  function applyWizard() {
    const staged = !!(pendingSource || pendingFile)
    const index = preparing ? 1 : inspection ? 2 : staged ? 1 : 0
    stepNodes.forEach((node, i) => {
      node.classList.toggle('done', i < index)
      node.classList.toggle('active', i === index)
    })
    importBadge.className = 'badge' + (inspection ? ' ok' : staged ? ' warn' : '')
    importBadge.textContent = preparing ? '导入中' : inspection ? '已识别' : staged ? '待导入' : '未选择'
  }

  function renderStatus() {
    if (dead) return
    const override = preparing ? '正在导入' : submitting ? '正在启动' : ''
    stateText.textContent = override || (sessionId ? (LABELS[currentStatus] || currentStatus || '准备中') : '未启动')
    if (preparing || submitting) stateDot.className = 'dot loading'
    else if (currentStatus === 'running') stateDot.className = 'dot ok'
    else if (currentStatus === 'starting' || currentStatus === 'stopping') stateDot.className = 'dot warn'
    else if (currentStatus === 'failed') stateDot.className = 'dot bad'
    else stateDot.className = 'dot'

    metaText.hidden = !sessionId
    if (sessionId) metaText.textContent = `${Math.max(0, Math.floor(elapsedMs / 1000))} 秒 · 端口 ${currentPort ?? '-'}`

    statusBadge.hidden = !(preparing || submitting)
    if (preparing) {
      statusBadge.className = 'badge info'
      statusBadge.textContent = prepPercent == null ? '导入中' : `导入 ${Math.floor(prepPercent)}%`
    } else if (submitting) {
      statusBadge.className = 'badge warn'
      statusBadge.textContent = '启动中'
    } else {
      statusBadge.textContent = ''
    }

    log.el.style.height = (expanded ? 360 : sessionId ? 240 : 150) + 'px'
    updateSettingsBadge()

    if (!expanded) {
      let badge = ''
      let kind = ''
      if (preparing) { badge = '导入中'; kind = 'info' }
      else if (currentStatus === 'running') { badge = '运行中'; kind = 'ok' }
      else if (currentStatus === 'starting') { badge = '启动中'; kind = 'warn' }
      else if (currentStatus === 'stopping') { badge = '停服中'; kind = 'warn' }
      else if (currentStatus === 'failed') { badge = '异常退出'; kind = 'bad' }
      ctx.setBadge?.(badge, kind)
    }
  }

  function controls() {
    const active = ACTIVE.includes(currentStatus)
    const busy = preparing || submitting || active
    for (const el of [plan, mc, java, memory, minMemory, optimization, jvmArgs, serverArgs, port, host, players, online, eula,
      pickPackage, pickFolder, pickCore, pickJava, autoJava, javaDownload, pickDestination]) {
      el.disabled = busy
    }
    beginImport.disabled = busy || (!pendingSource && !pendingFile)
    btnStart.disabled = busy || !inspection || !plan.value
    btnStop.disabled = !active || currentStatus === 'stopping'
    btnForce.disabled = !active
    // 启动中允许输入：整合包可能在启动阶段等待世界类型编号。
    command.disabled = !(currentStatus === 'starting' || currentStatus === 'running')
    btnSend.disabled = command.disabled
    cancel.style.display = preparing ? '' : 'none'
    sessions.disabled = preparing || submitting
    updateSettingsBadge()
  }

  /* ---------------- 暂存与导入 ---------------- */
  function setPending(source, file = null) {
    pendingSource = source || ''
    pendingFile = file || null
    directory.value = source || file?.name || ''
    directory.title = source || file?.name || ''
    inspection = null
    retained.inspection = null
    corePath = ''
    retained.corePath = ''
    clear(plan)
    plan.appendChild(option('', '请先开始识别'))
    planHint.textContent = ''
    setActivity('')
    setError('')
    setInputHint('')
    setImportStatus('文件已暂存，等待开始识别并导入。')
    importHint.textContent = file
      ? `已暂存文件：${file.name}\n请选择解压位置（可留空），然后点击“开始识别并导入”；此时还没有上传或解压。`
      : `已暂存路径：${source}\n确认路径和解压位置后，点击“开始识别并导入”。`
    importPanel.open = true
    applyWizard()
    controls()
  }

  function handleDrop(event) {
    event.preventDefault()
    drop.classList.remove('over')
    if (locked() || dead) return
    const file = event.dataTransfer?.files?.[0]
    const name = file?.name || (file?.path ? file.path.split(/[\\/]/).pop() : '')
    if (!file || !/\.(zip|mrpack|jar)$/i.test(name)) {
      toast(DROP_HINT, 'err')
      return
    }
    if (file.path) setPending(file.path)
    else setPending('', file)
  }

  async function beginImportNow() {
    if (!pendingSource && !pendingFile) {
      toast('请先选择或拖入服务端包 / 文件夹', 'err')
      return
    }
    const source = pendingSource
    const file = pendingFile
    pendingSource = ''
    pendingFile = null
    await prepare(source, file)
  }

  async function prepare(source, file = null, keepCore = false) {
    if (preparing || submitting || ACTIVE.includes(currentStatus)) return
    preparing = true
    cancelling = false
    cancel.disabled = false
    applyWizard()
    controls()
    renderStatus()
    if (!keepCore) {
      corePath = ''
      retained.corePath = ''
    }
    setError('')
    setImportStatus(file ? '正在上传服务端文件…' : '正在导入服务端…')
    setProgress(null)
    try {
      const job = file
        ? await upload(file)
        : await api.post('/api/server-manager/prepare', { source, destination: destination.value, corePath })
      if (dead || !container.isConnected) return
      prepId = job.id
      if (cancelling) await api.post(`/api/server-manager/prepare/${prepId}/cancel`)
      for (;;) {
        const current = await api.get(`/api/server-manager/prepare/${prepId}`)
        if (dead || !container.isConnected) return
        setProgress(current.progress)
        setImportStatus(current.detail + (current.progress == null ? '' : `（${Math.floor(current.progress)}%）`))
        if (current.status === 'done') {
          sessionId = ''
          retained.sessionId = ''
          currentStatus = ''
          elapsedMs = 0
          currentPort = null
          setError('')
          setActivity('')
          setInputHint('')
          showInspection(current.result)
          hideProgress()
          setImportStatus('识别完成，请核对参数后启动')
          importPanel.open = false
          settingsPanel.open = true
          applyWizard()
          break
        }
        if (['failed', 'cancelled'].includes(current.status)) throw new Error(current.error || current.detail)
        await wait(400)
      }
    } catch (e) {
      if (dead) return
      setImportStatus(e.message)
      toast(e.message, cancelling ? 'warn' : 'err')
      hideProgress()
    } finally {
      preparing = false
      prepId = ''
      xhr = null
      applyWizard()
      controls()
      renderStatus()
      if (!dead) setError('')
    }
  }

  function upload(file) {
    if (file.size > 2 * 1024 ** 3) throw new Error('压缩包超过 2 GB，请先解压并选择文件夹')
    return new Promise((resolve, reject) => {
      xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/server-manager/upload?' + new URLSearchParams({ destination: destination.value }))
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name))
      xhr.upload.onprogress = event => {
        if (dead) return
        setProgress(event.lengthComputable ? event.loaded / event.total * 100 : null)
        setImportStatus(`上传到本机：${fmtBytes(event.loaded)} / ${fmtBytes(event.total || file.size)}`)
      }
      xhr.upload.onload = () => {
        if (dead) return
        setImportStatus('上传完成，正在创建导入任务…')
        setProgress(null)
      }
      xhr.onabort = () => reject(new Error('已中止上传'))
      xhr.onerror = () => reject(new Error('上传失败'))
      xhr.onload = () => {
        try {
          const result = JSON.parse(xhr.responseText)
          if (result.error || xhr.status >= 400) reject(new Error(result.error || '上传失败'))
          else resolve(result)
        } catch {
          reject(new Error('上传响应无效'))
        }
      }
      xhr.send(file)
    })
  }

  async function cancelImport() {
    cancelling = true
    cancel.disabled = true
    if (xhr) xhr.abort()
    if (prepId) await api.post(`/api/server-manager/prepare/${prepId}/cancel`).catch(e => toast(e.message, 'err'))
  }

  /* ---------------- 识别结果 ---------------- */
  function applyPlan() {
    const selected = inspection?.plans.find(item => item.id === plan.value)
    if (!selected) {
      controls()
      return
    }
    mc.value = selected.runtime?.mc || ''
    java.value = selected.javaPath || ''
    if (selected.memory && /G$/i.test(selected.memory)) memory.value = parseInt(selected.memory, 10)
    if (selected.minMemory && /G$/i.test(selected.minMemory)) minMemory.value = parseInt(selected.minMemory, 10)
    const args = selected.jvm?.join(' ') || '无附加 JVM 参数'
    planHint.textContent = `服务端目录：${inspection.root}\n识别 ${inspection.modCount} 个模组；按规模建议最大 ${inspection.recommendedMemory} GB，可按实测调整。\n原包 JVM 参数：${args}\n${selected.missingCore ? `启动脚本引用的核心不存在：${selected.args[selected.args.indexOf('-jar') + 1] || ''}。请点击“选择核心 JAR”，不会自动把安装器当核心。\n` : ''}${(inspection.warnings || []).join('\n')}`
    controls()
    checkJava()
  }

  function showInspection(value) {
    inspection = value
    retained.inspection = value
    const plans = value.plans || []
    const props = value.properties || {}
    directory.value = value.root
    directory.title = value.root
    clear(plan)
    plan.appendChild(option('', plans.length ? '选择启动入口' : '未找到可启动核心，请选择核心 JAR'))
    for (const item of plans) plan.appendChild(option(item.id, item.label))
    plan.value = value.selected || ''
    memory.value = value.recommendedMemory || 4
    minMemory.value = 1
    port.value = props['server-port'] || '25565'
    host.value = props['server-ip'] || ''
    players.value = props['max-players'] || '20'
    online.value = props['online-mode'] === 'false' ? 'false' : 'true'
    eula.checked = !!value.eulaAccepted
    applyPlan()
    const s = value.settings
    if (s && plans.some(item => item.id === s.planId)) {
      plan.value = s.planId
      applyPlan()
      mc.value = s.mc || mc.value
      java.value = s.javaPath || ''
      memory.value = parseInt(s.memory, 10) || memory.value
      minMemory.value = parseInt(s.minMemory, 10) || 1
      optimization.value = s.optimization || 'original'
      jvmArgs.value = s.jvmArgs || ''
      serverArgs.value = s.serverArgs || ''
    }
    if (!plans.length || !plan.value) {
      planHint.textContent = `服务端目录：${value.root}\n${plans.length ? '发现多个启动入口，请明确选择，避免运行错误版本。' : '未找到可以直接启动的核心；安装器不能当作服务端核心。请先安装核心，或点击“选择核心 JAR”。'}\n${(value.warnings || []).join('\n')}`
    }
    applyWizard()
    controls()
    checkJava()
  }

  async function checkJava() {
    const serial = ++javaSerial
    const selected = inspection?.plans.find(item => item.id === plan.value)
    if (!inspection || !mc.value || !selected) {
      javaHint.textContent = '请先选择核心并补全 MC 版本。'
      return
    }
    javaHint.textContent = '正在检查随包及本机 Java…'
    javaHint.style.color = ''
    try {
      const result = await api.post('/api/server-manager/java', {
        root: inspection.root,
        runtime: { ...selected.runtime, mc: mc.value },
        javaPath: java.value
      })
      if (serial !== javaSerial || dead) return
      javaHint.textContent = `Java ${result.major}（64 位）：${result.path}`
      javaHint.style.color = ''
    } catch (e) {
      if (serial !== javaSerial || dead) return
      javaHint.textContent = e.message
      javaHint.style.color = 'var(--redstone)'
    }
  }

  /* ---------------- 启动 / 停止 / 命令 ---------------- */
  async function launchServer() {
    if (!inspection || !plan.value || submitting) return
    if (!Number.isInteger(Number(memory.value)) || !Number.isInteger(Number(minMemory.value))) {
      toast('内存请填写整数 GB', 'err')
      return
    }
    if (!eula.checked) {
      toast('请先阅读并确认 Minecraft EULA', 'err')
      settingsPanel.open = true
      eula.focus?.()
      return
    }
    submitting = true
    setActivity('')
    setError('')
    controls()
    renderStatus()
    setActivity('正在校验核心、Java、内存和端口…')
    setProgress(null)
    try {
      const result = await api.post('/api/server-manager/start', {
        root: inspection.root,
        corePath,
        planId: plan.value,
        mc: mc.value.trim(),
        javaPath: java.value,
        memory: memory.value + 'G',
        minMemory: minMemory.value + 'G',
        optimization: optimization.value,
        jvmArgs: jvmArgs.value,
        serverArgs: serverArgs.value,
        port: Number(port.value),
        host: host.value,
        maxPlayers: Number(players.value),
        onlineMode: online.value === 'true',
        acceptEula: eula.checked
      })
      if (dead) return
      sessionId = result.id
      retained.sessionId = sessionId
      after = 0
      log.clear()
      logText = ''
      elapsedMs = Number(result.elapsed) || 0
      currentPort = result.port ?? null
      setActivity('')
      await poll()
      await refreshSessions()
    } catch (e) {
      if (dead) return
      setActivity(e.message, 'bad')
      hideProgress()
      toast(e.message, 'err')
    } finally {
      submitting = false
      controls()
      renderStatus()
    }
  }

  async function stopSession(force) {
    if (!sessionId) return
    if (force && !(await confirmDialog('强制停止可能丢失尚未保存的世界数据。确定强制停止这个服务端？', { danger: true }))) return
    try {
      await api.post(`/api/server-manager/sessions/${sessionId}/stop`, force ? { force: true } : undefined)
      await poll()
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  async function sendCommand() {
    if (!sessionId) return
    try {
      await api.post(`/api/server-manager/sessions/${sessionId}/command`, { command: command.value })
      command.value = ''
      await poll()
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  function openLogModal() {
    if (!log.body.childElementCount) logText = ''
    openModal({
      title: '服务端实时日志',
      size: 'lg',
      body: h('pre', {
        class: 'mono scroll-y',
        style: { maxHeight: '65vh', margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '11.5px', lineHeight: '1.6' }
      }, logText || '（暂无日志）'),
      buttons: [{ label: '关闭', class: 'btn-primary' }]
    })
  }

  async function openServerDir() {
    const root = inspection?.root
    if (!root) return
    try {
      await api.post('/api/fs/open', { path: root })
    } catch (e) {
      toast('无法打开服务端目录：' + e.message, 'err')
    }
  }

  /* ---------------- 会话与轮询 ---------------- */
  async function poll() {
    if (dead) return
    if (!container.isConnected) { dispose(); return }
    if (!sessionId || polling) return
    polling = true
    try {
      const result = await api.get(`/api/server-manager/sessions/${sessionId}?after=${after}`)
      if (dead) return
      currentStatus = result.status
      elapsedMs = Number(result.elapsed) || 0
      currentPort = result.port ?? null
      setActivity('')
      setError(result.error || '')
      setInputHint(result.inputHint || '')
      renderStatus()
      if (result.status === 'starting' || result.status === 'stopping') setProgress(null)
      else if (!preparing && !submitting) hideProgress()
      if (result.logs?.length) {
        const lines = result.logs.map(line => line.text)
        if (!log.body.childElementCount && logText) logText = ''
        log.append(lines)
        logText = (logText + lines.join('\n') + '\n').slice(-LOG_LIMIT)
        trimLogViewer()
        after = result.logs[result.logs.length - 1].seq
      }
      controls()
    } catch (e) {
      if (!dead) setActivity('日志读取失败：' + e.message, 'bad')
    } finally {
      polling = false
    }
  }

  async function refreshSessions() {
    try {
      const result = await api.get('/api/server-manager/sessions')
      if (dead) return
      clear(sessions)
      sessions.appendChild(option('', '选择已有运行会话'))
      for (const item of result.items || []) {
        sessions.appendChild(option(item.id, `${LABELS[item.status] || item.status} · ${item.root}`))
      }
      sessions.value = sessionId
    } catch (e) {
      if (!dead) toast(e.message, 'err')
    }
  }

  async function selectSession() {
    if (!sessions.value || dead) return
    sessionId = sessions.value
    retained.sessionId = sessionId
    after = 0
    log.clear()
    logText = ''
    setInputHint('')
    setError('')
    setActivity('')
    try {
      const current = await api.get(`/api/server-manager/sessions/${sessionId}`)
      if (dead) return
      corePath = current.settings?.corePath || ''
      retained.corePath = corePath
      const value = await api.post('/api/server-manager/inspect', { source: current.root, corePath })
      if (dead) return
      showInspection({ ...value, settings: current.settings })
      importPanel.open = false
      await poll()
    } catch (e) {
      if (!dead) toast(e.message, 'err')
    }
  }

  /* ---------------- 生命周期与拖放守卫 ---------------- */
  // 文件拖到页面其他位置时浏览器会打开/下载文件；只允许本磁贴的 drop-zone 接收。
  const preventOutsideFileDrop = event => {
    const files = event.dataTransfer?.files
    if (!files?.length) return
    if (!event.target.closest?.('.drop-zone')) {
      event.preventDefault()
      event.stopPropagation()
    }
  }
  document.addEventListener('dragover', preventOutsideFileDrop, true)
  document.addEventListener('drop', preventOutsideFileDrop, true)
  removeDropGuards = () => {
    document.removeEventListener('dragover', preventOutsideFileDrop, true)
    document.removeEventListener('drop', preventOutsideFileDrop, true)
  }

  function dispose() {
    if (disposed) return
    disposed = true
    dead = true
    if (timer) clearInterval(timer)
    timer = null
    if (observer) observer.disconnect()
    observer = null
    if (removeDropGuards) removeDropGuards()
    removeDropGuards = null
    try { xhr?.abort() } catch { /* 上传已结束 */ }
    xhr = null
    disposers.delete(dispose)
  }

  disposers.add(dispose)
  if (typeof MutationObserver === 'function') {
    observer = new MutationObserver(() => {
      if (!container.isConnected) dispose()
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  if (inspection) showInspection(inspection)
  applyWizard()
  controls()
  renderStatus()
  if (!dead) timer = setInterval(poll, 1000)

  async function init() {
    if (dead) return
    await refreshSessions()
    if (dead) return
    await poll()
  }
  void init()
}
