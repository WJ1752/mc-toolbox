# 本地功能示例

在本地工作区运行以下命令，以示例成员身份打开启动器和临时好友服务。服务仅监听本机，关闭后再运行可重建示例群。要体验群主发布流程，在命令后添加 `--owner`。

```powershell
node tools/group-profile-demo.mjs
```

本次工作区已安装「工具箱联机示例 · 服主」和「工具箱联机示例 · 成员」，均使用 Minecraft 1.20.1 和 Fabric Loader 0.16.14。成员实例保留了旧版 Mod，适合按以下顺序体验。

1. **更新后撤销。** 选成员实例，打开「模组 → 检查更新 → 全部更新」。预览里可勾选 Fabric API 和 Mod Menu。完成后打开「更新记录 → 撤销这次更新」，Fabric API 恢复 0.92.11，Mod Menu 恢复 7.2.1 并继续禁用。只保留最近成功的一批。
2. **用群配置补齐。** 进入「好友 → 群聊 → 周末生存示例群 → 入服 · 周末服 1.0」，选择成员实例。Fabric API 0.92.12 显示「待替换」，Mod Menu 7.2.2 显示「可选」。点击「补齐必装模组」，检查结果会变为就绪，可选模组保留原状。示例中的游戏地址为 `127.0.0.1:25565`。实际进服时需在该地址运行游戏服务器；群主也可以将其改为自己的服址。正式好友服务器需要运行新版服务脚本。[示例配置](group-profile.json)
3. **迁移一个独立副本。** 从侧栏进入「导入已有游戏」，选择本工作区的 `data/examples/Prism-Fabric-1.20.1`，依次点击「扫描实例」「预估空间」「复制并安装」。这个源目录包含两个真实 Mod 和一份游戏设置；修改新实例不会改动它。在新克隆的仓库中，可改选 `examples/prism-fabric` 体验基础迁移。空间预估针对复制内容，首次安装的游戏运行库和资源另外下载。[Prism 示例清单](prism-fabric/mmc-pack.json)

本地验收使用了 Modrinth 上的 [Fabric API 0.92.11](https://modrinth.com/mod/fabric-api/version/xhLT3C5f)、[0.92.12](https://modrinth.com/mod/fabric-api/version/rvI2dfzR)、[Mod Menu 7.2.1](https://modrinth.com/mod/modmenu/version/eTCL1uh8) 和 [7.2.2](https://modrinth.com/mod/modmenu/version/lEkperf6)。普通玩家使用启动器自己的游戏账户启动游戏；示例群身份只用于本地好友服务。
