# v1.9.3 工作台下载同步与磁贴布局需求

> 状态：实现中  
> 范围：`public/js/launcher/downloads.js`、`public/js/launcher/install.js`、`public/features/community-download/tile.js`、`src/server/community.js`、`src/server/launcher/install.js`、`public/js/core/grid.js`、`public/js/app.js`、`public/js/core/settings.js`、`public/css/shell.css`、`src/server/defaults.js`。  
> 兼容目标：`settings.json` 旧布局、`layout: [{id,w,h,collapsed}]`、`/api/community/jobs` 与 `/api/launcher/jobs` 的既有键；只做增量字段。

## 1. 用户反馈

截图与现场复现（v1.9.1 EXE）暴露出四组问题：

1. **工作台下载在启动器下载中心里进度不对**
   - 「资源下载」里的社区任务进度条一直是动画条（indeterminate），即使任务已完成也只显示一小段绿色，不显示百分比。
   - 任务状态、文件大小、速度、耗时没有统一口径；`done` 任务没有用时，`failed / cancelled` 任务可能仍显示「已进行 X」。
   - 启动器任务里出现过 `下载依赖库 · 依赖库 · 581.1 / 599 MB`，但同一行字节显示 `58 MB / 60 MB`，进度条停在约 60%。
2. **安装实例的下载时间显示不对**
   - 同一行显示「已进行 9.7 小时」，与用户实际等待时间不符。
   - 排队时间、真正运行时间、完成用时被混在同一个 `startedAt` 上。
3. **工作台看起来一直在下载新的整合包**
   - 社区下载磁贴的任务列表每 1.2 秒刷新一次；每次刷新都会重建所有任务行并追加到列表，旧行没有被移除，行数随刷新次数增长。
   - 三个完全相同的「Better MC … 已完成 63 MB」行就是同一任务被重复渲染，而不是真的重复下载。
4. **磁贴布局不可控**
   - 拖动任意一个磁贴会触发整个 masonry 最短列重排，其他列所有磁贴跟着移动。
   - 无法把磁贴固定在第一列、第二列或任意列，也无法保持列内顺序。
   - 设置里没有「自适应磁贴」开关。
   - 窗口放大后，工作台内容被 `max-width: 1440px` 限制，磁贴不再变宽；用户期望磁贴随窗口自适应。

## 2. 根因定位

| 编号 | 现象 | 根因 | 位置 |
| --- | --- | --- | --- |
| D1 | 社区下载磁贴任务行不断变多，像一直在下载新整合包 | `createJobBoard().render()` 每次轮询都 `rowFor(j)` 追加新行，`rows.set(id)` 覆盖旧记录但不移除旧 DOM；清理循环只删除「不在新 id 集合里」的已跟踪行 | `public/features/community-download/tile.js` |
| D2 | 下载中心社区任务进度条永远不确定 | `progressNode(job)` 只看 `job.progress`；社区任务没有这个字段，只提供 `received / total / installProgress` | `public/js/launcher/downloads.js` |
| D3 | 下载中心社区任务没有耗时/速度/安装进度条 | `communityRow()` 未使用统一的耗时和进度计算；`installProgress` 只拼在文字里 | `public/js/launcher/downloads.js` |
| D4 | 安装任务字节数与详情不一致 | `InstallJob.received / total` 跨阶段保留：进入新的顶层阶段时没有清零，上一阶段（整合包/客户端）的 60 MB 会残留到依赖库阶段；详情用本阶段计数器，字节用旧字段 | `src/server/launcher/install.js` |
| D5 | 安装任务耗时从创建时开始算，包含排队 | `InstallJob` 构造时立刻写 `startedAt = Date.now()`，`runJob` 真正开跑时不再更新；没有 `createdAt` | `src/server/launcher/install.js` |
| D6 | 社区任务失败/取消后仍显示「已进行」 | `runDownload` 只在成功时写 `finishedAt`；`cancelJob` 也不写；`speed` 可能残留 | `src/server/community.js` |
| D7 | 社区任务进度与重试累计错误 | 镜像回退/额外文件重试时 `job.received/job.total` 不清零，失败尝试的字节被累计进总进度；`publicJob` 不提供统一 `progress` | `src/server/community.js` |
| D8 | 工作台「任务 N」不统计启动器任务 | 状态栏/任务抽屉只轮询 `/api/community/jobs`；启动器安装任务在 `/api/launcher/jobs` 中，不参与计数 | `public/js/app.js` |
| D9 | 拖动磁贴导致全网格重排 | `TileGrid` 只有 masonry 模式：按 DOM 顺序放入当前最短列；没有任何列位数据 | `public/js/core/grid.js` |
| D10 | 布局不持久列位 | `settings.layout` 只有 `{id,w,h,collapsed}`，没有 `col` | `public/js/app.js`、`src/server/defaults.js` |
| D11 | 窗口放大磁贴不变宽 | `.workspace-inner { max-width: 1440px }` 硬上限；网格宽度被容器限制 | `public/css/shell.css` |
| D12 | 列数/宽度变化时重排不可靠 | 只在窗口 resize 与容器 ResizeObserver 触发时重排；列数取 `min(用户列数, 可容纳列数)`，但没有暴露模式与列位 | `public/js/core/grid.js`、`public/js/app.js` |

