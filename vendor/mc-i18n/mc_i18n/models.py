"""数据模型定义（对应技术设计方案 §3.2）。

本模块集中定义全流程共享的数据结构：
    - LangEntry      ：一条可翻译的语言条目（最小操作单元）
    - LangFile       ：一个语言文件的解析结果（含无损重建所需的骨架信息）
    - JsonStyle      ：.json 文件的格式风格快照（缩进/压缩/转义/换行）
    - LangFileRef    ：一个语言文件的"引用"（扫描产物，写入 manifest）
    - ScanStats / ScanReport ：一次扫描的统计与总报告

设计原则：
    所有模型均为纯数据容器（dataclass），不包含 IO 与业务逻辑，
    便于单元测试与后续切换 pydantic 做配置校验（M2 阶段）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class EntryStatus(str, Enum):
    """单条语言条目的生命周期状态（对应 PRD F10 校对工作流）。

    MVP 第一阶段仅使用 UNTRANSLATED；其余状态在 M1 翻译流水线中启用。
    """

    UNTRANSLATED = "untranslated"    # 未翻译
    MACHINE = "machine_translated"   # 机翻完成，待人工校对
    REVIEWED = "human_reviewed"      # 人工已校对
    APPROVED = "approved"            # 已审定，导出优先采用
    NEEDS_HUMAN = "needs_human"      # 占位符校验失败等，必须人工介入


class FileFormat(str, Enum):
    """支持的语言文件格式。"""

    LANG = "lang"    # MC 1.7.10 ~ 1.12.2 的 key=value 行结构文件
    JSON = "json"    # MC 1.13+ 的 JSON 语言文件


class LangStyle(str, Enum):
    """语言代码命名风格，决定导出时的文件命名方式。

    - MODERN：1.13+ 全小写，如 en_us.json / zh_cn.json
    - LEGACY：1.12.2- 大小写混合，如 en_US.lang / zh_CN.lang
    """

    MODERN = "modern"
    LEGACY = "legacy"


@dataclass
class LangEntry:
    """一条语言条目。

    字段说明：
        key          规范化后的语言键（strip 处理），如 "block.furnace.name"
        raw_key      '=' 之前的原始文本（保留原样，序列化时原样回放）
        raw_value    '=' 之后的原始值文本；.lang 续行条目为合并后的逻辑值
        value        去除首尾空白后的值（MC 1.7.10 Locale 行为：key/value 均做 trim）
        line_start/line_end
                     该条目占用的物理行号区间（0 起，闭区间）；
                     未修改时序列化按区间原样回放，保证字节级还原
        continuation 是否为 '\' 续行条目（多条物理行合并为一条逻辑条目）
        status       校对状态机状态（MVP 阶段恒为 UNTRANSLATED）
    """

    key: str
    raw_key: str = ""
    raw_value: str = ""
    value: str = ""
    line_start: int = -1
    line_end: int = -1
    continuation: bool = False
    status: EntryStatus = EntryStatus.UNTRANSLATED


@dataclass
class JsonStyle:
    """.json 文件的格式风格快照——序列化时据此复现原文件排版。

    字段说明：
        indent           缩进单元字符串（"  " / "    " / "\t"）；None 表示无缩进
        minified         是否为压缩单行格式（jar 内原版文件即此格式）
        ensure_ascii     原文件是否使用 \\uXXXX 转义非 ASCII 字符
        trailing_newline 文件是否以换行符结尾
        crlf             是否使用 CRLF（\r\n）换行（Windows 编辑器常见）
    """

    indent: Optional[str] = None
    minified: bool = False
    ensure_ascii: bool = False
    trailing_newline: bool = False
    crlf: bool = False


@dataclass
class LangFile:
    """一个语言文件的完整解析结果。

    .lang 文件使用：
        lines      物理行列表（splitlines(keepends=True)，保留行尾换行符）
        segments   序列化骨架：("raw", 行内容) 或 ("entry", 语言键)，
                   未修改场景按骨架逐段回放即可字节级还原原文件

    .json 文件使用：
        obj            解析后的完整对象（保持键的插入顺序）
        style          格式风格快照
        duplicate_keys 重复键列表（与 Gson 行为一致：保留首次位置、后值覆盖）
        non_string_keys 值不是字符串的键（原样保留、不参与翻译）

    通用：
        entries   可翻译条目表 {语言键: LangEntry}
        warnings  解析过程中的非致命告警
    """

    fmt: FileFormat
    entries: dict[str, LangEntry] = field(default_factory=dict)
    # ---------- .lang 专用 ----------
    lines: list[str] = field(default_factory=list)
    segments: list[tuple] = field(default_factory=list)
    # ---------- .json 专用 ----------
    obj: dict[str, Any] = field(default_factory=dict)
    style: Optional[JsonStyle] = None
    duplicate_keys: list[str] = field(default_factory=list)
    non_string_keys: list[str] = field(default_factory=list)
    # ---------- 通用 ----------
    warnings: list[str] = field(default_factory=list)


@dataclass
class LangFileRef:
    """一个语言文件的引用（扫描器产物，对应技术设计方案 models.LangFileRef）。

    核心字段：
        path_in_pkg   在整合包内的相对路径（POSIX 风格）；
                      jar 内文件记为 "<jar相对路径>!<zip内路径>"
        container     所在容器文件（jar/zip）的相对路径；散装文件为 None
        relative_dir  该文件所在目录的相对路径（路径映射表的"相对目录"字段）
        export_relative_path
                      导出时的目标相对路径，即把语言代码替换为
                      目标语言后的路径（例如 en_us.json → zh_cn.json；
                      legacy 风格 en_US.lang → zh_CN.lang）。
                      jar 内文件的导出路径为其 zip 内路径。
    """

    path_in_pkg: str
    container: Optional[str] = None
    relative_dir: str = ""
    mod_id: Optional[str] = None
    fmt: FileFormat = FileFormat.JSON
    lang_code: Optional[str] = None
    lang_style: Optional[LangStyle] = None
    encoding: str = "utf-8"
    had_bom: bool = False
    sha256: str = ""
    size: int = 0
    entry_count: int = 0
    is_source_candidate: bool = False
    is_target_existing: bool = False
    detected_by: str = "path"        # path=路径规则识别 | content=内容规则识别
    parse_status: str = "ok"         # ok | error | skipped_too_large
    export_relative_path: str = ""
    warnings: list[str] = field(default_factory=list)


@dataclass
class ScanStats:
    """一次扫描的统计信息。"""

    language_files: int = 0          # 识别出的语言文件总数（含目标语言现存文件）
    source_candidates: int = 0       # 待翻译候选文件数（源语言匹配，如 en_us）
    jars_scanned: int = 0            # 扫描的 jar 容器数量
    json_skipped: int = 0            # 被判定为"非语言文件"而跳过的 .json 数量
    too_large_skipped: int = 0       # 因超过大小上限而跳过解析的文件数
    parse_errors: int = 0            # 解析失败的文件数
    total_entries: int = 0           # 候选文件的可翻译条目总数
    by_fmt: dict[str, int] = field(default_factory=dict)   # 按格式统计
    by_mod: dict[str, int] = field(default_factory=dict)   # 按模组统计


@dataclass
class ScanReport:
    """一次整合包扫描的总报告（scan 命令的返回值）。"""

    pack_root: str = ""
    pack_type: str = "plain"         # plain | curseforge | modrinth
    source_lang: str = "en_us"
    target_lang: str = "zh_cn"
    files: list[LangFileRef] = field(default_factory=list)
    stats: ScanStats = field(default_factory=ScanStats)
    warnings: list[str] = field(default_factory=list)
    duration_sec: float = 0.0
