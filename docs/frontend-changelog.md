# 旧版 → 新版对照说明

基线：`v1.6.3` / `9a299c0`（`main`）
新版分支：`rewrite/frontend-bench-v1`
范围：只重写 `public/`，`server.js`、`src/server/**`、`host/**`、`build.mjs` 未改动（v1.7.0 发布时另含 `src/server/dirs.js`、`api.js`、`monitor.js` 的目录迁移与轮询修复，见 README 更新说明）。

## 1. 一句话

按钮还在原来的位置，只是台面终于像一张 2026 年的工匠工作台了。

## 2. 信息架构

| 区域 | 旧版 | 新版 | 变了吗 |
| --- | --- | --- | --- |
| 顶栏 | 品牌 + 4 个文字按钮 + 窗口三键 | 40px Titlebar：品牌/版本、本地服务状态、命令面板、窗口三键 | 视觉重做；入口等价 |
| 导航 | 无，只有工作台 | 52px Rail：工作台、8 个功能快捷入口（带状态点）、添加、设置 | 新增快捷入口；原入口全部保留 |
| 工作台工具条 | 折叠/添加/重载/设置 | 列数 1–4、全部折叠、添加、重载 | 设置移入 Rail；列数直接可调 |
| 状态栏 | 无 | 24px：心跳、监测引擎、任务数、版本、作者水印 | 新增；心跳断线横幅保留 |
| 设置 | 整页，10 分区 | 整页左导航 + 右内容，10 分区 | 字段一一对应，新增分组与说明 |
| 磁贴 | 40px 折叠 / 内容撑开 | 同；新增折叠摘要、更多菜单、放大视图 | 行为一致，视觉重做 |

## 3. 设计系统

- 新增 `css/tokens.css`（六主题 + 语义色 + 字号/间距/动效）、`base.css`（重置、排版、焦点、水印）、`components.css`（按钮/表单/表格/弹层/日志/图表外框）、`shell.css`（标题栏/Rail/工作台/磁贴/设置/放大/命令面板/目录选择器）、`features.css`（八个功能专属表面）。
- 自绘 20×20 双色图标集与功能映射：`js/ui/icons.js`。manifest 的 emoji 字段保留用于兼容，但不再作为界面主图标。
- 组件工厂 `js/ui/kit.js`：Button、Field、Select、Segmented、Toggle、Table、LogViewer、Progress、Modal、Drawer、Toast、ContextMenu、Empty/Error、Spinner、Badge、Kbd、Tabs、Accordion。
- 新增命令面板（`Ctrl/Cmd+K`）、右侧任务抽屉、磁贴更多右键菜单、目录选择器重绘。
- 六主题全部按新材质语言重新调和：`dark / light（图纸）/ gray / orange / red / blue`。
- 动效统一 120–180ms；尊重 `prefers-reduced-motion` 与「界面动画」开关。

## 4. 八个功能

| 功能 | 新组织方式 | 未变的部分 |
| --- | --- | --- |
| 服务器在线测试 | 服务器档案：64px 图标槽 + MOTD/版本/人数/延迟/解析地址；快捷条为可横向滚动 chip | 地址/端口/类型、快捷内置与自定义、原始数据、加入监测、lastHost、全部错误原因 |
| 服务器延迟监测 | 仪表卡（状态灯 + 名称 + 大数字 + 单位 + sparkline）；详情为双栏统计 + 图表 + 记录；放大视图独立轮询 | 添加/编辑/删除、引擎启停、批量指标、拖拽排序、宽度/高度策略、4s 轮询、全部统计与历史 |
| 客户端转服务端 | 两模式分段：清理四段式（目录→扫描→表格→处理）；转换三步向导（来源→配置→进度/结果） | 扫描/过滤/全选/匹配规则、四种处理方式与危险确认、mod 库增删改、脚本绑定、上传与转换任务、Java/内存/世界预设/随包 Java |
| 社区资源下载 | 固定搜索区、两列紧凑结果卡、右侧任务抽屉；详情保留项目简介/链接/版本/文件 | 源/类型/加载器/版本/排序/分页、命名规则、下载目录、任务列表、CurseForge Key 回退 |
| 服务端核心下载 | 三步纵向流程（加载器→版本→目标）+ 底部下载；任务留在卡片内 | 7 种加载器、在线版本、Cleanroom 锁定 1.12.2、Java 共用组件、任务状态与取消 |
| 整合包翻译 | 引擎控制台：大状态灯 + 说明 + 三个按钮 + 端口/地址 | 状态轮询、启动/停止/打开工作台、autoStart、错误详情、外部工作台 |
| 存档编辑器 | 左栏可搜索世界列表 + 右栏「世界/玩家/区块」页签；区块编辑器全屏、可缩放平移 | 目录检测、世界属性、玩家数据、备份提示、区域分布、16×16 俯视图、批量/坐标替换、跳转区块 |
| 开服管理 | 控制台：状态条 + 启停 + LogViewer + 命令输入；导入向导；配置收进分组折叠区 | 拖入/选择、核心识别、Java/内存/网络/JVM/EULA、启动/正常停服/强制停止、命令、会话恢复、实时日志 |

