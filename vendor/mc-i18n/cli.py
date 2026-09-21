"""命令行界面（对应 PRD F09 完整命令集）。

零第三方依赖：基于标准库 argparse 实现（M3 里程碑可选迁移 typer + rich）。

子命令总览：
    scan       递归扫描整合包，输出语言文件清单与路径映射表（manifest.json）
    translate  完整翻译闭环：扫描 → 解析 → 批量翻译 → 占位符还原 → 导出（→ 打包）
    inspect    查看单个语言文件的解析结果，并做占位符完整性分析
    pack       把 translate 的导出目录一键打包为汉化资源包
    roundtrip  校验单个文件的"解析 → 序列化"无损往返（验收指标 A2 工具）
    check      语言文件质量巡检：重复键 / 占位符丢失 / 漏翻 / 编码隐患（只读，不调用 API）
    gui / menu 图形界面 / 控制台菜单

日志体系（translate 启用）：
    控制台 INFO（--verbose 时 DEBUG）+ 文件 DEBUG（<整合包>/.mc-i18n/logs/）；
    全链路错误捕获：单文件/单批/单条失败均不中断任务，失败清单进 report.json。

用法示例：
    python -m mc_i18n scan samples/demo_modpack
    python -m mc_i18n translate samples/demo_modpack                # demo 引擎，零密钥
    python -m mc_i18n translate samples/demo_modpack --engine baidu --pack
    python -m mc_i18n inspect overrides/kubejs/assets/kubejs/lang/en_us.json
    python -m mc_i18n pack .mc-i18n/translated -o my_zh_cn.zip
    python -m mc_i18n check samples/demo_modpack                    # 质量巡检（CI 卡点）
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime
from pathlib import Path

from . import __version__
from .config import load_config
from .core import quality
from .core.exporters import (build_resource_pack_to,
                             guess_pack_format, resolve_pack_output)
from .core.pipeline import PipelineOptions, TranslationPipeline
from .core.manifest import build_manifest, save_manifest
from .core.scanner import ScanOptions, scan
from .core.placeholders import PlaceholderGuard
from .core.parsers import get_parser_for_filename
from .utils import decode_bytes, ensure_console_encoding

# --------------------------------------------------------------------------
# 日志配置
# --------------------------------------------------------------------------

def _setup_logging(pack_root: Path, console_level: str = "INFO") -> Path:
    """配置 mc_i18n 日志：控制台 + 文件双通道，返回日志文件路径。

    文件通道永远 DEBUG（保留排查细节），控制台按参数级别输出。
    """
    log_dir = pack_root / ".mc-i18n" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"mc-i18n_{datetime.now():%Y%m%d_%H%M%S}.log"

    root = logging.getLogger("mc_i18n")
    root.setLevel(logging.DEBUG)
    root.handlers.clear()          # 防止重复运行时 handler 叠加

    console = logging.StreamHandler(sys.stderr)
    console.setLevel(getattr(logging, console_level.upper(), logging.INFO))
    console.setFormatter(logging.Formatter("%(message)s"))
    root.addHandler(console)

    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setLevel(logging.DEBUG)
    file_handler.setFormatter(logging.Formatter(
        "%(asctime)s [%(levelname)-7s] %(name)s: %(message)s"))
    root.addHandler(file_handler)
    return log_file


# --------------------------------------------------------------------------
# 主入口
# --------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    """CLI 主入口；返回进程退出码（0 成功 / 1 有失败 / 2 参数或文件错误）。"""
    # v0.3.8：控制台编码防御。Windows 窄编码（cp1252/cp936）管道下 print 中文会抛
    # UnicodeEncodeError 并中断整个命令；errors="replace" 降级为 ? 号，绝不阻断流程。
    ensure_console_encoding()
    parser = argparse.ArgumentParser(
        prog="mc_i18n",
        description=f"MC整合包自动翻译工具 v{__version__}"
                    f"（扫描 → 翻译 → 占位符还原 → 导出 → 打包，零第三方依赖）",
    )
    parser.add_argument("--version", action="version", version=f"mc-i18n {__version__}")
    # required=False：允许"零参数"启动（双击 exe 的默认场景），交给下方分支处理
    sub = parser.add_subparsers(dest="command", required=False)

    # ---- scan ----
    p_scan = sub.add_parser("scan", help="递归扫描整合包，识别语言文件并生成路径映射表")
    p_scan.add_argument("pack_root", help="整合包根目录")
    p_scan.add_argument("-o", "--output", default=None,
                        help="manifest 输出路径（默认 <整合包>/.mc-i18n/manifest.json）")
    p_scan.add_argument("--lang", default="en_us", help="源语言代码（默认 en_us）")
    p_scan.add_argument("--target", default="zh_cn", help="目标语言代码（默认 zh_cn）")
    p_scan.add_argument("--no-jar", action="store_true", help="不扫描 mods/*.jar 容器内部")
    p_scan.add_argument("--quiet", action="store_true", help="只输出汇总，不逐文件列出")

    # ---- translate ----
    p_tr = sub.add_parser("translate", help="完整翻译流程：扫描→解析→批量翻译→导出（→打包）")
    p_tr.add_argument("pack_root", help="整合包根目录")
    p_tr.add_argument("-o", "--output", default=None,
                      help="译文导出目录（默认 <整合包>/.mc-i18n/translated）")
    p_tr.add_argument("-c", "--config", default=None,
                      help="config.yaml 路径（默认：当前目录 → 整合包根目录 → 默认配置）")
    p_tr.add_argument("--lang", default="en_us", help="源语言代码（默认 en_us）")
    p_tr.add_argument("--target", default="zh_cn", help="目标语言代码（默认 zh_cn）")
    p_tr.add_argument("--engine", default=None,
                      help="主引擎（覆盖配置文件）：google / youdao / baidu / deepl / openai / demo")
    p_tr.add_argument("--fallback", default=None,
                      help="备用引擎列表，逗号分隔（覆盖配置文件），如 'baidu,deepl'")
    p_tr.add_argument("--force", action="store_true", help="强制重翻（忽略翻译缓存）")
    p_tr.add_argument("--no-jar", action="store_true", help="不扫描 mods/*.jar 容器内部")
    p_tr.add_argument("--limit", type=int, default=0,
                      help="只处理前 N 个候选文件（0=全部，调试用）")
    p_tr.add_argument("--dry-run", action="store_true",
                      help="只扫描与统计（含缓存命中估算），不调用 API、不写文件")
    p_tr.add_argument("--workers", type=int, default=None, help="并发线程数（默认取配置）")
    p_tr.add_argument("--no-cache", action="store_true", help="本次任务禁用翻译缓存")
    p_tr.add_argument("--no-glossary", action="store_true",
                      help="禁用术语表（内置 MC 标准术语 + glossary.yaml）")
    p_tr.add_argument("--translate-existing", action="store_true",
                      help="强制重翻整合包已自带目标语言翻译的文件"
                           "（默认跳过，保护已有的社区/官方中文不被机翻覆盖）")
    p_tr.add_argument("--merge-existing", action="store_true",
                      help="增量合并：整合包已自带目标语言文件的，保留其既有译文、"
                           "只补翻缺失条目后合并导出（既不覆盖好翻译，也不留半截汉化）。"
                           "优先级高于 --translate-existing")
    p_tr.add_argument("--pack", action="store_true", help="翻译完成后立即打包为汉化资源包")
    p_tr.add_argument("-O", "--pack-out", default=None,
                      help="汉化资源包产出位置（文件夹或 .zip 路径）。"
                           "默认输出到整合包 resourcepacks 文件夹内（开箱即用）；"
                           "传 .zip 则生成单文件压缩包；相对路径以整合包根为基准。")
    p_tr.add_argument("--zip", default=None,
                      help="(旧别名) 同 --pack-out：资源包产出位置")
    p_tr.add_argument("--mc-version", default=None, help="整合包 MC 版本（用于推断 pack_format）")
    p_tr.add_argument("--pack-format", type=int, default=None, help="显式指定资源包 pack_format")
    p_tr.add_argument("--description", default="汉化资源包（mc-i18n 生成）", help="资源包描述")
    p_tr.add_argument("--check", dest="check", action="store_true",
                      help="翻译前先做一轮语言文件质量巡检（只读，不调用 API）；"
                           "发现 ERROR 级问题只告警，不阻断翻译")
    p_tr.add_argument("--check-strict", dest="check_strict", action="store_true",
                      help="同 --check，但发现 ERROR 级问题时中止翻译（退出码 1），适合 CI")
    p_tr.add_argument("--verbose", action="store_true", help="控制台输出 DEBUG 级日志")

    # ---- inspect ----
    p_insp = sub.add_parser("inspect", help="查看单文件解析结果与占位符完整性分析")
    p_insp.add_argument("file", help=".lang/.json 文件路径")
    p_insp.add_argument("--limit", type=int, default=20,
                        help="条目预览条数上限（-1 全部，默认 20）")
    p_insp.add_argument("--no-placeholders", action="store_true",
                        help="不显示占位符分析列")

    # ---- pack ----
    p_pack = sub.add_parser("pack", help="把 translate 的导出目录一键打包为汉化资源包")
    p_pack.add_argument("translated_dir", help="translate 的导出目录（如 .mc-i18n/translated）")
    p_pack.add_argument("-O", "--pack-out", default=None,
                        help="汉化资源包产出位置（文件夹或 .zip 路径）。"
                             "默认输出到整合包 resourcepacks 文件夹内（开箱即用）；"
                             "传 .zip 则生成单文件压缩包；相对路径以整合包根为基准。")
    p_pack.add_argument("-o", "--output", default=None,
                        help="(旧别名) 同 --pack-out：资源包产出位置")
    p_pack.add_argument("--mc-version", default=None, help="整合包 MC 版本（推断 pack_format）")
    p_pack.add_argument("--pack-format", type=int, default=None, help="显式指定 pack_format")
    p_pack.add_argument("--description", default="汉化资源包（mc-i18n 生成）", help="资源包描述")

    # ---- roundtrip ----
    p_rt = sub.add_parser("roundtrip", help="校验解析→序列化是否字节级还原原文件")
    p_rt.add_argument("file", help=".lang/.json 文件路径")

    # ---- check（v0.3.8，路线图 M2 的 --check 质量巡检）----
    p_chk = sub.add_parser(
        "check", help="语言文件质量巡检（只读，不调用 API）：重复键/占位符丢失/漏翻/编码隐患")
    p_chk.add_argument("pack_root", help="整合包根目录")
    p_chk.add_argument("--lang", default="en_us", help="源语言代码（默认 en_us）")
    p_chk.add_argument("--target", default="zh_cn", help="目标语言代码（默认 zh_cn）")
    p_chk.add_argument("--no-jar", action="store_true", help="不扫描 mods/*.jar 容器内部")
    p_chk.add_argument("--no-untranslated", action="store_true",
                       help="关闭「译文与原文完全相同」的漏翻检测（同形词多的包可关）")
    p_chk.add_argument("--ignore", default=None,
                       help="跳过指定问题码，逗号分隔，如 'stale_translation,mixed_format_spec'")
    p_chk.add_argument("-o", "--output", default=None,
                       help="巡检报告输出路径（默认 <整合包>/.mc-i18n/check-report.json）")
    p_chk.add_argument("--json", dest="as_json", action="store_true",
                      help="把 JSON 报告直接打到标准输出（不写文件）")
    p_chk.add_argument("--max-issues", type=int, default=30,
                       help="控制台逐条明细上限（0=只输出汇总，默认 30）")
    p_chk.add_argument("--strict", action="store_true",
                       help="WARN 级问题也视为失败（退出码 1），适合 CI 卡点")
    p_chk.add_argument("--quiet", action="store_true", help="只输出一行结论")

    # ---- gui ----
    p_gui = sub.add_parser("gui", help="启动图形界面（本地网页，自动打开浏览器）")
    p_gui.add_argument("--port", type=int, default=0,
                       help="监听端口（默认 8636，被占用时自动 +1）")
    p_gui.add_argument("--no-browser", action="store_true",
                       help="只启动服务，不自动打开浏览器")

    # ---- menu ----
    sub.add_parser("menu", help="控制台菜单模式（翻版/扫描/打包等纯键盘操作）")

    args = parser.parse_args(argv)

    # ---- 无子命令：双击 exe 的默认场景 → 控制台菜单（v0.3.2 行为回退）----
    # v0.2.1~v0.3.1 无参数直开图形界面（WebUI），实测存在两个问题：
    #   1. CI 冒烟测试 `exe </dev/null | head -5` 下，Windows 把 NUL 设备
    #      归类为字符设备（GetFileType → FILE_TYPE_CHAR），isatty() 误判
    #      为"交互终端" → 启动 serve() 阻塞循环且永不退出，冒烟步骤被
    #      拖到 timeout-minutes 兜底超时，表现为"构建卡死"。
    #   2. 图形界面并非所有用户的第一选择，直开浏览器反而绕路。
    # v0.3.2 起无参数统一进入控制台菜单（键盘流），图形界面降级为可选：
    #   菜单选 [6]，或显式运行 `mc-i18n gui` / `mc-i18n.exe gui`。
    # 菜单对 stdin EOF / Ctrl+C 已有优雅退出路径（_MenuExit → return），
    # 因此无人值守环境（CI / 管道 / 重定向）打印菜单后立即退出，不再
    # 依赖 isatty 判断（该判断在 Windows NUL 场景不可靠，见上）。
    if args.command is None:
        from .interactive import run_interactive   # 延迟导入：加快启动速度

        return run_interactive()

    try:
        if args.command == "scan":
            return _cmd_scan(args)
        if args.command == "translate":
            return _cmd_translate(args)
        if args.command == "inspect":
            return _cmd_inspect(args)
        if args.command == "pack":
            return _cmd_pack(args)
        if args.command == "roundtrip":
            return _cmd_roundtrip(args)
        if args.command == "check":
            return _cmd_check(args)
        if args.command == "gui":
            from .webui import serve          # 延迟导入：不影响其他子命令启动速度
            serve(port=args.port, open_browser=not args.no_browser)
            return 0
        if args.command == "menu":
            from .interactive import run_interactive
            return run_interactive()
    except (NotADirectoryError, FileNotFoundError, ValueError) as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return 2
    return 0


# -------------------------------------------------------------------------- #
# scan 子命令
# -------------------------------------------------------------------------- #
def _cmd_scan(args) -> int:
    """执行扫描：打印汇总 + 文件映射表，并把 manifest 落盘。"""
    options = ScanOptions(
        source_lang=args.lang,
        target_lang=args.target,
        include_jars=not args.no_jar,
    )
    report = scan(Path(args.pack_root), options)
    stats = report.stats

    print("=" * 62)
    print(f"mc-i18n v{__version__} 整合包扫描报告")
    print("=" * 62)
    print(f"整合包目录 : {report.pack_root}")
    print(f"包类型     : {report.pack_type} | 源语言: {report.source_lang}"
          f" | 目标语言: {report.target_lang}")
    print(f"语言文件   : {stats.language_files} 个"
          f"（翻译候选 {stats.source_candidates} 个，可翻译条目 {stats.total_entries} 条）")
    fmt_text = ", ".join(f"{k}={v}" for k, v in stats.by_fmt.items()) or "-"
    mod_text = ", ".join(f"{k}={v}" for k, v in stats.by_mod.items()) or "-"
    print(f"按格式     : {fmt_text} | 按模组: {mod_text}")
    print(f"jar 容器   : {stats.jars_scanned} 个 | 跳过 json: {stats.json_skipped} 个"
          f" | 解析失败: {stats.parse_errors} 个 | 超限跳过: {stats.too_large_skipped} 个")

    if not args.quiet:
        print("-" * 62)
        for ref in report.files:
            tags = []
            if ref.is_source_candidate:
                tags.append("候选")
            if ref.is_target_existing:
                tags.append("目标已存在")
            if ref.parse_status != "ok":
                tags.append(ref.parse_status)
            tag_text = f"[{','.join(tags)}]" if tags else ""
            print(f"[{ref.fmt.value}]{tag_text} {ref.path_in_pkg}")
            warn_text = f" ⚠ {'; '.join(ref.warnings)}" if ref.warnings else ""
            print(f"    mod={ref.mod_id} 条目={ref.entry_count} 编码={ref.encoding}"
                  f" 导出→ {ref.export_relative_path}{warn_text}")

    if report.warnings:
        print("-" * 62)
        for warning in report.warnings:
            print(f"⚠ {warning}")

    output = Path(args.output) if args.output else Path(report.pack_root) / ".mc-i18n" / "manifest.json"
    save_manifest(build_manifest(report), output)
    print("-" * 62)
    print(f"路径映射表已保存: {output}")
    print(f"耗时 {report.duration_sec}s")
    return 0


# -------------------------------------------------------------------------- #
# translate 子命令
# -------------------------------------------------------------------------- #
def _cmd_translate(args) -> int:
    """完整翻译闭环。配置文件 → 环境变量 → CLI 参数三层覆盖后交给流水线。"""
    pack_root = Path(args.pack_root)
    if not pack_root.is_dir():
        raise NotADirectoryError(f"整合包目录不存在：{pack_root}")

    # ---- 配置加载（文件 → 环境变量 → CLI 覆盖）----
    cfg_result = load_config(args.config, pack_root)
    app = cfg_result.config
    if args.engine:
        app.engine.primary = args.engine
    if args.fallback is not None:
        app.engine.fallback = [x.strip() for x in args.fallback.split(",") if x.strip()]
    if args.workers:
        app.workers = args.workers

    errors = app.validate()
    if errors:
        for err in errors:
            print(f"[配置错误] {err}", file=sys.stderr)
        return 2

    # ---- 术语表：内置 MC 标准术语 + <整合包>/glossary.yaml（用户键优先）----
    glossary = None
    if not args.no_glossary:
        from .core.glossary import Glossary
        from .core.glossary_presets import DEFAULT_TERMS_COUNT
        user_glossary = Glossary.load(pack_root / "glossary.yaml")
        glossary = user_glossary.with_defaults()

    log_file = _setup_logging(pack_root, console_level="DEBUG" if args.verbose else "INFO")
    print(f"mc-i18n v{__version__} 翻译任务")
    print(f"  整合包   : {pack_root}")
    print(f"  语言对   : {args.lang} → {args.target}")
    print(f"  引擎     : {app.engine.primary}"
          f"（备用：{', '.join(app.engine.fallback) or '无'}）")
    if args.merge_existing:
        policy_text = "增量合并（保留既有译文，只补翻缺失条目）"
    elif args.translate_existing:
        policy_text = "全量重翻（忽略整合包已有中文）"
    else:
        policy_text = "跳过（保护整合包已有中文；--merge-existing 只补翻缺失）"
    print(f"  已有中文 : {policy_text}")
    if glossary:
        print(f"  术语表   : 内置 {DEFAULT_TERMS_COUNT} 条 MC 标准术语"
              f" + 用户 {len(user_glossary)} 条，共 {len(glossary)} 条自动生效"
              f"（--no-glossary 可禁用）")
    if cfg_result.path:
        print(f"  配置文件 : {cfg_result.path}")
    for warning in cfg_result.warnings:
        print(f"  ⚠ {warning}")
    print(f"  日志文件 : {log_file}")
    print("-" * 62)

    # ---- 可选：翻译前质量巡检（v0.3.8）。只读，不调用任何引擎。----
    # 默认只告警：整合包先天的重复键/漏翻不该挡住"先翻一遍看看"。
    # CI 场景用 --check-strict 把它升级为硬闸门。
    if args.check or args.check_strict:
        abort_code = _run_preflight_check(pack_root, args)
        if abort_code is not None:
            return abort_code

    options = PipelineOptions(
        source_lang=args.lang,
        target_lang=args.target,
        include_jars=not args.no_jar,
        engine_primary=args.engine,
        engine_fallback=[x.strip() for x in args.fallback.split(",")] if args.fallback is not None else None,
        force_refresh=args.force,
        dry_run=args.dry_run,
        limit=args.limit,
        workers=args.workers,
        no_cache=args.no_cache,
        skip_existing_translations=not args.translate_existing,
        merge_existing=args.merge_existing,
        glossary=glossary,
        out_dir=Path(args.output) if args.output else None,
    )
    result = TranslationPipeline(app).run(pack_root, options)

    print("-" * 62)
    print(result.summary_line())
    if result.failures:
        print(f"\n失败清单（前 {min(10, len(result.failures))} 条，完整见 report.json）：")
        for failure in result.failures[:10]:
            print(f"  ✗ [{failure['file']}] {failure['key']}：{failure['reason'][:90]}")
    if result.dry_run:
        return 0
    print(f"  译文目录 : {result.output_dir}")
    report_path = pack_root / ".mc-i18n" / "report.json"
    print(f"  任务报告 : {report_path}")

    # ---- 可选：翻译完直接打包 ----
    if args.pack:
        pack_out = args.pack_out or args.zip          # --pack-out 优先，--zip 兼容旧别名
        out_path = resolve_pack_output(
            pack_root, pack_out, target_lang=args.target, pack_name=pack_root.name)
        is_zip = out_path.suffix.lower() == ".zip"
        try:
            built, count = build_resource_pack_to(
                result.output_dir, out_path,
                pack_format=args.pack_format, mc_version=args.mc_version,
                description=args.description,
            )
        except ValueError as exc:
            print(f"[打包失败] {exc}", file=sys.stderr)
            return 1
        fmt = args.pack_format or guess_pack_format(args.mc_version)
        where = "（文件夹资源包，开箱即用）" if not is_zip else "（zip 资源包）"
        print(f"  资源包   : {built}（pack_format={fmt}，{count} 个文件）{where}")
    return 0 if not result.failures and result.files_error == 0 else 1


# -------------------------------------------------------------------------- #
# inspect 子命令
# -------------------------------------------------------------------------- #
def _cmd_inspect(args) -> int:
    """打印单文件的解析结果 + 占位符完整性分析。"""
    fpath = Path(args.file)
    data = fpath.read_bytes()
    text, meta = decode_bytes(data)
    parser = get_parser_for_filename(fpath.name)
    if parser is None:
        print(f"[错误] 不支持的文件格式：{fpath.name}", file=sys.stderr)
        return 2
    parsed = parser.parse(text)
    guard = PlaceholderGuard()

    print(f"文件     : {fpath}")
    print(f"格式     : {parsed.fmt.value} | 编码: {meta['encoding']}"
          f"（BOM: {'有' if meta['had_bom'] else '无'}） | 大小: {len(data)} B")
    if parsed.fmt.value == "json" and parsed.style is not None:
        style = parsed.style
        print(f"风格     : 缩进={style.indent!r} 压缩单行={'是' if style.minified else '否'}"
              f" ascii转义={'是' if style.ensure_ascii else '否'}"
              f" 尾换行={'是' if style.trailing_newline else '否'}"
              f" CRLF={'是' if style.crlf else '否'}")
        print(f"键况     : 条目={len(parsed.entries)} 重复键={len(parsed.duplicate_keys)}"
              f" 非字符串键={len(parsed.non_string_keys)}")
    else:
        raw_segments = sum(1 for seg in parsed.segments if seg[0] == "raw")
        cont = sum(1 for e in parsed.entries.values() if e.continuation)
        print(f"结构     : 物理行={len(parsed.lines)} 注释/空行/杂行段={raw_segments}"
              f" 条目={len(parsed.entries)}（含续行条目 {cont} 条）")
    if parsed.warnings:
        for warning in parsed.warnings:
            print(f"⚠ {warning}")

    # ---- 占位符完整性分析（inspect 的核心增量能力）----
    if not args.no_placeholders:
        from collections import Counter
        counter: Counter[str] = Counter()
        multi = 0
        print("-" * 62)
        print("占位符分析（基于保护引擎的识别规则）：")
        for key, entry in parsed.entries.items():
            tokens = guard.analyze(entry.value)
            if not tokens:
                continue
            counter.update(tokens)
            if len(tokens) > 1:
                multi += 1
            print(f"  {key}: {' '.join(tokens)}")
        if counter:
            kinds = ", ".join(f"{tok}×{n}" for tok, n in counter.most_common())
            print(f"  汇总：{sum(counter.values())} 个占位符"
                  f"（{len(counter)} 种），多条目占位符 {multi} 条")
            print("  提示：以上占位符在翻译中将被 ⟦N⟧ token 保护，字节级还原")
        else:
            print("  未发现占位符")

    print("-" * 62)
    limit = len(parsed.entries) if args.limit < 0 else args.limit
    for i, (key, entry) in enumerate(parsed.entries.items()):
        if i >= limit:
            print(f"... 共 {len(parsed.entries)} 条（剩余 {len(parsed.entries) - limit} 条未显示）")
            break
        print(f"{key} = {entry.value!r}")
    return 0


# -------------------------------------------------------------------------- #
# pack 子命令
# -------------------------------------------------------------------------- #
def _cmd_pack(args) -> int:
    """把 translate 导出目录一键打包为汉化资源包。"""
    translated_dir = Path(args.translated_dir)
    if not translated_dir.is_dir():
        raise NotADirectoryError(f"导出目录不存在：{translated_dir}（先运行 translate）")
    # 默认产出位置：整合包 resourcepacks 文件夹内（开箱即用）。
    # pack 子命令仅拿到 translated_dir，用其父目录的父目录反推整合包根目录。
    pack_root = translated_dir.parent.parent
    pack_out = args.pack_out or args.output          # --pack-out 优先，--output 兼容旧别名
    out_path = resolve_pack_output(pack_root, pack_out,
                                  target_lang="zh_cn", pack_name=pack_root.name)
    is_zip = out_path.suffix.lower() == ".zip"
    built, count = build_resource_pack_to(
        translated_dir, out_path,
        pack_format=args.pack_format, mc_version=args.mc_version,
        description=args.description,
    )
    fmt = args.pack_format or guess_pack_format(args.mc_version)
    where = "（文件夹资源包，开箱即用）" if not is_zip else "（zip 资源包）"
    print("=" * 62)
    print(f"mc-i18n v{__version__} 汉化资源包打包完成")
    print(f"  来源       : {translated_dir}")
    print(f"  资源包     : {built}")
    print(f"  pack_format: {fmt} | 文件数: {count} {where}")
    print(f"  使用方法   : 放入 .minecraft/resourcepacks/ 后在游戏中启用"
          + ("（已在整合包内，启动游戏即可见）" if not is_zip else ""))
    return 0


# -------------------------------------------------------------------------- #
# roundtrip 子命令
# -------------------------------------------------------------------------- #
def _cmd_roundtrip(args) -> int:
    """验证"解析 → 序列化"往返是否字节级还原（验收指标 A2 的单文件手动工具）。"""
    fpath = Path(args.file)
    data = fpath.read_bytes()
    text, meta = decode_bytes(data)
    parser = get_parser_for_filename(fpath.name)
    if parser is None:
        print(f"[错误] 不支持的文件格式：{fpath.name}", file=sys.stderr)
        return 2
    parsed = parser.parse(text)
    rebuilt = parser.serialize(parsed)          # 不带译文 → 应与原文一致

    if rebuilt == text:
        print(f"✅ 往返校验通过（字节级一致）：{fpath}")
        return 0
    diff_at = next((i for i, (a, b) in enumerate(zip(text, rebuilt)) if a != b),
                   min(len(text), len(rebuilt)))
    print(f"❌ 往返校验失败：{fpath}")
    print(f"   首个差异位于第 {diff_at} 字符处；原文长度 {len(text)}，重建长度 {len(rebuilt)}")
    print(f"   原文片段: {text[max(0, diff_at - 20):diff_at + 20]!r}")
    print(f"   重建片段: {rebuilt[max(0, diff_at - 20):diff_at + 20]!r}")
    return 1


# -------------------------------------------------------------------------- #
# check 子命令（v0.3.8，路线图 M2 的"质量巡检"）
# -------------------------------------------------------------------------- #
def _cmd_check(args) -> int:
    """语言文件质量巡检：只读体检 + 人类可读摘要 + 结构化 JSON 报告。

    退出码：0=无 ERROR 级问题 / 1=有 ERROR（或 --strict 下有 WARN） / 2=参数或路径错误。
    """
    pack_root = Path(args.pack_root)
    if not pack_root.is_dir():
        raise NotADirectoryError(f"整合包目录不存在：{pack_root}")

    ignore = frozenset(
        code.strip() for code in (args.ignore or "").split(",") if code.strip())
    unknown = sorted(ignore - set(quality.ISSUE_CATALOG))
    if unknown:
        print(f"[错误] 未知问题码：{', '.join(unknown)}", file=sys.stderr)
        print(f"       可用问题码：{', '.join(sorted(quality.ISSUE_CATALOG))}",
              file=sys.stderr)
        return 2

    options = quality.CheckOptions(
        source_lang=args.lang,
        target_lang=args.target,
        include_jars=not args.no_jar,
        check_untranslated=not args.no_untranslated,
        ignore_codes=ignore,
    )
    report = quality.check_pack(pack_root, options)

    if args.as_json:
        # --json：结构化结果直出标准输出，交给 jq / CI 消费，不落盘
        print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    else:
        for line in _check_report_lines(report, max_issues=args.max_issues,
                                        quiet=args.quiet):
            print(line)

    if not args.as_json:
        out_path = (Path(args.output) if args.output
                    else pack_root / ".mc-i18n" / "check-report.json")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps(report.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8")
        if not args.quiet:
            print("-" * 62)
            print(f"巡检报告已保存: {out_path}")
            print(f"耗时 {report.duration_sec:.2f}s")

    if report.error_count:
        return 1
    if args.strict and report.warn_count:
        return 1
    return 0


def _check_report_lines(report, *, max_issues: int, quiet: bool) -> list[str]:
    """把 QualityReport 渲染成控制台文本（保持与 scan/translate 一致的版式）。"""
    if quiet:
        verdict = "通过" if report.ok else f"发现 {report.error_count} 处 ERROR 级问题"
        return [f"[check] {verdict}："
                f"error={report.error_count} warn={report.warn_count}"
                f" info={report.info_count}（源文件 {report.source_files} 个，"
                f"比对 {report.entries_checked} 条）"]

    lines = ["=" * 62,
             f"mc-i18n v{__version__} 语言文件质量巡检报告",
             "=" * 62,
             f"整合包目录 : {report.pack_root}",
             f"语言对     : {report.source_lang} → {report.target_lang}",
             f"语言文件   : {report.files_scanned} 个"
             f"（源语言 {report.source_files} 个，"
             f"其中 {report.paired_files} 个有目标语言文件可逐条比对）",
             f"比对条目   : {report.entries_checked} 条",
             "-" * 62,
             f"问题汇总   : {report.error_count} error | "
             f"{report.warn_count} warn | {report.info_count} info"]

    by_code = report.by_code()
    if not by_code:
        lines.append("  ✅ 未发现问题")
    for code, files, entries in by_code:
        severity, description = quality.ISSUE_CATALOG.get(
            code, (quality.Severity.WARN, "未知问题"))
        mark = {"error": "✗", "warn": "⚠", "info": "ℹ"}.get(severity.value, "·")
        lines.append(f"  {mark} {code:<20} {files} 个文件 / {entries} 条 —— {description}")

    issues = report.sorted_issues()
    if max_issues > 0 and issues:
        lines.append("-" * 62)
        lines.append(f"问题明细（前 {min(max_issues, len(issues))} 条，"
                     f"完整见 check-report.json）：")
        for issue in issues[:max_issues]:
            lines.append(f"[{issue.severity.value}] {issue.code}  {issue.path_in_pkg}")
            if issue.detail:
                lines.append(f"    {issue.detail}")
            if issue.keys:
                lines.append(f"    受影响 {issue.count} 项"
                             f"（示例 {len(issue.keys)} 条）：")
                for key in issue.keys[:5]:
                    lines.append(f"      - {key}")
        if len(issues) > max_issues:
            lines.append(f"  ... 其余 {len(issues) - max_issues} 条见 check-report.json")

    if report.warnings:
        lines.append("-" * 62)
        for warning in report.warnings[:20]:
            lines.append(f"⚠ {warning}")
        if len(report.warnings) > 20:
            lines.append(f"⚠ ... 其余 {len(report.warnings) - 20} 条告警见报告 JSON")
    return lines


def _run_preflight_check(pack_root: Path, args) -> int | None:
    """``translate --check`` 的翻译前巡检；返回非 None 表示应直接以该退出码结束。"""
    options = quality.CheckOptions(
        source_lang=args.lang,
        target_lang=args.target,
        include_jars=not args.no_jar,
    )
    report = quality.check_pack(pack_root, options)
    print(f"[巡检] error={report.error_count} warn={report.warn_count}"
          f" info={report.info_count}"
          f"（源语言文件 {report.source_files} 个，比对条目 {report.entries_checked} 条）")
    for code, files, entries in report.by_code()[:8]:
        severity, description = quality.ISSUE_CATALOG.get(
            code, (quality.Severity.WARN, "未知问题"))
        print(f"       {severity.value:<5} {code:<20} {files} 文件 / {entries} 条"
              f" —— {description}")
    if report.error_count:
        if args.check_strict:
            print("[巡检] 存在 ERROR 级问题，--check-strict 中止翻译。"
                  "确认可忽略后请去掉 --check-strict 重跑。", file=sys.stderr)
            return 1
        print("[巡检] 存在 ERROR 级问题（如占位符丢失会直接影响游戏内显示），"
              "本次仅告警、继续翻译。")
    return None


if __name__ == "__main__":
    raise SystemExit(main())
