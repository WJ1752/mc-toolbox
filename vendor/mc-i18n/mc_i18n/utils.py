"""通用工具集：文件解码（编码探测）、哈希与控制台编码防御。

编码策略（对应技术设计方案 §4.2.4）：
    1. 若文件以 UTF-8 BOM 开头 → 用 utf-8-sig 解码（BOM 自动剥离并记录）；
    2. 否则先尝试严格 UTF-8（MC 官方要求的标准编码，覆盖 99% 场景）；
    3. 失败则尝试 GBK（部分远古整合包/中文作者手编文件）；
    4. 再失败则尝试可选依赖 charset-normalizer 自动探测（若已安装）；
    5. 最后兜底 latin-1（永不失败，但会告警提示人工确认）。

写出统一为 UTF-8 无 BOM（后续导出阶段执行），本模块只负责"读"。

另提供**控制台**编码防御工具（v0.3.8 起集中到本模块）：
``ensure_console_encoding`` 与 ``safe_print``。此前这两类逻辑散落在
``webui/http.py``（_safe_print + serve 内联 reconfigure）与
``interactive.py``（_ensure_console_utf8）三处，实现与策略各异；
集中后 CLI / 交互菜单 / WebUI 三个入口共用一份实现，杜绝再次漂移。
"""

from __future__ import annotations

import hashlib
import sys
from typing import Any

# UTF-8 BOM 字节序列（EF BB BF）
UTF8_BOM = b"\xef\xbb\xbf"


def sha256_bytes(data: bytes) -> str:
    """计算字节流的 SHA-256 摘要（十六进制字符串）。

    用于文件级去重（PRD F07）：内容未变化的文件直接跳过，不重复解析/翻译。
    """
    return hashlib.sha256(data).hexdigest()


def decode_bytes(data: bytes) -> tuple[str, dict[str, Any]]:
    """把原始字节流解码为文本，并返回编码元信息。

    返回值：
        (text, meta)
        text : 解码后的字符串（BOM 已剥离）
        meta : {"encoding": str, "had_bom": bool, "warnings": list[str]}
    """
    meta: dict[str, Any] = {"encoding": "utf-8", "had_bom": False, "warnings": []}

    # --- 1) UTF-8 BOM：MC 社区部分编辑器（Windows 记事本）会写入 BOM ---
    if data.startswith(UTF8_BOM):
        meta["had_bom"] = True
        meta["encoding"] = "utf-8-sig"
        # utf-8-sig 会自动剥离 BOM；导出时统一转为无 BOM，并在报告中提示
        meta["warnings"].append("文件带 UTF-8 BOM，导出时将转为标准 UTF-8 无 BOM")
        return data.decode("utf-8-sig"), meta

    # --- 2) 严格 UTF-8（最常见路径，速度最快）---
    try:
        return data.decode("utf-8"), meta
    except UnicodeDecodeError:
        pass

    # --- 3) GBK（远古整合包 / 中文环境手编文件）---
    try:
        text = data.decode("gbk")
        meta["encoding"] = "gbk"
        meta["warnings"].append("文件不是 UTF-8，按 GBK 解码；导出时将转为 UTF-8")
        return text, meta
    except UnicodeDecodeError:
        pass

    # --- 4) 可选依赖 charset-normalizer 自动探测（已安装才启用）---
    try:
        from charset_normalizer import from_bytes  # type: ignore

        best = from_bytes(data).best()
        if best is not None:
            meta["encoding"] = best.encoding or "unknown"
            meta["warnings"].append(f"文件编码异常，charset-normalizer 判定为 {meta['encoding']}")
            return str(best), meta
    except ImportError:
        pass  # 未安装可选依赖，跳过自动探测

    # --- 5) latin-1 兜底（任何字节序列都可解码，但可能得到乱码）---
    meta["encoding"] = "latin-1"
    meta["warnings"].append("无法识别编码，已按 latin-1 兜底解码，请人工确认内容")
    return data.decode("latin-1"), meta


# --------------------------------------------------------------------------
# 控制台编码防御（v0.3.8：从 webui/http.py 与 interactive.py 提炼为公共实现）
# --------------------------------------------------------------------------
def ensure_console_encoding(force_utf8: bool = False) -> None:
    """尽力让标准输出/错误流在窄编码环境下不因中文而崩溃。

    背景：Windows 上 Python 3.6+ 向**真控制台**写入时走 Unicode API
    （PEP 528），``sys.stdout.encoding`` 已是 ``utf-8``，中文显示正常。
    但一旦 stdout/stderr 被重定向到管道或文件，就退化为按 locale 编码
    的字节流（英文系统常见 ``cp1252``），此时打印中文/制表符（``─``
    U+2500）会抛 ``UnicodeEncodeError``。对 WebUI 而言这尤其致命：
    异常若发生在 ``serve_forever()`` 之前，服务线程随之崩溃 —— 端口已
    bind+listen 却无人 accept，客户端只看到连接超时（v0.3.1 修复的
    CI 缺陷根因）。

    参数：
        force_utf8:
            ``False``（默认，保守）只把不可映射字符降级为 ``?``，
            **不改动 encoding** —— 中文 Windows 控制台（cp936）下中文
            显示完全不受影响，cp1252 等窄编码管道下也不再抛异常。
            ``True`` 则强制切到 UTF-8，字节层面无损、适合重定向落盘，
            但在旧版 cmd 的 GBK 代码页下可能显示为乱码。

    标准流缺失或不是 ``TextIOWrapper``（被测试框架替换等）时静默跳过；
    任何失败都不得影响主流程 —— 调用方可能在服务启动的关键路径上。
    """
    for stream in (sys.stdout, sys.stderr):
        if stream is None:
            continue
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            if force_utf8:
                reconfigure(encoding="utf-8", errors="replace")
            else:
                reconfigure(errors="replace")
        except Exception:  # noqa: BLE001 - 编码重配失败不影响主流程
            pass


def safe_print(text: str = "", *, stream: Any = None) -> None:
    """防御式输出：编码 / IO 失败绝不中断调用方流程。

    用于横幅、启动提示、菜单等"展示了更好、展示失败也无所谓"的输出。
    相比直接 ``print``，它把 ``UnicodeEncodeError`` / ``OSError`` 等
    一并吞掉 —— 输出失败最多丢一行提示，服务/菜单照常运转。

    ``stream`` 为 ``None`` 时输出到标准输出（等同内置 ``print``）。
    """
    try:
        print(text, file=stream)
    except Exception:  # noqa: BLE001 - 输出失败不允许影响主流程
        pass
