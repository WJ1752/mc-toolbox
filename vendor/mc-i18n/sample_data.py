"""测试样例数据：在给定目录生成一个最小但覆盖典型场景的"演示整合包"。

该演示包同时服务于：
    - samples/build_samples.py（生成仓库内静态样例，供快速体验）
    - tests/test_scanner.py（单元测试在临时目录中自行构建，保证隔离）

演示包结构（覆盖扫描器的全部判定分支）：
    demo_modpack/
    ├── manifest.json                                  # CurseForge 标记 → pack_type=curseforge
    ├── overrides/
    │   ├── kubejs/assets/kubejs/lang/en_us.json       # 路径规则命中（2空格缩进+LF+尾换行）
    │   ├── kubejs/assets/kubejs/lang/zh_cn.json       # 目标语言现存文件（增量合并伏笔）
    │   ├── kubejs/data/demopack/recipes/demo.json     # 非语言 json（嵌套结构 → 内容规则跳过）
    │   └── config/example.cfg                         # 无关文件（直接忽略）
    └── mods/
        ├── demo_mod_1.0.0.jar                         # 现代模组：jar 内压缩单行 json 语言文件
        └── legacy_mod_1.12.2.jar                      # 旧版模组：jar 内 CRLF .lang（注释/续行/值含'='）
"""

from __future__ import annotations

import zipfile
from pathlib import Path

# --------------------------------------------------------------------------
# 文本常量（注意：JSON 字符串内的 "\n" 转义在 Python 源码中写作 \\n）
# --------------------------------------------------------------------------

# CurseForge 整合包清单（manifestType 字段是 pack_type 探测依据）
CURSEFORGE_MANIFEST_JSON = """{
  "minecraft": {
    "version": "1.20.1",
    "modLoaders": [
      {"id": "forge-47.2.0", "primary": true}
    ]
  },
  "manifestType": "minecraftModpack",
  "manifestVersion": 1,
  "name": "Demo Modpack",
  "version": "1.0.0",
  "author": "mc-i18n",
  "files": []
}
"""

# kubejs 语言文件（英文源）：2 空格缩进 / LF / 以换行结尾
# 值中覆盖典型占位符：%s、%d、%1$s、${player}、§ 颜色码、\n 转义
KUBEJS_EN_JSON = """{
  "item.kubejs.demo_sword.name": "Demo Sword of %s",
  "item.kubejs.demo_sword.tooltip": "Deals %d damage\\n§cSharp! §rUse with %1$s",
  "block.kubejs.demo_block.name": "${player}'s Demo Block",
  "key.categories.kubejs": "Demo Keys",
  "config.kubejs.enabled": "Enabled: %s"
}
"""

# kubejs 语言文件（简中，部分已翻译）：模拟"目标语言文件已存在"的增量场景
KUBEJS_ZH_JSON = """{
  "item.kubejs.demo_sword.name": "演示之剑",
  "key.categories.kubejs": "演示按键"
}
"""

# 非语言 json：配方文件（嵌套结构，值非全字符串 → 内容规则应跳过）
RECIPE_JSON = """{
  "type": "minecraft:crafting_shaped",
  "pattern": [
    "XXX",
    "X X"
  ],
  "key": {
    "X": {
      "item": "minecraft:iron_ingot"
    }
  },
  "result": {
    "item": "minecraft:iron_ingot",
    "count": 1
  }
}
"""

# 无关配置文件（扫描器应直接忽略）
EXAMPLE_CFG = """# Demo config file（非语言文件，扫描器应忽略）
enabled = true
max_size = 64
"""

# jar 内语言文件：压缩单行风格（与 MC jar 内原版文件一致），5 条目
DEMO_JAR_EN_JSON = (
    '{"item.demomod.pickaxe.name":"Demo Pickaxe",'
    '"item.demomod.pickaxe.tooltip":"Mines %s blocks/s\\n§7Right-click §rfor mode: %1$s",'
    '"entity.demomod.golem.name":"Demo Golem",'
    '"item.demomod.gear.name":"Cogwheel %d",'
    '"item.demomod.gear.tooltip":"Rotation: %s RPM\\nUsed in §6machines"}'
)

# jar 内非语言 json：物品模型（路径规则不命中、jar 内不做内容规则 → 不入映射表）
DEMO_JAR_MODEL_JSON = (
    '{"parent":"minecraft:item/handheld","textures":{"layer0":"demomod:item/pickaxe"}}'
)

# jar 内 pack.mcmeta（验证 jar 内非 lang 目录的 json 不被扫描）
DEMO_JAR_MCMETA = '{"pack":{"pack_format":15,"description":"Demo mod"}}'

# 旧版 .lang 内容（CRLF 换行），覆盖：注释行 / 空行 / 值含 '=' / '\' 续行
LEGACY_LANG_LINES = [
    "# Legacy Mod 语言文件（注释行必须原样保留）",
    "# 第二行注释",
    "",
    "item.legacymod.wand.name=Magic Wand",
    "item.legacymod.wand.desc=Right click to use %s\\nCost: %d mana §9(cool §rdown)",
    "tile.legacymod.machine.name=Furnace Mk2=MK2",
    "item.legacymod.book.page1=Long text \\",
    "continues here",
    "# EOF",
]
LEGACY_LANG_CRLF = "\r\n".join(LEGACY_LANG_LINES) + "\r\n"


# --------------------------------------------------------------------------
# 构建函数
# --------------------------------------------------------------------------

def _write_bytes(path: Path, text: str) -> None:
    """以字节方式写入文本（绕过任何平台换行符转换，保证样例字节精确）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode("utf-8"))


def _make_jar(path: Path, entries: dict[str, str]) -> None:
    """构建一个 zip/jar 容器并写入文本条目（UTF-8、DEFLATED 压缩）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in entries.items():
            zf.writestr(name, content.encode("utf-8"))


def build_demo_pack(root: Path) -> Path:
    """在 root 目录生成完整演示整合包，返回该目录路径。"""
    root = Path(root)

    # ---- 1) CurseForge 清单与 overrides 散装文件 ----
    _write_bytes(root / "manifest.json", CURSEFORGE_MANIFEST_JSON)
    _write_bytes(root / "overrides/kubejs/assets/kubejs/lang/en_us.json", KUBEJS_EN_JSON)
    _write_bytes(root / "overrides/kubejs/assets/kubejs/lang/zh_cn.json", KUBEJS_ZH_JSON)
    _write_bytes(root / "overrides/kubejs/data/demopack/recipes/demo.json", RECIPE_JSON)
    _write_bytes(root / "overrides/config/example.cfg", EXAMPLE_CFG)

    # ---- 2) 现代模组 jar：压缩单行 json 语言文件 + 干扰 json ----
    _make_jar(root / "mods/demo_mod_1.0.0.jar", {
        "assets/demomod/lang/en_us.json": DEMO_JAR_EN_JSON,
        "assets/demomod/models/item/pickaxe.json": DEMO_JAR_MODEL_JSON,
        "pack.mcmeta": DEMO_JAR_MCMETA,
    })

    # ---- 3) 旧版模组 jar：CRLF .lang（注释 / 续行 / 值含 '='）----
    _make_jar(root / "mods/legacy_mod_1.12.2.jar", {
        "assets/legacymod/lang/en_US.lang": LEGACY_LANG_CRLF,
    })

    return root
