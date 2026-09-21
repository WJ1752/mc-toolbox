"""mc-i18n 交互式菜单模块。

设计目标：当用户**双击 exe**（无任何命令行参数）启动程序时，进入一个
"小白友好"的菜单界面，无需记忆任何命令行参数即可完成
翻译 / 翻译并打包 / 扫描 / 打包 / 查看报告等全部核心操作。

交互体验要点（均为双击 exe 场景下的真实痛点）：
- 不闪退：任何一步出错都只打印错误并回到菜单；退出前必须"按回车"确认；
  窗口由用户亲手关闭，而不是程序退出后立即消失。
- Windows 拖拽路径：把整合包文件夹拖进控制台时路径会被引号包裹
  （含空格路径尤其如此），输入解析时自动剥掉成对引号。
- 控制台编码：Windows 旧版控制台默认 GBK，⟦⟧【】等字符可能打印失败，
  启动时强制将标准输出/错误流转为 UTF-8（带 errors="replace" 兜底）。
- 复用 CLI：菜单只负责"拼装命令行参数"然后调用 ``cli.main(argv)``，
  因此日志、缓存、降级链、失败清单等行为与命令行模式完全一致，
  未来 CLI 新增能力菜单自动继承。

本模块零第三方依赖（仅标准库），不引入任何 GUI 框架。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from . import __version__
from .utils import ensure_console_encoding

# 菜单循环中使用的选择分隔线，纯 ASCII 以兼容最老旧的控制台
_LINE = "-" * 62


class _MenuExit(Exception):
    """用户主动退出菜单（Ctrl+C / Ctrl+Z / 输入 0）时抛出的内部控制流异常。"""


# -------------------------------------------------------------------------- #
# 基础输入输出工具
# -------------------------------------------------------------------------- #
# 控制台编码防御已上移至 utils.ensure_console_encoding（v0.3.8）：
# 此前本模块的 _ensure_console_utf8 与 webui/http.py 的内联实现各写一套，
# 现由 CLI / 交互菜单 / WebUI 三个入口共用同一份实现。


def _strip_quotes(text: str) -> str:
    """剥掉输入两端的引号与空白。

    Windows 用户把文件夹拖进控制台时，系统会自动加英文双引号
    （路径含空格时必然发生），例如 ``"D:\\My Modpack"``。
    """
    return text.strip().strip('"').strip("'").strip()


def _ask(prompt: str) -> str:
    """读取一行输入；EOF（Ctrl+Z 回车）/ Ctrl+C 视为退出菜单。"""
    try:
        return _strip_quotes(input(prompt))
    except (EOFError, KeyboardInterrupt):
        print()
        raise _MenuExit() from None


def _ask_path(prompt: str, must_exist: bool = True) -> str:
    """循环询问一个目录路径，直到（可选）校验存在为止。"""
    while True:
        path = _ask(prompt)
        if not path:
            print("  ! 路径不能为空，请重新输入（或按 Ctrl+C 退出）")
            continue
        if must_exist and not Path(path).is_dir():
            print(f"  ! 目录不存在：{path}\n"
                  "    提示：可直接把整合包文件夹拖进本窗口再回车")
            continue
        return path


def _ask_default(prompt: str, default: str) -> str:
    """询问一个可有默认值的字符串：直接回车即取默认值。"""
    value = _ask(f"{prompt} [{default}]: ")
    return value or default


def _pause(msg: str = "\n按回车键返回菜单…") -> None:
    """暂停等待用户回车（防闪退的关键动作），出错静默。"""
    try:
        input(msg)
    except Exception:  # noqa: BLE001 - 任何异常都只当作用户想离开
        pass


# -------------------------------------------------------------------------- #
# 引擎可用性检测
# -------------------------------------------------------------------------- #
def _detect_engine_status() -> dict[str, tuple[bool, str]]:
    """返回 {引擎名: (是否可用, 说明)}，供菜单展示密钥状态。

    检测逻辑：先尝试加载当前目录 / 默认位置的 config.yaml
    （加载失败自动降级为默认配置并携带警告），再检查各引擎密钥字段；
    demo 引擎永远可用。
    """
    app = None
    try:  # 配置损坏/不存在不影响菜单 —— 降级为默认配置
        from .config import load_config

        result = load_config(None, None)
        app = result.config
    except Exception:  # noqa: BLE001 - 极端情况下(如导入失败)也兜底
        app = None

    def _filled(value: str) -> bool:
        return bool(value and value.strip())

    baidu_ok = deepl_ok = openai_ok = youdao_ok = False
    if app is not None:
        # 注意 AppConfig 的布局：baidu/deepl/openai 是顶层字段，
        # engine 下只有 primary/fallback 引擎选择
        baidu_ok = _filled(app.baidu.app_id) and _filled(app.baidu.app_key)
        deepl_ok = _filled(app.deepl.api_key)
        openai_ok = _filled(app.openai.api_key)
        youdao_ok = _filled(app.youdao.app_id) and _filled(app.youdao.app_key)
    if not baidu_ok:  # 配置文件没有时再看环境变量（config 模块支持环境变量注入）
        baidu_ok = _filled(os.getenv("BAIDU_APP_ID")) and _filled(os.getenv("BAIDU_APP_KEY"))
    if not deepl_ok:
        deepl_ok = _filled(os.getenv("DEEPL_API_KEY"))
    if not openai_ok:
        openai_ok = _filled(os.getenv("OPENAI_API_KEY"))
    if not youdao_ok:
        youdao_ok = (_filled(os.getenv("YOUDAO_APP_ID"))
                     and _filled(os.getenv("YOUDAO_APP_KEY")))

    return {
        "demo": (True, "内置演示引擎，无需密钥；输出带【机翻·演示】前缀，用于试跑全流程"),
        "google": (True, "谷歌翻译免费接口，零密钥；国内网络不可直连时可换镜像地址"),
        "youdao": (youdao_ok, "有道智云官方 API：需 YOUDAO_APP_ID / YOUDAO_APP_KEY"),
        "baidu": (baidu_ok, "百度翻译：需在 config.yaml 或环境变量配置 BAIDU_APP_ID / BAIDU_APP_KEY"),
        "deepl": (deepl_ok, "DeepL：需在 config.yaml 或环境变量 DEEPL_API_KEY（free 密钥以 :fx 结尾）"),
        "openai": (openai_ok, "OpenAI 兼容接口（GLM/DeepSeek/通义/Kimi）：需 OPENAI_API_KEY 与 base_url"),
    }


def _print_menu(status: dict[str, tuple[bool, str]]) -> None:
    """打印横幅 + 菜单项 + 引擎状态一览。"""
    engines = ["demo", "google", "youdao", "baidu", "deepl", "openai"]
    print(f"\n{_LINE}")
    print(f"  MC 整合包自动翻译工具 mc-i18n v{__version__}")
    print(f"  扫描 → 翻译 → 占位符还原 → 导出 → 打包，全程保留原文件格式")
    print(f"{_LINE}")
    print("  [1] 一键翻译            （扫描→翻译→导出译文文件）")
    print("  [2] 翻译并打包资源包    （翻译完成后自动生成可安装的 .zip）")
    print("  [3] 仅扫描整合包        （看看能找到哪些语言文件，不翻译）")
    print("  [4] 仅打包资源包        （把已导出的译文一键打成 .zip）")
    print("  [5] 查看上次翻译报告    （统计 / 失败清单 / 警告）")
    print("  [6] 打开图形界面        （浏览器操作：任务书/校对台/术语表/设置）")
    print("  [0] 退出")
    print(f"{_LINE}")
    print("  翻译引擎状态：")
    for idx, name in enumerate(engines, start=1):
        ok, note = status[name]
        mark = "可用" if ok else "未配置"
        print(f"    {idx}. {name:<7} [{mark}] {note}")
    print(f"{_LINE}")


def _choose_engine() -> str:
    """让用户选择翻译引擎；回车默认 1.google（免费零密钥，失败自动降级）。"""
    engines = ["google", "youdao", "baidu", "deepl", "openai", "demo"]
    status = _detect_engine_status()
    print("\n选择翻译引擎（回车=1.google 免费接口）：")
    for idx, name in enumerate(engines, start=1):
        ok, note = status[name]
        mark = "OK" if ok else "未配置"
        print(f"  {idx}. {name:<7} [{mark}]  {note}")
    while True:
        raw = _ask("> 引擎编号: ")
        if not raw:
            return "google"
        if raw.isdigit() and 1 <= int(raw) <= len(engines):
            chosen = engines[int(raw) - 1]
            if not status[chosen][0]:
                confirm = _ask(f"  ! {chosen} 尚未检测到密钥，翻译将失败并尝试降级。仍要继续吗? [y/N]: ")
                if confirm.lower() not in ("y", "yes"):
                    continue
            return chosen
        print(f"  ! 请输入 1-{len(engines)} 之间的数字")


# -------------------------------------------------------------------------- #
# 菜单动作（每个动作对应一次 cli.main(argv) 调用）
# -------------------------------------------------------------------------- #
def _run_cli(argv: list[str]) -> None:
    """拼装好 argv 后调用 CLI 主入口；打印等价命令行便于复现/报错求助。"""
    from .cli import main as cli_main

    print(f"\n>>> 正在执行: mc-i18n {' '.join(argv)}\n")
    try:
        cli_main(argv)
    except SystemExit as exc:  # argparse 异常会抛 SystemExit，菜单里吞掉转为提示
        print(f"\n[错误] 命令退出（代码 {exc.code}），请检查参数。")
    except Exception as exc:  # noqa: BLE001 - 单次操作失败绝不退出整个菜单
        print(f"\n[错误] {type(exc).__name__}: {exc}")
        print("       详细日志见 <整合包>/.mc-i18n/logs/ 目录。")


def _action_translate(pack: bool) -> None:
    """动作 1/2：完整翻译流程（可选翻译后打包）。"""
    print(f"\n{_LINE}\n  {'翻译并打包资源包' if pack else '一键翻译'}\n{_LINE}")
    root = _ask_path("> 整合包根目录（可拖入文件夹）: ")
    src = _ask_default("源语言代码", "en_us")
    tgt = _ask_default("目标语言代码", "zh_cn")
    engine = _choose_engine()
    argv = ["translate", root, "--lang", src, "--target", tgt, "--engine", engine]
    # 免费接口（google）在部分网络环境不可达 → 自动挂 demo 兜底，
    # 保证小白用户"无论如何都能拿到一份产物 + 明确的报错说明"
    if engine not in ("demo",):
        argv += ["--fallback", "demo"]
    if pack:
        argv.append("--pack")
    _run_cli(argv)
    if pack:
        print("\n提示：资源包 .zip 通常在 <整合包>/.mc-i18n/ 目录下，")
        print("      放入游戏 mods/ 或 resourcepacks/ 即可使用。")


def _action_scan() -> None:
    """动作 3：仅扫描，列出可翻译文件清单。"""
    print(f"\n{_LINE}\n  仅扫描整合包\n{_LINE}")
    root = _ask_path("> 整合包根目录（可拖入文件夹）: ")
    _run_cli(["scan", root])


def _action_pack() -> None:
    """动作 4：把已导出的译文目录打包为资源包。"""
    print(f"\n{_LINE}\n  仅打包资源包\n{_LINE}")
    root = _ask_path("> 整合包根目录（可拖入文件夹）: ")
    translated = os.path.join(root, ".mc-i18n", "translated")
    if not Path(translated).is_dir():
        print(f"  ! 未找到译文导出目录：{translated}")
        print("    请先在菜单里执行 [1] 一键翻译，再回来打包。")
        return
    mcver = _ask_default("MC 版本（如 1.20.1，回车跳过）", "")
    argv = ["pack", translated]
    if mcver:
        argv += ["--mc-version", mcver]
    _run_cli(argv)


def _action_report() -> None:
    """动作 5：展示上次翻译的 report.json（统计 + 失败清单摘要）。"""
    print(f"\n{_LINE}\n  查看上次翻译报告\n{_LINE}")
    root = _ask_path("> 整合包根目录（可拖入文件夹）: ")
    report_path = Path(root) / ".mc-i18n" / "report.json"
    if not report_path.is_file():
        print(f"  ! 未找到报告文件：{report_path}")
        print("    报告在每次 translate 运行结束后自动生成。")
        return
    try:
        data = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - 报告损坏也不退出菜单
        print(f"  ! 报告解析失败：{exc}")
        return
    stats = data.get("stats", {})
    print(f"\n  报告时间   : {data.get('finished_at', '?')}")
    print(f"  语言方向   : {data.get('source_lang', '?')} → {data.get('target_lang', '?')}")
    engine = data.get("engine", {})
    print(f"  翻译引擎   : {engine.get('primary', '?')}"
          f"（备用: {', '.join(engine.get('fallback') or []) or '无'}）")
    print(f"\n  文件       : 共 {stats.get('files_total', 0)} | "
          f"成功 {stats.get('files_ok', 0)} | 部分 {stats.get('files_partial', 0)} | "
          f"失败 {stats.get('files_error', 0)}")
    print(f"  条目       : 去重后 {stats.get('unique_sources', 0)} | "
          f"译出 {stats.get('entries_translated', 0)} | "
          f"命中缓存 {stats.get('entries_from_cache', 0)} | "
          f"失败 {stats.get('entries_failed', 0)}")
    print(f"  API 调用   : {stats.get('api_calls', 0)} 次 / "
          f"{stats.get('chars_sent', 0)} 字符 | 耗时 {stats.get('duration_sec', 0):.1f}s")
    failures = data.get("failures") or []
    if failures:
        print(f"\n  失败清单（前 10 条 / 共 {len(failures)} 条）：")
        for item in failures[:10]:
            print(f"    - {item}")
    warnings = data.get("warnings") or []
    if warnings:
        print(f"\n  警告（前 5 条 / 共 {len(warnings)} 条）：")
        for item in warnings[:5]:
            print(f"    - {item}")
    if not failures:
        print("\n  没有失败条目。")


# -------------------------------------------------------------------------- #
# 主循环
# -------------------------------------------------------------------------- #
def _action_gui() -> None:
    """菜单选项 6：启动图形界面（阻塞直到用户 Ctrl+C 关闭服务）。"""
    from .webui import serve

    print(f"\n{_LINE}")
    print("  正在启动图形界面…浏览器将自动打开。")
    print("  若浏览器没有自动弹出，请手动复制下方地址到浏览器地址栏。")
    print("  用完后回到本窗口按 Ctrl+C（或直接关闭本窗口）即可退出图形界面。")
    print(f"{_LINE}")
    try:
        serve()                      # 阻塞；Ctrl+C 后打印"已退出"并返回菜单
    except OSError as exc:
        print(f"  ! 图形界面启动失败：{exc}")


def run_interactive() -> int:
    """交互菜单主入口；返回进程退出码（菜单模式恒为 0，除非意外）。"""
    # 强制 UTF-8：菜单含 ⟦⟧【】等符号，窄编码管道下需降级而非崩溃
    ensure_console_encoding(force_utf8=True)
    code = 0
    try:
        while True:
            try:
                _print_menu(_detect_engine_status())
                choice = _ask("> 请输入编号: ")
            except _MenuExit:
                raise
            if choice in ("0", "q", "quit", "exit", "exit", "退出"):
                break
            if choice == "1":
                _action_translate(pack=False)
            elif choice == "2":
                _action_translate(pack=True)
            elif choice == "3":
                _action_scan()
            elif choice == "4":
                _action_pack()
            elif choice == "5":
                _action_report()
            elif choice == "6":
                _action_gui()
            else:
                print("  ! 无效编号，请输入 0-6")
    except _MenuExit:
        pass
    except Exception as exc:  # noqa: BLE001 - 菜单兜底：任何意外都不闪退
        print(f"\n[意外错误] {type(exc).__name__}: {exc}")
        code = 1
    # 防闪退关键：退出前必须回车确认，让双击启动的窗口停留在最后画面
    _pause("\n按回车键退出 mc-i18n…")
    return code
