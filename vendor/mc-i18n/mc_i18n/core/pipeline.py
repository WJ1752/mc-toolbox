"""翻译流水线（对应 PRD F05/F13）——把扫描、解析、翻译、导出串成完整闭环。

执行阶段：
    1. 扫描       scan() 产出映射表，筛出源语言候选文件（可 limit 截断）
    2. 收集       逐文件读取 → 解析 → 提取条目值 → 全局按原文去重
                  （同一原文跨文件只翻一次；占位符只依赖文本本身，去重安全）
                  增量合并模式下（v0.3.8）同时读出已有目标语言译文，已被
                  覆盖的键不生成翻译任务
    3. 占位符保护 PlaceholderGuard.protect() 把格式要素替换为 ⟦N⟧ token
    4. 缓存查询   sha256(protected+语言+引擎+模型) 命中 → 直接还原（=断点续翻）
    5. 并发翻译   ThreadPoolExecutor 按批并发；批内失败 → 备用引擎降级链；
                  还原失败 → 单条重试；仍失败 → 保留原文 + NEEDS_HUMAN 标记
    6. 导出       按映射表把译文写回原目录结构（translated/ 树）；
                  增量合并模式下，已有目标语言条目直接沿用、不覆盖
    7. 报告       统计 + 失败清单落盘 report.json（人工校对的输入）

单点失败纪律（全链路统一）：
    单文件读取/解析失败 → 告警跳过，不中断整体；
    单批翻译失败 → 备用引擎接管，再失败则该批条目保留原文；
    单条还原失败 → 单条重试，再失败保留原文；
    任何情况下：任务整体完成，失败细节全部进入 report.json 与日志。
"""

from __future__ import annotations

import json
import logging
import time
import concurrent.futures
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Callable

from .. import __version__
from ..config import AppConfig
from ..models import LangFileRef
from ..utils import decode_bytes
from . import exporters
from .cache import NullCache, TranslationCache, make_key
from .engines import BaseEngine, EngineError, create_engine
from .glossary import Glossary
from .placeholders import PlaceholderGuard, PlaceholderOrderError
from .parsers import get_parser
from .scanner import ScanOptions, scan
from . import snapshot

logger = logging.getLogger("mc_i18n.pipeline")

__all__ = ["PipelineOptions", "PipelineResult", "TranslationPipeline"]


# --------------------------------------------------------------------------
# 选项与结果容器
# --------------------------------------------------------------------------

class ExistingTargetPolicy(str, Enum):
    """整合包**已自带目标语言文件**时的处理策略（v0.3.8）。

    三种模式的取舍，决定了"机翻与社区/官方已有中文"如何共存：

    SKIP（默认）
        整体跳过这些文件。CPFA「只补翻缺失」工作流的原教旨做法：绝不覆盖
        好翻译。代价是**半截汉化**——模组自带一份残缺 zh_cn，整个文件
        就永远补不齐。

    MERGE（M2 增量合并）
        读出已有译文，**逐键保留**，只对缺失/空值的键调用引擎，最后合并
        导出。既不动社区译文，又把残缺文件补全。

    OVERWRITE
        无视已有译文，全量机翻（``--translate-existing``）。文件多出一个
        仅含源语言键的完整译文，不再残留旧译。
    """

    SKIP = "skip"
    MERGE = "merge"
    OVERWRITE = "overwrite"


def resolve_existing_policy(options: "PipelineOptions") -> ExistingTargetPolicy:
    """把两个布尔开关解析成唯一策略（merge > skip > overwrite）。

    保留 ``skip_existing_translations`` 这个既有的布尔参数（CLI/WebUI/测试
    都在用），只在其上叠加"合并"这一档，避免破坏既有调用方。
    """
    if options.merge_existing:
        return ExistingTargetPolicy.MERGE
    if options.skip_existing_translations:
        return ExistingTargetPolicy.SKIP
    return ExistingTargetPolicy.OVERWRITE


# --------------------------------------------------------------------------
# v0.3.8 实时译文流参数
# --------------------------------------------------------------------------
# 缓存命中条目进译文流的上限。缓存命中是瞬时的，全量上报只会把前端刷爆，
# 抽样既能让人看到"有内容"，又不至于让 1 秒轮询的载荷失去意义。
_CACHE_ENTRY_SAMPLE = 30

# 单条译文在事件里携带的最大字符数（超出截断）。
# 语言文件里偶尔有整段说明文字（MOTD、README 类），原样塞进每秒轮询的
# JSON 会让"进度查询"变成大文件传输；前端展示本来也是一行一个。
_ENTRY_TEXT_LIMIT = 240


def _clip(text: str | None, limit: int = _ENTRY_TEXT_LIMIT) -> str | None:
    """把过长文本截断（None 原样透传）。"""
    if text is None:
        return None
    return text if len(text) <= limit else text[:limit] + "…"


def _task_event(task: "_Task", *, cached: bool = False) -> dict:
    """把翻译任务的结果整理成一条 "entry" 事件（v0.3.8）。"""
    return {
        "type": "entry",
        "ok": bool(task.done and task.failed_reason is None),
        "source": _clip(task.source),
        "translation": _clip(task.translation) if task.done else None,
        "review": _clip(task.review_note),
        "failed": _clip(task.failed_reason),
        "cached": cached,
    }


