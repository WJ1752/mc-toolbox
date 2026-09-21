"""导出与打包（对应 PRD F08 一键打包输出）。

目录还原规则（与 manifest 的路径映射表严格对应）：
    - 散装文件（container=None）
          导出磁盘路径 = <out_root>/<export_relative_path>
          例：overrides/kubejs/assets/kubejs/lang/en_us.json
              → <out_root>/overrides/kubejs/assets/kubejs/lang/zh_cn.json
    - jar 内文件（container="mods/xxx.jar"）
          导出磁盘路径 = <out_root>/extracted/<容器相对路径去.jar>/<zip内导出路径>
          例：mods/demo_mod_1.0.0.jar!assets/demomod/lang/en_us.json
              → <out_root>/extracted/mods/demo_mod_1.0.0/assets/demomod/lang/zh_cn.json
          （jar 本身不回写——保持"只读扫描"纪律，译文以散装树形式落地）

打包规则（build_resource_pack）：
    遍历 out_root 全部文件，取路径中第一个 assets/ 段开始的部分作为 zip 条目名，
    生成 pack.mcmeta 后压缩为可直接投入 .minecraft/resourcepacks 的资源包。
    这样 overrides 树与 extracted 树中所有 assets 内容都会被正确收进包里。
"""

from __future__ import annotations

import json
import logging
import zipfile
from pathlib import Path

from ..models import LangFileRef

logger = logging.getLogger("mc_i18n.export")

__all__ = [
    "read_ref_bytes", "read_existing_target", "disk_path_for_ref", "collect_assets",
    "build_resource_pack", "build_resource_pack_dir", "build_resource_pack_to",
    "resolve_pack_output", "guess_pack_format", "PACK_FORMATS",
    "target_language_exists",
]

# 汉化包（资源包）默认产出名：放入整合包 resourcepacks 文件夹后即为开箱即用
DEFAULT_PACK_NAME = "mc-i18n"


# --------------------------------------------------------------------------
# 源文件读取
# --------------------------------------------------------------------------

def read_ref_bytes(pack_root: Path, ref: LangFileRef) -> bytes:
    """按映射表引用读取语言文件原始字节（散装文件 / jar 容器内文件通吃）。

    jar 文件的 path_in_pkg 形如 "mods/xxx.jar!assets/m/lang/en_us.json"，
    以 '!' 分隔容器相对路径与 zip 内路径，用 zipfile 在内存中读取，
    不落盘、不修改 jar。
    """
    if ref.container is None:
        return (Path(pack_root) / ref.path_in_pkg).read_bytes()
    # jar 内文件
    pack_root = Path(pack_root)
    jar_path = pack_root / ref.container
    zip_inner = ref.path_in_pkg.split("!", 1)[1]
    with zipfile.ZipFile(jar_path) as zf:
        return zf.read(zip_inner)


# --------------------------------------------------------------------------
# 目标语言存在性检测（"已有中文的模组跳过，不覆盖好翻译"的依据）
# --------------------------------------------------------------------------

def target_language_exists(pack_root: Path, ref: LangFileRef) -> bool:
    """判断该源文件对应的【目标语言文件】是否已存在于整合包中。

    检测规则（与导出路径映射同源，保证判断和写出一致）：
        - 散装文件：整合包内 <export_relative_path> 存在
          （例：overrides/kubejs/.../en_us.json → 同目录 zh_cn.json 是否存在）
        - jar 内文件：同一容器 zip 内 <export_relative_path>（zip 内路径）是否存在
          （例：demo.jar!assets/m/lang/en_us.json → demo.jar 内 assets/m/lang/zh_cn.json）

    用途：整合包/模组**自带中文**时，说明该模组已有（社区/官方）翻译，
    机翻不应覆盖 —— 默认跳过这些文件，只补翻"完全没有中文"的模组。

    注意：独立汉化资源包（如 CFPA）不在整合包目录内，此函数检测不到；
    该场景请用户在游戏资源包列表中把 mc-i18n 包放在汉化包之下（低优先级）。
    """
    pack_root = Path(pack_root)
    export_path = ref.export_relative_path
    if ref.container:                          # jar 内：查容器 zip 内路径
        inner = export_path.split("!", 1)[1].lstrip("/") if "!" in export_path else export_path
        jar_path = pack_root / ref.container
        try:
            with zipfile.ZipFile(jar_path) as zf:
                names = frozenset(zf.namelist())
                return inner in names
        except (OSError, zipfile.BadZipFile):
            return False                       # 容器读不了 → 视为不存在，正常翻译
    return (pack_root / export_path).is_file()


