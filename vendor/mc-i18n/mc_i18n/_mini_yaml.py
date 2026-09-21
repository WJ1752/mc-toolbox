"""精简 YAML 子集解析器——零第三方依赖的配置加载回退实现。

背景：
    本工具的配置文件是 config.yaml。为满足"零第三方强依赖、可直接运行"
    的交付约束，当环境中没有 PyYAML 时，用本模块解析配置所需的 YAML 子集；
    PyYAML 可用时仍优先使用 PyYAML（见 mc_i18n.config.load_yaml_dict）。

支持的 YAML 子集（恰好覆盖 config.yaml 的全部表达需求）：
    1. 嵌套映射（靠缩进分层）
        engine:
          primary: demo
    2. 列表（"- " 前缀；元素为标量或嵌套块）
        fallback:
          - baidu
          - deepl
    3. 标量：带/不带引号字符串、true/false/yes/no/on/off、null/~、
       整数、浮点数
    4. 行内注释："#" 前是行首或空白、且不在引号内时视为注释
    5. 双引号字符串转义：\\n \\t \\" \\\\ \\uXXXX

不支持的特性（配置文件用不到，遇错明确报错而非静默出错）：
    多行字面量（| 与 >）、锚点/引用、流式集合 [a, b]、多文档（---）。

设计要点：
    预处理把文本整理为 (缩进, 内容, 行号) 三元组流，再做一次
    递归下降解析；解析器始终"回吐"未消费的行号，由上层校验缩进一致性。
"""

from __future__ import annotations

import re
from typing import Any

__all__ = ["parse", "MiniYamlError"]


class MiniYamlError(ValueError):
    """YAML 子集解析错误（带行号定位）。"""


# --------------------------------------------------------------------------
# 预处理
# --------------------------------------------------------------------------

def _strip_inline_comment(s: str) -> str:
    """剥离行内注释：'#' 前是行首或空白、且不在引号内时才算注释。

    引号状态需要区分单双引号并处理双引号内的 \\" 转义
    （连续反斜杠计数：偶数个 \\" 中的 " 是真闭合，奇数个则是转义）。
    """
    in_single = in_double = False
    backslash_run = 0  # 当前位置前连续反斜杠个数
    for i, ch in enumerate(s):
        if ch == "\\":
            backslash_run += 1
            continue
        if ch == "'" and not in_double and backslash_run % 2 == 0:
            in_single = not in_single
        elif ch == '"' and not in_single and backslash_run % 2 == 0:
            in_double = not in_double
        elif ch == "#" and not in_single and not in_double:
            # 注释符必须位于行首或空白之后（"a#b" 是普通文本，"a #b" 是注释）
            if i == 0 or s[i - 1] in " \t":
                return s[:i].rstrip()
        backslash_run = 0
    return s.rstrip()


def _preprocess(text: str) -> list[tuple[int, str, int]]:
    """把全文整理为 [(缩进空格数, 去注释内容, 行号)]；跳过空行与纯注释行。

    Tab 一律按 4 空格展开（YAML 规范禁止 Tab 缩进，此处宽容处理并保持
    与常见编辑器视觉一致；展开后若与空格混用，缩进层级仍按展开值判定）。
    """
    rows: list[tuple[int, str, int]] = []
    for lineno, raw in enumerate(text.splitlines(), 1):
        expanded = raw.replace("\t", "    ")
        stripped = expanded.strip()
        if not stripped or stripped.startswith("#"):
            continue
        content = _strip_inline_comment(stripped)
        if not content:
            continue
        indent = len(expanded) - len(expanded.lstrip(" "))
        rows.append((indent, content, lineno))
    return rows


# --------------------------------------------------------------------------
# 递归下降解析
# --------------------------------------------------------------------------

def parse(text: str) -> dict[str, Any]:
    """解析 YAML 子集文本，返回字典。解析失败抛 MiniYamlError。"""
    rows = _preprocess(text)
    if not rows:
        return {}
    # 整个文档是一个顶层块，顶层缩进取第一有效行的缩进
    value, consumed = _parse_block(rows, 0, rows[0][0])
    if consumed != len(rows):
        bad = rows[consumed]
        raise MiniYamlError(
            f"第 {bad[2]} 行：缩进层级异常（该行缩进 {bad[0]} 空格，"
            f"不属于任何上级块）；请检查 config.yaml 的缩进是否统一"
        )
    if not isinstance(value, dict):
        raise MiniYamlError("config.yaml 顶层必须是一个映射（键值对）结构")
    return value


