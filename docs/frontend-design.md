# 前端设计说明 · The Bench（铸造台）

> 目标不是“像网页”，而是一张用久了会有包浆的工匠工作台：近黑石墨台面、氧化铜配件、翡翠色指示灯，信息像仪表刻度一样精确排列。

## 1. 设计方向

- **材质**：台面近黑石墨，叠加 2–5% 噪点与极淡的 115° 斜向拉丝；面板比台面亮一级，1px 内高光 + 1px 外描边，像嵌进台面的金属板。
- **插槽**：功能图标底座是 26×26（放大视图 30×30）的方形槽，内阴影 + 极轻描边，暗示“这里可以放一件工具”。
- **颜色纪律**：大面积永远中性灰；只有状态点、进度、图表和主按钮使用饱和色。主按钮使用用户强调色（默认铜 `#C07A4A`），危险用红石 `#D9584C`，成功用翡翠 `#63C77E`，信息用青绿 `#4E9B8A`，链接/选中用青金 `#4A7DBD`。
- **字体**：正文 `"MiSans", "HarmonyOS Sans SC", "Microsoft YaHei UI", "Segoe UI", system-ui`；IP、路径、版本、日志、数值使用 `"JetBrains Mono", "Cascadia Mono", Consolas`。不加载在线字体，数字使用 `tabular-nums`。
- **图标**：`public/js/ui/icons.js` 自绘 20×20 双色像素几何，1.35px 方头线宽、45° 斜角。`#` 前缀表示 42% 透明度的次线条，`~` 表示实心。manifest 里的 emoji 仍被读取但不再渲染为主图标；未知功能回退到拼图/首字。
- **动效**：120–180ms，`cubic-bezier(.2,.7,.3,1)`。弹窗淡入 + 4px 上移；拖拽抬起 2px 并加阴影；进度条只做宽度过渡；`prefers-reduced-motion` 与「界面动画」开关都会让动效归零。

## 2. 色板

暗色（默认）：

| Token | 值 | 用途 |
| --- | --- | --- |
| `--bg` | `#0F1115` | 应用底色 |
| `--bg-2` | `#14171C` | 工作区 / 放大视图 |
| `--surface` | `#1A1E24` | 卡片 |
| `--surface-2` | `#21262E` | 输入、内嵌面板 |
| `--surface-3` | `#2A3039` | 悬停、轨道 |
| `--line` | `#2E3540` | 分隔线 |
| `--line-hi` | `#3D4653` | 悬停描边 |
| `--text` | `#E9ECEF` | 主文字 |
| `--dim` | `#A3ACB8` | 次文字 |
| `--mute` | `#6E7783` | 弱文字 |
| `--copper` | `#C07A4A` | 品牌铜、分区标记 |
| `--patina` | `#4E9B8A` | 次强调 / 信息 |
| `--emerald` | `#63C77E` | 成功 / 在线 |
| `--gold` | `#E3B341` | 警告 / 排队 |
| `--redstone` | `#D9584C` | 危险 / 失败 |
| `--lapis` | `#4A7DBD` | 链接 / 选中 |

浅色主题「图纸」：纸底 `#F2EFE8`、面板 `#FBF9F4`、墨色文字 `#23262B`、描边 `#D6D0C4`，语义色降饱和并加深，保证白底对比度。

`gray / orange / red / blue` 不是换背景，而是按同一材质逻辑重新调和：中性灰台面、氧化橙暖调、红石暖调、青金冷调，各自拥有独立的 surface/line/text 层级。

用户强调色写入 `--accent`，`--accent-soft`、`--accent-line`、`--accent-ink` 由 `color-mix()` 派生；主按钮使用近黑文字，避免亮色强调色上的白字对比度不足。

## 3. 字号与间距

| 级别 | 字号 | 用途 |
| --- | --- | --- |
| 辅助 | 11px | 设置说明、表格头、状态栏 |
| 正文 | 12px | 绝大多数界面文字 |
| 重点 | 13px | 磁贴标题、弹窗标题、按钮 |
| 卡片标题 | 15px | 放大视图标题、详情服务器名 |
| 分区标题 | 18px | 工作台标题 |
| 设置大标题 | 24px | 设置页 `h2` |

行高 1.55；间距使用 4/6/8/12/16/20/24/32 八级；圆角只有 3 / 5 / 8px 三档，避免“圆角卡片堆叠”。

## 4. 应用骨架

```
┌──────────────────────────────────────────────────────────┐
│ Titlebar 40   品牌/版本      本地服务 · 命令 K      窗口键 │
├──────┬───────────────────────────────────────────────────┤
│ Rail │ Workspace  工作台 / 列数 / 全部折叠 / 添加 / 重载 │
│ 52   │  masonry 磁贴网格                                 │
├──────┴───────────────────────────────────────────────────┤
│ Statusbar 24  心跳 · 监测引擎 · 任务数 · 版本 · 水印      │
└──────────────────────────────────────────────────────────┘
```

