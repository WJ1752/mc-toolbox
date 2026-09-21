"""语言文件质量巡检（v0.3.8，对应路线图 M2 的 ``--check`` 质量巡检）。

定位
----
``translate`` 回答"翻译得动不动"，``check`` 回答"翻出来的东西**靠不靠得住**"。
本模块**不调用任何翻译 API、不修改任何文件**，只做静态体检，可安全地在
CI、发版前、交付前反复运行。

三层检查
--------
第一层「文件健康」（对每个源语言文件，无需目标语言文件）：
    * 解析是否成功、是否因超大被跳过；
    * 编码是否非 UTF-8 / 带 BOM（MC 要求无 BOM 的 UTF-8）；
    * **重复键**——Gson 语义下后值覆盖前值，是"条目凭空消失"的头号原因；
    * 非字符串值（嵌套 JSON）——这类值不会参与翻译，容易漏翻；
    * 源值为空、源值以孤立的 ``§`` 结尾（色码不完整）；
    * 同一值内**混用顺序格式符与位置格式符**（``%s`` 与 ``%1$s`` 并存），
      MC 对混用会告警，且译者极易按错误顺序排版。

第二层「译文比对」（源语言文件 + 同目录已有目标语言文件逐条比对）：
    * 缺键 / 多键 / 译文为空；
    * **译文与原文完全相同**（疑似漏翻）；
    * **占位符丢失 / 多出**——复用 ``PlaceholderGuard`` 的识别规则，
      保证"巡检口径 == 翻译时的保护口径"，不会出现两套判定标准打架。

第三层「汇总与出口」：
    控制台人类可读摘要 + 结构化 ``check-report.json``（供 CI 与后续工具消费）；
    存在 ERROR 级问题时退出码为 1，可直接当作发布闸门。

设计约束
--------
* 每条 ``(文件, 问题码)`` 只产出一个 ``Issue``，用 ``count`` + ``keys``
  样本承载明细 —— 真机 2832 个文件、5 万条目的整合包下，逐条产出 issue
  会把报告撑成几十万行，反而不可读；
* 单文件异常一律降级为 ``report.warnings``，绝不中断整轮巡检；
* 巡检口径与扫描/导出/占位符引擎**同源复用**（``scan`` / ``read_ref_bytes``
  / ``decode_bytes`` / ``get_parser`` / ``PlaceholderGuard``），避免规则漂移。
"""

from __future__ import annotations

import re
import time
from collections import Counter
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable, Optional

from ..models import LangFile, LangFileRef, ScanReport
from ..utils import decode_bytes
from .exporters import read_ref_bytes
from .parsers import get_parser
from .placeholders import JAVA_FORMAT_RE, PlaceholderGuard
from .scanner import DEFAULT_MAX_FILE_BYTES, ScanOptions, scan


# --------------------------------------------------------------------------
# 问题码目录（唯一真相源：severity 与文案都从这里取，CLI/JSON/README 不另写一套）
# --------------------------------------------------------------------------
class Severity(str, Enum):
    """问题严重级别。

    ERROR：**必须修**——译文会丢占位符/丢条目，游戏内表现异常或内容缺失；
    WARN ：**建议修**——疑似漏翻、编码隐患等，不影响工具自身正确性；
    INFO ：仅供参考——如目标语言文件比源文件多出的陈旧键。
    """

    ERROR = "error"
    WARN = "warn"
    INFO = "info"