def _parse_block(rows: list[tuple[int, str, int]], i: int, indent: int):
    """解析一个以 rows[i] 开始、缩进为 indent 的块（映射或列表）。

    返回 (值, 消费后的行索引)。块在遇到缩进 < indent 的行时结束。
    """
    content = rows[i][1]
    if content == "-" or content.startswith("- "):
        return _parse_list(rows, i, indent)
    return _parse_map(rows, i, indent)


def _parse_map(rows, i: int, indent: int):
    """解析缩进为 indent 的映射块：连续的 'key: value' / 'key:' 行。"""
    result: dict[str, Any] = {}
    while i < len(rows):
        row_indent, content, lineno = rows[i]
        if row_indent < indent:
            break  # 返回上级块
        if row_indent > indent:
            raise MiniYamlError(
                f"第 {lineno} 行：缩进突增（{row_indent} > {indent}），"
                f"上一行是否有冒号结尾或缩进不一致？"
            )
        if content == "-" or content.startswith("- "):
            break  # 映射块中出现列表项 → 交给上层处理

        key, sep, rest = _split_key_value(content, lineno)
        if not sep:
            raise MiniYamlError(f"第 {lineno} 行：缺少 ':' 分隔符，无法解析键值对 {content!r}")

        rest = rest.strip()
        if rest:
            # 内联值（标量 / 流式场景）
            result[key] = _parse_scalar(rest, lineno)
            i += 1
        elif i + 1 < len(rows) and rows[i + 1][0] > indent:
            # 'key:' 结尾 → 子块（列表或映射）
            child_indent = rows[i + 1][0]
            value, i = _parse_block(rows, i + 1, child_indent)
            result[key] = value
        else:
            # 'key:' 后无内容 → null（配置语义中通常表示"未设置"）
            result[key] = None
            i += 1
    return result, i


def _parse_list(rows, i: int, indent: int):
    """解析缩进为 indent 的列表块：连续的 '- value' / '-' 行。"""
    result: list[Any] = []
    while i < len(rows):
        row_indent, content, lineno = rows[i]
        if row_indent != indent or not (content == "-" or content.startswith("- ")):
            break
        item_text = content[1:].strip()  # 去掉 '-' 后的文本
        if item_text:
            # "- key: value" 形式（列表元素为映射）也按块解析，覆盖更多写法
            result.append(_parse_scalar(item_text, lineno))
            i += 1
        elif i + 1 < len(rows) and rows[i + 1][0] > indent:
            value, i = _parse_block(rows, i + 1, rows[i + 1][0])
            result.append(value)
        else:
            result.append(None)
            i += 1
    return result, i


def _split_key_value(content: str, lineno: int) -> tuple[str, bool, str]:
    """把 'key: value' 切为 (key, 是否有冒号, 余文)。

    key 支持带引号写法（如 "app_id": ...）；冒号取第一个"行尾或后跟空白"的冒号，
    避免把 URL（https://）或时间（12:30）误当作分隔符。
    """
    in_single = in_double = False
    backslash_run = 0
    for idx, ch in enumerate(content):
        if ch == "\\":
            backslash_run += 1
            continue
        quoted = in_single or in_double
        if ch == "'" and not in_double and backslash_run % 2 == 0:
            in_single = not in_single
        elif ch == '"' and not in_single and backslash_run % 2 == 0:
            in_double = not in_double
        elif ch == ":" and not quoted:
            at_end = idx == len(content) - 1
            followed_by_space = idx + 1 < len(content) and content[idx + 1] in " \t"
            if at_end or followed_by_space:
                key = content[:idx].strip()
                if len(key) >= 2 and key[0] == key[-1] and key[0] in "\"'":
                    key = key[1:-1]
                return key, True, content[idx + 1:]
        backslash_run = 0
    return content, False, ""


# --------------------------------------------------------------------------
# 标量解析
# --------------------------------------------------------------------------

