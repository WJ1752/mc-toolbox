// 启动器设置 —— 整页设置中的「启动器」分组。
//
// 与工作台设置共用同一个设置页（即时保存），但数据独立存在于 launcher.json：
//   GET/PUT /api/launcher/settings
// 这里把原来的 7 张弹窗卡片合并成 4 张：
//   游戏目录与存储 / 下载 / 启动默认值 / Java 与账户
import { h, clear } from './dom.js'
import { api } from './api.js'
import { toast } from './toast.js'
import { confirmDialog } from './modal.js'
import { pickDir, pickFile } from './dirpicker.js'
import { icon } from '../ui/icons.js'
import { btn, input, spinner, openPath } from '../ui/kit.js'
import { createSettingsKit } from './settings-kit.js'
import { checkForUpdatesManual } from '../launcher/update.js'

const DEFAULTS = {
  root: '',
  rootConfigured: false,
  source: 'auto',
  concurrency: 8,
  threads: 4,
  retries: 3,
  verify: true,
  defaultMinMemory: 1024,
  defaultMemory: 4096,
  defaultWidth: 1280,
  defaultHeight: 720,
  jvmArgs: '',
  gameArgs: '',
  defaultJava: '',
  msClientId: '',
  closeOnLaunch: false,
  downloadAssets: true,
  showLog: true,
  // 启动器自身更新（GitHub Releases）
  update: {
    autoCheck: true,
    includePrerelease: false,
    repo: '',
    token: undefined,
    tokenSet: false,
    tokenDirty: false,
    skippedVersion: ''
  }
}

const SOURCES = [
  ['auto', '自动'],
  ['official', '官方'],
  ['bmclapi', 'BMCL 镜像']
]

const PATH_ROWS = [
  ['libraries', '库文件'],
  ['assets', '素材'],
  ['instances', '实例'],
  ['versions', '版本']
]

function pickSettings(data) {
  const source = data && typeof data === 'object' ? data : {}
  const settings = source.settings && typeof source.settings === 'object' ? source.settings : source
  const out = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (settings[key] !== undefined && settings[key] !== null) out[key] = settings[key]
  }
  out.defaultJava = settings.defaultJava || settings.java?.default || ''
  out.verify = settings.verify !== false
  out.downloadAssets = settings.downloadAssets !== false
  out.showLog = settings.showLog !== false
  out.closeOnLaunch = settings.closeOnLaunch === true
  // 更新设置：token 不回填明文，只记录服务端「是否已设置」。
  const update = settings.update && typeof settings.update === 'object' ? settings.update : {}
  out.update = {
    autoCheck: update.autoCheck !== false,
    includePrerelease: update.includePrerelease === true,
    repo: String(update.repo || '').trim(),
    token: undefined,
    tokenSet: update.tokenSet === true,
    tokenDirty: false,
    skippedVersion: String(update.skippedVersion || '')
  }
  return out
}

function joinPath(root, ...parts) {
  const base = String(root || '').replace(/[\\/]+$/, '')
  if (!base) return ''
  const sep = base.includes('\\') ? '\\' : '/'
  return [base, ...parts.filter(Boolean)].join(sep)
}

/**
 * 选中的目录原样交给服务端 resolveGameRoot 解析：本身叫 .minecraft、已经是
 * 游戏根（含 versions/libraries/assets）、或需要新建 .minecraft，都由服务端
 * 统一判断，避免前端再追加一层 .minecraft 指向空目录。
 */
export function suggestGameRoot(picked) {
  return String(picked || '').trim().replace(/[\\/]+$/, '')
}

/**
 * @param {{onStatus?:Function,onSaved?:Function,onRootChanged?:Function,onReady?:Function}} options
 */
