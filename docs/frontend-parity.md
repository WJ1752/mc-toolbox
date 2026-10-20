# 前端等价矩阵（Frontend Parity Matrix）

版本：`rewrite/frontend-bench-v1` · 基线 `v1.6.3` / `9a299c0`
截图：`docs/screenshots/dark`、`docs/screenshots/light`
双跑：旧版 `8756`（`main`）／新版 `8757`（本分支），同一份数据副本。

## 0. 判定规则与签字

- **通过**：操作入口可达（≤2 次点击）、请求方法/路径/请求体键集合一致、成功与失败反馈一致、状态与持久化字段一致。
- **表现差异**：仅视图结构/文案润色，已在“备注”列注明，不计回归。
- 所有 API 均未新增或修改；前端只使用 `src/server/api.js` 已存在的端点。
- 签字符号：`✅` 通过 · `🟡` 表现差异（已注明） · `❌` 未通过。

## 1. 壳层（Shell）

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 启动 | 读取引导数据 | `app.js boot()` | `app.js boot()` | `GET /api/bootstrap` | `settings` / `features` / `version` / `author` | 主题、列数、磁贴按 layout 恢复 | 工作台内“初始化失败”卡 + 重新加载 | 双跑截图 + 网络面板 ✅ |
| 心跳 | 10s 心跳 / 关窗通知 | `startHeartbeat()` | `startHeartbeat()` | `POST /api/heartbeat`、`sendBeacon('/api/shutdown')` | 心跳状态 | 状态栏绿点“本地服务正常” | 连续 3 次失败：红点 + 顶部断线横幅 | 手工断服 ✅ |
| 窗口控制 | 最小化 / 最大化 / 关闭 | `winControls` | 标题栏右侧三键 | 宿主消息 `min|max|close` | 最大化状态 | 宿主执行 | 宿主无响应时按钮无动作 | WebView2 宿主 ✅ |
| 无边框拖拽 | 拖动标题栏 / 双击最大化 | `header.topbar` pointerdown/dblclick | `header.titlebar` pointerdown/dblclick | 宿主消息 `cap` / `max` | — | 窗口移动/最大化 | — | 宿主 ✅ |
| 缩放热区 | 八向缩放 | `.rsz-layer` | `.rsz-layer`（八向） | 宿主消息 `rsz 10–17` | — | 原生缩放 | — | 宿主 ✅ |
| 全部折叠 | 折叠/展开所有磁贴 | 顶栏按钮 | 工作台工具条按钮 | `PUT /api/settings {layout}` | `layout[].collapsed` | 文案在“全部折叠/全部展开”间切换 | 保存失败仅 console.warn（与旧版一致） | 截图 ✅ |
| 添加磁贴 | 列出未挂载功能并添加 | `＋ 添加磁贴` | 工具条/Rail/空状态/命令面板 | `PUT /api/features/:id {visible:true,enabled:true}` | `features[id]` | Toast `已添加「名称」` | Toast `添加失败：…` | 双跑 ✅ |
| 重载功能 | 重新扫描功能目录 | `↻ 重载` | 工具条“重载” | `GET /api/features` | `features` | Toast `已重新加载功能` | Toast `重载失败：…` | 双跑 ✅ |
| 删除功能 | 非内置功能删除 | 磁贴菜单“删除此功能” | 更多菜单 / 设置-功能与磁贴 | 确认后 `DELETE /api/features/:id` | `features` | Toast `功能已删除` / `功能已移除` | Toast `删除失败：…` | 双跑 ✅ |
| 拖拽排序 | 拖动磁贴改顺序 | HTML5 指针拖拽 | 指针拖拽（5px 阈值、虚线占位、FLIP） | `PUT /api/settings {layout}` | `layout[]` 顺序 | 松手即保存 | 保存失败仅 console.warn | 手工 + 刷新 ✅ |
| 折叠 | 折叠为 40px 标题条 | 标题栏 / 箭头 | 标题栏 / 箭头 / 菜单 / 命令面板 | `PUT /api/settings {layout}` | `layout[].collapsed` | 箭头旋转、内容隐藏 | — | 截图 ✅ |
| 放大视图 | 全屏工作台 | `⤢` | 磁贴“放大”/菜单/命令面板 | 功能 `renderExpanded` | — | 全屏 Bench View | 渲染失败 error-state；无 renderExpanded 时回退挂载并说明 | 截图 ✅ |
| 更多菜单 | 磁贴操作 | 旧版弹窗菜单 | 右键式 ContextMenu | — | — | 菜单项 | — | 截图 ✅ |
| 隐藏磁贴 | 从工作台移除但保留功能 | 菜单“隐藏此磁贴” | 菜单“隐藏此磁贴（设置中恢复）” | `PUT /api/features/:id {visible:false}` | `features[id].visible` | Toast `已隐藏磁贴，可在设置中恢复` | Toast `隐藏失败：…` | 双跑 ✅ |
| 打开功能设置 | 跳到对应设置分区 | 无 | 菜单“打开此功能设置” | — | — | 设置页对应分区 | — | 手工 ✅ |
| Rail 快捷 | 定位功能磁贴 | 无（新增） | 左侧 Rail 功能图标 | 未挂载时 `PUT /api/features/:id` | `features[id].visible` | 滚动并高亮 1.4s；未挂载则先添加 | 禁用功能提示 `该功能已在设置中禁用，请先启用` | 截图 ✅ |
| 命令面板 | 搜索功能/动作 | 无（新增） | `Ctrl/Cmd+K` 或标题栏“命令” | 纯前端；部分动作调用已有 API | — | 回车执行 | 无结果提示 | 手工 ✅ |
| 任务抽屉 | 下载/转换/导入任务 | 各功能内任务区 | 状态栏“任务 N” | `GET /api/community/jobs`（2.5s） | `jobs` | 抽屉列表、进度、取消、打开目录、清空 | 取消失败 Toast；空态说明 | 截图 ✅ |
| 列数 | 1–4 列切换 | 设置页数字 | 工具条 1/2/3/4 + 设置页 | `PUT /api/settings {general.tileColumns}` | `general.tileColumns` | 立即重排 | Toast `保存列数失败：…` | 截图 ✅ |
| 空状态 | 没有磁贴 | 文案 + 按钮 | 同（新视觉） | — | — | “添加磁贴” | — | 截图 ✅ |
| 加载失败 | 功能 import/mount 失败 | 卡片内红字 | 卡片内 error-state + 重试 | 重新 `import()` / `mount()` | — | 重试恢复 | 显示具体错误 | 截图（阻断 tile.js）✅ |
| 设置页 | 打开/关闭/返回滚动位置 | 顶栏“⚙ 设置” | Rail 设置 / 状态栏引擎 / 命令面板 | — | — | 整页设置，关闭恢复滚动 | — | 截图 ✅ |
| 状态栏 | 引擎、版本、作者水印 | 旧版无状态栏 | 底部 24px 状态栏 | `GET /api/monitors`（8s） | 引擎运行状态 | 绿点/暂停文案；点击进设置 | 引擎不可用显示 `不可用` | 截图 ✅ |
| 主题/强调色 | 六主题与强调色 | 设置-通用 | 设置-通用（色块 + 色点） | `PUT /api/settings {general}` | `general.theme/accent` | 即时生效 | Toast `设置保存失败：…` | 6 主题截图 ✅ |
| 设置保存 | 即时保存 | 350ms 防抖 PUT | 同（350ms 防抖 + flush） | `PUT /api/settings` | 整个设置对象 | 顶部“已保存 · 时间” | 顶部“保存失败”+ Toast | 双跑 ✅ |
| 关闭窗口 | 停止本地服务 | 心跳 + `beforeunload` | 同 | `sendBeacon('/api/shutdown')` | — | 服务停止 | — | 手工 ✅ |

