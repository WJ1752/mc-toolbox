"""整合包扫描器（对应 PRD F01 / 技术设计方案 core/scanner.py）。

职责：
    1. 递归遍历整合包目录（支持 CurseForge 解压结构 / Modrinth / 裸 mods 目录 /
       资源包目录等任意形态），跳过 .git、libraries 等无关目录；
    2. 自动识别 .lang / .json 语言文件：
       - 路径规则（主）：位于 lang/ 目录下、文件名是合法语言代码
         （en_us / zh_CN / pt_br ...）；
       - 内容规则（兜底）：不在 lang/ 目录但内容是"扁平的字符串键值表"
         （≥5 条且过半语言键含 '.'），例如个别模组放错位置的语言文件；
    3. 读取 mods/*.jar 容器内部的 assets/<modid>/lang/ 语言文件（只读解包，
       不落盘、不修改 jar；jar 回写属 M2/M3 范围）；
    4. 为每个语言文件建立 LangFileRef 引用：相对路径、所属容器、模组 ID、
       编码、SHA-256、条目数、导出目标路径 —— 即"文件路径映射表"的数据源；
    5. 汇总统计与告警，产出 ScanReport。
"""

from __future__ import annotations

import json
import os
import re
import time
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from ..models import FileFormat, LangFileRef, LangStyle, ScanReport, ScanStats
from ..utils import decode_bytes, sha256_bytes
from .manifest import translate_stem
from .parsers import get_parser

# --------------------------------------------------------------------------
# 正则与常量
# --------------------------------------------------------------------------

# 合法语言代码文件名：en_us / zh_CN / pt_br / es_es / lol_us(彩蛋) ...
# 语言部分 2~3 个字母；可选 "_-区域部分"（2~8 个字母数字，兼容 lol_us 等）
_LANG_CODE_RE = re.compile(r"^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?$")

# jar 容器内的语言文件路径：assets/<modid>/lang/<文件名>.json|.lang
_JAR_LANG_RE = re.compile(r"^assets/([^/]+)/lang/([^/]+)\.(json|lang)$", re.IGNORECASE)

# 从任意相对路径中提取 assets/<modid>/lang/ 片段（用于散装文件的 modid 推断）
_MODID_RE = re.compile(r"(?:^|/)assets/([^/]+)/lang/", re.IGNORECASE)

# 内容规则（json 兜底识别）的阈值：条目数下限 / 含 '.' 的语言键占比下限
_CONTENT_MIN_ENTRIES = 5
_CONTENT_DOT_RATIO = 0.5

# 默认排除目录：与语言文件无关、体积大或属于运行时缓存的目录
DEFAULT_EXCLUDE_DIRS: frozenset[str] = frozenset({
    ".git", ".github", ".gradle", "gradle", "node_modules",
    "libraries", "versions", "logs", "crash-reports",
    "saves", "screenshots", "server-resource-packs",
    ".mixin.out", "caches", "asm", ".fabric",
})

# 单文件解析大小上限：语言文件通常 <1MB，超限几乎必属误判或异常文件
DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024


@dataclass
class ScanOptions:
    """扫描参数（CLI 参数的内存形态；M2 阶段将映射到 TOML 配置）。"""

    source_lang: str = "en_us"      # 源语言（要被翻译的语言代码）
    target_lang: str = "zh_cn"      # 目标语言（导出的语言代码）
    include_jars: bool = True       # 是否扫描 mods/*.jar 容器内部
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES
    exclude_dirs: frozenset[str] = field(default_factory=lambda: DEFAULT_EXCLUDE_DIRS)
    # 进度回调（v0.3.3 新增，可选）：每完成一个文件的裁决/登记调用一次
    # progress_cb(done, total)。total 在第一遍目录遍历结束后确定为
    # "散装语言文件 + 待裁决 json + jar 容器"的总数；回调必须轻量
    # （只做状态记录），抛出的异常会被吞掉——进度上报失败不影响扫描。
    progress_cb: "Callable[[int, int], None] | None" = None


# --------------------------------------------------------------------------
# 对外入口
# --------------------------------------------------------------------------

