"""翻译引擎抽象基类：统一接口 + 限流 + 指数退避重试 + HTTP 薄封装。

层次设计：
    BaseEngine.translate_batch_with_retry()   流水线唯一调用入口
        └─ _call_with_retry()                限流 + 指数退避（AuthError/配额不重试）
             └─ translate_batch()            子类实现：一次 HTTP 往返翻译一批文本

异常语义（流水线据此执行降级链）：
    AuthError     密钥无效/未授权        → 不重试，直接交给备用引擎
    QuotaError    配额耗尽/余额不足      → 不重试，直接交给备用引擎
    RateLimited   429/限流错误码         → 指数退避后重试
    EngineError   网络错误/5xx/解析失败  → 指数退避后重试
"""

from __future__ import annotations

import json
import logging
import random
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from abc import ABC, abstractmethod
from typing import Any, Callable, Sequence

logger = logging.getLogger("mc_i18n.engine")


# --------------------------------------------------------------------------
# 异常体系
# --------------------------------------------------------------------------

class EngineError(Exception):
    """引擎通用错误（网络 / 服务端 5xx / 响应解析失败）。可重试。"""


class AuthError(EngineError):
    """鉴权失败（密钥无效、未授权、IP 受限）。不可重试。"""


class QuotaError(EngineError):
    """配额耗尽 / 余额不足。不可重试（本月用完了，重试没有意义）。"""


class RateLimited(EngineError):
    """触发限流（429 / 54003）。指数退避后重试。"""


class HTTPStatusError(EngineError):
    """HTTP 非 2xx 响应——携带状态码与响应体，由具体引擎解释语义。"""

    def __init__(self, status: int, body: str):
        self.status = status
        self.body = body
        super().__init__(f"HTTP {status}: {body[:200]}")


# --------------------------------------------------------------------------
# HTTP 薄封装（标准库 urllib；设计为模块级函数 → 单元测试可 monkeypatch）
# --------------------------------------------------------------------------