def read_existing_target(pack_root: Path, ref: LangFileRef) -> bytes | None:
    """读取该源文件对应的【已有目标语言文件】的原始字节；不存在/读不了返回 None。

    与 ``target_language_exists`` 共用同一套路径推导（保证"判断存在"与
    "真正读出内容"永远指向同一个文件），区别只是这里把字节也取回来 ——
    M2 增量合并（``--merge-existing``）需要逐条读取社区/官方已有译文，
    以便"只补翻缺失、不覆盖已有"。

    jar 内文件在本函数中**只读不写**：译文的落地形式仍是散装
    ``extracted/`` 树（见模块 docstring），回写 jar 属 M3 范围。
    """
    pack_root = Path(pack_root)
    export_path = ref.export_relative_path
    if ref.container:                          # jar 内：读容器 zip 内路径
        inner = export_path.split("!", 1)[1].lstrip("/") if "!" in export_path else export_path
        jar_path = pack_root / ref.container
        try:
            with zipfile.ZipFile(jar_path) as zf:
                return zf.read(inner)
        except (OSError, KeyError, zipfile.BadZipFile):
            return None                        # 容器/条目读不了 → 视为"没有已有译文"
    try:
        return (pack_root / export_path).read_bytes()
    except OSError:
        return None


# --------------------------------------------------------------------------
# 导出路径换算
# --------------------------------------------------------------------------

def disk_path_for_ref(out_root: Path, ref: LangFileRef) -> Path:
    """把映射表引用换算为导出磁盘路径（规则见模块 docstring）。"""
    out_root = Path(out_root)
    if ref.container is None:
        return out_root / ref.export_relative_path
    # jar 内文件：写入 extracted/<容器去.jar>/<zip内路径>
    container_stem = ref.container[:-len(".jar")] if ref.container.lower().endswith(".jar") else ref.container
    return out_root / "extracted" / container_stem / ref.export_relative_path


# --------------------------------------------------------------------------
# 资源包打包
# --------------------------------------------------------------------------

# MC 版本 → 资源包 pack_format（常用版本速查；未收录版本用 guess_pack_format 兜底）
PACK_FORMATS: dict[str, int] = {
    "1.21.4": 46, "1.21.2": 42, "1.21": 34,
    "1.20.5": 32, "1.20.3": 22, "1.20.2": 18,
    "1.20": 15, "1.19.4": 13, "1.19.3": 12, "1.19": 9,
    "1.18.2": 9, "1.17": 8, "1.16.5": 6, "1.15": 5,
    "1.13": 4, "1.12.2": 3, "1.11": 3, "1.10": 2, "1.9": 2, "1.8": 1,
}


def guess_pack_format(mc_version: str | None) -> int:
    """按 MC 版本字符串猜测 pack_format；未知版本取不小于该版本的最近已知值。

    解析形如 "1.20.1" / "1.21.4-pre2" 的版本号为 (主, 次, 修订) 三元组，
    在已知表中找"≤ 目标版本的最大 pack_format"（向后兼容规则与官方一致）。
    """
    if not mc_version:
        return 15   # 默认 1.20.x，兼容性最好
    import re
    m = re.match(r"(\d+)\.(\d+)(?:\.(\d+))?", mc_version.strip())
    if not m:
        return 15
    version = tuple(int(m.group(i) or 0) for i in (1, 2, 3))

    best = 15
    best_key: tuple | None = None
    for label, fmt in PACK_FORMATS.items():
        mm = re.match(r"(\d+)\.(\d+)(?:\.(\d+))?", label)
        if not mm:
            continue
        key = tuple(int(mm.group(i) or 0) for i in (1, 2, 3))
        if key <= version and (best_key is None or key > best_key):
            best, best_key = fmt, key
    return best


def _pack_mcmeta(pack_format: int, description: str) -> bytes:
    """构造 pack.mcmeta 字节（UTF-8、LF、尾部换行）。"""
    return (json.dumps(
        {"pack": {"pack_format": pack_format, "description": description}},
        ensure_ascii=False, indent=2,
    ) + "\n").encode("utf-8")


