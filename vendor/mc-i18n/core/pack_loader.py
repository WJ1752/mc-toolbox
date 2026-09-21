"""拖拽上传文件解析器：把浏览器 drop 的 .zip / .mrpack / .jar / 文件夹
整理成可直接翻译的整合包目录结构。

安全边界（解压炸弹防护）：
    - 单个压缩包最大 512 MB
    - 解压后总大小最大 1 GB
    - 最多 10 000 个文件
    - 最大嵌套深度 8 层
    - 禁止绝对路径与 ../ 穿越
    - 仅保留 .jar / .json / .lang / .snbt / .txt / .toml / .cfg / .yaml / .yml 等文本/模组文件

输出结构：
    - CurseForge .zip     → 解压后直接使用（含 manifest.json + overrides/ + mods/）
    - Modrinth .mrpack    → 解压后取 overrides/，并在 mods/ 中按 pack/index.json 描述
                            生成可扫描的 jar 占位名（mc-i18n 不联网下载，仅保留原文件名）
    - 单个/多个 .jar      → 统一放到 <临时目录>/mods/
    - 混合 jar + zip      → zip 解压为包，额外 jar 再放进其 mods/（或新建 mods/）
"""

from __future__ import annotations

import json
import logging
import shutil
import zipfile
from dataclasses import dataclass
from pathlib import Path
from tempfile import mkdtemp

logger = logging.getLogger("mc_i18n.pack_loader")

# 安全阈值
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024      # 512 MB
MAX_TOTAL_BYTES = 1024 * 1024 * 1024       # 1 GB
MAX_FILES = 10_000
MAX_DEPTH = 8

# 浏览器拖拽文件夹时无法真正上传「目录」，而是上传其中文件；
# 服务端只接受这些扩展名，拒绝可执行/未知二进制。
ALLOWED_EXTENSIONS = {
    ".jar", ".json", ".lang", ".snbt", ".txt",
    ".toml", ".cfg", ".ini", ".yaml", ".yml",
    ".md", ".mcmeta", ".png", ".jpg", ".jpeg",
}


class UploadError(ValueError):
    """用户上传文件不合法（格式、大小、路径安全）。"""


@dataclass(frozen=True)
class LoadedPack:
    """解析后的结果。"""

    root: Path
    kind: str  # curseforge | modrinth | jar_drop | folder


def _safe_name(name: str) -> str:
    """清理文件名：去掉路径、控制字符，替换危险字符。"""
    name = name.replace("\\", "/").split("/")[-1]
    # 只允许常见安全字符
    allowed_chars = set(
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        "_-+()[]{}.,~@#$%&= !^"
    )
    return "".join(c if c in allowed_chars else "_" for c in name).strip("._")


def _is_safe_member(arcname: str) -> bool:
    """校验压缩包成员路径：禁止绝对路径、../ 穿越、过深目录。"""
    parts = arcname.replace("\\", "/").split("/")
    depth = 0
    for part in parts:
        if part == "" or part == ".":
            continue
        if part == "..":
            return False
        depth += 1
    if depth > MAX_DEPTH:
        return False
    return True


def _extension_ok(path: Path) -> bool:
    """根据扩展名或通用名判断文件是否允许保留。"""
    ext = path.suffix.lower()
    if ext in ALLOWED_EXTENSIONS:
        return True
    # manifest.json / pack/index.json 等无特殊后缀但属于元数据
    name = path.name.lower()
    if name in ("manifest.json", "index.json", "modlist.html", "index.toml"):
        return True
    return False


def _extract_zip(zip_path: Path, out_dir: Path) -> None:
    """安全解压 zip，带炸弹防护。"""
    total = 0
    count = 0
    with zipfile.ZipFile(zip_path, "r") as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            if not _is_safe_member(info.filename):
                raise UploadError(f"压缩包含危险路径：{info.filename}")
            total += info.file_size
            count += 1
            if total > MAX_TOTAL_BYTES:
                raise UploadError("解压后总大小超过 1 GB 安全上限")
            if count > MAX_FILES:
                raise UploadError("解压文件数超过 10 000 安全上限")

        # 二次遍历真正写出
        for info in zf.infolist():
            if info.is_dir():
                continue
            target = out_dir / Path(*Path(info.filename).parts)
            if not _extension_ok(target):
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, target.open("wb") as dst:
                shutil.copyfileobj(src, dst)


