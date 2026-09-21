"""WebUI 运行期状态 —— 任务槽、上传索引与校对台缓存（v0.3.0 框架拆分）。

本模块只承载"服务运行期间会变化的状态"，不包含任何业务逻辑：

    - _Job              单个后台任务的描述与进度快照（含 v0.3.8 实时译文流/ETA）
    - _GuiState         全局唯一任务槽（同一时刻只允许一个任务，线程安全）
    - _JobLogHandler    把 mc_i18n 命名空间日志实时注入任务对象
    - _STATE            模块级单例任务槽（兼容旧 ``mc_i18n.webui._STATE`` 访问）
    - _UPLOAD_CACHE     拖拽上传产生的临时包索引（upload_id -> LoadedPack）
    - _index_cache      校对台"译文文件 -> 源文件引用"映射的 TTL 缓存

线程模型：
    - _GuiState 内部用 Lock 保护任务槽的读写；任务本身跑在 daemon 线程；
    - _index_cache / _UPLOAD_CACHE 依赖 ThreadingHTTPServer 的 GIL 原子操作
      （dict 单键读写无需加锁；清空动作只在任务开始/结束时发生一次）。
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from collections import deque

from ..core.pack_loader import LoadedPack

# -------------------------------------------------------------------------- #
# v0.3.8 实时译文流 / ETA 相关的有界参数
# -------------------------------------------------------------------------- #
# 任务对象里最多保留多少条已产出译文（服务端侧滚动窗口）。
# 前端按 seq 游标增量拉取，游标推进正常时这个上限只决定"最多能回溯多久"；
# 若一次轮询间隔内产出条目超过上限，最老的会被挤掉（观感问题，不影响产物）。
_RECENT_MAX = 300

# 前端**不传** since 游标时（例如首次加载 / 其它调用方）下发多少条尾部样本。
_RECENT_FALLBACK_SEND = 40


# -------------------------------------------------------------------------- #
# 后台任务状态（线程安全；同一时刻只允许一个任务）
# -------------------------------------------------------------------------- #
class _Job:
    def __init__(self, kind: str, label: str):
        self.id = uuid.uuid4().hex[:8]
        self.kind = kind
        self.label = label
        self.status = "running"            # running | done | error
        self.progress = 0.0
        self.message = label
        self.logs: list[str] = []
        self.started = time.time()
        self.finished: float | None = None
        self.summary: dict = {}
        # ---- v0.3.8：实时译文流与预计用时 ----
        self.stage = ""                    # 当前阶段：scan/collect/translate/export
        self.done_units = 0                # 当前阶段已完成单位数（条/文件）
        self.total_units = 0               # 当前阶段总单位数
        self.rate: float | None = None     # 当前阶段速率（单位/秒）
        self.eta_sec: float | None = None  # 当前阶段预计剩余秒数
        self.eta_total_sec: float | None = None   # 全任务预计剩余秒数（含收尾预留）
        self.entry_seq = 0                 # 累计进入译文流的条目数（单调递增游标）
        self.recent: deque[dict] = deque(maxlen=_RECENT_MAX)

    # -- 译文流 -------------------------------------------------------- #
    def push_entry(self, entry: dict) -> None:
        """把一条译文追加进滚动窗口（带单调 seq，供前端增量拉取）。

        只在流水线主线程调用（见 pipeline 的 emit 契约），故无需额外加锁；
        deque.append 本身在 CPython 下亦是原子的，即使误从 worker 调用也不会撕裂。
        """
        self.entry_seq += 1
        entry = dict(entry)
        entry["seq"] = self.entry_seq
        self.recent.append(entry)

    def to_dict(self, since: int = 0) -> dict:
        if since > 0:
            entries = [e for e in self.recent if e.get("seq", 0) > since]
        else:
            entries = list(self.recent)[-_RECENT_FALLBACK_SEND:]
        return {
            "id": self.id, "kind": self.kind, "label": self.label,
            "status": self.status, "progress": round(self.progress, 1),
            "message": self.message,
            "logs": self.logs[-200:],       # 前端只展示最近 200 行
            "elapsed": round((self.finished or time.time()) - self.started, 1),
            "summary": self.summary,
            # v0.3.8
            "stage": self.stage,
            "units": {"done": self.done_units, "total": self.total_units},
            "rate": (round(self.rate, 2) if self.rate else None),
            "eta_sec": (round(self.eta_sec, 1) if self.eta_sec is not None else None),
            "eta_total_sec": (round(self.eta_total_sec, 1)
                              if self.eta_total_sec is not None else None),
            "entry_seq": self.entry_seq,
            "recent": entries,
        }


class _GuiState:
    """全局唯一任务槽：GUI 简单化，同一时刻只跑一个翻译任务。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._job: _Job | None = None
        self.cancel_requested = False    # "停止"按钮 → 管线 cancel_check 探针

    def request_cancel(self) -> tuple[bool, str]:
        """请求停止当前任务。返回 (是否受理, 提示)。"""
        with self._lock:
            running = self._job is not None and self._job.status == "running"
        if not running:
            return False, "当前没有正在运行的任务"
        self.cancel_requested = True
        return True, ("停止请求已发出：等待当前批次完成（几秒内），"
                      "已翻译的部分会照常导出；重新开始可自动续翻")

    def start(self, kind: str, label: str, fn) -> tuple[bool, str, dict | None]:
        with self._lock:
            if self._job is not None and self._job.status == "running":
                return False, "已有任务在运行，请等待完成或稍后再试", None
            self.cancel_requested = False    # 新任务开始前清除上次的停止请求
            job = _Job(kind, label)
            self._job = job

        def _runner():
            handler = _JobLogHandler(job)
            log_root = logging.getLogger("mc_i18n")
            log_root.addHandler(handler)
            try:
                summary = fn(job) or {}
                job.summary = summary
                job.status = "done"
                job.progress = 100.0
                job.message = f"{label} 完成"
            except Exception as exc:  # noqa: BLE001 - 任务失败信息要完整回传前端
                job.status = "error"
                job.summary = {"error": f"{type(exc).__name__}: {exc}"}
                job.message = f"{label} 失败：{exc}"
                job.logs.append(f"[错误] {type(exc).__name__}: {exc}")
            finally:
                job.finished = time.time()
                log_root.removeHandler(handler)

        threading.Thread(target=_runner, name=f"webui-{kind}", daemon=True).start()
        return True, job.id, job.to_dict()

    def snapshot(self, since: int = 0) -> dict | None:
        """任务快照。``since`` 为译文流游标（v0.3.8）：

        传 0（默认）→ 返回尾部若干条样本，兼容既有调用方；
        传上次收到的最大 seq → 只返回其后的新条目，轮询载荷与实际产出成正比。
        """
        with self._lock:
            return self._job.to_dict(since=since) if self._job else None