def scan(pack_root: Path, options: ScanOptions | None = None) -> ScanReport:
    """扫描整合包目录，返回 ScanReport（含文件路径映射表所需的全部信息）。"""
    options = options or ScanOptions()
    started = time.perf_counter()
    pack_root = Path(pack_root).resolve()
    if not pack_root.is_dir():
        raise NotADirectoryError(f"整合包目录不存在：{pack_root}")

    report = ScanReport(
        pack_root=str(pack_root),
        pack_type=detect_pack_type(pack_root),
        source_lang=_normalize_lang_code(options.source_lang) or options.source_lang,
        target_lang=_normalize_lang_code(options.target_lang) or options.target_lang,
    )

    # ---- 第一遍：普通目录树中的散装语言文件与 jar 容器收集 ----
    jar_files: list[Path] = []
    plain_lang: list[tuple[Path, FileFormat, str]] = []   # (绝对路径, 格式, detected_by)
    json_skipped_candidates: list[Path] = []              # 待内容规则裁决的 json

    for dirpath, dirnames, filenames in os.walk(pack_root, followlinks=False):
        # 就地过滤排除目录："." 开头（.git/.cache 等）+ 显式排除名单
        dirnames[:] = sorted(
            d for d in dirnames
            if not d.startswith(".") and d not in options.exclude_dirs
        )
        for filename in sorted(filenames):
            fpath = Path(dirpath) / filename
            suffix = fpath.suffix.lower()
            if suffix == ".jar" and options.include_jars:
                jar_files.append(fpath)
            elif suffix == ".lang":
                # .lang 是 MC 专用格式：任何 .lang 都纳入扫描
                plain_lang.append((fpath, FileFormat.LANG, "path"))
            elif suffix == ".json":
                json_skipped_candidates.append(fpath)
            # 其余后缀（cfg/toml/txt/纹理等）本阶段不处理

    # ---- 第二遍：逐个裁决与登记（附进度上报：大包扫描可观察、可区分卡死）----
    scan_total = len(plain_lang) + len(json_skipped_candidates) + len(jar_files)
    scan_done = 0

    def _tick() -> None:
        """每完成一个扫描单元推进一次进度；回调异常静默吞掉。"""
        nonlocal scan_done
        scan_done += 1
        if options.progress_cb is not None:
            try:
                options.progress_cb(scan_done, scan_total)
            except Exception:  # noqa: BLE001 - 进度上报失败不影响扫描本身
                pass

    for fpath, fmt, detected_by in plain_lang:
        rel = fpath.relative_to(pack_root)          # 统一使用相对路径（路径映射表要求）
        _register_language_file(report, options, data=_read_bytes(fpath, report),
                                path_in_pkg=rel.as_posix(),
                                container=None, relative_dir=rel.parent.as_posix(),
                                filename=fpath.name, fmt=fmt, mod_id=None,
                                detected_by=detected_by)
        _tick()
    for fpath in json_skipped_candidates:
        _adjudicate_json(report, options, fpath)
        _tick()

    # ---- 第三遍：jar 容器内部扫描（只读） ----
    for jar_path in jar_files:
        _scan_jar(report, options, jar_path)
        _tick()

    # ---- 收尾：排序（保证 manifest 幂等可 diff）与统计汇总 ----
    report.files.sort(key=lambda r: (r.container or "", r.path_in_pkg))
    _finalize_stats(report)
    report.duration_sec = round(time.perf_counter() - started, 3)
    return report


def detect_pack_type(root: Path) -> str:
    """探测整合包类型：modrinth / curseforge / plain（普通目录）。"""
    if (root / "modrinth.index.json").is_file():
        return "modrinth"
    manifest_path = root / "manifest.json"
    if manifest_path.is_file():
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            # CurseForge 的 manifest 含 manifestType=minecraftModpack
            if str(data.get("manifestType", "")).lower().startswith("minecraftmodpack"):
                return "curseforge"
        except (OSError, ValueError):
            pass
        if (root / "overrides").is_dir():
            return "curseforge"
    return "plain"


# --------------------------------------------------------------------------
# 内部：散装文件登记
# --------------------------------------------------------------------------

def _read_bytes(fpath: Path, report: ScanReport) -> bytes | None:
    """读取文件字节；IO 失败时记录告警并返回 None（调用方跳过）。"""
    try:
        return fpath.read_bytes()
    except OSError as exc:
        _add_warning(report, f"文件读取失败 {fpath}: {exc}")
        return None


