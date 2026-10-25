# Minecraft 工具箱

### v1.11.0 好友系统改为正版账号 + 中心服务器

- 好友不再使用 P2P / 好友码 / 中转：启动器用已登录的正版微软账户向自建好友服务器换取会话，按正版游戏 ID 添加好友；好友能看到真实正版 ID，自己可以设置昵称。离线与第三方账户无法通过正版校验，会被明确拒绝。
- 服务器负责好友请求、在线状态（含正在玩的实例）、离线聊天与未读；消息保存在服务器，换设备登录也能看到。整合包与模组文件做临时中转：接收方下载完成后 10 分钟删除，未下载的 24 小时过期；默认配额 5 GB/账号、全局 15 GB。
- 传输安全：服务器使用自签 HTTPS，客户端首次连接显示证书 SHA-256 指纹，确认后固定并在每次响应时比对；公网 `http://` 直接拒绝。服务器的正版校验只调用 Mojang 接口读取档案，不保存 Minecraft 访问令牌，只发 30 天会话令牌（哈希存盘）。
- 部署：`tools/friends-server.mjs`（零依赖）配 systemd 与邀请码注册，部署步骤见 [好友服务器](docs/friends-server.md)。客户端好友页改为「连接服务器 → 绑定正版账号登录 → 好友/聊天/传输」，移除好友码、UPnP/STUN 与中转设置。
- 模组同步：双方把清单上传到服务器后对比；补齐优先用已收到的文件与 Modrinth，私有模组由对方点「把我独有的发给对方」经服务器临时中转。
- 回归与验证：`node --test tests/*.test.mjs` 241 项通过（新增服务器 9 项、HTTPS 客户端 5 项）；`node build.mjs` 生成 EXE 并通过隔离冒烟；真实服务器已部署在阿里云 443（Ubuntu 24.04 + Node 18），公网探测证书指纹与健康检查通过；临时文件上下行由本地 HTTPS 集成用例覆盖。
- 设计、接口、安全边界与部署记录见 [好友服务器说明](docs/friends-server.md)。

### v1.10.0 启动器好友：P2P 聊天、整合包分享与模组对称补齐

> v1.11.0 已把好友改为「正版账号 + 中心服务器」，本节仅作历史记录；`tools/friends-relay.mjs` 已移除。

- 启动器侧栏新增「好友」页：好友码（`MCTB1-`，含公钥与地址）、粘贴互加、待处理请求、在线 / 不可达 / 等待确认状态、延迟与「正在玩」，以及每个好友一条会话的聊天框（Enter 发送、Shift+Enter 换行、未读数与「已送达」标记）。全程点对点，不经过任何服务器。
- 连接使用 X25519 + HKDF + AES-256-GCM 逐帧加密；好友码里的公钥是唯一信任锚点，地址被换掉时公钥对不上会直接断开。同一局域网直接连；跨网络先尝试 UPnP 自动端口映射，失败时可在设置里填公网地址 / DDNS，页面显示「不可达」而不是假装在线。
- 每次（重）连都由对端确认一次：对方删掉你之后不会出现「本地显示在线、对方其实不认识你」的假在线，对方会重新收到好友请求。
- 可选自建中转：该版本用 `tools/friends-relay.mjs` 做大厅配对与盲转发；v1.11.0 起已由中心好友服务器取代。
- 分享整合包：导出（`.mrpack` / `.zip`，可选存档 / 截图）后通过当前 P2P 连接发送，对方点「接收」才落盘；128 KB 分块 + SHA-1 校验，存到数据目录的 `friends/received/<传输 id>/`，可直接进入「新建实例 → 整合包」安装。
- 模组对称补齐：按 SHA-1 比对双方同一实例的 mods，分「一致 / 仅我有 / 仅对方有 / 版本或启用状态不同」；「以对方为准补齐」依次从已收到的暂存区、Modrinth（按 SHA-1）、对端直传取文件，冲突的旧版本改名 `.disabled` 而不是删除，完成后重新比对确认两边一致。也可以把只有我有的模组发到对方暂存区，由对方决定是否应用。
- 隐私边界写进界面与文档：不提供离线消息队列、群聊、断点续传；没有中转且双方都在 NAT 后时无法直连；Modrinth 不可达且对方离线时不能补齐；好友身份跟着配置目录走，同一配置目录的两个启动器进程会共用身份。中转服务器需要自己维护，它能看到连接元数据（IP、时间、流量），但看不到聊天与文件内容。
- 回归与验证：`node --test tests/*.test.mjs` 270 项通过（新增 62 项：好友码校验、握手派生与篡改、存储、文件名消毒、传输台账、差异与补齐、聊天记录、双节点回环 P2P / 聊天 / 拒绝）；两个本机实例走通真实链路（A 添加 B、B 接受、聊天送达、UPnP/STUN 降级显示），并在阿里云轻量服务器上实测自建中转的 ping / 配对 / 聊天；headless Edge 探针确认好友页、聊天框与模组对比弹窗渲染且无控制台异常；`node build.mjs` 生成 83.0 MB EXE 并通过隔离冒烟（含好友页资源与新增接口的完整性校验）。

### v1.9.9 更新弹窗不再重复叠层

- 修复「弹出更新窗口后，点右下角卡片上的『立即更新』又弹出一个新的更新窗口」：右下角提示卡片挂在 `toastRoot`（`z-index: 400`）里，层级高于更新弹窗（`z-index: 200`），点它就会再调一次 `openUpdateDialog`，于是叠出第二份弹窗；关掉上面那份，下面那份又露出来，看起来像「弹窗关不掉」。现在 `openUpdateDialog` 同一时间只保留一个弹窗，重复触发只把已有弹窗提到最上层（`raiseModal`），不再新建。
- 弹窗打开时收起右下角卡片，关闭后再放回来（正在替换程序或已选择「忽略此版本」时不恢复）。卡片原来会盖住弹窗右下角，现在不会再出现「分不清哪个是弹窗按钮」的情况。
- 「稍后 / 忽略此版本 / 关闭窗口」的行为不变；下载进度轮询、替换脚本与自动重启逻辑未改动。
- 回归与验证：`node --test tests/*.test.mjs` 208 项通过；`tools/launcher-ui-smoke.mjs` 30/30（新增 3 项：更新弹窗只开一层、弹窗打开时收起卡片、关闭后不残留且卡片恢复）。

### v1.9.8 已运行实例接管、多开与模组真实 modid