## 2. 服务器在线测试（server-status）

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 单次探测 | Java 自动/明确 | 地址+端口+类型+测试 | 同（测试按钮、Enter） | `POST /api/ping {host,port,type}` | `network.lastHost` | 档案卡 + badge `N ms` | 卡片 inline 原因 + badge `离线` | 双跑 ✅ |
| 地址格式 | `host:port` / IPv6 / SRV | 地址输入 | 同（后端解析，前端原样提交） | 同上 | 同上 | 目标/解析地址并列 | 解析失败原因来自后端 | 手工 ✅ |
| 类型切换 | Java/基岩/自动 | 下拉 | 同 | — | `network.javaPort/bedrockPort` | 端口自动切换 | — | 双跑 ✅ |
| 快捷测试 | 内置 Hypixel/本地 | chip 点击 | 横向 chip 点击 | — | `serverstatus.removed` | 立即探测 | — | 截图 ✅ |
| 自定义快捷 | 添加/删除 | ＋快捷 / 行内 × | 同（chip 行内 × + 确认） | `PUT /api/settings {serverstatus.quicks}` | `serverstatus.quicks` | Toast `已添加快捷/已删除快捷项` | Toast `请填写域名 / IP`、保存失败提示 | 双跑 ✅ |
| 结果档案 | 图标/MOTD/版本/人数 | 文本行 | 64px 图标 + 三段信息 | — | — | MOTD 白名单 HTML、玩家名 chip | — | 截图 ✅ |
| 玩家列表 | 最多 24 人 | pill 列表 | chip 列表（上限 24） | — | — | 显示玩家名 | 无玩家时不显示 | 截图 ✅ |
| 原始数据 | 只读 JSON + 复制 | 按钮+弹窗 | 同（LogViewer 风格 pre） | — | — | 复制 Toast `已复制` | 未测试提示 `请先测试一次` | 手工 ✅ |
| 加入监测 | 请求延迟监测添加 | 按钮 | 同 | `bus.emit('monitor:request-add')` | — | Toast `已请求加入延迟监测` | 未测试提示 | 双跑 ✅ |
| 离线/失败 | 目标/解析/原因 | 红字 | 离线档案 + 原因 + 目标/解析 | — | — | — | `r.error` 原文 | 截图 ✅ |

## 3. 服务器延迟监测（latency-monitor）

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 添加监测 | 名称/地址/端口/类型/间隔/指标/颜色 | ＋ 添加 IP | 同（仪表卡工具条） | `POST /api/monitors` | `monitors.json` | Toast `已添加监测` | Toast `请填写地址`/`操作失败：…` | 双跑 ✅ |
| 编辑监测 | 改全部字段 | 卡片详情“编辑” | 同 | `PUT /api/monitors/:id` | 同上 | Toast `已保存` | 同上 | 双跑 ✅ |
| 删除监测 | 二次确认 | 编辑弹窗“删除” | 同 | `DELETE /api/monitors/:id` | 同上 | Toast `已删除` | 取消失败不提示 | 双跑 ✅ |
| 立即检测 | 单台触发 | 详情“立即检测” | 同 | `POST /api/monitors/:id/check` | — | Toast `已触发检测` | 请求错误 Toast | 手工 ✅ |
| 引擎启停 | 启动/暂停 | 暂停/继续 | 同（工具条 + 详情 + 设置） | `POST /api/monitors/engine {running}` | 引擎状态 | Toast `监测已启动/已暂停` | Toast `操作失败：…` | 双跑 ✅ |
| 批量指标 | 全部改成延迟/人数/丢包 | 全部图表指标条 | 同 | `POST /api/monitors/metric {metric}` | 每台 `metric` | Toast `已把 N 台…` | Toast `还没有监测项`/失败 | 截图 ✅ |
| 4s 轮询 | 拉取快照 | `setInterval` | 同（卸载清理） | `GET /api/monitors` | `status/stats/history` | 卡片实时刷新 | 轮询失败静默（与旧一致） | 手工 ✅ |
| 拖拽排序 | 卡片拖动 | HTML5 拖拽 | 同（`TileGrid`） | `POST /api/monitors/reorder {ids}` | monitors 顺序 | 松手保存 | Toast `排序保存失败：…` | 双跑 ✅ |
| 卡片缩放 | 右下角调宽/高度策略 | 拖拽手柄 | 同（128–620px、maxTileWidth、tileHeightMode） | — | 会话内尺寸；策略来自设置 | 实时改变 | — | 截图 ✅ |
| 详情统计 | 当前/平均/最低最高/抖动/在线率/连续失败/累计/丢包 | 点击卡片 | 同（宽详情弹窗） | `GET /api/monitors` | `stats` | 统计盒 + 图表 + 记录 | 读取失败 Toast `读取世界…`（监测为读取失败） | 截图 ✅ |
| 图表指标 | 延迟/人数/丢包 | 详情/展开 segmented | 同（写入每台） | `PUT /api/monitors/:id {metric}` | 每台 `metric` | Toast `图表指标已改为…` | Toast `保存失败：…` | 截图 ✅ |
| 空/离线/暂停 | 七种状态 | 文案 | 同（空态、等待首次探测、超时、已暂停） | — | — | 对应文案 | `st.error` 原文 | 截图 ✅ |
| 展开视图 | 大图 + 切换服务器 | `renderExpanded` | Bench View（服务器选择 + 指标 + 统计 + 图 + 记录） | `GET /api/monitors` 4s | 同上 | 图表跟随 `chartRange` | 请求失败静默 | 截图 ✅ |
| 从在线测试加入 | bus 事件 | 接收 `monitor:request-add` | 同 | — | — | 预填添加弹窗 | — | 双跑 ✅ |