def _adjudicate_json(report: ScanReport, options: ScanOptions, fpath: Path) -> None:
    """裁决一个散装 .json：是语言文件（路径规则/内容规则）还是普通 json。"""
    rel = fpath.relative_to(report.pack_root)
    rel_posix = rel.as_posix()
    rel_dir = rel.parent.as_posix()
    stem = fpath.stem
    parent_is_lang = fpath.parent.name.lower() == "lang"
    stem_is_lang_code = _LANG_CODE_RE.match(stem) is not None

    # ---- 路径规则：lang/ 目录 + 合法语言代码文件名 → 直接判定 ----
    if parent_is_lang and stem_is_lang_code:
        _register_language_file(
            report, options, data=_read_bytes(fpath, report),
            path_in_pkg=rel_posix, container=None,
            relative_dir=rel_dir, filename=fpath.name,
            fmt=FileFormat.JSON, mod_id=None, detected_by="path",
        )
        return

    # ---- 内容规则（兜底）：解析后按"扁平字符串键值表"特征判定 ----
    data = _read_bytes(fpath, report)
    if data is None:
        return
    try:
        text, _meta = decode_bytes(data)
        parsed = get_parser(FileFormat.JSON).parse(text)
    except (ValueError, json.JSONDecodeError):
        report.stats.json_skipped += 1     # 连 JSON 都不是（或非对象），直接跳过
        return
    if _looks_like_language_content(parsed.entries):
        _register_language_file(
            report, options, data=data,
            path_in_pkg=rel_posix, container=None,
            relative_dir=rel_dir, filename=fpath.name,
            fmt=FileFormat.JSON, mod_id=None, detected_by="content",
        )
    else:
        report.stats.json_skipped += 1     # 配方/模型/清单等普通 json


def _looks_like_language_content(entries: dict) -> bool:
    """内容规则判定：条目数达下限，且过半语言键含 '.'（MC 语言键的典型特征）。"""
    if len(entries) < _CONTENT_MIN_ENTRIES:
        return False
    dot_keys = sum(1 for key in entries if "." in key)
    return dot_keys / len(entries) >= _CONTENT_DOT_RATIO


def _register_language_file(
    report: ScanReport,
    options: ScanOptions,
    *,
    data: bytes | None,
    path_in_pkg: str,
    container: str | None,
    relative_dir: str,
    filename: str,
    fmt: FileFormat,
    mod_id: str | None,
    detected_by: str,
) -> None:
    """登记一个已判定的语言文件：解码 → 解析 → 构建 LangFileRef → 更新统计。

    该函数是"文件路径映射表"的单条生产线：导出阶段（F08）还原目录结构
    所需的 path_in_pkg / relative_dir / export_relative_path 均在此确定。
    """
    ref = LangFileRef(
        path_in_pkg=path_in_pkg,
        container=container,
        relative_dir=relative_dir,
        mod_id=mod_id or _guess_mod_id(path_in_pkg),
        fmt=fmt,
        detected_by=detected_by,
    )
    stem, _, ext = filename.rpartition(".")
    suffix = f".{ext.lower()}"

    # ---- 大小守卫：超限文件不做解析（防异常大文件拖垮扫描）----
    if data is not None and len(data) > options.max_file_bytes:
        ref.parse_status = "skipped_too_large"
        ref.size = len(data)
        ref.warnings.append(f"文件超过大小上限（{options.max_file_bytes} 字节），跳过解析")
        report.stats.too_large_skipped += 1
        report.files.append(ref)
        return

    # ---- 解码与解析 ----
    entry_count = 0
    if data is not None:
        ref.sha256 = sha256_bytes(data)
        ref.size = len(data)
        try:
            text, meta = decode_bytes(data)
            ref.encoding = meta["encoding"]
            ref.had_bom = meta["had_bom"]
            ref.warnings.extend(meta["warnings"])
            parsed = get_parser(fmt).parse(text)
            entry_count = len(parsed.entries)
            ref.warnings.extend(parsed.warnings)
        except Exception as exc:  # 解析失败不中断整体扫描，仅标记该文件
            ref.parse_status = "error"
            ref.warnings.append(f"解析失败：{type(exc).__name__}: {exc}")

    # ---- 语言代码 / 风格 / 候选标记 ----
    ref.lang_code = _normalize_lang_code(stem)
    ref.lang_style = _detect_lang_style(stem, fmt)
    ref.is_source_candidate = (
        ref.parse_status == "ok" and ref.lang_code == report.source_lang
    )
    ref.is_target_existing = ref.lang_code == report.target_lang
    if ref.lang_code is None:
        ref.warnings.append(f"无法从文件名 {filename!r} 识别语言代码")

    # ---- 导出路径映射：把文件名主干替换为目标语言（保持大小写风格）----
    if ref.lang_code is not None:
        new_stem = translate_stem(stem, report.target_lang, ref.lang_style)
        ref.export_relative_path = (
            f"{relative_dir}/{new_stem}{suffix}" if relative_dir else f"{new_stem}{suffix}"
        )
    else:
        ref.export_relative_path = (
            f"{relative_dir}/{filename}" if relative_dir else filename
        )

    # ---- 统计 ----
    ref.entry_count = entry_count
    if ref.is_source_candidate:
        report.stats.total_entries += entry_count
    if ref.parse_status == "error":
        report.stats.parse_errors += 1
    report.files.append(ref)