- 启动器启动/轮询时扫描本机 `java.exe` / `javaw.exe`，按命令行里的 `--gameDir` 精确匹配已添加实例；启动器重启后内存 session 丢失，仍能显示运行中、PID 与已运行时长，不再把正在玩的实例当成未启动。命令行（可能含 `--accessToken`）只在内存中用于匹配，不返回前端。
- 运行中的实例可单独停止：Windows 先发关闭请求，8 秒未退出再 `taskkill /F /T`；Unix 先 `SIGTERM` 再 `SIGKILL`。日志页自动接入游戏 `latest.log`，按字节偏移增量跟随，外部进程不需要 stdout 管道。
- 多开：不同实例可同时运行；hero 和「正在运行」面板保留「再开一个」，保持当前进程并从其它已安装实例中选择启动。同一实例仍只允许一个进程，避免存档与 `options.txt` 互相覆盖。
- 模组识别修复：Forge/NeoForge 实例优先读 `META-INF/mods.toml` / `neoforge.mods.toml`，不再被同 jar 的 `fabric.mod.json` 假依赖污染；解析 Forge `META-INF/jarjar/metadata.json` 与 jar-in-jar 子模组，Xaero 的 `xaerolib`、PuzzlesAccessAPI、MixinExtras 等内嵌前置会被识别为已提供。
- 依赖块只归到实际 `[[mods]]` 声明的 modId；mod ID 比较忽略大小写与 `-` / `_` 分隔符（`yumi-commons-core` = `yumi_commons_core`）；有真实元数据时不再用文件名猜 modid；Forge 实例中的 Fabric-only 模组标记「加载器不匹配」并忽略其依赖，避免无意义的 Fabric API 报缺。
- 回归与验证：`node --test tests/*.test.mjs` 208 项通过；headless Edge 探针 14/14（2 个外部进程同时运行、运行面板/hero、再开一个、日志接入、停止后只保留另一个、900px 无横向溢出、无控制台异常）与模组页探针 5/5（Xaero 真实 modid、内嵌 xaerolib 不报缺、Fabric-only 标记加载器不匹配）；真实 Forge 1.20.1 整合包 97 个 jar 扫描后缺失依赖为 0，97/97 识别到真实 modid（`kotlinforforge-all.jar` 从 jar-in-jar 识别）；`node build.mjs` 生成 82.8 MB EXE 并通过隔离冒烟。

### v1.9.7 在线搜索支持分页与按下载量排序

- 启动器的「安装模组 / 资源包 / 光影」弹窗与「新建实例 → 整合包」在线搜索新增分页条：上一页、下一页、输入页码跳转，并显示「1–20 / 共 N 个结果」与「第 X / Y 页」；最后一页自动禁用「下一页」，搜索或切换来源、版本、筛选、排序时回到第 1 页。
- 上述搜索框新增排序：相关性、下载量（热度）、点赞、最近更新、最新发布。请求统一携带 `offset` / `limit=20` / `sort`，Modrinth 与 CurseForge 都按所选排序返回；结果区不再只能靠一条很短的滚动条翻看。
- 修复 CurseForge 排序被 API 拒绝：v1 `/mods/search` 的 `sortOrder` 只接受 `asc` / `desc`，旧代码传数字 `2` 会返回 HTTP 400「The value '2' is invalid」，按下载量排序直接失败；现已改为 `desc`。
- 社区资源磁贴的分页条补充总页数，修复最后一页仍能点「下一页」；排序项明确为「下载量（热度）」。
- 回归与验证：`node --test tests/*.test.mjs` 195 项通过；headless Edge 探针 24/24（模组搜索分页/页码跳转、排序请求参数、整合包分页/排序、社区磁贴分页），另加 CurseForge 探针 5/5（下载量排序与翻页请求），无前端控制台异常。

### v1.9.6 更新启动器不再关闭正在运行的游戏