## 4. 客户端转服务端（client2server）

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 模式切换 | 清理 / 整合包转换 | 上下两块 | 分段控件两模式 | — | — | 切换视图 | — | 截图 ✅ |
| 选择目录 | 输入/浏览 | mods 目录行 | 同（四段式第一步） | `PUT /api/settings {client2server:{modsDir}}` | `client2server.modsDir` | 自动扫描 | Toast `请先选择 mods 目录` | 双跑 ✅ |
| 扫描 | 递归/包含 disabled | 扫描 | 同 | `POST /api/mods/scan {dir}` | 扫描结果 | Toast `扫描完成：N 个文件` | 表格内 `扫描失败：…` | 双跑 ✅ |
| 汇总/过滤 | 匹配数/无法识别/已选 | 文本 + 过滤按钮 | 摘要行 + 过滤按钮 | — | — | 计数实时更新 | — | 截图 ✅ |
| 选择 | 全选/取消/仅匹配 | 三个按钮 | 同 | — | 组件内选中集 | 只作用于可见行 | — | 手工 ✅ |
| 处理方式 | 备份/禁用/启用/删除 | 下拉 | 同 | — | `client2server.defaultAction` | — | — | 双跑 ✅ |
| 处理选中项 | 二次确认 + 结果 | 按钮 | 同 | `POST /api/mods/apply {files,mode,dir,backupDir}` | — | 结果弹窗成功/失败数、备份路径 | Toast `处理失败：…` | 双跑 ✅ |
| 删除警告 | 不可恢复提示 | 确认文案 | 同（红字 + `确认删除`） | 同上 | — | — | — | 手工 ✅ |
| mod 库 | 搜索/添加/编辑/删除 | 管理库弹窗 | 同（宽弹窗） | `GET/POST /api/mods/client-list`、`PUT/DELETE /:id` | `clientmods.json` | Toast `已添加/已删除` | `保存失败：…` 等 | 双跑 ✅ |
| 库目录 | 打开真实目录 | 📂 按钮 | 同（显示 clientmods.json 路径） | `POST /api/system/open-path {which:'clientModsDir'}` | — | Toast `已打开…` | Toast `打开失败` | 手工 ✅ |
| 启动脚本 | 选择/运行/解除 | 行内控件 | 同 | `PUT /api/settings {client2server:{scriptPath}}`、`POST /api/scripts/run {path}` | `scriptPath` | Toast `已绑定/已在新窗口运行脚本/已解除绑定` | Toast `运行失败：…` | 手工 ✅ |
| 选择来源 | 拖入/选包/文件夹 | drop + 按钮 | 三步向导第一步 | `POST /api/mods/inspect` | — | 已选择提示 | `请拖入 .zip 或 .mrpack 客户端整合包` | 双跑 ✅ |
| 自动识别 | MC/加载器/版本 | `setConvertSource` | 同（只读清单，不解压全包） | `POST /api/mods/inspect {source,records,summary}` | — | 识别结果 + 内存建议 | `自动识别失败：…。可以手动填写版本。` | 手工 ✅ |
| 手动补全 | MC 版本/加载器/版本 | 三个字段 | 同（向导第二步） | `GET /api/servercore/gameversions`、`loaderversions` | — | 候选 datalist | 在线列表不可用提示 | 手工 ✅ |
| Java | 自动/手动/下载 | 行内 | 同（共用 java-download） | `POST /api/mods/java {runtime,javaPath}`、`/api/java/*` | — | `已找到 Java N…` | 提示错误原因 | 手工 ✅ |
| 内存/预设 | 最大/初始/世界 UUID/随包 Java | 表单项 | 高级设置内 | — | — | 建议值回填 | `内存请输入 1–256...` | 双跑 ✅ |
| 转换提交 | 目录/上传 | 按钮 | 向导第三步 | `POST /api/mods/convert` 或 `/api/mods/convert-upload?…`（XHR，`X-File-Name`） | 任务 id | 进度条/阶段文案 | 失败原因 | 手工 ✅ |
| 转换轮询 | 350ms | `setInterval` 等价 | 同 | `GET /api/mods/convert/jobs/:id` | 任务状态 | 结果弹窗 + `打开输出文件夹` | `转换失败：…` | 手工 ✅ |
| 取消 | 上传中断/后台中止 | 中止按钮 | 同 | `POST /api/mods/convert/jobs/:id/cancel` | — | Toast `已中止转换` | `中止请求失败：…` | 手工 ✅ |
| 展开视图 | 大屏库管理（旧） | `renderExpanded` | 两模式完整工作台 + 库表 | 同上 | — | 大屏操作 | 同 | 截图 ✅ |

