# Launch Bay · 内置启动器

v1.9.1 起启动器就是主页：应用启动后直接进入启动器，工作台只是标题栏里的另一个页面（侧栏「工作台」或 `Ctrl/Cmd+2`）。设置也合并成了同一页：启动器分组（游戏目录 / 启动与 Java / 下载与安装）与工具箱分组共用左侧导航和即时保存。首次进入启动器时会让你选择游戏目录，默认在启动器旁边创建 `.minecraft`（与 PCL / HMCL 一致），之后可随时在设置里更换。

v1.9.0 在 v1.8 启动器的基础上完成四项改造：PCL 风格 MC 版本筛选与真实版本识别、外部实例启动修复与阶段进度/结构化错误、新建实例的在线整合包搜索安装、已有实例导出为可重新安装的整合包。原有八个功能、数据目录与接口保持兼容。

## 1. 页面结构

```
标题栏  品牌 · 启动器/工作台 · 本地服务 · 命令
┌───────────────┬──────────────────────────────────────────────┐
│ 账户卡          │ 实例主面板                                      │
│ 搜索            │ 图标 / 名称 / 版本 / 账户 / 启动 · 停止           │
│ 实例列表        │ 启动进度条 · 阶段文案 · 取消 / 失败诊断           │
│                 │ 概览 / 模组 / 资源包 / 光影 / 世界 / 截图 / 服务器 / 日志 │
│ 下载/Java/导入  │ 概览：启动配置、实例信息、内容统计、最近日志、崩溃诊断、版本动态 │
│ 工作台 / 设置   │                                                │
└───────────────┴──────────────────────────────────────────────┘
状态栏  本地服务 · 监测引擎 · 任务 · 游戏运行状态 · 版本 · 作者
```

- 实例列表按最近启动排序，可搜索名称、版本、加载器与分组；双击直接启动。
- 「下载中心」独立成页，只展示启动器任务（安装/整合包/修复/模组更新/导出）与社区资源下载；已完成任务可打开对应文件夹或跳转实例页。
- 新建实例、整合包与「导入已有」在独立页面，从侧栏「新建实例」进入；整合包页提供「搜索下载」（默认）与「本地文件」两种模式。
- 实例设置弹窗覆盖名称、分组、内存、窗口、全屏、自动进服、Java、JVM/游戏参数与备注。
- 启动按钮旁常驻启动进度：准备阶段显示阶段序号、阶段名、真实/不确定进度与「取消」；失败后保留红色错误条，点击打开结构化诊断面板。hero 不随 tab 切换重建，因此切到日志页再回来进度不会丢失。
- 「更多操作 → 导出为整合包」和概览快捷操作均可打开导出弹窗，选择 `.mrpack` / 通用 `.zip`、是否包含存档/截图与输出目录。
- 命令面板新增「启动器」分组，可在任意页面启动/停止当前实例、打开账户、Java、设置与实例目录。
- 启动器是主页：品牌、侧栏「工作台」、标题栏与 `Ctrl/Cmd+1` 都可以在启动器与工作台之间切换；工作台左侧 Rail 顶部新增「启动器主页」按钮，不再用「返回工作台」暗示工作台才是首页。
- 首次进入启动器（或还没确认过游戏目录）时弹出「选择游戏目录」：默认使用 `<启动器目录>/.minecraft`，也可以选择其它文件夹；启动器会在其中创建标准的 versions / libraries / assets / instances。已有实例会记住各自的目录，更换目录不会移动或删除它们。
- 设置页左侧分为「启动器 / 工具箱 / 系统」三组：启动器设置（游戏目录与存储、启动与 Java、下载与安装）和工具箱设置共用一套即时保存；原来的「延迟监测」并入「网络与监测」，「客户端转服务端」与「服务端核心」并入「服务端」。

## 2. 功能范围（参考 HMCL / PCL2 / Prism 的常用能力）