@dataclass
class PipelineOptions:
    """一次翻译任务的参数（CLI 参数 + 配置文件合并后的内存形态）。"""

    source_lang: str = "en_us"
    target_lang: str = "zh_cn"
    include_jars: bool = True
    engine_primary: str | None = None            # 覆盖 config.engine.primary
    engine_fallback: list[str] | None = None     # 覆盖 config.engine.fallback
    force_refresh: bool = False                  # 强制重翻（忽略缓存读）
    dry_run: bool = False                        # 只统计不翻译不写文件
    limit: int = 0                               # 只处理前 N 个候选文件（0=不限）
    workers: int | None = None                   # None → config.workers
    no_cache: bool = False                       # 本次任务禁用缓存
    out_dir: Path | None = None                  # None → <整合包>/.mc-i18n/translated
    glossary: "Glossary | None" = None           # 术语表：None = 不启用术语保护
    # 整合包/模组已自带目标语言翻译（zh_cn.json 已存在）时默认跳过，
    # 避免资源包覆盖社区/官方的优质中文（CFPA 工作流："只补翻缺失"）。
    # 关闭此开关（--translate-existing）可强制重翻全部文件。
    skip_existing_translations: bool = True
    # M2 增量合并（v0.3.8）：已自带目标语言翻译的文件不再"整体跳过"，而是
    # **保留既有译文、只补翻缺失条目**后合并导出 —— 兼顾"不覆盖好翻译"与
    # "不留半截汉化"。优先级高于 skip_existing_translations（同时为真时按合并走）；
    # 三者语义见 ExistingTargetPolicy。
    merge_existing: bool = False
    # 外部取消探针（WebUI"停止"按钮）：返回 True 时停止剩余批次。
    # 已翻译完成的条目照常导出；未翻译的保留原文 ——
    # 配合翻译缓存，重新运行会自动命中缓存续翻，等效"暂停/继续"。
    cancel_check: "Callable[[], bool] | None" = None
    # 进度回调（v0.3.3 新增，可选）：流水线在每个阶段推进时调用
    # progress_cb(stage, done, total)。
    #   stage 取值：
    #     "scan"      扫描/跳过已有译文检查阶段（done/total 为已检查文件数）
    #     "collect"   收集与去重阶段（逐文件）
    #     "translate" 并发翻译阶段（done/total 为已完成的"唯一原文"任务数，
    #                 total 为去重后待翻条数——跨文件同文只翻一次）
    #     "export"    导出写盘阶段（逐文件）
    # 回调在流水线主线程同步调用，必须轻量（只做状态记录，勿做 IO）；
    # 回调抛出的异常会被吞掉——进度上报失败绝不影响翻译任务本身。
    progress_cb: "Callable[[str, int, int], None] | None" = None
    # 结构化事件回调（v0.3.8 新增，可选）：把 progress_cb 承载不了的
    # "逐条译文流"与"速率/预计剩余"以事件形式送出去。**不替代** progress_cb，
    # 两者共用同一调用点——老的 (stage, done, total) 契约一字未改，
    # 因此 CLI / 既有调用方无需改动。
    #
    # event_cb(event: dict)，event["type"] 取值：
    #   "progress"  阶段推进。字段 stage/done/total，另带 rate（单位/秒，未知为
    #               None）与 eta_sec（本阶段预计剩余秒数，未知为 None）。
    #   "entry"     产出一条译文（或一条失败条目）。字段：
    #               ok(bool)     True=已产出译文；False=失败保留原文
    #               source       原文
    #               translation  译文（ok=False 时为 None）
    #               review       非空=译文已采纳但建议人工复核（原因字符串）
    #               failed       非空=失败原因
    #               cached       True=来自缓存（未调用引擎）
    #
    # 与 progress_cb 一致：**只在流水线主线程调用**（worker 线程不直接回调，
    # 完成一批后在主循环里按批补发），异常一律吞掉，且必须轻量。
    # 为控制前端负载，缓存命中条目只抽样上报（见 _CACHE_ENTRY_SAMPLE）。
    event_cb: "Callable[[dict], None] | None" = None


@dataclass
class FileStat:
    """单文件的翻译结果统计（report.json 的 files 数组元素）。"""

    path_in_pkg: str
    export_relative_path: str
    container: str | None
    fmt: str
    entry_count: int          # 可翻译条目数（非空值）
    translated: int = 0
    failed: int = 0
    # v0.3.8 增量合并：沿用已有目标语言文件、未被机翻覆盖的条目数
    kept_existing: int = 0
    status: str = "ok"        # ok | partial | error | skipped_existing（已自带译文而跳过）
    error: str | None = None


@dataclass
class PipelineResult:
    """一次翻译任务的总结果（report.json 的内存形态 + CLI 展示用统计）。"""

    pack_root: str
    source_lang: str
    target_lang: str
    engine_primary: str
    engine_fallback: list[str]
    dry_run: bool
    duration_sec: float = 0.0
    output_dir: Path | None = None
    cache_path: Path | None = None
    # ---- 统计 ----
    files_total: int = 0
    files_ok: int = 0
    files_partial: int = 0
    files_error: int = 0
    files_skipped_existing: int = 0    # 因"整合包已自带目标语言翻译"而跳过的文件数
    # v0.3.8 增量合并（--merge-existing）统计
    files_merged: int = 0              # 走"合并"路径的文件数（存在已有目标语言文件）
    entries_kept_existing: int = 0     # 沿用既有译文、未被机翻覆盖的条目数
    existing_policy: str = "skip"      # 本次实际生效的策略（skip/merge/overwrite）
    entries_total: int = 0            # 去重前：所有候选文件的待译条目数
    unique_sources: int = 0           # 去重后：唯一原文数
    entries_translated: int = 0
    entries_from_cache: int = 0
    entries_failed: int = 0
    entries_new: int = 0               # 相对上次快照新增的原文条数（增量更新功能）
    entries_passthrough: int = 0       # 纯占位符条目（无可译正文），原样保留不调引擎（v0.3.4）
    api_calls: int = 0                # 引擎实际发出的 HTTP 请求数（含重试）
    chars_sent: int = 0               # 发送给引擎的字符总量（配额参考）
    # v0.3.7：真正产出译文的引擎（主引擎失败降级到备用时，这里记的是备用引擎名）。
    # 与 engine_primary（请求的引擎）区分——真机事故中报告写着 openai、
    # 日志写着 demo、配置写着 google，三方不一致让人无法定位问题。
    engine_used: str = ""
    cancelled: bool = False           # 任务被外部手动停止（已翻部分照常导出）
    files: list[FileStat] = field(default_factory=list)
    failures: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    # v0.3.3：已产出译文但建议人工复核的条目（当前来源：占位符乱序回填）。
    # 与 failures（保留原文待补翻）不同，这些条目译文已导出，只是质量
    # 需要人眼把关——详情见 report.json 的 review_suggested 数组。
    review_suggested: list[dict] = field(default_factory=list)

    def summary_line(self) -> str:
        """一行式摘要（CLI 结束输出）。"""
        if self.dry_run:
            return (f"[预览] 文件 {self.files_total} | 条目 {self.entries_total}"
                    f"（唯一原文 {self.unique_sources}）| 缓存命中 {self.entries_from_cache}"
                    f" | 待翻译 {self.entries_total - self.entries_from_cache}")
        return (f"文件 {self.files_total}（成功 {self.files_ok} / 部分 {self.files_partial}"
                f" / 失败 {self.files_error}"
                + (f" / 已有中文跳过 {self.files_skipped_existing}" if self.files_skipped_existing else "")
                + (f" / 增量合并 {self.files_merged}" if self.files_merged else "")
                + ("）[已手动停止]" if self.cancelled else "）")
                + f" | 条目 {self.entries_total}"
                f"（译出 {self.entries_translated}，缓存 {self.entries_from_cache}，"
                + (f"沿用既有 {self.entries_kept_existing}，"
                   if self.entries_kept_existing else "")
                + f"失败 {self.entries_failed}）| API {self.api_calls} 次"
                f" / {self.chars_sent} 字符")


