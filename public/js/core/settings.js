import { h, clear, fmtBytes } from './dom.js'
import { api } from './api.js'
import { toast } from './toast.js'
import { confirmDialog } from './modal.js'
import { pickDir, pickFile } from './dirpicker.js'
import { icon } from '../ui/icons.js'
import { btn, input, select, seg, toggle, spinner } from '../ui/kit.js'

const ACCENTS = ['#c07a4a', '#5ec96a', '#3ba0ff', '#c084fc', '#ff8a4c', '#f43f5e', '#22d3ee', '#eab308']

// Legacy SDK export: keep a mirror of the last known settings object.
let MIRROR = null

const THEMES = [
  ['dark', '深色', '#14171c'],
  ['light', '浅色 · 图纸', '#f2efe8'],
  ['gray', '灰调', '#262a2d'],
  ['orange', '橙调', '#251d16'],
  ['red', '红调', '#25181b'],
  ['blue', '蓝调', '#17202c']
]

const clone = (o) => JSON.parse(JSON.stringify(o ?? {}))

const ENGINE_STATUS = { queued: '排队中', running: '下载中', installing: '安装中', done: '已完成', failed: '失败', cancelled: '已取消' }

export function initSettings(ctx) {
  const SECTIONS = buildSections(ctx)
  const page = document.getElementById('settingsPage')
  const nav = document.getElementById('settingsNav')
  const content = document.getElementById('settingsContent')
  const saveStateEl = document.getElementById('settingsSaveState')
  MIRROR = ctx.getSettings()

  let S = null
  let active = 'general'
  let timer = null
  let saving = false
  let again = false
  let restoreScroll = 0

  function setSaveState(text, kind = '') {
    if (!saveStateEl) return
    saveStateEl.textContent = text
    saveStateEl.style.color = kind === 'err' ? 'var(--redstone)' : kind === 'ok' ? 'var(--emerald)' : ''
  }

  function scheduleSave() {
    setSaveState('保存中…')
    clearTimeout(timer)
    timer = setTimeout(doSave, 350)
  }

  async function doSave() {
    timer = null
    if (!S) return
    if (saving) { again = true; return }
    saving = true
    try {
      // Never clobber a layout/tile state changed by the shell while the page
      // is open: read those two from the live settings mirror.
      const live = ctx.getSettings()
      S.layout = clone(live.layout || [])
      const next = await api.put('/api/settings', S)
      S = next
      MIRROR = S
      ctx.onSaved?.(S)
      setSaveState('已保存 · ' + new Date().toLocaleTimeString(), 'ok')
    } catch (e) {
      setSaveState('保存失败', 'err')
      toast('设置保存失败：' + e.message, 'err')
    } finally {
      saving = false
      if (again) { again = false; doSave() }
    }
  }

  function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
      doSave()
    }
  }

  function commit() {
    scheduleSave()
  }

  function applyLive() {
    document.documentElement.dataset.theme = S.general.theme
    document.documentElement.style.setProperty('--accent', S.general.accent)
    document.documentElement.style.setProperty('--tile-cols', String(Math.max(1, Math.min(4, Number(S.general.tileColumns) || 1))))
    document.body.classList.toggle('no-anim', S.general.animations === false)
  }

  /* ---------------- generic field helpers ---------------- */

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
      commit()
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
    inp.addEventListener('change', () => { set(inp.value.trim()); commit() })
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); set(inp.value.trim()); commit(); inp.blur() } })
    return inp
  }

  function monoField(get, set, placeholder = '', width = '') {
    const inp = input({ value: get() || '', placeholder, mono: true, class: width })
    inp.addEventListener('change', () => { set(inp.value.trim()); commit() })
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); set(inp.value.trim()); commit(); inp.blur() } })
    return inp
  }

  function pathField(get, set, placeholder = '', { fileMode = false, exts = [], title = '选择目录' } = {}) {
    const inp = input({ value: get() || '', placeholder, mono: true })
    const apply = () => { set(inp.value.trim()); commit() }
    inp.addEventListener('change', apply)
    const browse = btn('浏览', {
      size: 'sm',
      onClick: async () => {
        const picked = fileMode
          ? await pickFile(inp.value || '', { title, exts })
          : await pickDir(inp.value || '', { title })
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
      commit()
      onChange?.(v)
    })
  }

  function switchField(get, set, onChange) {
    return toggle(!!get(), (v) => {
      set(v)
      commit()
      onChange?.(v)
    })
  }

  function panel(title, desc, ...children) {
    return h('div', { class: 'settings-panel' },
      h('div', { class: 'settings-title' }, h('h2', {}, title)),
      h('p', { class: 'settings-desc' }, desc),
      ...children
    )
  }

  function actionRow(...nodes) {
    return h('div', { class: 'settings-actions' }, ...nodes)
  }

  /* ---------------- sections ---------------- */

  function buildSections(ctx) {
    const C = ctx

    return [
      {
        id: 'general',
        label: '通用',
        iconName: 'sliders',
        desc: '工作台外观与操作习惯',
        render() {
          const themeDots = h('div', { class: 'color-dots theme-dots' })
          for (const [v, label, color] of THEMES) {
            const b = h('button', {
              type: 'button',
              class: S.general.theme === v ? 'active' : '',
              title: label,
              'aria-label': label,
              style: { background: color }
            })
            b.onclick = () => {
              S.general.theme = v
              for (const x of themeDots.children) x.classList.remove('active')
              b.classList.add('active')
              applyLive()
              commit()
            }
            themeDots.appendChild(b)
          }

          const accentDots = h('div', { class: 'color-dots' })
          for (const c of ACCENTS) {
            const b = h('button', {
              type: 'button',
              class: S.general.accent === c ? 'active' : '',
              title: c,
              'aria-label': '强调色 ' + c,
              style: { background: c }
            })
            b.onclick = () => {
              S.general.accent = c
              for (const x of accentDots.children) x.classList.remove('active')
              b.classList.add('active')
              applyLive()
              commit()
            }
            accentDots.appendChild(b)
          }

          return panel('通用', '这些设置即时生效并写入 settings.json。', 
            card('外观', '主题、强调色与磁贴网格',
              row('主题', '六套调色板，深色为默认台面', themeDots),
              row('强调色', '主按钮、选中态与图表主线', accentDots),
              row('每行磁贴数', '1 = 单列；多列时每个磁贴默认占一列', numField(() => S.general.tileColumns || 1, (v) => { S.general.tileColumns = v; applyLive() }, { min: 1, max: 4, step: 1, suffix: '列' })),
              row('界面动画', '拖拽与弹层过渡；关闭后立即静止', switchField(() => S.general.animations, (v) => { S.general.animations = v; applyLive(); C.onAnimationsChange?.(v) })),
              row('时间格式', '日志、图表与记录时间', segField(() => S.general.timeFormat, (v) => (S.general.timeFormat = v), [['24h', '24 小时'], ['12h', '12 小时']])),
              row('新磁贴默认折叠', '只显示图标、标题与状态', switchField(() => S.general.defaultCollapsed !== false, (v) => (S.general.defaultCollapsed = v)))
            ),
            card('操作习惯', '', 
              row('危险操作二次确认', '删除 mod、移除监测项、清空记录时弹窗确认', switchField(() => S.general.confirmDanger, (v) => (S.general.confirmDanger = v)))
            ),
            h('div', { class: 'settings-note' }, '所有设置都保存在配置目录的 settings.json。老版本配置可以直接沿用；本页不会改写 version 字段。')
          )
        }
      },
      {
        id: 'network',
        label: '网络',
        iconName: 'globe',
        desc: '探测、默认端口与下载代理',
        render() {
          return panel('网络', '所有服务器探测、监测与下载功能共享这些默认值。',
            card('探测参数', '单次连接与重试策略',
              row('超时时间', '单次连接最长等待', numField(() => S.network.timeout, (v) => (S.network.timeout = v), { min: 500, max: 30000, step: 500, suffix: 'ms' })),
              row('失败重试次数', '判定失败前的重试', numField(() => S.network.retries, (v) => (S.network.retries = v), { min: 0, max: 5, step: 1, suffix: '次' })),
              row('并发探测上限', '同时进行的探测数量', numField(() => S.network.concurrency, (v) => (S.network.concurrency = v), { min: 1, max: 64, step: 1, suffix: '个' })),
              row('解析 SRV 记录', '优先使用 _minecraft._tcp 记录', switchField(() => S.network.resolveSrv, (v) => (S.network.resolveSrv = v))),
              row('默认服务器类型', '新测试与新监测项的初值', segField(() => S.network.defaultType, (v) => (S.network.defaultType = v), [['auto', '自动'], ['java', 'Java 版'], ['bedrock', '基岩版']])),
              row('Java 版默认端口', '', numField(() => S.network.javaPort, (v) => (S.network.javaPort = v), { min: 1, max: 65535 })),
              row('基岩版默认端口', '', numField(() => S.network.bedrockPort, (v) => (S.network.bedrockPort = v), { min: 1, max: 65535 }))
            ),
            card('下载代理', '作用于社区资源下载与服务端核心下载（含安装器联网）',
              row('代理地址', '如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080；支持 user:pass@ 认证，留空直连',
                h('div', { class: 'ctrl-wide' }, textField(() => S.network.proxy, (v) => (S.network.proxy = v), 'http://127.0.0.1:7890')))
            )
          )
        }
      },
      {
        id: 'monitor',
        label: '延迟监测',
        iconName: 'pulse',
        desc: '采样、图表与磁贴高度策略',
        render() {
          const engineLine = h('div', { class: 'settings-badge-line' }, h('span', { class: 'spinner' }), '读取引擎状态…')
          const clearBtn = btn('清空历史数据', { size: 'sm', variant: 'danger', onClick: async () => {
            if (S.general.confirmDanger && !(await confirmDialog('确定清空全部监测历史数据吗？此操作不可恢复。', { danger: true }))) return
            try {
              await api.del('/api/monitors/history')
              toast('历史数据已清空', 'ok')
            } catch (e) { toast('清空失败：' + e.message, 'err') }
          } })
          const toggleBtn = btn('切换运行 / 暂停', { size: 'sm', onClick: async () => {
            try {
              const snap = await api.get('/api/monitors')
              const run = !snap.running
              await api.post('/api/monitors/engine', { running: run })
              toast(run ? '监测已启动' : '监测已暂停', 'ok')
              loadEngine()
            } catch (e) { toast('操作失败：' + e.message, 'err') }
          } })
          async function loadEngine() {
            try {
              const snap = await api.get('/api/monitors')
              clear(engineLine)
              engineLine.append(
                h('span', { class: 'dot ' + (snap.running ? 'ok' : '') }),
                h('span', { class: 'badge ' + (snap.running ? 'ok' : '') }, snap.running ? '运行中' : '已暂停'),
                h('span', { class: 'muted' }, `${(snap.items || []).length} 台 · ${(snap.items || []).filter((x) => x.status?.ok).length} 在线`)
              )
            } catch (e) {
              clear(engineLine)
              engineLine.append(h('span', { class: 'badge bad' }, '不可用'), h('span', { class: 'muted' }, e.message))
            }
          }
          setTimeout(loadEngine, 0)

          return panel('延迟监测', '影响所有监测磁贴与展开图表。',
            card('监测策略', '采样与展示',
              row('默认轮询间隔', '新增监测项时使用', numField(() => S.monitor.defaultInterval, (v) => (S.monitor.defaultInterval = v), { min: 1, max: 3600, step: 1, suffix: '秒' })),
              row('默认图表指标', '新增监测项默认显示的指标', segField(() => S.monitor.defaultMetric, (v) => (S.monitor.defaultMetric = v), [['latency', '延迟'], ['players', '在线人数'], ['loss', '丢包率']])),
              row('历史保留点数', '每个监测项保留的采样数量', numField(() => S.monitor.historyPoints, (v) => (S.monitor.historyPoints = v), { min: 60, max: 10080, step: 60, suffix: '点' })),
              row('离线判定阈值', '连续失败达到该次数判定离线', numField(() => S.monitor.offlineAfter, (v) => (S.monitor.offlineAfter = v), { min: 1, max: 10, suffix: '次' })),
              row('延迟告警阈值', '超过该值在图表中标红', numField(() => S.monitor.latencyWarn, (v) => (S.monitor.latencyWarn = v), { min: 20, max: 2000, step: 10, suffix: 'ms' })),
              row('展开图显示点数', '详情图表的时间窗口', numField(() => S.monitor.chartRange, (v) => (S.monitor.chartRange = v), { min: 30, max: 1440, step: 30, suffix: '点' })),
              row('监测磁贴最大宽度', '0 表示不限制', numField(() => S.monitor.maxTileWidth ?? 300, (v) => (S.monitor.maxTileWidth = v), { min: 0, max: 800, step: 10, suffix: 'px' })),
              row('磁贴高度策略', '固定 / 限高 / 自适应', segField(() => S.monitor.tileHeightMode ?? 'fixed', (v) => (S.monitor.tileHeightMode = v), [['fixed', '固定'], ['max', '限制最大'], ['auto', '自适应']])),
              row('磁贴高度', '配合高度策略使用', numField(() => S.monitor.tileHeight ?? 100, (v) => (S.monitor.tileHeight = v), { min: 60, max: 500, step: 5, suffix: 'px' })),
              row('启动后自动监测', '工具箱启动时立即开始轮询', switchField(() => S.monitor.autoStart, (v) => (S.monitor.autoStart = v)))
            ),
            card('监测引擎', '', row('运行状态', '启动 / 暂停只影响轮询，不删除监测项', engineLine), actionRow(toggleBtn, clearBtn))
          )
        }
      },
      {
        id: 'c2s',
        label: '客户端转服务端',
        iconName: 'swap',
        desc: 'mod 扫描与处理默认值',
        render() {
          return panel('客户端转服务端', 'mod 处理工具的默认目录与行为；目录修改后立即生效。',
            card('mod 处理', '客户端转服务端辅助工具的默认行为',
              row('默认 mods 目录', '打开工具时自动填充', pathField(() => S.client2server.modsDir, (v) => (S.client2server.modsDir = v), '例如 C:\\Users\\...\\.minecraft\\mods')),
              row('备份目录', '移出的仅客户端 mod 存放位置；留空使用 mods 同级目录', pathField(() => S.client2server.backupDir, (v) => (S.client2server.backupDir = v), '留空则使用 mods 目录同级')),
              row('默认处理方式', '', segField(() => S.client2server.defaultAction, (v) => (S.client2server.defaultAction = v), [['disable', '禁用'], ['backup', '移入备份'], ['delete', '直接删除']])),
              row('扫描子目录', '递归查找子文件夹中的 jar', switchField(() => S.client2server.scanSubdir, (v) => (S.client2server.scanSubdir = v))),
              row('包含 .jar.disabled', '把已禁用的 mod 也纳入扫描', switchField(() => S.client2server.includeDisabled, (v) => (S.client2server.includeDisabled = v))),
              row('自动识别 environment=client', '依据 fabric/quilt 元数据自动标记', switchField(() => S.client2server.autoDetectEnv, (v) => (S.client2server.autoDetectEnv = v))),
              row('启动脚本', '绑定 .bat / .cmd / .sh；留空表示未绑定', pathField(() => S.client2server.scriptPath, (v) => (S.client2server.scriptPath = v), '未绑定启动脚本', { fileMode: true, exts: ['.bat', '.cmd', '.sh'], title: '选择要绑定的启动脚本' }))
            )
          )
        }
      },
      {
        id: 'community',
        label: '社区资源',
        iconName: 'package-down',
        desc: '搜索源、下载目录与命名规则',
        render() {
          return panel('社区资源', 'Modrinth 无需密钥；CurseForge 需要 Eternal API Key（免费，非商业用途）。',
            card('平台与凭据', '',
              row('CurseForge API Key', '只保存在本地 settings.json', h('div', { class: 'ctrl-wide' }, textField(() => S.community.cfApiKey, (v) => (S.community.cfApiKey = v), '粘贴你的 Eternal API Key'))),
              row('默认来源', '', segField(() => S.community.defaultSource, (v) => (S.community.defaultSource = v), [['modrinth', 'Modrinth'], ['curseforge', 'CurseForge']])),
              row('默认游戏版本', '例如 1.20.1，留空不限', textField(() => S.community.defaultGameVersion, (v) => (S.community.defaultGameVersion = v), '1.20.1')),
              row('默认加载器', '', segField(() => S.community.defaultLoader, (v) => (S.community.defaultLoader = v), [['', '不限'], ['fabric', 'Fabric'], ['forge', 'Forge'], ['neoforge', 'NeoForge'], ['quilt', 'Quilt']]))
            ),
            card('下载', '线程、并发、限速与命名',
              row('默认下载目录', '留空则使用系统下载文件夹', pathField(() => S.community.downloadDir, (v) => (S.community.downloadDir = v), '例如 D:\\MC\\mods')),
              row('单文件线程数', '分段并发下载，不支持 Range 时自动降为 1', numField(() => S.community.threads, (v) => (S.community.threads = v), { min: 1, max: 8, step: 1, suffix: '线程' })),
              row('同时下载任务数', '队列并发上限', numField(() => S.community.maxConcurrent, (v) => (S.community.maxConcurrent = v), { min: 1, max: 10, step: 1, suffix: '个' })),
              row('全局限速', '所有任务共享的速度上限，0 为不限', numField(() => S.community.speedLimit, (v) => (S.community.speedLimit = v), { min: 0, max: 1048576, step: 128, suffix: 'KB/s' })),
              row('按类型建子目录', 'mod / 整合包 / 光影等分别存到对应文件夹', switchField(() => S.community.subdirByType, (v) => (S.community.subdirByType = v))),
              row('命名规则', '占位符：{project} {version} {loader} {gameversion} {type} {source} {date} {time} {filename} {ext}',
                h('div', { class: 'row', style: { gap: '5px', flexWrap: 'wrap' } },
                  h('div', { class: 'ctrl-wide' }, monoField(() => S.community.nameRule, (v) => (S.community.nameRule = v), '{project}-{version}{ext}')),
                  btn('预览', { size: 'sm', onClick: async () => {
                    try {
                      const r = await api.post('/api/community/preview-name', {
                        rule: S.community.nameRule,
                        filename: 'sodium-fabric-0.5.13+mc1.20.1.jar',
                        meta: { project: 'Sodium', version: '0.5.13', loader: 'fabric', gameVersion: '1.20.1', type: 'mod', source: 'modrinth' }
                      })
                      toast('预览：' + r.filename, 'ok', 5000)
                    } catch (e) { toast('预览失败：' + e.message, 'err') }
                  } })
                )
              ),
              row('每页结果数', '', numField(() => S.community.pageSize, (v) => (S.community.pageSize = v), { min: 5, max: 50, step: 5, suffix: '条' })),
              row('下载任务', '取消所有进行中的任务并清空记录', btn('清空任务', { size: 'sm', variant: 'danger', onClick: async () => {
                if (!(await confirmDialog('确定取消所有下载任务并清空记录？已下载的文件不会被删除。', { danger: true }))) return
                try {
                  await api.del('/api/community/jobs')
                  toast('已清空下载记录', 'ok')
                } catch (e) { toast('清空失败：' + e.message, 'err') }
              } }))
            )
          )
        }
      },
      {
        id: 'servercore',
        label: '服务端核心',
        iconName: 'chip',
        desc: '启动脚本内存',
        render() {
          return panel('服务端核心', 'Fabric 等服务端安装完成后，自动在目标目录生成 start.bat / start.sh。',
            card('启动脚本', '',
              row('分配内存', '写入启动脚本的 -Xms 与 -Xmx，如 2G、4G、1024M', textField(() => S.servercore.memory, (v) => (S.servercore.memory = v), '2G')),
              h('div', { class: 'settings-note' }, '内存字符串会原样写入启动脚本，不做数值校验。请按实际物理内存与整合包规模填写。')
            )
          )
        }
      },
      {
        id: 'i18n',
        label: '整合包翻译',
        iconName: 'language',
        desc: '翻译引擎与工作台',
        render() {
          const statusLine = h('div', { class: 'settings-badge-line' }, h('span', { class: 'spinner' }), '检查中…')
          const startBtn = btn('测试并启动', { size: 'sm', variant: 'primary', onClick: async () => {
            startBtn.disabled = true
            try {
              const r = await api.post('/api/i18n/start', { i18n: S.i18n || {} })
              toast(`翻译工作台已启动${r.port ? `（端口 ${r.port}）` : ''}`, 'ok')
              loadStatus()
            } catch (e) { toast('翻译引擎启动失败：' + e.message, 'err') } finally { startBtn.disabled = false }
          } })
          const stopBtn = btn('停止', { size: 'sm', onClick: async () => {
            stopBtn.disabled = true
            try {
              await api.post('/api/i18n/stop')
              toast('翻译工作台已停止', 'ok')
              loadStatus()
            } catch (e) { toast('停止翻译引擎失败：' + e.message, 'err') } finally { stopBtn.disabled = false }
          } })
          async function loadStatus() {
            try {
              const st = await api.get('/api/i18n/status')
              clear(statusLine)
              const label = !st.available ? '运行时不可用' : st.starting ? '启动中' : st.running ? '已运行' : '未启动'
              statusLine.append(
                h('span', { class: 'dot ' + (!st.available ? 'bad' : st.running ? 'ok' : st.starting ? 'warn' : '') }),
                h('span', { class: `badge ${!st.available ? 'bad' : st.running ? 'ok' : st.starting ? 'warn' : ''}` }, label),
                st.running && st.port ? h('span', { class: 'mono muted' }, `端口 ${st.port}`) : null
              )
            } catch (e) {
              clear(statusLine)
              statusLine.append(h('span', { class: 'badge bad' }, '状态不可用'), h('span', { class: 'muted' }, e.message))
            }
          }
          setTimeout(loadStatus, 0)
          return panel('整合包翻译', 'mc-i18n 会作为工具箱管理的本地子进程运行，翻译项目文件仍保存在你选择的整合包目录中。',
            card('翻译工作台', '',
              row('Python 解释器', '开发模式需要 Python 3.10+；留空使用系统 PATH 中的 python', textField(() => S.i18n?.pythonPath, (v) => { S.i18n.pythonPath = v }, 'python')),
              row('启动工具箱时自动启动', '打开工具箱后自动准备翻译工作台', switchField(() => S.i18n?.autoStart, (v) => { S.i18n.autoStart = v })),
              row('运行状态', '检查内置运行时、Python 和 Web 工作台是否可用', statusLine),
              actionRow(startBtn, stopBtn)
            ),
            card('使用说明', '',
              h('div', { class: 'settings-note' }, '启动后打开「整合包翻译」磁贴即可进入完整工作台。扫描、批量翻译、术语表、任务书、校对和资源包打包功能均由 mc-i18n 提供。'),
              h('div', { class: 'settings-note' }, '开发模式需要 Python 3.10+。发布单文件前，可在 vendor/mc-i18n/dist/ 放置 mc-i18n.exe，这样目标电脑无需单独安装 Python。')
            )
          )
        }
      },
      {
        id: 'features',
        label: '功能与磁贴',
        iconName: 'grid',
        desc: '启用、显示与删除',
        render() {
          const listWrap = h('div', { class: 'col', style: { gap: '0' } })
          const countEl = h('span', { class: 'muted', style: { fontSize: '11px' } })

          async function renderList() {
            clear(listWrap)
            let data
            try {
              data = await api.get('/api/features')
            } catch (e) {
              listWrap.appendChild(h('div', { class: 'error-state' }, '读取功能列表失败：' + e.message))
              return
            }
            countEl.textContent = `${data.items.length} 个功能 · ${data.items.filter((f) => f.enabled && f.visible).length} 个在台面上`
            for (const f of data.items) {
              const enabledSw = toggle(!!f.enabled, async (v) => {
                try {
                  await api.put('/api/features/' + f.id, { enabled: v })
                  toast(v ? `${f.name} 已启用` : `${f.name} 已禁用`, 'ok')
                  if (!v) C.onFeatureToggle?.(f.id, false)
                  await renderList()
                  C.onFeaturesChanged?.()
                } catch (e) { toast('操作失败：' + e.message, 'err') }
              })
              const visibleSw = toggle(!!f.visible, async (v) => {
                try {
                  await api.put('/api/features/' + f.id, { visible: v })
                  C.onFeatureToggle?.(f.id, v && f.enabled)
                  await renderList()
                  C.onFeaturesChanged?.()
                } catch (e) { toast('操作失败：' + e.message, 'err') }
              })
              listWrap.appendChild(h('div', { class: 'feature-admin' },
                h('div', { class: 'fi-icon', style: { background: f.color || 'var(--surface-3)' } }, icon(featureIconName(f), { size: 15 })),
                h('div', { class: 'fa-main' },
                  h('b', {}, f.name),
                  h('span', { class: 'mono' }, `${f.id} · v${f.version}`),
                  h('span', { title: f.desc || '' }, f.desc || '')
                ),
                h('div', { class: 'fa-ctrl' },
                  h('div', { class: 'fa-toggle' }, h('span', {}, '启用'), enabledSw),
                  h('div', { class: 'fa-toggle' }, h('span', {}, '显示'), visibleSw),
                  btn('删除', {
                    size: 'xs',
                    variant: 'danger',
                    disabled: f.builtin,
                    title: f.builtin ? '内置功能不可删除，可隐藏或禁用' : '移动到 features_disabled 目录',
                    onClick: async () => {
                      if (!(await confirmDialog(`确定删除功能「${f.name}」？目录将被移动到 features_disabled。`, { danger: true }))) return
                      try {
                        await api.del('/api/features/' + f.id)
                        toast('功能已移除', 'ok')
                        await renderList()
                        C.onFeaturesChanged?.()
                      } catch (e) { toast('删除失败：' + e.message, 'err') }
                    }
                  })
                )
              ))
            }
          }
          setTimeout(renderList, 0)

          return panel('功能与磁贴', '新增功能：在 public/features 下新建目录（含 manifest.json 与 tile.js）后点击「重新扫描」即可出现。',
            card('已安装功能', '',
              actionRow(
                btn('添加磁贴', { size: 'sm', onClick: () => C.openAddTile?.() }),
                btn('重新扫描', { size: 'sm', iconName: 'refresh', onClick: async () => {
                  try {
                    await api.post('/api/features/reload')
                    await renderList()
                    C.onFeaturesChanged?.()
                    toast('已重新扫描功能目录', 'ok')
                  } catch (e) { toast('扫描失败：' + e.message, 'err') }
                } }),
                btn('重置磁贴布局', { size: 'sm', onClick: () => C.onResetLayout?.() }),
                countEl
              ),
              h('div', { class: 'hr', style: { margin: '10px 0 4px' } }),
              listWrap
            )
          )
        }
      },
      {
        id: 'data',
        label: '数据管理',
        iconName: 'archive',
        desc: '存储目录、备份与恢复',
        render() {
          const dirBox = h('div', {}, h('div', { class: 'row' }, h('span', { class: 'spinner' }), h('span', { class: 'muted' }, '读取目录信息…')))
          const fileInput = h('input', {
            type: 'file',
            accept: '.json',
            style: { display: 'none' },
            onchange: async (e) => {
              const file = e.target.files?.[0]
              if (!file) return
              try {
                const obj = JSON.parse(await file.text())
                await api.post('/api/data/import', obj)
                toast('导入成功，正在刷新…', 'ok')
                setTimeout(() => location.reload(), 800)
              } catch (err) {
                toast('导入失败：' + err.message, 'err')
              }
            }
          })
          loadDirs(dirBox)
          return panel('数据管理', '更改目录会把原目录里的所有文件完整转移到新位置（校验通过后才会清空原目录），立即生效，无需重启。',
            card('存储目录', '', dirBox, fileInput),
            card('备份与恢复', '设置、监测项、仅客户端 mod 库',
              actionRow(
                btn('导出配置', { size: 'sm', onClick: async () => {
                  try {
                    const data = await api.get('/api/data/export')
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
                    const a = document.createElement('a')
                    a.href = URL.createObjectURL(blob)
                    a.download = `mc-toolbox-backup-${new Date().toISOString().slice(0, 10)}.json`
                    a.click()
                    URL.revokeObjectURL(a.href)
                    toast('已导出配置', 'ok')
                  } catch (e) { toast('导出失败：' + e.message, 'err') }
                } }),
                btn('导入配置', { size: 'sm', onClick: () => fileInput.click() }),
                btn('恢复默认设置', { size: 'sm', variant: 'danger', onClick: async () => {
                  if (!(await confirmDialog('恢复默认设置会清空所有个性化配置（不含监测项与 mod 库），确定继续？', { danger: true }))) return
                  try {
                    await api.post('/api/settings/reset')
                    toast('设置已恢复默认，正在刷新…', 'ok')
                    setTimeout(() => location.reload(), 700)
                  } catch (e) { toast('恢复失败：' + e.message, 'err') }
                } })
              ),
              h('div', { class: 'settings-note' }, '导出的 JSON 包含 settings、monitors 与 clientmods；导入后会立即刷新页面。')
            ),
            card('存档编辑器', '',
              row('默认 .minecraft 目录', '存档编辑器打开时自动填充；可留空自动检测', pathField(() => S.saveEditor.mcDir, (v) => (S.saveEditor.mcDir = v), '例如 C:\\Users\\你\\AppData\\Roaming\\.minecraft'))
            )
          )
        }
      },
      {
        id: 'about',
        label: '关于',
        iconName: 'info',
        desc: '版本、路径与许可',
        render() {
          const box = h('div', {}, h('div', { class: 'row' }, h('span', { class: 'spinner' }), h('span', { class: 'muted' }, '读取系统信息…')))
          api.get('/api/system/info').then((info) => {
            clear(box)
            const openByWhich = (which, label) => btn('打开', {
              size: 'xs',
              title: '打开' + label,
              onClick: async () => {
                try { await api.post('/api/system/open-path', { which }) } catch (e) { toast(e.message || '打开失败', 'err') }
              }
            })
            const openByPath = (path, label) => btn('打开', {
              size: 'xs',
              title: '打开' + label,
              onClick: async () => {
                try { await api.post('/api/fs/open', { path }) } catch (e) { toast(e.message || '打开失败', 'err') }
              }
            })
            const pathDd = (path, opener) => h('div', { class: 'row', style: { gap: '6px', minWidth: '0', alignItems: 'center' } },
              h('span', { class: 'mono', style: { flex: '1', overflowWrap: 'anywhere' } }, path || '—'),
              opener || null
            )
            box.appendChild(h('dl', { class: 'kv' },
              h('dt', {}, '工具箱版本'), h('dd', {}, `v${info.version || S.version || ''}`),
              h('dt', {}, '作者'), h('dd', {}, info.author || 'Rinkore28'),
              h('dt', {}, '运行环境'), h('dd', {}, `Node ${info.node} · ${info.platform}`),
              h('dt', {}, '项目目录'), h('dd', {}, pathDd(info.root, info.root ? openByPath(info.root, '项目目录') : null)),
              h('dt', {}, '配置目录'), h('dd', {}, pathDd(info.configDir, info.configDir ? openByWhich('configDir', '配置目录') : null)),
              h('dt', {}, 'mod 库目录'), h('dd', {}, pathDd(info.clientModsDir, info.clientModsDir ? openByWhich('clientModsDir', 'mod 库目录') : null)),
              h('dt', {}, '运行数据'), h('dd', {}, pathDd(info.dataDir, info.dataDir ? openByWhich('dataDir', '运行数据目录') : null)),
              h('dt', {}, '功能目录'), h('dd', {}, pathDd(info.featuresDir, info.featuresDir ? openByPath(info.featuresDir, '功能目录') : null))
            ))
            box.appendChild(h('div', { class: 'settings-actions' },
              h('a', { class: 'btn btn-sm', href: 'https://github.com/WJ1752/mc-toolbox', target: '_blank', rel: 'noopener' }, '打开仓库'),
              h('span', { class: 'settings-note', style: { flex: '1', margin: '0' } }, '所有配置文件都保存在配置目录，可直接用文本编辑器修改或分享。')
            ))
          }).catch((e) => {
            clear(box)
            box.appendChild(h('div', { class: 'error-state' }, '读取系统信息失败：' + e.message))
          })
          return panel('关于', '本工具不包含遥测；所有配置和数据都保存在本机。',
            card('关于本工具箱', '', box),
            card('许可与运行时', '',
              h('div', { class: 'settings-note' }, '前端零第三方运行时依赖（无框架、无 CDN、无在线字体）。打包版内嵌 Node.js 运行时与 Microsoft Edge WebView2，分别遵循其上游许可。'),
              h('div', { class: 'settings-note' }, '整合包翻译由内置的 mc-i18n 提供（vendor/mc-i18n），以子进程方式运行。'),
              h('div', { class: 'settings-note' }, '界面作者水印「Rinkore28」是完整性校验的一部分，必须保留。')
            )
          )
        }
      }
    ]
  }

  function featureIconName(f) {
    const map = {
      'server-status': 'signal',
      'latency-monitor': 'pulse',
      'client2server': 'swap',
      'community-download': 'package-down',
      'server-core': 'chip',
      'i18n': 'language',
      'save-editor': 'cube',
      'server-manager': 'terminal'
    }
    return map[f.id] || 'puzzle'
  }

  async function loadDirs(box) {
    let dirs
    try {
      dirs = await api.get('/api/dirs')
    } catch (e) {
      clear(box)
      box.appendChild(h('div', { class: 'muted' }, '读取目录信息失败：' + e.message))
      return
    }
    const rows = {
      configDir: { label: '配置目录', desc: 'settings.json / monitors.json 等配置文件' },
      clientModsDir: { label: 'mod 库目录', desc: '仅客户端 mod 库（clientmods.json）' },
      dataDir: { label: '运行数据目录', desc: '历史曲线、日志等运行数据' }
    }
    // 一键迁移入口：三类目录同源，放在逐目录设置之上。
    // 高亮用内联样式（公共样式表由其他改动维护，这里不新增选择器，避免互相覆盖）。
    function rootRow() {
      const rootBtn = btn('选择文件夹并迁移…', { variant: 'primary', size: 'sm', onClick: async () => {
        const target = await pickDir('', { title: '选择迁移目标文件夹' })
        if (!target) return
        // 仅用于确认框展示：按用户所选路径的分隔符拼接（服务端最终会自己 resolve）
        const sep = target.includes('\\') ? '\\' : '/'
        const sub = (name) => target.replace(/[\\/]+$/, '') + sep + name
        const ok = await confirmDialog(
          `把三类目录一起迁移到：\n  ${target}\n\n` +
          `配置目录：\n  ${dirs.configDir}\n  → ${sub('config')}\n\n` +
          `mod 库目录：\n  ${dirs.clientModsDir}\n  → ${sub('client-mods')}\n\n` +
          `运行数据目录：\n  ${dirs.dataDir}\n  → ${sub('data')}\n\n` +
          '所有文件会先复制并校验，三类全部通过后才清空原位置。迁移中请勿关闭应用。',
          { danger: true, okText: '迁移' })
        if (!ok) return
        rootBtn.disabled = true
        try {
          const r = await api.post('/api/dirs/root', { target })
          if (r.error) throw new Error(r.error)
          toast(`已迁移 ${r.files} 个文件（${fmtSize(r.bytes)}）到 ${r.root}`, 'ok')
          dirs = await api.get('/api/dirs')
          renderDirRows()
        } catch (e) {
          toast('迁移失败：' + e.message, 'err')
        } finally { rootBtn.disabled = false }
      } })
      const node = row('一键迁移到单个文件夹',
        '配置、mod 库与运行数据会一起搬到所选文件夹的 config / client-mods / data 子目录，便于整包备份或换机',
        rootBtn)
      node.style.padding = '10px 12px'
      node.style.margin = '6px 0 2px'
      node.style.border = '1px solid color-mix(in srgb, var(--accent) 40%, var(--line))'
      node.style.borderRadius = 'var(--r-2)'
      node.style.background = 'color-mix(in srgb, var(--accent) 8%, transparent)'
      return node
    }
    function renderDirRows() {
      clear(box)
      box.appendChild(rootRow())
      box.appendChild(h('p', { class: 'settings-note' },
        `一键迁移不会搬走引导文件 dirs.json，它始终留在默认数据目录（${dirs.dirsFile}），请勿删除。`))
      for (const which of dirs.movable || ['configDir', 'clientModsDir', 'dataDir']) {
        box.appendChild(dirRow(which))
      }
      box.appendChild(h('p', { class: 'settings-note' },
        `目录记录保存在 ${dirs.dirsFile}（引导文件，始终留在默认位置，请勿删除）。迁移中请勿关闭应用。`))
    }
    function dirRow(which) {
      const meta = rows[which] || { label: which, desc: '' }
      const changeBtn = btn('更改…', { size: 'sm', onClick: async () => {
        const target = await pickDir(dirs[which], { title: '选择新的' + meta.label })
        if (!target || target === dirs[which]) return
        const ok = await confirmDialog(
          `把「${meta.label}」从：\n  ${dirs[which]}\n迁移到：\n  ${target}\n\n所有文件会先复制并校验，通过后清空原目录。迁移中请勿关闭应用。`,
          { danger: true, okText: '迁移' })
        if (!ok) return
        changeBtn.disabled = true
        try {
          const r = await api.post('/api/dirs/change', { which, target })
          if (r.error) throw new Error(r.error)
          toast(`${meta.label}已迁移：${r.files} 个文件（${fmtSize(r.bytes)}）→ ${r.target}`, 'ok')
          dirs = await api.get('/api/dirs')
          renderDirRows()
        } catch (e) {
          toast('迁移失败：' + e.message, 'err')
        } finally { changeBtn.disabled = false }
      } })
      const resetBtn = btn('恢复默认', {
        size: 'sm',
        disabled: !dirs.custom?.[which],
        onClick: async () => {
          const ok = await confirmDialog(`把「${meta.label}」恢复为默认目录？\n文件会迁移回：\n  ${dirs.defaults[which]}`, { danger: true, okText: '恢复' })
          if (!ok) return
          resetBtn.disabled = true
          try {
            const r = await api.post('/api/dirs/reset', { which })
            if (r.error) throw new Error(r.error)
            toast(`${meta.label}已恢复默认（${r.files} 个文件已迁回）`, 'ok')
            dirs = await api.get('/api/dirs')
            renderDirRows()
          } catch (e) {
            toast('恢复失败：' + e.message, 'err')
          } finally { resetBtn.disabled = false }
        }
      })
      return h('div', { class: 'dir-card' },
        h('div', { class: 'dc-head' },
          h('b', {}, meta.label),
          dirs.custom?.[which] ? h('span', { class: 'badge accent' }, '自定义') : null,
          h('span', { class: 'muted', style: { fontSize: '11px' } }, meta.desc)
        ),
        h('div', { class: 'dc-path' },
          icon('folder', { size: 13 }),
          h('span', {}, dirs[which] || '—')
        ),
        h('div', { class: 'dc-actions' },
          btn('打开', { size: 'sm', onClick: async () => {
            try { await api.post('/api/system/open-path', { which }) } catch (e) { toast(e.message, 'err') }
          } }),
          changeBtn,
          resetBtn
        )
      )
    }
    renderDirRows()
  }

  function fmtSize(n) {
    if (n == null) return '?'
    return fmtBytes(n)
  }

  /* ---------------- navigation ---------------- */

  const NAV_GROUPS = [
    ['工作台', ['general', 'network']],
    ['工具', ['monitor', 'c2s', 'community', 'servercore', 'i18n', 'features']],
    ['系统', ['data', 'about']]
  ]

  function renderNav() {
    clear(nav)
    for (const [group, ids] of NAV_GROUPS) {
      nav.appendChild(h('div', { class: 'nav-group' }, group))
      for (const id of ids) {
        const s = SECTIONS.find((x) => x.id === id)
        if (!s) continue
        const b = h('button', {
          type: 'button',
          class: id === active ? 'active' : '',
          dataset: { section: id },
          title: s.label,
          onclick: () => openSection(id)
        }, icon(s.iconName, { size: 15 }), h('span', {}, s.label))
        nav.appendChild(b)
      }
    }
  }

  function openSection(id) {
    active = SECTIONS.some((s) => s.id === id) ? id : 'general'
    for (const b of nav.querySelectorAll('button')) b.classList.toggle('active', b.dataset.section === active)
    renderContent()
    content.scrollTop = 0
  }

  function renderContent() {
    clear(content)
    const s = SECTIONS.find((x) => x.id === active) || SECTIONS[0]
    try {
      content.appendChild(s.render())
    } catch (e) {
      console.error('[settings] render failed', active, e)
      content.appendChild(h('div', { class: 'error-state' }, '设置分区渲染失败：' + e.message))
    }
  }

  renderNav()

  return {
    open(sectionId = 'general') {
      if (page.hidden) {
        const ws = document.getElementById('workspace')
        restoreScroll = ws?.scrollTop || 0
      }
      S = clone(ctx.getSettings())
      MIRROR = S
      active = SECTIONS.some((x) => x.id === sectionId) ? sectionId : 'general'
      setSaveState('即时保存')
      renderNav()
      openSection(active)
      page.hidden = false
    },
    close() {
      flush()
      page.hidden = true
      const ws = document.getElementById('workspace')
      if (ws) ws.scrollTop = restoreScroll
      setSaveState('即时保存')
    },
    isOpen: () => !page.hidden,
    refreshTheme: applyLive,
    openSection,
    sections: () => SECTIONS.map((s) => ({ id: s.id, label: s.label, desc: s.desc, iconName: s.iconName })),
    flush
  }
}

export function getSettingsMirror() {
  return MIRROR
}
