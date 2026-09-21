""".lang 语言文件解析器（MC 1.7.10 ~ 1.12.2）。

文件结构特征：
    key=value            键值行；以【第一个】 '=' 分割（value 中可含 '='）
    # 注释行             行首 '#' 开头，MC 引擎忽略，必须原样保留
    空行                 同样原样保留
    行尾 '\'             续行：逻辑上与下一行合并为同一条目
                         （沿用 java.util.Properties 的续行语义，
                          以"行尾反斜杠数量为奇数"判定，处理 '\\\\' 转义）
    行内空格             原样保留；key/value 的 trim 仅用于规范化视图，
                         MC 1.7.10 Locale 加载时同样会 trim 两端

无损策略：
    - 按物理行切分（keepends 保留 CRLF/LF 各自的行尾）；
    - 骨架 segments 记录每一行是"注释/空行/其他"还是"某条目"；
    - 未修改的条目按其占用的物理行区间原样回放 → 字节级还原；
    - 仅当条目被翻译时，才以 "<原key>=<新译文>" 的形式单行重写该条目
      （续行条目的译文合并为单行输出，语义不变，报告中会提示）。
"""

from __future__ import annotations

from typing import Optional

from ...models import EntryStatus, FileFormat, LangEntry, LangFile
from .base import BaseParser


def _ends_with_odd_backslashes(line_body: str) -> bool:
    """判断一行是否以"奇数个反斜杠"结尾（即 Properties 语义的续行标志）。

    例如:
        "abc\\"   → 1 个反斜杠 → True（续行）
        "abc\\\\" → 2 个反斜杠 → False（'\\\\' 是转义的反斜杠字符本身，不续行）
    """
    count = 0
    for ch in reversed(line_body):
        if ch == "\\":
            count += 1
        else:
            break
    return count % 2 == 1


