"""OpenAI 兼容引擎——LLM 翻译扩展位（DeepSeek / Kimi / GLM / 本地 vLLM 均可接入）。

只要服务实现 POST {base_url}/chat/completions 的 OpenAI Chat 协议即可使用：
    config.yaml:
        openai:
          api_key: sk-xxx
          base_url: https://api.deepseek.com/v1     # 换 base_url 即接入其他厂商
          model: deepseek-chat

批量协议（本引擎的核心设计）：
    请求  把一批文本编号为 JSON 对象 {"0": "...", "1": "..."} 塞进 user 消息，
          system 提示词硬性要求：保留 ⟦N⟧ 占位符标记、只输出 JSON；
    响应  解析 content 中的 JSON（自适应：剥 ``` 代码围栏、截取最外层花括号），
          校验编号集完整后按序取译文。
    自适应降级  整批 JSON 解析失败/编号缺失 → 逐条单发重试
               （LLM 偶发输出废话很常见，逐条几乎总能成功）；
               逐条仍失败的那几条抛给流水线降级链处理。
"""

from __future__ import annotations

import json
import logging
import re

from ...config import AppConfig
from ._registry import register_engine
from .base import (
    BaseEngine, AuthError, EngineError, HTTPStatusError, QuotaError, RateLimited,
    http_json,
)

logger = logging.getLogger("mc_i18n.engine.openai")

# 兼容常见的"输出带围栏"坏习惯：```json ... ``` / ``` ... ```
_CODE_FENCE_RE = re.compile(r"```[a-zA-Z]*\s*(.*?)```", re.DOTALL)


