"""翻译缓存系统（对应 PRD F06 / F13 断点续翻）。

设计：
    - 存储：SQLite 单文件（WAL 模式，读写并发友好），随包存放在
      <整合包>/.mc-i18n/cache.sqlite3（"." 开头目录天然不被扫描器命中）；
    - 键：sha256(source_text + '\x00' + target_lang + '\x00' + engine + '\x00' + model)
      —— 引擎名参与哈希 → 不同引擎的译文互不污染（引擎隔离）；
      原文参与哈希 → 占位符结构变化（protect 后文本不同）自动视为新键；
    - 断点续翻：缓存天然实现——翻译中断后重新运行，已入库的条目全部
      命中，只有未完成的部分会真正调用 API；
    - 强制重翻：调用方不查缓存（--force）即等价于全部 miss；
    - 线程安全：sqlite3 连接跨线程复用 + threading.Lock 串行化写读。
"""

from __future__ import annotations

import hashlib
import sqlite3
import threading
import time
from pathlib import Path

__all__ = ["TranslationCache", "NullCache", "make_key"]

# 表结构：cache 存译文主体；meta 存任务级元数据（最近一次使用的语言/引擎等）
_SCHEMA = """
CREATE TABLE IF NOT EXISTS cache (
    key         TEXT PRIMARY KEY,      -- sha256 复合键
    source      TEXT NOT NULL,         -- 受保护原文（便于人工审查缓存内容）
    translated  TEXT NOT NULL,         -- 引擎返回的受保护译文
    target_lang TEXT NOT NULL,
    engine      TEXT NOT NULL,
    model       TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL,         -- unix 时间戳（TTL 判定用）
    hits        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cache_engine ON cache(engine, target_lang);
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def make_key(source_text: str, target_lang: str, engine: str, model: str = "") -> str:
    """构造缓存键：sha256(原文 \x00 目标语言 \x00 引擎 \x00 模型)。

    注意：传入的 source_text 应当是【占位符保护后】的文本，
    这样"同一原文 + 不同占位符结构"（理论上不可能，防御性设计）或
    保护开关变化导致的受保护文本差异都会被视为不同的缓存条目。
    """
    raw = "\x00".join((source_text, target_lang, engine, model))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class NullCache:
    """空缓存对象（--no-cache / cache.enabled=false 时使用）。

    与 TranslationCache 同接口，让流水线无需分支判断。
    """

    enabled = False

    def get(self, key: str) -> str | None:  # noqa: ARG002
        return None

    def put(self, key: str, source: str, translated: str,
            target_lang: str, engine: str, model: str = "") -> None:  # noqa: ARG002
        return None

    def stats(self) -> tuple[int, int]:
        return 0, 0

    def set_meta(self, key: str, value: str) -> None:
        return None

    def close(self) -> None:
        return None


class TranslationCache:
    """SQLite 翻译缓存（线程安全；一实例对应一个数据库文件）。"""

    enabled = True

    def __init__(self, db_path: str | Path, *, ttl_days: int = 0):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._ttl_seconds = max(0, ttl_days) * 86400
        self._lock = threading.Lock()
        # check_same_thread=False：允许工作线程访问；实际并发安全由 _lock 保证
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")   # 读写并发性能
        self._conn.execute("PRAGMA synchronous=NORMAL") # 断电最多丢最后一事务，可接受
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    # ------------------------------------------------------------------
    # 读写
    # ------------------------------------------------------------------
    def get(self, key: str) -> str | None:
        """按键取译文；命中时 hits+1，超过 TTL 视为未命中并删除。"""
        with self._lock:
            row = self._conn.execute(
                "SELECT translated, created_at FROM cache WHERE key = ?", (key,)
            ).fetchone()
            if row is None:
                return None
            translated, created_at = row
            if self._ttl_seconds and (time.time() - created_at) > self._ttl_seconds:
                self._conn.execute("DELETE FROM cache WHERE key = ?", (key,))
                self._conn.commit()
                return None
            self._conn.execute("UPDATE cache SET hits = hits + 1 WHERE key = ?", (key,))
            self._conn.commit()
            return translated

    def put(self, key: str, source: str, translated: str,
            target_lang: str, engine: str, model: str = "") -> None:
        """写入/覆盖一条缓存（占位符还原成功后才允许入库——纪律在流水线层执行）。"""
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO cache"
                " (key, source, translated, target_lang, engine, model, created_at, hits)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
                (key, source, translated, target_lang, engine, model, time.time()),
            )
            self._conn.commit()

    # ------------------------------------------------------------------
    # 元数据（供 report / CLI 展示"上次任务"信息）
    # ------------------------------------------------------------------
    def set_meta(self, key: str, value: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value)
            )
            self._conn.commit()

    def get_meta(self, key: str) -> str | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM meta WHERE key = ?", (key,)
            ).fetchone()
            return row[0] if row else None

    # ------------------------------------------------------------------
    # 统计与清理
    # ------------------------------------------------------------------
    def stats(self) -> tuple[int, int]:
        """返回 (缓存条目总数, 累计命中次数)。"""
        with self._lock:
            total = self._conn.execute("SELECT COUNT(*) FROM cache").fetchone()[0]
            hits = self._conn.execute("SELECT COALESCE(SUM(hits), 0) FROM cache").fetchone()[0]
        return int(total), int(hits)

    def clear(self) -> int:
        """清空全部缓存，返回被删除的条目数。"""
        with self._lock:
            deleted = self._conn.execute("SELECT COUNT(*) FROM cache").fetchone()[0]
            self._conn.execute("DELETE FROM cache")
            self._conn.commit()
        return int(deleted)

    def close(self) -> None:
        """关闭数据库连接（流水线结束时调用；WAL 文件随之合并）。"""
        with self._lock:
            self._conn.close()
