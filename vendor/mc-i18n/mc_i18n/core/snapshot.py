"""增量更新快照模块（"mod 升级只翻新增"功能的地基）。

场景：整合包的 mod 升级后，语言文件里大部分条目没变，只有少量新增/
修改。翻译缓存（sha256 键）天然只对变化条目调 API —— 本模块在此之上
提供"可见的增量"：

    1. 每次翻译完成后，把本次全部唯一原文的指纹（sha256）存入
       <整合包>/.mc-i18n/snapshot.json；
    2. 下次运行时与旧快照对比，得到"新增条目数"写入翻译报告，
       GUI 校对台用它提供"只看本次新增"过滤。

指纹只与原文文本相关（不含引擎/语言），mod 换引擎、换目标语言后
增量语义依然正确。
"""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger("mc_i18n.snapshot")

SNAPSHOT_NAME = "snapshot.json"
__all__ = ["SNAPSHOT_NAME", "fingerprint", "load_snapshot", "save_snapshot"]


def fingerprint(source: str) -> str:
    """原文文本 → 稳定指纹（sha256 hex，只取决于文本本身）。"""
    return hashlib.sha256(source.encode("utf-8")).hexdigest()


def snapshot_path(pack_root: Path) -> Path:
    return Path(pack_root) / ".mc-i18n" / SNAPSHOT_NAME


def load_snapshot(pack_root: Path) -> set[str]:
    """读取上次快照的指纹集合；文件不存在/损坏返回空集（首次运行）。"""
    path = snapshot_path(pack_root)
    if not path.is_file():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        keys = data.get("keys", [])
        if isinstance(keys, list):
            return {str(k) for k in keys}
    except Exception as exc:  # noqa: BLE001 - 快照损坏只降级为"全部视为新增"
        logger.warning("快照读取失败（视为首次运行）：%s", exc)
    return set()


def save_snapshot(pack_root: Path, fingerprints: set[str]) -> None:
    """写入本次运行的指纹集合（翻译成功结束后调用）。"""
    path = snapshot_path(pack_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "saved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "count": len(fingerprints),
        "keys": sorted(fingerprints),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1),
                    encoding="utf-8")


def diff_new(current: set[str], previous: set[str]) -> set[str]:
    """本次新增 = 当前集合 - 上次集合。"""
    return current - previous
