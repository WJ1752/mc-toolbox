"""DeepL 翻译引擎（DeepL API /v2/translate）。

接口要点（依据官方文档）：
    域名    Free 密钥（以 ":fx" 结尾）→ https://api-free.deepl.com
            Pro  密钥               → https://api.deepl.com
    方法    POST JSON：{"text": ["...", ...], "target_lang": "ZH",
                       "source_lang": "EN"(可选), "preserve_formatting": true}
    鉴权    请求头 Authorization: DeepL-Auth-Key <key>
    批量    text 传数组，响应 translations 数组与请求顺序一一对应
    配额    Free 50 万字符/月；单请求体上限 128 KiB（装箱预算已保守设定）

错误码语义：403 → 鉴权失败；456 → 配额耗尽；429 → 限流；
5xx → 服务端错误（可重试）。与百度引擎共用基类的重试/限流机制。
"""

from __future__ import annotations

from ...config import AppConfig
from ._registry import register_engine
from .base import (
    BaseEngine, AuthError, EngineError, HTTPStatusError, QuotaError, RateLimited,
    http_json,
)

# MC 语言代码 → DeepL 目标语言代码（DeepL 要求大写；zh 统一翻简体中文）
_TARGET_MAP = {
    "zh_cn": "ZH",
    "zh_tw": "ZH",       # DeepL 无 zh-TW 目标语言；ZH 即简体中文
    "en_us": "EN",
    "ja_jp": "JA",
    "ko_kr": "KO",
    "fr_fr": "FR",
    "de_de": "DE",
    "es_es": "ES",
    "pt_br": "PT-BR",
    "ru_ru": "RU",
}

# MC 语言代码 → DeepL 源语言代码（仅收录DeepL官方明确支持的源语言；未知则不传）
_SOURCE_MAP = {
    "en_us": "EN", "ja_jp": "JA", "ko_kr": "KO", "fr_fr": "FR", "de_de": "DE",
    "es_es": "ES", "pt_br": "PT", "ru_ru": "RU", "zh_tw": "ZH", "zh_cn": "ZH",
}


@register_engine("deepl")
class DeepLEngine(BaseEngine):
    """DeepL 引擎（Free/Pro 域名自适应）。"""

    name = "deepl"

    def __init__(self, app: AppConfig):
        super().__init__(
            retry=app.retry,
            qps=0.0,                                   # DeepL 官方未设硬 QPS，不额外限流
            timeout=app.deepl.timeout,
            batch_char_budget=app.deepl.batch_char_budget,
        )
        self.conf = app.deepl
        if not self.conf.api_key:
            raise AuthError("DeepL 引擎缺少 api_key（config.yaml 或环境变量 DEEPL_API_KEY）")

        # 域名自适应：Free 密钥以 ":fx" 结尾
        key = self.conf.api_key
        self._is_free = key.endswith(":fx")
        if self.conf.endpoint:
            self._endpoint = self.conf.endpoint.rstrip("/")
        else:
            host = "https://api-free.deepl.com" if self._is_free else "https://api.deepl.com"
            self._endpoint = f"{host}/v2/translate"

    def model_tag(self) -> str:
        # Free 与 Pro 的译文风格可能不同，缓存键区分开更严谨
        return "deepl-free" if self._is_free else "deepl-pro"

    # ------------------------------------------------------------------
    # 单次批量调用
    # ------------------------------------------------------------------
    def translate_batch(self, texts: list[str]) -> list[str]:
        target = _TARGET_MAP.get(self.target_lang.lower())
        if target is None:
            raise EngineError(
                f"DeepL 不支持目标语言 {self.target_lang!r}"
                f"（已收录：{', '.join(sorted(_TARGET_MAP))}）"
            )
        body: dict = {
            "text": list(texts),
            "target_lang": target,
            "preserve_formatting": True,   # 要求 DeepL 保持占位符 token 周边格式
        }
        source = _SOURCE_MAP.get(self.source_lang.lower())
        if source:
            body["source_lang"] = source   # 指定源语言可避免检测抖动、节省字符额度

        try:
            _status, payload = http_json(
                self._endpoint, method="POST", body=body,
                headers={"Authorization": f"DeepL-Auth-Key {self.conf.api_key}"},
                timeout=self.timeout,
            )
        except HTTPStatusError as exc:
            # DeepL 用 HTTP 状态码表达错误语义
            if exc.status == 403:
                raise AuthError("DeepL 鉴权失败（403，检查 api_key 与套餐类型）") from exc
            if exc.status == 456:
                raise QuotaError("DeepL 配额耗尽（456，本月字符额度已用完）") from exc
            if exc.status == 429:
                raise RateLimited("DeepL 限流（429，稍后自动重试）") from exc
            raise EngineError(f"DeepL HTTP {exc.status}") from exc

        translations = payload.get("translations") if isinstance(payload, dict) else None
        if not isinstance(translations, list) or len(translations) != len(texts):
            raise EngineError(
                f"DeepL 响应条数不匹配：发送 {len(texts)} 条，"
                f"返回 {len(translations) if isinstance(translations, list) else '无效'} 条"
            )
        return [str(item.get("text", "")) for item in translations]