| 能力 | 实现 |
| --- | --- |
| 原版安装 | Mojang 版本清单 + 客户端 JAR + libraries + assets（含旧版 virtual / map_to_resources） |
| 加载器 | Fabric、Quilt（profile JSON）；Forge、NeoForge（官方 installer `--installClient`，安装器依赖可走 BMCLAPI 镜像） |
| 下载源 | 自动（BMCLAPI 优先、失败回退官方）、官方、BMCLAPI；并发/重试/校验可配置 |
| 进度与取消 | 真实字节数、资源文件计数、Phase、日志；任务可取消并清理临时文件；启动准备独立进度状态，可取消 |
| 实例 | 创建/编辑/复制/删除/导入已有；内存、Java、窗口、全屏、服务器、JVM/游戏参数 |
| 迁移 | 扫描标准 `.minecraft/versions`（官方 / PCL2 / HMCL），引用原目录不复制；真实 MC 版本按继承链/ JAR / 资源索引/版本目录推断，失败时要求手动指定 |
| 账户 | 离线（OfflinePlayer UUID）、微软设备代码 OAuth（内置公共客户端，也可填自己的 Azure ID）、authlib-injector 第三方 |
| 启动 | 版本继承、OS/arch 规则、Modern/legacy 参数、natives、日志配置、Forge ModLauncher；外部目录 libraries/assets/gameDir 按原 `.minecraft` 解析 |
| 启动反馈 | 账户 → 版本链 → Java → 文件 → natives → 进程 → 窗口 7 阶段；真实百分比或 indeterminate；结构化错误码与可操作按钮；异常退出崩溃诊断 |
| 日志 | stdout/stderr 实时捕获（log4j XML 转可读文本）、已保存日志、崩溃报告与中文诊断 |
| 模组 | JAR 拖入/选择、启停、删除、重复/缺失前置提示、Modrinth / CurseForge 搜索安装；按文件 SHA-1 检查 Modrinth 更新并解析缺失前置 |
| 资源包 / 光影 | Modrinth / CurseForge 搜索、PCL 风格 MC 版本下拉、兼容版本优先与标记；ZIP 导入、启停（写 options.txt）、删除、打开目录 |
| 世界 / 截图 | 世界卡片（版本/模式/大小/时间）、截图缩略图与大图、删除/打开目录 |
| 服务器 | 读写 `servers.dat`、添加/删除、一键设为启动后自动连接 |
| 整合包 | Modrinth `.mrpack`、CurseForge ZIP、本工具导出的 `.mrpack`/`.zip`；在线搜索下载或本地文件；识别 MC/加载器、安装加载器、补文件、解压 overrides |
| 整合包导出 | `.mrpack`（`modrinth.index.json` + `overrides/`）与通用 `.zip`（`manifestType: mc-toolbox` + `overrides/`）；Modrinth 哈希匹配、配置/资源包/光影/options/servers，可选存档/截图；默认排除日志、崩溃、缓存、令牌 |
| 下载中心 | 实例安装/整合包/修复/模组更新/导出任务与社区资源下载统一展示，支持取消与清理记录 |
| 版本筛选 | 安装模组/资源包/光影弹窗使用可输入下拉：全部版本、当前实例真实版本（推荐）、Mojang 版本清单（新到旧）；非法值提示且不请求 |
| 版本列表 | 当前实例 MC + 加载器兼容项置顶、按发布时间倒序、适配/当前实例可用/推荐标记；不兼容折叠「其他版本（N）」 |
| JVM 优化 | 一键写入 Aikar 风格 G1 参数，只合并 GC 参数、不改动 `-Xms`/`-Xmx` |
| Java | 本机扫描（含官方启动器 runtime）、真实 `java -version` 校验、Temurin 下载、默认 Java |
| 启动器设置（整页设置） | 游戏目录与存储、下载源/并发/重试/校验、默认内存/窗口/参数、Java、微软 Client ID、启动行为 |
| 社区接口校验 | `gameVersion` 格式 + Mojang 清单校验；非法/未知版本回退全部版本并返回中文 `gameVersionNotice` |
| 启动器更新 | 启动时检查 GitHub Releases；发现新版本右下角提示，一键下载 exe、校验 SHA-256 后替换并自动重启；可忽略版本、可配 Token |

### 未实现 / 边界

- **OptiFine**：不做自动安装器（官方安装器依赖 GUI，且需要向游戏 JAR 注入补丁）。两条可用路径：在 Forge 实例中把 OptiFine JAR 放入 `mods/`；或先用原启动器安装，再用「导入已有」。不新增自动下载，避免分发第三方闭源文件。
- **微软登录**：默认使用内置公共客户端（PCL/HMCL 同款 Live Connect 设备码），无需注册 Azure 应用；也可在「设置 → 启动与 Java → Java 与账户」填写自己的 Azure 公共客户端 ID 覆盖。令牌刷新会自动沿用登录时的流程。
- **Prism 实例**：只支持标准 `.minecraft/versions` 布局。Prism 实例的 `mmc-pack.json` + `patches/*.json` 需要现场合成版本 JSON；若写入原 `.minecraft/versions` 会破坏「只引用不修改原目录」的约定，因此本轮不实现，继续建议先用 Prism 导出/复制为标准版本后导入。
- **皮肤**：只展示账户档案自带的皮肤（微软/第三方），不提供上传或本地皮肤仓库。
- **CurseForge**：使用官方 API Key（设置中已有）或 curse.tools 公共元数据；作者禁止自动下载时给出文件名与手动处理步骤，若本地已有 SHA-1 一致的文件会直接复用。在线整合包搜索/安装未配置 Key 时显示设置引导，不创建假任务。
- **资源包启停**：直接修改 `options.txt`；游戏运行中修改可能被游戏覆盖。
- **旧版 Forge 安装器**：通过官方 installer 运行；需要对应 Java（1.12.2 → Java 8）。安装器失败时会保留完整日志。
- **导出格式**：`.zip` 使用本工具的 `mc-toolbox` 清单（含 `files` 下载地址与哈希 + `overrides/`），可被本工具重新导入；`.mrpack` 按 Modrinth 规范生成，尽量兼容 PCL2 / Modrinth App。未匹配 Modrinth 的模组会放进 `overrides/mods/`，因此导出包仍可离线还原，但体积会相应增加。

## 3. 数据目录

启动器根目录默认是启动器旁边的 `.minecraft/`（dev 模式为项目根，发布版为 exe 同级；首次进入时会让你确认或改选）。旧版自动使用的 `<data>/minecraft/` 会继续作为「已有实例」的目录保留，不会丢实例：

```
<root>/
  versions/<versionId>/<versionId>.json|.jar
  libraries/…
  assets/indexes/*.json
  assets/objects/<xx>/<hash>
  assets/log_configs/client-*.xml
  assets/virtual/<indexId>/…            # 旧版资源
  cache/installers/…                    # Forge/NeoForge 安装器缓存
  cache/authlib-injector/…              # 第三方登录 agent
  cache/packs/<jobId>/                  # 整合包临时目录（在线任务成功/失败/取消都清理）
  cache/export/<jobId>/                 # 导出临时目录（成功/失败/取消都清理）
  exports/                              # 默认整合包导出目录
  instances/<instanceId>/
    game/                               # 隔离游戏目录（mods/saves/options.txt…）
    logs/launch-*.log                   # 启动器捕获日志
    natives/<jarVersion>/               # legacy natives 解压目录
```