def http_json(
    url: str,
    *,
    method: str = "GET",
    params: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
    form: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 15.0,
) -> tuple[int, Any]:
    """发起 HTTP 请求并解析 JSON 响应，返回 (状态码, 响应对象)。

    - params 会被 urlencode 到 URL（GET 风格，百度 API 使用）；
    - body 不为 None 时以 application/json POST（DeepL/OpenAI 使用）；
    - form 不为 None 时以 application/x-www-form-urlencoded POST
      （有道智云等传统表单风格 API 使用）；body 与 form 同时给出时取 form；
    - 非 2xx 抛 HTTPStatusError（尽力读取响应体以保留服务端错误信息）；
    - 网络层异常统一包装为 EngineError（可重试）。
    """
    if params:
        url = f"{url}?{urllib.parse.urlencode(params, safe='')}"
    data = None
    request_headers = {"Accept": "application/json"}
    if form is not None:
        data = urllib.parse.urlencode(form).encode("utf-8")
        request_headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    if headers:
        request_headers.update(headers)

    request = urllib.request.Request(url, data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            status = resp.status
            payload = json.loads(resp.read().decode("utf-8", errors="replace"))
            return status, payload
    except urllib.error.HTTPError as exc:  # 4xx/5xx：读出响应体供引擎判别
        try:
            body_text = exc.read().decode("utf-8", errors="replace")
        except OSError:
            body_text = ""
        raise HTTPStatusError(exc.code, body_text) from exc
    except urllib.error.URLError as exc:
        raise EngineError(f"网络错误：{exc.reason}") from exc
    except (TimeoutError, socket.timeout) as exc:
        raise EngineError(f"请求超时（{timeout}s）") from exc
    except json.JSONDecodeError as exc:
        raise EngineError(f"响应不是合法 JSON：{exc}") from exc


# --------------------------------------------------------------------------
# 限流器
# --------------------------------------------------------------------------

class RateLimiter:
    """最小间隔限流器（时间片轮转，线程安全）。

    qps=10 → 相邻两次请求至少间隔 0.1s。相比"整秒窗口计数"，最小间隔
    不会在窗口边界产生 2 倍突发，对百度 QPS=1 的标准版尤其重要。
    """

    def __init__(self, qps: float):
        self._interval = (1.0 / qps) if qps and qps > 0 else 0.0
        self._lock = threading.Lock()
        self._next_allowed = 0.0

    def wait(self) -> float:
        """阻塞到"本次请求允许发出"的时刻，返回实际等待秒数。"""
        if not self._interval:
            return 0.0
        with self._lock:
            now = time.monotonic()
            delay = self._next_allowed - now
            # 预订下一个时间片（即使本次要等很久，也不让其他线程插队）
            self._next_allowed = max(now, self._next_allowed) + self._interval
        if delay > 0:
            time.sleep(delay)
            return delay
        return 0.0


# --------------------------------------------------------------------------
# 基类
# --------------------------------------------------------------------------

class BaseEngine(ABC):
    """翻译引擎抽象基类。

    子类只需：
        - 实现 translate_batch(texts)：一次 HTTP 往返翻译一批（不重试、不限流）；
        - 可选覆盖 chunk()：自定义批量装箱策略（默认按字符预算装箱）；
        - 可选覆盖 model_tag()：参与缓存键的模型标识（LLM 类引擎返回模型名）。

    批量/重试/限流/降级全部由基类与流水线负责，子类保持纯粹的"单次调用"。
    """

    name: str = "base"                       # 注册名（register_engine 覆盖）

    # 术语处理偏好：False（默认）= 术语由流水线保护为 ⟦N⟧ token（传统 API 路线）；
    # True（LLM 类引擎）= 术语以"对照表指令"注入 prompt，不做 token 保护。
    # 原因：LLM 对大量 ⟦N⟧ 标记的文本经常吞标记/改写标记（GLM-4-Flash 实测），
    # 而术语本身恰恰是 LLM 最擅长按指令处理的部分——token 化反而是负优化。
    prefers_glossary_instructions: bool = False

    def __init__(self, *, retry, qps: float = 0.0, timeout: float = 15.0,
                 batch_char_budget: int = 1500):
        self.retry = retry                   # config.RetryConf
        self.timeout = timeout
        self.batch_char_budget = batch_char_budget
        self._limiter = RateLimiter(qps)
        # 运行统计（流水线汇总用；request_count 含重试，chars_sent 为发送字符量）
        self.request_count: int = 0
        self.failure_count: int = 0
        self.chars_sent: int = 0
        # 语言对由流水线在运行时注入（引擎实例可跨任务复用）
        self.source_lang: str = "en_us"
        self.target_lang: str = "zh_cn"
        # 术语表 hint：仅 prefers_glossary_instructions=True 的引擎使用
        #（流水线在任务开始时注入；传统引擎保持 None，行为完全不变）
        self._glossary = None

    # ------------------------------------------------------------------
    # 语言注入
    # ------------------------------------------------------------------
    def configure_languages(self, source_lang: str, target_lang: str) -> None:
        """流水线在 run() 开始时注入本次任务的语言对。"""
        self.source_lang = source_lang
        self.target_lang = target_lang

    def set_glossary(self, glossary) -> None:
        """注入术语表（仅 LLM 类引擎使用：按批筛选命中项注入 prompt 指令）。

        传统引擎不会被流水线调用本方法；默认实现直接保存引用即可。
        """
        self._glossary = glossary

    def glossary_hints_for(self, texts: list[str]) -> dict[str, str]:
        """筛选本批文本命中的术语（大小写敏感，键必须完整出现）。

        返回 {原文: 译法}；仅含"可安全放入 prompt"的键——
        键里含换行或等号会破坏对照表格式，直接剔除。
        """
        if not self._glossary or not self._glossary.terms:
            return {}
        hints: dict[str, str] = {}
        joined = "\n".join(texts)
        for key, value in self._glossary.terms.items():
            if "\n" in key or "=" in key or "\n" in value:
                continue
            if key in joined:
                hints[key] = value
        return hints

    def model_tag(self) -> str:
        """缓存键中的模型标识；传统翻译 API 无模型概念，返回空串。"""
        return ""

    # ------------------------------------------------------------------
    # 批量装箱
    # ------------------------------------------------------------------
    def chunk(self, texts: Sequence[str]) -> list[list[str]]:
        """按字符预算把待翻译文本装箱为若干批。

        规则：单条超预算的文本独占一批（由子类/服务端决定是否报错）；
        其余按顺序贪心装入，直到加入下一条会超出预算。
        """
        if not texts:
            return []
        budget = max(1, self.batch_char_budget)
        batches: list[list[str]] = []
        current: list[str] = []
        current_len = 0
        for text in texts:
            size = len(text) + 1             # +1：批量分隔符（\n）占位
            if current and current_len + size > budget:
                batches.append(current)
                current, current_len = [], 0
            current.append(text)
            current_len += size
        if current:
            batches.append(current)
        return batches

    # ------------------------------------------------------------------
    # 子类实现的"单次调用"
    # ------------------------------------------------------------------
    @abstractmethod
    def translate_batch(self, texts: list[str]) -> list[str]:
        """翻译一批文本（受保护后的），返回与输入等长的译文列表。

        本方法只做一次 HTTP 往返，不做重试与限流——那是
        translate_batch_with_retry() 的职责。任何失败抛 EngineError 子类。
        """

    # ------------------------------------------------------------------
    # 重试模板（流水线调用入口）
    # ------------------------------------------------------------------
    def translate_batch_with_retry(self, texts: list[str]) -> list[str]:
        """限流 + 指数退避重试地翻译一批文本。

        - RateLimited / EngineError：按 RetryConf 指数退避重试；
        - AuthError / QuotaError：立即上抛（重试无意义）；
        - LLM 类引擎可覆盖本方法实现"整批失败 → 逐条"的自适应策略
          （见 openai_compat.py）。
        """
        self.chars_sent += sum(len(text) for text in texts)
        return self._call_with_retry(lambda: self.translate_batch(texts))

    def _call_with_retry(self, operation: Callable[[], Any], *,
                         what: str = "翻译请求") -> Any:
        """通用重试模板：operation 是一次"单次调用"闭包。"""
        attempt = 0
        while True:
            self._limiter.wait()
            self.request_count += 1
            try:
                return operation()
            except (AuthError, QuotaError):
                self.failure_count += 1
                raise                                  # 不可重试错误直接上抛
            except EngineError as exc:
                self.failure_count += 1
                attempt += 1
                if attempt > self.retry.max_retries:
                    raise EngineError(
                        f"{what}重试 {self.retry.max_retries} 次后仍失败：{exc}"
                    ) from exc
                delay = min(
                    self.retry.initial_delay * (self.retry.backoff_factor ** (attempt - 1)),
                    self.retry.max_delay,
                )
                if self.retry.jitter > 0:
                    delay *= 1.0 + random.uniform(0.0, self.retry.jitter)
                logger.warning("%s 失败（第 %d 次）：%.80s；%.1fs 后重试",
                               what, attempt, exc, delay)
                time.sleep(delay)