- 修复「一键更新启动器时，正在玩的 MC 被一起关掉」：Windows 上 Node/libuv 会把非 detached 的子进程与启动器放进同一个 kill-on-close 作业对象，替换脚本等待旧进程退出的那一刻作业关闭，游戏被 `TerminateProcess` —— 表现是 `latest.log` 没有 `Stopping!`，直接断在最后一行。游戏进程改为 `detached: true` 启动（`gameSpawnOptions`），启动器关窗 / 一键更新 / 重启都不再影响游戏；游戏自己的日志、崩溃报告与「停止游戏」不变。
- 顺带修复「启动后关闭启动器」：关闭启动器后游戏继续运行，设置文案与实际行为一致。
- 回归与验证：新增 `tests/launcher-game-detached.test.mjs`（把 `detached` 改回 `false` 即失败）；`node --test tests/*.test.mjs` 187 项通过；`node build.mjs` 生成 82.8 MB EXE 并通过隔离冒烟。根因、探针数据与验证记录见 [启动器说明 · 6.11](docs/launcher.md#611-更新启动器不再关闭正在运行的游戏)。

### v1.9.5 实例目录可读化、稳定性与全功能体检修复

- 实例目录改为 `versions/<实例名>/`，重命名实例实时同步文件夹名；旧版 `instances/<id>/game` 在首次启动时自动迁移，文件被占用则保留旧布局下次重试，不会丢档。版本 JSON / `libraries` / `assets` 仍共享，不重复占盘。
- 并发安装：未完成的实例在装好之前不再出现在侧栏；安装失败/取消会自动刷新列表，不再出现「读取实例失败 · 实例不存在」。
- 修复整合包下载「长度校验失败（1286462 / 1286460）」误报：有哈希时以哈希为准，清单里的 `fileSize` 只用于进度；哈希不符会在同一地址重下一次。
- 修复 BMCLAPI 镜像：`piston-data` 对象（客户端 JAR / client_mappings / 日志配置）改走 `/v1/objects/<hash>/<文件名>`，并保留官方地址兜底；下载超时由「总时长 5 分钟」改为「60 秒无数据」。
- 实例列表新增右键菜单（启动/停止、设置、打开游戏目录与日志、复制、导出整合包/配置、删除），运行中的实例禁止删除/复制/修复。
- 存档编辑器：修复「按坐标替换」因坐标形状不一致必然报错、区域文件误用全局区块坐标导致读写错位、跨区域只备份第一个文件、失败仍提示成功。
- 界面与安全：修复欢迎页重复渲染、确认弹窗把实例名当 HTML 渲染（存储型 XSS）、启动命令预览泄漏旧版 `--session` 令牌、侧栏实例计数不显示、删除实例目录失败却提示成功。
- 后端稳定性：刷新页面不再触发后端退出；「清空监测历史」不再被 `:id` 路由吞掉；导入损坏配置不再让进程崩溃；限速过低时下载队列不再死锁；`/api/mods/apply` 拒绝扫描目录之外的路径，`openPath` 移除可注入命令的 `cmd /c start` 回退。
- 启动与账户：设置里的「默认 Java」真正生效；未知账户 ID 不再静默换成第一个账户，刷新也不会把已删除的账户「复活」。
- 整合包与转换：客户端实例不再解压 `server-overrides`；本地整合包先下载再解压覆盖文件，修掉同路径覆盖导致的「哈希校验失败」；CurseForge 清单支持自定义 `overrides`、世界/数据包类目不再让整包失败；客户端转服务端修正 NeoForge `type/side`、`[[mods]]` 块顺序与嵌套 jar 引起的「必需模组依赖缺失」误报。
- 导出与导入：外部实例与启动器同根时也能导出整合包；导入指定目录找不到版本时直接报错，不再悄悄改用其它 `.minecraft`。
- 回归与验证：`node --test tests/*.test.mjs` 185 项通过；`node build.mjs` 打包并隔离冒烟通过。

### v1.9.4 拖拽恢复、下载中心直达安装与 Forge 安装修复

- 修复拖入整合包后「松开以安装整合包」遮罩卡死：新增拖拽状态看门狗，`dragend`、Esc、窗口失焦、离开窗口和切页都会清理遮罩；安装页自己的拖放区不再把同一个文件上传两次。
- 下载中心与新建实例联动：已完成整合包下载行新增「安装到新实例」，点击后直接进入「新建实例 → 整合包」，载入本地文件并自动开始安装；页头也新增「安装整合包」入口。
- 安装进度上移：整合包 / 实例安装任务改为页头下方的吸顶进度坞，显示百分比、阶段、字节、耗时，并提供取消任务、查看日志、打开实例；滚动到内存与分组设置时进度仍可见。
- 修复 Forge / NeoForge 安装失败：安装器不再优先挑 Java 25（1.20.1 现在使用最接近要求的 Java 17）；预取 Mojang client mappings 并给安装器补 `--skipIfExists`，绕开安装器对 `launchermeta` / `piston-data` 的直连重置；网络类失败自动重试 3 次，失败原因会显示具体异常行。
- 安装器依赖预取不再把 `MOJMAPS` / `MERGED_MAPPINGS` / `MC_UNPACKED` 等 processor 生成物当成 Maven 包下载，减少无谓的超时与 404。
- 回归与验证：`node --test tests/*.test.mjs` 162 项通过；`tools/launcher-ui-smoke.mjs` 27/27；真实 Forge `1.20.1-47.4.22` 安装成功，安装器日志确认 `Skipping as output file exists`。
- 需求、根因与验收记录见 [v1.9.4 安装恢复与下载联动](docs/v1.9.4-install-recovery.md)。

### v1.9.3 下载同步、任务耗时与手动磁贴布局

- 工作台与启动器的下载统一口径：社区下载磁贴、下载中心、状态栏任务数共用 `public/js/core/jobs.js`，同一任务在三个位置显示相同的百分比、字节、速度与状态。状态栏「任务 N」现在同时统计社区下载与启动器安装任务。
- 修复工作台社区下载磁贴的「任务越刷新越多」：任务行按 id 复用，不再每次轮询都追加新行；同一任务任何时刻只显示一行。
- 修复下载中心的进度与状态：社区任务不再永远显示不确定动画，运行中显示真实 `received / total`、百分比与速度；完成显示 100% 与「用时」；失败/取消显示终态与终止时间，不再显示「已进行」。安装任务详情与字节字段统一按当前阶段计数，不再出现详情 599 MB、字节 60 MB 的错位。
- 修复安装/下载耗时：任务区分 `createdAt`（排队）与 `startedAt`（真正开始），`finishedAt` 在所有终态写入；排队时间不再算进「已进行」。运行中超过 2 分钟没有进展会显示「无进展 X」，便于识别卡住的任务；镜像重试不会把失败尝试的字节计入进度。
- 工作台磁贴默认改为「手动列布局」：每个磁贴有独立的列位（`layout[].col`），拖动只改变目标列与列内顺序，其他列的磁贴不会被挤走；支持把所有磁贴放在第一列或任意列，窗口变窄时暂时收列、变宽后回到原列。
- 设置 → 通用 → 外观新增「自适应磁贴」开关，工作台工具条也提供「手动 / 自适应」切换；开启后恢复按最短列自动排布，切换不丢列位、不重新挂载磁贴。
- 工作台内容不再被 1440px 宽度限制，1920 / 2560 窗口下磁贴随窗口变宽；1280×820 自动收列且无横向溢出。
- 回归与验证：`node --test tests/*.test.mjs` 156 项通过；`tools/launcher-ui-smoke.mjs` 21/21；新增 `tools/bench-layout-check.mjs` 32/32（手动列布局、拖动、宽度自适应、下载中心真实进度与磁贴轮询行数）。
- 需求、根因与验收记录见 [工作台下载同步与磁贴布局需求](docs/bench-downloads-layout.md)。

### v1.9.2 启动器检查更新与一键更新

- 启动器启动时检查 GitHub Releases：发现新版本在右下角提示「启动器有新版本」，可立即更新或稍后；`设置 → 启动器 → 更新`、`设置 → 关于` 与命令面板都能手动检查。
- 一键更新：下载发布资产里的新 `mc-toolbox.exe`，校验大小与 SHA-256 后，由独立 PowerShell 脚本在旧进程退出后替换 exe 并自动重启；替换失败会回滚备份并拉回旧版。开发模式（`node server.js`）只检查、不替换本体。
- 更新源可配置：默认官方仓库，可改 `owner/repo`、填写访问 Token（私有仓库或 API 限额，只保存在本机不回显）、接受预发布版本、忽略某个版本。
- 详细设计见 [启动器说明 · 启动器自身更新](docs/launcher.md#48-启动器自身更新)。

### v1.9.1 启动器主页、统一设置与 .minecraft 目录

- 启动器成为唯一主页：启动应用直接进入启动器，品牌、侧栏「工作台」、标题栏与 `Ctrl/Cmd+1` 都能回到启动器；去掉「返回工作台」这种把工作台当主页的文案，工作台 Rail 顶部新增「启动器主页」按钮。
- 设置合并成一页：左侧导航分为「启动器 / 工具箱 / 系统」；启动器设置从弹窗并入整页（游戏目录与存储、启动与 Java、下载与安装，原 7 张卡片合并为 4 张），与工具箱设置共用即时保存。「延迟监测」并入「网络与监测」，「客户端转服务端」与「服务端核心」并入「服务端」。
- 首次启动选择游戏目录：默认在启动器旁边创建 `.minecraft`（与 PCL / HMCL 一致），也可以选择其它文件夹；启动器会在其中准备 `versions` / `libraries` / `assets` / `instances`。每个实例都会记住创建时的根目录，之后更换游戏目录不会移动或丢失已有实例。
- 旧版 `<data>/minecraft` 升级：如果 root 还停在旧版自动写入的位置（用户从未主动选过），会重新弹出目录选择；已有实例自动固定到旧目录，文件不受影响。
- 详细设计见 [启动器说明](docs/launcher.md)。

### v1.9.0 版本识别、启动反馈与整合包能力

- 内容安装（模组 / 资源包 / 光影）把「实例版本 / 全部版本」两段按钮换成 PCL 风格可输入 MC 版本下拉：全部版本、当前实例真实版本（推荐）、Mojang 版本清单（新到旧）；支持关键字过滤、手动输入合法版本、非法值中文提示且不发送请求。搜索结果顶部显示「筛选：1.20.1 · Fabric」；项目版本列表把当前实例 MC + 加载器兼容项置顶并按发布时间倒序，标记「适配」「当前实例可用」「推荐」，不兼容版本折叠到「其他版本（N）」，无兼容项时提供「查看全部版本」。
- 外部实例版本识别修复：导入 PCL2 / HMCL / 官方 `.minecraft` 时按 `inheritsFrom` 链根 → `jar`/`clientVersion` → `assetIndex`/`assets` → 版本目录中的原版 JSON → 版本格式校验的顺序解析真实 MC 版本；无法判断时在导入界面要求手动选择，不再拿实例名或版本文件夹名（如 `M1182rebirth`）冒充 MC 版本。导入后 `mc`、`versionId`、`jarVersion`、`baseDir`、`gameDir` 与外部 `libraries`/`assets` 均指向正确位置。
- 外部实例启动修复：外部 `versions` / `libraries` / `assets` 按原 `.minecraft` 解析，启动器日志与 natives 仍写入实例目录；客户端 JAR 按 `jarVersion`/`versionId`/`mc` 候选取实际存在的文件；PCL2 版本隔离目录（`versions/<id>/mods`、`saves`）作为 `gameDir`；启动准备不会在外部目录创建 mods/saves 等启动器目录。
- 启动流程拆为账户 → 版本链 → Java → 文件 → natives → 进程 → 窗口 7 个阶段，前端在启动按钮旁显示进度条、阶段文案、真实/不确定进度与「取消」；准备状态保存在服务端，切换页面不丢失，重复点击被 `ALREADY_RUNNING` 拦截。
- 启动失败返回结构化错误：`NO_ACCOUNT`、`NO_JAVA`、`JAVA_TOO_OLD`、`VERSION_JSON_MISSING`、`MISSING_FILES`、`EXTERNAL_DIR_UNWRITABLE`、`ALREADY_RUNNING`、`SPAWN_FAILED`，面板显示摘要、详细原因、缺失文件与相关路径，并提供「检查并修复文件」「选择 Java」「打开游戏目录」「打开日志」「复制错误信息」。异常退出显示 `GAME_CRASHED` / `GAME_EXITED` 诊断与日志入口；用户主动停止不误报崩溃。
- 新建实例 → 整合包新增「搜索下载」（默认）与「本地文件」双模式：Modrinth / CurseForge 搜索、PCL 风格 MC 版本筛选、项目版本兼容优先与标记、一键「下载并安装」。后端解析下载地址、缓存并校验哈希，复用现有整合包管线；任务阶段为 下载整合包 → 校验整合包 → 解析清单 → 安装加载器 → 下载模组 → 解压覆盖文件 → 完成，成功/失败/取消都清理临时目录。CurseForge 未配置 API Key 时显示明确设置引导。ZIP 读取器改为按 EOCD 偏移读取中央目录，2 万+ 条 overrides 的大包也能正确识别清单。
- 已有实例支持「导出为整合包」：优先 Modrinth `.mrpack`（`modrinth.index.json` + `overrides/`），同时提供通用 `.zip`（`manifestType: mc-toolbox` + `overrides/`）。模组按 SHA-1 匹配 Modrinth 并写入下载地址/哈希，未匹配的放入 `overrides/mods/`；导出 `config/`、`defaultconfigs/`、`kubejs/`、`resourcepacks/`、`shaderpacks/`、`options.txt`、`servers.dat`，可选存档/截图；默认排除日志、崩溃报告、缓存与账户令牌。导出异步、可取消、有真实进度与压缩包校验，失败不留半成品；外部实例只读源目录。
- 社区接口 `/api/community/search` 与 `/api/community/versions` 对 `gameVersion` 做格式 + Mojang 清单校验：非法/未知版本不硬过滤，回退全部版本并返回 `gameVersionNotice`，避免静默 0 结果。版本接口保留旧数组响应，新增 `withMeta=1` 返回对象与提示。
- 回归与验证：`node --test tests/*.test.mjs` 105 项通过；`node build.mjs` 生成 82.7 MB EXE；`tools/launcher-ui-smoke.mjs` 20/20；真实 PCL2 外部 26.2 实例启动到主菜单，在线安装 Modrinth「FPS Modpack 1.8」，导出 `.mrpack`/`.zip` 后重新导入并启动。
- 详细设计与验收记录见 [启动器说明](docs/launcher.md)。

### v1.8.0 内置启动器（Launch Bay）

- 新增独立启动器页面并作为默认主菜单：标题栏「启动器 / 工作台」一键切换，`Ctrl/Cmd+1`、`Ctrl/Cmd+2` 直接跳转。工作台、八个功能磁贴、设置页与所有旧数据保持原样，启动器只新增入口，不替换任何工具。
- 实例管理：原版、Fabric、Quilt、Forge、NeoForge 安装，原版快照/正式版筛选，加载器版本在线候选；实例名称、分组、内存、窗口、全屏、服务器自动连接、JVM / 游戏参数、Java 覆盖都可单独设置。每个实例独占 `versions/<实例名>/` 作为游戏目录（改名实时同步文件夹名），版本 JSON / `libraries` / `assets` 在启动器根目录共享，不重复占盘；安装中的实例完成前不会出现在侧栏。
- 安装使用真实字节进度、SHA-1 校验和可取消任务；Mojang 资源支持 BMCLAPI 镜像与自动回退，Forge/NeoForge 运行官方安装器并校验生成的版本 JSON；NeoForge 安装器依赖可从 BMCLAPI 预取，避免 `maven.neoforged.net` 不可达时卡住。任务日志可在下载中心展开。
- 账户：离线账户（标准 OfflinePlayer UUID）、微软设备码 OAuth（内置 PCL/HMCL 同款公共客户端，开箱即用；也可在设置中覆盖为自己的 Azure 公共客户端 ID）、authlib-injector 第三方登录；令牌只保存在本机、API 返回一律脱敏，启动前自动刷新/验证，第三方账户启动时自动加载 authlib-injector。
- 启动：解析 `inheritsFrom` 版本链、OS/arch 规则、Modern/legacy 参数、natives 解压、资源索引、日志配置、legacy `virtual` / `map_to_resources`；支持 Forge ModLauncher（自动把实际客户端 JAR 加入 `ignoreList`）、自动进入服务器、窗口尺寸与全屏。日志实时显示并对 OOM、Java 版本、模组依赖/冲突、显卡驱动、权限、网络给出中文诊断；启动 Java 时隐藏控制台窗口，不再弹出空白 cmd 黑框。
- 内容管理：模组启停/删除/拖入导入、Modrinth / CurseForge 搜索安装、按 SHA-1 检查 Modrinth 更新（单独更新 / 全部更新）与缺失前置一键补全；资源包、光影同样支持搜索、MC 版本筛选与版本选择下载，资源包启停（写 `options.txt`）；世界、截图、`servers.dat`（可一键设为启动服务器）；日志与崩溃报告查看。下载中心独立成页，只展示任务与下载记录，普通文件可打开所在文件夹，实例任务直接跳转实例页。
- JVM 优化：新建实例时可勾选「一键优化 JVM 参数」，实例设置里也提供同一按钮；写入 Aikar 风格 G1 参数，只合并 GC 参数、不改动 `-Xms`/`-Xmx`。
- 整合包：支持 Modrinth `.mrpack` 与 CurseForge ZIP，自动识别 MC/加载器、安装对应加载器、下载缺失文件并解压 overrides；CurseForge 按清单项目/文件 ID 补齐，未开放自动下载会给出可操作的中文提示，手动放入 SHA-1 一致的文件后也会复用。
- 迁移：可扫描并导入本机官方 / PCL2 / HMCL 等标准 `.minecraft/versions`（只引用原目录，不复制游戏文件），也支持按目录扫描。
- Java：扫描 PATH、JAVA_HOME、常见 JDK、官方启动器 `runtime`、工具箱内置运行时与 `.jdks`，解析 `java.home` 避免 Oracle `javapath` 垫片导致进程无法停止；可直接下载 Temurin 8–25，并支持一键写入 Aikar 风格 G1 优化参数。
- 启动器设置：游戏目录、下载源（自动 / 官方 / BMCL）、并发、重试、文件校验、默认内存/窗口、默认 JVM/游戏参数、默认 Java、微软客户端 ID、启动后关闭启动器窗口等。
- 数据位置：启动器数据默认在运行数据目录的 `minecraft/`（开发模式 `data/minecraft`，EXE 模式 `%LOCALAPPDATA%\MC Toolbox\data\minecraft`）；账户令牌在配置目录的 `launcherAccounts.json`，实例清单在 `launcher.json`。
- 已知边界：OptiFine 未做自动安装（可用导入已有版本或把 OptiFine JAR 放入 Forge 的 mods）；Prism 的实例元数据（`mmc-pack.json`/patches）暂不直接导入；皮肤只显示官方/第三方档案自带皮肤，不提供上传。
- 详细设计与接口见 [启动器说明](docs/launcher.md)。

### v1.7.0 新工作台与一键迁移

- 前端按「The Bench」设计系统整体重做：40px 标题栏、功能 Rail、状态栏、命令面板（`Ctrl/Cmd+K`）、任务抽屉，八个功能磁贴与十个设置分区全部换新。API、设置键名与数据文件保持兼容，旧数据无需迁移。
- 磁贴网格重写：列数可选 1–4，窗口变窄时按实际宽度收列并在按钮上提示；拖拽改为每帧 `transform` 定位加 FLIP 重排，磁贴不再落后于指针。
- 目录设置新增「一键迁移到单个文件夹」：配置、mod 库、运行数据一起复制到所选目录的 `config` / `client-mods` / `data`，三类都复制并校验通过后才切换并清理旧目录；任一步失败保留原目录，只删除本次自己创建的内容。
- 修复延迟监测的轮询间隔：下限从 5 秒改为 1 秒，修改后下一拍即生效；调度节拍改为 250ms，1 秒间隔不再被推迟到 2 秒，全局并发上限跨节拍生效。
- 服务器地址框支持直接粘贴 `host:port`、`[IPv6]:port` 以及带协议前缀或路径的写法，自动拆到地址与端口两个输入框。
- 设置页的「危险操作二次确认」「时间格式（12/24 小时）」「启动后自动监测」现在即时生效：确认框、图表时间轴与监测引擎同步跟随，无需重启。
- 客户端转服务端：转换面板的内存初值读取设置中的分配内存，「自动识别环境」默认值读取设置中的同名开关。
- 新旧界面差异、有意变更与回滚方式见 [旧版 → 新版对照说明](docs/frontend-changelog.md)。

### v1.6.3 扩展 Java 选择

- Java 下载器可选择 Java 8–25 的大版本，不再只显示 8、16、17、21、25。Eclipse Temurin 没有提供某个已结束版本时会给出明确失败原因。
- 下载 Java 弹窗会扫描本机 PATH、JAVA_HOME、常见 JDK 安装目录、工具箱随包运行时和用户 `.jdks`，列出发现的所有 64 位 Java（包括非工具箱下载的发行版），可以直接使用路径。
- Java 选择保持安全校验：最终启动前仍检查实际大版本和 64 位；扩大可见范围不会让不兼容 Java 被静默用于服务端。

### v1.6.2 恢复原版图标

- 恢复 v1.6.0 左上角的原版绿色方块图标和网页图标。
- EXE、窗口与任务栏使用原版左上角图标的默认深色主题配色，保留七种尺寸及最终 EXE 图标校验。

### v1.6.1 应用图标修复

- 下载的 EXE、桌面窗口、任务栏及页面统一使用像素工具箱图标，修复外层 EXE 仍显示 Node.js 默认图标的问题。
- 嵌入 16–256 像素共七种尺寸，构建时验证最终 EXE 的图标资源并执行程序启动检查。

### v1.6.0 Cleanroom、复杂整合包转换与 Java 下载

- 识别 Minecraft 1.12.2 整合包中的 Cleanroom 配置，安装官方 Cleanroom 服务端并使用其 Forge 模组启动入口；Cleanroom 0.6 系列匹配 Java 25，0.5 系列匹配 Java 21。完整 Forge 版本候选可搜索选择。
- “客户端转服务端”“服务端核心”“开服管理”均可下载 Java 8 / 16 / 17 / 21 / 25。从 Eclipse Temurin 官方来源下载 Windows 64 位运行时，检查 SHA-256、文件长度、实际版本和位数；显示真实下载与解压进度，支持中止、复用及随服务端打包。
- CurseForge 导出包按清单的项目 ID / 文件 ID 补齐原版本，校验 SHA-1，缓存可复用。优先使用设置中的 CurseForge API Key；未配置时通过 curse.tools 公共服务查询元数据，文件从返回的作者下载地址获取。禁止自动下载的文件会明确报错，可在启动器安装后选择实例目录转换。Modrinth 下载同样校验哈希、显示已传输字节，损坏镜像可尝试备用地址。
- 修复旧 Forge 注解、一个 JAR 多个模组 ID、内嵌依赖和核心插件识别，保护服务端必需依赖；不再把 JEI、地图、信息显示等具有服务端能力的模组一概移除。缺失依赖阻止生成不完整服务端。
- 对已验证的 Elemental End 字节码修复错误服务端代理；同时处理 Bansoukou 补丁重注入、纯客户端提示脚本和 Cleanroom 0.6 下 Dynamic Surroundings 3.6.1.0 停服崩溃。兼容修复受版本、字节码或脚本内容限制，不按整合包名称盲目删除玩法模组。
- 允许设置内存、Java、随包运行时及 Default World Generator 世界预设；未设置预设时，开服控制台提示需要输入世界类型。生成包附带转换报告，列出移除项、保留依赖、兼容修复和验证边界。
- ZIP 输入上限 4 GiB，单条目上限 512 MiB，解压总量上限 8 GiB；打包逐文件写出，避免把整个输出压缩包保留在内存中。暂不支持 ZIP64，生成 ZIP 限 65,534 个文件及 4 GiB。

真实验证见 [GreedyCraft 2.8.5 服务端验证记录](docs/validation-greedycraft-2.8.5.md)：531 个原始模组 JAR，剔除 50 个客户端或不兼容的可选模组，保留 481 个；实际运行加载器报告 535 个模组 ID，完成建世界、重启、状态查询、保存和正常停服。尚未进行客户端登录及全部玩法验收。

### v1.5.1 开服导入与官方服务端适配

- 服务端 ZIP / `.mrpack` / JAR 现在先暂存，用户可以先选择解压位置，再点击“开始识别并导入”；拖入服务端包不会立即上传、解压或创建目录。
- 页面拦截磁贴外的文件拖放默认行为，拖到其他位置不会再触发浏览器打开、下载或替换页面。
- 识别 `run-windows.bat`、`run-linux.sh` 等官方命名脚本，并从字面参数识别 Forge / NeoForge 版本、核心文件、Java 参数和内存设置。官方包没有核心时会显示“脚本引用的核心”，要求用户选择或安装对应核心，不再误报为完全无法识别。

### v1.5.0 开服管理与转换更新

- 新增独立“开服管理”磁贴：拖入 ZIP / .mrpack / 核心 JAR 或选择已有目录，自动识别后先显示配置，点击启动才运行；压缩包解压到独立新目录，支持导入进度与中止。
- 通用识别 Vanilla、旧 Forge、新 Forge / NeoForge 参数文件、Fabric、Quilt、Paper、Purpur、Spigot；多核心时支持明确选择，也可以指定其他核心 JAR。未知版本提示手动填写，不把安装器当核心运行。标准启动脚本里的字面 JVM 参数会保留；含变量或复杂脚本逻辑时提示核对，不自动执行未知脚本。
- 开服磁贴可调整初始 / 最大内存、选择 Java、保留原包参数、选择 G1 预设或追加自定义 JVM 参数，并设置端口、监听 IP、玩家数、正版验证及服务端附加参数。优先检测随包运行时，参数传入真实 Java 进程。
- 提供实际启动日志、控制台命令、正常停服、强制停止、会话切换、配置记忆、端口占用和重复开服检查。启动进度未知时显示处理中，不伪造百分比；收到核心 Done 日志后才显示运行中。
- 首次开服需用户自行阅读并确认 Minecraft EULA。修改已有 server.properties 前保留一次备份。关闭工具箱会发送 stop 并等待最多 45 秒，超时后终止进程；重要世界请先正常停服。


- 选择客户端目录、ZIP 或拖入文件后立即识别并回填 MC / 加载器 / 加载器版本。ZIP 通过分片读取清单，不先解压整个包。字段说明独立显示，窄磁贴内可换行。
- 加载器版本改为明确必填（原版不适用），在线候选不会覆盖已识别的历史版本；可以手动输入准确版本，修改 MC 或加载器后清除旧版本。
- 新增初始内存、最大内存和 Java 选择。默认初始 1 GB，最大内存按模组数量和体积给出 4 / 6 / 8 GB 建议，不根据整合包名称特调；用户可覆盖建议，建议不是开服最低内存保证。
- 自动在本机查找兼容的 64 位 Java，旧版 Forge 1.12.2 使用 Java 8，不再误用 PATH 中的 Java 21；找不到时明确提示。安装器使用选定 Java，生成的脚本也在每次启动前检查大版本。
- 支持随服务端包携带本机 Java（可取消勾选），按复制字节数显示进度，保留发行者许可文件。Windows 运行时只适用于 Windows；Linux/macOS 需相应系统的运行时。本功能面向 Java 版服务端，不支持基岩版原生可执行服务端。Windows 启动配置位于 `server-launch.json`，Unix 的内存参数位于 `start.sh`，可在生成后继续调整。
- 新旧 Forge 的启动方式都应用内存设置；新版 Forge 优先使用安装器的参数文件。此更新解决 Java 兼容和启动参数问题，不保证复杂整合包所有模组、脚本、依赖与世界均通过开服测试。

### v1.4.4 转换更新

- 识别 HMCL `manifest.json` 的 `addons`、嵌套清单、PCL/HMCL 版本 JSON、MultiMC/Prism 实例组件和 Forge 启动脚本。部分手动填写项与识别结果合并；发现多个实例时提示选择具体目录。
- 转换过程中可点击“中止转换”：上传断开，后台复制、解压、扫描、下载、安装器和打包可中止；等待清理结束后恢复操作。
- 拖入文件时显示上传阶段的真实百分比与字节数；等待服务器回应时显示处理中。后续转换阶段独立显示，不把未知进度伪装成 0%。上传改为流式写盘。
- 当前 ZIP 上限已在 v1.6.0 提升到 4 GiB，超过时请先解压并选择实例文件夹；ZIP64 暂不支持。对于有对应版本官方服务端包的深度整合包，优先使用官方模组、配置和依赖。成功识别并安装核心不代表已完成全部 mod 的开服兼容性验证。

磁贴式、可插拔的 Minecraft 服务器/客户端工具集。零第三方依赖（只用 Node 内置模块），双击 `start.bat` 即用。

工具箱作者：**Rinkore28**。主界面右下角保留低透明度作者水印；集成组件的原作者和许可证仍归各自项目所有。

发布版启动时校验内嵌 SHA-256 清单中的应用界面资源（`index.html`、`css/`、`js/`）及作者标识；删除或改动这些缓存文件会停止启动并显示错误。校验清单嵌入 EXE，不依赖可替换的外置清单。用户配置、整合包、翻译内容和功能插件不受此校验限制；源码开发模式不启用校验。损坏后可关闭工具箱，清除 `%LOCALAPPDATA%\MC Toolbox\runtime\public` 缓存，再启动从官方仓库下载的完整 EXE 重新解压。此机制用于检测资源篡改，不是代码签名或不可绕过的防破解机制，也不修改第三方依赖的作者信息。

## 运行

### 方式 A：单文件可执行（推荐）

构建后 `dist\mc-toolbox.exe` 是完全自包含的桌面应用（约 83 MB）。**双击即可启动，无需安装 Node / 任何第三方依赖**。

启动时会自动检测本机的 **Microsoft Edge / Google Chrome**，并在「无浏览器窗口」模式（`--app=URL`）打开应用窗口——外观就是一个独立的桌面应用窗口，**没有浏览器标签页、地址栏、收藏夹等浏览器 UI**。关闭该窗口会自动停止服务。

> **无控制台黑框**：构建后的 `mc-toolbox.exe` 已被标记为 Windows GUI 子系统，双击启动时**不会弹出黑色的命令行窗口**，只有应用窗口。如需排查问题或看日志，可用 `--console` 强制保留控制台：`mc-toolbox.exe --console`。

命令行参数（也支持 `start.bat mc-toolbox.exe -- --no-open` 透传）：

| 参数 | 作用 |
|------|------|
| `--no-open` / `--no-app` | 不自动启动应用窗口，仅在控制台运行服务（调试 / 服务器场景） |
| `--port=N` | 指定端口（默认 8756） |

如果本机没有 Edge / Chrome，会在控制台提示本地地址，可手动用任意浏览器打开。

> **单例说明**：每个 `mc-toolbox.exe` 固定使用端口 8756（可用 `--port=` 改）。如果该端口已被占用（通常是因为已经有一个窗口在运行），再次双击 exe 会直接提示「端口 8756 已被占用」并退出，不会重复打开多个窗口。如需多开，请显式指定不同端口：`mc-toolbox.exe --port=9000`。

### 方式 B：开发模式

```
start.bat                  :: Windows 双击（自动判断 exe 或 dev 模式）
node server.js             :: 手动启动 dev，默认 http://127.0.0.1:8756
node server.js --port=9000 --no-open
```

dev 模式同样会在 Edge/Chrome 可用时以无浏览器窗口模式启动。

### 整合包翻译运行环境

工具箱内置 [mc-i18n](https://github.com/WJ1752/mc-i18n) 翻译工作台，并通过「整合包翻译」磁贴统一启动和管理。开发模式需要 **Python 3.10+**，首次启动时工具箱会在本机启动一个临时本地端口，再通过内嵌工作台提供完整功能。关闭工具箱时翻译进程会一起退出。

发布单文件版本时，构建脚本会把 `vendor/mc-i18n` 的源码一并打包。目标电脑如果没有 Python，可先准备 `vendor/mc-i18n/dist/mc-i18n.exe`（或 `vendor/mc-i18n/mc-i18n.exe`）再执行构建；工具箱会优先使用该 EXE。没有 EXE 时，单文件版本仍需要目标电脑安装 Python 3.10+。

翻译项目的扫描结果、译文、日志、术语表和资源包都保存在用户选择的整合包目录下的 `.mc-i18n/`，工具箱不会把项目文件复制到自己的配置目录。

## 打包成单文件可执行（可选，推荐分发）

```bash
node build.mjs
```

产出 `dist/mc-toolbox.exe`（约 83 MB）。**双击即可启动，无需安装 Node.js**。

发布版首次运行把配置与运行时放在用户目录；第一次进入启动器时会让你选择游戏目录，默认在 EXE 同级创建 `.minecraft`（和 PCL / HMCL 一致，之后可在「设置 → 游戏目录」更换）：

```
%LOCALAPPDATA%/MC Toolbox/data/        用户数据（监测历史、磁贴布局）
%LOCALAPPDATA%/MC Toolbox/runtime/     界面、翻译运行时和下载的 Java
文档/MC Toolbox/config/               设置及配置
文档/MC Toolbox/client-mods/          客户端模组库
<EXE 所在目录>/.minecraft/            游戏文件（versions / libraries / assets / instances）
```

升级后按内嵌版本自动更新界面缓存。源码开发模式使用项目内的 data / runtime / public 目录。

构建步骤：

1. esbuild 把 `src/server/*` 打成 CJS bundle（Node 22 SEA 入口强制 CJS）
2. 系统 tar 把 `public/` 内容打成 `tar.gz` 内嵌为 SEA asset
3. `node --experimental-sea-config` 生成 SEA 二进制
4. postject 把 blob 注入到 `node.exe` 副本
5. 冒烟测试：启动产物 → 验证 `/api/bootstrap` + 首页能正常返回

技术细节：见 `build.mjs` 内注释、`src/server/paths.js` 的 SEA 兼容层。

发布到 GitHub（启动器「一键更新」依赖 Release 资产与更新说明）的固定流程见 [发布流程](docs/release.md)：定版本号 → 写 README 更新日志 → 跑测试与构建 → 提交推送 → `gh release create` 上传 `mc-toolbox.exe` → 用旧版检查更新自检。

数据全部存放在 `data/` 目录（settings.json / monitors.json / clientmods.json / history.json），删掉即恢复初始状态。

## 架构

```
server.js                  启动入口：静态服务 + API + 监测引擎
src/server/
  api.js                   REST 路由 + 静态资源
  features.js              扫描 public/features/*/manifest.json → 功能注册表
  mc-ping.js               Java 版 TCP Server List Ping + 基岩版 UDP RakNet Ping + SRV
  monitor.js               多服务器轮询引擎、历史环形缓冲、统计
  zip.js                   最小 ZIP 读取器（读 jar 内的 mod 元数据）
  mods.js                  mod 扫描（fabric/quilt/forge/旧版）+ 备份/删除
  store.js / defaults.js   JSON 存储与默认配置
public/
  index.html               外壳：顶栏 / 磁贴网格 / 设置页 / 弹窗
  js/core/                 grid(拖拽) chart canvas modal toast dirpicker settings bus api dom
  features/<id>/           每个功能一个目录：manifest.json + tile.js
```

**功能之间完全解耦**：每个功能只依赖 `public/js/core/*` 提供的 SDK，后端只提供通用 API。删掉任一 `features/<id>` 目录，其它功能照常工作。

## 已有功能

| 功能 | 说明 |
| --- | --- |
| 功能 | 说明 |
| --- | --- |
| `server-status` | 单个服务器在线测试：Java/基岩自动识别，延迟、版本、玩家、MOTD、图标、原始 JSON，可一键加入监测 |
| `latency-monitor` | 多服务器持续监测：每台服务器是一张可拖动的小磁贴，点击放大看折线图、在线率、丢包、逐次日志 |
| `client2server` | 客户端转服务端：支持扫描深层 mods 目录，也可拖入 ZIP / `.mrpack` 或选择客户端整合包文件夹，自动移除仅客户端 mod 并生成新的服务端 ZIP；原包不改写，可选择输出目录 |
| `community-download` | 社区资源下载：Modrinth / CurseForge 搜索并下载 mod、整合包、数据包、资源包、光影；支持多线程、限速、自定义命名规则 |
| `server-core` | 服务端核心下载：选 MC 版本 + 加载器（官方 / Fabric / Forge / NeoForge / Quilt / Paper）。官方/Paper 直接下载核心；Fabric/Forge/NeoForge/Quilt 下载官方安装器并自动运行，把服务端装到指定目录（生成 run.bat/launch.jar） |
| `i18n` | 整合包翻译：复用 mc-i18n 的语言文件扫描、批量翻译、实时进度、任务书、术语表、校对台、质量检查和汉化资源包打包工作台 |
| `save-editor` | 存档编辑器：解析 level.dat / playerdata（纯手写 NBT 编解码，Long 全程 BigInt 保精度），编辑世界名称、游戏模式、难度、出生点、游戏时间、天气、边界，以及玩家的生命/生命上限/饥饿/经验/坐标/朝向/飞行/无敌；每次保存自动备份原文件（保留最近 10 份）。并含**图形化区块编辑**：.mca 区域文件浏览、区块 16×16 俯视彩色地图（顶层方块渲染 + 点选拾取）、按调色板批量替换方块（自动处理位压缩重编码与调色板扩容，.mca 自动备份）；支持**按世界坐标操作**：查询单点方块、单点设置、长方体范围替换（等效 /fill，可留空原方块=全部替换，Y 轴自动裁剪，跨区块自动分组迁移）、按区块坐标跳转 |

## 磁贴

- 拖动磁贴标题栏即可排序，顺序自动保存（`settings.layout`）
- 标题栏 `▾` 折叠为「仅图标 + 标题」（默认初始状态，设置里可改），`⤢` 放大查看、`⋯` 折叠或隐藏；顶栏「全部折叠 / 全部展开」一键切换
- 磁贴尺寸由功能自己的 `manifest.json` 里的 `size` 决定，界面不提供手动改尺寸；在多列时大尺寸会跨列，单列时所有磁贴占满整行
- 设置 → 通用：可调整「每行磁贴数」（默认 1，即一行一个）
- 设置 → 网络：可配置「下载代理」（http:// 或 socks5://），作用于社区资源下载、服务端核心下载及其安装器联网
- 顶栏「＋ 添加磁贴」随时把隐藏/新装的功能放回页面
- 设置 → 功能与磁贴：启用/禁用、显示/隐藏、删除非内置功能、重置布局

## 新增一个功能（不需要改任何已有代码）

在 `public/features/` 下新建目录，例如 `public/features/my-tool/`：

**manifest.json**
```json
{
  "id": "my-tool",
  "name": "我的工具",
  "desc": "一句话说明",
  "icon": "🔧",
  "color": "#3ba0ff",
  "version": "1.0.0",
  "size": { "w": 1, "h": 1 },
  "builtin": false,
  "entry": "tile.js"
}
```

**tile.js**
```js
import { h } from '/js/core/dom.js'

export default {
  async mount(ctx) {
    // ctx.body        磁贴内容容器
    // ctx.settings()  当前设置（只读快照）
    // ctx.setBadge(t) 标题栏徽章
    // ctx.api         后端 API 封装
    // ctx.toast(msg)  提示
    // ctx.openModal() 弹窗
    // ctx.bus         功能间可选事件总线
    ctx.body.appendChild(h('div', {}, 'Hello Minecraft'))
  },
  renderExpanded(container) { /* 可选：⤢ 放大视图 */ },
  unmount() { /* 可选：清理定时器 */ }
}
```

然后在页面点「↻ 重载」或设置里「重新扫描」。需要后端能力时，在 `src/server/api.js` 里加一条 `on('GET', '/api/xxx', ...)` 即可。

## 常用 API

```
GET    /api/bootstrap                 设置 + 功能列表
GET/PUT /api/settings                 设置读写（深层合并）
GET    /api/features                  功能列表
PUT    /api/features/:id              启用/显示
POST   /api/ping                      单次探测 {host, port, type}
GET    /api/monitors                  监测快照（含状态、统计、历史）
POST   /api/monitors                  新增监测项
POST   /api/monitors/reorder          磁贴排序
POST   /api/monitors/:id/check        立即检测
GET/POST/PUT/DELETE /api/mods/client-list   仅客户端 modid 库
POST   /api/mods/scan                 扫描 mods 目录
POST   /api/mods/apply                移入备份 / 删除 / 禁用 / 启用
POST   /api/mods/convert              目录或本地 ZIP / .mrpack 转服务端 ZIP
POST   /api/mods/convert-upload       拖入压缩包上传并转服务端 ZIP
GET    /api/servercore/loaders       支持的加载器列表
GET    /api/servercore/gameversions   MC release 版本列表
GET    /api/servercore/loaderversions 指定加载器+MC版本的可用版本
POST   /api/servercore/download       下载服务端核心（安装器类下载后自动安装到目标目录）
GET    /api/i18n/status                翻译引擎状态
POST   /api/i18n/start                 启动翻译工作台子进程
POST   /api/i18n/stop                  停止翻译工作台子进程
GET    /api/fs/roots                  盘符/根目录 + home + presets + specials(桌面/下载/文档) + cwd
GET    /api/fs/list?path=             目录浏览（返回 parent、dirs、files、presets）
POST   /api/fs/mkdir                  新建文件夹
GET    /api/saveeditor/presets       默认 .minecraft 候选目录
GET    /api/saveeditor/worlds?mcDir= 列出 saves 下的世界（解析 level.dat）
GET    /api/saveeditor/world?world=  世界可编辑字段 + 玩家清单
GET    /api/saveeditor/player        玩家数据详情（level 或 playerdata/*.dat）
GET    /api/saveeditor/regions       世界的区域文件（.mca）列表
GET    /api/saveeditor/region        区块存在位图（32×32）
GET    /api/saveeditor/chunk         区块俯视图数据（每列顶层方块）
POST   /api/saveeditor/chunk/replace 区块内批量替换方块（自动备份 .mca）
POST   /api/saveeditor/block         查询世界坐标处方块
POST   /api/saveeditor/block/set     设置世界坐标处方块
POST   /api/saveeditor/box/plan      长方体范围 → 受影响区块计划
POST   /api/saveeditor/box/apply     在单个区块内应用长方体替换
POST   /api/saveeditor/level         写世界属性（每次自动备份）
POST   /api/saveeditor/player        写玩家数据（每次自动备份）
GET    /api/dirs                     存储目录（当前/默认/是否自定义）
POST   /api/dirs/change             更改目录并完整迁移文件
POST   /api/dirs/reset              恢复默认目录（文件迁回）
GET    /api/data/export               导出配置

# 好友（中心服务器，详见 docs/friends-server.md）
POST   /api/friends/server/probe     探测服务器并返回证书指纹
PUT    /api/friends/server           保存服务器地址与指纹
POST   /api/friends/login            用启动器当前正版微软账户登录
POST   /api/friends/add              按正版游戏 ID 发好友请求
GET/POST /api/friends/:uuid/messages 聊天记录 / 发送消息
POST   /api/friends/packs/share      导出整合包并上传给好友
POST   /api/friends/mods/compare     对比双方模组清单（fill / send 为补齐与直传）
POST   /api/friends/transfers/:id/download 下载好友发来的文件

# 启动器（详见 docs/launcher.md）
GET    /api/launcher/bootstrap        启动器设置、实例、账户、任务、会话（含进程检测结果）
GET    /api/launcher/running          当前运行的实例（?force=1 强制重新扫描进程表）
GET/PUT /api/launcher/settings        启动器设置
GET    /api/launcher/update/check     检查 GitHub Releases 是否有新版本（?force=1 绕过缓存）
POST   /api/launcher/update/download  下载新版本 exe（立即返回，进度看 state）
GET    /api/launcher/update/state     下载进度与是否可一键替换
POST   /api/launcher/update/apply     替换当前 exe 并重启（仅 Windows 打包版）
POST   /api/launcher/update/skip      忽略某个版本
GET/PUT /api/launcher/update/config   更新源（仓库 / Token / 预发布 / 忽略版本）
GET    /api/launcher/instances        实例列表
GET/PUT/DELETE /api/launcher/instances/:id   实例详情 / 修改 / 删除
POST   /api/launcher/instances/:id/launch    启动游戏（立即返回，准备阶段轮询 status.launch）
POST   /api/launcher/instances/:id/launch/cancel 取消启动准备
POST   /api/launcher/instances/:id/stop      停止游戏（外部接管的进程先请求正常关闭，8 秒后强制）
GET    /api/launcher/instances/:id/status    运行状态 + 启动阶段/错误（launch）
GET    /api/launcher/instances/:id/preview   启动命令预览（令牌脱敏）
GET    /api/launcher/instances/:id/log       实时/已保存日志
GET    /api/launcher/instances/:id/content   模组/资源包/光影/世界/截图/服务器/日志/崩溃
POST   /api/launcher/instances/:id/upload    导入 JAR / 资源包（原始字节）
POST   /api/launcher/instances/:id/servers   增删改 servers.dat
GET    /api/launcher/versions         Mojang 版本清单（正式版/快照）
GET    /api/launcher/loaders/:loader/versions 加载器版本候选
POST   /api/launcher/install          创建安装任务
GET    /api/launcher/jobs             安装/整合包任务
POST   /api/launcher/packs/install    安装本地 .mrpack / CurseForge ZIP / 本工具导出的 ZIP
POST   /api/launcher/packs/install-online 搜索下载的整合包一键安装
POST   /api/launcher/instances/:id/export 导出实例为 .mrpack / 通用 .zip
GET    /api/launcher/exports          导出任务列表
GET    /api/launcher/exports/:id      导出任务详情与增量日志
POST   /api/launcher/exports/:id/cancel 取消导出
GET    /api/launcher/java             扫描本机 Java
GET/POST /api/launcher/accounts       账户列表 / 添加离线账户
POST   /api/launcher/accounts/ms/start|poll 微软设备码登录
POST   /api/launcher/accounts/authlib 第三方 authlib-injector 登录
GET    /api/launcher/import/scan      扫描本机 .minecraft / PCL / HMCL 版本
POST   /api/launcher/import           导入已有版本（引用原目录）
GET    /api/launcher/news             Mojang 版本动态

# 社区资源（版本参数校验）
GET    /api/community/search          搜索项目；返回 gameVersionRequested/Applied/Notice
GET    /api/community/versions        项目版本；withMeta=1 返回 items + 版本提示
GET    /api/community/project         项目详情
POST   /api/community/download        下载单个文件到下载中心
GET    /api/community/jobs            社区下载任务
```