# --------------------------------------------------------------------------
# 内部任务单元
# --------------------------------------------------------------------------

@dataclass
class _Task:
    """一个"唯一原文"的翻译任务（跨文件共享）。"""

    source: str                    # 原文（条目值）
    protected: str = ""            # 占位符保护后的文本（送引擎）
    tokens: list[str] = field(default_factory=list)
    translation: str | None = None
    failed_reason: str | None = None
    done: bool = False
    # v0.3.3：非空 = 译文已采纳但建议人工复核（如乱序回填）；进
    # report.json 的 review_suggested 清单，由校对台/人工跟进
    review_note: str | None = None


class TranslationPipeline:
    """翻译流水线：组合配置、引擎、缓存、占位符保护与导出器完成端到端任务。"""

    def __init__(self, app_config: AppConfig):
        self.app = app_config
        # v0.3.7：本次运行真正产出译文的引擎名（工作线程写入，见 _note_engine_used）
        self._engine_used: str = ""

    # ------------------------------------------------------------------
    # 主入口
    # ------------------------------------------------------------------
    def run(self, pack_root: str | Path, options: PipelineOptions) -> PipelineResult:
        started = time.perf_counter()
        pack_root = Path(pack_root).resolve()

        # ---- 进度回调的安全包装：上报失败只告警，绝不影响任务 ----
        progress_cb = options.progress_cb
        event_cb = options.event_cb

        def _report(stage: str, done: int, total: int, *,
                    rate: float | None = None,
                    eta_sec: float | None = None) -> None:
            """阶段推进上报（v0.3.3 的 3 参数契约 + v0.3.8 的速率/ETA 附加量）。

            rate / eta_sec 是**关键字可选**参数：既有调用方（scan /
            _export / _translate_pending 的 report_progress 形参）仍按
            3 个位置参数调用，行为与 v0.3.8 完全一致。
            """
            if progress_cb is not None:
                try:
                    progress_cb(stage, done, total)
                except Exception as exc:  # noqa: BLE001 - 进度上报失败不影响翻译
                    logger.debug("进度回调异常（已忽略）：%s", exc)
            _emit({"type": "progress", "stage": stage, "done": done,
                   "total": total, "rate": rate, "eta_sec": eta_sec})

        def _emit(event: dict) -> None:
            """发出结构化事件（v0.3.8）。异常吞掉，绝不反噬翻译任务。"""
            if event_cb is None:
                return
            try:
                event_cb(event)
            except Exception as exc:  # noqa: BLE001 - 事件上报失败不影响翻译
                logger.debug("事件回调异常（已忽略）：%s", exc)

        result = PipelineResult(
            pack_root=str(pack_root),
            source_lang=options.source_lang,
            target_lang=options.target_lang,
            engine_primary=options.engine_primary or self.app.engine.primary,
            engine_fallback=(options.engine_fallback if options.engine_fallback is not None
                             else list(self.app.engine.fallback)),
            dry_run=options.dry_run,
        )
        policy = resolve_existing_policy(options)
        result.existing_policy = policy.value

        # ---- 1) 扫描 ----
        logger.info("开始扫描整合包：%s", pack_root)
        _report("scan", 0, 0)
        report = scan(pack_root, ScanOptions(
            source_lang=options.source_lang,
            target_lang=options.target_lang,
            include_jars=options.include_jars,
            # 扫描器内部逐文件进度 → 统一经 _report 转发（stage="scan"）
            progress_cb=lambda done, total: _report("scan", done, total),
        ))
        refs = [r for r in report.files if r.is_source_candidate and r.parse_status == "ok"]
        result.files_total = len(refs)
        # ---- 1.5) 处理"整合包已自带目标语言翻译"的文件 ----
        # 模组 jar 内或 overrides 中已有 zh_cn.json → 该模组已有社区/官方翻译，
        # 机翻产物会以资源包形式覆盖它们（资源包优先级高于 jar 内置语言）。
        #   SKIP（默认） 整体跳过，不重翻；
        #   MERGE        保留既有译文、只补翻缺失条目（合并发生在收集/导出阶段，
        #                这里不做任何剔除——文件仍需进入流水线）；
        #   OVERWRITE    全量重翻（--translate-existing）。
        if policy is ExistingTargetPolicy.SKIP:
            kept: list = []
            for sk_idx, ref in enumerate(refs):
                # 跳过检查需要逐个解包 jar 比对目标语言文件，大包下耗时可观，
                # 纳入 scan 阶段进度（调用方据此显示"检查已有翻译 x/n"）
                _report("scan", sk_idx + 1, len(refs))
                if exporters.target_language_exists(pack_root, ref):
                    result.files_skipped_existing += 1
                    result.files.append(FileStat(
                        path_in_pkg=ref.path_in_pkg,
                        export_relative_path=ref.export_relative_path,
                        container=ref.container, fmt=ref.fmt.value,
                        entry_count=ref.entry_count, status="skipped_existing",
                    ))
                    logger.info("整合包已自带 %s 翻译，跳过不覆盖：%s",
                                options.target_lang, ref.path_in_pkg)
                else:
                    kept.append(ref)
            refs = kept
            if result.files_skipped_existing:
                logger.info("共跳过 %d 个已有翻译的文件（--translate-existing 可强制重翻，"
                            "--merge-existing 可只补翻缺失）", result.files_skipped_existing)
        if options.limit > 0:
            refs = refs[:options.limit]
        result.entries_total = sum(r.entry_count for r in refs)
        result.warnings.extend(report.warnings)
        logger.info("扫描完成：%d 个候选文件，%d 条待译条目（耗时 %.1fs）",
                    len(refs), result.entries_total, time.perf_counter() - started)
        if not refs:
            logger.warning("未找到可翻译的语言文件（确认存在 %s 源语言文件，"
                           "或用 --lang 指定其它源语言）", options.source_lang)
            result.duration_sec = round(time.perf_counter() - started, 3)
            return result

        # ---- 2) 引擎与缓存准备 ----
        primary = create_engine(result.engine_primary, self.app)
        fallbacks: list[BaseEngine] = []
        for name in result.engine_fallback:
            try:
                fallbacks.append(create_engine(name, self.app))
            except (ValueError, Exception) as exc:  # 备用引擎配置问题只告警不中断
                result.warnings.append(f"备用引擎 {name!r} 不可用：{exc}")
        engines_used = [primary] + fallbacks
        for eng in engines_used:
            eng.configure_languages(options.source_lang, options.target_lang)
            # LLM 类引擎（openai 兼容）：术语走 prompt 指令而非 token 保护——
            # GLM 等模型对密集 ⟦N⟧ 标记经常吞标记导致整条失败，而"对照表指令"
            # 它们执行得很好；译文回来后仍会做 apply_after_restore 统一兜底
            if options.glossary and getattr(eng, "prefers_glossary_instructions", False):
                eng.set_glossary(options.glossary)
        # 术语保护策略按主引擎能力二选一：AI 引擎不 token 化（literal_terms 置空），
        # 传统引擎照旧保护。真占位符（%s/§/{} 等）所有引擎都照常保护。
        glossary_literal_terms: tuple[str, ...] = ()
        if options.glossary and not getattr(primary, "prefers_glossary_instructions", False):
            glossary_literal_terms = options.glossary.literal_terms()
        logger.info("主引擎：%s，备用：%s", result.engine_primary,
                    ",".join(result.engine_fallback) or "无")

        out_dir = Path(options.out_dir) if options.out_dir else \
            pack_root / ".mc-i18n" / "translated"
        cache = self._make_cache(pack_root, options, result)

        # ---- 3) 收集与去重 + 占位符保护 ----
        guard = PlaceholderGuard(self.app.protect)
        tasks_by_source: dict[str, _Task] = {}
        # 增量合并：path_in_pkg → {语言键: 既有译文}。只有 MERGE 模式会填充；
        # 导出的终验与写盘都依赖它 ——「既有译文优先于机翻」这条规则在
        # 收集阶段（不生成任务）与导出阶段（直接写入）各执行一次，两处口径一致。
        merge_map: dict[str, dict[str, str]] = {}
        # v0.3.8：先报一条 (0, total) 作为阶段起点 —— 下游据此把"本阶段已耗时"
        # 的计时器钉在阶段真正开始处（否则第一条完成时 elapsed≈0，ETA 会失真）
        _report("collect", 0, len(refs))
        for col_idx, ref in enumerate(refs):
            _report("collect", col_idx + 1, len(refs))
            try:
                text, _meta = decode_bytes(exporters.read_ref_bytes(pack_root, ref))
                parsed = get_parser(ref.fmt).parse(text)
            except Exception as exc:  # 单文件失败不中断
                logger.error("文件读取/解析失败，跳过 %s：%s", ref.path_in_pkg, exc)
                result.files.append(FileStat(
                    path_in_pkg=ref.path_in_pkg,
                    export_relative_path=ref.export_relative_path,
                    container=ref.container, fmt=ref.fmt.value,
                    entry_count=ref.entry_count, status="error",
                    error=f"读取/解析失败：{type(exc).__name__}: {exc}",
                ))
                continue
            kept: dict[str, str] = {}
            if policy is ExistingTargetPolicy.MERGE:
                kept = self._load_existing_entries(pack_root, ref, parsed, result)
                if kept:
                    merge_map[ref.path_in_pkg] = kept
                    result.files_merged += 1
                    result.entries_kept_existing += len(kept)
                    logger.info("增量合并 %s：沿用既有译文 %d 条，其余补翻",
                                ref.path_in_pkg, len(kept))
            for entry in parsed.entries.values():
                source = entry.value
                if not source.strip():
                    continue          # 空值不翻译
                if entry.key in kept:
                    continue          # 增量合并：该键已有社区/官方译文，不送引擎
                if source not in tasks_by_source:
                    # 术语表启用时（传统引擎）：术语原文先于普通占位符被保护为
                    # token，引擎接触不到术语文本，译文由术语表统一回填译法；
                    # LLM 引擎（prefers_glossary_instructions）术语改走 prompt
                    # 指令，不产生术语 token（防模型吞 ⟦N⟧），见 engines/base.py
                    protected, tokens = guard.protect(source, glossary_literal_terms)
                    task = _Task(source=source, protected=protected, tokens=tokens)
                    if tokens and guard.is_passthrough(protected):
                        # v0.3.4：纯 token 条目（整条只有色码/占位符、无可译正文，
                        # 如 §r 装饰行）直接原样通过——交给 LLM 只会得到不可控
                        # 输出（实测"应有 1 个 ⟦N⟧，译文识别到 0 个"即此类）。
                        task.translation = source
                        task.done = True
                        result.entries_passthrough += 1
                    tasks_by_source[source] = task
        if result.entries_passthrough:
            logger.info("其中 %d 条为纯占位符条目（无可译正文），原样保留不调用引擎",
                        result.entries_passthrough)
        result.unique_sources = len(tasks_by_source)
        logger.info("原文去重后 %d 条待处理", len(tasks_by_source))

        # ---- 增量统计：与上次快照对比，得到"本次新增"条目数 ----
        current_fp = {snapshot.fingerprint(s) for s in tasks_by_source}
        previous_fp = snapshot.load_snapshot(pack_root)
        new_fp = snapshot.diff_new(current_fp, previous_fp)
        result.entries_new = len(new_fp)
        if previous_fp:
            logger.info("相对上次翻译：新增 %d 条，沿用 %d 条",
                        len(new_fp), len(current_fp) - len(new_fp))

        # ---- 4) 缓存查询 ----
        pending: list[_Task] = []
        cache_hits: list[_Task] = []      # v0.3.8：进实时译文流的缓存命中样本
        # 术语回填：restore 返回的是术语"原文"，这里统一替换为译法
        def _post_restore(text: str) -> str:
            return options.glossary.apply_after_restore(text) if options.glossary else text

        for task in tasks_by_source.values():
            if task.done:
                continue    # 纯占位符条目已在收集阶段原样通过，无需查缓存
            # 缓存键用 **protected**（token 空间）文本构造，这是刻意的：
            # 缓存 value 也是 token 空间的引擎输出，还原由各任务持自己的
            # tokens 完成。因此两条不同原文若 token 化后同形（术语碰撞），
            # 共用一条缓存是**安全**的——restore 会各自回到正确译法；
            # 若把 source 掺进键，只会平白多存一份同值条目。（v0.3.9 备注：
            # 曾有"缓存串味"的疑诊，实测为 _group_batches 丢任务所致，见其 docstring。）
            key = make_key(task.protected, options.target_lang, primary.name, primary.model_tag())
            if not options.force_refresh:
                cached = cache.get(key)
                if cached is not None:
                    try:
                        task.translation = _post_restore(guard.restore(cached, task.tokens))
                        task.done = True
                        result.entries_from_cache += 1
                        cache_hits.append(task)
                        continue
                    except Exception as exc:
                        # 缓存内容损坏/保护开关变化导致无法还原 → 重新翻译
                        logger.warning("缓存条目无法还原，将重新翻译：%s", exc)
            pending.append(task)
        logger.info("缓存命中 %d 条，需调用引擎 %d 条", result.entries_from_cache, len(pending))
        # ---- v0.3.8 实时译文流：缓存命中抽样上报 ----
        # 缓存命中是瞬时完成的（不产生"翻译中"的观感），全量上报反而把前端刷爆；
        # 但一条都不报会让"全部命中缓存"的场景下译文流面板空空如也，
        # 所以按上限抽样，前端把它们标成【缓存】与真正机翻的条目区分开。
        for task in cache_hits[:_CACHE_ENTRY_SAMPLE]:
            _emit(_task_event(task, cached=True))

        # ---- 5) 并发翻译 ----
        if pending and not options.dry_run:
            self._translate_pending(pending, primary, fallbacks, guard,
                                    cache, options, result,
                                    report_progress=_report, emit=_emit)
        result.entries_translated = sum(1 for t in tasks_by_source.values() if t.done)
        result.entries_failed = len(pending) if options.dry_run else \
            sum(1 for t in pending if not t.done)
        result.api_calls = sum(eng.request_count for eng in engines_used)
        result.chars_sent = sum(eng.chars_sent for eng in engines_used)
        # v0.3.7：记录真正产出译文的引擎（可能因降级而不同于 engine_primary）
        result.engine_used = self._engine_used or result.engine_primary

        # ---- 6) 导出 ----
        if not options.dry_run:
            self._export(pack_root, refs, tasks_by_source, guard, out_dir, result,
                         report_progress=_report, merge_map=merge_map)
            result.output_dir = out_dir
            self._save_report(result, pack_root, options)
            # 快照在"成功运行后"更新 —— 供下次运行计算增量
            snapshot.save_snapshot(pack_root, current_fp)
            logger.info("译文已导出：%s", out_dir)

        # ---- 7) 缓存元信息与收尾 ----
        if isinstance(cache, TranslationCache):
            cache.set_meta("last_task", json.dumps({
                "pack_root": str(pack_root),
                "source_lang": options.source_lang,
                "target_lang": options.target_lang,
                "engine": result.engine_primary,
                "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }, ensure_ascii=False))
            cache.close()
            result.cache_path = cache.db_path

        result.duration_sec = round(time.perf_counter() - started, 3)
        return result

    # ------------------------------------------------------------------
    # 并发翻译
    # ------------------------------------------------------------------
    def _translate_pending(self, pending: list[_Task], primary: BaseEngine,
                           fallbacks: list[BaseEngine], guard: PlaceholderGuard,
                           cache, options: PipelineOptions,
                           result: PipelineResult,
                           report_progress: "Callable[[str, int, int], None] | None" = None,
                           emit: "Callable[[dict], None] | None" = None,
                           ) -> None:
        """把待译任务装箱后交给线程池并发执行（每批一个 future）。

        report_progress：翻译阶段进度回调（v0.3.3），每完成一批累计
        已完成条数并上报 ("translate", done, total)，并附上速率与预计剩余。

        emit（v0.3.8）：结构化事件出口 —— 每完成一批，把该批**逐条**译文
        以 "entry" 事件补发。补发在主线程做（不在 worker 里回调），
        所以两个回调的线程契约完全一致：谁都不必自己加锁。
        """
        workers = options.workers or self.app.workers
        batches = primary.chunk([t.protected for t in pending])
        logger.info("开始并发翻译：%d 批 × %d 线程", len(batches), workers)
        if not batches:
            return
        total_tasks = len(pending)
        # v0.3.8：阶段起点上报（ETA 计时基准，见 _report 的 eta_sec 说明）
        if report_progress is not None:
            report_progress("translate", 0, total_tasks)
        # 术语回填回调：restore 返回术语"原文"，统一替换为译法（None = 未启用）
        def _post_restore(text: str) -> str:
            return options.glossary.apply_after_restore(text) if options.glossary else text

        with ThreadPoolExecutor(max_workers=max(1, workers),
                                thread_name_prefix="mc-i18n") as pool:
            # future → 该批任务数（完成后用于累计进度；v0.3.3 真实进度条）
            futures = {
                pool.submit(self._translate_batch, batch_tasks, primary,
                            fallbacks, guard, cache, options.target_lang,
                            _post_restore): len(batch_tasks)
                for batch_tasks in self._group_batches(batches, pending)
            }
            done_tasks = 0
            cancelled = False
            # v0.3.8 ETA 基准：从“第一批发出去”开始计时，而不是从进入函数起算
            # ——装箱/分块本身也是耗时，但那是准备成本，不该摊进翻译速率。
            eta_clock = time.perf_counter()
            for future in as_completed(futures):
                outcomes: list[dict] = []
                try:
                    outcomes = future.result() or []
                except concurrent.futures.CancelledError:
                    continue    # 被撤销的排队批次：正常现象，静默跳过
                except Exception as exc:  # 防御：批处理内部已捕获，此处兜底
                    logger.error("批次处理异常（已兜底捕获）：%s", exc)
                # 批次完成 → 逐条补发译文事件（前端"实时显示翻译了哪些语句"）
                if emit is not None:
                    for ev in outcomes:
                        emit(ev)
                # 批次完成 → 累计已完成条数并上报（翻译阶段的真实进度源）
                done_tasks += futures[future]
                done_now = min(done_tasks, total_tasks)
                elapsed = max(time.perf_counter() - eta_clock, 1e-6)
                rate = done_now / elapsed if done_now else None
                eta_sec = ((total_tasks - done_now) / rate) if rate else None
                if report_progress is not None:
                    report_progress("translate", done_now, total_tasks,
                                    rate=rate, eta_sec=eta_sec)
                # 取消探针：外部（WebUI"停止"按钮）请求停止 → 撤销所有
                # 还在排队的批次；正在执行的批次等它自然结束（几秒内）。
                # 未被翻译的任务保持未完成 → 导出时保留原文（无损）。
                if not cancelled and options.cancel_check and options.cancel_check():
                    cancelled = True
                    logger.info("收到停止请求：撤销剩余 %d 个排队批次，等待进行中的批次完成…",
                                sum(1 for f in futures if not f.done()))
                    for f in futures:
                        f.cancel()
            if cancelled:
                result.cancelled = True
                logger.info("已停止翻译：已完成的 %d 条照常导出，"
                            "未翻译的保留原文（重新运行可自动续翻，缓存生效）",
                            result.entries_from_cache)

    @staticmethod
    def _group_batches(text_batches: list[list[str]],
                       pending: list[_Task]) -> list[list[_Task]]:
        """把"受保护文本批次"映射回"任务批次"（顺序一致，逐个认领）。

        v0.3.9 缺陷修复（core·重要）——"受保护文本碰撞导致静默漏翻"：
        旧实现以 protected 文本为键、用 setdefault 建 protected→task 表。
        当两条**不同原文**经术语表 token 化后落到**同一**受保护文本时
        （例：术语 "Speed" 与 "Efficiency" 都在表里，"Speed: %d%%" 与
        "Efficiency: %d%%" 都变成 "⟦0⟧: ⟦1⟧⟦2⟧"），后一条会被 setdefault
        折叠掉——它永远拿不到批次 → done 恒为 False 且 failed_reason 为
        None → 汇总阶段落到 "未知原因" 分支，**静默保留英文且不报错**。

        改为**按出现次数逐个认领**：受保护文本相同的任务排成 FIFO，每
        遇到一次该文本就出队一个任务。BaseEngine.chunk() 是保序的贪心
        装箱（只做切分，不重排、不去重），因此"批次中的文本序列"与
        "pending 中的任务序列"逐位对应，逐个认领得到的正是原任务对象；
        即便某引擎的 chunk() 重排了批次，只要文本多重集不变，此处仍能
        一一配齐（同形文本对调无害——还原用的 tokens 挂在任务自己身上）。
        """
        queues: dict[str, deque[_Task]] = {}
        for task in pending:
            queues.setdefault(task.protected, deque()).append(task)
        grouped: list[list[_Task]] = []
        for batch in text_batches:
            tasks: list[_Task] = []
            for text in batch:
                queue = queues.get(text)
                if not queue:
                    # 只可能来自"chunk() 篡改文本"的实现错误（丢字/造字），
                    # 显式报错好过静默错配。
                    raise RuntimeError(
                        f"批次装箱与待译任务不一致：受保护文本未在待译集合中"
                        f"（或出现次数不匹配）→ {text!r:.120}"
                    )
                tasks.append(queue.popleft())
            grouped.append(tasks)
        return grouped

    def _note_engine_used(self, name: str) -> None:
        """记录真正产出译文的引擎名（v0.3.7）。

        多线程下用锁保护；多个引擎混合产出时（降级链部分命中）取"产出最多"
        的语义无法在不引入计数的前提下表达，这里采用**出现即记录、首个胜出**
        的简单策略——实际场景中降级链几乎总是整批整批地切换，首个成功的
        引擎就代表了主体产出，足以让报告的 engine 字段不再自相矛盾。
        """
        if not self._engine_used:
            self._engine_used = name

    def _translate_batch(self, batch: list[_Task], primary: BaseEngine,
                         fallbacks: list[BaseEngine], guard: PlaceholderGuard,
                         cache, target_lang: str, post_restore=None) -> list[dict]:
        """翻译一批任务：主引擎 → 备用引擎降级链 → 逐条还原校验 → 缓存写回。

        返回该批**逐条**结果事件（v0.3.8）。不改由 worker 线程直接回调前端，
        而是把结果交回主线程统一发出 —— 回调契约（主线程调用）因此保持成立。
        """
        texts = [t.protected for t in batch]
        engines_chain: list[BaseEngine] = [primary, *fallbacks]
        last_error: Exception | None = None

        for engine in engines_chain:
            try:
                outputs = engine.translate_batch_with_retry(texts)
                if len(outputs) != len(texts):
                    raise EngineError(
                        f"引擎 {engine.name} 返回条数不匹配："
                        f"发送 {len(texts)}，返回 {len(outputs)}"
                    )
            except EngineError as exc:
                logger.warning("引擎 %s 批量翻译失败（%d 条）：%s", engine.name, len(batch), exc)
                last_error = exc
                continue   # 降级到下一个引擎

            # ---- 批量成功：逐条还原（还原失败单条重试）----
            self._note_engine_used(engine.name)
            for task, output in zip(batch, outputs):
                self._finalize_task(task, output, engine, guard, cache, target_lang,
                                    post_restore=post_restore)
            return [_task_event(t) for t in batch]

        # ---- 所有引擎都失败：整批标记失败（保留原文，进失败清单）----
        for task in batch:
            task.failed_reason = f"所有引擎失败：{last_error}"
        return [_task_event(t) for t in batch]

    def _finalize_task(self, task: _Task, output: str, engine: BaseEngine,
                       guard: PlaceholderGuard, cache, target_lang: str,
                       post_restore=None) -> None:
        """还原单条译文 + 校验 + 缓存写回；失败则单条重试一次，仍失败保留原文。

        缓存写回的是【引擎返回的受保护译文】（含 ⟦N⟧ token）——
        读缓存时按当前任务自己的 token 表还原，跨任务复用语义正确。
        post_restore：restore 成功后的后处理回调（术语表原文→统一译法）；
        仅作用于 task.translation，不影响缓存写入的受保护译文。

        v0.3.4 变更：restore 已在 auto/always 策略下直接容忍编号完整的
        乱序（按编号回填，译文语序保留），PlaceholderOrderError 不再产生，
        v0.3.3 的"重试→采纳回填→转人工复核"降级链退出现役主路径；
        下方 except PlaceholderOrderError 分支保留为防御（配置 never 之外
        理论上无抛出点，若未来策略再分化可在此兜底）。
        """
        cached_output: str | None = None
        try:
            task.translation = guard.restore(output, task.tokens)
            if post_restore is not None:
                task.translation = post_restore(task.translation)
            task.done = True
            cached_output = output
        except Exception as restore_error:
            # 降级一：同一引擎单条重试（批量上下文丢失后，模型/接口常有不同表现）
            logger.warning("还原失败，单条重试（引擎 %s）：%s", engine.name, restore_error)
            retry_raw = ""
            try:
                retry_out = engine.translate_batch_with_retry([task.protected])
                retry_raw = retry_out[0] if retry_out else ""
                task.translation = guard.restore(retry_raw, task.tokens)
                if post_restore is not None:
                    task.translation = post_restore(task.translation)
                task.done = True
                cached_output = retry_raw
            except PlaceholderOrderError as order_error:
                # 降级二（v0.3.3）：重试仍乱序 → 采纳按编号回填的译文（占位符齐）。
                task.translation = (post_restore(order_error.fallback)
                                    if post_restore else order_error.fallback)
                task.done = True
                task.review_note = f"占位符乱序已按编号回填，建议人工复核：{order_error}"
                logger.warning("乱序重试仍失败，采纳回填译文转人工复核：%s", order_error)
                return    # 回填结果不含 token 流，无法写缓存（下次重翻再走降级链）
            except Exception as retry_error:
                # 降级三（v0.3.5-r2 新增）：重译后仍然无法建立任何锚点
                # ——模型把占位符整个吞掉/语义化改写（%s → "玩家"）。
                #
                # 旧行为：task.failed_reason = ... → 整条回退英文，汉化率受损。
                # 真机实测（Linggango 整合包）该分支是日志刷屏的主要来源。
                #
                # 新行为：对【重试译文】做强制回填——把占位符按启发式补回
                #（参数型 → 句末标点前；色码 → 句首），保证占位符零丢失，
                # 同时把该条计入人工复核清单。
                # 理由：占位符丢失会导致运行期 Java formatter 抛异常（崩溃级），
                # 位置欠佳只是观感问题（可人工修），两害相权取后者。
                # 重试译文为空（引擎完全失败）时不强填，保持失败语义。
                forced = (guard.force_fill(retry_raw, task.tokens)
                          if retry_raw else None)
                if forced is not None:
                    task.translation = (post_restore(forced)
                                        if post_restore else forced)
                    task.done = True
                    task.review_note = (
                        f"占位符被引擎吞掉，已强制回填（位置待人工确认）：{retry_error}"
                    )
                    logger.warning(
                        "重译仍失败，强制回填占位符并转人工复核（引擎 %s）：%s",
                        engine.name, retry_error,
                    )
                    return   # 强制回填结果不含 token 流，不写缓存
                task.failed_reason = f"占位符还原失败：{retry_error}"
                return
        # 还原成功才写缓存（引擎名参与缓存键 → 引擎间译文隔离）
        cache.put(make_key(task.protected, target_lang, engine.name, engine.model_tag()),
                  task.protected, cached_output,
                  target_lang, engine.name, engine.model_tag())

    # ------------------------------------------------------------------
    # 增量合并
    # ------------------------------------------------------------------
    @staticmethod
    def _load_existing_entries(pack_root: Path, ref: LangFileRef,
                               source_parsed, result: PipelineResult) -> dict[str, str]:
        """读出该源文件对应的既有目标语言译文（增量合并用）。

        返回 ``{语言键: 既有译文}``，只保留满足以下全部条件的键：
            * 源文件里确实有这个键（既有文件里的陈旧键一律丢弃，不写进产物）；
            * 源值非空（空源值本就跳过不翻）；
            * 既有译文非空（空译文等于"没翻"，需要走引擎补）。

        任何读取/解析失败都退化为"没有既有译文"（= 全量翻译该文件）并记告警 ——
        宁可多翻一遍，也不能因为一个坏文件把整轮任务打断。
        """
        data = exporters.read_existing_target(pack_root, ref)
        if data is None:
            return {}
        try:
            text, _meta = decode_bytes(data)
            parsed = get_parser(ref.fmt).parse(text)
        except Exception as exc:  # noqa: BLE001 - 坏文件退化为全量翻译
            result.warnings.append(
                f"{ref.path_in_pkg}：已有目标语言文件无法解析，该文件改为全量翻译"
                f"（{type(exc).__name__}: {exc}）")
            logger.warning("已有目标语言文件解析失败，改为全量翻译 %s：%s",
                           ref.path_in_pkg, exc)
            return {}
        kept: dict[str, str] = {}
        for key, entry in parsed.entries.items():
            source_entry = source_parsed.entries.get(key)
            if source_entry is None or not source_entry.value.strip():
                continue
            if entry.value.strip():
                kept[key] = entry.value
        return kept

    # ------------------------------------------------------------------
    # 导出
    # ------------------------------------------------------------------
    def _export(self, pack_root: Path, refs: list[LangFileRef],
                tasks_by_source: dict[str, _Task], guard: PlaceholderGuard,
                out_dir: Path, result: PipelineResult,
                report_progress: "Callable[[str, int, int], None] | None" = None,
                merge_map: dict[str, dict[str, str]] | None = None) -> None:
        """按映射表把译文写回原始目录结构（详见 exporters.disk_path_for_ref）。

        report_progress：导出阶段进度回调（v0.3.3），逐文件上报 ("export", i, n)。
        merge_map：增量合并模式下 path_in_pkg → 既有译文；这些条目直接写入
        产物、不覆盖、不参与机翻终验（改为"保留 + 转人工复核"）。
        """
        merge_map = merge_map or {}
        export_total = len(refs)
        # v0.3.8：阶段起点上报（导出阶段的 ETA 计时基准，同 collect/translate）
        if report_progress is not None:
            report_progress("export", 0, export_total)
        for exp_idx, ref in enumerate(refs):
            if report_progress is not None:
                report_progress("export", exp_idx + 1, export_total)
            if any(fs.path_in_pkg == ref.path_in_pkg and fs.status == "error"
                   for fs in result.files):
                continue    # 收集阶段已标记 error 的文件不再处理
            try:
                text, _meta = decode_bytes(exporters.read_ref_bytes(pack_root, ref))
                parser = get_parser(ref.fmt)
                parsed = parser.parse(text)

                kept = merge_map.get(ref.path_in_pkg, {})
                translations: dict[str, str] = {}
                stat = FileStat(
                    path_in_pkg=ref.path_in_pkg,
                    export_relative_path=ref.export_relative_path,
                    container=ref.container, fmt=ref.fmt.value,
                    entry_count=len(parsed.entries),
                )
                for key, entry in parsed.entries.items():
                    source = entry.value
                    if not source.strip():
                        continue
                    if key in kept:
                        # 增量合并：既有译文（社区/官方/上一轮人工）优先。
                        # 这里**不做**终验回退 —— 那是给机翻产物兜底的；
                        # 对人工成果只能"保留 + 提示复核"，不能悄悄换成英文。
                        translations[key] = kept[key]
                        stat.kept_existing += 1
                        ok, message = guard.verify(source, kept[key])
                        if not ok:
                            result.review_suggested.append({
                                "file": ref.path_in_pkg,
                                "key": key,
                                "source": source,
                                "reason": f"既有译文的占位符与原文不一致（已保留未覆盖）：{message}",
                            })
                        continue
                    task = tasks_by_source.get(source)
                    if task is not None and task.done:
                        translations[key] = task.translation
                        stat.translated += 1
                        if task.review_note:
                            # v0.3.3：乱序回填等"已产出但建议复核"的条目
                            result.review_suggested.append({
                                "file": ref.path_in_pkg,
                                "key": key,
                                "source": source,
                                "reason": task.review_note,
                            })
                    elif task is not None:
                        stat.failed += 1
                        result.failures.append({
                            "file": ref.path_in_pkg,
                            "key": key,
                            "source": source,
                            "reason": task.failed_reason or "未知原因",
                        })
                        logger.error("条目翻译失败（保留原文）[%s] %s：%s",
                                     ref.path_in_pkg, key, task.failed_reason)

                # 终验：导出前抽验占位符一致性（第二道防线）。
                # 迭代副本：终验失败会 pop 当前条目（v0.3.x 潜伏缺陷修复——
                # 直接迭代 .items() 时 pop 触发 RuntimeError 中断导出）
                # 增量合并沿用的既有译文跳过本步：它们的校验口径是
                # "保留 + 转人工复核"，不允许在这里被回退成英文原文。
                for key, new_value in list(translations.items()):
                    if key in kept:
                        continue
                    ok, message = guard.verify(parsed.entries[key].value, new_value)
                    if not ok:
                        logger.error("终验失败，条目回退为原文 [%s] %s：%s",
                                     ref.path_in_pkg, key, message)
                        translations.pop(key)
                        stat.translated -= 1
                        stat.failed += 1
                        result.failures.append({
                            "file": ref.path_in_pkg, "key": key,
                            "source": parsed.entries[key].value,
                            "reason": f"终验失败：{message}",
                        })

                # 无任何译文 → 跳过写出（避免产出与原文相同的冗余文件）
                if not translations:
                    stat.status = "failed" if stat.failed else "error"
                    if stat.failed == 0:
                        stat.error = "无条目被成功翻译"
                    result.files.append(stat)
                    continue

                out_text = parser.serialize(parsed, translations)
                dest = exporters.disk_path_for_ref(out_dir, ref)
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(out_text.encode("utf-8"))
                stat.status = "ok" if stat.failed == 0 else "partial"
                result.files.append(stat)
            except Exception as exc:  # 导出失败不中断其他文件
                logger.exception("导出失败 %s：%s", ref.path_in_pkg, exc)
                result.files.append(FileStat(
                    path_in_pkg=ref.path_in_pkg,
                    export_relative_path=ref.export_relative_path,
                    container=ref.container, fmt=ref.fmt.value,
                    entry_count=ref.entry_count, status="error",
                    error=f"导出失败：{type(exc).__name__}: {exc}",
                ))

        # 文件级统计（skipped_existing 是"主动跳过"不算错误，单独计数）
        for stat in result.files:
            if stat.status == "ok":
                result.files_ok += 1
            elif stat.status == "partial":
                result.files_partial += 1
            elif stat.status == "skipped_existing":
                continue    # 已在跳过阶段计入 files_skipped_existing，不进错误桶
            else:
                result.files_error += 1

    # ------------------------------------------------------------------
    # 报告与缓存
    # ------------------------------------------------------------------
    def _save_report(self, result: PipelineResult, pack_root: Path,
                     options: PipelineOptions) -> None:
        """report.json 落盘（统计 + 文件明细 + 失败清单）。"""
        report = {
            "tool": f"mc-i18n {__version__}",
            "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "pack_root": result.pack_root,
            "source_lang": result.source_lang,
            "target_lang": result.target_lang,
            "engine": {"primary": result.engine_primary,
                       "fallback": result.engine_fallback,
                       # v0.3.7：真正产出译文的引擎。与 primary 不同即说明发生了
                       # 降级（例如主引擎密钥失效 → 落到备用引擎），排障时先看它。
                       "used": result.engine_used},
            # v0.3.8：本次对"整合包已自带目标语言文件"采取的策略。
            # 排障时先看它 —— 报告里"译出 0 条"通常只是 skip/merge 生效，不是故障。
            "existing_target_policy": result.existing_policy,
            "stats": {
                "duration_sec": result.duration_sec,
                "files_total": result.files_total,
                "files_ok": result.files_ok,
                "files_partial": result.files_partial,
                "files_error": result.files_error,
                "files_skipped_existing": result.files_skipped_existing,
                "files_merged": result.files_merged,
                "entries_total": result.entries_total,
                "unique_sources": result.unique_sources,
                "entries_translated": result.entries_translated,
                "entries_from_cache": result.entries_from_cache,
                "entries_kept_existing": result.entries_kept_existing,
                "entries_failed": result.entries_failed,
                "entries_new": result.entries_new,
                "entries_passthrough": result.entries_passthrough,
                "api_calls": result.api_calls,
                "chars_sent": result.chars_sent,
            },
            "files": [vars(stat) for stat in result.files],
            "failures": result.failures,
            "review_suggested": result.review_suggested,
            "warnings": result.warnings,
        }
        report_path = pack_root / ".mc-i18n" / "report.json"
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        logger.info("任务报告已保存：%s（失败清单 %d 条）", report_path, len(result.failures))

    def _make_cache(self, pack_root: Path, options: PipelineOptions,
                    result: PipelineResult):
        """按配置构建缓存实例（禁用条件：no_cache 开关 / config.cache.enabled=false）。"""
        if options.no_cache or not self.app.cache.enabled:
            logger.info("缓存已禁用（本次任务不读写缓存）")
            return NullCache()
        path = Path(self.app.cache.path) if self.app.cache.path else \
            pack_root / ".mc-i18n" / "cache.sqlite3"
        return TranslationCache(path, ttl_days=self.app.cache.ttl_days)