def collect_assets(out_root: Path) -> list[tuple[str, Path]]:
    """收集导出树中所有 assets/ 内容，返回 [(zip 条目名, 绝对路径)]。

    路径改写规则：取相对路径中第一个 assets/ 段开始的部分。
        overrides/kubejs/assets/kubejs/lang/zh_cn.json
            → assets/kubejs/lang/zh_cn.json
        extracted/mods/demo_mod_1.0.0/assets/demomod/lang/zh_cn.json
            → assets/demomod/lang/zh_cn.json
    不含 assets/ 段的文件（如临时文件）忽略并记录 debug 日志。
    """
    out_root = Path(out_root)
    collected: list[tuple[str, Path]] = []
    for fpath in sorted(out_root.rglob("*")):
        if not fpath.is_file():
            continue
        parts = fpath.relative_to(out_root).parts
        if "assets" not in parts:
            logger.debug("打包时跳过无 assets/ 段的文件：%s", fpath)
            continue
        idx = parts.index("assets")
        zip_name = "/".join(parts[idx:])
        collected.append((zip_name, fpath))
    return collected


def build_resource_pack(out_root: Path, zip_path: Path, *,
                        pack_format: int | None = None,
                        mc_version: str | None = None,
                        description: str = "汉化资源包（mc-i18n 生成）") -> tuple[Path, int]:
    """把导出树一键打包为汉化资源包 zip。

    参数：
        out_root     导出树根目录（pipeline 的输出目录）
        zip_path     产物 zip 路径（父目录自动创建）
        pack_format  显式 pack_format；未提供时按 mc_version 推断
        mc_version   整合包 MC 版本（guess_pack_format 使用）
        description  资源包描述（游戏内资源包列表显示）

    返回 (zip 路径, 打包文件数)。导出树中无 assets/ 内容时抛 ValueError。
    """
    deduped, duplicates, fmt, _no_assets = _prepare_pack_assets(
        out_root, pack_format, mc_version)
    if _no_assets:
        raise ValueError(
            f"导出树 {out_root} 中没有 assets/ 内容，无法打包资源包"
            f"（请先运行 translate，并确认整合包内存在语言文件）"
        )

    zip_path = Path(zip_path)
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("pack.mcmeta", _pack_mcmeta(fmt, description))
        for zip_name, fpath in deduped.items():
            zf.write(fpath, zip_name)
            count += 1
    if duplicates:
        logger.warning("共忽略 %d 个重复条目（同一 modid 被多个文件同时覆盖）", duplicates)
    logger.info("资源包已生成：%s（pack_format=%d，含 %d 个文件）", zip_path, fmt, count)
    return zip_path, count


def _prepare_pack_assets(out_root, pack_format=None, mc_version=None):
    """收集导出树 assets/ 内容并去重，返回 (deduped, duplicates, fmt, no_assets)。

    供 zip 与文件夹两种资源包构建复用。重名条目（不同 jar 覆盖同一 modid
    语言文件，如多个 mod 都覆盖 assets/minecraft/lang/）保留先到者（字母序），
    游戏读取顺序未定义，这里告警并忽略后者。
    """
    out_root = Path(out_root)
    assets = collect_assets(out_root)
    if not assets:
        return {}, 0, (pack_format or guess_pack_format(mc_version)), True
    deduped: dict[str, Path] = {}
    duplicates = 0
    for zip_name, fpath in assets:
        if zip_name in deduped:
            duplicates += 1
            logger.warning("资源包内出现重名条目，保留先到者：'%s'（%s 被忽略）",
                           zip_name, fpath)
            continue
        deduped[zip_name] = fpath
    if duplicates:
        logger.warning("共忽略 %d 个重复条目（同一 modid 被多个文件同时覆盖）", duplicates)
    return deduped, duplicates, (pack_format or guess_pack_format(mc_version)), False


