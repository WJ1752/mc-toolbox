"""WebUI HTTP 协议层 —— 请求解析、路由分发与服务器启动（v0.3.0 框架拆分）。

本模块只做协议与传输：

    - GET_ROUTES / POST_ROUTES  模块级路由表（请求时直接查表，不再每请求重建）
    - WebUIHandler              解析 JSON / multipart 请求体 → 查表分发 →
                                统一把业务异常映射为 400/404 JSON 错误响应
    - serve()                   启动 ThreadingHTTPServer（阻塞），端口占用自动 +1

安全边界（与 v0.2.x 一致）：
    - 只绑定 127.0.0.1，不对外网暴露；
    - multipart 仅 /api/upload 一个入口，解析用标准库 email.parser
      （不依赖已废弃的 cgi 模块）。
"""
from __future__ import annotations

import email
import json
import threading
import webbrowser
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .. import __version__
from ..utils import ensure_console_encoding, safe_print
from ..web_page import PAGE_HTML
from . import api
from .helpers import _json_bytes

_DEFAULT_PORT = 8636

# -------------------------------------------------------------------------- #
# 路由表（模块级常量，v0.3.0 起不再于每次请求时重建）
#   GET  接口收 query dict；POST 接口收 JSON 请求体 dict
# -------------------------------------------------------------------------- #
GET_ROUTES = {
    "/api/status": api._api_status,
    "/api/report": api._api_report,
    "/api/review/files": api._api_review_files,
    "/api/review/entries": api._api_review_entries,
    "/api/glossary": api._api_glossary,
    "/api/settings": api._api_settings,
    "/api/browse": api._api_browse,
    "/api/presets": api._api_presets,
}

POST_ROUTES = {
    "/api/scan": api._api_scan,
    "/api/translate": api._api_translate,
    "/api/quests/scan": api._api_quests_scan,
    "/api/quests/translate": api._api_quests_translate,
    "/api/review/save": api._api_review_save,
    "/api/glossary/save": api._api_glossary_save,
    "/api/glossary/import_defaults": api._api_glossary_import_defaults,
    "/api/settings/save": api._api_settings_save,
    "/api/test-engine": api._api_test_engine,
    "/api/pack": api._api_pack,
    "/api/cancel": api._api_cancel,
}

# multipart 接口单独走文件流通道（请求体不是 JSON）
MULTIPART_ROUTES = {
    "/api/upload": api._api_upload,
}


class WebUIHandler(BaseHTTPRequestHandler):
    server_version = f"mc-i18n-webui/{__version__}"

    # ---- 工具 ----
    def _send(self, body: bytes, status: int, ctype: str):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json_ok(self, data: dict):
        body, status, ctype = _json_bytes(data)
        self._send(body, status, ctype)

    def _send_json_err(self, exc: Exception, status: int = 400):
        body, _, ctype = _json_bytes({"error": f"{type(exc).__name__}: {exc}"})
        self._send(body, status, ctype)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise ValueError(f"请求体不是合法 JSON：{exc}") from exc
        if not isinstance(data, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return data

    def _read_multipart_body(self) -> tuple[dict, list[tuple[str, bytes]]]:
        """解析 multipart/form-data；返回 (字段, [(文件名, 内容), ...])。

        用 email.parser 解析，避免依赖已废弃的 cgi 模块。
        """
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}, []
        raw = self.rfile.read(length)
        content_type = self.headers.get("Content-Type", "")
        # 构造合法 MIME 消息头
        msg_bytes = b"Content-Type: " + content_type.encode("utf-8") + b"\r\n\r\n" + raw
        msg = email.message_from_bytes(msg_bytes)

        fields: dict[str, str] = {}
        files: list[tuple[str, bytes]] = []
        payload = msg.get_payload()
        if isinstance(payload, list):
            for part in payload:
                disp = part.get("Content-Disposition") or ""
                if "form-data" not in disp:
                    continue
                name = part.get_param("name", header="Content-Disposition")
                filename = part.get_param("filename", header="Content-Disposition")
                body = part.get_payload(decode=True) or b""
                if filename:
                    files.append((filename, body))
                elif name:
                    fields[name] = body.decode("utf-8", errors="replace")
        return fields, files

    def _query_dict(self) -> dict:
        qs = parse_qs(urlparse(self.path).query)
        return {k: v[0] for k, v in qs.items()}

    # ---- 日志静默（本地工具，不刷屏）----
    def log_message(self, fmt, *args):  # noqa: A003
        pass

    # ---- 路由 ----
    def do_GET(self):  # noqa: N802
        try:
            path = self.path.split("?", 1)[0]
            if path in ("/", "/index.html"):
                self._send(PAGE_HTML.encode("utf-8"), 200,
                           "text/html; charset=utf-8")
                return
            query = self._query_dict()
            handler = GET_ROUTES.get(path)
            if handler is None:
                raise FileNotFoundError(f"未知接口：{path}")
            self._send_json_ok(handler(query))
        except Exception as exc:  # noqa: BLE001
            self._send_json_err(exc, 404 if isinstance(exc, FileNotFoundError) else 400)

    def do_POST(self):  # noqa: N802
        try:
            path = self.path.split("?", 1)[0]
            content_type = self.headers.get("Content-Type", "")

            # multipart 接口：文件上传
            if content_type.startswith("multipart/form-data"):
                params, files = self._read_multipart_body()
                handler = MULTIPART_ROUTES.get(path)
                if handler is None:
                    raise FileNotFoundError(f"未知 multipart 接口：{path}")
                self._send_json_ok(handler(params, files))
                return

            # JSON 接口
            params = self._read_json_body()
            handler = POST_ROUTES.get(path)
            if handler is None:
                raise FileNotFoundError(f"未知接口：{path}")
            self._send_json_ok(handler(params))
        except Exception as exc:  # noqa: BLE001
            self._send_json_err(exc, 404 if isinstance(exc, FileNotFoundError) else 400)