## 5. 社区资源下载（community-download）

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 来源切换 | Modrinth / CurseForge | 分段 | 同 | `GET /api/community/search` | `community.defaultSource` | 结果刷新 | 错误显示在结果区 | 双跑 ✅ |
| 类型筛选 | 全部/Mod/整合包/数据包/资源包/光影 | 类型 pill | 同 | 同上（`type`） | — | 结果刷新 | — | 截图 ✅ |
| 加载器 | 不限/Fabric/Forge/NeoForge/Quilt | 下拉 | 同 | 同上（`loader`） | `community.defaultLoader` | — | — | 双跑 ✅ |
| MC 版本 | 常用建议 + 手输 | 输入 + 下拉建议 | 同 | 同上（`gameVersion`） | `community.defaultGameVersion` | 点击建议回填 | — | 截图 ✅ |
| 排序 | 相关性/下载量/点赞/最近更新/最新发布 | 下拉 | 同 | 同上（`sort`） | — | 结果刷新 | — | 双跑 ✅ |
| 搜索/分页 | 关键词/每页数/上一页下一页 | 搜索、翻页 | 同 | 同上（`limit`/`offset`） | `community.pageSize` | `x-y / 共 N` | `没有结果`/错误原因 | 双跑 ✅ |
| 结果卡 | 图标/标题/作者/下载量/简介 | 列表 | 两列紧凑卡 | — | — | 点击开详情 | — | 截图 ✅ |
| 详情 | 简介/许可/链接/版本/文件 | 弹窗 | 同（宽弹窗） | `GET /api/community/project`、`versions` | — | 版本/文件可选 | `详情加载失败：…`、`版本加载失败：…` | 双跑 ✅ |
| 下载 | 选择版本文件 + 目录 | 下载按钮 | 同 | `POST /api/community/download {url,filename,dir,title,meta}` | `jobs` | Toast `已加入下载：…` | Toast `下载失败：…` | 双跑 ✅ |
| 下载目录 | 磁贴内修改/浏览/打开 | 目录行 | 同（即时保存） | `PUT /api/settings {community:{downloadDir}}`、`POST /api/fs/open` | `community.downloadDir` | Toast `已打开` | `无法打开下载目录（可能尚未创建）：…` | 手工 ✅ |
| 任务列表 | 排队/下载/安装/完成/失败/取消 | 列表 | 收进抽屉 + 磁贴最近 3 条 | `GET /api/community/jobs` 1.2s | `jobs` | 进度/速度/线程 | `j.error` 原文 | 截图 ✅ |
| 取消/打开/清空 | 行内操作 | 按钮 | 同 | `POST /jobs/cancel`、`POST /fs/open`、`DELETE /jobs?scope=community` | — | Toast `已清空下载记录` | 失败说明 | 手工 ✅ |
| CurseForge Key | 未配置回退提示 | 后端错误 | 同（设置页 Key 配置） | 同上 | `community.cfApiKey` | — | 后端原始原因 | 手工 ✅ |
| 展开视图 | 大屏搜索/右侧详情 | `renderExpanded` | 同（独立状态） | 同上 | — | 右侧详情/下载 | 同 | 截图 ✅ |

## 6. 服务端核心下载（server-core）

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 加载器 | 官方/Fabric/Forge/Cleanroom/NeoForge/Quilt/Paper | 下拉 | 同（三步第一步） | — | 本地状态 | — | — | 双跑 ✅ |
| MC 版本 | 在线列表 | 下拉 | 同 | `GET /api/servercore/gameversions` | — | 首项默认 | `（获取失败）` + Toast | 手工 ✅ |
| 加载器版本 | 在线列表 | 下拉 | 同 | `GET /api/servercore/loaderversions?loader&mc` | — | 首项默认 | `（无可用版本）`/`（获取失败）` | 手工 ✅ |
| Cleanroom | 强制 1.12.2 | 切换加载器 | 同 | 同上 | — | 版本回填 | — | 手工 ✅ |
| 下载目录 | 输入/浏览 | 目录行 | 同（第二步） | — | `community.downloadDir` 初值 | — | — | 双跑 ✅ |
| Java | 下载/选择 | 下载 Java… | 同（共用组件） | `/api/java/*` | — | `Java 已就绪` | 组件内错误 | 手工 ✅ |
| 下载 | 加入队列 | 下载按钮 | 第三步主按钮 | `POST /api/servercore/download {loader,mc,loaderVersion,dir,javaPath}` | `jobs` | Toast `已加入下载队列：…` | Toast `下载失败：…` | 双跑 ✅ |
| 任务区 | 1s 轮询/取消/刷新 | 卡片下部 | 同（任务列表） | `GET /api/community/jobs` | `meta.type==='servercore'` | 进度/安装阶段 | 失败原因 | 截图 ✅ |
| 展开视图 | 独立实例 | `renderExpanded` | 同（独立状态/计时器） | 同上 | — | — | — | 截图 ✅ |

## 7. 整合包翻译（i18n）

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 状态轮询 | 可用/启动中/运行/未启动 | 3s 轮询 | 同 | `GET /api/i18n/status` | 运行时状态 | 状态灯 + 文案 | `无法读取翻译引擎状态：…` | 截图 ✅ |
| 启动 | 启动引擎 | ▶ 启动翻译工作台 | 同（大按钮） | `POST /api/i18n/start {i18n}` | — | Toast + 自动打开工作台 | Toast `翻译引擎启动失败：…` + 内联错误 | 手工 ✅ |
| 打开工作台 | 外部工作台 | ↗ 打开工作台（iframe） | 新窗口/外链（规范要求不内嵌） | — | `status.url` | 新窗口打开 | `请先启动翻译工作台` / 拦截提示 | 手工 ✅ |
| 停止 | 停止引擎 | ■ 停止引擎 | 同 | `POST /api/i18n/stop` | — | Toast `翻译引擎已停止` | Toast `停止翻译引擎失败：…` | 手工 ✅ |
| 自动启动 | `i18n.autoStart` | 发送 `start` | 同（启动后 + 磁贴挂载时） | `POST /api/i18n/start` | `i18n.autoStart` | 自动启动 | 不阻塞主界面 | 手工 ✅ |
| 错误详情 | 运行时缺失/启动失败 | 文案 | 同 + 内联错误框 | — | — | — | 具体原因 | 截图 ✅ |
| 展开视图 | 工作台 | `renderExpanded` 打开工作台 | 同（新窗口） | — | — | 新窗口 | 未启动提示 | 手工 ✅ |

