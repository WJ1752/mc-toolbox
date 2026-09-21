"""解析器抽象基类。

所有格式解析器都遵循技术设计方案 §4.2 的核心纪律：

    【不重建，只替换】
    - 解析：把原文件拆成"可翻译条目 + 结构骨架"两部分；
    - 序列化：按骨架逐段回放，仅把"被翻译的条目值"替换为译文；
    - 未修改的条目/注释/空行/缩进/换行符一律原样回放，
      从而保证 parse → serialize 往返的字节级还原（验收指标 A2）。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Optional

from ...models import FileFormat, LangFile


class BaseParser(ABC):
    """格式解析器抽象基类。

    子类必须实现 parse() 与 serialize()，并保证：

        serialize(parse(text)) == text          # 未修改场景，字节级往返恒等
        serialize(parse(text), 译文表)           # 仅替换译文值，其余结构不变
    """

    #: 本解析器对应的文件格式（子类覆盖）
    fmt: FileFormat

    @abstractmethod
    def parse(self, text: str) -> LangFile:
        """把文本解析为 LangFile。

        参数:
            text: 已解码的文件全文（编码处理由扫描器/调用方完成）
        返回:
            LangFile，包含条目表与无损重建所需的结构信息
        """

    @abstractmethod
    def serialize(self, file: LangFile, translations: Optional[dict[str, str]] = None) -> str:
        """把 LangFile 序列化回文本。

        参数:
            file: parse() 的产物
            translations: 译文表 {语言键: 新值}；None 或不含某键时，该键所在行
                          按原文件内容原样回放（保证往返恒等）
        返回:
            序列化后的完整文本
        """

    def parse_and_count(self, text: str) -> tuple[LangFile, int]:
        """便捷方法：解析并返回 (解析结果, 可翻译条目数)。"""
        parsed = self.parse(text)
        return parsed, len(parsed.entries)
