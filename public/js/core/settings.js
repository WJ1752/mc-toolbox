import { h, clear, debounce } from './dom.js'
import { api } from './api.js'
import { toast } from './toast.js'
import { confirmDialog } from './modal.js'
import { pickDir } from './dirpicker.js'

const ACCENTS = ['#5ec96a', '#3ba0ff', '#c084fc', '#ff8a4c', '#f43f5e', '#22d3ee', '#eab308']

// 每个主题用一个有代表性的主色做「色块圆圈」，light 主题在深色设置页里需要白边框才看得见
// 顺序按色块亮度 从浅到深（自上而下递增）排列
const THEMES = [
  ['light', '浅色', '#f3f5f8'],
  ['gray', '灰调', '#202224'],
  ['orange', '橙调', '#211710'],
  ['blue', '蓝调', '#101722'],
  ['red', '红调', '#1f1214'],
  ['dark', '深色', '#14161a']
]

let S = null          // 设置对象（本地镜像）
let saveFn = null
let ctxRef = null

const save = debounce(async () => {
  try {
    const next = await api.put('/api/settings', S)
    S = next
    ctxRef.onSaved?.(S)
  } catch (e) {
    toast('设置保存失败：' + e.message, 'err')
  }
}, 350)

function commit() {
  save()
}

function applyTheme() {
  document.documentElement.dataset.theme = S.general.theme
  document.documentElement.style.setProperty('--accent', S.general.accent)
  document.documentElement.style.setProperty('--tile-cols', String(Math.max(1, Number(S.general.tileColumns) || 1)))
}

// ---------- 控件工厂 ----------
function row(label, desc, control) {
  return h(
    'div',
    { class: 'setting-row' },
    h('div', { class: 'info' }, h('b', {}, label), desc ? h('span', {}, desc) : null),
    h('div', { class: 'ctrl' }, control)
  )
}

function sw(get, set) {
  const input = h('input', { type: 'checkbox', onchange: (e) => { set(e.target.checked); commit() } })
  input.checked = !!get()
  return h('label', { class: 'switch' }, input, h('span', {}))
}

function num(get, set, { min = 0, max = 999999, step = 1, suffix = '' } = {}) {
  const input = h('input', {
    class: 'input',
    type: 'number',
    value: get(),
    min,
    max,
    step,
    onchange: (e) => {
      let v = Number(e.target.value)
      if (Number.isNaN(v)) v = get()
      v = Math.min(max, Math.max(min, v))
      e.target.value = v
      set(v)
      commit()
    }
  })
  return h('div', { class: 'row' }, input, suffix ? h('span', { class: 'muted' }, suffix) : null)
}

function seg(get, set, options, onChange) {
  const wrap = h('div', { class: 'seg' })
  for (const [v, label] of options) {
    const b = h('button', { class: get() === v ? 'active' : '' }, label)
    b.onclick = () => {
      set(v)
      Array.from(wrap.children).forEach((c) => c.classList.remove('active'))
      b.classList.add('active')
      commit()
      onChange?.(v)
    }
    wrap.appendChild(b)
  }
  return wrap
}

function text(get, set, placeholder = '') {
  return h('input', {
    class: 'input',
    type: 'text',
    value: get() || '',
    placeholder,
    onchange: (e) => {
      set(e.target.value.trim())
      commit()
    }
  })
}

function pathRow(get, set, placeholder = '') {
  const input = h('input', {
    class: 'input mono',
    value: get() || '',
    placeholder,
    onchange: (e) => {
      set(e.target.value.trim())
      commit()
    }
  })
  return h(
    'div',
    { class: 'row' },
    input,
    h('button', {
      class: 'btn btn-sm',
      onclick: async () => {
        const p = await pickDir(input.value || '')
        if (p) {
          input.value = p
          set(p)
          commit()
        }
      }
    }, '浏览')
  )
}

