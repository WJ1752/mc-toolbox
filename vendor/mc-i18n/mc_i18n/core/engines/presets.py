"""AI 翻译服务商预设（一键填充 base_url 与模型名，参考主流汉化工具的体验）。

用户只需在「设置 → OpenAI 兼容接口」点选服务商按钮，即可自动填好
API 地址与推荐模型，再补一个对应的 API Key 就能用大模型翻译。

所有服务商都走 OpenAI Chat Completions 兼容协议（openai 引擎），
预设只是"地址 + 模型名"的快捷方式，不引入任何新协议代码。
"""

from __future__ import annotations

# 键 → 前端展示信息；model 为该服务商当前性价比/免费档的推荐型号。
# 后续服务商调整模型名时，只需改这张表。
AI_PRESETS: dict[str, dict[str, str]] = {
    "zhipu": {
        "label": "智谱 GLM-4-Flash（免费）",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "model": "glm-4-flash",
        "key_url": "https://open.bigmodel.cn/usercenter/apikeys",
    },
    "deepseek": {
        "label": "DeepSeek",
        "base_url": "https://api.deepseek.com/v1",
        "model": "deepseek-chat",
        "key_url": "https://platform.deepseek.com/api_keys",
    },
    "qwen": {
        "label": "阿里通义",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "model": "qwen-turbo",
        "key_url": "https://bailian.console.aliyun.com/",
    },
    "kimi": {
        "label": "Kimi（月之暗面）",
        "base_url": "https://api.moonshot.cn/v1",
        "model": "moonshot-v1-8k",
        "key_url": "https://platform.moonshot.cn/console/api-keys",
    },
}


def preset_dict() -> dict[str, dict[str, str]]:
    """给前端 /api/presets 的安全副本（只暴露展示所需字段）。"""
    return {k: dict(v) for k, v in AI_PRESETS.items()}