## 8. 存档编辑器（save-editor）

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| .minecraft 目录 | 自动检测 | 自动检测 | 同（左栏顶部） | `GET /api/saveeditor/presets` | `saveEditor.mcDir` | Toast `已找到：…` | `未在默认位置找到…`/`检测失败：…` | 手工 ✅ |
| 目录 | 浏览/读取/打开 | 浏览/读取存档/📂 | 同 | `PUT /api/settings {saveEditor}`、`GET /api/saveeditor/worlds` | `saveEditor.mcDir` | 世界列表 | `读取失败：…` | 双跑 ✅ |
| 世界列表 | 名称/大小/时间/图标/搜索 | 列表 | 左栏可搜索列表 | 同上 | — | 选中高亮 | `解析失败：…` | 截图 ✅ |
| 世界属性 | 名称/模式/难度/出生点/刻/边界/极限/作弊/天气 | 表单 | 页签「世界」 | `POST /api/saveeditor/level {world,edits}` | `level.dat` | Toast `世界属性已保存（备份：…）` | Toast `保存失败：…` | 手工 ✅ |
| 玩家选择 | 玩家列表 | chips | 页签「玩家」chips | `GET /api/saveeditor/player` | 玩家 key | 回填 | `读取失败：…` | 手工 ✅ |
| 玩家保存 | 生命/饥饿/经验/坐标/视角/飞行/无敌 | 表单 | 同 | `POST /api/saveeditor/player {world,player,edits}` | `playerdata` | 确认后备份 + Toast | `保存失败：…` | 手工 ✅ |
| 背包预览 | 只读物品列表 | 列表 | 同（网格） | — | — | 槽位/ID/数量 | — | 截图 ✅ |
| 区块入口 | 区域文件列表/32×32 分布 | 弹窗 | 页签「区块」+ 全屏编辑器 | `GET /api/saveeditor/regions`、`region` | — | 分布图 | `读取失败：…` | 截图 ✅ |
| 区块俯视 | 16×16 彩色地图/拾取 | canvas | 同（支持缩放/平移） | `GET /api/saveeditor/chunk` | — | 点击拾取局部/世界坐标 | 未生成区块提示 | 截图 ✅ |
| 批量替换 | 单区块/全区域 | 表单 | 同（确认 + 进度） | `POST /api/saveeditor/chunk/replace` | — | Toast 替换数量 + 备份 | `替换失败：…` | 手工 ✅ |
| 坐标操作 | 角1/角2/查询/plan/apply | 表单 | 同（确认 + 进度） | `POST /api/saveeditor/block`、`box/plan`、`box/apply` | — | `坐标替换完成：N 个方块` | `范围内没有任何已生成的区块` 等 | 手工 ✅ |
| 跨区块 | 自动分组/逐区备份 | 后端 plan | 同（不在前端伪造） | 同上 | — | 逐区块进度 | 跳过区块计数 | 手工 ✅ |
| 跳转区块 | 区块坐标 → 区域/文件 | 输入 + 跳转 | 同 | `region`、`chunk` | — | 定位并高亮 | `区域文件 … 不存在（区块未生成）` | 手工 ✅ |
| 展开视图 | 大屏 | `renderExpanded` | 两栏世界/页签编辑 | 同上 | — | 更大编辑区 | 同 | 截图 ✅ |

## 9. 开服管理（server-manager）

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 选择来源 | 拖入 ZIP/.mrpack/JAR、文件夹、核心 | drop + 按钮 | 同（导入向导） | — | 暂存路径/File | 暂存提示，不立即解压 | `请拖入 ZIP / .mrpack / JAR…` | 双跑 ✅ |
| 开始导入 | 上传/路径导入 | 开始识别并导入 | 同 | `POST /api/server-manager/prepare` 或 `upload?destination=`（XHR，`X-File-Name`） | 暂存 | 识别结果回填 | 上传/识别失败原因 | 手工 ✅ |
| 进度/取消 | 真实字节/阶段/中止 | 进度条 + 中止导入 | 同 | `GET /api/server-manager/prepare/:id`、`POST .../cancel` | 任务 | 阶段文案 | `已中止上传` 等 | 手工 ✅ |
| 识别结果 | 启动入口/核心/警告/内存建议 | plan 下拉 + hint | 同（启动入口字段） | — | inspection | 回填 mc/内存/端口/EULA | 未找到核心提示 | 手工 ✅ |
| 核心选择 | 手动选核心 JAR | 选择核心 JAR | 同 | 再次 `prepare`（corePath） | `corePath` | 重新识别 | `核心不存在…` 提示 | 手工 ✅ |
| Java | 自动/手动/下载 | 行内 | 设置区「Java 与内存」 | `POST /api/server-manager/java`、`/api/java/*` | — | `Java N（64 位）：path` | 错误原因 | 手工 ✅ |
| 内存校验 | 整数 GB | 数字输入 | 同 | — | — | — | `内存请填写整数 GB` | 手工 ✅ |
| 网络/参数 | 端口/IP/玩家/正版/JVM/服务端参数/优化 | 更多启动参数 | 设置区「网络/启动参数」 | — | 会话 settings | — | — | 双跑 ✅ |
| EULA | 勾选 + 链接 | 复选框 + 链接 | 同 | — | `acceptEula` | — | `请先阅读并确认 Minecraft EULA` | 双跑 ✅ |
| 启动 | 启动服务端 | ▶ 启动服务端 | 同（控制台顶部） | `POST /api/server-manager/start {…}` | 会话 | 控制台进入运行中 | 校验错误 Toast/状态行 | 手工 ✅ |
| 正常停服 | 保存并停止 | ■ 正常停服 | 同 | `POST /api/server-manager/sessions/:id/stop` | 会话状态 | `正在保存并停止` | 错误 Toast | 手工 ✅ |
| 强制停止 | 二次确认 | 强制停止 | 同 | 同上 `{force:true}` | — | 停止 | 确认取消 | 手工 ✅ |
| 控制台命令 | 发送命令 | 输入 + 发送 | 同（Enter） | `POST /sessions/:id/command {command}` | — | 回显日志 | 错误 Toast | 手工 ✅ |
| 实时日志 | 1s 轮询/自动滚底/放大 | `pre` | LogViewer（行号/复制/下载/上滚暂停） | `GET /sessions/:id?after=` | 日志 seq | 实时追加 | `日志读取失败：…` | 截图 ✅ |
| 会话 | 列表/恢复 | 下拉 + 刷新会话 | 同 | `GET /api/server-manager/sessions` | — | 恢复控制台 | 错误 Toast | 手工 ✅ |
| 打开目录 | 服务端目录 | 按钮 | 同 | `POST /api/fs/open {path:root}` | — | 打开资源管理器 | 错误 Toast | 手工 ✅ |
| 状态 | 启动中/运行/停止中/已停止/失败 | 状态行 | 同（状态条） | 轮询 | 会话状态 | 状态与时长/端口 | failure 原因 | 截图 ✅ |
| 展开视图 | 大屏 | `renderExpanded`（移动 DOM） | 独立控制台视图 | 同上 | — | 更大日志/配置 | 同 | 截图 ✅ |