#: 问题码 → (级别, 说明)。新增检查项必须先在此登记（测试会校验无"野生"问题码）。
ISSUE_CATALOG: dict[str, tuple[Severity, str]] = {
    # ---- 第一层：文件健康 ----
    "parse_error":        (Severity.ERROR, "语言文件无法解析，整个文件的条目都拿不到"),
    "file_too_large":     (Severity.WARN,  "文件超过大小上限，未做解析"),
    "duplicate_key":      (Severity.ERROR, "同一文件存在重复键（后值覆盖前值，条目会凭空消失）"),
    "non_string_value":   (Severity.WARN,  "存在非字符串值（嵌套结构），不会被翻译"),
    "encoding_suspect":   (Severity.WARN,  "编码不是无 BOM 的 UTF-8，MC 可能读成乱码"),
    "empty_source_value": (Severity.WARN,  "源值为空，无从翻译"),
    "stray_color_code":   (Severity.WARN,  "源值以孤立的 § 结尾，颜色/格式码不完整"),
    "mixed_format_spec":  (Severity.WARN,  "同一值内混用顺序格式符（%s）与位置格式符（%1$s）"),
    # ---- 第二层：译文比对 ----
    "target_parse_error":  (Severity.ERROR, "目标语言文件无法解析，无法与源文件比对"),
    "missing_translation": (Severity.WARN,  "目标语言文件缺少源文件中的键（该条目未被汉化）"),
    "stale_translation":   (Severity.INFO,  "目标语言文件有源文件已不存在的陈旧键"),
    "empty_translation":   (Severity.WARN,  "译文为空，游戏内会显示空白"),
    "untranslated":        (Severity.WARN,  "译文与原文完全相同，疑似漏翻"),
    "placeholder_lost":    (Severity.ERROR, "译文丢失占位符（游戏内会显示异常或直接报错）"),
    "placeholder_added":   (Severity.WARN,  "译文出现原文没有的占位符（可能是多打或误翻译）"),
}

#: 级别排序权重（控制台按"先严重后轻微"输出）
_SEVERITY_ORDER = {Severity.ERROR: 0, Severity.WARN: 1, Severity.INFO: 2}

#: 判断"值得报漏翻"的最小英文词长：OK / HP / TNT 这类同形词报了也是噪音
_HAS_WORD_RE = re.compile(r"[A-Za-z]{3,}")

#: 位置格式符（%1$s / %2$-6d）——用于"混用格式符"判定
_INDEXED_SPEC_RE = re.compile(r"%\d+\$")


# --------------------------------------------------------------------------
# 数据模型
# --------------------------------------------------------------------------
@dataclass
class CheckOptions:
    """巡检参数。

    字段说明：
        source_lang / target_lang / include_jars / max_file_bytes
            与 ``ScanOptions`` 同名同义，直接透传给扫描器；
        check_untranslated
            是否启用"译文 == 原文"漏翻检测（默认开）。某些整合包刻意
            保留大量同形词（物品 ID、专有名词），如噪音过多可关掉；
        sample_limit
            每个 issue 最多记录多少个键名样本（默认 10，避免报告膨胀）；
        ignore_codes
            要跳过的**问题码**集合（如 ``{"stale_translation"}``）；
        progress_cb
            进度回调 ``progress_cb(done, total)``，按源语言文件计数；
            异常会被吞掉——进度上报失败不影响巡检。
    """

    source_lang: str = "en_us"
    target_lang: str = "zh_cn"
    include_jars: bool = True
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES
    check_untranslated: bool = True
    sample_limit: int = 10
    ignore_codes: frozenset[str] = field(default_factory=frozenset)
    progress_cb: Optional[Callable[[int, int], None]] = None


@dataclass
class Issue:
    """一条巡检问题（粒度 = 「一个文件 + 一个问题码」）。"""

    code: str
    path_in_pkg: str
    count: int = 1
    keys: list[str] = field(default_factory=list)
    detail: str = ""

    @property
    def severity(self) -> Severity:
        """级别取自 ``ISSUE_CATALOG``（未登记的问题码按 WARN 处理并可见）。"""
        return ISSUE_CATALOG.get(self.code, (Severity.WARN, ""))[0]

    @property
    def description(self) -> str:
        return ISSUE_CATALOG.get(self.code, (Severity.WARN, "未知问题"))[1]

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "severity": self.severity.value,
            "description": self.description,
            "file": self.path_in_pkg,
            "count": self.count,
            "keys": list(self.keys),
            "detail": self.detail,
        }


