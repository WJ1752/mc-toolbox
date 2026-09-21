"""谷歌翻译引擎（社区广泛使用的免费 gtx 接口 · 零密钥开箱即用）。

接口要点（社区长期使用经验）：
    端点    https://translate.googleapis.com/translate_a/single
    参数    client=gtx & dt=t & sl=<源> & tl=<目标> & q=<文本>
    方法    GET（q 走 query string，UTF-8）
    响应    JSON 数组：[[["译句1","原句1",...],["译句2","原句2",...]], ...]
            data[0] 是分句数组，每项 [0] 为译文分句，顺序与原文流一致
    限制    无官方配额承诺，高频访问会 429；单请求 q 建议控制在数千字符内

多段-多行重组算法（与百度引擎同一套守卫纪律）：
    发送前把多条文本以 "\n" 拼接进 q，统计总行数 total_lines；
    响应把 data[0] 所有分句 [0] 顺序拼接为整段译文，按 "\n" 切分，
    行数必须等于 total_lines，再按各条文本占用行数切回重组。
    行数不符（服务端策略变化/超长截断等）抛 EngineError 走降级链，
    绝不静默错位拼装译文。

网络可达性说明：
    部分网络环境无法直连 translate.googleapis.com；用户可把
    config.yaml 的 google.endpoint 换成本地可用的镜像地址，
    引擎其余逻辑不变。目标语言映射：zh_cn → zh-CN，zh_tw → zh-TW。
"""

from __future__ import annotations

from ...config import AppConfig
from ._registry import register_engine
from .base import (
    BaseEngine, EngineError, HTTPStatusError, RateLimited,
    http_json,
)

# MC 语言代码 → 谷歌语言代码（BCP-47 风格，区域段用大写）
_LANG_MAP = {
    "zh_cn": "zh-CN",
    "zh_tw": "zh-TW",
    "zh_hk": "zh-HK",
    "en_us": "en",
    "ja_jp": "ja",
    "ko_kr": "ko",
    "fr_fr": "fr",
    "de_de": "de",
    "ru_ru": "ru",
    "es_es": "es",
    "pt_br": "pt",
}


@register_engine("google")
class GoogleEngine(BaseEngine):
    """谷歌翻译免费接口引擎。"""

    name = "google"

    def __init__(self, app: AppConfig):
        super().__init__(
            retry=app.retry,
            qps=app.google.qps,
            timeout=app.google.timeout,
            batch_char_budget=app.google.batch_char_budget,
        )
        self.conf = app.google          # 零密钥引擎：无需校验凭证

    # ------------------------------------------------------------------
    # 内部工具
    # ------------------------------------------------------------------
    @staticmethod
    def _map_lang(mc_lang: str) -> str:
        """MC 语言代码 → 谷歌语言代码；未知语言取 "_" 前缀主语言码兜底。"""
        code = mc_lang.lower().replace("-", "_")
        mapped = _LANG_MAP.get(code)
        if mapped:
            return mapped
        return code.split("_")[0]

    # ------------------------------------------------------------------
    # 单次批量调用
    # ------------------------------------------------------------------
    def translate_batch(self, texts: list[str]) -> list[str]:
        # 1) 多段拼接：段间以 \n 分隔；统计每段行数用于响应重组
        joined = "\n".join(texts)
        line_counts = [text.count("\n") + 1 for text in texts]
        total_lines = sum(line_counts)

        params = {
            "client": "gtx",
            "dt": "t",
            "sl": self._map_lang(self.source_lang),
            "tl": self._map_lang(self.target_lang),
            "q": joined,
        }

        # 2) 请求与 HTTP 状态分诊
        try:
            _status, payload = http_json(
                self.conf.endpoint, params=params, timeout=self.timeout
            )
        except HTTPStatusError as exc:
            if exc.status == 429:
                raise RateLimited(f"谷歌接口限流（HTTP 429）：{exc.body[:80]}") from exc
            raise EngineError(f"谷歌接口 HTTP {exc.status}") from exc

        # 3) 结构守卫：期望 [分句数组, ...]；分句数组每项 [译句, 原句, ...]
        if not (isinstance(payload, list) and payload
                and isinstance(payload[0], list)):
            raise EngineError(f"谷歌响应结构异常：{str(payload)[:120]}")

        segments: list[str] = []
        for item in payload[0]:
            if not (isinstance(item, list) and item):
                raise EngineError("谷歌响应分句缺少译文项")
            segments.append(str(item[0]))
        merged = "".join(segments)          # 分句顺序拼接 = 完整译文

        # 4) 行数守卫：切分行数必须等于发送总行数，否则按错误降级
        lines = merged.split("\n")
        if len(lines) != total_lines:
            raise EngineError(
                f"谷歌响应行数不匹配：发送 {total_lines} 行，返回 {len(lines)} 行"
            )

        # 5) 按各段行数切回：段内 join("\n") 重组（保证 %s 换行结构零偏差）
        outputs: list[str] = []
        cursor = 0
        for count in line_counts:
            outputs.append("\n".join(lines[cursor:cursor + count]))
            cursor += count
        return outputs