## 5. 接口、数据与扩展协议（未变）

- 所有 API 方法、路径、请求体键集合保持原样；上传的 `X-File-Name` 与 query 键一致。
- `settings.json` / `monitors.json` / `clientmods.json` / `history.json` 结构未改；设置键名与默认值未改；`version` 不变。
- `settings.layout` 继续保存 `{id,w,h,collapsed}`；已删除功能的 id 被安全忽略。
- `public/features/<id>/manifest.json` 字段与 `dir` 注入逻辑不变。
- `/js/core/*` 模块路径与导出保留；`ctx` 原字段全部保留，仅新增 `openBench`。
- 旧 `tile.js` 仍可通过旧查询接口与 `ctx` 挂载；`mount/unmount/renderExpanded` 签名不变。
- 完整性校验范围仍是 `index.html`、`css/`、`js/`；`Rinkore28` 作者标识与水印保留。

## 6. 有意差异（不是功能删减）

1. **翻译工作台打开方式**：旧版在弹窗里用 iframe 内嵌；新版按规范用系统浏览器新窗口打开，并在磁贴/设置中显示端口与地址。真实 mc-i18n 工作台功能不变。
2. **延迟监测轮询**：旧磁贴用 `max(2000, defaultInterval*1000/4)`（默认约 7.5s），新版按规范固定 4s；请求与数据格式不变。
3. **磁贴折叠触发区**：旧版点击磁贴正文空白处也会折叠；新版只有标题栏可折叠，避免点快捷项/卡片时误折叠。
4. **MOTD**：保留白名单 HTML，同时去掉旧版遗留的 `§` 颜色控制码，换行转为 `<br>`；文本内容不减。
5. **项目简介**：社区资源详情在旧版仅去 HTML 标签；新版额外去掉 Markdown 标记（保留链接文字），内容不截断超过旧版 4000 字上限。
6. **错误反馈**：旧版部分操作失败只落 console；新版统一 Toast 或内联错误，便于定位。
7. **设置页新增但复用旧键**：`client2server.scriptPath`、`saveEditor.mcDir` 原本只在功能磁贴内编辑，现在设置页也提供（同键、同 API）。
8. **目录选择器**：盘符/面包屑/常用位置/过滤/新建文件夹/双击选择行为保留，视觉换新；`pickDir` 返回 `null` 的取消语义未变。
9. **图标**：manifest 的 emoji 不再作为主图标；未知功能回退拼图或首字。
10. **命令面板/任务抽屉/状态栏**是纯表现层新增能力，不替代任何旧入口。

## 7. 回归与回滚

- 回滚：`git checkout main` 即可回到旧前端；新版在独立分支与 tag 上，后端数据文件完全兼容，无需迁移/回滚数据。
- 数据样本：`data/` 为开发数据（已 gitignore），升级时旧 `settings.json`、`monitors.json`、`clientmods.json` 可直接读取（已在旧 layout 含已删除功能 id 的场景验证）。
- 验收记录见 `docs/frontend-parity.md`；视觉说明见 `docs/frontend-design.md`；截图见 `docs/screenshots/dark|light`。

## 8. 交付物清单

- `public/` 全量新前端（index、5 个 CSS、core/ui/app、8 个功能）。
- `docs/frontend-design.md`、`docs/frontend-parity.md`、本文件。
- 暗/亮两套截图：工作台折叠、8 个功能展开、10 个设置分区、命令面板、任务抽屉、添加磁贴、空态、功能加载失败。
- 重新生成的 `src/server/integrity.gen.js`、`src/server/asset-version.gen.js`（由 `node build.mjs` 生成）。
- 本地分支 `rewrite/frontend-bench-v1` 与 tag。
