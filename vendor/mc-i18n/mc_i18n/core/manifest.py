"""文件路径映射表（对应 PRD 需求 3 / 技术设计方案 core/manifest.py）。

职责：
    1. 把扫描结果（ScanReport）整理为可落盘的 manifest 字典；
    2. 计算"导出路径映射"——源语言文件 → 目标语言文件的相对路径，
       这正是后续导出阶段（F08）按原目录树还原结构的依据；
    3. manifest.json 的保存 / 加载。

manifest 示例（节选）：
    {
      "manifest_version": 1,
      "pack_type": "curseforge",
      "source_lang": "en_us",
      "target_lang": "zh_cn",
      "stats": {...},
      "files": [
        {
          "path_in_pkg": "overrides/kubejs/assets/kubejs/lang/en_us.json",
          "container": null,
          "relative_dir": "overrides/kubejs/assets/kubejs/lang",
          "mod_id": "kubejs",
          "fmt": "json",
          "lang_code": "en_us",
          "entry_count": 5,
          "export_relative_path": "overrides/kubejs/assets/kubejs/lang/zh_cn.json",
          ...
        }
      ]
    }
"""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from .. import __version__
from ..models import LangFileRef, LangStyle, ScanReport

#: manifest 结构版本号（字段变更时递增，便于向后兼容判断）
MANIFEST_VERSION = 1


def translate_stem(source_stem: str, target_lang: str, style: LangStyle | None) -> str:
    """把源语言文件名主干替换为目标语言主干，并保持原文件的大小写风格。

    示例：
        ("en_us", "zh_cn", MODERN) -> "zh_cn"     # 1.13+ 全小写风格
        ("en_US", "zh_cn", LEGACY) -> "zh_CN"     # 1.12.2- 主语言小写、区域大写
    """
    target = target_lang.lower().replace("-", "_")
    if style is LangStyle.LEGACY:
        parts = target.split("_")
        head = parts[0].lower()                       # 语言部分：小写（zh）
        tail = "_".join(p.upper() for p in parts[1:])  # 区域部分：大写（CN/TW）
        return f"{head}_{tail}" if tail else head
    return target


def _ref_to_dict(ref: LangFileRef) -> dict:
    """把 LangFileRef 转为可 JSON 序列化的字典（枚举 → 字符串）。"""
    return {
        "path_in_pkg": ref.path_in_pkg,
        "container": ref.container,
        "relative_dir": ref.relative_dir,
        "mod_id": ref.mod_id,
        "fmt": ref.fmt.value,
        "lang_code": ref.lang_code,
        "lang_style": ref.lang_style.value if ref.lang_style else None,
        "encoding": ref.encoding,
        "had_bom": ref.had_bom,
        "sha256": ref.sha256,
        "size": ref.size,
        "entry_count": ref.entry_count,
        "is_source_candidate": ref.is_source_candidate,
        "is_target_existing": ref.is_target_existing,
        "detected_by": ref.detected_by,
        "parse_status": ref.parse_status,
        "export_relative_path": ref.export_relative_path,
        "warnings": list(ref.warnings),
    }


def build_manifest(report: ScanReport) -> dict:
    """把扫描报告整理为 manifest 字典（路径映射表的内存形态）。"""
    return {
        "manifest_version": MANIFEST_VERSION,
        "tool": f"mc-i18n {__version__}",
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pack_root": report.pack_root,
        "pack_type": report.pack_type,
        "source_lang": report.source_lang,
        "target_lang": report.target_lang,
        "stats": asdict(report.stats),
        "warnings": list(report.warnings),
        # files：路径映射表主体；每个条目都带 export_relative_path，
        # 后续导出（F08）直接按该字段把译文文件写回原目录树对应位置
        "files": [_ref_to_dict(ref) for ref in report.files],
    }


def save_manifest(manifest: dict, path: Path) -> Path:
    """保存 manifest.json（UTF-8、缩进 2 空格、保留中文可读性）。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")  # 末尾换行，方便 git diff
    return path


def load_manifest(path: Path) -> dict:
    """加载 manifest.json。"""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)
