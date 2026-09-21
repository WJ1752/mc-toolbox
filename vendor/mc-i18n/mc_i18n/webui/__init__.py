"""mc-i18n WebUI 包 —— 图形界面的本地服务器与 JSON API（v0.3.0 框架拆分）。

v0.2.x 时代本包是单文件 ``mc_i18n/webui.py``；v0.3.0 起按职责拆分为子模块：

    mc_i18n/webui/
    ├── __init__.py   兼容层：显式 re-export 全部公开符号（本文件）
    ├── state.py      运行期状态：任务槽 _STATE/_Job/_GuiState、上传索引、
    │                 校对台 TTL 缓存
    ├── helpers.py    无状态工具：参数校验、路径换算、校对台索引构建
    ├── api.py        业务层：21 个 _api_* 接口实现（纯 dict 进 / dict 出）
    └── http.py       协议层：WebUIHandler、模块级路由表、serve() 启动入口

对外兼容性承诺（拆分不改变任何行为）：
    - ``from mc_i18n.webui import serve``（cli.py / interactive.py 使用）照旧；
    - ``import mc_i18n.webui as webui; webui._api_scan(...)``（tests 使用）
      照旧 —— 所有旧符号在本命名空间下可见；
    - 路由表提升为模块级常量 GET_ROUTES / POST_ROUTES / MULTIPART_ROUTES，
      并由 tests/test_webui_routes.py 校验完备性。

架构与安全边界（与 v0.2.x 一致）：

    exe/命令启动 → 本地 127.0.0.1 随机端口起 ThreadingHTTPServer
    → 自动打开系统浏览器 → 单页应用（五页：工作台/任务书/校对台/术语表/设置）

    - 只绑定 127.0.0.1（不对外网暴露任何接口）；
    - 只读/写整合包目录与其 .mc-i18n 工作目录；
    - 无 Cookie/登录体系（本地单用户工具，不做过度设计）。
"""
from __future__ import annotations

# ---- 状态层（任务槽 + 运行期缓存） ----
from .state import (
    _GuiState,
    _INDEX_TTL,
    _Job,
    _JobLogHandler,
    _STATE,
    _UPLOAD_CACHE,
    _index_cache,
)

# ---- 工具层 ----
from .helpers import (
    _detect_fmt,
    _find_snbt,
    _glossary_path,
    _json_bytes,
    _read_text_file,
    _resolve_pack_output,
    _review_index,
    _safe_pack,
    _snbt_stat,
    _webui_config_path,
)

# ---- 业务层（21 个 API 实现） ----
from .api import (
    _api_browse,
    _api_cancel,
    _api_glossary,
    _api_glossary_import_defaults,
    _api_glossary_save,
    _api_pack,
    _api_presets,
    _api_report,
    _api_review_entries,
    _api_review_files,
    _api_review_save,
    _api_scan,
    _api_settings,
    _api_settings_save,
    _api_status,
    _api_test_engine,
    _api_translate,
    _api_upload,
    _api_quests_scan,
    _api_quests_translate,
)

# ---- 协议层（路由表 + HTTP 处理器 + 启动入口） ----
from .http import (
    _DEFAULT_PORT,
    GET_ROUTES,
    MULTIPART_ROUTES,
    POST_ROUTES,
    WebUIHandler,
    serve,
)

__all__ = [
    # 协议层
    "serve", "WebUIHandler",
    "GET_ROUTES", "POST_ROUTES", "MULTIPART_ROUTES", "_DEFAULT_PORT",
    # 状态层
    "_STATE", "_Job", "_GuiState", "_JobLogHandler",
    "_UPLOAD_CACHE", "_index_cache", "_INDEX_TTL",
    # 工具层
    "_json_bytes", "_safe_pack", "_webui_config_path", "_glossary_path",
    "_read_text_file", "_resolve_pack_output", "_review_index",
    "_detect_fmt", "_find_snbt", "_snbt_stat",
    # 业务层
    "_api_upload", "_api_scan", "_api_translate", "_api_cancel",
    "_api_quests_scan", "_api_quests_translate", "_api_report",
    "_api_review_files", "_api_review_entries", "_api_review_save",
    "_api_glossary", "_api_glossary_import_defaults", "_api_glossary_save",
    "_api_settings", "_api_settings_save", "_api_pack", "_api_test_engine",
    "_api_presets", "_api_status", "_api_browse",
]
