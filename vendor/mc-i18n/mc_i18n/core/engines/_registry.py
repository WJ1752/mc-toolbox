"""引擎注册表（插件式扩展点，对应技术设计方案 §1 可扩展性）。

自定义引擎三步接入：
    1. 新建 my_engine.py，实现 BaseEngine 子类；
    2. 类定义前加 @register_engine("my")；
    3. config.yaml 中 engine.primary: my。

注册表独立成模块（而非放在包 __init__），避免子模块 import
注册表时形成循环导入。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Callable, Type

if TYPE_CHECKING:  # 仅供类型标注，避免运行时循环导入
    from .base import BaseEngine

ENGINE_REGISTRY: dict[str, Type["BaseEngine"]] = {}


def register_engine(name: str) -> Callable[[Type["BaseEngine"]], Type["BaseEngine"]]:
    """引擎注册装饰器：@register_engine("baidu")。"""
    def decorator(cls: Type["BaseEngine"]) -> Type["BaseEngine"]:
        cls.name = name
        ENGINE_REGISTRY[name] = cls
        return cls
    return decorator


def available_engines() -> list[str]:
    """当前已注册的引擎名（排序后返回，CLI 提示用）。"""
    return sorted(ENGINE_REGISTRY)