配置文件：

- `launcher.json`（配置目录）：启动器设置（含 `root` / `rootConfigured`）+ 实例清单 + 选中实例。每个实例会记录创建时的 `root`，切换游戏目录后仍能找到自己的文件。
- `launcherAccounts.json`（配置目录）：账户与令牌；Windows 下尝试 `chmod 600`。API 只返回脱敏字段，令牌不会进入前端或日志。
- 外部导入实例：`baseDir` 指向原 `.minecraft`，`gameDir` 可能是隔离版本目录；日志/natives 仍存放在启动器实例目录，启动时不会在外部目录创建 mods/saves 等启动器目录，删除实例不会删除原目录。
- 测试/便携场景可用环境变量 `MC_TOOLBOX_LAUNCHER_ROOT` 覆盖本次进程的启动器游戏根目录（不写入用户配置）。

## 4. 关键实现

### 4.1 版本继承、版本识别与规则

`src/server/launcher/launch-plan.js` 是纯函数层：

- `rulesAllow`：OS 名称、arch、version 正则、features；按顺序应用 allow/disallow。
- `combineVersions`：子版本覆盖标量；libraries 去重（子优先）；JVM/game 参数拼接；Forge 的空 `logging` 不会清除父版本日志配置。
- `libraryArtifacts`：优先 `downloads.artifact`，否则按 Maven 坐标构造 URL；legacy `natives` 分类器单独提取；现代 natives JAR 进 classpath。
- `buildLaunchPlan`：内存 → 用户 JVM → 版本 JVM；补 `-cp` 与 `-Djava.library.path`；日志配置；游戏参数、尺寸、服务器、自定义参数；离线/微软/第三方账户占位符。
- Forge 修复：将实际客户端 JAR 文件名追加到 `-DignoreList`，避免 ModLauncher 把 `1.20.1.jar` 当作自动模块导致 `module minecraft contains package ...`。
- `analyzeCrash`：OOM、Java 版本、NoSuchMethod/NoClassDef、 ModResolution、OpenGL、权限、网络等中文诊断。

`src/server/launcher/version-detect.js` 负责导入外部版本时识别真实 MC 版本：

1. 递归跟随 `inheritsFrom`，取继承链根版本 id；根 id 非法时继续看链上其他版本。
2. `json.jar`，其次 `json.clientVersion`。
3. `json.assetIndex.id`，其次 `json.assets`。
4. 版本目录中实际存在且带合法 id / 继承关系的原版版本 JSON。
5. 仅当值符合 Minecraft 版本格式（`1.20.1`、`26.3`、`1.20.1-pre1`、`24w14a` 等）时才采纳。
6. 仍无法判断时 `mc` 留空、`needsMc=true`，导入界面要求手动指定；`json.id` 只有通过格式校验时才可作为最后兜底，`M1182rebirth` 这类实例名/目录名永远不会被当作 MC 版本。

`inferRuntime` 同时返回 `mcSource`、`clientJarVersion`、`chain`，供导入界面显示来源（继承识别 / JAR 识别 / 版本目录）并写入实例 `mc`、`versionId`、`jarVersion`。

### 4.2 安装

`src/server/launcher/install.js`：

1. 取版本清单与版本 JSON，写 `versions/<mc>/<mc>.json`，下载客户端 JAR 与日志配置。
2. Fabric/Quilt：取 profile JSON，改写 `id` 为自定义版本 ID；Forge/NeoForge：下载官方 installer，写 `launcher_profiles.json`，**优先使用最接近要求的兼容 Java** 运行安装器（1.20.1 用 Java 17，不再挑 Java 25），读取 `version.json` 确定生成的版本 ID。
   - NeoForge 1.20.1 发布在 `net.neoforged:forge` 坐标（版本形如 `1.20.1-47.1.106`）；1.20.2+ 才使用 `net.neoforged:neoforge`；`forgeInstaller()` 会按 MC 版本选择正确坐标与 `expectedId`。
   - 非官方源时安装器本身从 BMCLAPI 下载，并预取 `version.json` / `install_profile.json` 中声明的库与 processor 的 `jar`/`classpath`；`mirrorUrl()` 同时把 `maven.neoforged.net` / `maven.minecraftforge.net` 映射到 BMCLAPI。`MOJMAPS` / `MERGED_MAPPINGS` / `MC_UNPACKED` 等 processor 生成物不再被误当成 Maven 包预取。
   - `DOWNLOAD_MOJMAPS` 会直连 Mojang，不受下载源设置影响。v1.9.4 起先用镜像链预取 `client_mappings`（校验 SHA-1/长度），再用 `jar-patch.js` 给安装器 profile 补 `--skipIfExists` 并生成 `*.patched.jar`，安装器日志会显示 `Skipping as output file exists`。
   - 安装器网络类失败（Connection reset / Connect timed out / HTTP 5xx）自动重试 3 次；最终错误会带上最后的异常行，而不是只有「退出码 1」。
3. `loadVersionChain` 合并继承链，按当前 OS 规则下载全部 libraries（含 natives）；asset index 与 objects 按 SHA-1 校验，支持镜像回退。
4. 写 `.mc-toolbox-installed` 标记并更新实例 `installedAt`；修复任务复用同一套文件检查/下载逻辑。
5. 任务由 `InstallJob` 管理：真实进度、日志环形缓冲、取消（AbortController + 杀安装器进程）、失败清理、完成后刷新实例。
6. 在线整合包 `startOnlinePackInstall`：先解析项目版本下载地址，下载到 `cache/packs/<jobId>/` 并按大小/SHA-1/SHA-512 校验，再复用同一套整合包安装管线；任务阶段固定为 下载整合包 → 校验整合包 → 解析清单 → 安装加载器 → 下载模组 → 解压覆盖文件 → 完成，成功/失败/取消都删除缓存目录。

