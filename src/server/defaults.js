// 全局默认设置（前后端共用，前端通过 /api/bootstrap 拉取）
export const DEFAULT_SETTINGS = {
  version: 2,
  general: {
    theme: 'dark',              // dark | light
    accent: '#5ec96a',          // 主题强调色
    tileColumns: 1,             // 每行磁贴数（1 = 一行一个）
    animations: true,           // 磁贴拖拽/展开动画
    confirmDanger: true,        // 危险操作二次确认
    timeFormat: '24h',          // 24h | 12h
    defaultCollapsed: true      // 新磁贴默认折叠为「仅图标+标题」
  },
  network: {
    timeout: 5000,              // 单次探测超时(ms)
    retries: 1,                 // 失败重试次数
    concurrency: 8,             // 并发探测上限
    resolveSrv: true,           // 解析 _minecraft._tcp SRV 记录
    defaultType: 'auto',        // java | bedrock | auto
    javaPort: 25565,
    bedrockPort: 19132,
    proxy: ''                   // 下载器代理，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080（留空直连）
  },
  monitor: {
    defaultInterval: 30,        // 默认轮询间隔(s)
    historyPoints: 720,         // 每个监测保留的历史点数
    offlineAfter: 2,            // 连续失败 N 次判定离线
    latencyWarn: 200,           // 延迟告警阈值(ms)
    autoStart: false,           // 启动后默认不自动监测
    chartRange: 120,            // 展开图默认显示最近 N 个点
    maxTileWidth: 300,          // 被监测服务器磁贴的最大宽度(px)，0 为不限制
    tileHeightMode: 'fixed',    // 磁贴高度策略：fixed 固定 | max 限制最大 | auto 自适应内容
    tileHeight: 100,            // 配合 tileHeightMode 的高度值(px)
    defaultMetric: 'latency'    // 新增监测项磁贴主显示：latency | players | loss
  },
  client2server: {
    modsDir: '',                // 默认 mods 目录
    backupDir: '',              // 移除的 mod 存放目录（默认 <modsDir>/../client-mods-backup）
    defaultAction: 'disable',   // backup | disable | delete（初始默认：禁用=改后缀名，可随时恢复）
    scanSubdir: true,           // 扫描子目录
    includeDisabled: true,      // 包含 .jar.disabled
    scriptPath: '',             // 绑定的启动脚本（.bat / .cmd / .sh）
    autoDetectEnv: true         // 自动识别 fabric/quilt 声明的 environment=client
  },
  community: {
    downloadDir: '',            // 默认下载目录（留空为系统下载文件夹）
    cfApiKey: '',               // CurseForge Eternal API Key（console.curseforge.com 申请）
    defaultSource: 'modrinth',  // modrinth | curseforge
    defaultGameVersion: '',     // 例如 1.20.1
    defaultLoader: '',          // fabric | forge | neoforge | quilt | ''
    pageSize: 20,
    maxConcurrent: 3,           // 同时下载任务数
    threads: 4,                 // 单文件线程数（分段下载，1-8，不支持 Range 时自动降为 1）
    speedLimit: 0,              // 全局限速 KB/s，0 = 不限
    nameRule: '{project}-{version}{ext}',  // 命名规则占位符
    subdirByType: false         // 按资源类型建子目录
  },
  servercore: {
    memory: '2G'                // 生成的启动脚本分配的堆内存（-Xms / -Xmx）
  },
  serverstatus: {
    quicks: [],   // 自定义快捷测试：[{ alias, host, port, type }]
    removed: []   // 已删除的内置快捷 id
  },
  features: {},                 // { featureId: { enabled, visible } }
  layout: []                    // [{ id, w, h }]
}