@dataclass
class QualityReport:
    """一次巡检的总报告（``check`` 命令的返回值，也是 check-report.json 的结构）。"""

    pack_root: str = ""
    source_lang: str = "en_us"
    target_lang: str = "zh_cn"
    files_scanned: int = 0        # 扫描到的语言文件总数（含目标语言现存文件）
    source_files: int = 0         # 参与巡检的源语言文件数
    paired_files: int = 0         # 找到目标语言文件、可逐条比对的文件数
    entries_checked: int = 0      # 实际逐条比对过的条目数
    issues: list[Issue] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)   # 巡检自身的告警（读不了的文件等）
    duration_sec: float = 0.0

    # ---- 汇总 ----
    def count(self, severity: Severity) -> int:
        """按级别统计 issue 条数（不是键数）。"""
        return sum(1 for issue in self.issues if issue.severity is severity)

    @property
    def error_count(self) -> int:
        return self.count(Severity.ERROR)

    @property
    def warn_count(self) -> int:
        return self.count(Severity.WARN)

    @property
    def info_count(self) -> int:
        return self.count(Severity.INFO)

    @property
    def ok(self) -> bool:
        """无 ERROR 级问题即视为"可发布"。"""
        return self.error_count == 0

    def by_code(self) -> list[tuple[str, int, int]]:
        """按问题码汇总：``[(code, 文件数, 受影响条目数), ...]``，按严重度排序。"""
        buckets: dict[str, list[int]] = {}
        for issue in self.issues:
            bucket = buckets.setdefault(issue.code, [0, 0])
            bucket[0] += 1
            bucket[1] += issue.count
        return sorted(
            ((code, files, entries) for code, (files, entries) in buckets.items()),
            key=lambda item: (
                _SEVERITY_ORDER[ISSUE_CATALOG.get(item[0], (Severity.WARN, ""))[0]],
                -item[2], item[0],
            ),
        )

    def sorted_issues(self) -> list[Issue]:
        """按「级别 → 问题码 → 路径」稳定排序，保证控制台与 JSON 输出可复现。"""
        return sorted(
            self.issues,
            key=lambda i: (
                _SEVERITY_ORDER[i.severity],
                i.code,
                i.path_in_pkg,
            ),
        )

    def to_dict(self) -> dict:
        return {
            "pack_root": self.pack_root,
            "source_lang": self.source_lang,
            "target_lang": self.target_lang,
            "files_scanned": self.files_scanned,
            "source_files": self.source_files,
            "paired_files": self.paired_files,
            "entries_checked": self.entries_checked,
            "summary": {
                "error": self.error_count,
                "warn": self.warn_count,
                "info": self.info_count,
                "by_code": [
                    {"code": code, "files": files, "entries": entries,
                     "severity": ISSUE_CATALOG.get(code, (Severity.WARN, ""))[0].value}
                    for code, files, entries in self.by_code()
                ],
            },
            "issues": [issue.to_dict() for issue in self.sorted_issues()],
            "warnings": list(self.warnings),
            "duration_sec": round(self.duration_sec, 3),
        }