# -------------------------------------------------------------------------- #
# 启动入口
# -------------------------------------------------------------------------- #
# 说明（v0.3.8）：原模块内的 _safe_print 与 serve() 内联的流编码防御已上移至
# utils.safe_print / utils.ensure_console_encoding，与 CLI、交互式菜单共用
# 同一份实现（此前三处各写一套，策略与行为存在漂移风险）。


def serve(port: int = 0, open_browser: bool = True,
          on_ready: Callable[[ThreadingHTTPServer], None] | None = None,
          quiet: bool = False) -> int:
    """启动 WebUI（阻塞）；返回实际端口。port=0 表示自动选择空闲端口。

    ``on_ready``（v0.3.2 新增，可选）：端口 bind 成功后、打印启动横幅之前
    以绑定的 server 对象为参数回调一次。设计动机（macOS CI 排查结论）：

        - serve() 是阻塞调用，调用方原本无从得知实际端口，测试只能约定
          固定端口探测 —— 固定端口在 CI 上天生脆弱（被占用/时间等待残留）；
        - 就绪信号也不应依赖横幅打印完成：stdout 慢或竞争时，端口早已
          可服务而探测方还在空等。

    回调里可安全调用 ``server.shutdown()`` / ``server.server_close()``
    （在其它线程）实现优雅关闭；回调自身抛异常会被吞掉，不影响服务。

    ``quiet``（v0.3.5 新增，可选）：跳过启动横幅打印与浏览器自动打开，
    并**在 bind 后立即进入 serve_forever()**。供测试/嵌入方使用——
    macOS CI 上曾出现"bind 成功但因横幅阶段耗时而探活超时"的时序问题，
    quiet=True 把"bind → 开始 accept"的窗口压到最小，从结构上消除该
    依赖（而非靠放大超时预算硬扛）。默认 False，命令行与 WebUI 行为不变。
    """
    if port == 0:
        port = _DEFAULT_PORT
    for attempt in range(20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), WebUIHandler)
            break
        except OSError:
            port += 1
    else:
        raise OSError("无法找到可用端口（8636-8655 均被占用）")

    # bind 成功即刻通知调用方（先于横幅打印）：服务是否就绪与 stdout
    # 无关，测试/嵌入方据此拿到真实端口与可 shutdown 的 server 引用。
    if on_ready is not None:
        try:
            on_ready(server)
        except Exception:  # noqa: BLE001 - 回调失败不允许影响服务可用性
            pass

    if quiet:
        # 测试/嵌入路径：跳过横幅与浏览器，直接开始 accept，消除时序依赖。
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        return port

    # 控制台编码防御（保守模式：只把不可映射字符降级为 replace，不强制改
    # encoding，以保住中文 Windows 控制台 cp936 下的正常显示）。实现见
    # utils.ensure_console_encoding()，与 CLI / 交互式菜单共用。
    ensure_console_encoding()

    url = f"http://127.0.0.1:{port}"
    safe_print()
    safe_print("─" * 56)
    safe_print(f"  mc-i18n 汉化工具箱 v{__version__}")
    safe_print(f"  图形界面地址：{url}")
    safe_print("  浏览器没有自动打开？手动复制上方地址访问。")
    safe_print("  关闭本窗口 / 按 Ctrl+C 即退出。")
    safe_print("─" * 56)
    if open_browser:
        threading.Timer(0.6, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        safe_print("\n已退出。")
    return port
