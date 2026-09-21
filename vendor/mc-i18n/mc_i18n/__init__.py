"""mc_i18n —— 《MC整合包自动翻译工具》核心包。

v0.2.0 完整翻译闭环（开箱即用成品）：
    1. F01 整合包扫描器（core/scanner.py）
       递归遍历整合包目录，自动识别 .lang / .json 语言文件，
       支持读取 mods/*.jar 容器内部的语言文件（只读）。
    2. F02 无损解析引擎（core/parsers/）
       .lang 与 .json 双解析器，解析 → 序列化往返字节级还原。
    3. F03 占位符保护引擎（core/placeholders.py）
       %s/%1$s/%%、${变量}、{0}、§/& 颜色码、\\n 转义、XML 标签——
       翻译前提取为保护 token，翻译后原位还原并校验。
    4. F04 翻译引擎层（core/engines/）
       内置 百度翻译 / DeepL / OpenAI 兼容接口（扩展位示例）/ 演示引擎，
       统一抽象 + 限流 + 指数退避重试，注册制可插拔扩展。
    5. F05/F13 批量并发调度与断点续翻（core/pipeline.py）
       线程池并发 + 批量装箱 + 失败降级链（备用引擎 → 保留原文标记人工）。
    6. F06 翻译缓存（core/cache.py）
       SQLite 本地缓存，SHA-256 键；已翻译自动跳过，支持强制重翻。
    7. F08 导出与打包（core/exporters.py）
       按原始目录结构导出译文，一键打包为可直接使用的汉化资源包。
    8. F09 CLI（cli.py）：scan / translate / inspect / pack / roundtrip /
       check 完整命令集。
    9. F14 语言文件质量巡检（core/quality.py，v0.3.8）
       只读体检：文件健康 + 译文比对 + 分级报告，15 个问题码，
       退出码可直接当发布闸门；占位符判定与翻译保护引擎同源。

零第三方强依赖：全部基于 Python 3.10+ 标准库实现，可直接运行；
PyYAML 为可选依赖（提供时优先使用，缺失时启用内置精简 YAML 解析器）。

v0.3.0 框架构建优化：WebUI 后端由单文件 webui.py 拆分为 webui/ 包
（state 运行期状态 / helpers 无状态工具 / api 业务层 / http 协议层），
路由表提升为模块级常量并由回归测试守护；对外符号与行为完全不变。

v0.3.1 缺陷修复：serve() 启动横幅改为编码安全输出（标准流
errors="replace" + 防御式打印），修复 Windows CI / 英文系统下
stdout 为 cp1252 等窄编码管道时 print 中文横幅抛 UnicodeEncodeError、
服务线程死于 serve_forever() 之前导致 WebUI「端口已绑但无响应」。

v0.3.2 缺陷修复（CI 构建卡死 + macOS 测试失败）：
    1. 入口行为回退：无参数启动（双击 exe）恢复为控制台菜单（v0.2.1
       前的键盘流），图形界面降级为可选项（菜单 [6] 或 `gui` 子命令）。
       根因：Windows 将 NUL 设备归类为字符设备，CI 冒烟测试
       `exe </dev/null | head -5` 下 isatty() 误判为交互终端 →
       serve() 阻塞循环永不退出 → 构建步骤被拖到超时（"卡死"）。
       菜单对 stdin EOF / Ctrl+C 天然优雅退出，无人值守环境安全。
    2. serve() 新增可选 on_ready 回调（bind 成功即触发、先于横幅打印，
       传真实 server 引用）；test_web_upload 弃用固定端口 18781，
       改随机空闲端口 + 禁代理回环探测 + tearDownClass 优雅关闭，
       修复 GitHub Actions macOS runner 上固定端口探测 5 秒超时
       （横幅已打印但连接不通）导致的 setUpClass ERROR。

v0.3.3 功能迭代（真实进度 + 扫描可观察 + 占位符还原修复）：
    1. 翻译真实进度条：PipelineOptions 新增 progress_cb 阶段回调
       （scan/collect/translate/export 四阶段逐文件/逐批上报），
       WebUI 翻译任务映射到 0-100 进度区间实时更新——修复旧版
       "开始翻译后进度条焊死 30% 直到结束才跳 85%"的假进度。
    2. 扫描异步化 + 扫描进度条：/api/scan 改后台线程执行，
       扫描器逐文件上报进度（"扫描中… 123/2832"）——大包扫描
       不再让界面干等、可区分"工作中"与"卡死"；前端复用 /api/status
       轮询渲染，同一整合包的扫描结果在切页间复用。
    3. 拖拽区已选状态：选中整合包后拖拽区切换为绿实线"已选"态
       （包名 + 完整路径 + 替换提示）；再次拖入/选择先弹确认，
       不再静默覆盖。
    4. 占位符还原失败修复（v0.3.2 实测失败率约 1.6%）：
       a) 连续色码段（§a§b§c…）合并为单 token 保护——LLM 对密集
          ⟦N⟧ 标记经常省略"重复"标记（62 个只留 19 个实测），
          合并后 token 数骤降、保留率大幅上升；
       b) 乱序自动恢复：token 编号集完整仅顺序错时（形态 A），
          单条重试仍乱序则按编号回填采纳译文并写入 report.json 的
          review_suggested 清单转人工复核——不再整条丢弃回退英文；
       c) AI 引擎 system prompt 强化：连续标记逐个输出的硬性规则
          + 专门示例。
    5. macOS CI 结构性防御：test_web_upload 的"启动+探活"封装为
       可重试单元，首次超时优雅关闭后全新端口重建再试一次
       （H1 假设："进程首个网络调用被一次性延迟"），全平台行为一致。

v0.3.4 修复（v0.3.3 实测占位符日志噪音治理）：
    1. 乱序分级判定：中文与英文语序差异天然导致 token 换位（编号集
       完整的乱序 [1, 0]、[2, 0, 11] 是正常翻译而非错误，v0.3.3 误判
       为失败→无谓重试→误转人工，日志刷屏）。现按"回填后 %s/%d
       等格式符类型序列是否与原文一致"分级：一致（纯文本/色码/
       同类型 token）直接回填通过；不一致（类型换位有 Java formatter
       参数错绑风险）才走重试→转人工降级链。
    2. 纯 token 条目跳过引擎：整条只有色码/占位符、无可译正文
       （§r 装饰行等）直接原样输出，不再交给 LLM（实测"应有 1 个
       ⟦N⟧，译文仅识别到 0 个"即此类不可控行为）；统计新增
       entries_passthrough 进 report.json。

v0.3.6 修复（v0.3.5-r2；真机复测：v0.3.5-r1 在 Linggango 整合包上兜底未生效）：
    r1 在公司构造语料上测试全绿，但用户真机日志仍被"应有 N 个 ⟦N⟧，
    译文仅识别到 M 个"刷屏。复盘出三个 r1 未覆盖的根因，本版逐一修复：

    1. 【编号越界被误判为映射不可靠】模型常吐出越界编号（原文 8 个
       token 却返回 ⟦9⟧），r1 在越界检查处直接放弃整条。现改为"只丢弃
       该幻觉标记，其余合法标记继续回填"；全部越界时才走无锚点路径。
    2. 【锚点用 tokens 字面反查，重复值必然错位】色码 §r / 同名 %s 会
       出现多次，result.find() 永远命中第一个 → 插入点错乱。现改由
       _rebuild_with_spans 返回回填后的真实 span 作为锚点；并修正插入
       规则：右侧无锚点时改插到"最近左锚点之后"，不再一律丢到句末
       （旧行为会把 §c%1$s§r 挤到句末，严重偏离原文语义）。
    3. 【strict 默认策略下无锚点即抛错】真机大量条目是"模型把占位符
       语义化改写"（%s → "玩家"），连 token 字面都搜不到。现 pipeline
       降级链新增第三条：重译仍失败 → force_fill 强制回填（参数型置
       句末标点前、色码置句首），保证占位符零丢失并计入人工复核。
       占位符丢失会导致运行期 Java formatter 崩，位置欠佳只是观感问题。

    附带修复：脏标记不再泄漏进译文（旧实现会产出 "%s 和 ⟦0⟧" 这类
    残留 ⟦0⟧ 的结果）；force_fill 对已存在的 token 字面做去重。

    实测（恶劣引擎删除全部 ⟦N⟧ 标记）：14/14 条目成功、0 失败、
    0 残留 token，导出产物 7 类占位符个数与原文完全一致。

v0.3.7 变更（引擎选择一致性修复 —— 真机事故根因）：
    背景：用户真机跑 Linggango 整合包，日志被"占位符还原失败"刷屏，
    导出 89349 条译文里 62910 条（70.4%）带「【机翻·演示】」前缀。
    排查结论：**根因不在占位符，而在引擎选择**——实际执行的是 demo
    演示引擎（输出 = 前缀 + 原文，等于完全没翻译）。

    1. 后端引擎解析（webui/api.py::_resolve_engine_name，新增）：
       旧写法 `params.get("engine") or "demo"` 在缺参时静默落演示引擎。
       现改为「请求参数 → config.engine.primary → demo」三级解析，
       让"设置页选了什么就跑什么"真正成立。translate 与
       quests/translate 两个入口统一走该函数。
    2. 工作台引擎只读化（web_page.py，方案 A）：
       删除工作台可写的 tr-engine 下拉框（它与设置页 set-engine
       各管各的，导致"设置里选 Google、实际跑 demo"），改为只读
       胶囊回显 + 「去设置修改」跳转；设置页成为引擎唯一真相源。
    3. 演示引擎警示（web_page.py）：
       引擎为 demo 时工作台顶部常驻红色横幅提示"不会真正翻译"，
       点击「开始翻译」直接拦截并引导到设置页。
    4. 报告记录真实引擎（core/pipeline.py）：
       PipelineResult 新增 engine_used 字段，report.json 的
       engine.used 记录**真正产出译文**的引擎（降级时为主引擎之外
       的值）。此前 primary/日志/报告三方不一致，排障时互相矛盾。

    实测：真机 config.yaml（engine.primary=google）端到端跑通——
    engine_used=google、2/2 条目翻译、0 失败、chars_sent=80（非 0），
    导出译文为真中文且 §色码 / %d / %s 原子零丢失。
    测试基线 358 → 379 例全绿。

v0.3.9 补丁版（修复 v0.3.8 采集界面截图时暴露的两处缺陷）：
    背景：v0.3.8 为归档资产库采集 8 张真实界面截图，过程中发现两个此前
    从未被测试覆盖的真实缺陷（一个 core 级"静默漏翻"、一个 UI 级"点了
    没反应"），按"立即修复、单独出补丁版"处理，不并入下一功能版。

    1. 【core·重要】**术语表 token 化致"受保护文本碰撞"→ 静默漏翻**
       （core/pipeline.py::_group_batches）。
       缺陷：术语表启用时，术语原文 + 占位符被统一替换为 ⟦N⟧ token 后送
       引擎。若两条**不同原文** token 化后落到**同一**受保护文本，旧实现
       以 protected 为键、用 setdefault 建 protected→task 表，后一条任务
       被静默折叠：
         · 该任务永远拿不到批次 → done 恒为 False 且 failed_reason 为
           None → 汇总阶段落到 `failed_reason or "未知原因"` 分支，报告里
           出现"未知原因"，用户拿不到任何可行动信息；
         · 导出的语言文件里该键**保留英文原文**（无损回退），译文流里也
           永远看不到它 —— 报告说"1 条失败"，看上去像引擎抽风。
       实测触发形态（术语表含 Speed / Efficiency 时）：
           "Speed: %d"       → "⟦0⟧: ⟦1⟧"
           "Efficiency: %d"  → "⟦0⟧: ⟦1⟧"
       热力（thermal）等模组的 lang 文件正是这种形状（"Speed: %d%%"）。
       旧实现实测输出：
           failures           = [{'key': 'item.collide.efficiency',
                                  'source': 'Efficiency: %d',
                                  'reason': '未知原因'}]
           entries_translated = 1
           exported zh        = {"item.collide.speed": "…速度: %d",
                                 "item.collide.efficiency": "Efficiency: %d"}
       修复：_group_batches 改为**按出现次数逐个认领**——受保护文本相同的
       任务排成 FIFO，每遇到一次该文本就出队一个任务。BaseEngine.chunk()
       是保序贪心装箱（只切分、不重排、不去重），因此"批次里的文本序列"
       与"pending 里的任务序列"逐位对应，逐个认领拿到的正是原任务对象；
       即便某引擎的 chunk() 重排批次，只要文本多重集不变仍能一一配齐
       （同形文本对调无害 —— 还原用的 tokens 挂在任务自己身上）。
       同时补显式报错：若批次里出现"待译集合中不存在"的文本（只可能来自
       chunk() 丢字/造字的实现错误），抛 RuntimeError 而不是静默错配。
       说明：该缺陷自仓库首个提交即存在，非 v0.3.8 引入；是 v0.3.8 的
       「完成后自动跳校对台」把它从"看不见"变成"看得见"。
       另附注：缓存键按 protected（token 空间）构造是**刻意且安全**的——
       缓存 value 也是 token 空间产物、还原由各任务持自己的 tokens 完成，
       两条同形原文共用一条缓存不会串味（已由回归用例作证）。

    2. 【UI·轻微】**校对台筛选复选框无 change 绑定**（web_page.py）。
       缺陷：`#rv-only-issue` / `#rv-only-new` / `#rv-nosrc` 三个复选框都
       没有 onchange，勾选后界面不重绘（要等搜索框 oninput 等其它动作才
       刷新）。而 rvFocusIssues() 走的是"先打勾、再显式调
       renderReviewEntries()"，于是表现为**同一控件两种行为**——从待处理
       横幅点进来有效、手动勾选无效。`#rv-only-new` / `#rv-nosrc` 自
       v0.3.2 起即有，`#rv-only-issue` 是 v0.3.8 新增的同源问题。
       修复：三个 input 各加 onchange="renderReviewEntries()"。

    测试基线 553 → 567 例全绿（新增 tests/test_token_collision.py 10 例
    锁定缺陷 1 的"不丢任务/不错配/端到端双双译出/缓存复用不串味"，
    tests/test_web_page_ui.py 新增 4 例锁定缺陷 2 的"每个筛选都绑了
    change 且渲染函数消费三者"）。
    兼容性：只改流水线内部批次映射与前端事件绑定，对外 CLI / API /
    配置 / 缓存键 / 产物结构全部不变；不加任何新参数。

v0.3.8 变更（M2 收口：质量巡检 + 增量合并 + 编码治理 + 死代码清理 + 实时进度可视化）：
    1. 语言文件质量巡检（core/quality.py，新增）：
       `translate` 回答"翻译得动不动"，`check` 回答"翻出来的东西
       靠不靠得住"。只读、零 API 调用、不改任何文件，可安全地反复跑。
       三层检查：文件健康（解析失败 / 超额 / 重复键 / 非字符串值 /
       编码非无 BOM 的 UTF-8 / 源值空 / 孤立 § 结尾 / 混用 %s 与 %1$s）、
       译文比对（缺键 / 陈旧键 / 译文为空 / 译文==原文 / 占位符丢失或多出）、
       汇总出口（控制台摘要 + check-report.json，有 ERROR 即退出码 1）。
       关键约束：占位符判定**复用 PlaceholderGuard 同一套识别规则**，
       杜绝"翻译说没丢、巡检说有丢"的两套口径打架；每条 (文件, 问题码)
       只产出一个 Issue 并以 count + 样本键承载明细，避免真机 2832 文件
       规模下报告膨胀。问题码目录 ISSUE_CATALOG 为唯一真相源，15 条。
       CLI：新增 `check` 子命令（--strict 令 WARN 也算失败，适合 CI 卡点；
       --json / --ignore / --no-untranslated / --max-issues / --quiet）；
       `translate` 新增 `--check`（翻前巡检，只告警）/ `--check-strict`
       （有 ERROR 立即中止，退出码 1）。
    2. 目标语言增量合并（core/pipeline.py + core/exporters.py）：
       新增 ExistingTargetPolicy 三态（SKIP / MERGE / OVERWRITE，解析
       优先级 merge > skip > overwrite）与 PipelineOptions.merge_existing。
       MERGE 逐键沿用整合包既有 zh_cn.json 的译文、只补翻缺失条目，源文件
       已删除的陈旧键丢弃，导出结构跟源文件走；既有译文若占位符校验不通过
       **不回退英文**，保留原译文并写入 review_suggested 转人工复核。
       exporters.read_existing_target() 同时支持散装文件与 jar 内读取。
       report.json 新增 existing_target_policy / files_merged /
       entries_kept_existing。工作台原「跳过整合包已有中文」复选框升级为
       三态下拉框（webui/api.py::_resolve_existing_policy 兼容旧前端只传
       skip_existing 的历史调用）。
    3. 控制台编码治理（utils.py 提炼，三入口收敛）：
       原先散落在 cli.py / interactive.py / webui/http.py / launcher.py 的
       四份 sys.stdout.reconfigure 循环，收敛为公共实现
       ensure_console_encoding(force_utf8=False) 与 safe_print()。
       Windows 窄编码（cp1252 / cp936）管道下打印中文不再抛
       UnicodeEncodeError 中断任务（仅降级为 "?"）；launcher.py 作为打包
       入口显式传 force_utf8=True。
    4. 任务书页引擎选择统一（web_page.py）：
       任务书页原有的可写引擎下拉框删除，与工作台（v0.3.7 方案 A）对齐为
       只读回显 + 设置页唯一真相源；引擎为 demo 时点「开始翻译」直接拦截
       并引导到设置页。
    5. 死代码清理（mc_i18n/webui.py 已删除，40,160 B / 951 行）：
       v0.3.0 把 WebUI 拆成 webui/ 包后，旧单文件因「同名包优先于模块」
       自拆分当日起即被遮蔽、永不生效，却长期留在仓库里让读者误以为它是
       活入口。tests/test_webui_routes.py 已加守卫测试防止被误恢复。
    6. .gitignore 补 .mc-i18n/：
       工具在各整合包目录内产生的日志 / 译文 / manifest / 巡检报告是
       **产物目录**而非源码，误提交会把用户译文与日志带进仓库。
    7. 文档数字校正：README 与本文档此前记录的 v0.3.7 实测数字
       （条目 4/4、chars_sent=247）与归档测试报告不符，按归档报告
       订正为 2/2 与 80。
    8. 文档一致性守卫（tests/test_doc_consistency.py，新增）：
       上面那类"文档数字漂移"靠人工注意是治不住的（改代码时没人会顺手
       改文档），现改为 CI 硬校验三条不变量——README 声明的测试数必须
       等于实际可发现用例数；版本表必须含当前 __version__ 行；每个源码
       模块都必须在 README 里被提到。数字再漂就直接红。
    9. 实时译文流（core/pipeline.py + webui/state.py + webui/api.py）：
       PipelineOptions 新增 event_cb(event) 结构化事件回调，与 progress_cb
       并行不替代——后者保持**严格三参数签名**不变，旧调用零改动。
       事件两类：progress（stage/done/total/rate/eta_sec）与 entry
       （ok/source/translation/review/failed/cached）。worker 线程不直接
       回调，_translate_batch 返回事件列表、由主线程按批补发，故无需加锁。
       服务端 deque(maxlen=300) 滚动窗口 + 单调 entry_seq，前端以
       ?since=N 游标只拉新增条目，避免整表重传；缓存命中只抽样上报
       （_CACHE_ENTRY_SAMPLE=30），文本裁剪至 240 字符、换行转 ⏎。
    10. 预计用时 ETA（core/pipeline.py + webui/api.py + web_page.py）：
       progress 事件携带 rate（条/秒）与 eta_sec，按累计均值速率外推
       （天然单调不增）。硬约束：collect/translate/export 每阶段起点必须
       补发一条 (0, total)，否则 elapsed≈0 导致 ETA 失真。export 为末阶段，
       界面另预留收尾（max(2s, translate 已耗时×6%)）得到全任务 ETA；
       scan/collect 后续工作量未知时如实返回 None，界面显示"估算中"，
       不谎报时长。
    11. 完成后自动跳转校对台（webui/api.py + web_page.py）：
       任务收尾时 failures 或 review_suggested 任一非空即自动切到校对台
       并聚焦问题文件；/api/review/files 与 /api/review/entries 新增
       pending / pending_total 与失败 / 待复核标注，支持「只看问题条目」
       筛选，行级高亮失败（红）/ 待复核（黄）。report.json 的 file 字段
       （path_in_pkg）经 _report_pending() 聚合为按文件的待处理清单。

    兼容性：不传任何新参数时行为与 v0.3.7 完全一致；
    --merge-existing 与 --translate-existing 同时给出时前者优先；
    check 的唯一写入是 check-report.json。
    测试基线 379 → 553 例全绿（新增模块 quality 53 / merge_existing 28 /
    console_encoding 20 / doc_consistency 14 / realtime_progress 35，
    另在既有模块补了任务书页引擎收敛回归、WebUI 死代码守卫，并扩展
    web_page_ui 前端接线断言）。

v0.3.5-r1 变更（位置回填兜底初版，已被 r2 取代，保留供回溯）：
    1. 位置回填兜底（core/placeholders.py::_fill_partial）：
       v0.3.4 及以前，"⟦N⟧ 标记数量不符"一律抛错 → 整条走
       重试 → 备用引擎 → 保留英文 降级链。按"映射可靠度"分级尝试。
    2. salvage 兜底策略（ProtectOptions / ProtectConf 新增
       missing_token_policy）：完全无锚点时，strict（默认）抛错降级；
       salvage 则把缺失占位符补回，保证零丢失。
    3. 配置项 protect.missing_token_policy（strict | salvage）已接入
       config 校验与流水线（pipeline 经 app.protect 透传）。
"""

__version__ = "0.3.9"

__all__ = ["__version__"]