class _JobLogHandler(logging.Handler):
    """把 mc_i18n 的日志实时注入任务对象（前端轮询可见）。"""

    def __init__(self, job: _Job):
        super().__init__(logging.INFO)
        self._job = job

    def emit(self, record: logging.LogRecord):
        try:
            self._job.logs.append(record.getMessage())
        except Exception:  # noqa: BLE001 - 日志收集失败绝不影响任务本身
            pass


_STATE = _GuiState()


# -------------------------------------------------------------------------- #
# 拖拽上传产生的临时包索引：upload_id -> LoadedPack
# 上传文件在扫描/翻译期间保持有效；服务端退出前统一清理。
# -------------------------------------------------------------------------- #
_UPLOAD_CACHE: dict[str, LoadedPack] = {}


# -------------------------------------------------------------------------- #
# 校对台数据链：实时扫描重建 [译文相对路径 -> 源文件引用] 映射的 TTL 缓存
# （翻译流程不落盘 manifest.json，校对台自己按 disk_path_for_ref 公式换算，
#   结果带 TTL 缓存——避免前端"文件清单 + 条目对照"两次请求重复扫描）
# -------------------------------------------------------------------------- #
_index_cache: dict[str, tuple[float, dict]] = {}
_INDEX_TTL = 60.0          # 缓存有效期（秒）；翻译任务结束后主动清空
