"""mc-i18n 可执行文件打包入口（供 PyInstaller 使用）。

为什么需要独立入口？
- ``python -m mc_i18n`` 依赖包的搜索路径，而 PyInstaller 打包后没有
  "当前目录的 mc_i18n 包"，需要一个顶层脚本直接 import 包并调用 main()。
- Windows 下 PyInstaller onefile 模式 + 多进程（本项目线程池不需要，
  但 freeze_support 是打包程序的标准保险丝，防止意外派生子进程时
  无限递归拉起自身）必须在入口最顶端调用。

打包方式（Windows）：
    build_windows.bat            # 一键构建，产物 dist/mc-i18n.exe
或手动：
    pip install pyinstaller
    pyinstaller mc-i18n.spec --noconfirm --clean
"""
import multiprocessing
import sys

# freeze_support() 必须在任何其他代码之前调用（PyInstaller 官方要求）
multiprocessing.freeze_support()

# ---- 控制台编码防御（修复 CI/英文 Windows 下 UnicodeEncodeError 崩溃）----
# Windows 控制台默认代码页可能是 cp1252/cp936 等，print 中文/特殊符号（⟦⟧）
# 会直接抛 UnicodeEncodeError 导致程序崩溃。这里强制标准流为 UTF-8、不可映射
# 字符降级替换 —— 任何语言环境下都不再因输出崩溃。
#
# v0.3.8：不再内联抄一份，统一复用 utils.ensure_console_encoding（与 CLI 的
# main()、交互式菜单、WebUI serve() 共用同一实现；此前四处各写一套的教训见该函数
# docstring）。打包 exe 走 force_utf8=True —— 这是**唯一**需要字节级 UTF-8 的
# 入口：重定向到文件/CI 日志时中文不丢字；真控制台下 Python 3.6+ 的 Windows
# 控制台本身就是按 UTF-8 缓冲实现的（PEP 528），显示不受影响。
from mc_i18n.utils import ensure_console_encoding  # noqa: E402

ensure_console_encoding(force_utf8=True)

from mc_i18n.cli import main  # noqa: E402  (需在 freeze_support 之后导入)

if __name__ == "__main__":
    sys.exit(main())