### 4.3 启动阶段、进度与错误

`src/server/launcher/launch-phases.js`：

- 固定 7 个阶段：`account` 校验账户、`version` 解析版本与继承链、`java` 检查并选择 Java、`files` 校验客户端文件、`natives` 解压 natives、`spawn` 启动 Java 进程、`window` 等待游戏窗口出现。
- `window` 阶段是**真实检测**而不是计时：`src/server/launcher/game-window.js` 在 Windows 上轮询该 PID 的主窗口句柄（GLFW 窗口创建后非 0），其余情况回退到「窗口创建后才会打印」的日志标记（Render thread / LWJGL / OpenGL / Setting user）。只有命中其一，实例状态才从 `spawning` 变成 `running`；等待期间前端显示「正在等待游戏窗口出现…（已等待 Ns）」。
- `createLaunchError(code, …)` 为每种错误生成中文摘要、详细原因、可操作 actions 与相关路径。

`src/server/launcher/launch.js`：

- `startInstance` 立即返回 session snapshot（准备期间 `status='starting'`），真正准备在后台执行；`launchStatus().launch` 返回阶段、detail、progress、indeterminate、error、logFile 等字段。`GET /api/launcher/instances/:id/status` 每次轮询即可拿到最新阶段，切换页面不丢失。
- 账户/版本/Java/文件/spawn/window 阶段无法计算真实进度时 `progress=null` + `indeterminate=true`；natives 阶段使用 `extractZip` 的真实解压比例。不伪造百分比。
- 文件阶段检查客户端 JAR、classpath libraries、legacy natives JAR、asset index 与 objects（并发 stat，缺失计数，最多返回 20 项），并检查外部 `gameDir` 可写性。
- 取消：`cancelLaunch` 中止准备；已 spawn 时等同于停止游戏。用户主动停止标记 `stopping`，session 为 `stopped`、launch 为 `idle`，不误报崩溃。
- 异常退出：非用户停止且 code ≠ 0 时 session `failed`，launch `failed`，错误码为 `GAME_CRASHED`（有 crash-report）或 `GAME_EXITED`，附崩溃诊断、日志文件和 `open-logs` / `copy` 操作。
- 错误码：`NO_ACCOUNT`、`NO_JAVA`、`JAVA_TOO_OLD`、`VERSION_JSON_MISSING`、`MISSING_FILES`、`EXTERNAL_DIR_UNWRITABLE`、`ALREADY_RUNNING`、`SPAWN_FAILED`、`GAME_CRASHED`、`GAME_EXITED`。`src/server/api.js` 把 `code/detail/missing/missingCount/paths/actions/crash` 一并返回，前端 `core/api.js` 附加到 `Error` 上。
- 外部实例的 `versionsDir`/`librariesDir`/`assetsDir` 指向 `baseDir`，`nativesDir`/`logsDir` 仍在启动器实例目录；`ensureInstanceDirs` 不会在外部 gameDir 创建 mods/saves 等目录；客户端 JAR 按 `jarVersion` / `versionId` / `mc` 候选顺序取第一个真实存在的文件。

### 4.4 账户

`src/server/launcher/accounts.js`：

- 离线：`UUID.nameUUIDFromBytes("OfflinePlayer:"+name)` 兼容算法；随机 accessToken。
- 微软：设备码 → MS token → XBL → XSTS → Minecraft services → profile；保存 refresh token，启动前 5 分钟内自动刷新；XErr 映射为中文提示。未配置 Azure ID 时使用内置公共客户端 `00000000402b5328` 走 Live Connect 设备码；配置后走 Azure v2 设备码。`msFlow` 随账户保存，刷新时沿用同一端点。
- 第三方：authlib-injector / Yggdrasil `/authserver/authenticate`、`validate`、`refresh`；启动时下载并校验 SHA-256 的 agent，添加 `-javaagent`。
- 令牌存储本地；API 仅返回 id/type/name/uuid/皮肤/到期等。

### 4.5 整合包

`startPackInstall` / `startOnlinePackInstall`：

- 读取 `modrinth.index.json`、CurseForge `manifest.json`，或本工具导出的 `manifest.json`（`manifestType: mc-toolbox`），推断 MC、加载器与版本；`toolbox` 与 Modrinth 一样按 `files` 下载、复制 `overrides/`。
- ZIP 读取器按 EOCD 记录的偏移单独读取中央目录（必要时跟随 Zip64），不再只扫文件末尾 2 MiB；2 万+ 条目的 overrides 大包也能正确读到根目录清单。
- 安装基础版本/加载器后，解压 overrides/client-overrides 到实例游戏目录；Modrinth 按路径/哈希下载，CurseForge 按项目/文件 ID 补齐并校验 SHA-1。
- CurseForge 文件被作者禁止自动下载时，先查缓存、`mods/`、`resourcepacks/`、`shaderpacks/` 中是否有 SHA-1 一致的文件；命中则复用，否则错误信息列出 `项目/文件（文件名）` 并提示用官方启动器或手动下载。
- 记录 `.mc-toolbox-pack.json`；任务失败/取消时清理临时目录和上传文件。
- 在线任务下载地址从 Modrinth `/version` 或 CurseForge `/download-url` 解析；未配置 CurseForge API Key 时返回 `CURSEFORGE_API_KEY` 中文引导，前端显示「设置 → 社区资源」入口或改用 Modrinth。

### 4.6 导出整合包

`src/server/launcher/pack-export.js`：

