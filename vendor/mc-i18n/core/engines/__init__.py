"""翻译引擎子包：统一抽象 + 注册表 + 工厂。

公开接口：
    create_engine(name, app)   按名字构造引擎实例（注入 AppConfig 与语言对由流水线后续注入）
    available_engines()        已注册引擎名列表（CLI 提示）
    ENGINE_REGISTRY            注册表本体（高级用法：直接枚举）

内置引擎：
    demo     演示引擎（零密钥，输出前缀+原文）
    baidu    百度翻译开放平台
    deepl    DeepL API（Free/Pro 自适应）
    openai   OpenAI Chat 兼容协议（AI 扩展位：GLM/DeepSeek/通义/Kimi/vLLM 等）
    google   谷歌翻译免费 gtx 接口（零密钥，endpoint 可换镜像）
    youdao   有道智云官方 API（应用密钥制）

另含 test_engine_connection()：「测试连接」按钮的后端实现。
"""

from __future__ import annotations

from ...config import AppConfig
from .base import (
    AuthError, BaseEngine, EngineError, HTTPStatusError, QuotaError, RateLimited,
    RateLimiter, http_json,
)
from ._registry import ENGINE_REGISTRY, available_engines, register_engine

# ---- 注册内置引擎（import 即注册）----
from .demo import DemoEngine          # noqa: F401  触发注册
from .baidu import BaiduEngine        # noqa: F401
from .deepl import DeepLEngine        # noqa: F401
from .openai_compat import OpenAICompatEngine  # noqa: F401

# 别名：openai_compat 写法同样可用（与模块名一致，方便从源码找过来的用户）
ENGINE_REGISTRY.setdefault("openai_compat", ENGINE_REGISTRY["openai"])

# ---- 注册其余内置引擎 ----
from .google import GoogleEngine            # noqa: F401  E402
from .youdao import YoudaoEngine            # noqa: F401  E402


def create_engine(name: str, app: AppConfig) -> BaseEngine:
    """按名字构造引擎实例；未注册的名字抛 ValueError（列出可用引擎）。"""
    normalized = name.strip().lower()
    cls = ENGINE_REGISTRY.get(normalized)
    if cls is None:
        raise ValueError(
            f"未知翻译引擎 {name!r}（可用：{', '.join(available_engines())}；"
            f"自定义引擎用 @register_engine 注册后即可使用）"
        )
    return cls(app)


def test_engine_connection(name: str, override: dict | None = None) -> tuple[bool, str]:
    """「测试连接」：用给定配置实际翻译一句话，验证地址/密钥/网络是否可用。

    参数
        name      引擎名（demo/baidu/deepl/openai/google/youdao）
        override  可选配置覆盖 dict（如 {"openai": {"api_key": "sk-...", ...}}），
                  键为配置节名、值为该节的字段 dict —— 允许用户在"尚未保存
                  设置"的情况下先测试表单里的密钥。

    返回 (是否成功, 给用户看的说明文字)；任何异常都被转换为失败消息，绝不抛出。
    """
    from ...config import _SECTION_TYPES, _build_section, load_config

    name = (name or "").strip().lower()
    if name == "demo":
        return True, "演示引擎无需网络与密钥，永远可用"

    try:
        # 1) 加载常规配置（含环境变量注入），再套上"表单临时值"覆盖
        app = load_config().config
        for section, values in (override or {}).items():
            cls = _SECTION_TYPES.get(section)
            if cls is not None and isinstance(values, dict):
                setattr(app, section, _build_section(cls, values, section, []))

        # 2) 构造引擎并实译一句（走完整重试链，但 retry 次数压到 1 次避免久等）
        app.retry.max_retries = 0
        engine = create_engine(name, app)
        engine.configure_languages("en_us", "zh_cn")
        output = engine.translate_batch_with_retry(["Hello, world!"])
        sample = (output[0] if output else "").strip()
        return True, f"连接成功，试译结果：{sample[:60] or '（空）'}"
    except ValueError as exc:               # 未知引擎名
        return False, str(exc)
    except AuthError as exc:
        return False, f"密钥无效或未授权：{exc}"
    except QuotaError as exc:
        return False, f"配额/余额不足：{exc}"
    except RateLimited as exc:
        return False, f"触发限流（密钥大概率是对的，稍后再试）：{exc}"
    except Exception as exc:  # noqa: BLE001 - 测试连接绝不抛异常到 HTTP 层
        return False, f"{type(exc).__name__}: {exc}"


__all__ = [
    "BaseEngine", "EngineError", "AuthError", "QuotaError", "RateLimited",
    "HTTPStatusError", "RateLimiter", "http_json",
    "ENGINE_REGISTRY", "available_engines", "register_engine", "create_engine",
    "test_engine_connection",
    "DemoEngine", "BaiduEngine", "DeepLEngine", "OpenAICompatEngine",
    "GoogleEngine", "YoudaoEngine",
]
