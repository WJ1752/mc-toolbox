# 发布流程（GitHub Releases）

启动器的「一键更新」完全依赖 GitHub Releases：启动时读取 `/repos/:owner/:repo/releases`，挑版本号最高的非草稿发布，下载资产里的 `mc-toolbox.exe`，校验 `size` 与 `sha256` digest 后由独立脚本替换自身。**所以每次用户可见的改动都要推送并发布 Release，否则更新检查看不到、用户无法升级。**

发布仓库：`WJ1752/mc-toolbox`（`src/server/launcher/app-update.js` 的 `DEFAULT_REPO`）。

## 每次更新的固定步骤

1. **定版本号**：`package.json` 与 `src/server/build-meta.js` 的 `PRODUCT_VERSION` 同时修改。
   - 修复用补丁号（1.9.6 → 1.9.7），功能用次版本号；tag 统一加 `v` 前缀（`v1.9.7`）。
2. **写更新日志（用户视角）**：
   - `README.md` 顶部新增 `### vX.Y.Z 标题` 段落，按「修复 / 功能 / 回归」分行写，1–2 句一条；
   - GitHub Release 说明用同一份内容（用户在更新弹窗里看到的就是它）。
   - 更新弹窗按**纯文本**逐行渲染（不解析 Markdown / HTML），说明里避免表格、嵌套列表和 HTML；每行尽量短。
3. **回归与构建**：
   ```bash
   node --test tests/*.test.mjs
   node build.mjs
   ```
   构建会重新生成 `dist/mc-toolbox.exe` 并做隔离冒烟（启动、首页、功能列表、作者信息、完整性校验）。确认 `dist/` 里的版本号是本次版本。
4. **提交并推送**：
   ```bash
   git add README.md docs package.json src tests
   git commit -m "fix(vX.Y.Z): 一句话说明"
   git push origin main
   ```
   提交信息沿用现有风格：修复 `fix(vX.Y.Z): …`，功能 `feat(vX.Y.Z): …`，正文写清根因/影响。
5. **创建 GitHub Release**（资产名必须是 `mc-toolbox.exe` 或以 `.exe` 结尾，否则更新检查会提示「发布里没有可执行文件」）：
   ```bash
   gh release create vX.Y.Z dist/mc-toolbox.exe \
     --title "vX.Y.Z 一句话标题" \
     --notes-file release-notes.md
   ```
   `release-notes.md` 内容 = README 里对应段落（可加一行「升级方式」）。也可以在 GitHub 网页创建：tag 填 `vX.Y.Z`，上传 `dist/mc-toolbox.exe`，说明填更新日志。
6. **发布后自检**：
   - `gh release view vX.Y.Z --json tagName,publishedAt,assets` 确认是正式发布（不是 draft）且资产带 `.exe`；
   - 旧版启动器「设置 → 启动器 → 更新 → 检查更新」应出现新版本卡片，点「下载并更新」后 `/api/bootstrap` 的 `version` 变为新版本。

## 规则与坑

- **草稿不参与更新**：`pickRelease` 过滤 `draft`；预发布只有在用户勾选「接受预发布」时才会被选中。正式发布千万别留在 draft。
- **版本号必须可解析**：`v1.9.7`、`1.9.7-rc.1` 可以；`v1.9.7+build` 会被当成预发布/无法比较，避免使用。
- **资产优先 `mc-toolbox.exe`**：其次任何 `.exe`；上传 `.zip` 不会被识别。
- **GitHub API 限额**：匿名 60 次/小时；私有仓库或频繁检查需在设置里填 Token（只保存在本机，不回显）。
- **发布说明就是更新弹窗内容**：改完 Release 说明，用户下次检查更新时看到的就是新文本；不需要重新发版。
- 更新本身只结束启动器进程，不会关闭正在运行的游戏（游戏进程 `detached` 启动，见 `docs/launcher.md` §4.3 / §6.11）。

## 需要手动更新的文件

| 文件 | 内容 |
| --- | --- |
| `package.json` | `version` |
| `src/server/build-meta.js` | `PRODUCT_VERSION` |
| `README.md` | 顶部 `### vX.Y.Z …` 更新日志 |
| GitHub Release | 标题、说明、`mc-toolbox.exe` 资产 |
| `docs/launcher.md` | 有行为/接口变化时补充验证记录 |