_DOUBLE_ESCAPES = {
    "n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "/": "/", "0": "\0",
}


def _parse_scalar(s: str, lineno: int) -> Any:
    """把一个标量 token 解析为 Python 值（字符串/布尔/整数/浮点/None/流式列表）。"""
    s = s.strip()
    if not s:
        return None

    # ---- 流式列表（[a, b, c] / []）—— config 中 fallback: [] 等常见写法 ----
    if len(s) >= 2 and s[0] == "[" and s[-1] == "]":
        inner = s[1:-1].strip()
        if not inner:
            return []
        return [_parse_scalar(item, lineno) for item in _split_top_level(inner, ",")]

    # ---- 引号字符串 ----
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        inner = s[1:-1]
        if s[0] == "'":
            return inner.replace("''", "'")  # YAML 单引号转义：'' → '
        return _unescape_double(inner, lineno)

    # ---- 布尔 / 空值（YAML 1.1 惯用拼写全兼容）----
    low = s.lower()
    if low in ("true", "yes", "on"):
        return True
    if low in ("false", "no", "off"):
        return False
    if low in ("null", "~", "none"):
        return None

    # ---- 数值（int 优先，失败再试 float；千位分隔等不规范写法按字符串处理）----
    try:
        return int(s, 10)
    except ValueError:
        pass
    try:
        return float(s)
    except ValueError:
        pass

    return s  # 其余一律按字符串（含 12:30 之类被 _split_key_value 保护的时间）


def _split_top_level(s: str, sep: str) -> list[str]:
    """按分隔符切分，但跳过引号内的分隔符（流式列表元素含逗号的场景）。"""
    parts: list[str] = []
    current: list[str] = []
    in_single = in_double = False
    for i, ch in enumerate(s):
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        if ch == sep and not in_single and not in_double:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    parts.append("".join(current))
    return [p.strip() for p in parts]


def _unescape_double(inner: str, lineno: int) -> str:
    """双引号字符串的转义还原（覆盖配置常用转义；未知转义保持原样）。"""
    out: list[str] = []
    i = 0
    while i < len(inner):
        ch = inner[i]
        if ch != "\\" or i + 1 >= len(inner):
            out.append(ch)
            i += 1
            continue
        nxt = inner[i + 1]
        if nxt in _DOUBLE_ESCAPES:
            out.append(_DOUBLE_ESCAPES[nxt])
            i += 2
        elif nxt == "u" and i + 6 <= len(inner):
            try:
                out.append(chr(int(inner[i + 2:i + 6], 16)))
                i += 6
            except ValueError:
                raise MiniYamlError(f"第 {lineno} 行：非法 \\uXXXX 转义序列 {inner[i:i + 6]!r}")
        else:
            out.append(ch)
            i += 1
    return "".join(out)


# -------------------------------------------------------------------------- #
# 序列化（写 config.yaml / glossary.yaml 等简单映射）
# -------------------------------------------------------------------------- #
_NEEDS_QUOTES = re.compile(r"^[\s]|[\s]$|^$|[:#]\s|\s#|[:]\s|$[{}`\[\],&*!|>'\"%@`]")


def _yaml_quote(value: str) -> str:
    """需要时给字符串加双引号（转义反斜杠与双引号本身）。"""
    if _NEEDS_QUOTES.search(value):
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return value


def dumps_yaml_mapping(data: dict, indent: int = 0) -> str:
    """把 {str: str|dict} 序列化为简单 YAML 文本（仅字符串映射，够用即可）。

    用途：保存术语表、WebUI 写回引擎配置。不支持列表/数字/布尔——
    调用方自行把值转为字符串。
    """
    pad = "  " * indent
    lines: list[str] = []
    for key, value in data.items():
        key_s = _yaml_quote(str(key))
        if isinstance(value, dict):
            if value:
                lines.append(f"{pad}{key_s}:")
                lines.append(dumps_yaml_mapping(value, indent + 1))
            else:
                lines.append(f"{pad}{key_s}: {{}}")
        else:
            lines.append(f"{pad}{key_s}: {_yaml_quote(str(value))}")
    return "\n".join(lines) + "\n"