## 10. 设置页（10 分区）

### 10.1 通用

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 主题 | 深/浅/灰/橙/红/蓝 | 色块 | 同（带名称） | `PUT /api/settings` | `general.theme` | 即时切换 | 保存失败 Toast | 6 主题截图 ✅ |
| 强调色 | 8 色 | 色点 | 同 | 同上 | `general.accent` | 即时 | 同上 | 截图 ✅ |
| 每行磁贴数 | 1–4 | 数字 | 数字 + 单位 | 同上 | `general.tileColumns` | 即时重排 | 同上 | 截图 ✅ |
| 界面动画 | 开关 | 开关 | 同 | 同上 | `general.animations` | 立即静止/恢复 | 同上 | 手工 ✅ |
| 时间格式 | 24h/12h | 分段 | 同 | 同上 | `general.timeFormat` | 日志/图表时间 | 同上 | 手工 ✅ |
| 新磁贴默认折叠 | 开关 | 开关 | 同 | 同上 | `general.defaultCollapsed` | 影响新磁贴 | 同上 | 手工 ✅ |
| 危险操作二次确认 | 开关 | 开关 | 同 | 同上 | `general.confirmDanger` | 影响全部删除确认 | 同上 | 手工 ✅ |

### 10.2 网络

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 超时 | 500–30000ms | 数字 | 同 | `PUT /api/settings` | `network.timeout` | 即时保存 | Toast | 手工 ✅ |
| 重试次数 | 0–5 | 数字 | 同 | 同上 | `network.retries` | 同上 | 同上 | 手工 ✅ |
| 并发上限 | 1–64 | 数字 | 同 | 同上 | `network.concurrency` | 同上 | 同上 | 手工 ✅ |
| SRV 解析 | 开关 | 开关 | 同 | 同上 | `network.resolveSrv` | 同上 | 同上 | 手工 ✅ |
| 默认类型 | auto/java/bedrock | 分段 | 同 | 同上 | `network.defaultType` | 新测试/监测初值 | 同上 | 手工 ✅ |
| Java/基岩端口 | 1–65535 | 数字 | 同 | 同上 | `network.javaPort/bedrockPort` | 同上 | 同上 | 手工 ✅ |
| 下载代理 | 文本 | 输入 | 同 | 同上 | `network.proxy` | 同上 | 同上 | 手工 ✅ |

### 10.3 延迟监测

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 默认间隔 | 5–3600s | 数字 | 同 | `PUT /api/settings` | `monitor.defaultInterval` | 即时保存 | Toast | 手工 ✅ |
| 默认指标 | 延迟/人数/丢包 | 分段 | 同 | 同上 | `monitor.defaultMetric` | 同上 | 同上 | 手工 ✅ |
| 历史点数 | 60–10080 | 数字 | 同 | 同上 | `monitor.historyPoints` | 同上 | 同上 | 手工 ✅ |
| 离线阈值 | 1–10 | 数字 | 同 | 同上 | `monitor.offlineAfter` | 同上 | 同上 | 手工 ✅ |
| 告警阈值 | 20–2000ms | 数字 | 同 | 同上 | `monitor.latencyWarn` | 同上 | 同上 | 手动 ✅ |
| 图表点数 | 30–1440 | 数字 | 同 | 同上 | `monitor.chartRange` | 展开图跟随 | 同上 | 截图 ✅ |
| 最大宽度 | 0–800px | 数字 | 同 | 同上 | `monitor.maxTileWidth` | 卡片宽度立即限制 | 同上 | 手工 ✅ |
| 高度策略 | fixed/max/auto | 分段 | 同 | 同上 | `monitor.tileHeightMode` | 卡片重排 | 同上 | 截图 ✅ |
| 高度值 | 60–500px | 数字 | 同 | 同上 | `monitor.tileHeight` | 同上 | 同上 | 手工 ✅ |
| 自动监测 | 开关 | 开关 | 同 | 同上 | `monitor.autoStart` | 启动生效 | 同上 | 手工 ✅ |
| 引擎启停 | 切换 | 按钮 | 同 | `GET/POST /api/monitors/engine` | 引擎状态 | Toast | Toast | 手工 ✅ |
| 清空历史 | 二次确认 | 按钮 | 同 | `DELETE /api/monitors/history` | `history.json` | Toast `历史数据已清空` | 确认取消 | 手工 ✅ |

### 10.4 客户端转服务端

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mods 目录 | 输入/浏览 | 行 | 同 | `PUT /api/settings` | `client2server.modsDir` | 即时 | Toast | 手工 ✅ |
| 备份目录 | 输入/浏览 | 行 | 同 | 同上 | `client2server.backupDir` | 即时 | 同上 | 手工 ✅ |
| 默认动作 | disable/backup/delete | 分段 | 同 | 同上 | `client2server.defaultAction` | 即时 | 同上 | 手工 ✅ |
| 扫描子目录 | 开关 | 开关 | 同 | 同上 | `client2server.scanSubdir` | 即时 | 同上 | 手工 ✅ |
| 包含 disabled | 开关 | 开关 | 同 | 同上 | `client2server.includeDisabled` | 即时 | 同上 | 手工 ✅ |
| 自动识别环境 | 开关 | 开关 | 同 | 同上 | `client2server.autoDetectEnv` | 即时 | 同上 | 手工 ✅ |
| 启动脚本 | 文件选择 | 旧版仅磁贴内 | 设置页新增（同键） | 同上 | `client2server.scriptPath` | 即时 | 同上 | 手工 ✅ |

