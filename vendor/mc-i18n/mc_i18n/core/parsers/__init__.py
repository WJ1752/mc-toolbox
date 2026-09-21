"""解析引擎子包：.lang 与 .json 双格式无损解析器。

对外接口：
    get_parser(fmt)            按格式枚举取解析器实例
    get_parser_for_filename()  按文件名后缀取解析器实例
    PARSER_REGISTRY            格式 → 解析器类 的注册表

新增格式（如 M1 的 .snbt）时：实现 BaseParser 子类并在此注册即可，
核心扫描/导出流程无需改动（插件式扩展，对应设计文档 §1 可扩展性）。
"""

from __future__ import annotations

from ...models import FileFormat
from .base import BaseParser
from .json_parser import JsonParser
from .lang_parser import LangParser

# 格式注册表：FileFormat 枚举 → 解析器类
PARSER_REGISTRY: dict[FileFormat, type[BaseParser]] = {
    FileFormat.LANG: LangParser,
    FileFormat.JSON: JsonParser,
}

# 文件后缀（小写） → 格式枚举
_SUFFIX_MAP: dict[str, FileFormat] = {
    ".lang": FileFormat.LANG,
    ".json": FileFormat.JSON,
}

# 解析器实例缓存（解析器均为无状态实现，可安全复用）
_CACHE: dict[FileFormat, BaseParser] = {}


def get_parser(fmt: FileFormat) -> BaseParser:
    """按格式枚举获取（缓存的）解析器实例。"""
    if fmt not in PARSER_REGISTRY:
        raise KeyError(f"暂不支持的文件格式: {fmt!r}")
    if fmt not in _CACHE:
        _CACHE[fmt] = PARSER_REGISTRY[fmt]()
    return _CACHE[fmt]


def get_parser_for_filename(filename: str) -> BaseParser | None:
    """按文件名后缀获取解析器；无法识别的格式返回 None。"""
    lower = filename.lower()
    for suffix, fmt in _SUFFIX_MAP.items():
        if lower.endswith(suffix):
            return get_parser(fmt)
    return None


__all__ = [
    "BaseParser",
    "LangParser",
    "JsonParser",
    "PARSER_REGISTRY",
    "get_parser",
    "get_parser_for_filename",
]
