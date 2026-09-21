"""百度翻译引擎（百度翻译开放平台 · 通用文本翻译 API）。

接口要点（依据官方文档）：
    端点    https://fanyi-api.baidu.com/api/trans/vip/translate
    方法    GET / POST，参数 q / from / to / appid / salt / sign
    签名    sign = MD5(appid + q + salt + 密钥)（q 为拼接后的完整文本）
    批量    多段文本用 "\n" 连接进 q；服务端按行拆分并在
            trans_result 数组里逐行返回 {"src":..., "dst":...}
    配额    标准版 5 万字符/月、QPS=1、单请求 q≤1000 字符；
            个人认证高级版 100 万字符/月、QPS=10、单请求≤6000 字符

多段-多行重组算法（本模块的关键正确性保障）：
    发送前统计每条文本占用的行数 lines(i) = count("\n") + 1；
    响应的 trans_result 项数必须等于总行数，按行数依次切回每条文本，
    段内用 "\n" 重新连接。若行数不匹配（服务端策略变化等），
    抛 EngineError 交给流水线降级，绝不静默错位拼装译文。

语言代码映射：MC 的 zh_cn → 百度 zh；zh_tw → cht；en_us → en。
未收录的语言取 "_" 前的主语言码兜底。
"""

from __future__ import annotations

import hashlib
import uuid

from ...config import AppConfig
from ._registry import register_engine
from .base import (
    BaseEngine, AuthError, EngineError, HTTPStatusError, QuotaError, RateLimited,
    http_json,
)

# MC 语言代码 → 百度语言代码（未收录的语言取 "_" 前缀兜底）
_LANG_MAP = {
    "zh_cn": "zh",     # 简体中文
    "zh_tw": "cht",    # 繁体中文（台湾）
    "zh_hk": "yue",    # 粤语（百度无 zh_hk，社区习惯映射 yue）
    "en_us": "en",
    "ja_jp": "jp",
    "ko_kr": "kor",
    "fr_fr": "fra",
    "de_de": "de",
    "ru_ru": "ru",
    "es_es": "spa",
    "pt_br": "pt",
}

# 百度错误码 → 本工具异常语义（未列出的错误码按 EngineError 可重试处理）
_ERROR_MAP: dict[str, tuple[type[Exception], str]] = {
    "52001": (EngineError, "请求超长（q 超过配额字符数），请调小 batch_char_budget"),
    "52002": (EngineError, "翻译服务响应异常"),
    "52003": (AuthError, "未授权（app_id 或密钥错误）"),
    "54000": (AuthError, "必填参数为空（检查 app_id/q/salt/sign 配置）"),
    "54001": (AuthError, "签名错误（检查 app_key 是否正确）"),
    "54003": (RateLimited, "访问频率受限（QPS 超额）"),
    "54004": (QuotaError, "账户余额不足"),
    "54005": (RateLimited, "请求过于频繁（长文本并发受限）"),
    "58000": (AuthError, "客户端 IP 非法（检查平台 IP 白名单设置）"),
    "58001": (EngineError, "目标语言不在支持列表"),
    "58002": (QuotaError, "翻译服务已关闭（检查控制台服务状态）"),
    "90107": (AuthError, "认证失败（标准版/高级版资质问题）"),
}


@register_engine("baidu")
class BaiduEngine(BaseEngine):
    """百度通用文本翻译引擎。"""

    name = "baidu"

    def __init__(self, app: AppConfig):
        super().__init__(
            retry=app.retry,
            qps=app.baidu.qps,
            timeout=app.baidu.timeout,
            batch_char_budget=app.baidu.batch_char_budget,
        )
        self.conf = app.baidu
        if not self.conf.app_id or not self.conf.app_key:
            raise AuthError("百度引擎缺少 app_id / app_key（config.yaml 或环境变量 BAIDU_APP_ID/BAIDU_APP_KEY）")

    # ------------------------------------------------------------------
    # 内部工具
    # ------------------------------------------------------------------
    @staticmethod
    def _map_lang(mc_lang: str, *, to_target: bool) -> str:
        """MC 语言代码 → 百度语言代码；未知语言取主语言码兜底。"""
        code = mc_lang.lower().replace("-", "_")
        mapped = _LANG_MAP.get(code)
        if mapped:
            return mapped
        if not to_target:
            return code.split("_")[0]     # 源语言兜底：en_us → en
        # 目标语言未知 → 尽力而为（百度对不认识的代码会报 58001，走降级链）
        return mapped or code.split("_")[0]

    @staticmethod
    def _sign(q: str, salt: str, app_id: str, app_key: str) -> str:
        """官方签名算法：MD5(appid + q + salt + key)。"""
        raw = f"{app_id}{q}{salt}{app_key}".encode("utf-8")
        return hashlib.md5(raw).hexdigest()

    # ------------------------------------------------------------------
    # 单次批量调用
    # ------------------------------------------------------------------
    def translate_batch(self, texts: list[str]) -> list[str]:
        # 1) 多段拼接：段间以 \n 分隔；统计每段行数用于响应重组
        joined = "\n".join(texts)
        line_counts = [text.count("\n") + 1 for text in texts]
        total_lines = sum(line_counts)

        # 2) 签名与参数（salt 需随机数；官方未规定格式，uuid 截断足够）
        salt = uuid.uuid4().hex[:16]
        params = {
            "q": joined,
            "from": self._map_lang(self.source_lang, to_target=False),
            "to": self._map_lang(self.target_lang, to_target=True),
            "appid": self.conf.app_id,
            "salt": salt,
            "sign": self._sign(joined, salt, self.conf.app_id, self.conf.app_key),
        }

        # 3) 请求与错误码分诊
        try:
            _status, payload = http_json(
                self.conf.endpoint, params=params, timeout=self.timeout
            )
        except HTTPStatusError as exc:
            raise EngineError(f"百度 API HTTP {exc.status}") from exc

        if isinstance(payload, dict) and payload.get("error_code"):
            code = str(payload["error_code"])
            exc_type, hint = _ERROR_MAP.get(code, (EngineError, "未知错误"))
            detail = payload.get("error_msg", "")
            raise exc_type(f"百度错误码 {code}（{hint}）：{detail}")

        trans_result = payload.get("trans_result") if isinstance(payload, dict) else None
        if not isinstance(trans_result, list):
            raise EngineError(f"百度响应缺少 trans_result 字段：{str(payload)[:120]}")

        # 4) 行数守卫：响应行数必须等于发送的总行数，否则按错误处理
        if len(trans_result) != total_lines:
            raise EngineError(
                f"百度响应行数不匹配：发送 {total_lines} 行，返回 {len(trans_result)} 行"
            )

        # 5) 按各段行数切回：段内 join("\n") 重组（保证 %s 换行结构零偏差）
        outputs: list[str] = []
        cursor = 0
        for count in line_counts:
            lines = [str(item.get("dst", "")) for item in trans_result[cursor:cursor + count]]
            outputs.append("\n".join(lines))
            cursor += count
        return outputs
