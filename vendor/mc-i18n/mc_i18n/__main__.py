"""支持 `python -m mc_i18n ...` 方式直接运行 CLI。"""

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