# --------------------------------------------------------------------------
# 内部：jar 容器扫描
# --------------------------------------------------------------------------

def _scan_jar(report: ScanReport, options: ScanOptions, jar_path: Path) -> None:
    """只读扫描一个 jar 容器内的 assets/<modid>/lang/ 语言文件。

    说明：
        - 通过 zipfile 在内存中读取条目，不落盘、不修改 jar；
        - 仅按路径规则匹配（assets/*/lang/），不对 jar 内做内容规则裁决——
          jar 内 json 数量庞大且路径规则已足够精确；
        - jar 回写（把译文写回容器）属于 M2/M3 的导出功能，本阶段只读。
    """
    jar_rel = jar_path.relative_to(report.pack_root).as_posix()
    report.stats.jars_scanned += 1
    try:
        with zipfile.ZipFile(jar_path) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                # zip 内路径统一使用 '/' 分隔符
                m = _JAR_LANG_RE.match(info.filename)
                if not m:
                    continue
                mod_id, _lang_stem, ext = m.group(1), m.group(2), m.group(3).lower()
                if info.file_size > options.max_file_bytes:
                    _add_warning(report, f"{jar_rel}!{info.filename} 超过大小上限，跳过")
                    report.stats.too_large_skipped += 1
                    continue
                data = zf.read(info)
                fmt = FileFormat.LANG if ext == "lang" else FileFormat.JSON
                # 完整文件名（含扩展名）：语言代码/导出路径都从它推导
                lang_filename = info.filename.rsplit("/", 1)[1]
                zip_dir = info.filename.rsplit("/", 1)[0] if "/" in info.filename else ""
                _register_language_file(
                    report, options, data=data,
                    path_in_pkg=f"{jar_rel}!{info.filename}",
                    container=jar_rel, relative_dir=zip_dir,
                    filename=lang_filename, fmt=fmt, mod_id=mod_id,
                    detected_by="path",
                )
    except zipfile.BadZipFile as exc:
        # mods 目录中偶见损坏/伪装成 .jar 的文件：告警但不中断扫描
        _add_warning(report, f"jar 容器读取失败 {jar_rel}: {exc}")


# --------------------------------------------------------------------------
# 内部：小工具
# --------------------------------------------------------------------------

def _normalize_lang_code(stem: str) -> str | None:
    """把文件名主干规范化为语言代码（小写、'-' 归一为 '_'）；不合法返回 None。"""
    if not _LANG_CODE_RE.match(stem):
        return None
    return stem.lower().replace("-", "_")


def _detect_lang_style(stem: str, fmt: FileFormat) -> LangStyle:
    """判定语言文件命名风格：LEGACY（1.12.2-）或 MODERN（1.13+）。

    判定依据：
        - .lang 格式只存在于 1.12.2 及以前 → LEGACY；
        - 文件名含大写字母（en_US / zh_TW）是旧版命名习惯 → LEGACY；
        - 其余 → MODERN（1.13+ 全小写 en_us.json）。
    """
    if fmt is FileFormat.LANG or stem != stem.lower():
        return LangStyle.LEGACY
    return LangStyle.MODERN


def _guess_mod_id(path_in_pkg: str) -> str | None:
    """从相对路径推断模组 ID（assets/<modid>/lang/ 片段）；推断不出返回 None。"""
    m = _MODID_RE.search(path_in_pkg)
    return m.group(1) if m else None


def _add_warning(report: ScanReport, message: str) -> None:
    """追加扫描级告警（上限 200 条，防止超大包刷屏）。"""
    if len(report.warnings) < 200:
        report.warnings.append(message)


def _finalize_stats(report: ScanReport) -> None:
    """基于 files 列表汇总统计（保证统计与映射表严格一致）。"""
    stats = report.stats
    by_fmt: Counter[str] = Counter()
    by_mod: Counter[str] = Counter()
    for ref in report.files:
        stats.language_files += 1
        by_fmt[ref.fmt.value] += 1
        by_mod[ref.mod_id or "unknown"] += 1
        if ref.is_source_candidate:
            stats.source_candidates += 1
    stats.by_fmt = dict(sorted(by_fmt.items()))
    stats.by_mod = dict(sorted(by_mod.items(), key=lambda kv: -kv[1]))