# --------------------------------------------------------------------------
# 巡检主流程
# --------------------------------------------------------------------------
def check_pack(
    pack_root: Path,
    options: CheckOptions | None = None,
    *,
    scan_report: ScanReport | None = None,
) -> QualityReport:
    """对整合包做一轮只读质量巡检。

    ``scan_report`` 可传入已有的扫描结果（例如 ``translate --check`` 场景），
    避免重复扫描；为 ``None`` 时内部自行扫描。
    """
    options = options or CheckOptions()
    started = time.perf_counter()
    pack_root = Path(pack_root)

    report = QualityReport(
        pack_root=str(pack_root),
        source_lang=options.source_lang,
        target_lang=options.target_lang,
    )

    if scan_report is None:
        scan_report = scan(pack_root, ScanOptions(
            source_lang=options.source_lang,
            target_lang=options.target_lang,
            include_jars=options.include_jars,
            max_file_bytes=options.max_file_bytes,
        ))
        # 扫描阶段的告警原样带进巡检报告（编码异常、jar 读取失败等）
        report.warnings.extend(scan_report.warnings)

    report.files_scanned = len(scan_report.files)
    sources = [ref for ref in scan_report.files if _is_source_file(ref, scan_report)]
    report.source_files = len(sources)

    target_index = _build_target_index(scan_report)
    parsed_cache: dict[str, Optional[LangFile]] = {}
    guard = PlaceholderGuard()

    def _emit(code: str, ref: LangFileRef, *, count: int = 1,
              keys: list[str] | None = None, detail: str = "") -> None:
        """登记一条问题；被 ``ignore_codes`` 排除时静默丢弃。"""
        if code in options.ignore_codes:
            return
        report.issues.append(Issue(
            code=code, path_in_pkg=ref.path_in_pkg, count=count,
            keys=list(keys or [])[: options.sample_limit], detail=detail,
        ))

    # ---- 第一层 + 第二层：源语言文件（健康检查 + 与已有译文的逐条比对）----
    total = len(sources)
    for done, ref in enumerate(sources, start=1):
        try:
            _check_one_source(
                pack_root, ref, target_index, parsed_cache,
                options=options, report=report, guard=guard, emit=_emit,
            )
        except Exception as exc:  # noqa: BLE001 - 单文件失败不得中断整轮巡检
            report.warnings.append(
                f"{ref.path_in_pkg}：巡检失败（{type(exc).__name__}: {exc}）")
        if options.progress_cb is not None:
            try:
                options.progress_cb(done, total)
            except Exception:  # noqa: BLE001 - 进度上报失败不影响巡检
                pass

    # ---- 整合包自带的「目标语言文件」同样做健康检查 ----
    # 模组自带的中文往往比机翻更需要体检（重复键、编码、残缺色码都在这里暴露），
    # 且它们不参与"源文件"循环，容易被漏掉。解析失败的单独报 target_parse_error。
    for ref in scan_report.files:
        if not ref.is_target_existing:
            continue
        if ref.parse_status != "ok":
            _emit("target_parse_error", ref,
                  detail="；".join(ref.warnings[:2]) or f"parse_status={ref.parse_status}")
            continue
        parsed = _parse_ref(pack_root, ref, parsed_cache)
        if parsed is None:
            _emit("target_parse_error", ref, detail="读取或解析失败")
            continue
        try:
            _check_file_health(parsed, ref, guard, _emit)
        except Exception as exc:  # noqa: BLE001
            report.warnings.append(
                f"{ref.path_in_pkg}：巡检失败（{type(exc).__name__}: {exc}）")

    report.duration_sec = time.perf_counter() - started
    return report


def _is_source_file(ref: LangFileRef, report: ScanReport) -> bool:
    """判断一个引用是否应按「源语言文件」体检。

    比 ``ref.is_source_candidate`` 宽松一档：``is_source_candidate`` 额外要求
    ``parse_status == "ok"``，而**解析失败的源语言文件恰恰是巡检头号目标**
    （整个文件的条目都拿不到）。因此这里只按语言代码判定，并额外纳入
    语言代码识别不出、但被内容规则认定为语言文件的文件（个别模组把语言
    文件放错位置、文件名不含语言代码）。
    """
    if ref.is_target_existing:
        return False
    if ref.is_source_candidate or ref.lang_code == report.source_lang:
        return True
    return ref.lang_code is None and ref.detected_by == "content"


# --------------------------------------------------------------------------
# 内部：索引与单文件检查
# --------------------------------------------------------------------------
def _build_target_index(report: ScanReport) -> dict[tuple[str, str], LangFileRef]:
    """建立"源文件导出路径 → 同目录目标语言文件"的索引。

    键为 ``(容器相对路径, 导出相对路径)``：
        * 散装文件  → ("",        "overrides/.../zh_cn.json")
        * jar 内文件 → ("mods/a.jar", "assets/a/lang/zh_cn.json")

    容器的参与是必要的：不同 jar 内可以出现**完全相同**的 zip 内路径
    （多个库都注册 assets/minecraft/lang/），只按路径索引会串台。
    该键与扫描器的 ``export_relative_path`` 同源，天然与导出阶段一致。
    """
    index: dict[tuple[str, str], LangFileRef] = {}
    for ref in report.files:
        if not ref.is_target_existing:
            continue
        index.setdefault((ref.container or "", ref.export_relative_path), ref)
    return index