// 内置「仅客户端 mod」库（按 modid 匹配），用户可在 GUI 中增删
// 格式: [modid, 显示名, 备注]
const SEED = [
  // ===== 渲染 / 性能优化 =====
  ['sodium', 'Sodium', '渲染优化，服务端不需要'],
  ['rubidium', 'Rubidium', 'Sodium 的 Forge 移植'],
  ['iris', 'Iris Shaders', '光影，纯客户端'],
  ['oculus', 'Oculus', 'Iris 的 Forge 移植'],
  ['optifine', 'OptiFine', '经典客户端优化'],
  ['reeses_sodium_options', "Reese's Sodium Options", 'Sodium 设置界面'],
  ['sodiumextras', 'Sodium Extras', 'Sodium 扩展设置'],
  ['immediatelyfast', 'ImmediatelyFast', '客户端渲染优化'],
  ['entityculling', 'Entity Culling', '客户端剔除优化'],
  ['moreculling', 'More Culling', '客户端剔除优化'],
  ['cullleaves', 'Cull Leaves', '客户端渲染优化'],
  ['cullparticles', 'Cull Particles', '客户端粒子优化'],
  ['entity_model_features', 'Entity Model Features', '客户端实体模型'],
  ['enhancedblockentities', 'Enhanced Block Entities', '客户端渲染增强'],
  ['ferritecore', 'FerriteCore', '客户端内存优化'],
  ['smoothboot', 'Smooth Boot', '客户端启动优化'],
  ['dynamicfps', 'Dynamic FPS', '失焦时降帧'],
  ['nofog', 'NoFog', '客户端视觉效果'],
  ['blur', 'Blur (MF)', '客户端界面模糊'],
  ['zoomify', 'Zoomify', '客户端缩放'],
  ['soundphysics', 'Sound Physics Remastered', '客户端音效'],
  ['presencefootsteps', 'Presence Footsteps', '客户端音效'],
  ['waveycapes', 'WaveyCapes', '客户端披风动效'],
  ['3dskinlayers', '3D Skin Layers', '客户端皮肤渲染'],
  ['skinlayers3d', '3D Skin Layers', '客户端皮肤渲染'],
  ['notenoughanimations', 'Not Enough Animations', '客户端动画'],
  ['firstperson', 'First-Person Model', '客户端第一人称模型'],
  ['borderlessmining', 'Borderless Mining', '客户端窗口'],
  ['smoothfont', 'Smooth Font', '客户端字体渲染'],
  ['customskinloader', 'CustomSkinLoader', '客户端皮肤加载'],
  ['betterfps', 'BetterFPS', '旧版客户端优化'],
  ['betterf3', 'BetterF3', '调试界面美化'],

  // ===== 物品 / 配方查看 =====
  ['jei', 'JEI', '配方查看，服务端无需安装'],
  ['rei', 'Roughly Enough Items', '配方查看'],
  ['emi', 'EMI', '配方查看'],
  ['nei', 'NotEnoughItems', '1.7.x 配方查看'],
  ['modmenu', 'Mod Menu', 'mod 列表界面'],
  ['appleskin', 'AppleSkin', '食物信息显示'],
  ['inspecio', 'Inspecio', '物品信息显示'],
  ['shulkerboxtooltip', 'ShulkerBox Tooltip', '潜影盒预览'],
  ['itemscroller', 'Item Scroller', '物品快速操作'],
  ['mousetweaks', 'Mouse Tweaks', '鼠标操作增强'],
  ['mousewheelie', 'Mouse Wheelie', '鼠标滚轮整理'],
  ['craftingtweaks', 'Crafting Tweaks', '合成界面按钮'],
  ['inventorytweaks', 'Inventory Tweaks', '旧版背包整理'],
  ['inventoryhud', 'Inventory HUD', '背包信息 HUD'],
  ['armorstatushud', 'ArmorStatus HUD', '盔甲状态 HUD'],
  ['statuseffecthud', 'StatusEffect HUD', '药水状态 HUD'],
  ['bettermounthud', 'Better Mount HUD', '坐骑状态 HUD'],

  // ===== 地图 / 小地图 =====
  ['journeymap', 'JourneyMap', '地图，纯客户端'],
  ['xaerominimap', "Xaero's Minimap", '小地图'],
  ['xaeroworldmap', "Xaero's World Map", '世界地图'],
  ['voxelmap', 'VoxelMap', '旧版小地图'],
  ['minimap', 'VoxelMap (旧)', '旧版小地图'],
  ['ftbchunks', 'FTB Chunks', '客户端地图部分（服务端版另需安装）'],

  // ===== 信息显示 =====
  ['jade', 'Jade', '方块信息显示（需要时服务端可另装）'],
  ['hwyla', 'HWYLA', '方块信息显示'],
  ['waila', 'WAILA', '1.7.x 方块信息显示'],
  ['wthit', 'WTHIT', '方块信息显示'],
  ['theoneprobe', 'The One Probe', '信息显示（通常两端都要）'],
  ['lightoverlay', 'Light Overlay', '刷怪光照显示'],
  ['minihud', 'MiniHUD', '调试信息 HUD'],
  ['tweakeroo', 'Tweakeroo', '客户端辅助'],
  ['malilib', 'MaLiLib', '客户端辅助库'],
  ['litematica', 'Litematica', '投影/原理图'],
  ['schematica', 'Schematica', '旧版投影'],
  ['worldeditcui', 'WorldEdit CUI', '选区显示'],
  ['controlling', 'Controlling', '按键冲突界面'],
  ['language_reload', 'Language Reload', '语言切换'],
  ['betterpingdisplay', 'Better Ping Display', '延迟显示'],
  ['chatheads', 'Chat Heads', '聊天头像'],
  ['tooltipfix', 'ToolTipFix', '提示框修复'],
  ['itemborders', 'Item Borders', '物品边框'],
  ['legendarytooltips', 'Legendary Tooltips', '提示框美化'],
  ['fancymenu', 'FancyMenu', '主菜单自定义'],
  ['defaultoptions', 'Default Options', '默认选项保存'],
  ['the5zigmod', '5zig Mod', '旧版客户端信息'],
  ['damageindicators', 'Damage Indicators', '旧版伤害显示']
]

export const DEFAULT_CLIENT_MODS = SEED.map(([modid, name, note], i) => ({
  id: 'seed-' + String(i + 1).padStart(3, '0'),
  modid,
  name,
  note,
  source: 'builtin',
  createdAt: Date.now()
}))
