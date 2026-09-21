"""配置中心：config.yaml 加载、默认值、环境变量注入与校验。

配置查找顺序（load_config）：
    1. 显式路径（CLI -c / --config）
    2. 当前工作目录 ./config.yaml
    3. 整合包根目录 <pack_root>/config.yaml
    4. 都不存在 → 全默认配置（primary=demo 引擎，零密钥开箱即用）

YAML 解析：优先 PyYAML（若已安装）；缺失时回退到内置精简解析器
（mc_i18n._mini_yaml）——这是"零第三方强依赖"的关键一环。

环境变量注入（优先级高于配置文件，便于 CI/容器化使用）：
    BAIDU_APP_ID / BAIDU_APP_KEY   → baidu.app_id / baidu.app_key
    DEEPL_API_KEY                  → deepl.api_key
    OPENAI_API_KEY                 → openai.api_key
    YOUDAO_APP_ID / YOUDAO_APP_KEY → youdao.app_id / youdao.app_key
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, fields, is_dataclass
from pathlib import Path
from typing import Any

# --------------------------------------------------------------------------
# 各引擎 / 各子系统配置节
# --------------------------------------------------------------------------


@dataclass
class EngineConf:
    """引擎选择：主引擎 + 降级链（主引擎失败时按序尝试备用引擎）。"""

    primary: str = "demo"        # 默认 demo：无任何密钥即可跑通全流程
    fallback: list[str] = field(default_factory=list)   # 如 ["baidu", "deepl"]


@dataclass
class BaiduConf:
    """百度翻译开放平台（fanyi-api.baidu.com）。

    配额参考（2026-09 官方文档实查）：
        标准版  5 万字符/月，QPS=1，单请求 q ≤ 1000 字符；
        个人认证高级版 100 万字符/月，QPS=10，单请求 ≤ 6000 字符。
        使用高级版时请把 qps 调到 10、batch_char_budget 调到 6000。
    """

    app_id: str = ""
    app_key: str = ""
    endpoint: str = "https://fanyi-api.baidu.com/api/trans/vip/translate"
    qps: float = 1.0                    # 每秒最大请求数（令牌间隔 = 1/qps）
    batch_char_budget: int = 1000       # 单请求字符预算（批量多段 \n 拼接的装箱上限）
    timeout: float = 15.0               # HTTP 超时（秒）


@dataclass
class GoogleConf:
    """谷歌翻译（社区广泛使用的免费 gtx 接口，无需任何密钥）。

    说明：
        - 免费接口非官方保证，偶发 429 限流；引擎内置限流与指数退避；
        - 国内网络环境可能无法直连，可把 endpoint 换成可用的镜像域名；
        - 批量策略：多条文本以 \\n 拼接一次请求，响应按"行数守卫"重组，
          行数不符即抛错降级（绝不静默错位）。
    """

    endpoint: str = "https://translate.googleapis.com/translate_a/single"
    qps: float = 5.0                    # 免费接口保守限流
    batch_char_budget: int = 800        # 单请求字符预算（拼接后的总长）
    timeout: float = 15.0


@dataclass
class YoudaoConf:
    """有道智云文本翻译（官方 API，openapi.youdao.com）。

    配额参考：新用户注册赠送体验金；标准版按量计费，QPS 与并发受
    控制台套餐限制。签名算法 v3：sha256(appKey + input + salt + curtime + 密钥)，
    input 超 20 字符时按官方规则截断（q[:10] + len(q) + q[-10:]）。
    """

    app_id: str = ""                    # 有道智云「应用 ID」
    app_key: str = ""                   # 有道智云「应用密钥」
    endpoint: str = "https://openapi.youdao.com/api"
    qps: float = 1.0
    batch_char_budget: int = 1000       # 官方单请求 q ≤ 5000，保守取 1000
    timeout: float = 15.0


@dataclass
class DeepLConf:
    """DeepL API（api.deepl.com）。

    配额参考：Free 套餐 50 万字符/月；Free 密钥以 ":fx" 结尾，
    请求域名自动切换为 api-free.deepl.com（引擎内置处理）。
    """

    api_key: str = ""
    endpoint: str | None = None         # None → 按 key 后缀自动选择 api / api-free
    batch_char_budget: int = 40000      # DeepL 单请求上限 128KiB，此处留足余量
    timeout: float = 30.0


@dataclass
class OpenAIConf:
    """OpenAI 兼容接口（扩展位示例：OpenAI / DeepSeek / 本地 vLLM 均可接入）。

    工作方式：把一批待翻译文本组装为编号 JSON 交给模型，要求逐条回译；
    模型输出不是合法 JSON 时自动降级为逐条请求（自适应重试）。
    """

    api_key: str = ""
    base_url: str = "https://api.openai.com/v1"
    model: str = "gpt-4o-mini"
    temperature: float = 0.2
    batch_size: int = 20                # 一次请求携带的文本条数
    timeout: float = 90.0
    system_prompt: str = (
        "你是 Minecraft 模组语言文件的机器翻译引擎，把英文文本翻译为简体中文。"
        "硬性规则："
        "1) 文本中的 ⟦数字⟧ 标记（如 ⟦0⟧ ⟦1⟧）是格式占位符（%s、%d、颜色代码、"
        "变量等），必须在译文的合适位置逐字保留——数量不得增减、内容与顺序不得改写、"
        "绝不能删除或翻译它们；"
        "1a) 连续出现的标记（如 ⟦0⟧⟦1⟧⟦2⟧⟦3⟧，通常是连续颜色代码）必须逐个原样"
        "输出，看起来重复也不得合并或省略任何一个——这是最高优先级要求；"
        "2) 末尾【术语对照表】中列出的英文术语必须使用等号右侧的固定中文译法；"
        "3) 译文必须符合 Minecraft 简体中文社区的行文习惯；"
        "4) 只输出 JSON 对象，键为原文编号、值为译文，不要任何解释或代码围栏。"
        "示例 1：输入 {\"0\": \"Use ⟦0⟧ to tame an Enderman⟦1⟧\"}，"
        "术语表含 Enderman=末影人，"
        "输出 {\"0\": \"使用⟦0⟧驯服末影人⟦1⟧\"}——⟦0⟧⟦1⟧ 原样保留，术语按表翻译。"
        "示例 2（连续标记逐个保留）：输入 {\"0\": \"⟦0⟧⟦1⟧⟦2⟧Golden Apples⟦3⟧\"}，"
        "输出 {\"0\": \"⟦0⟧⟦1⟧⟦2⟧金苹果⟦3⟧\"}——四个标记一个不少。"
    )


@dataclass
class RetryConf:
    """指数退避重试（对限流 / 网络错误 / 5xx 生效；鉴权与配额错误不重试）。"""

    max_retries: int = 3                # 单请求最大重试次数
    initial_delay: float = 1.0          # 首次重试延迟（秒）
    backoff_factor: float = 2.0         # 延迟倍率：delay = initial * factor^(n-1)
    max_delay: float = 30.0             # 单次延迟上限
    jitter: float = 0.3                 # 随机抖动比例（0~1），防止整点重试风暴


@dataclass
class ProtectConf:
    """占位符保护引擎开关（见 core/placeholders.py）。

    默认只开启 MC 场景高频占位符；& 颜色码与 XML 标签在普通文本中
    存在误伤可能（如 "Tom & Jerry"），需要时手动打开。
    """

    amp_color_codes: bool = False       # &a/&c 等 & 颜色码（部分旧版插件/整合包使用）
    percent_variables: bool = True      # %player% / %target% 等百分比变量
    xml_tags: bool = False              # <b></b> 等 XML 标签（ quests 书籍类内容常见）
    brace_placeholders: bool = True     # {0} / {name} 花括号占位符
    dollar_braces: bool = True          # ${player} 美元花括号变量
    escape_sequences: bool = True       # \n \t \" \\ \u00a7 转义序列
    out_of_order: str = "auto"          # 占位符乱序容忍：auto | always | never
    # v0.3.5 新增：引擎把 ⟦N⟧ 标记整个吞掉时的兜底策略。
    #   strict  = 无法建立映射即抛错，走 重试 → 备用引擎 → 保留原文 降级链（默认，行为同 v0.3.4）
    #   salvage = 尽力回填（缺失占位符按原文次序补到句末）并计入人工复核，
    #             宁可语序生硬也不让条目退回英文，适合"汉化率优先"的整合包
    missing_token_policy: str = "strict"


@dataclass
class CacheConf:
    """翻译缓存（SQLite）。断点续翻天然实现：重启后已译键全部命中缓存。"""

    enabled: bool = True
    path: str | None = None             # None → <整合包>/.mc-i18n/cache.sqlite3
    ttl_days: int = 0                   # 缓存有效期天数；0 = 永久


@dataclass
class LogConf:
    """日志：控制台打印级别 + 文件记录级别（写入 <整合包>/.mc-i18n/logs/）。"""

    console_level: str = "INFO"
    file_level: str = "DEBUG"


@dataclass
class AppConfig:
    """应用总配置（config.yaml 的内存形态）。"""

    engine: EngineConf = field(default_factory=EngineConf)
    baidu: BaiduConf = field(default_factory=BaiduConf)
    deepl: DeepLConf = field(default_factory=DeepLConf)
    openai: OpenAIConf = field(default_factory=OpenAIConf)
    google: GoogleConf = field(default_factory=GoogleConf)
    youdao: YoudaoConf = field(default_factory=YoudaoConf)
    retry: RetryConf = field(default_factory=RetryConf)
    protect: ProtectConf = field(default_factory=ProtectConf)
    cache: CacheConf = field(default_factory=CacheConf)
    log: LogConf = field(default_factory=LogConf)
    workers: int = 4                    # 翻译并发线程数
    source_lang: str = "en_us"          # 源语言（可被 CLI 覆盖）
    target_lang: str = "zh_cn"          # 目标语言（可被 CLI 覆盖）

    def validate(self) -> list[str]:
        """校验配置一致性，返回错误列表（空列表 = 配置可用）。"""
        errors: list[str] = []
        if self.workers < 1:
            errors.append("workers 必须 ≥ 1")
        if self.engine.primary == "baidu" and not (self.baidu.app_id and self.baidu.app_key):
            errors.append(
                "主引擎为 baidu 但缺少密钥：请在 config.yaml 填写 baidu.app_id/app_key，"
                "或设置环境变量 BAIDU_APP_ID / BAIDU_APP_KEY"
            )
        if self.engine.primary == "deepl" and not self.deepl.api_key:
            errors.append(
                "主引擎为 deepl 但缺少密钥：请填写 deepl.api_key 或设置环境变量 DEEPL_API_KEY"
            )
        if self.engine.primary == "openai" and not self.openai.api_key:
            errors.append(
                "主引擎为 openai 但缺少密钥：请填写 openai.api_key 或设置环境变量 OPENAI_API_KEY"
            )
        if self.engine.primary == "youdao" and not (self.youdao.app_id and self.youdao.app_key):
            errors.append(
                "主引擎为 youdao 但缺少密钥：请在 config.yaml 填写 youdao.app_id/app_key，"
                "或设置环境变量 YOUDAO_APP_ID / YOUDAO_APP_KEY"
            )
        _KNOWN_ENGINES = ("demo", "baidu", "deepl", "openai", "openai_compat",
                          "google", "youdao")
        for name in self.engine.fallback:
            if name not in _KNOWN_ENGINES:
                errors.append(f"engine.fallback 中包含未知引擎 {name!r}"
                              f"（可用：{'/'.join(_KNOWN_ENGINES)}）")
        if self.protect.out_of_order not in ("auto", "always", "never"):
            errors.append("protect.out_of_order 只能是 auto / always / never")
        if self.protect.missing_token_policy not in ("strict", "salvage"):
            errors.append("protect.missing_token_policy 只能是 strict / salvage")
        return errors


# --------------------------------------------------------------------------
# 配置加载
# --------------------------------------------------------------------------

@dataclass
class ConfigResult:
    """加载结果容器：配置对象 + 实际使用的文件 + 非致命告警。"""

    config: AppConfig
    path: Path | None            # None 表示未找到配置文件（全默认）
    warnings: list[str] = field(default_factory=list)


#: 各配置节 → 对应 dataclass 的映射（dict → dataclass 递归构建用）
_SECTION_TYPES: dict[str, Any] = {
    "engine": EngineConf,
    "baidu": BaiduConf,
    "deepl": DeepLConf,
    "openai": OpenAIConf,
    "google": GoogleConf,
    "youdao": YoudaoConf,
    "retry": RetryConf,
    "protect": ProtectConf,
    "cache": CacheConf,
    "log": LogConf,
}


def load_yaml_dict(text: str) -> dict:
    """YAML 文本 → dict；PyYAML 可用则优先，否则回退内置精简解析器。"""
    try:
        import yaml  # type: ignore  # 可选依赖
        data = yaml.safe_load(text)
        if data is None:
            return {}
        if not isinstance(data, dict):
            raise ValueError("config.yaml 顶层必须是映射结构")
        return data
    except ImportError:
        from ._mini_yaml import parse as mini_parse
        return mini_parse(text)


def _build_section(section_type: Any, data: Any, section_name: str, warnings: list[str]) -> Any:
    """把配置节的 dict 增量合并到 dataclass 默认实例上（未知键告警）。"""
    instance = section_type()
    if data is None:
        return instance
    if not isinstance(data, dict):
        warnings.append(f"配置节 [{section_name}] 应为映射，已忽略该节内容（实际类型 {type(data).__name__}）")
        return instance
    known = {f.name for f in fields(section_type)}
    for key, value in data.items():
        if key not in known:
            warnings.append(f"配置节 [{section_name}] 中存在未知键 {key!r}，已忽略")
            continue
        current = getattr(instance, key)
        # 嵌套 dataclass（当前配置无此层级，预留扩展）递归构建
        if is_dataclass(current) and isinstance(value, dict):
            value = _build_section(type(current), value, f"{section_name}.{key}", warnings)
        setattr(instance, key, value)
    return instance


def _inject_env(app: AppConfig) -> list[str]:
    """环境变量注入：环境变量存在且非空时覆盖配置文件值（CI/容器友好）。"""
    hints: list[str] = []
    pairs = (
        ("BAIDU_APP_ID", app.baidu, "app_id"),
        ("BAIDU_APP_KEY", app.baidu, "app_key"),
        ("DEEPL_API_KEY", app.deepl, "api_key"),
        ("OPENAI_API_KEY", app.openai, "api_key"),
        ("YOUDAO_APP_ID", app.youdao, "app_id"),
        ("YOUDAO_APP_KEY", app.youdao, "app_key"),
    )
    for env_name, section, attr in pairs:
        env_value = os.environ.get(env_name, "").strip()
        if env_value:
            setattr(section, attr, env_value)
            hints.append(f"{env_name} → {type(section).__name__}.{attr}")
    return hints


def find_config_file(explicit: str | Path | None = None,
                     pack_root: str | Path | None = None) -> Path | None:
    """按查找顺序定位 config.yaml；找不到返回 None。"""
    if explicit:
        p = Path(explicit)
        if not p.is_file():
            raise FileNotFoundError(f"指定的配置文件不存在：{p}")
        return p
    cwd_candidate = Path.cwd() / "config.yaml"
    if cwd_candidate.is_file():
        return cwd_candidate
    if pack_root:
        pack_candidate = Path(pack_root) / "config.yaml"
        if pack_candidate.is_file():
            return pack_candidate
    return None


def load_config(explicit: str | Path | None = None,
                pack_root: str | Path | None = None) -> ConfigResult:
    """加载配置：文件 → dict → AppConfig → 环境变量注入。

    任何一步失败都不抛异常中断流程：文件解析失败时降级为默认配置并记录告警，
    保证"单文件失败不中断整体任务"的全链路纪律同样适用于配置层。
    """
    warnings: list[str] = []
    path = find_config_file(explicit, pack_root)

    app = AppConfig()
    if path is not None:
        try:
            data = load_yaml_dict(path.read_text(encoding="utf-8-sig"))
            for section_name, section_type in _SECTION_TYPES.items():
                setattr(app, section_name,
                        _build_section(section_type, data.pop(section_name, None),
                                       section_name, warnings))
            # 顶层标量键（engine 之外的通用设置）
            for key in ("workers", "source_lang", "target_lang"):
                if key in data:
                    setattr(app, key, data.pop(key))
            for key in data:
                warnings.append(f"配置文件中存在未知顶层键 {key!r}，已忽略")
        except Exception as exc:  # noqa: BLE001 —— 配置损坏降级为默认
            warnings.append(f"配置文件 {path} 解析失败（{type(exc).__name__}: {exc}），已使用默认配置")
            app = AppConfig()

    env_hints = _inject_env(app)
    if env_hints:
        warnings.append("已从环境变量注入密钥：" + ", ".join(env_hints))

    return ConfigResult(config=app, path=path, warnings=warnings)