- ≥1600px 时内容最大宽 1440 居中；≤1100px 时 Rail 收为 44、磁贴强制单列（CSS 媒体查询以 `!important` 覆盖 `--tile-cols`）；≤860px 时设置导航收为图标列。
- Rail：工作台、启用功能的快捷入口（带状态点）、添加、设置。功能入口点击滚动并短暂高亮；磁贴不存在时先添加。
- 状态栏：心跳点（绿/黄/红）、监测引擎（点击进设置）、进行中任务数（点击开抽屉）、版本、`Rinkore28` 低透明度水印（不可选中）。
- 放大视图：覆盖 Rail + 工作区（标题栏与状态栏保留），标题 52px，内容区最大宽 1240 居中；无 `renderExpanded` 的旧功能回退为“放大挂载”并给出说明。
- 设置页：整页左导航（216px）+ 右内容，内容最大宽 840；关闭后恢复工作台滚动位置。

## 5. 组件与用法

| 组件 | 选择器 / API | 说明 |
| --- | --- | --- |
| Button | `.btn` + `.btn-primary/-danger/-ghost/-ok`，`.btn-sm/-xs`；`btn()` | 6 态：默认/hover/active/focus/disabled/loading |
| IconButton | `.icobtn`；`iconBtn()` | 必须有 `aria-label` 与 `title`，focus-visible 2px |
| Field | `.field`、`.input`、`.input-group`；`field()/input()` | label + hint + error；只读路径用 mono |
| Segmented | `.seg`；`seg()` | 单选过滤，含 `aria-selected` |
| Toggle | `.switch`；`toggle()` | 18px 轨道，焦点环在键盘时出现 |
| Number | `.input[type=number]` + `.unit` | 失焦/回车钳制到范围 |
| Table | `.tbl` / `.tbl-wrap` | 粘性表头、斑马纹、行 hover、数字右对齐 |
| LogViewer | `logViewer()` | 行号、自动滚底（上滚暂停、跳回最新）、复制、下载、清空 |
| Chart | `chart.js` Canvas | DPR、主题色、离线红带、告警线、悬停读数、时间轴 |
| Progress | `.bar`；`progress()` | 确定/不确定两态；不确定不伪造百分比 |
| Modal | `openModal()` / `.modal` | 层级栈、尺寸 sm/md/lg/xl、Esc 逐层、遮罩关闭、焦点陷阱与返回 |
| Drawer | `openDrawer()` / `.drawer` | 右侧任务抽屉，Esc 关闭 |
| Toast | `.toast`；`toast()` | ok/err/warn/info，右下、最多 4 条、3–5 秒、可点击关闭 |
| ContextMenu | `.ctx-menu`；`openContextMenu()` | 磁贴更多、行内操作；方向键导航 |
| Empty/Error | `.empty-state` / `.error-state` | 标题 + 说明 + 动作 |
| Skeleton | `.sk` | 列表加载占位 |
| Tabs | `.tabs` / `.tab` | 世界/玩家/区块等子视图 |
| Accordion | `details.acc` | 高级设置、分组配置 |
| Badge / Kbd / Divider | `.badge` / `.kbd` / `.hr` | 语义色变体 |
| DirPicker | `pickDir()` / `.dp-*` | 盘符、面包屑、快速访问、常用、过滤、新建文件夹、文件模式 |

所有交互元素保留 `:focus-visible` 2px 强调色焦点环；正文对比度 ≥ 4.5:1；危险操作二次确认文案语义与旧版一致。

## 6. 磁贴

- 折叠 40px：图标槽、标题、单行摘要（或 badge）、放大、更多、折叠箭头。
- 展开：头部 40px + 12px 内边距内容区，高度按内容自然撑开（不再用 `h=2` 跨行）。
- 更多菜单：展开/折叠、放大、隐藏、打开该功能设置；非内置功能额外提供删除（二次确认，提示移动到 `features_disabled`）。
- 拖拽：整条 header 可拖（按钮除外），5px 阈值，虚线占位符 + FLIP；松手 280ms 内不触发折叠。
- 多列：1–4 列来自 `general.tileColumns`，多列时每个磁贴占一列；单列时宽度铺满。
- 加载失败：卡片内显示原因与重试，不影响其他磁贴。

## 7. 无障碍与性能

- 键盘：Tab 顺序跟随 DOM；Enter 提交；Esc 关闭当前层；命令面板 ↑↓/Enter；弹窗焦点陷阱。
- `aria-live`：任务状态、日志、Java 下载状态。
- 首屏：静态 HTML 骨架先出，bootstrap 后挂载磁贴；折叠磁贴延迟 `mount`，避免无意义 API/计时器。
- 长列表：日志与表格使用文档片段/上限裁剪；定时器在 unmount 或容器移除时清理。
- 1px 线在 125%/150% DPI 下保持；像素图标 `image-rendering: pixelated`，正文不使用。
- 窄窗 1024 无横向滚动；表格内部滚动；设置导航可折叠。

## 8. 文件结构

```
public/
  index.html
  css/tokens.css      设计令牌与六套主题
  css/base.css        重置、排版、工具类、水印
  css/components.css  按钮/表单/表格/弹层/日志/图表外框
  css/shell.css       标题栏/Rail/工作台/磁贴/状态栏/设置/放大/命令面板/目录选择器
  css/features.css    八个功能的专属表面
  js/app.js           启动、磁贴生命周期、壳层交互
  js/core/*           对外 SDK（api/bus/dom/grid/modal/toast/settings/chart/dirpicker/heartbeat/java-download/pack-preview）
  js/ui/icons.js      图标集与功能图标映射
  js/ui/kit.js        组件工厂
  js/ui/command.js    命令面板
  js/ui/drawer.js     任务抽屉
  js/ui/contextmenu.js 右键菜单
  features/*/tile.js  八个功能的视图层
```
