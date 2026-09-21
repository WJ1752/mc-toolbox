""".json 语言文件解析器（MC 1.13+）。

文件结构特征：
    - 标准 JSON 对象，键为语言键、值为字符串（原版要求扁平结构）；
    - jar 内原版/多数模组文件为【压缩单行】格式：{"a":"b","c":"d"}
    - 整合包作者手工维护的文件多为【缩进美化】格式（2 空格 / 4 空格 / Tab）
    - 部分工具导出会用 \\uXXXX 转义非 ASCII 字符（ensure_ascii 风格）
    - 文件可能以换行符结尾，也可能不带；Windows 编辑器可能产生 CRLF

无损策略（对应技术设计方案 §4.2.3）：
    解析时对原文件做"格式风格探测"，序列化时按探测结果复现排版：
        indent           缩进单元（2 空格 / 4 空格 / Tab）
        minified         压缩单行（无换行/无缩进 → separators=(',', ':')）
        ensure_ascii     非 ASCII 是否转义（原文纯 ASCII 而值含非 ASCII → 转义）
        trailing_newline 是否以换行符结尾
        crlf             CRLF 换行（dumps 输出后整体替换 \\n → \\r\\n）

已知边界（在 README 中向用户明示）：
    - 重复键：JSON 标准未定义；本解析器与 MC 的 Gson 行为对齐——
      保留首次出现的键位置、后值覆盖前值，并记录告警；
    - 值非字符串的键（个别模组违规嵌套）：原样保留、不参与翻译；
    - 异型排版（如逗号前后多余空格的"伪美化"格式）：序列化时按探测到的
      风格规范化重排；扫描器对"未修改文件"直接按字节复制，不会触碰它们。
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

from ...models import FileFormat, JsonStyle, LangFile
from .base import BaseParser

# 匹配"行首缩进 + 引号开头"的行，用于探测缩进单元
_INDENT_RE = re.compile(r"(?m)^[ \t]+")


class JsonParser(BaseParser):
    """.json 格式解析器（无状态，可安全复用）。"""

    fmt = FileFormat.JSON

    # ------------------------------------------------------------------ #
    # 解析
    # ------------------------------------------------------------------ #
    def parse(self, text: str) -> LangFile:
        """把 .json 语言文件文本解析为 LangFile。

        使用 object_pairs_hook 在反序列化过程中捕获重复键：
        与 Gson（MC 引擎实际使用的 JSON 库）行为一致——
        保留首次出现的键位置，后值覆盖前值，同时记录重复键告警。
        """
        parsed = LangFile(fmt=FileFormat.JSON)
        duplicate_keys: list[str] = []

        def _pairs_hook(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
            """json 反序列化的键值对钩子：检测重复键、保持插入顺序。"""
            obj: dict[str, Any] = {}
            for key, value in pairs:
                if key in obj:
                    duplicate_keys.append(key)  # 只记录，不中断（Gson 兼容行为）
                obj[key] = value                # 后值覆盖；dict 保序，位置为首次出现
            return obj

        # ---- 1) 反序列化（失败直接抛出，由扫描器捕获并标记 parse_status）----
        obj = json.loads(text, object_pairs_hook=_pairs_hook)
        if not isinstance(obj, dict):
            raise ValueError("语言文件顶层必须是 JSON 对象（{...}）")

        # ---- 2) 拆分条目：仅字符串值可翻译，其余原样保留 ----
        for key, value in obj.items():
            if isinstance(value, str):
                parsed.entries[key] = _entry_from_json(key, value)
            else:
                parsed.non_string_keys.append(key)
        if parsed.non_string_keys:
            parsed.warnings.append(
                f"{len(parsed.non_string_keys)} 个键的值不是字符串"
                f"（原样保留、不翻译）：{parsed.non_string_keys[:5]}..."
            )

        # ---- 3) 格式风格探测 ----
        parsed.obj = obj
        parsed.style = self._detect_style(text, obj)
        parsed.duplicate_keys = duplicate_keys
        if duplicate_keys:
            parsed.warnings.append(
                f"检测到 {len(duplicate_keys)} 个重复键（按 Gson 规则保留后值）："
                f"{list(dict.fromkeys(duplicate_keys))[:5]}..."
            )
        return parsed

    def _detect_style(self, raw: str, obj: dict[str, Any]) -> JsonStyle:
        """从原始文本探测 JSON 排版风格，供序列化时复现。

        探测顺序：CRLF 换行 → 缩进/压缩 → ensure_ascii → 尾部换行。
        """
        style = JsonStyle()

        # --- CRLF 检测：值内换行在 JSON 中必须转义为 \n（两个字符），
        #     因此原文中出现的"真实 \r\n 字节"只可能是排版换行 ---
        style.crlf = "\r\n" in raw

        # --- 缩进 / 压缩检测 ---
        # 压缩单行格式：没有任何一行以空白开头（jar 内原版文件即此形态）
        indent_match = _INDENT_RE.search(raw)
        if indent_match is None:
            style.minified = True
            style.indent = None
        else:
            # 第一个命中行即条目所在层（语言文件是扁平结构），
            # 其前导空白就是缩进单元（"  " / "    " / "\t"）
            style.minified = False
            style.indent = indent_match.group(0)

        # --- ensure_ascii 检测 ---
        # 原文纯 ASCII，而解析出的值里有非 ASCII 字符 → 原文件必然用了 \uXXXX 转义
        has_non_ascii_value = any(not v.isascii() for v in obj.values()
                                  if isinstance(v, str))
        style.ensure_ascii = raw.isascii() and has_non_ascii_value

        # --- 尾部换行检测 ---
        style.trailing_newline = raw.endswith("\n")
        return style

    # ------------------------------------------------------------------ #
    # 序列化
    # ------------------------------------------------------------------ #
    def serialize(self, file: LangFile, translations: Optional[dict[str, str]] = None) -> str:
        """按探测到的风格把对象序列化回文本。

        替换规则：
            - translations 中存在且原值为字符串的键 → 输出新译文；
            - 其余键（未翻译 / 非字符串值）→ 原值输出，键序保持不变。
        """
        style = file.style or JsonStyle()
        rebuilt: dict[str, Any] = {}
        for key, value in file.obj.items():
            if translations is not None and isinstance(value, str) and key in translations:
                rebuilt[key] = translations[key]   # 已翻译 → 译文
            else:
                rebuilt[key] = value               # 其余 → 原值（键序不变）

        # --- 按风格选择 dumps 参数 ---
        if style.minified:
            # 压缩单行：与 MC jar 内原版文件一致（无空格分隔）
            text = json.dumps(rebuilt, ensure_ascii=style.ensure_ascii,
                              separators=(",", ":"))
        else:
            # 缩进格式：json.dumps 在 indent 非 None 时自动使用 (',', ': ') 分隔符；
            # indent=""（空串）支持"有换行、无缩进"的罕见风格
            text = json.dumps(rebuilt, ensure_ascii=style.ensure_ascii,
                              indent=style.indent if style.indent is not None else "")

        # --- CRLF 复现：值内换行在 JSON 里必须是转义序列 \n（两字符），
        #     dumps 输出中的真实 \n 只可能是排版换行，整体替换是安全的 ---
        if style.crlf:
            text = text.replace("\n", "\r\n")

        # --- 尾部换行复现 ---
        if style.trailing_newline:
            text += "\r\n" if style.crlf else "\n"
        return text


def _entry_from_json(key: str, value: str):
    """把 JSON 条目包装为 LangEntry（行号字段对 JSON 无意义，填 -1）。

    独立成小函数是为了避免循环导入：models.LangEntry 由 models 统一管理。
    """
    from ...models import LangEntry

    return LangEntry(key=key, raw_key=key, raw_value=value, value=value)
