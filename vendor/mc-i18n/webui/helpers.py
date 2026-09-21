"""WebUI 无状态工具函数 —— 参数校验、路径换算与索引构建（v0.3.0 框架拆分）。

本模块函数全部是"输入 → 输出"的纯工具（仅 _review_index 带 TTL 缓存，
缓存本体存放在 state 模块），供 api.py 与 http.py 复用。
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path

from ..config import load_yaml_dict
from ..core.exporters import disk_path_for_ref, resolve_pack_output
from ..core.quests import find_translatable_strings
from ..core.scanner import ScanOptions, scan
from ..utils import decode_bytes
from . import state

logger = logging.getLogger(__name__)


def _json_bytes(data, status: int = 200) -> tuple[bytes, int, str]:
    return (json.dumps(data, ensure_ascii=False).encode("utf-8"),
            status, "application/json; charset=utf-8")


def _safe_pack(params_or_query: dict) -> Path:
    """提取并校验 pack 参数：必须是已存在的目录。"""
    pack = str(params_or_query.get("pack", "")).strip().strip('"').strip("'")
    if not pack:
        raise ValueError("缺少 pack 参数（整合包目录）")
    root = Path(pack)
    if not root.is_dir():
        raise FileNotFoundError(f"目录不存在：{pack}")
    return root


def _webui_config_path(pack: Path) -> Path:
    """WebUI 设置的持久化位置（CLI 不受影响，翻译线程显式加载它）。"""
    return pack / ".mc-i18n" / "config.yaml"


def _glossary_path(pack: Path) -> Path:
    return pack / "glossary.yaml"


def _read_text_file(path: Path) -> tuple[str, str, bool]:
    """读文件 → (文本, 编码, 是否有 BOM)，写回时用于保真。"""
    data = path.read_bytes()
    text, meta = decode_bytes(data)
    return text, str(meta.get("encoding", "utf-8")), bool(meta.get("had_bom"))


# -------------------------------------------------------------------------- #
# 汉化包产出位置解析（v0.2.8）：默认落在整合包 resourcepacks 文件夹内，
# 方便游戏直接启用；用户可在设置里自定义任意文件夹或 .zip 路径。
# -------------------------------------------------------------------------- #
def _resolve_pack_output(pack: Path, params: dict) -> Path:
    """根据请求参数解析汉化包（资源包）产出位置。

    params["pack_out"] 为空 / "auto" → 回退到整合包已保存配置
    （.mc-i18n/config.yaml 的 output.pack_out）；仍未指定则使用内置默认
    <整合包>/resourcepacks/mc-i18n-<target>/。这样即使工作台未切换到设置页、
    前端单选状态未同步，已保存的自定义产出位置依然生效。
    """
    target = str(params.get("target_lang") or "zh_cn")
    out = params.get("pack_out")
    if not out:
        cfg = _webui_config_path(pack)
        if cfg.is_file():
            try:
                data = load_yaml_dict(cfg.read_text(encoding="utf-8"))
                saved = (data or {}).get("output", {}) if isinstance(data, dict) else {}
                saved = saved.get("pack_out") if isinstance(saved, dict) else None
                if isinstance(saved, str) and saved.strip():
                    out = saved
            except Exception:  # noqa: BLE001
                pass
    return resolve_pack_output(
        pack, out, target_lang=target, pack_name=pack.name)


def _review_index(pack: Path, source_lang: str = "en_us",
                  target_lang: str = "zh_cn") -> dict[str, dict]:
    """实时扫描重建 [译文相对路径 -> 源文件引用] 映射（带 TTL 缓存）。"""
    key = f"{pack.resolve()}|{source_lang}|{target_lang}"
    now = time.time()
    hit = state._index_cache.get(key)
    if hit and now - hit[0] < state._INDEX_TTL:
        return hit[1]
    report = scan(pack, ScanOptions(
        source_lang=source_lang, target_lang=target_lang, include_jars=True))
    translated_root = pack / ".mc-i18n" / "translated"
    index: dict[str, dict] = {}
    for ref in report.files:
        if not ref.is_source_candidate:      # 只收录源候选（zh_cn 现存文件无对照意义）
            continue
        disk = disk_path_for_ref(translated_root, ref)
        try:
            rel = str(disk.relative_to(translated_root))
        except ValueError:                   # 导出根之外（理论不会发生），防御性跳过
            continue
        index[rel] = {
            "path_in_pkg": ref.path_in_pkg,
            "container": ref.container or "",
            "fmt": ref.fmt.value if hasattr(ref.fmt, "value") else str(ref.fmt),
        }
    state._index_cache[key] = (now, index)
    return index


def _detect_fmt(path: Path) -> str:
    return "lang" if path.suffix.lower() == ".lang" else "json"


def _find_snbt(pack: Path) -> list[dict]:
    """定位任务书：config/ftbquests 下的 chapters 优先，其余 .snbt 兜底。"""
    seen: dict[str, dict] = {}
    for pat in ("config/ftbquests/quests/chapters/*.snbt",
                "config/ftbquests/quests/chapters/**/*.snbt"):
        for p in sorted(pack.glob(pat)):
            seen[str(p.relative_to(pack))] = _snbt_stat(pack, p)
    if not seen:                       # 兜底：全包递归（排除备份目录）
        for p in sorted(pack.rglob("*.snbt")):
            rel = str(p.relative_to(pack))
            if "backup" in Path(rel).parts or rel.startswith(".mc-i18n"):
                continue
            seen[rel] = _snbt_stat(pack, p)
    return list(seen.values())


def _snbt_stat(pack: Path, p: Path) -> dict:
    try:
        text, _enc, _bom = _read_text_file(p)
        count = len(find_translatable_strings(text))
    except Exception:  # noqa: BLE001
        count = 0
    return {"path": str(p.relative_to(pack)), "count": count}
