"""有道智云翻译引擎（官方 API · 应用密钥制）。

接口要点（依据有道智云官方文档）：
    端点    https://openapi.youdao.com/api
    方法    POST（application/x-www-form-urlencoded 表单）
    参数    q / from / to / appKey / salt / curtime / sign / signType=v3 / type=data
    签名    sign = sha256(appKey + input + salt + curtime + appSecret)
            input：len(q) ≤ 20 时取 q 全文；
                   超 20 时按官方规则截断为 q[:10] + str(len(q)) + q[-10:]
    响应    {"errorCode": "0", "translation": ["…"], ...}

多段-多行重组算法（与百度/谷歌同一套守卫纪律）：
    发送前把多条文本以 "\n" 拼接进 q，统计总行数；响应把 translation
    数组以 "\n" 连接后按行切分，行数必须等于发送总行数，再按各段行数
    切回重组。行数不符抛 EngineError 走降级链，绝不静默错位。

错误码分诊（errorCode → 异常语义，未列出按可重试 EngineError 处理）：
    0     成功
    103   账户余额不足            → QuotaError（不重试）
    108   应用 ID 无效            → AuthError（不重试）
    110   IP 未授权 / 202 签名错误 → AuthError（不重试）
    20701/20702/40122 频率/并发超限 → RateLimited（退避重试）
"""

from __future__ import annotations

import hashlib
import time
import uuid

from ...config import AppConfig
from ._registry import register_engine
from .base import (
    BaseEngine, AuthError, EngineError, HTTPStatusError, QuotaError, RateLimited,
    http_json,
)

# MC 语言代码 → 有道语言代码（有道用短码：zh-CHS / zh-CHT / en ...）
_LANG_MAP = {
    "zh_cn": "zh-CHS",
    "zh_tw": "zh-CHT",
    "en_us": "en",
    "ja_jp": "ja",
    "ko_kr": "ko",
    "fr_fr": "fr",
    "de_de": "de",
    "ru_ru": "ru",
    "es_es": "es",
    "pt_br": "pt",
}

# 有道 errorCode → 本工具异常语义
_ERROR_MAP: dict[str, tuple[type[Exception], str]] = {
    "103": (QuotaError, "账户余额不足（请到有道智云控制台充值或换套餐）"),
    "108": (AuthError, "应用 ID 无效（检查 youdao.app_id）"),
    "110": (AuthError, "IP 未授权（检查控制台服务授权与 IP 白名单）"),
    "201": (AuthError, "应用已被禁用"),
    "202": (AuthError, "签名检验失败（检查 youdao.app_key 是否正确）"),
    "20701": (RateLimited, "请求过于频繁"),
    "20702": (RateLimited, "频率超限（降低 qps 或减少并发）"),
    "40122": (RateLimited, "并发量超限（降低 workers 或 qps）"),
}


def _clip_input(q: str) -> str:
    """官方签名输入规则：≤20 字符取全文；否则 q[:10] + 长度 + q[-10:]。"""
    if len(q) <= 20:
        return q
    return f"{q[:10]}{len(q)}{q[-10:]}"


@register_engine("youdao")
class YoudaoEngine(BaseEngine):
    """有道智云文本翻译引擎。"""

    name = "youdao"

    def __init__(self, app: AppConfig):
        super().__init__(
            retry=app.retry,
            qps=app.youdao.qps,
            timeout=app.youdao.timeout,
            batch_char_budget=app.youdao.batch_char_budget,
        )
        self.conf = app.youdao
        if not self.conf.app_id or not self.conf.app_key:
            raise AuthError(
                "有道引擎缺少 app_id / app_key"
                "（config.yaml 或环境变量 YOUDAO_APP_ID/YOUDAO_APP_KEY）"
            )

    # ------------------------------------------------------------------
    # 内部工具
    # ------------------------------------------------------------------
    @staticmethod
    def _map_lang(mc_lang: str, *, to_target: bool) -> str:
        """MC 语言代码 → 有道语言代码；未知语言取 "_" 前缀主语言码兜底。"""
        code = mc_lang.lower().replace("-", "_")
        mapped = _LANG_MAP.get(code)
        if mapped:
            return mapped
        return code.split("_")[0]

    @staticmethod
    def _sign(app_id: str, input_text: str, salt: str, curtime: str,
              app_key: str) -> str:
        """官方签名算法 v3：sha256(appKey + input + salt + curtime + secret)。"""
        raw = f"{app_id}{input_text}{salt}{curtime}{app_key}".encode("utf-8")
        return hashlib.sha256(raw).hexdigest()

    # ------------------------------------------------------------------
    # 单次批量调用
    # ------------------------------------------------------------------
    def translate_batch(self, texts: list[str]) -> list[str]:
        # 1) 多段拼接：段间以 \n 分隔；统计每段行数用于响应重组
        joined = "\n".join(texts)
        line_counts = [text.count("\n") + 1 for text in texts]
        total_lines = sum(line_counts)

        # 2) 签名与表单参数（curtime 秒级时间戳；salt 随机串）
        salt = uuid.uuid4().hex[:16]
        curtime = str(int(time.time()))
        form = {
            "q": joined,
            "from": self._map_lang(self.source_lang, to_target=False),
            "to": self._map_lang(self.target_lang, to_target=True),
            "appKey": self.conf.app_id,
            "salt": salt,
            "curtime": curtime,
            "sign": self._sign(self.conf.app_id, _clip_input(joined),
                               salt, curtime, self.conf.app_key),
            "signType": "v3",
            "type": "data",
        }

        # 3) 请求与错误码分诊
        try:
            _status, payload = http_json(
                self.conf.endpoint, method="POST", form=form,
                timeout=self.timeout,
            )
        except HTTPStatusError as exc:
            raise EngineError(f"有道 API HTTP {exc.status}") from exc

        code = str(payload.get("errorCode", "")) if isinstance(payload, dict) else ""
        if code and code != "0":
            exc_type, hint = _ERROR_MAP.get(code, (EngineError, "未知错误"))
            raise exc_type(f"有道错误码 {code}（{hint}）")

        translation = payload.get("translation") if isinstance(payload, dict) else None
        if not isinstance(translation, list) or not translation:
            raise EngineError(f"有道响应缺少 translation 字段：{str(payload)[:120]}")

        # 4) 行数守卫：数组按 \n 连接后切分行数必须等于发送总行数
        #    （无论服务端返回"单元素含换行"还是"逐行多元素"都兼容）
        merged = "\n".join(str(line) for line in translation)
        lines = merged.split("\n")
        if len(lines) != total_lines:
            raise EngineError(
                f"有道响应行数不匹配：发送 {total_lines} 行，返回 {len(lines)} 行"
            )

        # 5) 按各段行数切回：段内 join("\n") 重组（保证 %s 换行结构零偏差）
        outputs: list[str] = []
        cursor = 0
        for count in line_counts:
            outputs.append("\n".join(lines[cursor:cursor + count]))
            cursor += count
        return outputs