function section(title, desc, ...children) {
  return h('section', { class: 'section' }, h('h4', {}, title), desc ? h('p', { class: 'desc' }, desc) : null, ...children)
}

// ---------- 各分区 ----------
const SECTIONS = [
  {
    id: 'general',
    label: '通用',
    render() {
      const el = h('div')
      el.appendChild(
        section(
          '外观',
          '主题、配色与磁贴布局',
          row('主题', '', (() => {
            const wrap = h('div', { class: 'color-dots theme-dots' })
            for (const [v, label, c] of THEMES) {
              const b = h('button', {
                title: label,
                style: { background: c },
                class: S.general.theme === v ? 'active' : ''
              })
              // light 主题在深色背景里容易看不见，加浅色内阴影/外边框做视觉区分
              if (v === 'light') b.style.boxShadow = 'inset 0 0 0 1px rgba(0,0,0,.12), 0 0 0 1px var(--line)'
              b.onclick = () => {
                S.general.theme = v
                Array.from(wrap.children).forEach((x) => x.classList.remove('active'))
                b.classList.add('active')
                applyTheme()
                commit()
              }
              wrap.appendChild(b)
            }
            return wrap
          })()),
          row('强调色', '按钮与图表主色', h('div', { class: 'color-dots' }, ...ACCENTS.map((c) => h('button', {
            class: S.general.accent === c ? 'active' : '',
            style: { background: c },
            onclick: (e) => {
              S.general.accent = c
              Array.from(e.target.parentElement.children).forEach((b) => b.classList.remove('active'))
              e.target.classList.add('active')
              applyTheme()
              commit()
            }
          })))),
          row('每行磁贴数', '1 = 一行一个；设置多列后每个磁贴默认占一列', num(() => S.general.tileColumns || 1, (v) => { S.general.tileColumns = v; applyTheme() }, { min: 1, max: 4, step: 1, suffix: ' 个' })),
          row('界面动画', '拖拽与弹窗过渡效果', sw(() => S.general.animations, (v) => { S.general.animations = v; ctxRef.onAnimationsChange?.(v) })),
          row('时间格式', '', seg(() => S.general.timeFormat, (v) => (S.general.timeFormat = v), [['24h', '24 小时'], ['12h', '12 小时']])),
          row('新磁贴默认折叠', '只显示图标和标题，点标题栏箭头展开', sw(() => S.general.defaultCollapsed !== false, (v) => { S.general.defaultCollapsed = v; ctxRef.onCollapsedDefaultChange?.(v) }))
        )
      )
      el.appendChild(
        section(
          '操作习惯',
          '',
          row('危险操作二次确认', '删除 mod、移除监测项时弹窗确认', sw(() => S.general.confirmDanger, (v) => (S.general.confirmDanger = v)))
        )
      )
      return el
    }
  },
  {
    id: 'network',
    label: '网络',
    render() {
      const el = h('div')
      el.appendChild(section(
        '探测参数',
        '所有服务器探测 / 监测的默认行为',
        row('超时时间', '单次连接最长等待', num(() => S.network.timeout, (v) => (S.network.timeout = v), { min: 500, max: 30000, step: 500, suffix: 'ms' })),
        row('失败重试次数', '判定失败前的重试', num(() => S.network.retries, (v) => (S.network.retries = v), { min: 0, max: 5, step: 1, suffix: '次' })),
        row('并发探测上限', '同时进行的探测数量', num(() => S.network.concurrency, (v) => (S.network.concurrency = v), { min: 1, max: 64, step: 1, suffix: '个' })),
        row('解析 SRV 记录', '优先使用 _minecraft._tcp 记录', sw(() => S.network.resolveSrv, (v) => (S.network.resolveSrv = v))),
        row('默认服务器类型', '', seg(() => S.network.defaultType, (v) => (S.network.defaultType = v), [['auto', '自动'], ['java', 'Java 版'], ['bedrock', '基岩版']])),
        row('Java 版默认端口', '', num(() => S.network.javaPort, (v) => (S.network.javaPort = v), { min: 1, max: 65535 })),
        row('基岩版默认端口', '', num(() => S.network.bedrockPort, (v) => (S.network.bedrockPort = v), { min: 1, max: 65535 }))
      ))
      el.appendChild(section(
        '下载代理',
        '作用于社区资源下载与服务端核心下载（含安装器联网）；留空直连',
        row('代理地址', '如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080（支持 user:pass@ 认证）', text(() => S.network.proxy, (v) => (S.network.proxy = v), 'http://127.0.0.1:7890'))
      ))
      return el
    }
  },
  {
    id: 'monitor',
    label: '延迟监测',
    render() {
      const el = h('div')
      el.appendChild(
        section(
          '监测策略',
          '影响所有延迟监测磁贴',
          row('默认轮询间隔', '新增监测项时使用', num(() => S.monitor.defaultInterval, (v) => (S.monitor.defaultInterval = v), { min: 5, max: 3600, step: 5, suffix: '秒' })),
          row('默认图表指标', '新增监测项默认显示的指标', seg(() => S.monitor.defaultMetric, (v) => (S.monitor.defaultMetric = v), [['latency', '延迟 (ms)'], ['players', '在线人数'], ['loss', '丢包率']])),
          row('历史保留点数', '每个监测项保留的采样数量', num(() => S.monitor.historyPoints, (v) => (S.monitor.historyPoints = v), { min: 60, max: 10080, step: 60, suffix: '点' })),
          row('离线判定阈值', '连续失败达到该次数判定离线', num(() => S.monitor.offlineAfter, (v) => (S.monitor.offlineAfter = v), { min: 1, max: 10, suffix: '次' })),
          row('延迟告警阈值', '超过该值在图表中标红', num(() => S.monitor.latencyWarn, (v) => (S.monitor.latencyWarn = v), { min: 20, max: 2000, step: 10, suffix: 'ms' })),
          row('展开图显示点数', '', num(() => S.monitor.chartRange, (v) => (S.monitor.chartRange = v), { min: 30, max: 1440, step: 30, suffix: '点' })),
          row('监测磁贴最大宽度', '0 表示不限制', num(() => S.monitor.maxTileWidth ?? 300, (v) => (S.monitor.maxTileWidth = v), { min: 0, max: 800, step: 10, suffix: 'px' })),
          row('监测磁贴高度策略', '固定：统一为设定高度 · 限高：内容超高时截断 · 自适应：随内容', seg(() => S.monitor.tileHeightMode ?? 'fixed', (v) => (S.monitor.tileHeightMode = v), [['fixed', '固定'], ['max', '限制最大'], ['auto', '自适应']])),
          row('磁贴高度（px）', '配合上面的高度策略使用', num(() => S.monitor.tileHeight ?? 100, (v) => (S.monitor.tileHeight = v), { min: 60, max: 500, step: 5, suffix: 'px' })),
          row('启动后自动监测', '工具箱启动时立即开始轮询', sw(() => S.monitor.autoStart, (v) => (S.monitor.autoStart = v)))
        )
      )
      el.appendChild(
        section(
          '监测引擎',
          '',
          h(
            'div',
            { class: 'row' },
            h('button', {
              class: 'btn',
              onclick: async () => {
                const snap = await api.get('/api/monitors')
                const run = !snap.running
                await api.post('/api/monitors/engine', { running: run })
                toast(run ? '监测已启动' : '监测已暂停', 'ok')
              }
            }, '切换运行 / 暂停'),
            h('button', {
              class: 'btn btn-danger',
              onclick: async () => {
                if (S.general.confirmDanger && !(await confirmDialog('确定清空全部监测历史数据吗？此操作不可恢复。', { danger: true }))) return
                await api.del('/api/monitors/history')
                toast('历史数据已清空', 'ok')
              }
            }, '清空历史数据')
          )
        )
      )
      return el
    }
  },
  {
    id: 'c2s',
    label: '客户端转服务端',
    render() {
      return section(
        'mod 处理',
        '客户端转服务端辅助工具的默认行为',
        row('默认 mods 目录', '打开工具时自动填充', pathRow(() => S.client2server.modsDir, (v) => (S.client2server.modsDir = v), '例如 C:\\Users\\...\\.minecraft\\mods')),
        row('备份目录', '移出的仅客户端 mod 存放位置', pathRow(() => S.client2server.backupDir, (v) => (S.client2server.backupDir = v), '留空则使用 mods 目录同级')),
        row('默认处理方式', '', seg(() => S.client2server.defaultAction, (v) => (S.client2server.defaultAction = v), [['disable', '禁用（改后缀名）'], ['backup', '移入备份目录'], ['delete', '直接删除']])),
        row('扫描子目录', '递归查找子文件夹中的 jar', sw(() => S.client2server.scanSubdir, (v) => (S.client2server.scanSubdir = v))),
        row('包含 .jar.disabled', '把已禁用的 mod 也纳入扫描', sw(() => S.client2server.includeDisabled, (v) => (S.client2server.includeDisabled = v))),
        row('自动识别 environment=client', '依据 fabric/quilt 元数据自动标记', sw(() => S.client2server.autoDetectEnv, (v) => (S.client2server.autoDetectEnv = v)))
      )
    }
  },
  {
    id: 'community',
    label: '社区资源',
    render() {
      const el = h('div')
      el.appendChild(
        section(
          '平台与凭据',
          'Modrinth 无需密钥；CurseForge 需要在 console.curseforge.com 申请 Eternal API Key（免费，非商业用途）',
          row('CurseForge API Key', '只保存在本地 data/settings.json', text(() => S.community.cfApiKey, (v) => (S.community.cfApiKey = v), '粘贴你的 Eternal API Key')),
          row('默认来源', '', seg(() => S.community.defaultSource, (v) => (S.community.defaultSource = v), [['modrinth', 'Modrinth'], ['curseforge', 'CurseForge']])),
          row('默认游戏版本', '例如 1.20.1，留空不限', text(() => S.community.defaultGameVersion, (v) => (S.community.defaultGameVersion = v), '1.20.1')),
          row('默认加载器', '', seg(() => S.community.defaultLoader, (v) => (S.community.defaultLoader = v), [['', '不限'], ['fabric', 'Fabric'], ['forge', 'Forge'], ['neoforge', 'NeoForge'], ['quilt', 'Quilt']]))
        )
      )
      el.appendChild(
        section(
          '下载',
          '社区资源下载磁贴的默认行为；线程数、并发数、限速、命名规则',
          row('默认下载目录', '留空则使用系统下载文件夹', pathRow(() => S.community.downloadDir, (v) => (S.community.downloadDir = v), '例如 D:\\MC\\mods')),
          row('单文件线程数', '分段并发下载，不支持 Range 时自动降为 1', num(() => S.community.threads, (v) => (S.community.threads = v), { min: 1, max: 8, step: 1, suffix: '线程' })),
          row('同时下载任务数', '队列并发上限', num(() => S.community.maxConcurrent, (v) => (S.community.maxConcurrent = v), { min: 1, max: 10, step: 1, suffix: '个' })),
          row('全局限速', '所有任务共享的下载速度上限，0 为不限', num(() => S.community.speedLimit, (v) => (S.community.speedLimit = v), { min: 0, max: 1048576, step: 128, suffix: 'KB/s' })),
          row('按类型建子目录', 'mod / 整合包 / 光影等分别存到对应文件夹', sw(() => S.community.subdirByType, (v) => (S.community.subdirByType = v))),
          row('命名规则', '占位符：{project} {version} {loader} {gameversion} {type} {source} {date} {time} {filename} {ext}', text(() => S.community.nameRule, (v) => (S.community.nameRule = v), '{project}-{version}{ext}')),
          row('命名预览', '用一组示例元数据实时预览文件名', h('button', {
            class: 'btn btn-sm',
            onclick: async () => {
              try {
                const r = await api.post('/api/community/preview-name', {
                  rule: S.community.nameRule,
                  filename: 'sodium-fabric-0.5.13+mc1.20.1.jar',
                  meta: { project: 'Sodium', version: '0.5.13', loader: 'fabric', gameVersion: '1.20.1', type: 'mod', source: 'modrinth' }
                })
                toast('预览：' + r.filename, 'ok', 5000)
              } catch (e) {
                toast('预览失败：' + e.message, 'err')
              }
            }
          }, '预览')),
          row('每页结果数', '', num(() => S.community.pageSize, (v) => (S.community.pageSize = v), { min: 5, max: 50, step: 5, suffix: '条' })),
          row('下载任务', '取消所有进行中的任务并清空记录', h('button', {
            class: 'btn btn-sm btn-danger',
            onclick: async () => {
              if (!(await confirmDialog('确定取消所有下载任务并清空记录？已下载的文件不会被删除。', { danger: true }))) return
              await api.del('/api/community/jobs')
              toast('已清空下载记录', 'ok')
            }
          }, '清空任务'))
        )
      )
      return el
    }
  },
  {
    id: 'servercore',
    label: '服务端核心',
    render() {
      return section(
        '启动脚本',
        'Fabric 等服务端安装完成后，自动在目标目录生成 start.bat / start.sh 启动脚本',
        row('分配内存', '写入启动脚本的 -Xms 与 -Xmx，如 2G、4G、1024M', text(() => S.servercore.memory, (v) => (S.servercore.memory = v), '2G'))
      )
    }
  },
  {
    id: 'i18n',
    label: '整合包翻译',
    render() {
      const el = h('div')
      el.appendChild(section(
        '翻译工作台',
        'mc-i18n 会作为工具箱管理的本地子进程运行，翻译项目文件仍保存在你选择的整合包目录中。',
        row('Python 解释器', '开发模式需要 Python 3.10+；留空使用系统 PATH 中的 python', text(() => S.i18n?.pythonPath, (v) => { S.i18n.pythonPath = v }, 'python')),
        row('启动工具箱时自动启动', '打开工具箱后自动准备翻译工作台', sw(() => S.i18n?.autoStart, (v) => { S.i18n.autoStart = v })),
        row('运行状态', '检查内置运行时、Python 和 Web 工作台是否可用', h('div', { class: 'row wrap' },
          h('button', {
            class: 'btn btn-sm btn-primary',
            onclick: async (e) => {
              e.currentTarget.disabled = true
              try {
                const s = await api.post('/api/i18n/start', { i18n: S.i18n || {} })
                toast(`翻译工作台已启动${s.port ? `（端口 ${s.port}）` : ''}`, 'ok')
              } catch (err) {
                toast('翻译引擎启动失败：' + err.message, 'err')
              } finally {
                e.currentTarget.disabled = false
              }
            }
          }, '测试并启动'),
          h('button', {
            class: 'btn btn-sm',
            onclick: async (e) => {
              e.currentTarget.disabled = true
              try {
                await api.post('/api/i18n/stop')
                toast('翻译工作台已停止', 'ok')
              } catch (err) {
                toast('停止翻译引擎失败：' + err.message, 'err')
              } finally {
                e.currentTarget.disabled = false
              }
            }
          }, '停止')
        ))
      ))
      el.appendChild(section(
        '使用说明',
        '启动后打开“整合包翻译”磁贴即可进入完整工作台，扫描、批量翻译、术语表、任务书、校对和资源包打包功能均由 mc-i18n 提供。',
        h('div', { class: 'muted' }, '开发模式需要 Python 3.10+。发布单文件前，可在 vendor/mc-i18n/dist/ 放置 mc-i18n.exe，这样目标电脑无需单独安装 Python。')
      ))
      return el
    }
  },
  {
    id: 'features',
    label: '功能与磁贴',
    render() {
      const el = h('div')
      const listWrap = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } })

      async function renderList() {
        clear(listWrap)
        const data = await api.get('/api/features')
        for (const f of data.items) {
          const enabledSw = sw(() => f.enabled, async (v) => {
            await api.put('/api/features/' + f.id, { enabled: v })
            if (!v) ctxRef.onFeatureToggle?.(f.id, false)
            toast(v ? `${f.name} 已启用` : `${f.name} 已禁用`, 'ok')
            renderList()
          })
          const visibleSw = sw(() => f.visible, async (v) => {
            await api.put('/api/features/' + f.id, { visible: v })
            ctxRef.onFeatureToggle?.(f.id, v && f.enabled)
            renderList()
          })
          listWrap.appendChild(
            h(
              'div',
              { class: 'feature-item' },
              h('div', { class: 'fi-icon', style: { background: f.color } }, f.icon),
              h('div', { class: 'fi-main' }, h('b', {}, f.name + ' '), h('span', { class: 'muted mono' }, `${f.id} · v${f.version}`), h('span', {}, f.desc || '')),
              h('div', { class: 'row', style: { gap: '14px' } },
                h('div', { class: 'field', style: { alignItems: 'center' } }, h('label', {}, '启用'), enabledSw),
                h('div', { class: 'field', style: { alignItems: 'center' } }, h('label', {}, '显示'), visibleSw),
                h('button', {
                  class: 'btn btn-sm btn-danger',
                  disabled: f.builtin,
                  title: f.builtin ? '内置功能不可删除' : '移动到 features_disabled 目录',
                  onclick: async () => {
                    if (!(await confirmDialog(`确定删除功能「${f.name}」？目录将被移动到 features_disabled。`, { danger: true }))) return
                    await api.del('/api/features/' + f.id)
                    toast('功能已移除', 'ok')
                    renderList()
                    ctxRef.onReload?.()
                  }
                }, '删除')
              )
            )
          )
        }
      }
      renderList()

      el.appendChild(
        section(
          '已安装功能',
          '新增功能：在 public/features 下新建目录（含 manifest.json + tile.js）后点击「重新扫描」即可出现',
          h('div', { class: 'row' },
            h('button', { class: 'btn', onclick: () => ctxRef.openAddTile?.() }, '＋ 添加磁贴'),
            h('button', { class: 'btn', onclick: async () => { await api.post('/api/features/reload'); renderList(); ctxRef.onReload?.(); toast('已重新扫描功能目录', 'ok') } }, '↻ 重新扫描'),
            h('button', { class: 'btn', onclick: () => ctxRef.onResetLayout?.() }, '重置磁贴布局')
          ),
          h('div', { class: 'hr' }),
          listWrap
        )
      )
      return el
    }
  },
  {
    id: 'data',
    label: '数据管理',
    render() {
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
      const el = h('div')
      el.appendChild(
        section(
          '存储目录',
          '更改目录会把原目录里的所有文件完整转移到新位置（校验通过后才会清空原目录），立即生效，无需重启。',
          dirPickerCard()
        )
      )
      el.appendChild(
        section(
          '备份与恢复',
          '设置、监测项、仅客户端 mod 库',
          h('div', { class: 'row wrap' },
            h('button', {
              class: 'btn',
              onclick: async () => {
                const data = await api.get('/api/data/export')
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
                const a = document.createElement('a')
                a.href = URL.createObjectURL(blob)
                a.download = `mc-toolbox-backup-${new Date().toISOString().slice(0, 10)}.json`
                a.click()
                URL.revokeObjectURL(a.href)
                toast('已导出配置', 'ok')
              }
            }, '导出配置'),
            h('button', { class: 'btn', onclick: () => fileInput.click() }, '导入配置'),
            fileInput,
            h('button', {
              class: 'btn btn-danger',
              onclick: async () => {
                if (!(await confirmDialog('恢复默认设置会清空所有个性化配置（不含监测项与 mod 库），确定继续？', { danger: true }))) return
                await api.post('/api/settings/reset')
                toast('设置已恢复默认，正在刷新…', 'ok')
                setTimeout(() => location.reload(), 700)
              }
            }, '恢复默认设置')
          )
        )
      )
      return el
    }
  },
  {
    id: 'about',
    label: '关于',
    render() {
      const box = h('div')
      const openDir = async (which) => {
        try { await api.post('/api/system/open-path', { which }) } catch (e) { toast(e.message || '打开失败', 'err') }
      }
      const rowWithOpen = (p, which) =>
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('span', { class: 'mono', style: { flex: '1', wordBreak: 'break-all' } }, p || '—'),
          which ? h('button', { class: 'btn btn-sm', onclick: () => openDir(which) }, '📂 打开') : null)
      api.get('/api/system/info').then((info) => {
        box.appendChild(
          h('dl', { class: 'kv' },
            h('dt', {}, '工具箱版本'), h('dd', {}, info.version || '1.5.4'),
            h('dt', {}, '作者'), h('dd', {}, info.author || 'Rinkore28'),
            h('dt', {}, '运行环境'), h('dd', {}, `Node ${info.node} · ${info.platform}`),
            h('dt', {}, '项目目录'), h('dd', { class: 'mono' }, info.root),
            h('dt', {}, '配置目录'), h('dd', {}, rowWithOpen(info.configDir, 'configDir')),
            h('dt', {}, 'mod 库目录'), h('dd', {}, rowWithOpen(info.clientModsDir, 'clientModsDir')),
            h('dt', {}, '运行数据'), h('dd', {}, rowWithOpen(info.dataDir, 'dataDir')),
            h('dt', {}, '功能目录'), h('dd', { class: 'mono' }, info.featuresDir)
          )
        )
        box.appendChild(h('p', { class: 'muted', style: { marginTop: '6px', lineHeight: '1.7' } },
          '所有配置项（settings.json / monitors.json 等）都保存在「配置目录」，mod 库保存在「mod 库目录」，可直接用文本编辑器修改、或复制给其他人分享。'))
        box.appendChild(h('p', { class: 'muted', style: { marginTop: '10px', lineHeight: '1.7' } },
          '所有功能相互独立，删除任意功能目录不会影响其他功能。新增功能只需在功能目录里放一个 manifest.json 和 tile.js。'))
      })
      return section('关于本工具箱', '', box)
    }
  }
]