- 模组：扫描 `mods/`，计算 SHA-1/SHA-512，POST Modrinth `/v2/version_files` 匹配版本；仅当版本的 `game_versions` 含实例 MC 且 `loaders` 含实例加载器、且文件哈希匹配时写入清单 `files`（下载地址、sha1/sha512、fileSize、env）；其余复制到 `overrides/mods/`。
- 配置：`config/`、`defaultconfigs/`、`kubejs/`、`resourcepacks/`、`shaderpacks/`、`options.txt`、`servers.dat`；可选 `saves/`、`screenshots/`（默认不包含）。
- 默认排除：日志、crash-reports、cache、backups、`.git`、`.mixin.out`、natives、`.mc-toolbox*`、`launcher_*.json`、`usercache.json`、`realms_persistence.json`、`servers.dat_old` 等账户/启动器内部文件。
- `.mrpack` 写 `modrinth.index.json`（`formatVersion:1`, `game:'minecraft'`, `dependencies`）与 `overrides/`；通用 `.zip` 写 `manifestType:'mc-toolbox'`、`minecraft`、`files` 与 `overrides/`，可被本工具重新导入。
- 输出默认 `<launcherRoot>/exports/`，文件名 `<名称>-<MC>-<加载器>-<时间戳>.<ext>`；staging 在 `cache/export/<jobId>`，成功/失败/取消都清理；先在输出目录写 `.part-*`，压缩包校验（清单存在、overrides 数量、files 路径）通过后才改名，避免半成品。
- 外部实例只读源目录；导出目录不能位于外部 baseDir 内。导出任务异步、可取消、带真实阶段进度与日志，前端弹窗与下载中心都能查看/打开所在文件夹。

### 4.7 内容安装版本筛选

`public/js/launcher/version-picker.js` + `public/js/launcher/content.js`：

- 可输入下拉：首项「全部版本」，次项「当前实例：<真实 MC 版本>（推荐）」，再列 Mojang 版本清单（新到旧），支持关键字过滤、键盘选择、手动输入合法版本回车应用；非法值显示提示且不发送请求。
- 搜索结果顶部显示「筛选：1.20.1 · Fabric」；服务端返回 `gameVersionNotice` 时显示金色警告。
- 项目版本列表读取全部版本，前端按实例 MC + 加载器分组：兼容项按发布时间倒序、行内标记「适配 1.20.1」「当前实例可用」「推荐」，加载器用强调色；不兼容项折叠到「其他版本（N）」，支持「显示全部版本 / 只看适配版本」；无兼容项时显示「该内容没有适配 X 的版本」+「查看全部版本」。
- 安装写入的 `meta.gameversion` 始终是实例真实 `mc`，不再使用实例名或版本文件夹名。

### 4.8 启动器自身更新

`src/server/launcher/app-update.js` + `public/js/launcher/update.js`：

- 版本源是 GitHub Releases：读取 `/repos/:owner/:repo/releases`，按语义化版本取最高项，默认忽略草稿与预发布（可在设置里接受预发布）；当前版本来自构建注入的 `PRODUCT_VERSION`。
- 检查结果缓存 10 分钟，`force=1` 绕过缓存。找不到仓库/发布、Token 失效、API 限额、网络错误都返回中文可操作提示；私有仓库或限额问题在「设置 → 启动器 → 更新」填 Token（只保存在本机，接口不回显）。
- 资产优先选 `mc-toolbox.exe`，其次其它 `.exe`；下载复用 `download.js` 的 `fetchToFile`（代理、重试、30 秒无数据中止），下载后按 `size` 与 GitHub 返回的 `sha256` digest 校验。
- 一键更新只允许 Windows 打包版（SEA）：服务端先把替换脚本写到临时目录并以独立进程启动；脚本等待旧进程退出（最长 180 秒）→ 目标 exe 改名 `.old` 备份 → 复制新 exe → 校验 → 删除备份 → 启动新版；任一步失败会回滚备份并拉回旧版。开发模式（`node server.js`）拒绝替换，只提示手动下载。
- 前端在启动器加载后按设置自动检查一次；发现新版本时右下角显示常驻卡片（立即更新 / 稍后），弹窗展示版本号、发布时间、发布说明与下载进度；替换成功后通过 WebView2 `close` 消息（或 shutdown beacon）关闭窗口，由脚本重启。命令面板「检查启动器更新」、设置 → 关于、设置 → 启动器 → 更新都可手动触发。

## 5. 接口

完整列表见 README「常用 API」。核心前缀 `/api/launcher`：

- `bootstrap` / `settings` / `status` / `sessions`
- `instances` CRUD、`select`、`repair`、`launch`、`launch/cancel`、`stop`、`preview`、`status`（含 `launch` 阶段）、`log`、`crash`
- `instances/:id/content?type=mods|resourcepacks|shaderpacks|worlds|screenshots|servers|logs|summary`
- `instances/:id/upload`（原始字节 + `X-File-Name`）、`mods/toggle`、`mods/delete`、`content/delete`、`resourcepack`、`servers`
- `instances/:id/mods/updates`、`mods/update`、`mods/missing`（Modrinth 更新检查 / 缺失前置）
- `instances/:id/export`（创建导出任务）、`exports`、`exports/:id`、`exports/:id/cancel`
- `versions`、`loaders/:loader/versions`、`install`、`jobs`、`packs/install|upload|inspect|install-online`
- `java`、`java/required`、`accounts/*`（离线/微软/authlib/select/refresh/delete）
- `import/scan`、`import`（可传 `mc` 手动指定）、`news`
- `update/check`、`update/state`、`update/download`、`update/apply`、`update/skip`、`update/reset`、`update/config`（检查 / 下载进度 / 替换重启 / 忽略版本 / 更新源配置）