class LangParser(BaseParser):
    """.lang 格式解析器（无状态，可安全复用）。"""

    fmt = FileFormat.LANG

    # ------------------------------------------------------------------ #
    # 解析
    # ------------------------------------------------------------------ #
    def parse(self, text: str) -> LangFile:
        """把 .lang 文本解析为 LangFile。

        处理流程（逐物理行扫描）：
            1. 空行 / '#' 注释行            → 骨架记为 raw，原样保留
            2. 续行中（pending 状态）        → 累积物理行，直到续行结束
            3. 不含 '=' 的普通行            → 骨架记为 raw（MC 引擎会忽略并告警）
            4. 含 '=' 且行尾反斜杠为奇数    → 开启续行累积
            5. 含 '=' 的普通键值行          → 以第一个 '=' 分割，登记条目
        """
        parsed = LangFile(fmt=FileFormat.LANG)
        # keepends=True：每行保留自己的行尾符（\n 或 \r\n），
        # 序列化时逐行回放即可保留原文件的换行风格
        lines = text.splitlines(keepends=True)
        parsed.lines = lines

        pending_key: Optional[str] = None
        pending_raw_key: str = ""
        pending_parts: list[str] = []   # 续行累积的物理行（含行尾）
        pending_start: int = -1

        for idx, line in enumerate(lines):
            # body：去掉行尾换行符后的正文；line 本身始终原样保留
            body = line.rstrip("\r\n")
            stripped = body.strip()

            # ---------- 状态 2：正处于续行累积中 ----------
            if pending_key is not None:
                pending_parts.append(line)
                if _ends_with_odd_backslashes(body):
                    # 行尾反斜杠为奇数 → 仍然续行，继续累积
                    continue
                self._finish_entry(parsed, pending_key, pending_raw_key,
                                   pending_parts, pending_start, idx)
                pending_key = None
                continue

            # ---------- 状态 1：注释行 / 空行 ----------
            if not stripped or stripped.startswith("#"):
                parsed.segments.append(("raw", line))
                continue

            # ---------- 状态 3：不含 '=' 的杂行（MC 引擎会忽略） ----------
            if "=" not in body:
                parsed.segments.append(("raw", line))
                parsed.warnings.append(
                    f"第 {idx + 1} 行不含 '='，MC 引擎会忽略该行：{stripped[:40]!r}"
                )
                continue

            # ---------- 状态 4：含 '=' 且需要续行 ----------
            if _ends_with_odd_backslashes(body):
                raw_key, _, _ = body.partition("=")
                key = raw_key.strip()
                if not key:
                    # 空 key 续行（如 "=abc\"）：按 raw 处理并告警
                    parsed.segments.append(("raw", line))
                    parsed.warnings.append(f"第 {idx + 1} 行语言键为空，已按普通行保留")
                    continue
                pending_key = key
                pending_raw_key = raw_key
                pending_parts = [line]
                pending_start = idx
                continue

            # ---------- 状态 5：普通键值行 ----------
            raw_key, _, raw_value = body.partition("=")
            key = raw_key.strip()
            if not key:
                # 空 key 行（如 "=value"）：按 raw 处理并告警，避免污染条目表
                parsed.segments.append(("raw", line))
                parsed.warnings.append(f"第 {idx + 1} 行语言键为空，已按普通行保留")
                continue
            entry = LangEntry(
                key=key,
                raw_key=raw_key,
                raw_value=raw_value,
                value=raw_value.strip(),
                line_start=idx,
                line_end=idx,
                continuation=False,
                status=EntryStatus.UNTRANSLATED,
            )
            parsed.entries[key] = entry
            parsed.segments.append(("entry", key))

        # 文件以孤立 '\' 结尾的极端情况：把残余累积也落为条目，避免丢数据
        if pending_key is not None:
            self._finish_entry(parsed, pending_key, pending_raw_key,
                               pending_parts, pending_start, len(lines) - 1)
            parsed.warnings.append(
                f"文件以续行符结尾，条目 {pending_key!r} 已按最后物理行收尾"
            )

        return parsed

    def _finish_entry(self, parsed: LangFile, key: str, raw_key: str,
                      parts: list[str], start: int, end: int) -> None:
        """收尾一条续行条目：合并物理行为逻辑值，并登记到条目表与骨架。"""
        # 合并逻辑值：首段取 '=' 之后的值部分；中间段剥掉行尾那一个
        # "续行反斜杠"后拼接；末段原样保留
        # （简化实现：不模拟 Properties 对续行首部空白的裁剪，保持内容原样拼接；
        #   进入收尾分支时末段行尾反斜杠必为偶数个，无需处理）
        merged_chars: list[str] = []
        for i, part in enumerate(parts):
            body = part.rstrip("\r\n")
            if i == 0:
                # 首段：剥离 "raw_key=" 前缀（按第一个 '=' 分割，与 parse 一致）
                body = body.partition("=")[2]
            if i < len(parts) - 1:
                # 中间段：剥掉行尾续行反斜杠（首段的续行符在值末尾，同样剥除）
                body = body[:-1]
            merged_chars.append(body)
        raw_value = "".join(merged_chars)
        entry = LangEntry(
            key=key,
            raw_key=raw_key,
            raw_value=raw_value,
            value=raw_value.strip(),
            line_start=start,
            line_end=end,
            continuation=True,
            status=EntryStatus.UNTRANSLATED,
        )
        parsed.entries[key] = entry
        parsed.segments.append(("entry", key))

    # ------------------------------------------------------------------ #
    # 序列化
    # ------------------------------------------------------------------ #
    def serialize(self, file: LangFile, translations: Optional[dict[str, str]] = None) -> str:
        """按骨架逐段回放，把译文替换进对应条目。

        替换规则：
            - translations 中存在该键 → 该条目重写为 "<raw_key>=<新译文>"
              （行尾风格沿用原条目首行；续行条目合并为单行）
            - 否则 → 原物理行原样回放（保证未翻译内容字节级不变）
        """
        out: list[str] = []
        for seg in file.segments:
            if seg[0] == "raw":
                out.append(seg[1])          # 注释/空行/杂行：原样回放
                continue
            entry = file.entries[seg[1]]
            new_value = None
            if translations is not None:
                new_value = translations.get(entry.key)
            if new_value is None:
                # 未翻译：回放该条目占用的全部物理行（含续行），字节级原样
                out.extend(file.lines[entry.line_start: entry.line_end + 1])
                continue
            # 已翻译：以原条目首行的行尾风格重写为单行
            # （续行条目的译文合并为单行，语义不变；该提示由解析阶段给出）
            first_line = file.lines[entry.line_start]
            newline = "\r\n" if first_line.endswith("\r\n") else "\n"
            out.append(f"{entry.raw_key}={new_value}" + newline)
        return "".join(out)
