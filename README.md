# Minecraft 工具箱

磁贴式、可插拔的 Minecraft 服务器/客户端工具集。零第三方依赖（只用 Node 内置模块），双击 `start.bat` 即用。

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

首次运行会在 exe 所在目录创建：

```
data/                      用户数据（设置、监测历史、磁贴布局）
runtime/public/            从内嵌资源解压出来的前端静态（首次启动写入一次，带版本戳）
```

升级到新版时把旧 `runtime/public/` 删掉，会自动重新解压。

构建步骤：

1. esbuild 把 `src/server/*` 打成 CJS bundle（Node 22 SEA 入口强制 CJS）
2. 系统 tar 把 `public/` 内容打成 `tar.gz` 内嵌为 SEA asset
3. `node --experimental-sea-config` 生成 SEA 二进制
4. postject 把 blob 注入到 `node.exe` 副本
5. 冒烟测试：启动产物 → 验证 `/api/bootstrap` + 首页能正常返回

技术细节：见 `build.mjs` 内注释、`src/server/paths.js` 的 SEA 兼容层。

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
```