社区接口：

- `GET /api/community/search?source&type&query&gameVersion&loader&limit&offset&sort`
  - 增加 `gameVersionRequested` / `gameVersionApplied` / `gameVersionNotice`；非法或未知 `gameVersion` 不硬过滤，按全部版本搜索并给出中文提示。
- `GET /api/community/versions?source&id&gameVersion&loader[&withMeta=1]`
  - 默认仍返回裸数组（兼容旧调用）；`withMeta=1` 返回 `{ items, gameVersionRequested, gameVersionApplied, gameVersionNotice, notice }`。
- `GET /api/community/project`、`POST /api/community/download`、`GET /api/community/jobs` 等保持原有行为。

文件型接口（如截图）会直接写响应，`requestHandler` 在 `res.writableEnded` 时跳过 JSON 包装。错误响应统一带 `error` 字符串；启动/安装错误额外带 `code`、`detail`、`missing`、`missingCount`、`paths`、`actions`、`crash`，前端 `core/api.js` 会把这些字段附加到 `Error`。

## 6. 验证记录

验证环境：Windows 10 x64、Node 22.18、Edge 155（CDP headless）、Java 25.0.1（官方启动器 runtime `java-runtime-epsilon`）；日期 2026-10-21。

### 6.1 自动化测试

- `node --test tests/*.test.mjs`：**105 项全部通过**。
- 新增/相关测试：
  - `tests/launcher-import.test.mjs`：版本格式、继承链、jar/clientVersion、assetIndex/assets、版本目录兜底、识别失败必须手动指定、隔离目录、`MC_VERSION_REQUIRED`/`INVALID_MC_VERSION`、清单缓存/BMCLAPI 回退、`validateGameVersion`。
  - `tests/launcher-launch-state.test.mjs`：阶段顺序与中文标签、10 个错误码、`publicLaunchState` 字段隔离、外部实例路径与 `ensureInstanceDirs` 不写外部 gameDir、Java 缺失/过旧分类、`VERSION_JSON_MISSING`。
  - `tests/launcher-pack-online.test.mjs`：Modrinth 版本解析、CurseForge 无 Key 引导、download-url 解析、`mc-toolbox` 清单识别、下载失败后的缓存清理。
  - `tests/launcher-pack-export.test.mjs`：`.mrpack` / 通用 `.zip` 结构、Modrinth 匹配与 overrides、默认排除存档/日志/令牌、勾选包含、外部目录只读、失败/取消清理、导出后 `readPackSummary` 识别。
  - `tests/launcher-version-picker.test.mjs`：版本格式、兼容判断、兼容/其他分组与推荐、筛选文案、徽章。
  - `tests/launcher-launch-panel.test.mjs` / `tests/launcher-install-ui.test.mjs`：前端启动阶段文案/进度/错误兼容、导入手动 MC 校验、在线整合包状态机、下载中心导出任务合并。
  - `tests/zip-reader.test.mjs`：中央目录超过 2 MiB（24000+ 条 overrides）时仍能读取根目录 `modrinth.index.json`，普通小包/通配符/stats 行为不变。
- 测试不再修改真实 `data/launcher.json`（使用 `MC_TOOLBOX_LAUNCHER_ROOT` 临时根与注入 create/fetcher），全量运行前后状态文件 SHA-1 一致；取消下载测试等待 PID 文本完整写入并轮询子进程退出，避免高负载下的偶发失败。连续 3 次全量运行均为 105/105。

### 6.2 构建与 EXE

- `node build.mjs` 成功：`dist/mc-toolbox.exe` **82.7 MB**；esbuild bundle 700.1 KB；public.tar.gz 259.7 KB；mc-i18n 运行时 353.0 KB；SEA blob 1580.2 KB；host.exe + WebView2 DLL 267.3 KB；应用图标 7 种尺寸校验通过。
- 构建脚本隔离冒烟：EXE 启动、首页、功能列表、作者信息与完整性校验全部通过。
- `src/server/integrity.gen.js` 与 `src/server/asset-version.gen.js` 由构建自动更新；新增 `css/launcher-versions.css`、`css/launcher-launch.css` 与 `js/launcher/version-picker.js` 已包含进壳文件清单。

### 6.3 外部 PCL2 实例（真实环境）

- 扫描 `C:\Users\HP\AppData\Roaming\.minecraft`（PCL2）：版本 `26.2`，`mc=26.2`、`mcSource=versionDir`、`clientJarVersion=26.2`、`isolated=true`，`gameDir` 为 `versions/26.2`；**没有**出现把实例名/版本文件夹名当 MC 版本的情况。
- 导入后实例 mc=`26.2`、versionId=`26.2`、jarVersion=`26.2`、external=true；`paths.versionJson/clientJarCandidates/librariesDir/assetsDir` 均指向外部 `.minecraft`，`nativesDir/logsDir` 在启动器实例目录。
- 启动到主菜单：阶段日志为 校验账户 → 解析版本 → 检查 Java（Java 25.0.1）→ 校验客户端文件（89 个库）→ 解压 natives → 启动 Java 进程 → 窗口就绪；游戏日志出现 NVIDIA 渲染设备、OpenAL、纹理图集，状态 `running`，`tasklist` 有对应 java 进程。用户停止后 session `stopped`、launch `idle`、无崩溃误报。
- 外部 26.2 实例搜索光影（`gameVersion=26.2`）返回 492 个结果；Sodium + Fabric + 26.2 返回 43 个结果。`M1182rebirth` 作为版本输入时返回「不是有效的 MC 版本号，已按全部版本搜索」。
- 导入界面手动 MC 验证：`M1182rebirth` 版本 JSON 无继承信息时显示「需要手动选择 MC 版本」与输入框，填 `1.21.8` 后成功创建实例，`versionId=M1182rebirth`、`mc=1.21.8`、`mcSource=manual`。