## 3. 需求

### R1 统一任务口径（下载中心 / 工作台磁贴 / 状态栏）

- 新建 `public/js/core/jobs.js`，统一导出：
  - `isActiveJob(job)`、`isFinishedJob(job)`、`jobStatusLabel(job)`
  - `jobProgress(job)` → `0..100` 或 `null`（未知 = 不确定进度）
  - `jobBytesText(job)`、`jobSpeedText(job)`、`jobElapsedText(job, now)`
  - `jobMetaText(job, now)`（按状态组合字节、百分比、速度、耗时）
- 进度优先级：
  1. `status === 'done'` → 100；
  2. `status === 'installing'` 且 `installProgress` 有效 → `installProgress`；
  3. `indeterminate === true` → `null`；
  4. `progress` 有效 → `progress`（服务端统一为 0–100）；
  5. `total > 0` → `received / total * 100`；
  6. 其余 → `null`。
- 三个界面必须使用同一 helper，不允许各自复制一套百分比逻辑。

### R2 启动器下载中心

- 「启动器任务」与「资源下载」两个分组使用同一套进度、状态、耗时口径。
- 有真实进度时显示确定进度条（0–100%），只有未知进度才显示不确定动画条。
- 每行显示：字节 `received / total`（total 未知只显示 received）、速度（运行中）、耗时（运行中「已进行」/完成「用时」/排队「已排队」）、安装阶段百分比。
- 失败/取消任务必须显示终止状态，不得继续显示「已进行」。
- 「显示已完成」开关、清理已完成、取消、打开文件夹、日志行为保持不变。
- 轮询 1.5s 内不闪、不重复行。

### R3 工作台社区下载磁贴

- 任务列表按 `id` 复用行，只更新内容；同一任务任何时刻最多一行。
- 刷新后按服务端顺序重排；超过 `limit` 的行移除。
- 进度条使用 `jobProgress()`；安装中显示 `installProgress`，下载中显示字节百分比，完成后 100%。
- 状态、文件名、目录、错误、速度、线程、耗时与下载中心一致。
- 「开始下载」只创建 1 个任务；重复点击在请求期间被禁用。
- 服务端核心下载磁贴与社区下载磁贴共享同一进度口径（服务端核心任务仍按 `meta.type === 'servercore'` 分流）。

### R4 安装/下载耗时

- `InstallJob` 增加 `createdAt`（创建时刻），`startedAt` 在真正开始执行时写入；`finishedAt` 在 `done / failed / cancelled` 时写入。
- `community` 任务同样补 `createdAt`，`startedAt` 在 `runDownload` 开始时写，`finishedAt` 在所有终态写。
- UI 语义：
  - 未开始：`已排队 X`；
  - 运行中：`已进行 X`（从 startedAt 算）；
  - 完成：`用时 X`（finishedAt - startedAt，不含排队）；
  - 失败/取消：`用时 X`，有 `finishedAt` 时不显示「已进行」。