def _parse_ref(pack_root: Path, ref: LangFileRef,
               cache: dict[str, Optional[LangFile]]) -> Optional[LangFile]:
    """解析一个语言文件（带缓存）；解析失败返回 None 并记录原因到缓存。"""
    cached = cache.get(ref.path_in_pkg, _MISSING)
    if cached is not _MISSING:
        return cached  # type: ignore[return-value]
    parsed: Optional[LangFile]
    try:
        text, _meta = decode_bytes(read_ref_bytes(pack_root, ref))
        parsed = get_parser(ref.fmt).parse(text)
    except Exception:  # noqa: BLE001 - 交由调用方决定如何报告
        parsed = None
    cache[ref.path_in_pkg] = parsed
    return parsed


# 缓存未命中哨兵：与"已缓存但解析失败（None）"区分开，避免失败文件被反复重读
_MISSING = object()



def _check_one_source(
    pack_root: Path,
    ref: LangFileRef,
    target_index: dict[tuple[str, str], LangFileRef],
    parsed_cache: dict[str, Optional[LangFile]],
    *,
    options: CheckOptions,
    report: QualityReport,
    guard: PlaceholderGuard,
    emit: Callable[..., None],
) -> None:
    """检查单个源语言文件：先做文件健康检查，再（若有目标文件）逐条比对。"""
    # ---- 第一层：文件健康 ----
    if ref.parse_status == "error":
        emit("parse_error", ref, detail="；".join(ref.warnings[:2]))
        return
    if ref.parse_status == "skipped_too_large":
        emit("file_too_large", ref, detail="；".join(ref.warnings[:1]))
        return
    if ref.encoding != "utf-8" or ref.had_bom:
        emit("encoding_suspect", ref,
             detail=f"encoding={ref.encoding} bom={'有' if ref.had_bom else '无'}")

    source = _parse_ref(pack_root, ref, parsed_cache)
    if source is None:
        emit("parse_error", ref, detail="读取或解析失败")
        return

    _check_file_health(source, ref, guard, emit)

    # ---- 第二层：译文比对 ----
    target_ref = target_index.get((ref.container or "", ref.export_relative_path))
    if target_ref is None:
        return
    if target_ref.parse_status != "ok":
        return      # 统一在上面那条循环里报 target_parse_error，避免重复
    report.paired_files += 1

    target = _parse_ref(pack_root, target_ref, parsed_cache)
    if target is None:
        emit("target_parse_error", target_ref, detail="读取或解析失败")
        return

    _compare_entries(source, target, ref, target_ref,
                     options=options, guard=guard, emit=emit, report=report)


def _check_file_health(
    parsed: LangFile,
    ref: LangFileRef,
    guard: PlaceholderGuard,
    emit: Callable[..., None],
) -> None:
    """第一层检查：重复键 / 非字符串值 / 空值 / 孤立色码 / 混用格式符。

    源语言文件与整合包自带的目标语言文件都走这一套（函数不关心是谁）。
    """
    if parsed.duplicate_keys:
        emit("duplicate_key", ref, count=len(parsed.duplicate_keys),
             keys=parsed.duplicate_keys, detail="重复键后值覆盖前值")
    if parsed.non_string_keys:
        emit("non_string_value", ref, count=len(parsed.non_string_keys),
             keys=parsed.non_string_keys, detail="嵌套值原样保留、不参与翻译")

    empty_keys: list[str] = []
    stray_keys: list[str] = []
    mixed_keys: list[str] = []
    for key, entry in parsed.entries.items():
        value = entry.value
        if not value.strip():
            empty_keys.append(key)
            continue
        if value.rstrip().endswith("§"):
            stray_keys.append(key)
        if _has_mixed_format_spec(value, guard):
            mixed_keys.append(key)

    if empty_keys:
        emit("empty_source_value", ref, count=len(empty_keys), keys=empty_keys)
    if stray_keys:
        emit("stray_color_code", ref, count=len(stray_keys), keys=stray_keys)
    if mixed_keys:
        emit("mixed_format_spec", ref, count=len(mixed_keys), keys=mixed_keys,
             detail="MC 对混用会告警，且排版顺序易错")


