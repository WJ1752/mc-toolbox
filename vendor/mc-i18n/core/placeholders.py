"""占位符保护引擎（对应 PRD F03 —— 本工具的技术核心与第一优先级）。

工作原理（提取 → 送翻 → 还原 → 校验 四段式）：

    1. protect(text)
       用一组按优先级组合的正则，把原文中的全部"格式要素"替换为
       中性保护 token ⟦N⟧（U+27E6/U+27E7，数学白方括号——神经机器翻译
       训练语料中几乎不存在，不会被引擎翻译、拆解或转写）；
       返回 (受保护文本, 占位符原文列表)。
    2. 受保护文本交给翻译引擎（此时引擎面对的是纯自然语言 + ⟦N⟧）。
    3. restore(translated, tokens)
       把译文中的 ⟦N⟧ 换回第 N 个占位符原文，并做三重校验：
       a) 数量校验：token 丢了或被引擎复制 → 直接判失败；
       b) 编号校验：出现的编号必须恰好是 0..n-1 的一个排列；
       c) 顺序校验：默认要求严格升序（NMT 大体保持语序）；
          唯一例外——原文含 %1$s 之类的"位置索引占位符"时允许乱序
          （Java 语义本就允许 %2$s 出现在 %1$s 之前）。
    4. 校验失败抛 PlaceholderRestoreError → 流水线降级：
       先对该条单独重试，仍失败则保留原文并标记 NEEDS_HUMAN。

覆盖的占位符体系（MC 全场景）：
    - Java String.format：%s %d %x %f %.2f %5d %-5s %1$s %2$d %% %n ...
    - MC 颜色/格式代码：§0-9 §a-f §k-o §r（含 §x 十六进制色场景）；
      v0.3.3 起连续色码段（§a§b§c…）整体合并为单个 token——LLM 引擎
      对密集 ⟦N⟧ 标记经常省略"重复"标记（62 个只留 19 个实测），
      合并后 token 数骤降、保留率大幅上升，还原时整段原样回填
    - & 颜色码（可选，默认关——避免误伤 "Tom & Jerry" 这类普通文本）
    - ${player} 美元花括号变量（PlaceholderAPI 常见变体）
    - {0} {name} 花括号占位符（部分模组/任务书自定义格式）
    - %player% / %target% 百分比成对变量（可选）
    - 转义序列：\n \t \r \" \\ \u00a7（.lang 文件中是字面两字符，必须原样保留）
    - XML 标签（可选）：<b></b> <br/>（任务书/教程类内容）

对抗引擎改写（全角变体修复）：
    个别引擎会把 ⟦0⟧ 转写为全角/异型括号（【0】、〖0〗、[0]、｛0｝…）
    或把数字写成全角（⟦１⟧）。restore 在标准 token 匹配不足时，
    按变体括号表逐一搜索"纯数字成对括号"，命中且编号集完整才采纳，
    否则依旧判定失败——宁降级、不产出错乱译文。
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from typing import Sequence

# 保护 token 的左右定界符（U+27E6 MATHEMATICAL LEFT/RIGHT WHITE SQUARE BRACKET）
TOKEN_LEFT = "\u27e6"
TOKEN_RIGHT = "\u27e7"

# 标准 token：⟦N⟧（容忍引擎在括号内外加空白；数字支持全角 → 换算后匹配）
_TOKEN_RE = re.compile(r"\u27e6\s*([0-9０-９]+)\s*\u27e7")

# 全角数字 → 半角数字 转换表（对抗引擎把 token 编号转写为全角）
_FULLWIDTH_TRANS = str.maketrans("０１２３４５６７８９", "0123456789")

# 位置索引占位符：%1$s / %2$d —— 出现时允许译文乱序（Java 语义本就按索引取参）
_POSITIONAL_RE = re.compile(r"%\d+\$[a-zA-Z]")

# 通用格式符（含位置索引）：%s %d %.2f %1$s …—— 捕获 (可选位置索引, 类型字符)
_FORMAT_SPEC_RE = re.compile(r"%(?:(\d+)\$)?[.\d]*([a-zA-Z])")


def _format_type_sequence(text: str) -> list[str]:
    """按出现顺序提取文本中的【非位置型】格式符类型序列（%s→s、%.2f→f）。

    位置索引型（%1$s）跳过——Java 按索引取参，与出现顺序无关，乱序安全。
    %% 字面百分号不匹配（类型位非字母），不会误入序列。
    """
    return [m.group(2) for m in _FORMAT_SPEC_RE.finditer(text) if not m.group(1)]


def _count_labels(text: str, tokens: list[str]) -> dict[str, int]:
    """统计 text 中每个 token 字面出现了多少次（用于强填去重）。

    ---- v0.3.5-r2 新增 ----
    强制回填前需要知道译文里"已经存在多少个某 token 字面"，避免把
    survivors 重复插入。返回 {token字面: 出现次数}，只统计非空 token。
    """
    counts: dict[str, int] = {}
    for tok in tokens:
        if tok and tok not in counts:
            counts[tok] = text.count(tok)
    return counts


def _remap_spans(spans: list[tuple[int, int, int]],
                 dropped: list[tuple[int, int]],
                 original: str) -> list[tuple[int, int, int]]:
    """删除 dropped 区间后，重算 spans 在删后文本中的坐标。

    ---- v0.3.5-r2 新增 ----
    删除策略与 _fill_partial / force_fill 一致：若被删区间前紧邻一个空格，
    该空格也一并删除。坐标左移量需逐段累加（含被顺带删掉的空格）。
    dropped 与 spans 来自同一份 original，故可直接比较位置。
    """
    # 构造"实际删除区间"列表（把前导空格纳入），按起点升序
    cuts: list[tuple[int, int]] = []
    for start, end in sorted(dropped):
        s0 = start
        if s0 > 0 and original[s0 - 1] == " ":
            s0 -= 1
        # 与上一个删除区间重叠时合并
        if cuts and s0 <= cuts[-1][1]:
            cuts[-1] = (cuts[-1][0], max(cuts[-1][1], end))
        else:
            cuts.append((s0, end))

    out: list[tuple[int, int, int]] = []
    for start, end, idx in spans:
        shift = 0
        for cs, ce in cuts:
            if ce <= start:
                shift += ce - cs          # 该删除段完全在 span 左侧
            elif cs < start:
                shift += start - cs       # 部分重叠（理论上不发生）
        out.append((start - shift, end - shift, idx))
    return out

__all__ = [
    "ProtectOptions", "PlaceholderGuard", "PlaceholderRestoreError",
    "PlaceholderOrderError",
    "TOKEN_LEFT", "TOKEN_RIGHT", "term_pattern_source",
]

# --------------------------------------------------------------------------
# 术语词边界（术语表防误伤的核心，glossary.py 与本模块共用）
# --------------------------------------------------------------------------

# ASCII 词字符集：术语边界检查只针对英文字母/数字/下划线。
# 刻意不用 \w —— Unicode 模式下 \w 包含中文，会导致
# "击杀Enderman后" 中紧邻汉字的术语无法匹配（中英混排不加空格是常态）。
_ASCII_WORD_CHARS = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_"
)


def term_pattern_source(term: str) -> str:
    r"""给单个术语生成带词边界的正则片段。

    规则：术语某一侧的**首/尾字符**是 ASCII 词字符时，该侧加边界断言——
    - "Redstone"  → (?<!\w_ascii)Redstone(?!\w_ascii)：不会截断 "RedstoneCraft"；
    - 中文邻接不受影响：汉字不是 ASCII 词字符，"杀Enderman后" 正常匹配；
    - 以非词字符开头/结尾的术语（如标点、中文键）不加对应侧边界。

    为何用 lookaround 而非 \b：\b 基于完整 \w（含中文），语义过宽；
    这里只需要防止"英文单词被拦腰截断"这一种误伤。
    """
    escaped = re.escape(term)
    left = r"(?<![A-Za-z0-9_])" if term and term[0] in _ASCII_WORD_CHARS else ""
    right = r"(?![A-Za-z0-9_])" if term and term[-1] in _ASCII_WORD_CHARS else ""
    return left + escaped + right


class PlaceholderRestoreError(ValueError):
    """占位符还原失败（token 丢失 / 编号异常 / 顺序异常）。

    流水线捕获该异常后的降级链：单条重试 → 备用引擎 → 保留原文标记 NEEDS_HUMAN。
    """


class PlaceholderOrderError(PlaceholderRestoreError):
    """占位符乱序异常（v0.3.3 引入，v0.3.4 起默认路径不再抛出）。

    v0.3.4 实测结论：中文与英文语序差异天然导致 token 换位（编号集
    完整的乱序是【正常翻译】而非错误），restore 现已在 auto / always
    策略下直接按编号回填通过，本异常类仅保留向后兼容（旧测试/旧配置
    可能引用）；``fallback`` 属性语义不变。``never`` 策略仍抛
    PlaceholderRestoreError（父类）。
    """

    def __init__(self, message: str, fallback: str = ""):
        super().__init__(message)
        self.fallback = fallback


@dataclass
class ProtectOptions:
    """占位符识别开关（与 config.yaml 的 [protect] 节一一对应）。"""

    amp_color_codes: bool = False    # & 颜色码（默认关：普通文本的 & 会被误伤）
    percent_variables: bool = True   # %player% 成对百分比变量
    xml_tags: bool = False           # XML 标签（任务书场景手动开启）
    brace_placeholders: bool = True  # {0} / {name} 花括号占位符
    dollar_braces: bool = True       # ${player} 变量
    escape_sequences: bool = True    # \n 等转义序列
    out_of_order: str = "auto"       # 乱序容忍：auto/always=编号完整即回填通过 | never=硬失败
    # 标记丢失兜底（v0.3.5 新增）：引擎把 ⟦N⟧ 标记整个吞掉时的处理策略。
    #   strict（默认）= 无法建立映射就抛错，走重试/备用引擎/保留原文降级链
    #   salvage       = 尽力回填（缺失占位符补到句末）并标记人工复核，
    #                   宁可语序生硬也不让条目退回英文。适合"汉化率优先"场景。
    missing_token_policy: str = "strict"


# --------------------------------------------------------------------------
# 原子正则（按优先级从高到低组合；同一位置先命中的分支获胜）
# --------------------------------------------------------------------------

# 转义序列：\n \t \r \b \f \0 \" \' \\ 与 \uXXXX
_RE_ESCAPE = r"\\[nrtbf0'\"]|\\\\|\\u[0-9a-fA-F]{4}"

# MC § 颜色/格式代码：§0-9 §a-f §k-o §r（大小写都认；§x 为十六进制色前缀）
_RE_COLOR = r"§[0-9A-Fa-fK-ORk-orxX]"

# 连续色码段（v0.3.3）：§a§b§c 这类紧邻色码序列整体保护为【一个】token。
# 动机：LLM 引擎对"一长串连续 ⟦N⟧ 标记"经常省略/合并"重复"的标记
#（实测 GLM 等模型 62 个 token 只保留 19 个），是占位符还原失败的最大来源；
# 把连续段合并为单 token 后（62 → 十几个），模型保留率大幅上升，
# 还原时按 token 原样回填整段色码，语义无损。单色码 §a 仍走 color 分支。
_RE_COLOR_RUN = r"(?:§[0-9A-Fa-fK-ORk-orxX]){2,}"

# & 颜色码（旧版插件/BungeeCord 风格）——默认关闭
_RE_AMP = r"&[0-9A-Fa-fK-ORk-or]"

# Java String.format 完整语法：
#   %[参数索引$][标志][宽度][.精度][时间前缀]转换符
#   例：%s %d %x %o %e %f %b %c %h %n %% %-5s %05.1f %1$s %2$-6d %tY
# 转换符限定为 Java 合法集合，避免把 %player% 的 "%p" 之类误判为格式符
_RE_JAVA_FMT = (
    r"%(?:\d+\$)?[-#+ 0,(]*"
    r"(?:\d+|\*)?"
    r"(?:\.\d+|\.\*)?"
    r"(?:[tT][A-Za-z])?"
    r"[aAbBcCdDeEfFgGhHnNoOsSxX%]"
)

# %var% 成对百分比变量（PlaceholderAPI / Bukkit 计分板常见）——默认开启
_RE_PVAR = r"%[A-Za-z_][A-Za-z0-9_.]{0,63}%"

# ${name} 美元花括号变量：内容不含花括号/换行，防止贪婪跨越
_RE_DOLLAR = r"\$\{[^{}$\n]{1,80}\}"

# {0} / {name} 花括号占位符：内容限定"标识符字符/点/冒号/井号/斜杠"，
# 不含空格与中文，显著降低误伤普通花括号文本的概率
_RE_BRACE = r"\{[\w.:#/-]{1,80}\}"

# XML 标签（含属性）——默认关闭
_RE_XML = r"</?[A-Za-z][A-Za-z0-9_-]*(?:\s[^<>]{0,120})?/?>"

# 编译版 Java 格式符正则（v0.3.8）：供质量巡检（core/quality.py）判定
# "同一值混用 %s 与 %1$s"等场景复用，避免格式符识别规则出现第二套实现。
JAVA_FORMAT_RE = re.compile(_RE_JAVA_FMT)

# 变体括号集合：对抗引擎把 ⟦N⟧ 转写为全角/异型括号。
# 搜索时左右括号独立匹配（左集合 × 右集合），覆盖"两边被替换成不同变体"的场景；
# 误伤由三重校验兜底：括号内必须是纯数字 + 数量一致 + 编号集恰好是 0..n-1 排列。
_VARIANT_LEFTS = "⟦【〖〔［｛「『[｢"
_VARIANT_RIGHTS = "⟧】〗］｝」』]｣"

# 编译缓存：按 ProtectOptions 的取值组合缓存组合正则（同一配置只编译一次）
_PATTERN_CACHE: dict[tuple, re.Pattern] = {}


def _combined_pattern(opts: ProtectOptions) -> re.Pattern:
    """按开关组合出单一 alternation 正则。

    组合为单条正则（而非多次串行 sub）有两个好处：
        1. 一次扫描即可完成识别，各类占位符的优先级由分支顺序唯一确定；
        2. 已替换为 token 的文本不会再被后续规则二次匹配（不会出现
           ⟦0⟧ 里的内容又被花括号规则捕获之类的级联误伤）。
    """
    key = (
        opts.escape_sequences, opts.amp_color_codes, opts.percent_variables,
        opts.dollar_braces, opts.brace_placeholders, opts.xml_tags,
    )
    cached = _PATTERN_CACHE.get(key)
    if cached is not None:
        return cached

    parts: list[str] = []          # 分支顺序即优先级，顺序不可随意调换
    if opts.escape_sequences:
        parts.append(f"(?P<esc>{_RE_ESCAPE})")
    # 连续色码段必须先于单色码分支：整段优先合并为一个 token（v0.3.3）
    parts.append(f"(?P<color_run>{_RE_COLOR_RUN})")
    parts.append(f"(?P<color>{_RE_COLOR})")
    if opts.amp_color_codes:
        parts.append(f"(?P<amp>{_RE_AMP})")
    parts.append(f"(?P<java>{_RE_JAVA_FMT})")
    if opts.percent_variables:
        parts.append(f"(?P<pvar>{_RE_PVAR})")
    if opts.dollar_braces:
        parts.append(f"(?P<dollar>{_RE_DOLLAR})")
    if opts.brace_placeholders:
        parts.append(f"(?P<brace>{_RE_BRACE})")
    if opts.xml_tags:
        parts.append(f"(?P<xml>{_RE_XML})")

    pattern = re.compile("|".join(parts))
    _PATTERN_CACHE[key] = pattern
    return pattern


# --------------------------------------------------------------------------
# 保护引擎
# --------------------------------------------------------------------------

class PlaceholderGuard:
    """占位符保护引擎：protect / restore / verify / analyze 四个公开方法。

    无状态（可多线程共享同一实例），选项在构造时固定。
    """

    def __init__(self, options: ProtectOptions | None = None):
        self.opts = options or ProtectOptions()
        self._pattern = _combined_pattern(self.opts)
        # 字面量术语保护专用：按术语元组缓存组合正则（术语表在单次翻译
        # 任务内固定不变，同一元组只编译一次；dict 键为排序后的术语元组）
        self._literal_cache: dict[tuple, re.Pattern] = {}

    # ------------------------------------------------------------------
    # 分析与提取
    # ------------------------------------------------------------------
    def analyze(self, text: str) -> list[str]:
        """列出文本中的全部占位符原样（按出现顺序）——inspect 命令与 verify 共用。"""
        return [m.group(0) for m in self._pattern.finditer(text)]

    def _literal_pattern(self, terms: tuple[str, ...]) -> re.Pattern:
        """构造"术语 + 常规占位符"的组合正则（术语分支放最前 = 最高优先级）。

        术语按长度降序拼接，保证长词优先匹配：
        先匹配 "Netherite"（下界合金）再匹配 "Nether"（下界），
        避免 "Netherite" 被其中的 "Nether" 拦腰截断。
        每个术语经 term_pattern_source() 加词边界，防止
        "Redstone" 误伤模组名 "RedstoneCraft" 之类的复合词。
        """
        cached = self._literal_cache.get(terms)
        if cached is not None:
            return cached
        alternation = "|".join(
            term_pattern_source(t) for t in sorted(terms, key=len, reverse=True)
        )
        pattern = re.compile(f"(?P<term>{alternation})|{self._pattern.pattern}")
        self._literal_cache[terms] = pattern
        return pattern

    def protect(self, text: str, literal_terms: Sequence[str] = ()) -> tuple[str, list[str]]:
        """提取占位符并替换为 token。

        literal_terms：需要按"字面量整体保护"的术语列表（术语表功能）。
        术语会先于其他规则被替换为 token，翻译后由 restore 原样回填，
        再由术语表模块把原文替换为统一译法 —— 保证 Enderman 永远译成
        "末影人"而不是引擎随机的"终界使者/幽匿人"。

        返回 (受保护文本, 占位符列表)。占位符列表的第 i 项对应 token ⟦i⟧。
        无占位符时返回 (原文本, [])。
        """
        tokens: list[str] = []

        def _replace(match: re.Match) -> str:
            tokens.append(match.group(0))
            return f"{TOKEN_LEFT}{len(tokens) - 1}{TOKEN_RIGHT}"

        # 无术语时走零开销缓存路径；有术语时用带术语分支的组合正则
        pattern = self._literal_pattern(tuple(literal_terms)) if literal_terms else self._pattern
        protected = pattern.sub(_replace, text)
        return protected, tokens

    @staticmethod
    def is_passthrough(protected: str) -> bool:
        """判断受保护文本是否为"纯 token 条目"（无可译正文）。

        v0.3.4 新增：整条内容全部由占位符构成（如纯色码装饰行 §r、
        §a§l），去掉 token 后只剩空白——这类条目没有任何可翻译内容，
        交给 LLM 只会得到不可控行为（实测返回空译文/改写标记，
        表现为"应有 N 个 ⟦N⟧，译文仅识别到 0 个"），应直接原样输出。
        """
        return not _TOKEN_RE.sub("", protected).strip()

    def force_fill(self, translated: str, tokens: list[str]) -> str | None:
        """公开入口：强制把全部占位符补回译文（v0.3.5-r2），失败返回 None。

        供 pipeline 在"重译后仍无锚点"时调用。与 `_force_fill` 的区别：
        本方法是稳定的公开 API（不走策略配置），并先清理译文里残留的
        【不可信 token】，再执行强制回填。

        清理规则：译文里若残留 ⟦N⟧ token，逐个判断——
          - 编号在 [0, len(tokens)) 且不重复 → 保留（属于"部分存活"，本
            不该走到强填，但保留也无害：_force_fill 会再补缺失的）
          - 编号越界 / 重复 → 视为引擎幻觉标记，直接删除
        真机实测：模型常吐出越界编号（原文 8 个 token 却返回 ⟦9⟧），
        这类残留标记若不清掉，强填结果会同时含正确占位符和垃圾标记。
        """
        if not tokens:
            return translated

        cleaned = translated
        stray = [
            (m.start(), m.end(), int(m.group(1).translate(_FULLWIDTH_TRANS)))
            for m in _TOKEN_RE.finditer(translated)
        ]
        if stray:
            seen: set[int] = set()
            drop: list[tuple[int, int]] = []
            for start, end, idx in stray:
                if idx < 0 or idx >= len(tokens) or idx in seen:
                    drop.append((start, end))       # 越界或重复 → 幻觉标记
                else:
                    seen.add(idx)
            # 剩余存活标记若次序已乱，说明映射不可靠，一并清掉走全量强填
            alive = [idx for start, end, idx in stray if (start, end) not in drop]
            if alive != sorted(alive):
                drop = [(start, end) for start, end, _ in stray]
            for start, end in sorted(drop, key=lambda s: s[0], reverse=True):
                # 连同标记前紧邻的单个空白一起删除，避免留下"击败  只"双空格
                s0 = start
                if s0 > 0 and cleaned[s0 - 1] == " ":
                    s0 -= 1
                cleaned = cleaned[:s0] + cleaned[end:]
                # 若删完又出现双空格（前后两侧原本各有一个），再收一次
                cleaned = re.sub(r" {2,}", " ", cleaned)

        return self._force_fill(cleaned, tokens)

    # ------------------------------------------------------------------
    # 还原
    # ------------------------------------------------------------------
    def restore(self, translated: str, tokens: list[str]) -> str:
        """把译文中的 token 还原为占位符原文，失败抛 PlaceholderRestoreError。

        三重校验（数量 / 编号集 / 顺序）+ 全角变体修复，详见模块 docstring。
        """
        if not tokens:
            # 原文无占位符：译文不应出现任何 token（出现说明引擎产生了幻觉标记）
            if _TOKEN_RE.search(translated):
                raise PlaceholderRestoreError("原文无占位符，但译文出现 ⟦N⟧ 标记（引擎幻觉）")
            return translated

        expected = len(tokens)
        matches = self._find_standard(translated)
        if len(matches) != expected:
            # 标准 token 数量不符 → 尝试全角/异型括号变体修复
            matches = self._find_variant(translated, expected)
            if matches is None:
                # ---- v0.3.5 新增：位置回填兜底（partial / greedy 两级）----
                # 走到这里说明引擎确实吞掉了标记。v0.3.4 及以前在此直接抛错
                # → 整条走"重试 → 备用引擎 → 保留英文"降级链，用户实测日志
                # 大量刷屏"应有 N 个 ⟦N⟧，译文仅识别到 M 个"，且大量条目
                # 最终回退英文（汉化率受损）。
                #
                # 关键认知：吞标记 ≠ 译文不可用。只要"存活标记"还能与原文
                # 槽位建立可靠映射，就能安全回填——占位符是运行期参数，丢了
                # 会崩；语序生硬只是观感问题，可用人工复核标记补救。
                # 因此按"映射可靠度"分级尝试，任何一级成功都不再抛错。
                filled = self._fill_partial(translated, tokens)
                if filled is None and self.opts.missing_token_policy == "salvage":
                    # salvage：完全无锚点时，把全部占位符补回译文（参数型
                    # 置句末、色码置句首）。语序会生硬，但占位符零丢失——
                    # 对"汉化率优先"的整合包制作者而言，一条语序欠佳的中文
                    # 远比一条英文原文有用。调用方须计入人工复核清单。
                    # 走公开 force_fill（含幻觉标记清理），避免残留 ⟦N⟧。
                    filled = self.force_fill(translated, tokens)
                if filled is not None:
                    return filled
                raise PlaceholderRestoreError(
                    f"占位符标记数量不符：应有 {expected} 个 ⟦N⟧，"
                    f"译文仅识别到 {len(self._find_standard(translated))} 个"
                )

        indices = [idx for _, _, idx in matches]
        if sorted(indices) != list(range(expected)):
            # ---- v0.3.5-r2 新增：编号集异常也走位置回填 ----
            # 真机实测：模型返回的标记【个数】可能恰好等于 expected，
            # 但编号是幻觉值（如 2 个 token → ⟦0⟧…⟦9⟧），此时旧逻辑在
            # 这里直接抛"编号异常"，绕过了 _fill_partial 的兜底。
            # 改为先尝试位置回填（它会剔除越界标记并补齐缺失槽位）。
            filled = self._fill_partial(translated, tokens)
            if filled is None and self.opts.missing_token_policy == "salvage":
                filled = self.force_fill(translated, tokens)
            if filled is not None:
                return filled
            raise PlaceholderRestoreError(
                f"占位符编号异常：{indices}（应为 0..{expected - 1} 的排列）"
            )

        # ---- 顺序校验（乱序容忍策略见 ProtectOptions.out_of_order）----
        in_order = indices == sorted(indices)
        if not in_order:
            policy = self.opts.out_of_order
            if policy == "never":
                raise PlaceholderRestoreError(f"占位符出现乱序：{indices}（当前策略禁止乱序）")
            # auto / always：编号集完整的乱序=译文语序被模型合理改写。
            # v0.3.4 实测结论：中文与英文语序差异天然导致 token 换位
            #（如 [1, 0]、[2, 0, 11]，v0.3.3 用户实测日志大量出现），
            # 重试不可能"恢复"本应改变的语序，只会浪费 API 调用并把
            # 正常译文误转人工。
            #
            # 唯一的真实风险：token 内含【非位置型】格式符（%s/%d…）时，
            # 语序换位会移动它们的相对顺序，而 Java formatter 按【出现
            # 顺序】取参 → 类型可能错绑（数字落进 %s 槽 → 运行时异常）。
            # 故按"回填后格式符类型序列是否与原文一致"分级：
            #   一致（纯文本/色码 token、同类型换位）→ 直接回填通过；
            #   不一致（类型换位）→ 抛 PlaceholderOrderError 走降级链转人工。
            rebuilt = self._rebuild(translated, matches, tokens)
            original_types: list[str] = []
            for tok in tokens:
                original_types.extend(_format_type_sequence(tok))
            if original_types == _format_type_sequence(rebuilt):
                return rebuilt
            raise PlaceholderOrderError(
                f"占位符出现乱序且移动了格式符：{indices}"
                f"（%s/%d 等参数顺序可能错位，语序建议人工复核）",
                fallback=rebuilt,
            )

        # ---- 按编号回填（从右往左替换，避免前面的替换使后面的 span 失效）----
        return self._rebuild(translated, matches, tokens)

    @staticmethod
    def _rebuild(translated: str, matches: list[tuple[int, int, int]],
                 tokens: list[str]) -> str:
        """按 token 编号把占位符原文回填进译文（从右往左替换防 span 失效）。"""
        result = translated
        for start, end, idx in sorted(matches, key=lambda m: m[0], reverse=True):
            result = result[:start] + tokens[idx] + result[end:]
        return result

    # ------------------------------------------------------------------
    # 位置回填兜底（v0.3.5 新增）
    # ------------------------------------------------------------------
    def _fill_partial(self, translated: str, tokens: list[str]) -> str | None:
        """引擎吞掉部分标记时的安全回填，失败返回 None。

        ---- v0.3.5-r2 修复（真机验证后重写）----
        r1 版本在公司构造语料上全绿，但真机（Linggango 整合包）实测
        日志仍被"应有 N 个 ⟦N⟧，译文仅识别到 M 个"刷屏。复盘出三个根因：

          根因 1【编号越界被误判为映射不可靠】
            模型常吐出越界编号（原文 8 个 token 却返回 ⟦9⟧、⟦10⟧）。
            r1 在 `any(i >= len(tokens))` 时直接 return None → 整条放弃。
            实际上"越界"只说明【那一个】标记不可信，其余合法标记依然可用。
            修复：越界标记降级为"无锚点标记"丢弃，其余继续回填。

          根因 2【锚点用 tokens 字面查找，重复值必然错位】
            色码/token 大量重复（§r 出现多次、同一 %s 多次出现），
            `result.find(tokens[idx])` 永远命中第一个 → 插入位置全错。
            修复：_rebuild 返回每个槽位回填后的真实 (start, end, idx)，
            直接用它做锚点，不再反查文本。

          根因 3【strict 默认策略下整条无锚点即抛错】
            真机大量条目是"模型把占位符语义化改写"（%s → "玩家"），
            连 token 字面都搜不到。此时 r1 无路可走。
            修复：留空返回 None，由上层（pipeline）先重译、再强制回填，
            见 _force_fill 与 pipeline 的降级链。

        两级策略（严格度递减）：
          A. 有存活锚点 → 按锚点回填 + 缺失槽位就近插入（位置可信）
          B. 完全无锚点 → 返回 None，交上层重译/强制回填

        返回值：成功返回回填后的文本；完全无法定位时返回 None。
        """
        # ---- 1. 收集所有存活标记（标准 + 变体），按出现位置排序 ----
        found: list[tuple[int, int, int]] = list(self._find_standard(translated))
        found.extend(self._find_variant_all(translated))

        # ---- 1b. 标记被"脱壳"时按占位符字面直接定位 ----
        # 引擎常把 ⟦0⟧ 直接"翻译"回原始占位符文本（§r 仍是 §r、%s 仍是 %s），
        # 等于 token 壳被剥掉但内容完好。此时按占位符字面在译文中查找，
        # 得到的位置可作为可靠锚点（内容一致 → 槽位必然正确）。
        # 注意：仅在"没有任何 ⟦N⟧ 标记"时才启用，避免与标准扫描打架。
        if not found:
            for ti, tok in enumerate(tokens):
                if not tok:
                    continue
                start = 0
                while True:
                    pos = translated.find(tok, start)
                    if pos < 0:
                        break
                    # 与已收集的 span 去重
                    if not any(pos < e and pos + len(tok) > s for s, e, _ in found):
                        found.append((pos, pos + len(tok), ti))
                        break
                    start = pos + 1

        if not found:
            return None

        # ---- 2. 同位置去重（标准 token 可能同时被变体正则命中）----
        found.sort(key=lambda m: m[0])
        dedup: list[tuple[int, int, int]] = []
        for span in found:
            if dedup and span[0] < dedup[-1][1]:
                continue
            dedup.append(span)
        found = dedup

        # ---- 3. v0.3.5-r2 根因 1 修复：越界/重复编号只丢弃【该标记】----
        # 不再因为个别坏标记而放弃整条。次序校验同样只作用于合法标记。
        # dropped 记录被丢弃的 span，回填前先从译文里剔除，避免残留 token
        # 泄漏进最终译文（旧实现会产出 "%s 和 ⟦0⟧" 这类脏结果）。
        legal: list[tuple[int, int, int]] = []
        dropped: list[tuple[int, int]] = []
        for span in found:
            idx = span[2]
            if idx < 0 or idx >= len(tokens):
                dropped.append((span[0], span[1]))   # 越界 → 丢弃
                continue
            if any(s[2] == idx for s in legal):
                dropped.append((span[0], span[1]))   # 同编号重复 → 只留最左
                continue
            legal.append(span)

        if not legal:
            # 全部标记都越界/重复 → 等同无锚点，交上层重译/强制回填
            return None

        # ---- 4. 次序校验：合法标记的编号必须严格递增 ----
        # 非递增说明引擎挪动过标记 → 映射不可靠，保守拒绝（走重译/强制回填）
        idxs = [s[2] for s in legal]
        if idxs != sorted(idxs):
            return None

        # ---- 5. 剔除被丢弃的脏标记，再按编号回填 ----
        text = translated
        spans = legal
        if dropped:
            for start, end in sorted(dropped, key=lambda s: s[0], reverse=True):
                s0 = start
                if s0 > 0 and text[s0 - 1] == " ":
                    s0 -= 1
                text = text[:s0] + text[end:]
            text = re.sub(r" {2,}", " ", text)
            # 删除脏标记后，合法标记的坐标要按删除量整体左移
            spans = _remap_spans(legal, dropped, translated)

        result, placed = self._rebuild_with_spans(text, spans, tokens)

        missing = [i for i in range(len(tokens)) if i not in set(idxs)]
        if missing:
            result = self._insert_missing_at(result, placed, tokens, missing)
        return result

    def _force_fill(self, translated: str, tokens: list[str]) -> str:
        """最后一道兜底：把【缺失的】占位符按启发式插入译文，绝不丢参。

        ---- v0.3.5-r2 新增 ----
        仅在"重译后仍无法建立可靠锚点"时由 pipeline 调用。模型此时可能
        已把占位符整个吞掉/语义化改写（%s → "玩家"），译文里没有可靠位置
        信息。为保证运行期 Java formatter 不因参数缺失抛异常，必须把占位符
        全部补回——位置只能取"最不破坏可读性"的启发式：

          - 参数型占位符（%s/%d/%1$s…）→ 插到句末标点之前
            （放句首会割裂"谓语+宾语"结构，放句末读起来最自然）
          - 色码类 token（§x、§a§b 等）→ 补到译文最前面
            （等价于"整句继承原色"，观感影响最小）

        ⚠️ 去重：译文里已按字面存在的 token 不再重复添加。调用方在调用前
        应先用 `force_fill` 清理幻觉 token；本方法自身也做一次存在性检查，
        避免 survivors 被重复插入（如 "§r文本§r" → 只补一次 §r）。

        调用方必须把这条计入人工复核清单（review_suggested）——
        占位符零丢失是硬保证，但位置需要人眼确认。
        """
        if not tokens:
            return translated

        result = translated
        # 统计 result 中已按字面存在的 token 用量，缺失的才补
        present = _count_labels(result, tokens)

        colors: list[str] = []
        args: list[str] = []
        for i, tok in enumerate(tokens):
            if not tok:
                continue
            # 同一 token 字面在原文可能出现多次 → present 里按"需求次数"扣减
            if present.get(tok, 0) > 0:
                present[tok] -= 1
                continue
            if tok.startswith("§"):
                colors.append(tok)
            else:
                args.append(tok)

        # 色码补到最前（整句继承原色）
        if colors:
            result = "".join(colors) + result
        # 参数型插到句末标点之前
        if args:
            m = re.search(r"[。！？.!?、,，；;]?\s*$", result)
            pos = m.start() if m else len(result)
            result = result[:pos] + "".join(args) + result[pos:]
        return result

    @staticmethod
    def _rebuild_with_spans(
        translated: str, matches: list[tuple[int, int, int]], tokens: list[str]
    ) -> tuple[str, list[tuple[int, int, int]]]:
        """按编号回填，并返回回填后每个槽位的真实 span 供锚点使用。

        ---- v0.3.5-r2 新增 ----
        旧实现（_rebuild + _insert_missing 里 result.find(tokens[idx])）在
        token 字面重复时必然错位：色码 §r 可能出现在多个槽位，find 永远
        命中第一个。这里直接在替换过程中记录新位置，从根上消除反查。

        返回 (回填后文本, [(new_start, new_end, idx), ...] 按 new_start 升序)。
        """
        result = translated
        placed: list[tuple[int, int, int]] = []
        # 从右往左替换，避免前面的替换使后面的 span 失效
        for start, end, idx in sorted(matches, key=lambda m: m[0], reverse=True):
            tok = tokens[idx]
            result = result[:start] + tok + result[end:]
            placed.append((start, start + len(tok), idx))
        placed.sort(key=lambda m: m[0])
        return result, placed

    @staticmethod
    def _insert_missing_at(result: str, placed: list[tuple[int, int, int]],
                           tokens: list[str], missing: list[int]) -> str:
        """把缺失槽位的占位符插入已回填文本（锚点用真实 span，非字面反查）。

        ---- v0.3.5-r2 新增（替代 _insert_missing）----
        位置规则（按此优先级）：
          1. 有"编号更大的存活锚点" → 插到最近那个右锚点【之前】
             （保持原文槽位相对次序）
          2. 否则若"编号更小的存活锚点"存在 → 插到最近那个左锚点【之后】
             （真机修正：旧版此时一律丢到句末，导致 §c%1$s§r 被挤到
             "生命"之后，占位符位置严重偏离原文语义）
          3. 两侧都无锚点（存活锚点为空）→ 插到句末标点之前

        锚点位置直接来自 _rebuild_with_spans 的真实 span，不再用 tokens
        字面查找，杜绝重复色码（§r 多次出现）造成的错位。
        多个缺失槽位落在同一插入点时，按编号升序拼接。
        """
        # 计算每个缺失槽位的插入点（以 result 的字符下标表示）
        insert_pts: dict[int, list[int]] = {}   # 插入点下标 → 该点要插入的槽位编号（升序）
        tail_pos: int | None = None             # 句末标点位置（惰性计算）

        def _sentence_end() -> int:
            nonlocal tail_pos
            if tail_pos is None:
                m = re.search(r"[。！？.!?、,，；;]?\s*$", result)
                tail_pos = m.start() if m else len(result)
            return tail_pos

        for mi in missing:
            right = [p for p in placed if p[2] > mi]
            left = [p for p in placed if p[2] < mi]
            if right:
                # 规则 1：插到最近右锚点之前
                pos = min(right, key=lambda p: p[2])[0]
            elif left:
                # 规则 2：插到最近左锚点【之后】（用其 end 坐标）
                pos = max(left, key=lambda p: p[2])[1]
            else:
                # 规则 3：无任何锚点 → 句末标点之前
                pos = _sentence_end()
            insert_pts.setdefault(pos, []).append(mi)

        # 按插入点从右往左拼接，避免偏移失效
        for pos in sorted(insert_pts, key=lambda p: p, reverse=True):
            # 同一点上的多个槽位按编号升序拼接
            filler = "".join(tokens[i] for i in sorted(insert_pts[pos]))
            result = result[:pos] + filler + result[pos:]
        return result

    def _find_variant_all(self, translated: str) -> list[tuple[int, int, int]]:
        """扫描全部变体括号标记（不要求数量齐），供位置回填使用。"""
        text = translated.translate(_FULLWIDTH_TRANS)
        lefts = "|".join(re.escape(ch) for ch in _VARIANT_LEFTS)
        rights = "|".join(re.escape(ch) for ch in _VARIANT_RIGHTS)
        pattern = re.compile(f"({lefts})\\s*([0-9]+)\\s*({rights})")
        # 变体扫描时排除标准 ⟦⟧（已由 _find_standard 覆盖，避免重复）
        return [(m.start(0), m.end(0), int(m.group(2)))
                for m in pattern.finditer(text)
                if m.group(1) not in ("⟦",) and m.group(3) not in ("⟧",)]

    @staticmethod
    def _insert_missing(result: str, found: list[tuple[int, int, int]],
                        tokens: list[str], missing: list[int]) -> str:
        """[已废弃] v0.3.5-r1 的就近插入实现。

        缺陷：用 `result.find(tokens[idx])` 反查锚点，token 字面重复
        （色码 §r、同名参数 %s）时必然命中第一个位置 → 插入点错乱。
        v0.3.5-r2 起由 `_insert_missing_at`（基于真实 span）替代。
        保留此转发壳仅为兼容外部可能的调用，内部不再使用。
        """
        # 把 found 当作锚点（其 start 是回填前的旧坐标，仅用于兼容路径）
        placed = sorted(found, key=lambda m: m[0])
        return PlaceholderGuard._insert_missing_at(result, placed, tokens, missing)

    # ------------------------------------------------------------------
    # 终验（导出前的第二道防线）
    # ------------------------------------------------------------------
    def verify(self, source: str, restored: str) -> tuple[bool, str]:
        """校验"还原后的译文"与原文的占位符多重集是否一致。

        与 restore 的 token 校验相互独立：restore 校验 token 流，
        verify 校验最终产物。用于 inspect 命令与流水线导出前抽验。
        返回 (是否通过, 不一致说明)。

        v0.3.3 口径修正：连续色码段先展开为单色码再比较——protect 把
        §a§b§c 合并为单 token，但译文回填后色码的相邻关系可能与原文
        不同（乱序回填把两个原本分离的色码排到一起是典型场景），
        按"色码本身"而非"分段方式"判定，避免把语义等价的译文误杀。
        """
        src_tokens = self._verify_view(self.analyze(source))
        if not src_tokens:
            return True, ""
        dst_tokens = self._verify_view(self.analyze(restored))
        if Counter(src_tokens) == Counter(dst_tokens):
            return True, ""
        return False, (
            f"占位符不一致：原文 {Counter(src_tokens)} vs 还原译文 {Counter(dst_tokens)}"
        )

    @staticmethod
    def _verify_view(tokens: list[str]) -> list[str]:
        """终验比较视图：连续色码段（如 §a§b§c）展开为单色码列表。"""
        view: list[str] = []
        for tok in tokens:
            if tok.startswith("§") and len(tok) > 2 and len(tok) % 2 == 0:
                view.extend(tok[i:i + 2] for i in range(0, len(tok), 2))
            else:
                view.append(tok)
        return view

    # ------------------------------------------------------------------
    # 内部：token 搜索
    # ------------------------------------------------------------------
    @staticmethod
    def _find_standard(text: str) -> list[tuple[int, int, int]]:
        """按标准 ⟦N⟧ 搜索 token，返回 [(start, end, 编号)]（容忍空白与全角数字）。"""
        return [
            (m.start(), m.end(), int(m.group(1).translate(_FULLWIDTH_TRANS)))
            for m in _TOKEN_RE.finditer(text)
        ]

    def _find_variant(self, translated: str,
                      expected: int) -> list[tuple[int, int, int]] | None:
        """全角/异型括号变体修复：搜索"纯数字 + 变体括号"的组合。

        左右括号各自独立匹配（覆盖 ⟦0] 之类两边变体不同的场景）；
        只有当搜索结果的数量与编号集都与预期完全一致时才采纳
        （例如文本中的"第【1】章"绝不会因为含数字括号而被误判，
        因为 1 不是 0..n-1 的完整排列）。不匹配则返回 None。
        """
        text = translated.translate(_FULLWIDTH_TRANS)  # 全角数字先归一化
        lefts = "|".join(re.escape(ch) for ch in _VARIANT_LEFTS)
        rights = "|".join(re.escape(ch) for ch in _VARIANT_RIGHTS)
        pattern = re.compile(f"({lefts})\\s*([0-9]+)\\s*({rights})")
        found = [(m.start(0), m.end(0), int(m.group(2)))
                 for m in pattern.finditer(text)]
        if not found:
            return None
        indices = [idx for _, _, idx in found]
        if len(found) == expected and sorted(indices) == list(range(expected)):
            return found
        return None