- 客户端不得用「创建时间」冒充「开始时间」；服务端时间与客户端时钟偏差不应导致负数或超长显示（clamp ≥ 0）。
- 新增测试覆盖：排队不计入用时、失败/取消有 finishedAt、进度字段优先级。

### R5 下载同步

- 状态栏「任务 N」同时统计：
  - `/api/community/jobs` 中 active 的社区任务；
  - `/api/launcher/jobs` 中 active 的启动器任务。
- 任务抽屉仍展示社区任务，并在标题旁标注启动器任务数量/入口；点击可打开下载中心。
- 工作台磁贴、下载中心、状态栏看到的同一任务百分比一致。
- 不新增轮询风暴：状态栏 2.5s 轮询一次即可，下载中心保持 1.5s，磁贴保持 1.2s。

### R6 磁贴手动列布局（默认）

- `general.adaptiveTiles` 默认 `false`（手动布局）。
- 手动模式下：
  - 每个磁贴有 `col`（0 基），持久化到 `settings.layout[].col`；
  - 同一列的磁贴按 DOM 顺序垂直堆叠，列与列互不影响；
  - 拖动只改变被拖磁贴的目标列与目标顺序；源列/目标列以外的磁贴位置不变；
  - 允许把全部磁贴放在第一列，也允许任意列；空列保留（不自动填坑）；
  - 支持拖到空列、拖动排序、Esc 取消、自动滚动、FLIP 动画；
  - 折叠/展开只影响本列后续磁贴，不影响其他列。
- 老数据没有 `col` 时：
  - 首次加载按 DOM 顺序分配 `index % maxColumns` 的初始列，随后写回；
  - 不丢磁贴、不改变顺序。
- 列数变化/窗口变窄时：
  - 有效列数 = `min(用户列数, 按最小列宽可容纳列数)`；
  - 保存的 `col` 不因为窗口变窄被改写；超出有效列数的磁贴临时显示在最后一列，窗口恢复后回到原列。
- 自适应模式（开关开启）保留现有 masonry 最短列算法与拖动行为。

### R7 自适应开关

- 设置 → 通用 → 外观新增「自适应磁贴」开关：
  - 关闭（默认）：手动列布局；
  - 开启：masonry 自动排布。
- 工作台工具条新增「手动 / 自适应」切换按钮（可选但推荐），与设置双向同步。
- 切换模式只改变排列，不丢 `col`、不重排 `layout` 顺序、不重挂载磁贴。

### R8 窗口宽度自适应

- 移除 `.workspace-inner` 的 1440px 硬上限；工作台内容随窗口宽度铺满（保留合理左右内边距）。
- 窗口放大/最大化、浏览器缩放、列数变化后：
  - 磁贴宽度按容器宽度重新计算；
  - 列数按可用宽度重新计算；
  - 不出现横向滚动、重叠、空白列错位；
  - 手动模式下仅宽度变化，列位不变。
- 启动器页面、设置页宽度不受影响（只改工作台容器）。

### R9 兼容与安全

- `settings.json` 无需迁移；`layout` 缺少 `col` 可正常读取。
- `/api/community/jobs`、`/api/launcher/jobs` 只增字段（`progress`、`createdAt`、`finishedAt`），不删旧字段。
- 不修改下载 URL、哈希校验、取消、清理、安装器等既有行为。
- 所有新 UI 文本中文；不引入第三方依赖。

## 4. 验收标准

1. 在社区下载磁贴连续观察 30 秒，同一任务始终只有一行；任务数不随刷新增长。
2. 启动器下载中心：
   - 社区任务运行中显示真实百分比与 `received / total`；
   - 完成显示 100% 绿色、「用时 X」；
   - 失败/取消显示对应状态与终止时间；
   - 启动器任务不再出现「详情 581/599 MB、字节 58/60 MB」的不一致。