### 6.4 启动阶段与错误（真实环境）

- 启动 26.2 外部实例时轮询到 `preparing` → `spawning` → `window` → `running`，每阶段返回 `phase/detail/step/total/progress/indeterminate`；natives 使用真实解压比例，其余阶段无真实比例时 `progress=null`。
- `ALREADY_RUNNING`：重复启动返回中文提示、`code=ALREADY_RUNNING`、`actions=['open-logs']` 与路径。
- 取消准备：启动 Fabric 实例后 120ms 取消，launch `cancelled`、session `stopped`、无 Java 进程残留。
- `VERSION_JSON_MISSING`：删除临时外部版本 JSON 后启动，错误码与中文说明正确，`actions=['repair','open-game-dir','copy']`，路径包含版本 JSON。
- `MISSING_FILES`：临时版本缺少客户端 JAR 与资源索引，返回 `缺失 2 个文件`、缺失清单与 `repair/open-game-dir/open-logs/copy`。
- `JAVA_TOO_OLD`：版本声明 `javaVersion.majorVersion=99`，返回「未找到兼容的 Java 99」与 `select-java`。
- `GAME_EXITED`：构造 mainClass 不存在的版本，Java 进程启动后快速退出，launch `failed`，错误含退出码、日志入口与 `open-logs/copy`。
- 前端错误面板显示摘要、错误码、详细原因、缺失文件列表、相关路径与「检查并修复文件 / 选择 Java / 打开游戏目录 / 打开日志 / 复制错误信息」；非用户停止的异常退出在概览保留持久诊断卡，不只弹 toast。

### 6.5 在线整合包（真实环境）

- Modrinth 搜索 `fps`（type=modpack, 1.20.1）返回 281 个结果；在线安装「FPS Modpack 1.8」（`nJ2Rn3SV` / `fhqny3KP`，6.7 KB `.mrpack`）。
- 任务阶段：下载整合包（真实字节 0–28%）→ 校验 → 解析清单 → 安装加载器（1.20.1 + Fabric 0.15.10，资源文件 3598 个 / 622 MB）→ 下载模组 → 解压覆盖文件 → 完成；新实例 `installed=true`，12 个模组全部启用，`.mc-toolbox-pack.json` 记录正确。
- CurseForge 未配置 API Key 时在线安装返回 `CURSEFORGE_API_KEY` 中文引导（设置 → 社区资源），不创建任务。
- 下载缓存 `data/minecraft/cache/packs` 在成功后为空，无残留。

### 6.6 导出 / 重新导入（真实环境）

- 对在线安装的 1.20.1 Fabric 实例导出：
  - `.mrpack`：6.2 KB，含 `modrinth.index.json`（12 个 Modrinth 文件，sha1+sha512、downloads、fileSize）与 13 个 `overrides/` 文件（config、options.txt）；`dependencies` 为 `minecraft=1.20.1`、`fabric-loader=0.15.10`。
  - 通用 `.zip`：6.3 KB，含 `manifestType: mc-toolbox`、`files`、`overrides/`，`minecraft.version=1.20.1`、`modLoaders=[fabric-0.15.10]`。
- 默认不包含 `saves/`、`screenshots/`、`logs/`、崩溃报告、账户令牌；勾选后才复制存档/截图。
- 用本工具「整合包 → 本地文件」重新导入 `.zip`：识别为 `toolbox`，创建实例，12 个模组与 10 个 config 文件就位；启动到 Fabric 模组加载阶段（c2me / sodium 等 mixin 初始化），可正常进入游戏。
- 用本工具导出的 `.mrpack` 重新导入原始 1.20.1 实例的整合包：识别为 Modrinth 格式，创建 `MRPACK 重导入验收` 实例并完成安装，`options.txt` 等 overrides 就位。
- 通过 UI「更多操作 → 导出为整合包」对 26.2 外部实例执行一次导出：弹窗显示任务阶段、完成文件与「打开所在文件夹」，下载中心同步显示导出任务；默认输出到 `data/minecraft/exports/`。
- 外部 26.2 实例导出 `.zip`：只复制 `options.txt`/`servers.dat`，源目录文件集合与导出前一致（导出只读）；导出目录拒绝放在外部 `.minecraft` 内。
- 导出任务在下载中心显示「导出整合包」「打开所在文件夹」，完成状态含格式/大小。

### 6.7 UI 回归

- `tools/launcher-ui-smoke.mjs`：**20/20 通过**（新增 1280×820 无横向溢出、v1.9 样式表加载、900px 窄窗、亮色主题、控制台异常检查），截图输出 `dist/_ui-smoke-v19b`。
- 额外新功能 UI 验收：**21/21 通过**，覆盖：
  - 安装弹窗版本下拉（全部版本 / 当前实例 1.20.1 推荐 / Mojang 版本列表）、筛选条件「筛选：1.20.1 · Fabric」、非法 `M1182rebirth` 提示；
  - Sodium 版本列表：13 个兼容项置顶并标记「当前实例可用/推荐/Fabric」，245 个其他版本折叠并可展开；
  - 在线整合包搜索/版本列表/「下载并安装」；
  - 导出弹窗（格式、包含存档/截图、导出目录、说明），并从弹窗实际启动一次导出，完成状态显示文件/大小与「打开所在文件夹」；
  - 文件缺失实例的失败错误条与结构化面板（摘要/缺失文件/路径/4 个操作按钮）；
  - 900px 窄窗无横向溢出、无控制台异常。