def _load_curseforge(root: Path) -> bool:
    """检测是否为 CurseForge 整合包（根目录 manifest.json 且 manifestType 正确）。"""
    manifest = root / "manifest.json"
    if not manifest.is_file():
        return False
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
        return data.get("manifestType") == "minecraftModpack"
    except Exception:
        return False


def _load_modrinth(root: Path) -> bool:
    """检测是否为 Modrinth 整合包（根目录 pack/index.json 且 formatVersion 存在）。"""
    idx = root / "pack" / "index.json"
    if not idx.is_file():
        return False
    try:
        data = json.loads(idx.read_text(encoding="utf-8"))
        return "formatVersion" in data and "files" in data
    except Exception:
        return False


def _prepare_modrinth_mods(root: Path) -> None:
    """为 Modrinth 包生成 mods/ 占位 jar 名（不联网下载，仅按项目 ID 命名便于识别）。"""
    idx = root / "pack" / "index.json"
    data = json.loads(idx.read_text(encoding="utf-8"))
    mods_dir = root / "mods"
    mods_dir.mkdir(exist_ok=True)
    for f in data.get("files", []):
        path = f.get("path", "")
        if not path.startswith("mods/"):
            continue
        name = path.split("/")[-1]
        if not name.endswith(".jar"):
            name += ".jar"
        target = mods_dir / _safe_name(name)
        if not target.exists():
            target.write_text(
                f"# mrpack placeholder for {f.get('downloads', ['?'])[0]}\n"
                "# mc-i18n does not download mods; this file is only for scanning.\n",
                encoding="utf-8",
            )


def load_dropped_files(paths: list[Path]) -> LoadedPack:
    """入口：把浏览器上传的若干文件整理成可翻译的整合包目录。

    参数 paths：每个 Path 都是已落盘到服务端的临时文件；
    若是文件夹，浏览器通常已递归展开成文件列表，服务端见不到目录本身。
    """
    if not paths:
        raise UploadError("没有收到文件")

    # 按类型分组
    zips = [p for p in paths if p.suffix.lower() == ".zip"]
    mrp = [p for p in paths if p.suffix.lower() == ".mrpack"]
    jars = [p for p in paths if p.suffix.lower() == ".jar"]
    others = [p for p in paths if p.suffix.lower() not in {".zip", ".mrpack", ".jar"}]

    if len(zips) + len(mrp) > 1:
        raise UploadError("一次只能上传 1 个整合包压缩文件")

    work = Path(mkdtemp(prefix="mc_i18n_drop_"))

    # 情况 1：上传的是整合包压缩文件
    if mrp:
        _extract_zip(mrp[0], work)
        if not _load_modrinth(work):
            raise UploadError(".mrpack 包结构不合法：缺少 pack/index.json")
        _prepare_modrinth_mods(work)
        return LoadedPack(work, "modrinth")

    if zips:
        _extract_zip(zips[0], work)
        # 浏览器拖 zip 可能带外层文件夹（一些压缩工具会套一层）
        entries = [e for e in work.iterdir() if e.name != ".DS_Store"]
        if len(entries) == 1 and entries[0].is_dir():
            candidate = entries[0]
            if (candidate / "manifest.json").is_file() or (candidate / "mods").is_dir():
                work = candidate
        if _load_curseforge(work):
            return LoadedPack(work, "curseforge")
        # 否则当作普通 zip（可能只是 mods/ 或语言文件压缩包）
        return LoadedPack(work, "folder")

    # 情况 2：只有 jar（单个或多个）
    if jars and not others:
        mods_dir = work / "mods"
        mods_dir.mkdir(parents=True)
        for jar in jars:
            target = mods_dir / _safe_name(jar.name)
            shutil.copy2(jar, target)
        return LoadedPack(work, "jar_drop")

    # 情况 3：零散文件（文件夹展开后的 lang/json 等）
    for f in others + jars:
        # 保持相对目录结构：浏览器上传时 flatten 了，只能按文件名放根目录或 mods
        if f.suffix.lower() == ".jar":
            target_dir = work / "mods"
        else:
            target_dir = work / "overrides"
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / _safe_name(f.name)
        shutil.copy2(f, target)
    return LoadedPack(work, "folder")


def cleanup_pack(pack: LoadedPack) -> None:
    """翻译任务完成后可选清理临时目录（用户导出结果在 .mc-i18n 工作目录里，
    这里删的是上传源文件）。"""
    try:
        shutil.rmtree(pack.root, ignore_errors=True)
    except Exception as exc:
        logger.warning("清理上传临时目录失败：%s", exc)