3. 安装任务从点击开始到完成，耗时只统计实际运行时间；取消后不再增长。
4. 状态栏任务计数包含正在运行的启动器安装任务。
5. 默认手动模式：把 8 个磁贴全部拖到第一列后，其他列为空且不再自动散开；拖动第二列磁贴不影响第一列磁贴坐标。
6. 设置中「自适应磁贴」开启后恢复最短列自动排布；关闭后恢复手动列位。
7. 1920×1080、2560×1440 窗口下工作台磁贴宽度随窗口变化；1280×820 无横向溢出。
8. `node --test tests/*.test.mjs` 全部通过；新增测试覆盖 helper、耗时语义、列位持久化/布局。
9. `node build.mjs` 成功生成新 EXE；`tools/launcher-ui-smoke.mjs` 通过。
10. 提交、tag、push，并生成 GitHub Release（含 EXE）。

## 5. 实施切分（并行）

| 工作流 | 负责文件 | 内容 |
| --- | --- | --- |
| A 服务端任务 | `src/server/community.js`、`src/server/launcher/install.js`、`tests/download-jobs.test.mjs` | R1 服务端字段、R4 时间语义、R5 数据同步、D4–D7 |
| B 启动器下载中心 | `public/js/launcher/downloads.js`、`public/js/launcher/install.js`、`tests/launcher-install-ui.test.mjs` | R2、R4 UI、使用 `core/jobs.js` |
| C 工作台下载磁贴 | `public/features/community-download/tile.js`、`public/features/server-core/tile.js`、`tests/community-job-board.test.mjs` | R3、行复用、进度/状态/耗时、D1 |
| D 磁贴布局 | `public/js/core/grid.js`、`public/js/app.js`、`public/js/core/settings.js`、`public/css/shell.css`、`public/index.html`、`src/server/defaults.js`、`tests/tile-layout.test.mjs` | R6–R8、D9–D12 |
| E 集成验收 | 全仓库 | 审阅、测试、UI 冒烟、构建、发布 |

共享契约：`public/js/core/jobs.js` 由集成方先落地，A/B/C/D 只消费，不修改。

## 6. 发布

- 版本：`1.9.3`（package.json / README 顶部 / build-meta 若引用）。
- 构建：`node build.mjs` → `dist/mc-toolbox.exe`。
- 发布说明：汇总下载同步、耗时、手动列布局、自适应开关、宽度自适应。
- 产物：EXE + source zip（如构建脚本生成）；GitHub Release tag `v1.9.3`。

## 7. 实现与验收记录

- 统一口径：`public/js/core/jobs.js`（进度、字节、速度、耗时、无进展、合并与计数）。
- 服务端：安装任务增加 `createdAt / startedAt / finishedAt / updatedAt`，阶段切换清零字节；社区任务增加派生 `progress`，失败/取消写 `finishedAt`，镜像失败回滚字节，分片下载失败会中止其他分片；导出任务同步时间字段。
- 启动器下载中心 / 工作台社区下载磁贴 / 服务端核心磁贴 / 状态栏任务抽屉全部消费同一 helper；社区磁贴按 `id` 复用行。
- 磁贴：手动列布局默认开启，`layout[].col` 持久化，拖动只影响目标列；设置与工具条均提供「自适应磁贴」开关；窗口宽度不再被 1440px 限制。
- 自动化：
  - `node --test tests/*.test.mjs`：156 项通过（含 `jobs-helper`、`download-jobs`、`community-job-board`、`tile-layout`）。
  - `node tools/launcher-ui-smoke.mjs`：21/21。
  - `node tools/bench-layout-check.mjs`：32/32。覆盖 1920×1080 四列铺满、拖动只影响目标列、全部磁贴放第一列、手动/自适应往返、2560 变宽、1280 收为 3 列且无横向溢出、社区下载在下载中心显示真实百分比/完成用时、工作台磁贴 4 次轮询不重复行。
