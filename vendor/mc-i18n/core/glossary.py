"""术语表模块（GUI 五页之一 —— 术语表页的底层引擎）。

解决的问题：机器翻译对 MC 社区通用译名完全不可控 ——
Enderman 可能被译成"终界使者/幽匿人"，Nether 可能变成"地狱/冥界"。
同一整合包里前后不一致，玩家体验极差。

工作方式（与占位符引擎无缝协作的两段式保护）：

    1. 翻译前：术语原文列表传给 PlaceholderGuard.protect(text, literal_terms)
       → 术语被替换为 ⟦N⟧ token，引擎完全接触不到术语文本；
    2. 翻译后：restore 把 token 回填为术语**原文**；
    3. apply_after_restore：把原文替换为统一译法（一次扫描、长词优先、
       已替换内容不会被二次匹配 —— 避免 "Java Edition→Java版" 中的
       "Java" 又被 "Java→爪哇" 之类规则误伤）。

术语表文件格式（<整合包>/glossary.yaml，与 config.yaml 同目录约定）：

    glossary:
      Enderman: 末影人
      Netherite: 下界合金
      "Redstone Dust": 红石粉     # 带空格的键加引号

无术语表文件 = 空表 = 完全不影响翻译行为（零配置可用性不变）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from .._mini_yaml import dumps_yaml_mapping  # 复用零依赖 YAML 生态
from ..config import load_yaml_dict
from .glossary_presets import DEFAULT_TERMS
from .placeholders import term_pattern_source


@dataclass
class Glossary:
    """术语表：{原文: 统一译法} 的内存形态与读写方法。

    terms 在构造后视为只读（webui 每次保存都构造新实例），
    apply_after_restore 依赖这一点缓存编译后的替换正则。
    """

    terms: dict[str, str] = field(default_factory=dict)

    # 编译缓存：替换正则只编译一次（此前每条文本都重新编译，
    # 内置大表 ~250 条加入后开销不可忽略 —— 这里顺手修掉）
    _pattern_cache: re.Pattern | None = field(
        default=None, init=False, repr=False, compare=False
    )

    # ------------------------------------------------------------------
    # 加载与保存
    # ------------------------------------------------------------------
    @classmethod
    def load(cls, path: Path) -> "Glossary":
        """从 glossary.yaml 加载；文件不存在/为空/损坏时返回空表（不抛异常）。"""
        if not path.is_file():
            return cls()
        try:
            # load_yaml_dict 接收 YAML 文本（str），文件按 UTF-8 读入
            data = load_yaml_dict(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 - 损坏的术语表不应中断整个翻译任务
            return cls()
        raw = data.get("glossary") if isinstance(data, dict) else None
        if not isinstance(raw, dict):
            return cls()
        terms: dict[str, str] = {}
        for key, value in raw.items():
            key_s, value_s = str(key).strip(), str(value).strip()
            if key_s and value_s and key_s != value_s:  # 原译相同的条目无意义，静默丢弃
                terms[key_s] = value_s
        return cls(terms=terms)

    def save(self, path: Path) -> None:
        """写回 glossary.yaml（设置页/术语表页的保存按钮调用）。"""
        path.parent.mkdir(parents=True, exist_ok=True)
        body = dumps_yaml_mapping({"glossary": self.terms})
        header = "# mc-i18n 术语表：左侧原文 → 右侧统一译法\n"
        header += "# 规则：翻译时术语原文会被整体保护，译文回填右侧译法\n"
        path.write_text(header + body, encoding="utf-8")

    # ------------------------------------------------------------------
    # 与翻译流程协作
    # ------------------------------------------------------------------
    def with_defaults(self) -> "Glossary":
        """合并内置 MC 标准术语表，返回新实例（自身不变）。

        分层规则：内置默认表打底，用户 glossary.yaml 同名键覆盖——
        用户对默认译名不满意时（比如坚持把 Creeper 叫"爬行者"），
        只需在术语表页写一条同名条目即可改写。
        """
        merged = dict(DEFAULT_TERMS)
        merged.update(self.terms)
        return Glossary(terms=merged)

    def literal_terms(self) -> list[str]:
        """提供 protect() 用的字面量列表（原文键）。"""
        return list(self.terms.keys())

    def _replacement_pattern(self) -> re.Pattern:
        """构建（并缓存）原文替换正则：长词优先 + ASCII 词边界。

        词边界与 protect 阶段（term_pattern_source）保持同一规则，
        确保两阶段对"哪些片段算术语"的判定完全一致：
        - 不截断复合词："RedstoneCraft" 中的 "Redstone" 不被替换；
        - 中文邻接正常替换："击杀Enderman后" → "击杀末影人后"。
        """
        if self._pattern_cache is None:
            self._pattern_cache = re.compile(
                "|".join(
                    term_pattern_source(t)
                    for t in sorted(self.terms, key=len, reverse=True)
                )
            )
        return self._pattern_cache

    def apply_after_restore(self, text: str) -> str:
        """restore 回填术语原文之后调用：原文 → 统一译法。

        单条正则一次扫描完成替换：
        - 长词优先（Netherite 先于 Nether）；
        - re.sub 从上次匹配结束处继续，替换结果不会被后续规则二次扫描；
        - 词边界防止复合词误伤（见 _replacement_pattern）。
        """
        if not self.terms:
            return text
        return self._replacement_pattern().sub(lambda m: self.terms[m.group(0)], text)

    def __len__(self) -> int:
        return len(self.terms)