@register_engine("openai")
class OpenAICompatEngine(BaseEngine):
    """OpenAI Chat 兼容协议引擎（LLM 扩展位示例实现）。"""

    name = "openai"
    prefers_glossary_instructions = True    # 术语走 prompt 指令，不做 token 保护（防 LLM 吞 ⟦N⟧）

    def __init__(self, app: AppConfig):
        super().__init__(
            retry=app.retry,
            qps=0.0,
            timeout=app.openai.timeout,
            batch_char_budget=10**6,   # 批量上限交给 batch_size 控制，字符预算不设卡
        )
        self.conf = app.openai
        if not self.conf.api_key:
            raise AuthError("OpenAI 兼容引擎缺少 api_key（config.yaml 或环境变量 OPENAI_API_KEY）")
        self._url = self.conf.base_url.rstrip("/") + "/chat/completions"

    def model_tag(self) -> str:
        return self.conf.model    # 模型名参与缓存键：换模型不串缓存

    # ------------------------------------------------------------------
    # 协议编解码
    # ------------------------------------------------------------------
    def _build_user_content(self, texts: list[str]) -> str:
        """组装 user 消息：编号 JSON 在前，命中的术语对照表附在后。

        术语对照放 JSON 之后：_extract_json 截取"最外层花括号"时
        不会被术语段干扰（术语键值不含花括号，见基类 glossary_hints_for）。
        """
        numbered = json.dumps(
            {str(i): text for i, text in enumerate(texts)}, ensure_ascii=False)
        hints = self.glossary_hints_for(texts)
        if not hints:
            return numbered
        lines = "\n".join(f"{key}={value}" for key, value in hints.items())
        return (numbered
                + "\n\n【术语对照表】下列英文术语必须使用等号右侧的固定简体中文译法，"
                  "不得采用其他译名：\n" + lines)

    @staticmethod
    def _extract_json(content: str) -> dict[str, str]:
        """从模型输出中鲁棒地提取 JSON 对象（剥围栏 + 截取最外层花括号）。"""
        text = content.strip()
        fence = _CODE_FENCE_RE.search(text)
        if fence:
            text = fence.group(1).strip()
        first, last = text.find("{"), text.rfind("}")
        if first == -1 or last <= first:
            raise EngineError(f"模型输出中未找到 JSON 对象：{text[:80]!r}")
        try:
            parsed = json.loads(text[first:last + 1])
        except json.JSONDecodeError as exc:
            raise EngineError(f"模型输出 JSON 解析失败：{exc}") from exc
        if not isinstance(parsed, dict):
            raise EngineError("模型输出不是 JSON 对象")
        return {str(k): str(v) for k, v in parsed.items()}

    def _request(self, user_content: str) -> str:
        """一次 chat/completions 调用，返回模型文本输出。"""
        body = {
            "model": self.conf.model,
            "temperature": self.conf.temperature,
            "messages": [
                {"role": "system", "content": self.conf.system_prompt},
                {"role": "user", "content": user_content},
            ],
        }
        try:
            _status, payload = http_json(
                self._url, method="POST", body=body,
                headers={"Authorization": f"Bearer {self.conf.api_key}"},
                timeout=self.timeout,
            )
        except HTTPStatusError as exc:
            if exc.status in (401, 403):
                raise AuthError(f"OpenAI 兼容接口鉴权失败（HTTP {exc.status}）") from exc
            if exc.status == 429:
                raise RateLimited("OpenAI 兼容接口限流（429）") from exc
            if exc.status >= 500:
                raise EngineError(f"OpenAI 兼容接口服务端错误（HTTP {exc.status}）") from exc
            raise EngineError(f"OpenAI 兼容接口 HTTP {exc.status}：{exc.body[:120]}") from exc
        try:
            return str(payload["choices"][0]["message"]["content"])
        except (KeyError, IndexError, TypeError) as exc:
            raise EngineError(f"OpenAI 响应结构异常：{str(payload)[:120]}") from exc

    def _translate_numbered(self, texts: list[str]) -> list[str]:
        """按编号 JSON 协议翻译一批，校验编号完整性后按序返回。"""
        content = self._request(self._build_user_content(texts))
        parsed = self._extract_json(content)
        missing = [i for i in range(len(texts)) if str(i) not in parsed]
        if missing:
            raise EngineError(f"模型输出缺少编号 {missing[:5]}（共缺 {len(missing)} 条）")
        return [parsed[str(i)] for i in range(len(texts))]

    # ------------------------------------------------------------------
    # 单次批量调用 / 自适应策略
    # ------------------------------------------------------------------
    def translate_batch(self, texts: list[str]) -> list[str]:
        """整批一次请求（供 chunk/装箱层调用的标准入口）。"""
        return self._translate_numbered(texts)

    def translate_batch_with_retry(self, texts: list[str]) -> list[str]:
        """LLM 自适应策略：整批（重试）失败 → 逐条（重试），尽最大能力多救回几条。

        逐条也失败时抛出"最常见"的错误，由流水线把该批整体降级。
        """
        try:
            return self._call_with_retry(lambda: self._translate_numbered(texts))
        except EngineError as batch_error:
            logger.warning("整批请求失败（%d 条），降级为逐条请求：%s", len(texts), batch_error)

        outputs: list[str] = []
        last_error: EngineError | None = None
        for index, text in enumerate(texts):
            try:
                outputs.append(self._call_with_retry(
                    lambda t=text: self._translate_numbered([t])
                )[0])
            except EngineError as item_error:
                logger.warning("逐条请求失败（第 %d 条）：%s", index, item_error)
                last_error = item_error
        if len(outputs) != len(texts):
            raise last_error or EngineError("逐条请求全部失败")
        return outputs

    def chunk(self, texts) -> list[list[str]]:
        """LLM 批量按条数装箱（batch_size 条/批；单批文本过长也拆开防超上下文）。"""
        batches: list[list[str]] = []
        current: list[str] = []
        current_len = 0
        limit = max(1, self.conf.batch_size)
        char_cap = 6000    # 经验值：单请求 user 消息超过 ~6K 字符时模型保序性下降
        for text in texts:
            if current and (len(current) >= limit or current_len + len(text) > char_cap):
                batches.append(current)
                current, current_len = [], 0
            current.append(text)
            current_len += len(text)
        if current:
            batches.append(current)
        return batches
