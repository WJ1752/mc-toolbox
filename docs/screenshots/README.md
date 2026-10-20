# 截图索引

视口 1440×900（错误态与空态同）。`dark/` 与 `light/` 各 24 张，覆盖验收清单要求的全部界面。

| 文件 | 内容 |
| --- | --- |
| `01-workspace-collapsed.png` | 工作台总览：8 个磁贴全部折叠、Rail 快捷入口、工具条、状态栏 |
| `02-server-status.png` | 服务器在线测试：地址/端口/类型/快捷条/空结果 |
| `03-latency-monitor.png` | 延迟监测：3 台仪表卡（在线/离线/丢包）、批量指标 |
| `04-client2server.png` | 客户端转服务端：清理模式四段式 + mod 库入口 |
| `05-community-download.png` | 社区资源下载：搜索区、类型筛选、下载目录、任务区 |
| `06-server-core.png` | 服务端核心下载：三步流程 + 任务区 |
| `07-i18n.png` | 整合包翻译：引擎控制台（未启动） |
| `08-save-editor.png` | 存档编辑器：世界列表 + 世界/玩家/区块页签 |
| `09-server-manager.png` | 开服管理：状态条、控制台、命令、导入向导、配置入口 |
| `10-settings-general.png` … `19-settings-about.png` | 设置的 10 个分区：通用、网络、延迟监测、客户端转服务端、社区资源、服务端核心、整合包翻译、功能与磁贴、数据管理、关于 |
| `20-command-palette.png` | `Ctrl/Cmd+K` 命令面板 |
| `21-task-drawer.png` | 右侧任务抽屉 |
| `22-add-tile.png` | 添加磁贴弹窗 |
| `23-empty-workspace.png` | 工作台空态 |
| `24-tile-error.png` | 功能模块加载失败：卡片内错误 + 重试（通过阻断 `tile.js` 请求复现） |

额外的 1024×680 与 1920×1080 布局检查在 `docs/frontend-parity.md` 第 12 节记录，未单独存档。

生成方式（开发机 headless Edge，零依赖 CDP）：

```bash
node server.js --port=8757 --no-open
node tools/gallery.mjs --url http://127.0.0.1:8757 --theme dark  --outdir docs/screenshots/dark
node tools/gallery.mjs --url http://127.0.0.1:8757 --theme light --outdir docs/screenshots/light
```
