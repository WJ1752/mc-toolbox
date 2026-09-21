"""FTB Quests 任务书翻译模块（GUI"任务书"页的底层引擎）。

FTB Quests 是整合包任务系统的事实标准，任务文本保存在
config/ftbquests/quests/chapters/*.snbt 文件中（SNBT = 文本化 NBT）。
这是整合包汉化最费人力的部分：标题/描述动辄上千条，且嵌在结构化
数据里，直接整文件送翻译会破坏格式。

本模块采用【字节段替换】策略（与 .lang/.json 解析器的"无损"思想一致，
但更彻底 —— 连行结构都不重建）：

    1. find_translatable_strings：状态机扫描，只定位
       title / subtitle / description 三个字段下的字符串值的字节区间，
       其余内容（物品 id、任务类型、坐标、图标……）完全不碰；
    2. 对每个命中的字符串：SNBT 反转义 → 占位符保护（含术语表）
       → 批量送翻译引擎 → 还原 → 术语回填 → SNBT 转义；
    3. 按字节区间从后往前替换 —— 未命中的内容逐字节保持原样。

SNBT 字符串转义遵循 Minecraft 原版规范：\\" \\\\ \\n \\t \\r \\b \\f \\'。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable

from .glossary import Glossary
from .placeholders import PlaceholderGuard

# 可翻译字段白名单：宁缺勿滥，物品 id / 任务类型 / 图标等一律不动
TEXT_KEYS = frozenset({"title", "subtitle", "description"})

# SNBT 转义映射（Minecraft 原版 SNBT 字符串支持的转义集合）
_UNESCAPE_MAP = {
    '"': '"', "\\": "\\", "n": "\n", "t": "\t",
    "r": "\r", "b": "\b", "f": "\f", "'": "'",
}
_ESCAPE_MAP = {
    "\\": "\\\\", '"': '\\"', "\n": "\\n", "\t": "\\t",
    "\r": "\\r", "\b": "\\b", "\f": "\\f",
}

# 裸标识符（key 名）：字母/数字/下划线/连字符
_IDENT_RE = re.compile(r"[A-Za-z0-9_-]+")


@dataclass
class SnbtStringSpan:
    """一个可翻译字符串值在 SNBT 文本中的位置与内容。"""

    key: str        # 归属字段：title / subtitle / description
    value: str      # 反转义后的字符串值
    start: int      # 开引号之后的位置（内容首字符）
    end: int        # 闭引号之前的位置（内容尾字符 + 1）


def snbt_unescape(raw: str) -> str:
    """SNBT 字符串内容 → 逻辑值（处理转义序列）。"""
    if "\\" not in raw:
        return raw
    out: list[str] = []
    i, n = 0, len(raw)
    while i < n:
        ch = raw[i]
        if ch == "\\" and i + 1 < n:
            out.append(_UNESCAPE_MAP.get(raw[i + 1], raw[i + 1]))
            i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def snbt_escape(value: str) -> str:
    """逻辑值 → SNBT 字符串内容（转义引号/反斜杠/控制字符）。"""
    out: list[str] = []
    for ch in value:
        out.append(_ESCAPE_MAP.get(ch, ch))
    return "".join(out)


def find_translatable_strings(text: str) -> list[SnbtStringSpan]:
    """单遍状态机扫描：定位可翻译字符串的字节区间。

    上下文跟踪规则：
    - current_key：最近一次出现的 `identifier:` 键名；
    - 进入 `[` 时：若 current_key 是可翻译字段则记住为 bracket_key
      （数组元素字符串归属它，如 description: ["...", "..."]）；
    - 进入 `{` 时：清空 current_key 与 bracket_key（对象边界，
      防止 tasks:[{...}] 里的物品 id 被误判为 description 元素）。

    引号内的转义字符（\\" \\\\）不终止字符串。
    """
    spans: list[SnbtStringSpan] = []
    i, n = 0, len(text)
    current_key: str | None = None
    bracket_key: str | None = None
    in_string = False
    content_start = 0

    while i < n:
        ch = text[i]
        if in_string:
            if ch == "\\":          # 跳过转义序列的下一个字符
                i += 2
                continue
            if ch == '"':           # 字符串结束
                in_string = False
                owner = bracket_key or current_key
                if owner in TEXT_KEYS:
                    spans.append(SnbtStringSpan(
                        owner, snbt_unescape(text[content_start:i]),
                        content_start, i,
                    ))
            i += 1
            continue

        if ch == '"':               # 字符串开始
            in_string = True
            content_start = i + 1
            i += 1
            continue

        match = _IDENT_RE.match(text, i)
        if match:                   # 裸标识符：判断是否 `key:`
            j = match.end()
            k = j
            while k < n and text[k] in " \t\r\n":
                k += 1
            if k < n and text[k] == ":":
                current_key = match.group(0)
                i = k + 1
            else:                   # 普通裸词（bare value），忽略
                i = j
            continue

        if ch == "[":
            bracket_key = current_key if current_key in TEXT_KEYS else None
            current_key = None
            i += 1
            continue
        if ch == "]":
            bracket_key = None
            i += 1
            continue
        if ch == "{":
            current_key = None
            bracket_key = None
            i += 1
            continue
        i += 1

    return spans


def _default_guard() -> PlaceholderGuard:
    return PlaceholderGuard()


def translate_snbt(text: str,
                   translate_batch: Callable[[list[str]], list[str]],
                   guard: PlaceholderGuard | None = None,
                   glossary: Glossary | None = None,
                   glossary_as_instructions: bool = False,
                   ) -> tuple[str, int, int]:
    """翻译一个 SNBT 文件中的全部可翻译字符串。

    translate_batch：受保护文本列表 → 引擎输出列表（调用方负责引擎与
    分批策略；异常向上抛出，由调用方决定整文件回退）。

    glossary_as_instructions：True 时术语不做 token 保护（LLM 引擎路线，
    由调用方把术语表注入引擎 prompt——见 engines/base.py set_glossary），
    只保留真占位符保护；译文回来后仍走 apply_after_restore 统一兜底。

    返回 (新文本, 成功条数, 失败条数)；还原失败的条目保留原文。
    """
    guard = guard or _default_guard()
    spans = find_translatable_strings(text)
    if not spans:
        return text, 0, 0

    terms = () if glossary_as_instructions else (
        glossary.literal_terms() if glossary else ())
    protected_list: list[str] = []
    tokens_list: list[list[str]] = []
    for sp in spans:
        protected, tokens = guard.protect(sp.value, terms)
        protected_list.append(protected)
        tokens_list.append(tokens)

    outputs = translate_batch(protected_list)
    if len(outputs) != len(spans):
        raise ValueError(f"引擎返回数量不符：发送 {len(spans)}，返回 {len(outputs)}")

    # 从最后一个 span 往前替换（前面的区间不受影响），逐字节保留其余内容
    result = text
    ok = failed = 0
    for sp, output, tokens in zip(reversed(spans), reversed(outputs),
                                  reversed(tokens_list)):
        try:
            restored = guard.restore(output, tokens)
            if glossary is not None:
                restored = glossary.apply_after_restore(restored)
            new_content = snbt_escape(restored)
            ok += 1
        except Exception:       # noqa: BLE001 - 单条失败保留原文（NEEDS_HUMAN 语义）
            failed += 1
            continue            # 不替换该区间（原文原样保留）
        result = result[:sp.start] + new_content + result[sp.end:]

    return result, ok, failed