### 10.5 社区资源

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CurseForge Key | 文本 | 输入 | 同 | `PUT /api/settings` | `community.cfApiKey` | 即时 | Toast | 手工 ✅ |
| 默认来源 | Modrinth/CF | 分段 | 同 | 同上 | `community.defaultSource` | 同上 | 同上 | 手工 ✅ |
| 默认版本 | 文本 | 输入 | 同 | 同上 | `community.defaultGameVersion` | 同上 | 同上 | 手工 ✅ |
| 默认加载器 | 不限/Fabric/… | 分段 | 同 | 同上 | `community.defaultLoader` | 同上 | 同上 | 手工 ✅ |
| 下载目录 | 输入/浏览 | 行 | 同 | 同上 | `community.downloadDir` | 同上 | 同上 | 手工 ✅ |
| 线程数 | 1–8 | 数字 | 同 | 同上 | `community.threads` | 同上 | 同上 | 手工 ✅ |
| 并发任务 | 1–10 | 数字 | 同 | 同上 | `community.maxConcurrent` | 同上 | 同上 | 手工 ✅ |
| 限速 | 0–1048576 KB/s | 数字 | 同 | 同上 | `community.speedLimit` | 同上 | 同上 | 手工 ✅ |
| 按类型子目录 | 开关 | 开关 | 同 | 同上 | `community.subdirByType` | 同上 | 同上 | 手工 ✅ |
| 命名规则 | 文本 | 输入 | 同 | 同上 | `community.nameRule` | 同上 | 同上 | 手工 ✅ |
| 命名预览 | 示例 | 按钮 | 同 | `POST /api/community/preview-name` | — | Toast `预览：…` | Toast `预览失败：…` | 手工 ✅ |
| 每页数量 | 5–50 | 数字 | 同 | `PUT /api/settings` | `community.pageSize` | 即时 | Toast | 手工 ✅ |
| 清空任务 | 二次确认 | 按钮 | 同 | `DELETE /api/community/jobs` | jobs | Toast `已清空下载记录` | 确认取消 | 手工 ✅ |

### 10.6 服务端核心

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 启动脚本内存 | 文本 | 输入 | 同 | `PUT /api/settings` | `servercore.memory` | 即时 | Toast | 手工 ✅ |

### 10.7 整合包翻译

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Python 路径 | 文本 | 输入 | 同 | `PUT /api/settings` | `i18n.pythonPath` | 即时 | Toast | 手工 ✅ |
| 自动启动 | 开关 | 开关 | 同 | 同上 | `i18n.autoStart` | 即时 | 同上 | 手工 ✅ |
| 测试并启动 | 按钮 | 按钮 | 同 | `POST /api/i18n/start {i18n}` | 运行时状态 | Toast `已启动（端口）` | Toast + 状态行 | 手工 ✅ |
| 停止 | 按钮 | 按钮 | 同 | `POST /api/i18n/stop` | — | Toast | Toast | 手工 ✅ |

### 10.8 功能与磁贴

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 功能列表 | 全部功能 | 列表 | 同（新视觉） | `GET /api/features` | features | 启用/显示开关 | 读取失败 error-state | 截图 ✅ |
| 启用/禁用 | 开关 | 开关 | 同 | `PUT /api/features/:id {enabled}` | `features[id].enabled` | Toast `已启用/已禁用` | Toast `操作失败：…` | 手工 ✅ |
| 显示/隐藏 | 开关 | 开关 | 同 | `PUT /api/features/:id {visible}` | `features[id].visible` | 立即挂载/卸载 | 同上 | 手工 ✅ |
| 删除非内置 | 二次确认 | 按钮 | 同 | `DELETE /api/features/:id` | features | Toast `功能已移除` | 同上 | 手工 ✅ |
| 添加磁贴 | 打开弹窗 | 按钮 | 同 | — | — | 添加弹窗 | — | 截图 ✅ |
| 重新扫描 | 按钮 | 按钮 | 同 | `POST /api/features/reload` | features | Toast `已重新扫描功能目录` | Toast `扫描失败：…` | 手工 ✅ |
| 重置布局 | 按钮 | 按钮 | 同 | `PUT /api/settings {layout:[]}` | `layout` | Toast `布局已重置` | — | 手工 ✅ |

### 10.9 数据管理

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 配置目录 | 更改/恢复/打开 | 行 | 同（卡片） | `GET /api/dirs`、`POST /api/dirs/change`、`POST /api/dirs/reset`、`POST /api/system/open-path` | `dirs.json` | Toast 迁移文件数/字节 | Toast `迁移失败：…` | 手工 ✅ |
| mod 库目录 | 更改/恢复/打开 | 行 | 同 | 同上 | 同上 | 同上 | 同上 | 手工 ✅ |
| 运行数据目录 | 更改/恢复/打开 | 行 | 同 | 同上 | 同上 | 同上 | 同上 | 手工 ✅ |
| 导出配置 | 下载 JSON | 按钮 | 同 | `GET /api/data/export` | — | 下载 + Toast | Toast `导出失败：…` | 手工 ✅ |
| 导入配置 | 选择 JSON | 按钮 | 同 | `POST /api/data/import` | — | Toast + 刷新 | Toast `导入失败：…` | 手工 ✅ |
| 恢复默认 | 二次确认 | 按钮 | 同 | `POST /api/settings/reset` | settings | Toast + 刷新 | Toast `恢复失败：…` | 手工 ✅ |
| 存档 mcDir | 输入/浏览 | 旧版仅磁贴内 | 设置页新增（同键） | `PUT /api/settings` | `saveEditor.mcDir` | 即时 | Toast | 手工 ✅ |

### 10.10 关于