def _safe_clear_resource_pack(dest_dir: Path) -> None:
    """清空旧资源包痕迹：仅移除 dest_dir 内的 assets/ 目录与 pack.mcmeta，
    不动其他文件，最大限度避免误删用户资料。

    资源包文件夹是 mc-i18n 专属产物，重跑时若仍往同一目录写会产生残留旧条目，
    故每次构建前清掉这两个专属文件/目录（其余子目录原样保留）。
    """
    dest_dir = Path(dest_dir)
    assets_dir = dest_dir / "assets"
    if assets_dir.is_dir():
        import shutil
        shutil.rmtree(assets_dir, ignore_errors=True)
    mcmeta = dest_dir / "pack.mcmeta"
    if mcmeta.is_file():
        try:
            mcmeta.unlink()
        except OSError:
            pass


def build_resource_pack_dir(out_root: Path, dest_dir: Path, *,
                            pack_format: int | None = None,
                            mc_version: str | None = None,
                            description: str = "汉化资源包（mc-i18n 生成）") -> tuple[Path, int, int]:
    """把导出树一键打包为**文件夹**资源包（开箱即用，游戏直接识别）。

    与 build_resource_pack 的 zip 产物不同，这里输出一个文件夹：
        <dest_dir>/
            pack.mcmeta          # 资源包描述（游戏内显示）
            assets/<modid>/lang/zh_cn.json
            ...
    放入整合包的 resourcepacks/ 后，启动游戏即可在资源包列表里直接启用，
    无需解压，也方便用户查看与二次校对。

    参数：
        out_root     导出树根目录（pipeline 的输出目录）
        dest_dir     资源包文件夹路径（不存在自动创建，旧产物自动清理）
        pack_format / mc_version / description 同 build_resource_pack

    返回 (资源包目录, 文件数, 重复条目数)。导出树无 assets/ 内容时抛 ValueError。
    """
    deduped, duplicates, fmt, no_assets = _prepare_pack_assets(
        out_root, pack_format, mc_version)
    if no_assets:
        raise ValueError(
            f"导出树 {out_root} 中没有 assets/ 内容，无法打包资源包"
            f"（请先运行 translate，并确认整合包内存在语言文件）"
        )

    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    _safe_clear_resource_pack(dest_dir)
    (dest_dir / "pack.mcmeta").write_bytes(_pack_mcmeta(fmt, description))

    count = 0
    for zip_name, fpath in deduped.items():
        target = dest_dir / zip_name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(fpath.read_bytes())
        count += 1
    logger.info("资源包（文件夹）已生成：%s（pack_format=%d，含 %d 个文件）",
                dest_dir, fmt, count)
    return dest_dir, count, duplicates


def build_resource_pack_to(out_root: Path, target: Path, *,
                           pack_format: int | None = None,
                           mc_version: str | None = None,
                           description: str = "汉化资源包（mc-i18n 生成）") -> tuple[Path, int]:
    """按 target 路径决定资源包形式：以 .zip 结尾 → zip 压缩包；
    否则 → 文件夹资源包。返回 (产物路径, 文件数)。

    单一入口，供 CLI / WebUI 根据"产出位置"配置统一调用。
    """
    target = Path(target)
    if target.suffix.lower() == ".zip":
        return build_resource_pack(
            out_root, target, pack_format=pack_format,
            mc_version=mc_version, description=description)
    return build_resource_pack_dir(
        out_root, target, pack_format=pack_format,
        mc_version=mc_version, description=description)[:2]


def resolve_pack_output(pack_root: Path, out: str | None, *,
                        target_lang: str = "zh_cn",
                        pack_name: str | None = None) -> Path:
    """解析汉化包（资源包）的产出位置。

    out 为空 / "auto" / None → 默认输出到整合包自己的 resourcepacks 文件夹内，
    即 <pack>/resourcepacks/<DEFAULT_PACK_NAME>-<target_lang>/（一个开箱即用的
    文件夹资源包，游戏启动后即可在资源包列表里直接启用，无需手动搬运）。

    否则使用用户自定义路径：以 .zip 结尾 → 输出为 zip 资源包；
    否则作为文件夹资源包目录。相对路径以整合包根为基准解析。
    """
    pack_root = Path(pack_root)
    normalized = (str(out).strip().lower() if out is not None else "")
    if not normalized or normalized == "auto":
        return pack_root / "resourcepacks" / f"{DEFAULT_PACK_NAME}-{target_lang}"
    p = Path(out)
    if not p.is_absolute():
        p = pack_root / p
    return p