export function initLauncherSettings({ onStatus = () => {}, onSaved, onRootChanged, onReady } = {}) {
  let data = null
  let draft = null
  let loadError = ''
  let loadPromise = null
  let saveTimer = null
  let saving = false
  let pendingSave = false
  const refs = { rootInput: null, javaInput: null, javaClear: null, pathList: null, msInput: null }

  const { row, card, panel, numField, textField, textareaField, segField, switchField } = createSettingsKit({ commit })

  /* ---------------- load / save ---------------- */

  function ensureLoaded() {
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      try {
        const next = await api.get('/api/launcher/settings')
        applyData(next)
        loadError = ''
      } catch (e) {
        loadError = e.message || String(e)
      } finally {
        onReady?.()
      }
    })()
    return loadPromise
  }

  function reload() {
    loadPromise = null
    data = null
    return ensureLoaded()
  }

  function applyData(next) {
    data = next
    draft = pickSettings(next)
    if (refs.rootInput) refs.rootInput.value = draft.root || ''
    if (refs.javaInput) refs.javaInput.value = draft.defaultJava || ''
    if (refs.javaClear) refs.javaClear.disabled = !draft.defaultJava
    if (refs.msInput) refs.msInput.value = draft.msClientId || ''
    refreshPaths()
  }

  function commit() {
    if (!draft) return
    onStatus('保存中…')
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveNow()
    }, 350)
  }

  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
      saveNow()
    }
  }

  function buildPatch() {
    return {
      source: SOURCES.some(([value]) => value === draft.source) ? draft.source : 'auto',
      concurrency: Math.round(Number(draft.concurrency) || 8),
      threads: Math.max(1, Math.min(16, Math.round(Number(draft.threads) || 4))),
      retries: Math.round(Number(draft.retries) || 0),
      verify: draft.verify !== false,
      defaultMinMemory: Math.round(Number(draft.defaultMinMemory) || 1024),
      defaultMemory: Math.round(Number(draft.defaultMemory) || 4096),
      defaultWidth: Math.round(Number(draft.defaultWidth) || 1280),
      defaultHeight: Math.round(Number(draft.defaultHeight) || 720),
      jvmArgs: String(draft.jvmArgs || '').trim(),
      gameArgs: String(draft.gameArgs || '').trim(),
      defaultJava: String(draft.defaultJava || '').trim(),
      msClientId: String(draft.msClientId || '').trim(),
      closeOnLaunch: draft.closeOnLaunch === true,
      downloadAssets: draft.downloadAssets !== false,
      showLog: draft.showLog !== false,
      update: {
        autoCheck: draft.update?.autoCheck !== false,
        includePrerelease: draft.update?.includePrerelease === true,
        repo: String(draft.update?.repo || '').trim(),
        skippedVersion: String(draft.update?.skippedVersion || '').trim(),
        // 只有用户真正改过 token 才回传：空串表示清除，未改则省略（服务端保留原值）。
        ...(draft.update?.tokenDirty ? { token: String(draft.update.token || '').trim() } : {})
      }
    }
  }

  async function saveNow() {
    if (!draft) return
    if (saving) { pendingSave = true; return }
    saving = true
    onStatus('保存中…')
    try {
      const next = await api.put('/api/launcher/settings', buildPatch())
      // root 只由「选择文件夹」修改，这里回填服务端返回的其余字段。
      Object.assign(draft, pickSettings(next))
      onStatus('已保存 · ' + new Date().toLocaleTimeString(), 'ok')
      onSaved?.(next)
    } catch (e) {
      onStatus('保存失败', 'err')
      toast('保存启动器设置失败：' + e.message, 'err')
    } finally {
      saving = false
      if (pendingSave) { pendingSave = false; saveNow() }
    }
  }

  /* ---------------- 游戏目录 ---------------- */

  async function chooseRoot() {
    let picked = ''
    try {
      picked = await pickDir(draft?.root || data?.defaultRoot || '', { title: '选择启动器文件夹' })
    } catch (e) {
      toast('无法打开目录选择器：' + e.message, 'err')
      return
    }
    if (!picked) return
    await applyRoot(suggestGameRoot(picked))
  }

  async function useDefaultRoot() {
    if (!data?.defaultRoot) return
    await applyRoot(data.defaultRoot)
  }

  async function applyRoot(target) {
    const ok = await confirmDialog(
      `将使用这个游戏目录：\n  ${target}\n\n` +
      '启动器会在其中准备 .minecraft（versions / libraries / assets / instances）。\n' +
      '已有实例会继续使用它们各自原来的目录，不会被移动或删除。',
      { title: '更换游戏目录', okText: '使用此目录' }
    )
    if (!ok) return
    onStatus('保存中…')
    try {
      const next = await api.put('/api/launcher/settings', { root: target })
      data = next
      draft = { ...draft, ...pickSettings(next) }
      if (refs.rootInput) refs.rootInput.value = draft.root || ''
      refreshPaths()
      onStatus('已保存 · ' + new Date().toLocaleTimeString(), 'ok')
      toast(next.root === target ? '游戏目录已更新' : '游戏目录已更新：' + next.root, 'ok')
      onRootChanged?.(next)
    } catch (e) {
      onStatus('保存失败', 'err')
      toast('更改游戏目录失败：' + e.message, 'err')
    }
  }

  function refreshPaths() {
    if (!refs.pathList) return
    clear(refs.pathList)
    for (const [name, label] of PATH_ROWS) {
      const full = joinPath(draft.root, name)
      refs.pathList.appendChild(h('div', { class: 'lp-row lp-settings-path-row' },
        h('div', { class: 'lp-kv', style: { flex: '1 1 auto', minWidth: '0' } },
          h('span', {}, label),
          h('b', { class: 'lp-settings-path mono' }, full || '—')
        ),
        btn('打开', {
          size: 'xs',
          variant: 'ghost',
          iconName: 'folder',
          disabled: !full,
          onClick: () => openPath(full)
        })
      ))
    }
  }

  /* ---------------- 字段 ---------------- */

  function javaControl() {
    const javaInput = input({ value: draft.defaultJava || '', mono: true, readonly: true, placeholder: '留空时按版本自动选择' })
    javaInput.style.flex = '1 1 300px'
    refs.javaInput = javaInput
    const clearBtn = btn('清除', {
      size: 'sm',
      variant: 'ghost',
      disabled: !draft.defaultJava,
      onClick: () => {
        draft.defaultJava = ''
        javaInput.value = ''
        clearBtn.disabled = true
        commit()
      }
    })
    refs.javaClear = clearBtn
    const choose = btn('选择 java.exe', {
      size: 'sm',
      iconName: 'folder-open',
      onClick: async () => {
        let picked = ''
        try {
          picked = await pickFile(draft.defaultJava || '', { title: '选择 java.exe', exts: ['.exe'] })
        } catch (e) {
          toast('无法打开文件选择器：' + e.message, 'err')
          return
        }
        if (!picked) return
        const value = String(picked).trim()
        if (!/(^|[\\/])java(\.exe)?$/i.test(value)) {
          toast('请选择 java.exe 可执行文件', 'err')
          return
        }
        draft.defaultJava = value
        javaInput.value = value
        clearBtn.disabled = false
        commit()
      }
    })
    return h('div', { class: 'row', style: { gap: '5px', flexWrap: 'wrap', flex: '1 1 420px' } }, javaInput, choose, clearBtn)
  }

  function msControl() {
    const msInput = input({ value: draft.msClientId || '', mono: true, placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' })
    refs.msInput = msInput
    msInput.addEventListener('change', () => {
      draft.msClientId = msInput.value.trim()
      commit()
    })
    const link = h('a', {
      class: 'btn btn-sm',
      href: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
      target: '_blank',
      rel: 'noopener noreferrer'
    }, icon('external', { size: 13 }), 'Azure 应用注册')
    return h('div', { class: 'row', style: { gap: '5px', flexWrap: 'wrap', flex: '1 1 420px' } },
      h('div', { class: 'ctrl-wide' }, msInput),
      link
    )
  }

  /* ---------------- 分区 ---------------- */

  function loadingPanel(title, desc) {
    return h('div', { class: 'settings-panel' },
      h('div', { class: 'settings-title' }, h('h2', {}, title)),
      desc ? h('p', { class: 'settings-desc' }, desc) : null,
      h('div', { class: 'lp-settings-loading' }, spinner(16), '正在读取启动器设置…')
    )
  }

  function errorPanel(title) {
    return panel(title, '',
      h('div', { class: 'error-state' }, '读取启动器设置失败：' + loadError),
      h('div', { class: 'settings-actions' }, btn('重试', { variant: 'primary', onClick: () => { loadError = ''; reload() } }))
    )
  }

  function renderRoot() {
    if (loadError) return errorPanel('游戏目录')
    if (!draft) {
      ensureLoaded()
      return loadingPanel('游戏目录', '启动器会在所选文件夹里使用 .minecraft。')
    }
    const rootInput = input({ value: draft.root || '', mono: true, readonly: true })
    rootInput.style.flex = '1 1 320px'
    refs.rootInput = rootInput
    const list = h('div', { class: 'lp-settings-paths' })
    refs.pathList = list
    refreshPaths()
    return panel('游戏目录', '与 PCL / HMCL 一样：选择一个文件夹，启动器会在其中创建或使用 .minecraft。',
      card('游戏目录与存储', '实例、库文件与素材的根目录',
        row('当前目录', '更换后，之后新建的实例会使用新目录', h('div', { class: 'row', style: { gap: '5px', flexWrap: 'wrap', flex: '1 1 420px' } },
          rootInput,
          btn('选择文件夹', { variant: 'primary', size: 'sm', iconName: 'folder-open', onClick: chooseRoot }),
          btn('默认位置', { size: 'sm', variant: 'ghost', onClick: useDefaultRoot }),
          btn('打开', { size: 'sm', iconName: 'folder', disabled: !draft.root, onClick: () => openPath(draft.root) })
        )),
        h('div', { class: 'hint' }, '如果选中的文件夹里已有 .minecraft 会直接使用；否则会在其中创建 .minecraft（versions / libraries / assets / instances）。'),
        h('div', { class: 'hr', style: { margin: '10px 0 6px' } }),
        list,
        h('div', { class: 'settings-note' }, '已有实例会保留创建时的目录；切换游戏目录不会移动或删除它们的文件。')
      )
    )
  }

  function renderDownload() {
    if (loadError) return errorPanel('下载与安装')
    if (!draft) {
      ensureLoaded()
      return loadingPanel('下载与安装', '下载源、并发与校验。')
    }
    return panel('下载与安装', '版本、素材、库文件与 Java 的下载行为。',
      card('下载', '下载源、并发与校验',
        row('下载源', '自动：先测速再选最快线路（BMCL 镜像 / 官方），单个文件失败还会自动换源', segField(() => draft.source, (v) => (draft.source = v), SOURCES)),
        row('并发下载数', '同时下载的文件数。素材阶段会自动提高并发（最高 96 条），整体速度低于 2.5 MB/s 还会继续加连接，直到跑满线路或触发镜像限流', numField(() => draft.concurrency, (v) => (draft.concurrency = v), { min: 1, max: 32 })),
        row('单文件分段线程数', '≥4 MB 的文件（客户端、整合包、大音频）用多条连接分段下载，慢速时连接数自动翻倍（最多 32 条）；1 = 单连接', numField(() => draft.threads, (v) => (draft.threads = v), { min: 1, max: 16, suffix: '线程' })),
        row('失败重试次数', '0–10。单个文件下载失败后的自动重试次数', numField(() => draft.retries, (v) => (draft.retries = v), { min: 0, max: 10 })),
        row('校验已存在文件', '复用本地文件时校验 SHA1；关闭会更快，但可能漏过损坏文件', switchField(() => draft.verify !== false, (v) => (draft.verify = v))),
        row('下载游戏素材', '关闭后不会下载声音与语言文件，部分版本可能没有声音', switchField(() => draft.downloadAssets !== false, (v) => (draft.downloadAssets = v)))
      )
    )
  }

  function renderLaunch() {
    if (loadError) return errorPanel('启动与 Java')
    if (!draft) {
      ensureLoaded()
      return loadingPanel('启动与 Java', '默认内存、窗口、参数与账户。')
    }

    const maxInput = numField(() => draft.defaultMemory, (v) => {
      draft.defaultMemory = v
      if (v < draft.defaultMinMemory) {
        draft.defaultMinMemory = v
        if (minInput) minInput.value = String(v)
      }
    }, { min: 256, max: 262144 })
    const minInput = numField(() => draft.defaultMinMemory, (v) => {
      draft.defaultMinMemory = v
      if (v > draft.defaultMemory) {
        draft.defaultMemory = v
        if (maxInput) maxInput.value = String(v)
      }
    }, { min: 256, max: 262144 })

    return panel('启动与 Java', '新建实例的默认值；单个实例可以单独覆盖。',
      card('启动默认值', '内存、窗口、参数与启动行为',
        row('初始内存（MB）', '建议 1024；不能大于最大内存', minInput),
        row('最大内存（MB）', '建议 4096–12288；大型整合包可以更高', maxInput),
        row('窗口宽度', '新建实例的窗口宽度，像素', numField(() => draft.defaultWidth, (v) => (draft.defaultWidth = v), { min: 320, max: 7680 })),
        row('窗口高度', '新建实例的窗口高度，像素', numField(() => draft.defaultHeight, (v) => (draft.defaultHeight = v), { min: 240, max: 4320 })),
        row('默认 JVM 参数', '留空使用启动器默认；按空格拆分', h('div', { class: 'ctrl-wide-lg' }, textareaField(() => draft.jvmArgs, (v) => (draft.jvmArgs = v), { placeholder: '-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions' }))),
        row('默认游戏参数', '附加到游戏主类之后，例如 --fullscreen', textField(() => draft.gameArgs, (v) => (draft.gameArgs = v), '--fullscreen')),
        row('启动后关闭启动器', '启动成功后约 2 秒关闭本窗口；进行中的下载会中断', switchField(() => draft.closeOnLaunch, (v) => (draft.closeOnLaunch = v))),
        row('启动时显示日志', '实例页会自动切换到日志标签，便于查看崩溃信息', switchField(() => draft.showLog !== false, (v) => (draft.showLog = v)))
      ),
      card('Java 与账户', '默认运行时与微软登录（默认无需配置）',
        row('默认 Java', '留空时按实例所需的 MC 版本自动选择', javaControl()),
        h('div', { class: 'settings-note' }, '启动前会校验 64 位与大版本；不匹配会拒绝启动并给出提示。'),
        row('Microsoft OAuth 客户端 ID', '留空使用内置公共客户端（与 PCL / HMCL 相同的设备码登录）', msControl())
      )
    )
  }

  function renderUpdate() {
    if (loadError) return errorPanel('更新')
    if (!draft) {
      ensureLoaded()
      return loadingPanel('更新', '启动器自身更新（GitHub Releases）。')
    }
    const state = draft.update || (draft.update = { autoCheck: true, includePrerelease: false, repo: '', skippedVersion: '' })
    const repoInput = input({ value: state.repo || '', mono: true, placeholder: 'WJ1752/mc-toolbox' })
    repoInput.addEventListener('change', () => {
      state.repo = repoInput.value.trim()
      commit()
    })
    const tokenInput = input({
      type: 'password',
      mono: true,
      placeholder: state.tokenSet ? '已设置（留空保持不变）' : '可选：ghp_… / github_pat_…'
    })
    const clearBtn = btn('清除', {
      size: 'sm',
      variant: 'ghost',
      disabled: !state.tokenSet,
      onClick: () => {
        state.token = ''
        state.tokenDirty = true
        state.tokenSet = false
        tokenInput.value = ''
        tokenInput.placeholder = '可选：ghp_… / github_pat_…'
        clearBtn.disabled = true
        commit()
      }
    })
    tokenInput.addEventListener('change', () => {
      const value = tokenInput.value.trim()
      if (!value) return
      state.token = value
      state.tokenDirty = true
      state.tokenSet = true
      tokenInput.value = ''
      tokenInput.placeholder = '已设置（留空保持不变）'
      clearBtn.disabled = false
      commit()
    })
    const ignored = String(state.skippedVersion || '')

    return panel('更新', '启动器从 GitHub Releases 获取新版本；发现更新时右下角提示，一键下载并重启。',
      card('自动检查', '',
        row('启动时检查更新', '打开启动器时请求一次发布信息（10 分钟内不重复请求）', switchField(() => state.autoCheck !== false, (v) => { state.autoCheck = v })),
        row('包含预发布版本', '接收 beta / rc 等预发布版本', switchField(() => state.includePrerelease === true, (v) => { state.includePrerelease = v })),
        row('立即检查', '手动检查一次并打开更新弹窗', btn('检查更新', { size: 'sm', variant: 'primary', iconName: 'refresh', onClick: () => checkForUpdatesManual() }))
      ),
      card('更新源', '默认读取官方仓库的 GitHub Releases',
        row('仓库', '格式 owner/repo；留空使用官方仓库', repoInput),
        row('访问 Token', '仓库为私有或遇到 API 限额时填写；只保存在本机', h('div', { class: 'row', style: { gap: '5px', flexWrap: 'wrap' } }, tokenInput, clearBtn)),
        h('div', { class: 'settings-note' }, 'Token 需要仓库的读取权限（公开仓库可留空）。保存后不再回显；清除后自动退回匿名访问。'),
        ignored
          ? row('已忽略的版本', '不再提示该版本', h('div', { class: 'row', style: { gap: '6px', alignItems: 'center' } },
              h('span', { class: 'mono' }, 'v' + ignored),
              btn('恢复提示', { size: 'sm', variant: 'ghost', onClick: () => { state.skippedVersion = ''; commit() } })))
          : null
      ),
      card('安装方式', '',
        h('div', { class: 'settings-note' }, '更新包从发布资产下载，校验大小与 SHA-256 后由独立脚本替换当前 exe 并自动重启。开发模式（node server.js）只检查、不替换本体；启动器目录没有写入权限时需要手动下载。')
      )
    )
  }

  const sections = [
    { id: 'launcher-root', label: '游戏目录', iconName: 'folder', desc: '启动器与游戏文件的位置', render: renderRoot },
    { id: 'launcher-download', label: '下载与安装', iconName: 'download', desc: '下载源、并发与校验', render: renderDownload },
    { id: 'launcher-launch', label: '启动与 Java', iconName: 'play', desc: '默认内存、参数与账户', render: renderLaunch },
    { id: 'launcher-update', label: '更新', iconName: 'refresh', desc: '版本检查与更新源', render: renderUpdate }
  ]

  return { sections, ensureLoaded, reload, flush, isLoaded: () => !!draft, getSettings: () => data }
}