| 功能 | 子流程 | 旧入口 | 新入口 | 触发 API | 状态字段 | 成功反馈 | 失败反馈 | 回归方式 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 系统信息 | 版本/作者/Node/路径 | 关于 | 同 | `GET /api/system/info` | — | 信息表 | 读取失败 error-state | 截图 ✅ |
| 打开目录 | 配置/mod/运行数据 | 📂 | 同 | `POST /api/system/open-path` | — | 打开资源管理器 | Toast | 手工 ✅ |
| 仓库链接 | 外链 | 无 | 仓库按钮 | — | — | 新窗口 | — | 手工 ✅ |
| 许可/水印 | 说明 | 无 | 许可与运行时说明 | — | — | — | — | 截图 ✅ |

## 11. 接口与数据兼容

| 项目 | 做法 | 结论 |
| --- | --- | --- |
| 方法/路径 | 全部沿用 `src/server/api.js` 既有端点；无新增/删除 | ✅ |
| 请求体键 | 逐功能对照旧实现保留（含 multipart `X-File-Name`、上传 query 键） | ✅ |
| settings 键名/默认值 | `general/network/monitor/client2server/community/servercore/i18n/serverstatus/saveEditor/features/layout/version` 原样 | ✅ |
| monitors/clientmods/history | 只读展示与原有写接口，结构未改 | ✅ |
| 旧 layout | 已删除功能的 id 在 `syncTiles` 中被过滤；`w/h/collapsed` 保留 | ✅ |
| manifest | 使用旧字段 `id/name/desc/icon/color/version/author/size/builtin/enabled/entry/dir`；未知字段忽略 | ✅ |
| 扩展 SDK | `ctx` 保留全部旧字段，新增 `openBench`；`mount/unmount/renderExpanded` 签名不变 | ✅ |
| 旧 tile.js | 仍可通过 `/js/core/*` 与 `ctx` 挂载（已用旧 server-core 等实测） | ✅ |

## 12. 构建与测试

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 前端语法 | `node --check public/js/*.js public/js/core/*.js public/js/ui/*.js public/features/*/tile.js public/features/save-editor/chunk-editor.js` | 全部通过（0 错误） |
| 单元/集成测试 | `node --test tests/*.test.mjs` | **22 / 22 通过**（在 ASCII 路径副本 `F:\mct-test-ascii` 运行；本工作区含中文路径时，Node 22.18 的 `fs.cpSync` 在 `tests/dirs.e2e.test.mjs` 的目录复制阶段硬崩溃，属运行时/环境缺陷，非前端变更；同一份源码在 ASCII 路径全部通过） |
| 开发启动 | `node server.js --port=8757 --no-open` | 正常：`/` 200、`/api/bootstrap` 返回 8 个功能、静态 CSS/JS 200 |
| 构建 | `node build.mjs` | 成功：`dist/mc-toolbox.exe` 82.2 MB；8 步全过；隔离环境冒烟（启动、首页、功能列表、作者信息、完整性）通过 |
| 完整性重签 | `src/server/integrity.gen.js`、`asset-version.gen.js` | 由 build 重新生成；`SHELL_INTEGRITY` 覆盖 24 个壳层文件；`ASSET_VERSION=pub-7c443cf5accf4219`；旧 `css/style.css` 已移除 |
| HTTP 冒烟 | `/`、`/api/bootstrap`、`/css/*`、`/js/*` | `200`；首页含 `author-watermark` 作者标识 |
| 1024 窄窗 | 1024×680 截图 + DOM 测量 | `scrollWidth=1024`（无横向滚动）、Rail 44px、`--tile-cols=1`、磁贴 952px |
| 六主题 | dark/light/gray/orange/red/blue 切换 | 均无对比度事故；主题仅影响 token，不改布局/API |

## 13. 签字

| 范围 | 结论 | 备注 |
| --- | --- | --- |
| 壳层 | ✅ 通过 | 标题栏/Rail/工作台/状态栏/折叠/拖拽/列数/隐藏/删除/重载/放大/设置入口全部对应；命令面板与任务抽屉为新增能力 |
| 8 个功能 | ✅ 通过 | 逐一挂载、展开、展开视图与关键请求实测；接口路径与请求体键未变 |
| 10 个设置分区 | ✅ 通过 | 字段/默认值/即时保存/危险确认逐项对照；两个旧键（`scriptPath`、`saveEditor.mcDir`）额外在设置页暴露 |
| 六主题与 1024/1920 适配 | ✅ 通过 | 1024 无横向滚动，1920 内容最大宽 1440 居中，六主题均可用 |
| 数据兼容 | ✅ 通过 | 旧 `layout` 含不存在功能 id 时安全忽略；旧 `settings.json`/`monitors.json`/`clientmods.json` 直接读取 |
| 构建/测试 | ✅ 通过 | 见第 12 节；构建产物冒烟通过 |

## 14. 表现差异与理由

1. **翻译工作台**：旧版用 iframe 嵌在弹窗里；新版按规范改为系统浏览器新窗口打开，磁贴内显示端口、地址与复制按钮。功能未减，且避免 iframe 冒充重写。
2. **延迟监测轮询**：旧磁贴间隔为 `max(2000, defaultInterval*1000/4)`（默认约 7.5s）；新版固定 4s（规范 §6.2 的“4 秒轮询”）。请求、字段、历史与统计未变。
3. **折叠触发区**：旧版点击磁贴正文空白也会折叠；新版仅标题栏可折叠，避免点击快捷 chip、监测卡、表格行时误折叠。
4. **MOTD**：保留白名单 HTML 与换行，额外去掉遗留 `§` 颜色控制码（旧版会显示原始 `§f/§a` 字符），文本内容不减少。
5. **社区项目简介**：在旧版“去 HTML”的基础上额外去掉 Markdown 标记（保留链接文字），避免把 `**…**`、`[](url)` 原样展示。
6. **失败反馈**：旧版部分异步失败只落 console；新版统一 Toast/内联错误，便于定位。成功文案语义保持。
7. **新增纯表现层**：命令面板、任务抽屉、状态栏、Rail 快捷入口、磁贴摘要/右键菜单、放大视图；不取代任何旧入口。
8. **图标**：manifest 的 emoji 字段保留用于兼容，但界面渲染改用 `icon` 映射；未知功能回退拼图或首字。

> 所有差异均为视图/反馈层，不涉及 API、存储结构、设置键或功能删减；没有说明的差异视为回归。