- 回归：模组启停/删除/更新、资源包/光影安装、下载中心、实例设置、命令面板、工作台切换均保持可用。

### 6.8 未做真实验收 / 已知边界

- OptiFine：结论是不补自动安装器（需要 GUI/补丁注入，且涉及闭源分发）；保留 Forge `mods/` 与「导入已有」两条路径，已写入边界说明。
- Prism `mmc-pack.json`：结论是本轮不补。现场合成版本 JSON 需要写入原 `.minecraft/versions`，与「引用原目录、不改原目录」冲突；继续建议先导出为标准版本后导入。
- CurseForge 在线安装需要用户自己的 API Key；没有 Key 时只验证了引导文案与拒绝创建任务，未做真实 CF 在线整合包下载。
- 外部实例的真实启动验收使用本机 PCL2/官方 `.minecraft` 的 26.2；其它 PCL2 版本隔离布局（仅 `saves/`、自定义 JAR 命名）由单元测试覆盖，未逐一真机启动。

### 6.9 启动器自我更新（真实环境）

验证环境：Windows 10 x64、Edge（headless CDP 驱动界面）、打包版 `mc-toolbox.exe`（SEA）、GitHub Releases 公有仓库；日期 2026-10-22。

- 版本比较：`tests/launcher-update.test.mjs` 覆盖 `v1.9.2` / 预发布标签解析、数值比较（1.9.2 < 1.9.10）、草稿/预发布过滤、资产优先级（`mc-toolbox.exe` 优先）、替换脚本的路径转义、参数保留与回滚分支。
- 检查与下载：1.9.2 打包版匿名访问 `releases/latest` 发现 1.9.3；下载 86.7 MB 资产后按 `size` + GitHub `sha256` digest 校验通过（`/api/launcher/update/state` 从 downloading → ready）。
- 一键更新：界面点「立即更新 → 下载并更新」，弹窗显示下载进度并走到「更新完成，启动器正在重启…」；独立脚本日志依次出现 `update start → replace ok → relaunched`，目标 exe 的 SHA-256 变为 1.9.3，重启后的实例 `/api/bootstrap` 返回 `version: 1.9.3`，再次检查更新返回 `updateAvailable: false`。
- 关键回归：Windows 作业对象会在父进程退出时连带结束普通子进程（实测 `taskkill` 后替换脚本消失），因此替换脚本改用 WMI（`Invoke-CimMethod Win32_Process Create`）在作业外启动；`detached: true` 会让 PowerShell 5.1 静默退出，已避免；重启时空参数不能传给 `Start-Process -ArgumentList`，已按 `$argList.Count` 分支处理。
- 开发模式（`node server.js`）只检查/下载，`update/apply` 返回可操作提示，不替换进程。
- 更新源（`owner/repo`、Token、是否接受预发布、忽略版本）可在「设置 → 启动器 → 更新」修改；Token 不随接口回显。

### 6.10 Forge 安装失败与拖拽遮罩（v1.9.4，真实环境）

验证环境：Windows 10 x64、Node 22.18、Java 17.0.2 / Java 21.0.5 / 官方启动器 Java 25.0.1、真实 Forge 1.20.1-47.4.22 安装器；日期 2026-10-22。

- 现场失败：安装器在 `DOWNLOAD_MOJMAPS` 阶段访问 `launchermeta.mojang.com` 时 `java.net.SocketException: Connection reset`，退出码 1；同时日志首行显示安装器被 Java 25 启动（`JVM info: Microsoft - 25.0.1`）。
- 修复后真实安装：自动选择 Java 17；预取 `client_mappings`（8,001,795 字节 / SHA-1 校验通过），安装器日志出现 `--skipIfExists` 与 `Skipping as output file exists`；安装器成功输出 `Successfully installed client into launcher.`，实例 `1.20.1-forge-47.4.22` 标记为已安装。
- 网络重试：安装器输出中的 `SocketException` / `Connect timed out` / `Connection reset` / HTTP 5xx 会触发最多 3 次自动重试；非网络错误（如 Java class 版本）不会重试。
- 拖拽遮罩：headless CDP 模拟 `dragenter`/`dragover` 后遮罩出现；`dragend` 后 60ms 内清除；停止 `dragover` 1.5 秒后看门狗自动清除，不再卡死页面。
- UI 回归：`node tools/launcher-ui-smoke.mjs` 27/27（新增拖放遮罩、下载中心安装入口、吸顶进度坞检查）。

## 7. 截图

v1.8 暗色：总览、新建实例、下载中心、Java、账户、启动器设置；亮色：总览。v1.9 新增的版本下拉、兼容版本列表、启动进度/错误面板、在线整合包与导出弹窗见本轮验收截图（`dist/_ui-smoke-v19b` 与临时验收目录，未随仓库提交）。v1.9.1 更新了首次选择游戏目录与统一设置页的截图。v1.9.2 新增启动器更新弹窗与「设置 → 启动器 → 更新」截图（开发模式下「下载并更新」不可用，界面会说明原因）。

![首次选择游戏目录](screenshots/launcher/00-first-run.png)
![启动器总览](screenshots/launcher/01-overview.png)
![新建实例](screenshots/launcher/02-new-instance.png)
![下载中心](screenshots/launcher/07-downloads.png)
![Java](screenshots/launcher/03-java.png)
![账户](screenshots/launcher/04-accounts.png)
![设置（启动器分组）](screenshots/launcher/05-settings.png)
![亮色主题](screenshots/launcher/06-overview-light.png)
![启动器更新](screenshots/launcher/08-update.png)
![更新设置](screenshots/launcher/09-update-settings.png)