def _compare_entries(
    source: LangFile,
    target: LangFile,
    source_ref: LangFileRef,
    target_ref: LangFileRef,
    *,
    options: CheckOptions,
    guard: PlaceholderGuard,
    emit: Callable[..., None],
    report: QualityReport,
) -> None:
    """第二层检查：逐条比对源文件与已有目标语言文件。"""
    missing: list[str] = []
    empty: list[str] = []
    untranslated: list[str] = []
    lost_pairs: list[str] = []       # "key: 丢失的具体占位符"
    added_pairs: list[str] = []
    lost_total = added_total = 0

    for key, src_entry in source.entries.items():
        if key not in target.entries:
            missing.append(key)
            continue
        report.entries_checked += 1
        src_value = src_entry.value
        tgt_value = target.entries[key].value

        if src_value.strip() and not tgt_value.strip():
            empty.append(key)
            continue
        if (options.check_untranslated and src_value.strip()
                and tgt_value.strip() == src_value.strip()
                and _HAS_WORD_RE.search(src_value)
                and not guard.is_passthrough(src_value)):
            untranslated.append(key)

        lost, added = _placeholder_diff(src_value, tgt_value, guard)
        if lost:
            lost_total += sum(lost.values())
            lost_pairs.append(f"{key}: " + _format_counter(lost))
        if added:
            added_total += sum(added.values())
            added_pairs.append(f"{key}: " + _format_counter(added))

    stale = [key for key in target.entries if key not in source.entries]

    if missing:
        emit("missing_translation", target_ref, count=len(missing), keys=missing)
    if stale:
        emit("stale_translation", target_ref, count=len(stale), keys=stale,
             detail="源文件已无这些键（模组更新遗留），可安全清理")
    if empty:
        emit("empty_translation", target_ref, count=len(empty), keys=empty)
    if untranslated:
        emit("untranslated", target_ref, count=len(untranslated), keys=untranslated)
    if lost_pairs:
        emit("placeholder_lost", target_ref, count=lost_total, keys=lost_pairs,
             detail=f"源自 {source_ref.path_in_pkg}")
    if added_pairs:
        emit("placeholder_added", target_ref, count=added_total, keys=added_pairs,
             detail=f"源自 {source_ref.path_in_pkg}")


# --------------------------------------------------------------------------
# 内部：占位符与格式符工具
# --------------------------------------------------------------------------
def _placeholder_diff(
    source_text: str, target_text: str, guard: PlaceholderGuard,
) -> tuple[Counter, Counter]:
    """比对源/译文的占位符多重集。

    返回 ``(lost, added)`` 两个 ``Counter``：
        lost  = 原文有、译文没有的占位符（**真事故**：游戏内格式化会错位/报错）
        added = 译文有、原文没有的占位符（多半是多打或把正文误当占位符）

    用多重集（而非集合）比较：``§a%s§r %s`` 少一个 ``%s`` 必须被发现。
    识别规则直接复用 ``PlaceholderGuard`` —— 与翻译时的保护口径完全同源。
    """
    src_counter = Counter(guard.analyze(source_text))
    tgt_counter = Counter(guard.analyze(target_text))
    lost = src_counter - tgt_counter
    added = tgt_counter - src_counter
    return lost, added


def _has_mixed_format_spec(text: str, guard: PlaceholderGuard) -> bool:
    """判断同一文本是否混用"顺序格式符"与"位置格式符"。

    只看被保护引擎认出来的 token 里的 Java 格式符（``%player%`` 这类成对变量
    不算）——保证与真正送进引擎的保护文本一致，不会把普通 ``%`` 误判。
    """
    indexed = plain = False
    for token in guard.analyze(text):
        if not JAVA_FORMAT_RE.fullmatch(token):
            continue
        if _INDEXED_SPEC_RE.match(token):
            indexed = True
        else:
            plain = True
        if indexed and plain:
            return True
    return False


def _format_counter(counter: Counter) -> str:
    """把 ``Counter`` 压成 ``"%s×2, §c×1"`` 形式的一行摘要。"""
    return ", ".join(f"{token}×{n}" for token, n in counter.most_common())
