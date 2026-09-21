"""WebUI JSON API 实现 —— 21 个 /api/* 接口的业务处理（v0.3.0 框架拆分）。

每个 _api_* 函数遵循同一约定：

    输入：params/query dict（HTTP 层已解析好 JSON 请求体或查询串）；
    输出：可直接 JSON 序列化的 dict；
    失败：抛 ValueError / FileNotFoundError 等异常，由 http 层统一映射为
          400 / 404 错误响应 —— 业务层不直接接触 socket。

API 一览：
    POST /api/upload                  拖拽上传 .zip/.mrpack/.jar/mods 文件夹
    POST /api/scan                    扫描整合包（v0.3.3 起后台线程，结果走 job.summary）
    POST /api/translate               启动后台翻译任务（线程）
    POST /api/cancel                  请求停止当前任务（已翻部分照常导出）
    POST /api/quests/scan             扫描任务书 .snbt 文件
    POST /api/quests/translate        启动后台任务书翻译（线程）
    GET  /api/report?pack=            读取 report.json
    GET  /api/review/files?pack=      校对台：译文文件清单
    GET  /api/review/entries          校对台：单文件条目对照
    POST /api/review/save             校对台：保存单条译文（无损写回）
    GET  /api/glossary?pack=          读取术语表
    POST /api/glossary/save           保存术语表
    POST /api/glossary/import_defaults 导入内置术语（已有键不覆盖）
    GET  /api/settings?pack=          读取 WebUI 设置
    POST /api/settings/save           保存设置（写 .mc-i18n/config.yaml）
    GET  /api/browse?path=            服务端目录浏览器
    GET  /api/presets                 AI 服务商预设表
    POST /api/test-engine             「测试连接」：实译一句话验证可用性
    POST /api/pack                    打包汉化资源包（同步）
    GET  /api/status                  任务状态（前端 1s 轮询）
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import time
import uuid
import zipfile
from pathlib import Path

from .. import __version__
from .._mini_yaml import dumps_yaml_mapping
from ..config import load_config, load_yaml_dict
from ..core.cache import NullCache
from ..core.engines import create_engine, test_engine_connection
from ..core.engines.presets import preset_dict as _ai_presets
from ..core.exporters import build_resource_pack_to
from ..core.glossary import Glossary
from ..core.glossary_presets import DEFAULT_TERMS
from ..core.pack_loader import UploadError, cleanup_pack, load_dropped_files
from ..core.parsers import get_parser
from ..core.pipeline import PipelineOptions, TranslationPipeline
from ..core.placeholders import PlaceholderGuard
from ..core.quests import translate_snbt
from ..core.scanner import ScanOptions, scan
from ..core import snapshot
from ..utils import decode_bytes
from . import state
from .helpers import (
    _detect_fmt,
    _find_snbt,
    _glossary_path,
    _read_text_file,
    _resolve_pack_output,
    _review_index,
    _safe_pack,
    _webui_config_path,
)


# -------------------------------------------------------------------------- #
# 拖拽上传（v0.2.7）：把浏览器拖进来的文件整理成可扫描的整合包目录
# -------------------------------------------------------------------------- #
def _api_upload(params: dict, file_streams: list[tuple[str, bytes]]) -> dict:
    """接收浏览器拖拽上传的 multipart 文件流，整理成可扫描的整合包目录。

    params 目前只携带前端额外字段（为空）；file_streams 是 [(文件名, 内容), ...]。
    返回 {"pack": 临时目录路径, "kind": 包类型, "count": 文件数, "name": 主包名}
    """
    if not file_streams:
        raise UploadError("没有收到文件")

    tmp_dir = Path(tempfile.mkdtemp(prefix="mc_i18n_upload_"))
    disk_files: list[Path] = []
    try:
        for filename, data in file_streams:
            if len(data) == 0:
                continue
            safe = "".join(
                c if (c.isalnum() or c in "._-()[] ") else "_" for c in filename
            )
            target = tmp_dir / safe
            target.write_bytes(data)
            disk_files.append(target)

        pack = load_dropped_files(disk_files)
        up_id = uuid.uuid4().hex[:8]
        state._UPLOAD_CACHE[up_id] = pack
        # 根据路径推断主包名
        main_name = disk_files[0].name if disk_files else "unknown"
        return {
            "pack": str(pack.root),
            "kind": pack.kind,
            "count": len(file_streams),
            "name": main_name,
        }
    except Exception:
        # 解析失败时清理本次临时文件
        try:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass
        raise


def _api_scan(params: dict) -> dict:
    """扫描整合包（v0.3.3 起异步化：立即返回，进度经 /api/status 轮询）。

    大整合包（数千文件 + 数百 jar）扫描可长达数十秒，旧版同步实现期间
    前端无任何反馈、无法区分"工作中"与"卡死"。现复用任务槽后台执行：
    前端 POST /api/scan 立即拿到 {started, job}，随后按既有 1s 轮询从
    job.message / job.progress 观察进度，job.status=done 后从 job.summary
    读取与旧版响应结构完全一致的扫描结果。
    """
    pack = _safe_pack(params)

    def job_fn(job: state._Job) -> dict:
        # 扫描器逐文件进度 → 0-90 区间；jar 清点等收尾阶段占 90-95
        def _scan_progress(done: int, total: int) -> None:
            pct = (done / total) if total > 0 else 0.0
            job.progress = 90.0 * pct
            job.message = (f"扫描中… {done}/{total}"
                           if total > 0 else "扫描中…")

        report = scan(pack, ScanOptions(
            source_lang=str(params.get("source_lang", "en_us")),
            target_lang=str(params.get("target_lang", "zh_cn")),
            include_jars=bool(params.get("include_jars", True)),
            progress_cb=_scan_progress,
        ))
        # ScanReport 是 dataclass —— 转成 JSON 友好的 dict（只保留前端需要的字段）
        files = [{
            "path_in_pkg": f.path_in_pkg,
            "container": f.container or "",
            "fmt": f.fmt.value if hasattr(f.fmt, "value") else str(f.fmt),
            "export_relative_path": f.export_relative_path,
            "entry_count": f.entry_count,
            "mod_id": f.mod_id or "unknown",
        } for f in report.files]
        st = report.stats
        job.progress = 93
        job.message = "清点任务书…"
        quest_files = _find_snbt(pack) if params.get("include_quests") else []
        return {
            "files": files,
            "stats": {
                "language_files": st.language_files,
                "source_candidates": st.source_candidates,
                "jars_scanned": st.jars_scanned,
                "json_skipped": st.json_skipped,
                "parse_errors": st.parse_errors,
                "total_entries": st.total_entries,
                "by_fmt": st.by_fmt,
                "by_mod": st.by_mod,
            },
            "quest_count": len(quest_files),
            "quest_entries": sum(q["count"] for q in quest_files),
            "warnings": report.warnings,
        }

    ok, msg, job = state._STATE.start("scan", f"扫描 {pack.name}", job_fn)
    return {"started": ok, "message": msg, "job": job}


def _resolve_engine_name(params: dict, app) -> str:
    """决定本次任务使用的引擎名（v0.3.7 单一真相源）。

    优先级：显式请求参数 → config.yaml 的 engine.primary → 硬编码兜底 "demo"。

    v0.3.7 之前这里写的是 ``params.get("engine") or "demo"``：只要前端没
    带上 engine 字段（老版本页面、直接调 API、脚本化调用），就会静默落到
    **演示引擎**——而演示引擎的输出是「前缀 + 原文」，等于完全没翻译，
    用户却会看到一个"成功"的产物。真机事故（Linggango 整合包，70.4% 条目
    带「【机翻·演示】」前缀）正是这个兜底值造成的。

    现在把 config.yaml 的 ``engine.primary`` 提到兜底位，让"设置页选了什么
    就跑什么"成立；仅当配置文件也缺失时才回落 demo（开发/试跑场景）。
    """
    explicit = str(params.get("engine") or "").strip()
    if explicit:
        return explicit
    from_config = str(getattr(app.engine, "primary", "") or "").strip()
    return from_config or "demo"


#: 界面上「已有中文处理」三态控件的合法取值（与 PipelineOptions 的两开关一一对应）
EXISTING_POLICIES = ("skip", "merge", "overwrite")


def _resolve_existing_policy(params: dict) -> tuple[bool, bool]:
    """把前端的「已有中文处理」选择解析成 ``(skip_existing, merge_existing)``。

    v0.3.8 起工作台用三态下拉框（skip / merge / overwrite）替代原来的单选框：

    ==================  =================  ====================
    界面取值             skip_existing      merge_existing
    ==================  =================  ====================
    ``skip``（默认）     True               False
    ``merge``            False              True
    ``overwrite``        False              False
    ==================  =================  ====================

    为了不打断老页面 / 脚本化调用，仍然接受只有 ``skip_existing`` 布尔值的
    旧请求格式；取值非法时一律回落到最安全的 ``skip``（保护社区中译）。
    """
    policy = str(params.get("existing_policy") or "").strip().lower()
    if policy not in EXISTING_POLICIES:
        # 兼容层：旧前端只传 skip_existing 布尔值
        return (bool(params.get("skip_existing", True)), False)
    return (policy == "skip", policy == "merge")


# -------------------------------------------------------------------------- #
# v0.3.8 实时译文流 / 预计用时：事件 → 前端载荷 的整理
# -------------------------------------------------------------------------- #
_ENTRY_SRC_LIMIT = 180      # 原文在译文流里的展示上限（超出加省略号）
_ENTRY_DST_LIMIT = 180      # 译文同上
_ENTRY_NOTE_LIMIT = 140     # 复核/失败原因同上

# 翻译之后只剩导出：用"已耗时的百分之几"给收尾预留一点时间，
# 让"预计总用时"不要在翻译跑满时给出过于乐观的数字（导出要写盘 + 可能打包）。
_EXPORT_TAIL_RATIO = 0.06
_EXPORT_TAIL_MIN_SEC = 2.0


def _one_line(text, limit: int) -> str:
    """压成单行并截断（译文流每行只占一行位置）。"""
    if not text:
        return ""
    s = str(text).replace("\r\n", "\n").replace("\r", "\n")
    s = s.replace("\n", "⏎")          # 真实换行替换成可见符号，防止撑破行高
    return s if len(s) <= limit else s[:limit] + "…"


def _clip_entry(ev: dict) -> dict:
    """把流水线发来的 entry 事件整理成前端译文流的行结构。"""
    return {
        "ok": bool(ev.get("ok", True)),
        "src": _one_line(ev.get("source"), _ENTRY_SRC_LIMIT),
        "dst": _one_line(ev.get("translation"), _ENTRY_DST_LIMIT),
        "review": _one_line(ev.get("review"), _ENTRY_NOTE_LIMIT),
        "failed": _one_line(ev.get("failed"), _ENTRY_NOTE_LIMIT),
        "cached": bool(ev.get("cached")),
    }


def _overall_eta(job: "state._Job", stage: str, eta_stage: float | None) -> float | None:
    """按当前阶段剩余时间推算"全任务预计剩余"。

    - ``export`` 已是最后一个阶段 → 阶段剩余即全任务剩余；
    - ``translate`` 之后还有导出 → 在阶段剩余上预留一点收尾时间；
    - ``scan`` / ``collect`` 时后续阶段的工作量根本还未知（要等去重结果才知道
      有多少条要翻），此时**如实返回 None** —— 与其编一个数，不如让界面显示
      "估算中"，等进入翻译阶段再给出可信的预计。
    """
    if eta_stage is None:
        return None
    if stage == "export":
        return eta_stage
    if stage == "translate":
        elapsed_total = max(time.time() - job.started, 0.0)
        tail = max(_EXPORT_TAIL_MIN_SEC, elapsed_total * _EXPORT_TAIL_RATIO)
        return eta_stage + tail
    return None


def _api_translate(params: dict) -> dict:
    pack = _safe_pack(params)
    use_glossary = bool(params.get("use_glossary", True))
    # 术语表 = 用户 glossary.yaml + 内置 MC 标准术语（用户键优先覆盖）；
    # 用户取消勾选"应用术语表"时两者都不启用（尊重用户选择）
    glossary = Glossary.load(_glossary_path(pack)).with_defaults() if use_glossary else None

    cfg_path = _webui_config_path(pack)
    app = load_config(cfg_path if cfg_path.is_file() else None, pack).config
    engine_name = _resolve_engine_name(params, app)

    def job_fn(job: state._Job) -> dict:
        job.progress = 3
        job.message = "准备任务…"

        # ---- v0.3.3 真实进度条：把流水线阶段回调映射到 0-100 进度区间 ----
        # 区间分配：扫描 5~20 | 收集 20~25 | 翻译 25~85 | 导出 85~95 |
        #           （打包 95~97 由下方 job.progress 直接设置）
        # 翻译阶段按"去重后的唯一原文"计数——跨文件相同原文只翻一次，
        # 因此条数与扫描统计的"可翻译条目"不等（去重后通常更少）。
        def _progress(stage: str, done: int, total: int) -> None:
            pct = (done / total) if total > 0 else 0.0
            if stage == "scan":
                job.progress = 5 + 15.0 * pct
                job.message = (f"扫描整合包… {done}/{total}"
                               if total > 0 else "扫描整合包…")
            elif stage == "collect":
                job.progress = 20 + 5.0 * pct
                job.message = (f"收集整理条目… {done}/{total}"
                               if total > 0 else "收集整理条目…")
            elif stage == "translate":
                job.progress = 25 + 60.0 * pct
                job.message = (f"翻译中… {done}/{total} 条"
                               if total > 0 else "翻译中…")
            elif stage == "export":
                job.progress = 85 + 10.0 * pct
                job.message = (f"导出译文… {done}/{total} 个文件"
                               if total > 0 else "导出译文…")

        # ---- v0.3.8 结构化事件：实时译文流 + 速率/预计用时 ----
        # 事件与 _progress 走同一套阶段语义，但承载了 (stage,done,total) 装不下的
        # 信息：逐条译文（entry）与该阶段的实测速率（progress 事件的 rate/eta_sec）。
        # 阶段计时器在这里各自维护——流水线在每阶段起点补发一条 (0, total)，
        # 因此 elapsed 从"阶段真正开始"起算，不会因为第一批完成时才收到回调而失真。
        stage_t0 = {"name": "", "ts": time.time()}

        def _event(ev: dict) -> None:
            etype = ev.get("type")
            if etype == "entry":
                job.push_entry(_clip_entry(ev))
                return
            if etype != "progress":
                return
            stage = str(ev.get("stage") or "")
            done = int(ev.get("done") or 0)
            total = int(ev.get("total") or 0)
            if stage != stage_t0["name"]:      # 阶段切换 → 计时器归零
                stage_t0["name"] = stage
                stage_t0["ts"] = time.time()
            job.stage = stage
            job.done_units, job.total_units = done, total
            rate = ev.get("rate")
            if rate is None and done > 0 and total > 0:
                elapsed = max(time.time() - stage_t0["ts"], 1e-6)
                rate = done / elapsed
            eta = ev.get("eta_sec")
            if eta is None and rate and total > 0:
                eta = (total - done) / rate
            job.rate = rate
            job.eta_sec = eta
            job.eta_total_sec = _overall_eta(job, stage, eta)

        # 主引擎不是 demo 时自动挂 demo 兜底：免费接口在部分网络环境不可达、
        # 或密钥失效时，用户至少能拿到一份完整产物 + 明确的降级说明
        fallback = ["demo"] if engine_name != "demo" else []
        # v0.3.8：把界面的三态控件（skip/merge/overwrite）解析为两个布尔开关
        # （兼容旧前端只传 skip_existing 的历史调用，见 _resolve_existing_policy）
        skip_existing, merge_existing = _resolve_existing_policy(params)
        options = PipelineOptions(
            source_lang=str(params.get("source_lang", "en_us")),
            target_lang=str(params.get("target_lang", "zh_cn")),
            include_jars=bool(params.get("include_jars", True)),
            engine_primary=engine_name,
            engine_fallback=fallback,
            skip_existing_translations=skip_existing,
            merge_existing=merge_existing,
            workers=int(params.get("workers") or 0) or None,

            glossary=glossary,
            # "停止"按钮探针：批次间隙轮询，触发后撤销剩余批次
            cancel_check=lambda: state._STATE.cancel_requested,
            # v0.3.3：真实进度回调（替代旧版"焊死 30%"的两段式假进度）
            progress_cb=_progress,
            # v0.3.8：逐条译文流 + 速率/预计用时（不替代上面的进度回调）
            event_cb=_event,
        )
        result = TranslationPipeline(app).run(pack, options)
        if result.cancelled:
            job.message = "已手动停止（已翻部分已导出，重跑自动续翻）"
        job.progress = 95          # 导出回调区间 85~95 已走完 → 打包区间起点
        zip_path = None
        if params.get("pack_zip"):
            job.message = "打包资源包…"
            pack_out = _resolve_pack_output(pack, {
                "pack_out": params.get("pack_out"),
                "target_lang": options.target_lang,
            })
            zip_path, _count = build_resource_pack_to(
                pack / ".mc-i18n" / "translated",
                pack_out,
                pack_format=params.get("pack_format"),
                mc_version=params.get("mc_version") or None,
            )
        job.progress = 97
        state._index_cache.clear()       # 新译文落地 → 校对台索引立即失效
        # v0.3.8：待人工处理条目数 —— 前端据此在完成后自动跳转校对台。
        # 两类都要带上：failures（保留原文，必须补翻）与 review_suggested
        # （译文已导出但质量待确认）。只要非零就值得把人送到校对台。
        pending_review = len(result.review_suggested)
        failed_entries = len(result.failures)
        return {
            "files_total": result.files_total, "files_ok": result.files_ok,
            "files_partial": result.files_partial, "files_error": result.files_error,
            "files_skipped_existing": result.files_skipped_existing,
            "entries_translated": result.entries_translated,
            "entries_from_cache": result.entries_from_cache,
            "entries_failed": result.entries_failed,
            "entries_new": result.entries_new,
            # v0.3.8：自动跳转校对台的判据（见 web_page.js 的 renderJob）
            "pending_review": pending_review,
            "failed_entries": failed_entries,
            "needs_review": (pending_review + failed_entries) > 0,
            "api_calls": result.api_calls, "chars_sent": result.chars_sent,
            "duration_sec": round(result.duration_sec, 1),
            "cancelled": result.cancelled,
            "zip": str(zip_path) if zip_path else None,
        }

    ok, msg, job = state._STATE.start(
        "translate", f"翻译 {pack.name}（{engine_name}）", job_fn)
    return {"started": ok, "message": msg, "job": job}


def _api_cancel(params: dict) -> dict:
    """请求停止当前任务（停止 ≠ 丢弃：已翻部分照常导出，缓存支持续翻）。"""
    ok, msg = state._STATE.request_cancel()
    if not ok:
        raise ValueError(msg)
    return {"message": msg}


def _api_quests_scan(params: dict) -> dict:
    pack = _safe_pack(params)
    files = _find_snbt(pack)
    return {"files": files, "total_entries": sum(f["count"] for f in files)}


def _api_quests_translate(params: dict) -> dict:
    pack = _safe_pack(params)
    cfg_path = _webui_config_path(pack)
    app = load_config(cfg_path if cfg_path.is_file() else None, pack).config
    engine_name = _resolve_engine_name(params, app)
    # 任务书翻译同样合并内置 MC 标准术语（用户键优先覆盖）
    glossary = Glossary.load(_glossary_path(pack)).with_defaults()
    files = [f["path"] for f in _find_snbt(pack)]
    if not files:
        raise ValueError("未找到任何 .snbt 任务书文件（config/ftbquests/quests/chapters/）")

    def job_fn(job: state._Job) -> dict:
        job.progress = 5
        engine = create_engine(engine_name, app)
        src = str(params.get("source_lang") or "en").split("_")[0]
        dst = str(params.get("target_lang") or "zh").split("_")[0]
        engine.configure_languages(src, dst)
        # LLM 引擎：术语注入 prompt 指令（防吞 ⟦N⟧ 标记），不再 token 保护
        if glossary and getattr(engine, "prefers_glossary_instructions", False):
            engine.set_glossary(glossary)
        quest_glossary_instructions = bool(
            glossary and getattr(engine, "prefers_glossary_instructions", False))
        guard = PlaceholderGuard()
        total_ok = total_failed = 0
        for idx, rel in enumerate(files):
            path = pack / rel
            text, enc, had_bom = _read_text_file(path)

            def batch(texts: list[str]) -> list[str]:
                return engine.translate_batch_with_retry(texts)

            new_text, ok, failed = translate_snbt(
                text, batch, guard, glossary,
                glossary_as_instructions=quest_glossary_instructions)
            if ok and new_text != text:
                backup = path.with_suffix(path.suffix + ".bak")
                if not backup.exists():          # 首次修改前备份原始文件
                    backup.write_bytes(path.read_bytes())
                data = new_text.encode(enc)
                if had_bom:
                    data = b"\xef\xbb\xbf" + data
                path.write_bytes(data)
            total_ok += ok
            total_failed += failed
            job.progress = 5 + 90.0 * (idx + 1) / len(files)
            job.message = f"任务书 {idx + 1}/{len(files)}：{path.name}"
        if hasattr(engine, "close"):
            engine.close()
        return {"files": len(files), "translated": total_ok, "failed": total_failed}

    ok, msg, job = state._STATE.start("quests", f"任务书翻译 {pack.name}（{engine_name}）", job_fn)
    return {"started": ok, "message": msg, "job": job}


def _api_report(query: dict) -> dict:
    pack = _safe_pack(query)
    path = pack / ".mc-i18n" / "report.json"
    if not path.is_file():
        return {"report": None}
    return {"report": json.loads(path.read_text(encoding="utf-8"))}


def _report_pending(pack: Path) -> dict:
    """从 report.json 汇总"待人工处理"明细（v0.3.8）。

    返回 ``{"by_file": {path_in_pkg: {key: {"failed":..,"review":..}}},
    "counts": {path_in_pkg: 条数}, "total": 总条数}``。

    报告里的 ``file`` 字段用的是 ``LangFileRef.path_in_pkg``（jar 内条目形如
    ``mods/x.jar!assets/.../en_us.json``），与校对台索引里的同名字段口径一致，
    因此可以用它把"待校对"标记准确地贴到校对台的每个文件/每条条目上。
    任何异常都退化为"无待处理项"——校对台主体功能不该被一个坏报告拖垮。
    """
    out: dict = {"by_file": {}, "counts": {}, "total": 0}
    path = pack / ".mc-i18n" / "report.json"
    if not path.is_file():
        return out
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - 报告损坏不影响校对台可用
        return out
    if not isinstance(report, dict):
        return out
    by_file: dict[str, dict] = out["by_file"]
    for field, tag in (("failures", "failed"), ("review_suggested", "review")):
        for item in report.get(field) or []:
            if not isinstance(item, dict):
                continue
            file_pip = str(item.get("file") or "")
            key = str(item.get("key") or "")
            if not file_pip or not key:
                continue
            slot = by_file.setdefault(file_pip, {}).setdefault(key, {})
            slot.setdefault(tag, str(item.get("reason") or ""))
    out["counts"] = {f: len(keys) for f, keys in by_file.items()}
    out["total"] = sum(out["counts"].values())
    return out


def _api_review_files(query: dict) -> dict:
    pack = _safe_pack(query)
    translated_root = pack / ".mc-i18n" / "translated"
    files: list[dict] = []
    if translated_root.is_dir():
        for p in sorted(translated_root.rglob("*")):
            if p.is_file() and p.suffix.lower() in (".json", ".lang"):
                files.append({"rel": str(p.relative_to(translated_root)),
                              "size": p.stat().st_size})
    # 源文件映射（rel -> 源引用）；无对照的文件前端只展示译文
    index = _review_index(pack, str(query.get("source_lang", "en_us")),
                          str(query.get("target_lang", "zh_cn")))
    # v0.3.8：把上次报告里的"待人工处理"条数贴到文件上，
    # 前端据此在翻译完成后自动选中"有问题的那个文件"（而不是列表第一个）。
    pending = _report_pending(pack)
    if pending["total"]:
        for item in files:
            ref = index.get(item["rel"]) or {}
            item["pending"] = pending["counts"].get(ref.get("path_in_pkg", ""), 0)
    return {"files": files, "source_map": index,
            "pending_total": pending["total"]}


def _api_review_entries(query: dict) -> dict:
    pack = _safe_pack(query)
    rel = str(query.get("rel", ""))
    if not rel or ".." in rel.replace("\\", "/").split("/"):
        raise ValueError("非法文件路径")
    translated_path = pack / ".mc-i18n" / "translated" / rel
    if not translated_path.is_file():
        raise FileNotFoundError(f"译文文件不存在：{rel}")

    fmt = _detect_fmt(translated_path)
    parser = get_parser(fmt)
    t_text, _enc, _bom = _read_text_file(translated_path)
    t_file = parser.parse(t_text)

    # 源文件：校对台索引（实时扫描重建）→ jar 内/散装均支持
    index = _review_index(pack, str(query.get("source_lang", "en_us")),
                          str(query.get("target_lang", "zh_cn")))
    ref_dict = index.get(rel)
    source_entries: dict[str, str] = {}
    if ref_dict:
        try:
            if ref_dict.get("container"):
                jar_path = pack / ref_dict["container"]
                with zipfile.ZipFile(jar_path) as zf:
                    inner = ref_dict["path_in_pkg"].split("!", 1)[1].lstrip("/")
                    src_text, _meta = decode_bytes(zf.read(inner))
            else:
                source_path = pack / ref_dict["path_in_pkg"]
                src_text, _e, _b = (_read_text_file(source_path)
                                    if source_path.is_file() else ("", "", False))
            if src_text:
                s_parser = get_parser(ref_dict.get("fmt") or fmt)
                source_entries = {k: e.value for k, e in
                                  s_parser.parse(src_text).entries.items()}
        except Exception:  # noqa: BLE001 - 源文件读不到时只展示译文
            pass

    prev_fp = snapshot.load_snapshot(pack)
    # v0.3.8：把上次报告里"待人工处理"的原因贴到对应条目上
    # （failed = 保留原文待补翻；review = 译文已导出但建议复核）
    ref_pip = (ref_dict or {}).get("path_in_pkg", "")
    flags = ((_report_pending(pack)["by_file"].get(ref_pip) or {})
             if ref_pip else {})
    entries = []
    for key, entry in t_file.entries.items():
        translated = entry.value
        src = source_entries.get(key, "")
        flag = flags.get(key) or {}
        entries.append({
            "key": key,
            "source": src,
            "translated": translated,
            "not_in_source": not src,
            "failed": bool(flag.get("failed")),
            "fail_reason": flag.get("failed", ""),
            "need_review": bool(flag.get("review")),
            "review_reason": flag.get("review", ""),
        })
    # 新增判定：该条原文不在上次快照中 → 上次翻译后 mod 又新增的文案
    for e in entries:
        src_fp = snapshot.fingerprint(e["source"]) if e["source"] else None
        e["is_new"] = bool(prev_fp) and src_fp is not None and src_fp not in prev_fp

    return {"rel": rel, "fmt": fmt, "entries": entries,
            "pending": sum(1 for e in entries
                           if e["failed"] or e["need_review"])}


def _api_review_save(params: dict) -> dict:
    pack = _safe_pack(params)
    rel = str(params.get("rel", ""))
    if not rel or ".." in rel.replace("\\", "/").split("/"):
        raise ValueError("非法文件路径")
    key = str(params.get("key", ""))
    value = str(params.get("value", ""))
    translated_path = pack / ".mc-i18n" / "translated" / rel
    if not translated_path.is_file():
        raise FileNotFoundError(f"译文文件不存在：{rel}")

    text, enc, had_bom = _read_text_file(translated_path)
    parser = get_parser(_detect_fmt(translated_path))
    lang_file = parser.parse(text)
    if key not in lang_file.entries:
        raise KeyError(f"文件中不存在条目：{key}")
    data = parser.serialize(lang_file, {key: value})
    out = data.encode(enc)
    if had_bom:
        out = b"\xef\xbb\xbf" + out
    translated_path.write_bytes(out)
    return {"saved": True, "key": key}


def _api_glossary(query: dict) -> dict:
    pack = _safe_pack(query)
    return {
        "terms": Glossary.load(_glossary_path(pack)).terms,
        "defaults": DEFAULT_TERMS,           # 「查看内置术语」弹层数据源
        "defaults_count": len(DEFAULT_TERMS),
    }


def _api_glossary_import_defaults(params: dict) -> dict:
    """把内置术语导入用户的 glossary.yaml（已有键不覆盖，保留用户改过的译法）。

    导入后即转为可编辑条目——用户可在此之上微调再保存，
    适合想以内置表为起点做个性化的用户；只想"用默认"的用户无需导入。
    """
    pack = _safe_pack(params)
    current = Glossary.load(_glossary_path(pack)).terms
    merged = dict(DEFAULT_TERMS)
    merged.update(current)                      # 用户已有键原样保留（含改过的译法）
    added = len(merged) - len(current)
    Glossary(terms=merged).save(_glossary_path(pack))
    return {"saved": True, "count": len(merged), "added": max(added, 0)}


def _api_glossary_save(params: dict) -> dict:
    pack = _safe_pack(params)
    raw = params.get("terms")
    if not isinstance(raw, dict):
        raise ValueError("terms 必须是 {原文: 译法} 对象")
    terms = {str(k).strip(): str(v).strip()
             for k, v in raw.items() if str(k).strip() and str(v).strip()}
    Glossary(terms=terms).save(_glossary_path(pack))
    return {"saved": True, "count": len(terms)}


def _api_settings(query: dict) -> dict:
    pack = _safe_pack(query)
    cfg_path = _webui_config_path(pack)
    if cfg_path.is_file():
        try:
            data = load_yaml_dict(cfg_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            data = {}
    else:
        data = {}
    data = data if isinstance(data, dict) else {}
    return {"settings": data, "path": str(cfg_path)}


def _api_settings_save(params: dict) -> dict:
    pack = _safe_pack(params)
    settings = params.get("settings")
    if not isinstance(settings, dict):
        raise ValueError("settings 必须是对象")
    # 白名单字段，防止写入任意结构
    allowed_top = {"engine", "baidu", "deepl", "openai", "google",
                   "youdao", "workers", "output"}
    clean: dict = {}
    if "engine" in settings and isinstance(settings["engine"], dict):
        clean["engine"] = {"primary": str(settings["engine"].get("primary", "demo"))}
    for sec in ("baidu", "deepl", "openai", "google", "youdao"):
        if sec in settings and isinstance(settings[sec], dict):
            clean[sec] = {k: str(v) for k, v in settings[sec].items()
                          if isinstance(v, (str, int))}
    if "workers" in settings:
        try:
            clean["workers"] = max(1, int(settings["workers"]))
        except (TypeError, ValueError):
            pass
    # 汉化包产出位置（v0.2.8）：output.pack_out 为空字符串表示"默认资源包文件夹"
    if "output" in settings and isinstance(settings["output"], dict):
        raw = settings["output"].get("pack_out")
        if isinstance(raw, str):
            clean["output"] = {"pack_out": raw.strip()}
    path = _webui_config_path(pack)
    path.parent.mkdir(parents=True, exist_ok=True)
    header = ("# 由 mc-i18n 图形界面生成 —— 供 GUI 翻译任务使用；\n"
              "# 环境变量（BAIDU_APP_ID 等）优先级高于本文件\n")
    path.write_text(header + dumps_yaml_mapping(clean), encoding="utf-8")
    return {"saved": True, "path": str(path)}


def _api_pack(params: dict) -> dict:
    pack = _safe_pack(params)
    translated = pack / ".mc-i18n" / "translated"
    if not translated.is_dir():
        raise FileNotFoundError("未找到译文导出目录（请先完成一次翻译）")
    pack_out = _resolve_pack_output(pack, {
        "pack_out": params.get("pack_out"),
        "target_lang": params.get("target_lang", "zh_cn"),
    })
    zip_path, count = build_resource_pack_to(
        translated, pack_out,
        pack_format=params.get("pack_format"),
        mc_version=params.get("mc_version") or None,
    )
    return {"zip": str(zip_path), "files": count}


def _api_test_engine(params: dict) -> dict:
    """「测试连接」：用表单当前值（可不保存）实际翻译一句话验证可用性。"""
    name = str(params.get("engine") or "").strip().lower()
    if not name:
        raise ValueError("缺少 engine 参数")
    override = params.get("settings")
    ok, msg = test_engine_connection(name, override if isinstance(override, dict) else None)
    return {"ok": ok, "message": msg}


def _api_presets(_query: dict) -> dict:
    """AI 服务商预设表（前端一键填充 base_url 与模型名）。"""
    return {"presets": _ai_presets()}


def _api_status(query: dict) -> dict:
    """任务状态（前端 1s 轮询）。

    ``since``（v0.3.8，可选）：译文流游标。前端把上次收到的最大 seq 传回来，
    只取新增条目 —— 轮询载荷与实际产出成正比，不再反复传整个尾部窗口。
    不传（或传 0）时返回尾部样本，兼容既有调用方。
    """
    try:
        since = max(0, int(str(query.get("since") or 0)))
    except (TypeError, ValueError):
        since = 0
    return {"job": state._STATE.snapshot(since=since), "version": __version__}


def _api_browse(query: dict) -> dict:
    """服务端目录浏览器：浏览器出于安全限制拿不到本机路径，由后端代列。"""
    raw = str(query.get("path", "")).strip().strip('"').strip("'")
    if not raw:
        if os.name == "nt":                     # Windows：列出存在的盘符
            roots = [f"{c}:\\" for c in "CDEFGHIJKLMNOPQRSTUVWXYZ"
                     if Path(f"{c}:\\").exists()]
            return {"roots": roots, "path": "", "dirs": [], "parent": None}
        raw = "/"
    p = Path(raw)
    if not p.is_dir():
        raise FileNotFoundError(f"目录不存在：{raw}")
    dirs = []
    try:
        for child in sorted(p.iterdir(), key=lambda c: c.name.lower()):
            if not child.is_dir() or child.name.startswith("."):
                continue
            hint = ""
            try:
                if (child / "mods").is_dir() and (child / "options.txt").is_file():
                    hint = "Minecraft 实例"
                elif child.name == "mods":
                    hint = "mods 目录"
            except OSError:
                pass
            dirs.append({"name": child.name, "hint": hint})
    except PermissionError:
        pass
    parent = str(p.parent) if p.parent != p else None
    return {"path": str(p), "dirs": dirs, "parent": parent, "roots": []}
