"""演示引擎——零密钥开箱即用的内置翻译引擎。

作用：
    1. 用户无任何 API 密钥也能跑通"扫描 → 翻译 → 导出 → 打包"全链路，
       直观验证工具行为（README 快速开始的第一条命令）；
    2. 流水线与导出的天然测试桩：输出 = "【机翻·演示】" + 原文，
       原样返回受保护文本 → 占位符 token 100% 保留，还原能力不构成干扰；
    3. 集成测试与 CI 的确定性依赖（真实 API 有配额与网络不确定性）。

正式汉化请切换到 baidu / deepl / openai 等真实引擎。
"""

from __future__ import annotations

from ...config import AppConfig
from ._registry import register_engine
from .base import BaseEngine

#: 演示译文前缀（醒目、可一键全局搜索替换为人工译文）
DEMO_PREFIX = "【机翻·演示】"


@register_engine("demo")
class DemoEngine(BaseEngine):
    """演示引擎：输出前缀 + 原文（延迟可选，模拟真实网络便于观察并发行为）。"""

    name = "demo"

    def __init__(self, app: AppConfig):
        super().__init__(retry=app.retry, qps=0.0, timeout=5.0, batch_char_budget=10**6)
        self.latency = 0.0    # 每批模拟延迟秒数（默认 0；集成测试可设小值观察限流）

    def model_tag(self) -> str:
        return "demo"

    def translate_batch(self, texts: list[str]) -> list[str]:
        if self.latency > 0:
            import time
            time.sleep(self.latency)
        # 原样携带占位符 token 返回：⟦N⟧ 不动 → 还原阶段必然零偏差
        return [f"{DEMO_PREFIX}{text}" for text in texts]
