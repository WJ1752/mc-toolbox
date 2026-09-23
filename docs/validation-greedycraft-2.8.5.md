# GreedyCraft 2.8.5 / Cleanroom 服务端验证记录

验证日期：2026-09-23。工具箱版本：1.6.0。

## 输入与运行环境

| 项目 | 本次使用的版本或设置 |
| --- | --- |
| 原始安装包 | GreedyCraft2-2.8.5-build(dev)-ae12006ad.zip |
| Minecraft | 1.12.2 |
| 加载器 | Cleanroom 0.6.13-alpha |
| Java | Eclipse Temurin 25.0.4.1+1，Windows x64 |
| 内存 | 初始 2 GB，最大 12 GB；不是仅分配 2 GB |
| 世界 | 原包“默认世界设置（BoP）”预设 |
| 测试监听 | 127.0.0.1:25579，仅本机验证 |

Cleanroom 是面向 Minecraft 1.12.2 的 Forge 分支，支持在较新 Java 上运行旧版模组。它不是 Java 本身，也不是原版服务端核心。官方 0.6 系列需要 Java 25，0.5 系列需要 Java 21；普通 Forge 1.12.2 则仍匹配 Java 8。加载器兼容性应以具体版本和模组为准。

参考：[Cleanroom 源码和说明](https://github.com/CleanroomMC/Cleanroom)、[0.6.13-alpha 发布页](https://github.com/CleanroomMC/Cleanroom/releases/tag/0.6.13-alpha)、[Eclipse Adoptium](https://adoptium.net/)。

## 转换结果及关键修复

原包提供 92 个覆盖目录 JAR，CurseForge 清单另外提供 439 个固定文件版本。共扫描 531 个 JAR，移除 50 个客户端或具有已知停服兼容问题的可选模组，保留 481 个。运行时加载器报告 **535 个模组 ID**；JAR 与模组 ID 不是一一对应关系。

1. 完整补齐并校验清单文件，避免把启动器导出包中的少量 overrides 误当成全部模组。
2. 识别一个 JAR 中多个模组 ID、旧 Forge 注解、内嵌依赖、独立核心插件与各自版本，保护被其他模组依赖的库。
3. 使用 Cleanroom 官方安装器与生成的 `cleanroom-0.6.13-alpha.jar` 启动。入口使用 `-jar`，加载 Forge 模组；没有改用只启动原版的入口。
4. 已核对字节码的 Elemental End 1.0.0 引用了不存在的 ServerProxy，改为其现有的 CommonProxy，同时修复会覆盖原 JAR 的 Bansoukou 补丁。
5. 删除对应已剔除客户端模组的 Bansoukou 补丁，防止客户端代码被重新注入。
6. Dynamic Surroundings 3.6.1.0 在此 Cleanroom 0.6 环境下正常停服时崩溃，服务端移除此可选环境效果模组。规则限于该版本组合，客户端不变。
7. 纯界面提示脚本添加 CraftTweaker `#sideonly client` 标记。原脚本内容保留，含配方等玩法逻辑的脚本不采用此规则。

具体修改、文件校验值、剔除原因和依赖提示保存在生成包内的 `toolbox-conversion-report.json`。通用转换过程检查依赖与核心安装，**不会自动替每一个包完成世界加载和玩家联机验收**；本记录是另行执行的真实启动测试。

## 已完成验证

- 从原始 ZIP 通过工具箱生产转换函数生成服务端，再进行实际 Java 启动。
- 完成首次世界生成，日志出现 `Done (...)!`。
- 保存并正常停止后再次启动；再次达到 `Done (...)!`。
- 执行 `list`，收到在线玩家列表响应；执行 `save-all`，完成存档保存。
- Minecraft 状态协议查询分别使用 -1、340、47，三次均成功，返回 535 个模组 ID。
- 发出 `stop`，保存世界并正常结束 Java，进程退出码 0。
- 随包 Java 25 实际用于启动；生成的 Windows 启动脚本检查也正确解析出相对运行时路径及 `-Xms2G -Xmx12G`。
- 最终干净交付包中的 481 个模组、Cleanroom 核心、Java 可执行文件及客户端提示脚本与实际验证版本逐项校验一致。启动后自动展开的内嵌库和缓存不作为缺失模组。

测试证据摘要（第二次启动）：

```text
[12:33:46] Forge Mod Loader has identified 535 mods to load
[12:35:50] Done (6.584s)! For help, type "help" or "?"
[12:36:11] There are 0/20 players online:
[12:38:20] Stopping server
[12:38:20] Saving chunks for level 'validation-world'/overworld
status ping: -1 OK / 340 OK / 47 OK, each with 535 mod IDs
Java exit code: 0
```

`Done` 括号内时长是核心世界启动阶段的计时，不包含前面的完整模组加载耗时。

## 原包仍有的内容问题与验证边界

- `config/modularmachinery/recipes/fallen_star_platinum.json` 的陨石输出引用 `thermalfoundation:storage@6`。ModularMachinery-Addons 2.0.3 的 `RequirementMeteor.from(String)` 直接按完整字符串查找物品，随后构造默认元数据的 ItemStack，不解析 `@6`，导致这条陨石配方注册失败。不能简单删掉 `@6`，否则可能改变为其他材料。保留原配置，需模组或整合包作者修复支持元数据的催化剂解析；此问题不阻止服务器启动，但该条配方不能宣称可用。
- 一些原版按钮、压力板、活板门进度仍引用被整合包移除的配方，出现非致命警告；另有 ProjectE 物品变体等非致命日志。没有通过删除玩法模组来掩盖这些内容问题。
- 没有完成真实客户端登录、全部任务/配方、维度探索、多人长时间运行或性能压力测试。此包为开发构建，Cleanroom 为 alpha，验证只针对上表中的确定版本。
- 当前转换器不支持 ZIP64。下载 Java 目前支持 Windows x64 / ARM64；本次随包的 x64 Java 不能直接用于 Linux 或 ARM64 主机。

## 使用交付包

1. 将 ZIP 完整解压到一个新目录，或在新版“开服管理”磁贴中选择该 ZIP，设置解压位置，再点击识别并导入。
2. 核对核心为 Cleanroom 0.6.13-alpha、Java 为随包 `runtime/bin/java.exe`、最大内存为 12 GB。按机器余量和人数调整；初始 2 GB 不等于最大只使用 2 GB，系统及客户端也需要内存余量。
3. 阅读并接受 Minecraft EULA 后启动。使用 `start.bat` 首次启动时若要求修改 EULA，按提示处理后再次运行。
4. 等日志出现 `Done` 后再连接。交付包使用默认服务器监听设置，没有带入本机测试端口或测试存档。
5. 正常退出使用“停止”或控制台 `stop`。Windows 启动脚本内存位于 `server-launch.json`，也可以在“开服管理”中调整。

交付包选用世界预设 UUID `98f16d23-cbcb-11ea-ac7b-005056c00008`。转换其他包时没有 Default World Generator 则留空；有该模组且未设置预设时，需要按控制台提示选择世界类型，不应把等待输入误认为卡死。

模组包只在用户本机生成，工具箱 GitHub Release 仅发布工具箱程序和校验文件。