// ---------- 存储目录卡片（更改目录 + 自动迁移文件） ----------
function dirPickerCard() {
  const box = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } })
  let dirs = null

  const rows = {
    configDir: { label: '配置目录', desc: 'settings.json / monitors.json 等配置文件' },
    clientModsDir: { label: 'mod 库目录', desc: '仅客户端 mod 库（clientmods.json）' },
    dataDir: { label: '运行数据目录', desc: '历史曲线、日志等运行数据' }
  }

  api.get('/api/dirs').then((r) => {
    dirs = r
    render()
  }).catch((e) => {
    box.appendChild(h('div', { class: 'muted' }, '读取目录信息失败：' + e.message))
  })

  function render() {
    clear(box)
    for (const which of dirs.movable || ['configDir', 'clientModsDir', 'dataDir']) {
      box.appendChild(dirRow(which))
    }
    box.appendChild(h('p', { class: 'muted', style: { margin: '2px 0 0', lineHeight: '1.7', fontSize: '12.5px' } },
      `目录记录保存在 ${dirs.dirsFile}（引导文件，始终留在默认位置，请勿删除）。迁移中请勿关闭应用。`))
  }

  function dirRow(which) {
    const meta = rows[which] || { label: which, desc: '' }
    const pathEl = h('span', { class: 'mono', style: { flex: '1', wordBreak: 'break-all' } }, dirs[which])
    const badge = h('span', { class: 'badge' + (dirs.custom?.[which] ? ' info' : ''), style: { display: dirs.custom?.[which] ? '' : 'none' } }, '自定义')

    const btnChange = h('button', {
      class: 'btn btn-sm',
      onclick: async () => {
        const target = await pickDir(dirs[which], { title: '选择新的' + meta.label })
        if (!target || target === dirs[which]) return
        const ok = await confirmDialog(
          `把「${meta.label}」从：\n  ${dirs[which]}\n迁移到：\n  ${target}\n\n所有文件会先复制并校验，通过后清空原目录。迁移中请勿关闭应用。`,
          { danger: true, okText: '迁移' })
        if (!ok) return
        btnChange.disabled = true
        try {
          const r = await api.post('/api/dirs/change', { which, target })
          if (r.error) throw new Error(r.error)
          toast(`${meta.label}已迁移：${r.files} 个文件（${fmtSize(r.bytes)}）→ ${r.target}`, 'ok')
          dirs = await api.get('/api/dirs')
          render()
        } catch (e) {
          toast('迁移失败：' + e.message, 'err')
        } finally { btnChange.disabled = false }
      }
    }, '更改…')

    const btnReset = h('button', {
      class: 'btn btn-sm',
      disabled: !dirs.custom?.[which],
      onclick: async () => {
        const ok = await confirmDialog(`把「${meta.label}」恢复为默认目录？\n文件会迁移回：\n  ${dirs.defaults[which]}`, { danger: true, okText: '恢复' })
        if (!ok) return
        btnReset.disabled = true
        try {
          const r = await api.post('/api/dirs/reset', { which })
          if (r.error) throw new Error(r.error)
          toast(`${meta.label}已恢复默认（${r.files} 个文件已迁回）`, 'ok')
          dirs = await api.get('/api/dirs')
          render()
        } catch (e) {
          toast('恢复失败：' + e.message, 'err')
        } finally { btnReset.disabled = false }
      }
    }, '恢复默认')

    return h('div', { class: 'mod-row', style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 12px', borderRadius: '10px', border: '1px solid var(--line)' } },
      h('div', { class: 'row', style: { alignItems: 'center', gap: '8px' } },
        h('strong', {}, meta.label), badge,
        h('span', { class: 'muted', style: { fontSize: '12px' } }, meta.desc)),
      h('div', { class: 'row', style: { alignItems: 'center', gap: '8px' } },
        pathEl,
        h('button', { class: 'btn btn-sm', onclick: () => api.post('/api/system/open-path', { which }).catch((e) => toast(e.message, 'err')) }, '📂 打开'),
        btnChange, btnReset))
  }

  function fmtSize(n) {
    if (n == null) return '?'
    if (n < 1024) return n + ' B'
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
    return (n / 1048576).toFixed(1) + ' MB'
  }

  return box
}

// ---------- 对外接口 ----------
export function initSettings(ctx) {
  ctxRef = ctx
  S = ctx.getSettings()
  saveFn = save
  applyTheme()

  const page = document.getElementById('settingsPage')
  const nav = document.getElementById('settingsNav')
  const content = document.getElementById('settingsContent')

  clear(nav)
  let active = 'general'
  for (const s of SECTIONS) {
    nav.appendChild(
      h('button', {
        class: s.id === active ? 'active' : '',
        onclick: (e) => {
          active = s.id
          Array.from(nav.children).forEach((c) => c.classList.remove('active'))
          e.target.classList.add('active')
          renderContent()
          document.querySelector('.settings-body').scrollTop = 0
        }
      }, s.label)
    )
  }

  function renderContent() {
    S = ctx.getSettings()
    clear(content)
    const s = SECTIONS.find((x) => x.id === active) || SECTIONS[0]
    content.appendChild(s.render())
  }

  return {
    open() {
      renderContent()
      page.hidden = false
    },
    close() {
      page.hidden = true
    },
    isOpen: () => !page.hidden,
    refreshTheme: applyTheme
  }
}

export function getSettingsMirror() {
  return S
}
