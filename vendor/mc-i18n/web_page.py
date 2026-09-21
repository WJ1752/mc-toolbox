"""mc-i18n WebUI 前端 —— 单文件单页应用（内嵌 CSS/JS，零第三方依赖）。

设计要点（与设计稿一致）：
    - 深色卡片风：#0b0f14 背景 / #131a22 卡片 / #2ea043 绿色强调
    - 五页分离导航：工作台 / 任务书 / 校对台 / 术语表 / 设置（每页独立、条理清晰）
    - 原生 fetch 调用后端 API；每秒轮询 /api/status 驱动进度条与日志
    - 目录浏览器为服务端代理（浏览器安全限制拿不到本机路径）

本模块只暴露 PAGE_HTML 常量，由 ``webui/http.py`` 在 GET / 时返回。
"""

PAGE_HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mc-i18n 汉化工具箱</title>
<style>
/* ================= 主题变量（深色卡片风） ================= */
:root{
  --bg:#0b0f14;          /* 页面背景 */
  --card:#131a22;        /* 卡片背景 */
  --card2:#0f151c;       /* 次级面板 */
  --line:#1f2833;        /* 边框 */
  --fg:#e6edf3;          /* 主文字 */
  --fg-dim:#8b98a5;      /* 次文字 */
  --accent:#2ea043;      /* 绿色强调 */
  --accent-dim:#238636;
  --warn:#d29922;        /* 警示黄 */
  --err:#f85149;         /* 错误红 */
  --info:#58a6ff;        /* 信息蓝 */
  --radius:10px;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--fg);
  font-family:"Segoe UI",system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  font-size:14px;line-height:1.55;min-height:100vh}
a{color:var(--info);text-decoration:none}
.mono{font-family:ui-monospace,Consolas,"Cascadia Mono",monospace}

/* ================= 顶部栏 ================= */
header{position:sticky;top:0;z-index:50;background:rgba(11,15,20,.92);
  backdrop-filter:blur(6px);border-bottom:1px solid var(--line);
  padding:10px 18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.logo{font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px}
.logo .cube{width:22px;height:22px;border-radius:5px;
  background:linear-gradient(135deg,var(--accent),#1a6b2a);display:inline-block}
.logo small{color:var(--fg-dim);font-weight:400}
#pack-chip{display:flex;align-items:center;gap:8px;background:var(--card);
  border:1px solid var(--line);border-radius:999px;padding:4px 6px 4px 14px;
  max-width:46%;font-size:12px;color:var(--fg-dim)}
#pack-chip .path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg)}
#pack-chip button{border:none;background:var(--accent-dim);color:#fff;
  border-radius:999px;padding:3px 10px;cursor:pointer;font-size:12px}
#job-pill{margin-left:auto;display:none;align-items:center;gap:8px;
  background:var(--card);border:1px solid var(--line);border-radius:999px;
  padding:5px 14px;font-size:12px}
#job-pill .bar{width:120px;height:6px;background:var(--line);border-radius:4px;overflow:hidden}
#job-pill .bar i{display:block;height:100%;background:var(--accent);width:0;transition:width .4s}
#job-pill.err{color:var(--err)}

/* ================= 导航 ================= */
nav{display:flex;gap:6px;padding:12px 18px 0;max-width:1180px;margin:0 auto;flex-wrap:wrap}
nav button{background:transparent;border:1px solid transparent;color:var(--fg-dim);
  padding:8px 18px;border-radius:8px 8px 0 0;cursor:pointer;font-size:14px}
nav button:hover{color:var(--fg)}
nav button.active{background:var(--card);border-color:var(--line);border-bottom-color:var(--card);
  color:var(--accent);font-weight:600}

/* ================= 主区与卡片 ================= */
main{max-width:1180px;margin:0 auto;padding:14px 18px 60px}
.page{display:none}
.page.active{display:block}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  padding:16px 18px;margin-bottom:14px}
/* 拖拽上传区 */
.dropzone{border:2px dashed var(--line);border-radius:12px;padding:30px 20px;
  text-align:center;transition:.15s;background:var(--card2);cursor:pointer}
.dropzone.drag{border-color:var(--accent);background:rgba(46,160,67,.08)}
/* 已选择整合包后的"已选"态（v0.3.3）：实线绿框 + 淡绿底，与初始虚线态明确区分 */
.dropzone.picked{border-style:solid;border-color:var(--accent-dim);
  background:rgba(46,160,67,.05)}
.dropzone.picked .big{color:var(--fg)}
.dropzone .big{font-size:18px;margin-bottom:8px;color:var(--accent)}
.dropzone .sub{color:var(--fg-dim);font-size:12px;margin-top:6px}
.dropzone .hint{color:var(--fg-dim);font-size:12px;margin-top:10px;opacity:.8}
/* 已选态下展示的完整路径（可点"更换"） */
.dropzone .picked-path{font-size:12px;color:var(--fg-dim);margin-top:6px;
  max-width:92%;margin-left:auto;margin-right:auto;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dropzone input[type="file"]{display:none}
.dropzone .btns{display:flex;gap:10px;justify-content:center;margin-top:14px;flex-wrap:wrap}
.card h3{font-size:14px;margin-bottom:12px;color:var(--fg);display:flex;
  align-items:center;gap:8px;flex-wrap:wrap}
.card h3 .sub{font-weight:400;font-size:12px;color:var(--fg-dim)}
/* 引擎只读展示（v0.3.7 方案A：引擎选择统一收敛到设置页，工作台只读回显） */
.engine-pill{display:inline-block;margin-left:6px;padding:4px 10px;border-radius:6px;
  background:var(--bg-alt,#2a2a2a);border:1px solid var(--line,#3a3a3a);
  font-size:13px;font-weight:600;color:var(--brand,#4ea1ff);cursor:pointer}
.engine-jump{margin-left:6px;font-size:12px;color:var(--fg-dim);text-decoration:none}
.engine-jump:hover{color:var(--brand,#4ea1ff);text-decoration:underline}
/* 演示引擎警示横幅：醒目红，不可忽略 */
.warn-banner{margin:10px 0 4px;padding:10px 12px;border-radius:8px;font-size:13px;
  line-height:1.6;background:rgba(220,53,69,.14);border:1px solid rgba(220,53,69,.5);
  color:#ff8a8a}
.warn-banner a{color:#ffb3b3;text-decoration:underline}
/* 可折叠卡片（设置页引擎配置）：点标题收起/展开，默认收起保持页面清爽 */
.foldable h3.fold-head{cursor:pointer;user-select:none;margin-bottom:0}
.foldable.open h3.fold-head{margin-bottom:12px}
.foldable .fold-body{display:none}
.foldable.open .fold-body{display:block}
.fold-arrow{margin-left:auto;font-size:12px;color:var(--fg-dim);transition:transform .15s}
.foldable.open .fold-arrow{transform:rotate(180deg)}
/* 已配置标记：收起时也能一眼看出哪些引擎填过密钥 */
.cfg-tag .tag.g{font-size:11px;padding:1px 7px}
/* 全站水印：各页右下角，不挡点击、不可选中 */
.wm{position:fixed;right:16px;bottom:10px;font-size:11px;color:rgba(148,163,184,.35);
  pointer-events:none;user-select:none;z-index:60;letter-spacing:.5px}
.grid{display:grid;gap:12px}
.grid.c4{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.grid.c2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.stat{background:var(--card2);border:1px solid var(--line);border-radius:8px;
  padding:12px 14px;text-align:center}
.stat b{display:block;font-size:22px;color:var(--accent)}
.stat span{font-size:12px;color:var(--fg-dim)}
.stat.dim b{color:var(--fg)}

/* ================= 控件 ================= */
button.btn{background:var(--accent-dim);border:1px solid var(--accent-dim);color:#fff;
  border-radius:7px;padding:7px 16px;cursor:pointer;font-size:13px;transition:.15s}
button.btn:hover{background:var(--accent)}
button.btn:disabled{opacity:.45;cursor:not-allowed}
button.btn.ghost{background:transparent;border-color:var(--line);color:var(--fg)}
button.btn.ghost:hover{border-color:var(--accent-dim);color:var(--accent)}
button.btn.danger{background:transparent;border-color:var(--err);color:var(--err)}
button.btn.big{font-size:15px;padding:10px 26px}
input,select{background:var(--card2);border:1px solid var(--line);color:var(--fg);
  border-radius:7px;padding:7px 10px;font-size:13px;outline:none;min-width:0}
input:focus,select:focus{border-color:var(--accent-dim)}
label.f{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--fg-dim)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.row>label.f{flex:1;min-width:150px}
.check{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--fg-dim);cursor:pointer}
.check input{width:auto}
.tag{display:inline-block;font-size:11px;border-radius:5px;padding:1px 8px;
  border:1px solid var(--line);color:var(--fg-dim)}
.tag.g{color:var(--accent);border-color:var(--accent-dim)}
.tag.y{color:var(--warn);border-color:var(--warn)}
.tag.b{color:var(--info);border-color:var(--info)}

/* ================= 进度与日志 ================= */
.progress{height:8px;background:var(--line);border-radius:5px;overflow:hidden;margin:10px 0}
.progress i{display:block;height:100%;width:0;background:var(--accent);transition:width .4s}
#logbox{background:#0a0e12;border:1px solid var(--line);border-radius:8px;
  padding:10px 12px;height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all;
  font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#9fb3c8;display:none}
#logbox .errline{color:var(--err)}

/* ============ 实时译文流 + 预计用时（v0.3.8） ============ */
.eta-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;
  font-size:12px;color:var(--fg-dim);margin-bottom:4px}
.eta-row .tag{font-variant-numeric:tabular-nums}
#tr-stream-wrap{margin-top:10px}
.stream-head{display:flex;gap:10px;align-items:center;font-size:12px;
  color:var(--fg-dim);margin-bottom:5px}
.stream-head b{color:var(--fg);font-size:13px}
.stream{background:#0a0e12;border:1px solid var(--line);border-radius:8px;
  height:190px;overflow:auto;padding:6px 8px;
  font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.7}
.srow{display:flex;gap:6px;align-items:baseline;white-space:nowrap}
.srow .mk{font-style:normal;color:var(--accent);flex:0 0 auto}
.srow .src{color:#8ba0b6;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;
  max-width:42%}
.srow .arw{color:#4a5560;flex:0 0 auto}
.srow .dst{color:#cfe3d4;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto}
.srow.warn .mk{color:var(--warn)}
.srow.bad .mk{color:var(--err)}
.srow.bad .dst{color:#ff9b9b}
.srow .badge{margin-left:4px;flex:0 0 auto}

/* ================= 表格 ================= */
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--fg-dim);font-weight:600;font-size:12px;white-space:nowrap}
tr:hover td{background:rgba(255,255,255,.02)}
/* v0.3.8：待处理条目整行着色（红=失败保留原文，橙=待人工复核） */
tr.row-bad td{background:rgba(220,53,69,.08)}
tr.row-bad:hover td{background:rgba(220,53,69,.14)}
tr.row-warn td{background:rgba(210,153,34,.07)}
tr.row-warn:hover td{background:rgba(210,153,34,.13)}
td .src{color:var(--fg-dim)}
td input.txt{width:100%}
.badge{font-size:11px;border-radius:4px;padding:0 6px;margin-left:6px}
.badge.new{background:rgba(210,153,34,.15);color:var(--warn)}
.badge.ok{background:rgba(46,160,67,.15);color:var(--accent)}
.badge.err{background:rgba(220,53,69,.15);color:#ff8a8a}
.badge.dim{background:rgba(148,163,184,.15);color:var(--fg-dim)}
.scroll{max-height:480px;overflow:auto;border:1px solid var(--line);border-radius:8px}
.scroll table{border-collapse:separate;border-spacing:0}
.scroll th{position:sticky;top:0;background:var(--card2);z-index:2}

/* ================= 校对台双栏 ================= */
#review-layout{display:grid;grid-template-columns:320px 1fr;gap:14px}
@media(max-width:860px){#review-layout{grid-template-columns:1fr}}
.filelist{max-height:520px;overflow:auto}
.fileitem{padding:8px 10px;border-bottom:1px solid var(--line);cursor:pointer;
  font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fileitem:hover{background:rgba(255,255,255,.03)}
.fileitem.sel{background:rgba(46,160,67,.12);border-left:2px solid var(--accent)}
.fileitem .no-map{color:var(--warn);font-size:11px;margin-left:6px}

/* ================= 模态框 ================= */
.modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;
  display:none;align-items:center;justify-content:center;padding:20px}
.modal-mask.show{display:flex}
.modal{background:var(--card);border:1px solid var(--line);border-radius:12px;
  width:min(620px,100%);max-height:82vh;display:flex;flex-direction:column;overflow:hidden}
.modal header{position:static;background:transparent;border-bottom:1px solid var(--line);
  padding:12px 16px}
.modal .body{padding:14px 16px;overflow:auto}
.modal footer{border-top:1px solid var(--line);padding:10px 16px;display:flex;
  justify-content:flex-end;gap:10px}
.dirlist{border:1px solid var(--line);border-radius:8px;max-height:300px;overflow:auto}
.diritem{padding:8px 12px;border-bottom:1px solid var(--line);cursor:pointer;
  display:flex;justify-content:space-between;align-items:center;font-size:13px}
.diritem:hover{background:rgba(255,255,255,.04)}
.diritem .hint{font-size:11px;color:var(--accent)}

/* ================= Toast ================= */
#toasts{position:fixed;right:18px;bottom:18px;z-index:200;display:flex;
  flex-direction:column;gap:8px}
.toast{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--accent);
  border-radius:8px;padding:10px 16px;font-size:13px;min-width:220px;max-width:380px;
  box-shadow:0 4px 16px rgba(0,0,0,.4);animation:slidein .2s}
.toast.err{border-left-color:var(--err)}
.toast.info{border-left-color:var(--info)}
@keyframes slidein{from{transform:translateX(30px);opacity:0}to{transform:none;opacity:1}}
.empty{color:var(--fg-dim);text-align:center;padding:26px 10px;font-size:13px}
.hintbox{font-size:12px;color:var(--fg-dim);background:var(--card2);
  border:1px dashed var(--line);border-radius:8px;padding:10px 14px;margin-top:10px}
.hintbox b{color:var(--fg)}
.test-result{display:none;font-size:12px;border-radius:6px;padding:7px 12px;
  margin-top:10px}
.test-result.ok{display:block;background:rgba(46,160,67,.12);
  border:1px solid var(--accent-dim);color:var(--accent)}
.test-result.bad{display:block;background:rgba(248,81,73,.10);
  border:1px solid var(--err);color:var(--err)}
.preset-btn.active{border-color:var(--accent);color:var(--accent);
  background:rgba(46,160,67,.10)}
</style>
</head>
<body>

<header>
  <span class="logo"><span class="cube"></span>mc-i18n 汉化工具箱 <small id="ver"></small></span>
  <span id="pack-chip" style="display:none">
    <span class="path mono" id="pack-path"></span>
    <button onclick="openBrowse()">更换</button>
  </span>
  <span id="job-pill"><span id="job-pill-txt"></span><span class="bar"><i id="job-pill-bar"></i></span></span>
</header>

<nav id="nav">
  <button data-page="home" class="active">🏠 工作台</button>
  <button data-page="quests">📜 任务书</button>
  <button data-page="review">✎ 校对台</button>
  <button data-page="glossary">📖 术语表</button>
  <button data-page="settings">⚙ 设置</button>
</nav>

<main>
<!-- ==================== 页1：工作台 ==================== -->
<section class="page active" id="page-home">
  <div class="card">
    <h3>📦 整合包 <span class="sub" id="home-pack-hint">拖入文件或选择目录</span></h3>
    <div class="dropzone" id="home-dropzone"
         onclick="document.getElementById('drop-input').click()"
         ondragenter="dropZoneEnter(event)" ondragover="dropZoneOver(event)"
         ondragleave="dropZoneLeave(event)" ondrop="dropZoneDrop(event)">
      <div class="big" id="dz-big">📦 拖拽整合包 / 模组到此处</div>
      <div id="dz-desc">支持：CurseForge 整合包 .zip（含 manifest.json） | Modrinth 整合包 .mrpack | 直接拖多个 .jar 或整个 mods 文件夹</div>
      <div class="sub" id="dz-sub">也可以点击选择文件</div>
      <div class="btns">
        <button class="btn" onclick="event.stopPropagation(); openBrowse()">选择整合包目录…</button>
        <button class="btn ghost" onclick="event.stopPropagation(); doScan(false, true)">重新扫描</button>
      </div>
      <input type="file" id="drop-input" multiple onchange="dropFiles(this.files)">
    </div>
  </div>

  <div id="home-scan" style="display:none">
    <div class="grid c4" style="margin-bottom:14px">
      <div class="stat"><b id="st-files">0</b><span>语言文件</span></div>
      <div class="stat"><b id="st-src">0</b><span>待翻译源文件</span></div>
      <div class="stat"><b id="st-entries">0</b><span>可翻译条目</span></div>
      <div class="stat"><b id="st-quests">0</b><span>任务书条目</span></div>
    </div>

    <div class="card">
      <h3>🚀 启动翻译
        <span class="sub">翻译结果导出在 .mc-i18n/translated/，原文件绝不修改</span></h3>
      <div class="row" style="margin-bottom:6px">
        <label class="f">翻译引擎
          <span id="tr-engine-view" class="engine-pill" title="点击前往设置页修改">谷歌翻译（免费）</span>
          <a href="#" class="engine-jump" onclick="gotoSettings();return false;">去设置修改 ›</a>
        </label>
        <label class="f">源语言 <input id="tr-src" value="en_us" style="width:110px"></label>
        <label class="f">目标语言 <input id="tr-dst" value="zh_cn" style="width:110px"></label>
        <label class="check" style="align-self:flex-end;padding-bottom:8px">
          <input type="checkbox" id="tr-glossary" checked> 应用术语表</label>
        <label class="check" style="align-self:flex-end;padding-bottom:8px">
          <input type="checkbox" id="tr-zip" checked> 完成后打包资源包</label>
      </div>
      <!-- v0.3.7：演示引擎警示横幅（选中 demo 时由 JS 显示） -->
      <div class="warn-banner" id="tr-engine-warn" style="display:none">
        ⚠️ 当前引擎是「演示引擎」，它<b>不会真正翻译</b>——产出的是「原文加前缀」的占位内容。
        请在 <a href="#" onclick="gotoSettings();return false;">设置</a> 中改用「谷歌翻译」或配置 AI 大模型。
      </div>
      <div class="row" style="margin-top:6px">
        <label class="f" title="整包已自带目标语言（zh_cn）时如何取舍机翻与既有译文">已有中文处理
          <select id="tr-existing-policy" style="width:290px">
            <option value="skip">跳过（保护社区/官方翻译，推荐）</option>
            <option value="merge">增量合并（保留已有译文，只补翻缺失条目）</option>
            <option value="overwrite">全量重翻（忽略已有译文）</option>
          </select>
        </label>
        <div style="font-size:12px;color:var(--fg-dim);margin-top:2px">
          整合包/模组自带 zh_cn.json 时：<b>跳过</b>不覆盖好翻译但会留半截汉化；
          <b>增量合并</b>两者兼顾（只对缺失键调用引擎）；<b>全量重翻</b>产出一份纯机翻全量文件。
        </div>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="btn big" id="btn-translate" onclick="doTranslate()">开始翻译</button>
        <button class="btn danger" id="btn-stop" style="display:none"
                onclick="stopTranslate()">⏹ 停止翻译</button>
        <button class="btn ghost" onclick="doPack()">仅打包资源包</button>
        <button class="btn ghost" onclick="loadReport()">查看上次报告</button>
      </div>
      <div style="font-size:12px;color:var(--fg-dim);margin-top:6px" id="tr-out-hint"></div>
      <div id="tr-progress-wrap" style="display:none">
        <div class="progress"><i id="tr-bar"></i></div>
        <div class="eta-row">
          <span id="tr-msg"></span>
          <span class="tag b" id="tr-rate" style="display:none"></span>
          <span class="tag g" id="tr-eta" style="display:none"></span>
          <span class="tag" id="tr-elapsed" style="display:none"></span>
        </div>
      </div>
      <!-- v0.3.8 实时译文流：翻译过程中逐条显示"翻译了哪些语句"，
           不只是报错时才有反馈（见 renderStream） -->
      <div id="tr-stream-wrap" style="display:none">
        <div class="stream-head">
          <b>实时译文流</b>
          <span id="tr-stream-stat"></span>
          <label class="check" style="margin-left:auto;font-size:12px">
            <input type="checkbox" id="tr-stream-autoscroll" checked> 自动滚动</label>
        </div>
        <div class="stream" id="tr-stream"></div>
      </div>
      <div id="logbox"></div>
    </div>

    <div class="card" id="report-card" style="display:none">
      <h3>📊 上次翻译报告 <span class="sub" id="report-time"></span></h3>
      <div class="grid c4">
        <div class="stat"><b id="rp-entries">0</b><span>翻译条目</span></div>
        <div class="stat"><b id="rp-cache">0</b><span>缓存命中</span></div>
        <div class="stat"><b id="rp-fail">0</b><span>失败</span></div>
        <div class="stat"><b id="rp-new">0</b><span>较上次新增</span></div>
      </div>
      <div style="font-size:12px;color:var(--fg-dim);margin-top:10px" id="rp-extra"></div>
    </div>
  </div>
</section>

<!-- ==================== 页2：任务书 ==================== -->
<section class="page" id="page-quests">
  <div class="card">
    <h3>📜 FTB Quests 任务书翻译
      <span class="sub">只翻译 title / subtitle / description 字段，其余内容逐字节保留</span></h3>
    <div class="row">
      <button class="btn" onclick="questsScan()">扫描任务书文件</button>
      <button class="btn ghost" onclick="loadQuestsDefaults()">载入默认语言设置</button>
    </div>
    <div class="hintbox" style="margin-top:12px">
      扫描 <b>config/ftbquests/quests/chapters/</b> 下的 .snbt 文件；
      首次修改前会自动生成 <b>.snbt.bak</b> 备份；任务书中的物品 ID、计数、
      图标路径等游戏数据一律不碰。
    </div>
  </div>
  <div id="quests-result" style="display:none">
    <div class="card">
      <h3>扫描结果 <span class="sub" id="quests-total"></span></h3>
      <div class="scroll"><table>
        <thead><tr><th>文件</th><th>可翻译条目</th></tr></thead>
        <tbody id="quests-tbody"></tbody>
      </table></div>
      <div class="row" style="margin-top:14px">
        <label class="f">引擎
          <span id="qs-engine-view" class="engine-pill" title="点击前往设置页修改">谷歌翻译（免费）</span>
          <a href="#" class="engine-jump" onclick="gotoSettings();return false;">去设置修改 ›</a>
        </label>
        <button class="btn big" id="btn-quests" onclick="doQuestsTranslate()">开始翻译任务书</button>
      </div>
      <!-- v0.3.8 方案A：演示引擎警示横幅（与工作台一致，选中 demo 时由 JS 显示） -->
      <div class="warn-banner" id="qs-engine-warn" style="display:none">
        ⚠️ 当前引擎是「演示引擎」，它<b>不会真正翻译</b>——产出的是「原文加前缀」的占位内容。
        请在 <a href="#" onclick="gotoSettings();return false;">设置</a> 中改用「谷歌翻译」或配置 AI 大模型。
      </div>
      <div id="qs-progress-wrap" style="display:none">
        <div class="progress"><i id="qs-bar"></i></div>
        <div style="font-size:12px;color:var(--fg-dim)" id="qs-msg"></div>
      </div>
    </div>
  </div>
</section>

<!-- ==================== 页3：校对台 ==================== -->
<section class="page" id="page-review">
  <div class="card">
    <h3>✎ 人工校对台
      <span class="sub">左边选文件，右边逐条修改译文；改动立即无损写回导出文件</span></h3>
    <!-- v0.3.8：待处理横幅 —— 翻译完成后若有失败/待复核条目，会自动跳到本页
         并把这里打开（见 renderJob 的 needs_review 分支） -->
    <div class="warn-banner" id="rv-pending-banner" style="display:none"></div>
    <!-- v0.3.9 缺陷修复（UI·轻微）：三个筛选复选框此前漏绑 onchange，
         勾选后界面不重绘（要等搜索框输入等其它动作才生效）。而
         rvFocusIssues() 是显式调用 renderReviewEntries() 的，所以"横幅
         链接进去有效、手动勾选无效"——同一功能两种表现。补上绑定即可。 -->
    <div class="row">
      <button class="btn" onclick="reviewLoad()">载入译文文件清单</button>
      <label class="check"><input type="checkbox" id="rv-only-issue" onchange="renderReviewEntries()"> 只看待处理（失败/待复核）</label>
      <label class="check"><input type="checkbox" id="rv-only-new" onchange="renderReviewEntries()"> 只看新增条目</label>
      <label class="check"><input type="checkbox" id="rv-nosrc" onchange="renderReviewEntries()"> 只看缺源条目</label>
      <input id="rv-search" placeholder="搜索原文/译文/键名…" style="flex:1;min-width:180px"
             oninput="renderReviewEntries()">
      <span class="tag" id="rv-count"></span>
    </div>
  </div>
  <div id="review-layout">
    <div class="card" style="margin-bottom:0">
      <h3>译文文件</h3>
      <div class="filelist" id="review-files"><div class="empty">先点击上方按钮载入</div></div>
    </div>
    <div class="card" style="margin-bottom:0">
      <h3>条目对照 <span class="sub" id="rv-file-label"></span></h3>
      <div class="scroll" style="max-height:460px"><table>
        <thead><tr><th style="width:42%">原文</th><th>译文（可直接修改）</th><th style="width:60px">操作</th></tr></thead>
        <tbody id="review-tbody"><tr><td colspan="3" class="empty">选择左侧文件查看条目</td></tr></tbody>
      </table></div>
      <div class="hintbox">红标 <span class="badge err">失败</span> = 译文未产出、文件中仍是原文（鼠标悬停看原因）；
        橙标 <span class="badge new">待复核</span> = 译文已导出但占位符处理存疑，建议人眼确认；
        黄标 <span class="badge new">新增</span> = 上次翻译后 mod 又新增的文案；
        灰条 = 找不到源文件对照（仅显示译文）。校对完成的条目会标记
        <span class="badge ok">已校对</span>（标记保存在浏览器本地）。</div>
    </div>
  </div>
</section>

<!-- ==================== 页4：术语表 ==================== -->
<section class="page" id="page-glossary">
  <div class="card">
    <h3>📖 术语表
      <span class="sub">翻译前受占位符级保护；翻译后强制替换为指定译法</span></h3>
    <div class="hintbox" style="margin-bottom:10px">
      ✅ 已内置 <b id="gl-defaults-count">…</b> 条 MC 标准译名
      （CFPA/中文 Wiki 惯例：<b>Enderman→末影人、Creeper→苦力怕、Nether→下界</b>…），
      <b>无需配置自动生效</b>；下方自定义术语同名时优先于内置。
    </div>
    <div class="scroll"><table>
      <thead><tr><th style="width:42%">原文（英文）</th><th>固定译法（中文）</th><th style="width:60px">操作</th></tr></thead>
      <tbody id="gl-tbody"></tbody>
    </table></div>
    <div class="row" style="margin-top:12px">
      <button class="btn ghost" onclick="glAddRow()">+ 添加术语</button>
      <button class="btn ghost" onclick="glViewDefaults()">查看内置术语</button>
      <button class="btn ghost" onclick="glImportDefaults()">导入内置术语为可编辑</button>
      <button class="btn" onclick="glossarySave()">保存术语表</button>
      <span class="tag" id="gl-count"></span>
    </div>
    <div class="hintbox">
      例：<b>Enderman → 末影人</b>。翻译时术语会先于普通文本被保护起来，
      译文中的术语一律回填/替换为此处指定的译法；同一整合包目录下保存为
      <b>glossary.yaml</b>，可随整合包分发。
    </div>
  </div>
</section>

<!-- ==================== 页5：设置 ==================== -->
<section class="page" id="page-settings">
  <div class="card">
    <h3>⚙ 翻译引擎设置
      <span class="sub">保存到整合包的 .mc-i18n/config.yaml，只对图形界面的翻译任务生效</span></h3>
    <div class="row">
      <label class="f">默认引擎
        <select id="set-engine" style="min-width:260px"></select></label>
      <label class="f">并发线程数 <input id="set-workers" type="number" min="1" max="32"
        placeholder="默认 4" style="width:110px"></label>
    </div>
  </div>

  <div class="card foldable" id="fold-google">
    <h3 class="fold-head" onclick="toggleFold('google')">🇬🇧 谷歌翻译 <span class="tag g">免费 · 无需密钥</span>
      <span class="sub">推荐的默认引擎；国内网络不可直连时可改用镜像地址</span>
      <span class="cfg-tag" id="cfg-google"></span><span class="fold-arrow" id="arr-google">▾</span></h3>
    <div class="fold-body">
    <div class="row">
      <label class="f">接口地址（可换镜像）<input id="set-google-endpoint" class="mono"
        style="flex:1" placeholder="https://translate.googleapis.com/translate_a/single"></label>
      <button class="btn ghost" style="align-self:flex-end" onclick="testEngine('google',this)">🔌 测试连接</button>
    </div>
    <div class="test-result" id="test-google"></div>
    </div>
  </div>

  <div class="card foldable" id="fold-youdao">
    <h3 class="fold-head" onclick="toggleFold('youdao')">🀄 有道翻译 <span class="tag">官方 API</span>
      <span class="sub">国内直连稳定；<a href="https://ai.youdao.com/" target="_blank">有道智云</a> 注册创建应用即可（新用户有免费额度）</span>
      <span class="cfg-tag" id="cfg-youdao"></span><span class="fold-arrow" id="arr-youdao">▾</span></h3>
    <div class="fold-body">
    <div class="row">
      <label class="f">应用 ID <input id="set-youdao-id" placeholder="youdao-app-id"></label>
      <label class="f">应用密钥 <input id="set-youdao-key" type="password" placeholder="应用密钥"></label>
      <button class="btn ghost" style="align-self:flex-end" onclick="testEngine('youdao',this)">🔌 测试连接</button>
    </div>
    <div class="test-result" id="test-youdao"></div>
    </div>
  </div>

  <div class="card foldable" id="fold-baidu">
    <h3 class="fold-head" onclick="toggleFold('baidu')">百度翻译
      <span class="sub">百度翻译开放平台 → 通用文本翻译 API</span>
      <span class="cfg-tag" id="cfg-baidu"></span><span class="fold-arrow" id="arr-baidu">▾</span></h3>
    <div class="fold-body">
    <div class="row">
      <label class="f">APP ID <input id="set-baidu-id" placeholder="2024xxxxx"></label>
      <label class="f">APP KEY <input id="set-baidu-key" type="password" placeholder="密钥"></label>
      <button class="btn ghost" style="align-self:flex-end" onclick="testEngine('baidu',this)">🔌 测试连接</button>
    </div>
    <div class="test-result" id="test-baidu"></div>
    </div>
  </div>

  <div class="card foldable" id="fold-deepl">
    <h3 class="fold-head" onclick="toggleFold('deepl')">DeepL
      <span class="sub">免费版用 api-free.deepl.com，正式版用 api.deepl.com</span>
      <span class="cfg-tag" id="cfg-deepl"></span><span class="fold-arrow" id="arr-deepl">▾</span></h3>
    <div class="fold-body">
    <div class="row">
      <label class="f">API Key <input id="set-deepl-key" type="password" placeholder="xxxx:fx"></label>
      <label class="f">API 域名 <input id="set-deepl-host" placeholder="api-free.deepl.com"></label>
      <button class="btn ghost" style="align-self:flex-end" onclick="testEngine('deepl',this)">🔌 测试连接</button>
    </div>
    <div class="test-result" id="test-deepl"></div>
    </div>
  </div>

  <div class="card foldable" id="fold-openai">
    <h3 class="fold-head" onclick="toggleFold('openai')">🤖 AI 翻译（OpenAI 兼容接口）
      <span class="sub">不想用机翻时的进阶选项：大模型译文更符合 MC 社区行文习惯</span>
      <span class="cfg-tag" id="cfg-openai"></span><span class="fold-arrow" id="arr-openai">▾</span></h3>
    <div class="fold-body">
    <div style="font-size:12px;color:var(--fg-dim);margin-bottom:8px">
      服务商预设（点选自动填充地址与模型，只需再填 API Key）：
    </div>
    <div class="row" style="margin-bottom:12px" id="ai-preset-row">
      <button class="btn ghost preset-btn" data-preset="zhipu">智谱 GLM-4-Flash（免费）</button>
      <button class="btn ghost preset-btn" data-preset="deepseek">DeepSeek</button>
      <button class="btn ghost preset-btn" data-preset="qwen">阿里通义</button>
      <button class="btn ghost preset-btn" data-preset="kimi">Kimi</button>
      <span class="tag">自定义（OpenAI 兼容）</span>
    </div>
    <div class="row">
      <label class="f">API 地址（OpenAI 兼容，含完整路径）<input id="set-openai-url" class="mono"
        placeholder="https://open.bigmodel.cn/api/paas/v4"></label>
      <label class="f">API Key <input id="set-openai-key" type="password" placeholder="对应平台的 Key"></label>
    </div>
    <div class="row" style="margin-top:10px">
      <label class="f">模型名称 <input id="set-openai-model" class="mono"
        placeholder="glm-4-flash"></label>
      <button class="btn ghost" style="align-self:flex-end" onclick="testEngine('openai',this)">🔌 测试连接</button>
    </div>
    <div class="test-result" id="test-openai"></div>
    <div class="hintbox">
      AI 翻译说明：默认只翻译「尚无译文的词条」（已有译文自动跳过，相当于
      <b>补翻</b>模式）；配合术语表可锁定译名风格。密钥仅保存在本机整合包目录内。
    </div>
    </div>
  </div>

  <div class="card">
    <h3>📦 汉化包产出位置
      <span class="sub">默认放到整合包的 resourcepacks 文件夹，启动游戏即可启用；也可自定义到任意位置方便寻找</span></h3>
    <div class="row">
      <label class="check">
        <input type="radio" name="packout-mode" id="set-packout-auto" value="auto" checked
               onchange="updatePackOutUI()"> 默认（整合包 resourcepacks 文件夹，开箱即用）</label>
    </div>
    <div class="row" style="margin-top:6px">
      <label class="check">
        <input type="radio" name="packout-mode" id="set-packout-custom" value="custom"
               onchange="updatePackOutUI()"> 自定义输出位置</label>
    </div>
    <div class="row" id="packout-custom-row" style="margin-top:8px; display:none">
      <input id="set-pack-out" class="mono" style="flex:1"
             placeholder="可填文件夹或 .zip 路径；相对路径以整合包为基准">
      <button class="btn ghost" type="button" onclick="openBrowseForPackOut()">浏览…</button>
    </div>
    <div class="hintbox" style="margin-top:10px" id="packout-hint"></div>
  </div>

  <div class="row">
    <button class="btn big" onclick="settingsSave()">保存设置</button>
    <span style="font-size:12px;color:var(--fg-dim);align-self:center">
      环境变量（BAIDU_APP_ID、YOUDAO_APP_ID 等）优先级高于本页设置；密钥仅保存在本机整合包目录内。</span>
  </div>
</section>
</main>

<!-- ==================== 目录浏览器模态框 ==================== -->
<div class="modal-mask" id="browse-mask">
  <div class="modal">
    <header><b>选择整合包目录</b></header>
    <div class="body">
      <div class="row" style="margin-bottom:10px">
        <input id="browse-input" class="mono" style="flex:1"
               placeholder="输入完整路径后回车，如 C:\Games\Modpacks\MyPack" onkeydown="if(event.key==='Enter')browseGoto()">
        <button class="btn ghost" onclick="browseGoto()">转到</button>
        <button class="btn ghost" id="browse-up" onclick="browseUp()">上级</button>
      </div>
      <div class="dirlist" id="browse-list"></div>
      <div style="font-size:12px;color:var(--fg-dim);margin-top:8px" id="browse-cur"></div>
    </div>
    <footer>
      <button class="btn ghost" onclick="closeBrowse()">取消</button>
      <button class="btn" onclick="confirmBrowse()">选择当前目录</button>
    </footer>
  </div>
</div>

<!-- ==================== 内置术语表查看模态框 ==================== -->
<div class="modal-mask" id="gl-defaults-mask">
  <div class="modal">
    <header><b>内置 MC 标准术语</b>
      <span class="sub" id="gl-defaults-total"></span></header>
    <div class="body">
      <input id="gl-defaults-filter" class="txt" style="width:100%;margin-bottom:8px"
             placeholder="输入关键词过滤，如：末影 / Ender / 附魔" oninput="glDefaultsRender()">
      <div class="dirlist" id="gl-defaults-list" style="max-height:46vh"></div>
      <div style="font-size:12px;color:var(--fg-dim);margin-top:8px">
        这些译名在翻译时<b>自动生效</b>（无需保存到任何文件）；同名自定义术语优先于内置。
        想微调某个译名？点「导入内置术语为可编辑」后再修改保存。
      </div>
    </div>
    <footer>
      <button class="btn ghost" onclick="glImportDefaults()">导入为可编辑</button>
      <button class="btn" onclick="glCloseDefaults()">关闭</button>
    </footer>
  </div>
</div>

<!-- 全站水印：每个工具页右下角 -->
<div class="wm">mc-i18n 汉化工具箱 by WJ1752</div>

<div id="toasts"></div>

<script>
"use strict";
/* ================================================================
   mc-i18n WebUI 前端逻辑（原生 JS，无框架）
   ================================================================ */
const $ = id => document.getElementById(id);
const state = {
  pack: localStorage.getItem("mc_i18n_pack") || "",
  page: "home",
  lastJobDone: null,          // 用于"完成瞬间"触发页面刷新
  reviewFiles: [], reviewMap: {}, reviewRel: "",
  reviewEntries: [],
  glDefaults: {},             // 内置 MC 标准术语（术语表查看弹层数据源）
  scanResult: null,           // v0.3.3：最近一次扫描结果（切页时复用，避免重复扫描）
  scanJobId: null,            // v0.3.3：进行中的扫描任务 id
  engine: "google",           // v0.3.7：当前引擎（由设置页同步，工作台只读回显）
  /* ---- v0.3.8 ---- */
  streamSeq: 0,               // 实时译文流游标（/api/status?since=）
  streamJobId: null,          // 译文流当前归属的任务 id（换任务即清空）
  reviewFocus: false,         // 进校对台时是否自动聚焦"有待处理条目"的文件
  reviewPendingTotal: 0,      // 上次报告里待人工处理的条目总数
};

/* ---------- 通用 ---------- */
function esc(s){ return String(s??"").replace(/[&<>"']/g,
  c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

function toast(msg, cls){
  const el = document.createElement("div");
  el.className = "toast " + (cls||"");
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(()=>{ el.style.opacity="0"; el.style.transition="opacity .3s";
    setTimeout(()=>el.remove(), 320); }, cls==="err"?6000:3200);
}

async function api(path, params){
  // params 存在 → POST JSON；否则 GET query
  const opt = params !== undefined
    ? {method:"POST", headers:{"Content-Type":"application/json"},
       body: JSON.stringify(params||{})}
    : {};
  const url = params !== undefined ? path : path;
  let res;
  try { res = await fetch(url, opt); }
  catch(e){ throw new Error("无法连接本地服务（服务可能已关闭）"); }
  let data;
  try { data = await res.json(); }
  catch(e){ throw new Error("服务返回了无法解析的内容 (HTTP " + res.status + ")"); }
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

/* ---------- 页面切换 ---------- */
document.querySelectorAll("#nav button").forEach(btn=>{
  btn.onclick = ()=> showPage(btn.dataset.page);
});
function showPage(name){
  state.page = name;
  document.querySelectorAll("#nav button").forEach(b=>
    b.classList.toggle("active", b.dataset.page===name));
  document.querySelectorAll(".page").forEach(p=>
    p.classList.toggle("active", p.id==="page-"+name));
  // 切页时刷新对应数据
  if (name==="home")  { if (state.pack) doScan(true); updateOutHint(); }
  // v0.3.8 方案A：进入任务书页也同步引擎回显，避免 state.engine 陈旧导致回显与配置不一致
  if (name==="quests"){ if (state.pack){ settingsLoad(); questsScan(); } }
  if (name==="review"){ reviewLoad(); }
  if (name==="glossary"){ glossaryLoad(); }
  if (name==="settings"){ settingsLoad(); }
}

/* ---------- 目录浏览器 ---------- */
let browsePath = "";
let browseConfirmCb = null;   // 选择目录后的回调（默认=设为整合包；输出位置选择复用）
function openBrowse(cb){
  browseConfirmCb = (typeof cb === "function") ? cb : null;
  $("browse-mask").classList.add("show");
  $("browse-input").value = state.pack || "";
  browseGoto(state.pack || "");
}
function closeBrowse(){ $("browse-mask").classList.remove("show"); }
async function browseGoto(path){
  try{
    const d = await api("/api/browse?path=" + encodeURIComponent(path??$("browse-input").value));
    browsePath = d.path || "";
    $("browse-input").value = browsePath;
    $("browse-cur").textContent = browsePath ? ("当前：" + browsePath) : "请选择盘符";
    $("browse-up").style.display = d.parent ? "" : "none";
    browseUpTarget = d.parent;
    const rootDiv = $("browse-list"); rootDiv.innerHTML = "";
    (d.roots||[]).forEach(r=>{
      const el = document.createElement("div");
      el.className="diritem"; el.innerHTML = "<span>💾 磁盘 "+esc(r)+"</span>";
      el.onclick = ()=> browseGoto(r);
      rootDiv.appendChild(el);
    });
    (d.dirs||[]).forEach(dir=>{
      const el = document.createElement("div");
      el.className="diritem";
      el.innerHTML = "<span>📁 "+esc(dir.name)+"</span>" +
        (dir.hint ? '<span class="hint">'+esc(dir.hint)+"</span>" : "");
      el.onclick = ()=> browseGoto(browsePath ? (browsePath.replace(/[\\\/]+$/,"") + "/" + dir.name) : dir.name);
      rootDiv.appendChild(el);
    });
    if (!(d.dirs||[]).length && !(d.roots||[]).length)
      rootDiv.innerHTML = '<div class="empty">此目录没有子目录</div>';
  }catch(e){ toast(e.message, "err"); }
}
let browseUpTarget = null;
function browseUp(){ if (browseUpTarget!==null) browseGoto(browseUpTarget); }
async function confirmBrowse(){
  if (!browsePath){ toast("请先选择目录", "err"); return; }
  // v0.3.3：已选择整合包时，改选其它目录先确认替换（取消则留在浏览器）
  if (browsePath !== state.pack && !confirmReplacePack()) return;
  closeBrowse();
  if (browseConfirmCb){ browseConfirmCb(browsePath); return; }
  // 默认行为：选择整合包目录
  state.pack = browsePath;
  localStorage.setItem("mc_i18n_pack", state.pack);
  state.scanResult = null;      // 换包后旧扫描结果作废（v0.3.3 扫描缓存）
  applyPackChip();
  toast("已选择整合包：" + state.pack.split(/[\\\/]/).pop(), "");
  showPage(state.page);       // 刷新当前页数据
}

/* ---------- 汉化包产出位置（v0.2.8） ---------- */
function openBrowseForPackOut(){
  openBrowse((path)=>{
    $("set-packout-custom").checked = true;
    $("set-pack-out").value = path;
    updatePackOutUI();
    toast("汉化包输出位置：" + path, "info");
  });
}
function updatePackOutUI(){
  const custom = $("set-packout-custom").checked;
  $("packout-custom-row").style.display = custom ? "" : "none";
  if (!custom) $("set-pack-out").value = "";
  const tgt = ($("tr-dst") && $("tr-dst").value.trim()) || "zh_cn";
  const base = state.pack || "<整合包>";
  if (custom){
    $("packout-hint").innerHTML = "将输出到你指定的位置：以 <b>.zip</b> 结尾生成单文件压缩包，"
      + "否则生成文件夹资源包（相对路径以整合包为基准）。";
  } else {
    $("packout-hint").innerHTML = "默认输出到：<b class='mono'>" + esc(base)
      + "/resourcepacks/mc-i18n-" + esc(tgt) + "/</b><br>"
      + "放入整合包后启动游戏即可在资源包列表直接启用，无需手动搬运。";
  }
  updateOutHint();
}
// 工作台翻译卡片下方：实时显示汉化包将落地到哪里
function updateOutHint(){
  const el = $("tr-out-hint");
  if (!el) return;
  const custom = $("set-packout-custom") && $("set-packout-custom").checked;
  if (custom && $("set-pack-out").value.trim()){
    el.innerHTML = "汉化包将输出到：<b class='mono'>" + esc($("set-pack-out").value.trim()) + "</b>";
  } else {
    const tgt = ($("tr-dst") && $("tr-dst").value.trim()) || "zh_cn";
    const base = state.pack || "整合包";
    el.innerHTML = "汉化包默认落到 <b class='mono'>" + esc(base)
      + "/resourcepacks/mc-i18n-" + esc(tgt) + "/</b>（开箱即用）";
  }
}
function applyPackChip(){
  $("pack-chip").style.display = state.pack ? "flex" : "none";
  $("pack-path").textContent = state.pack;
  $("pack-path").title = state.pack;
  updateDropzoneState();      // v0.3.3：拖拽区同步反映"已选择"状态
}

/* ---------- 拖拽区已选状态（v0.3.3） ----------
   选中整合包后拖拽区切换为"已选"态：绿实线框 + 包名 + 完整路径 +
   更换提示；未选择时保持初始虚线引导态。让"到底选没选上、
   再拖一个会怎样"一眼可读，不再只靠顶栏小字。 */
function updateDropzoneState(){
  const dz = $("home-dropzone");
  if (!dz) return;
  const big = $("dz-big"), desc = $("dz-desc"), sub = $("dz-sub");
  const old = document.getElementById("dz-path-line");
  if (old) old.remove();
  if (state.pack){
    const name = state.pack.split(/[\\\/]/).pop() || state.pack;
    dz.classList.add("picked");
    big.textContent = "✅ 已选择：" + name;
    desc.innerHTML = "拖入新的整合包 / 模组文件可<b>替换</b>当前选择（会先弹出确认）";
    sub.textContent = "路径不对？点上方「选择整合包目录…」重新选择";
    const line = document.createElement("div");
    line.className = "picked-path mono";
    line.id = "dz-path-line";
    line.textContent = state.pack;
    line.title = state.pack;
    dz.insertBefore(line, desc);   // 顺序：big → path → desc → sub
  } else {
    dz.classList.remove("picked");
    big.textContent = "📦 拖拽整合包 / 模组到此处";
    desc.textContent = "支持：CurseForge 整合包 .zip（含 manifest.json） | Modrinth 整合包 .mrpack | 直接拖多个 .jar 或整个 mods 文件夹";
    sub.textContent = "也可以点击选择文件";
  }
}
/* 已选择整合包时，替换前先向用户确认（拖拽 / 选目录 / 点选文件共用）。
   返回 true = 继续替换；false = 用户取消。首次选择（无已有包）不询问。 */
function confirmReplacePack(){
  if (!state.pack) return true;
  const name = state.pack.split(/[\\\/]/).pop() || state.pack;
  return confirm("当前已选择整合包：" + name + "\n要替换为新选择的内容吗？\n（替换后会自动重新扫描）");
}

/* ---------- 拖拽上传 ---------- */
function dropZoneEnter(e){ e.preventDefault(); $("home-dropzone").classList.add("drag"); }
function dropZoneOver(e){ e.preventDefault(); }
function dropZoneLeave(e){ $("home-dropzone").classList.remove("drag"); }
function dropZoneDrop(e){
  e.preventDefault();
  $("home-dropzone").classList.remove("drag");
  if (!confirmReplacePack()) return;   // v0.3.3：已选包时拖入新内容先确认替换
  const items = e.dataTransfer.items;
  if (!items) return dropFiles(e.dataTransfer.files);
  // 浏览器拖拽文件夹时，需要 webkitGetAsEntry 递归读取
  const entries = Array.from(items).map(i => i.webkitGetAsEntry()).filter(Boolean);
  collectEntries(entries).then(files => uploadFiles(files));
}
async function collectEntries(entries){
  const out = [];
  await Promise.all(entries.map(async entry => {
    if (entry.isFile) {
      out.push(await new Promise((res,rej)=> entry.file(f=>res(f), rej)));
    } else if (entry.isDirectory) {
      await readDir(entry.createReader(), entry.fullPath, out);
    }
  }));
  return out;
}
async function readDir(reader, path, out){
  const entries = await new Promise((res,rej)=> reader.readEntries(res, rej));
  await Promise.all(entries.map(async entry => {
    if (entry.isFile) {
      out.push(await new Promise((res,rej)=> entry.file(f=>res(f), rej)));
    } else if (entry.isDirectory) {
      await readDir(entry.createReader(), entry.fullPath, out);
    }
  }));
}
function dropFiles(fileList){
  if (!fileList || !fileList.length) return;
  if (!confirmReplacePack()) return;   // v0.3.3：已选包时点选新文件先确认替换
  uploadFiles(Array.from(fileList));
}
async function uploadFiles(files){
  // 过滤：只传允许的文件类型
  const allowed = files.filter(f =>
    /\.(zip|mrpack|jar|json|lang|snbt|txt|toml|cfg|ini|yaml|yml|md|mcmeta)$/i.test(f.name) ||
    f.name.toLowerCase() === "manifest.json"
  );
  if (!allowed.length){ toast("没有可识别的文件（支持 .zip / .mrpack / .jar / .json / .lang 等）", "err"); return; }
  const form = new FormData();
  allowed.forEach(f => form.append("files", f, f.name));
  toast("正在解析上传文件…", "");
  try{
    const d = await fetch("/api/upload", {method: "POST", body: form}).then(r => r.json());
    if (d.error) throw new Error(d.error);
    state.pack = d.pack;
    localStorage.setItem("mc-i18n_pack", state.pack);
    state.scanResult = null;      // 新上传的包：旧扫描结果作废（v0.3.3）
    applyPackChip();
    toast(`已加载：${d.name}（${d.kind === "curseforge" ? "CurseForge" : d.kind === "modrinth" ? "Modrinth" : "文件集合"}）`, "");
    showPage("home");
    doScan(true);
  }catch(e){ toast(e.message || "上传失败", "err"); }
}

/* ---------- 任务轮询（每秒） ---------- */
let pollTimer = setInterval(pollStatus, 1000);
let pollBusy = false;
async function pollStatus(){
  if (pollBusy) return; pollBusy = true;
  try{
    // v0.3.8：带上译文流游标 —— 只取新增条目，轮询载荷与产出成正比
    const d = await api("/api/status?since=" + (state.streamSeq|0));
    $("ver").textContent = "v" + d.version;
    renderJob(d.job);
  }catch(e){ /* 服务未就绪时静默 */ }
  pollBusy = false;
}
function fmtDur(sec){
  if (sec==null || !isFinite(sec)) return "";
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return sec + " 秒";
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return m + " 分" + (s ? " " + s + " 秒" : "");
  return Math.floor(m / 60) + " 时 " + (m % 60) + " 分";
}
/* v0.3.8：把逐条译文增量渲染进译文流面板（按 seq 去重，只追加新行） */
function renderStream(job){
  const box = $("tr-stream");
  const items = job.recent || [];
  if (items.length){
    const frag = document.createDocumentFragment();
    items.forEach(e=>{
      const row = document.createElement("div");
      row.className = "srow" + (e.failed ? " bad" : (e.review ? " warn" : ""));
      let tail = "";
      if (e.failed) tail = '<span class="badge err" title="' + esc(e.failed) + '">失败</span>';
      else if (e.review) tail = '<span class="badge new" title="' + esc(e.review) + '">待复核</span>';
      else if (e.cached) tail = '<span class="badge dim">缓存</span>';
      row.innerHTML = '<i class="mk">' + (e.failed ? "✗" : (e.review ? "⚠" : (e.cached ? "▣" : "✓"))) +
        '</i><span class="src">' + esc(e.src) + '</span><span class="arw">→</span>' +
        '<span class="dst">' + esc(e.ok ? e.dst : (e.failed || "（未产出译文）")) + '</span>' + tail;
      frag.appendChild(row);
    });
    box.appendChild(frag);
    // 只保留最近 400 行：长任务（几万条）下 DOM 不能无限增长
    while (box.childElementCount > 400) box.removeChild(box.firstChild);
    if ($("tr-stream-autoscroll").checked) box.scrollTop = box.scrollHeight;
  }
  $("tr-stream-stat").textContent = job.entry_seq
    ? ("已产出 " + job.entry_seq + " 条 · 显示最近 " + box.childElementCount + " 条") : "";
}
/* v0.3.8：预计用时 / 速率 展示 */
function renderEta(job){
  const rateEl = $("tr-rate"), etaEl = $("tr-eta"), elEl = $("tr-elapsed");
  if (job.rate){ rateEl.textContent = job.rate.toFixed(1) + " 条/秒"; rateEl.style.display = ""; }
  else rateEl.style.display = "none";
  let etaTxt = "";
  if (job.eta_total_sec != null) etaTxt = "预计剩余 " + fmtDur(job.eta_total_sec);
  else if (job.eta_sec != null)  etaTxt = "本阶段约剩 " + fmtDur(job.eta_sec);
  else if (job.stage === "scan" || job.stage === "collect") etaTxt = "预计用时：估算中…";
  if (etaTxt){ etaEl.textContent = etaTxt; etaEl.style.display = ""; }
  else etaEl.style.display = "none";
  if (job.elapsed != null){
    elEl.textContent = "已用 " + fmtDur(job.elapsed) +
      (job.units && job.units.total ? "　" + job.units.done + "/" + job.units.total : "");
    elEl.style.display = "";
  } else elEl.style.display = "none";
}
function renderJob(job){
  const pill = $("job-pill");
  if (!job || job.status!=="running"){ pill.style.display="none"; }
  else{
    pill.style.display="flex"; pill.classList.remove("err");
    $("job-pill-txt").textContent = job.label + " " + Math.round(job.progress) + "%";
    $("job-pill-bar").style.width = job.progress + "%";
  }
  // 完成瞬间：toast + 刷新对应页面
  if (job && job.status!=="running" && state.lastJobDone !== job.id){
    state.lastJobDone = job.id;
    if (job.status==="done"){
      toast(job.summary && job.summary.cancelled
            ? "已手动停止：已翻译的部分照常导出；重新点「开始翻译」会自动续翻（缓存命中，不再花配额）"
            : job.message, "");
      const s = job.summary || {};
      if (job.kind==="translate"){
        showReportSummary(s);
        alertLog(job, false);
        // v0.3.8：有失败/待复核条目 → 直接把人送到校对台（不必自己去点导航）
        const pending = (s.pending_review||0) + (s.failed_entries||0);
        if (pending > 0){
          const why = [];
          if (s.failed_entries)   why.push(s.failed_entries + " 条翻译失败（仍是原文）");
          if (s.pending_review)   why.push(s.pending_review + " 条待人工复核");
          state.reviewFocus = true;
          showPage("review");
          toast("共 " + pending + " 条需要人工处理（" + why.join("、") + "），已打开校对台", "err");
        }
      }
      if (job.kind==="quests") alertLog(job, false);
      if (job.kind==="scan" && job.id===state.scanJobId){
        state.scanJobId = null;
        applyScanResult(s);       // v0.3.3：扫描结果渲染进工作台
      }                           //（完成提示由上方通用 toast 显示 job.message）
    } else if (job.status==="error"){
      toast(job.message, "err");
      if (job.kind==="scan" && job.id===state.scanJobId){
        state.scanJobId = null;
        $("home-pack-hint").textContent = "扫描失败";
      }
      alertLog(job, true);
    }
  }
  // 运行中：同步进度到当前页的进度条/日志/译文流
  if (job && job.status==="running"){
    if (job.kind==="translate"){
      if (state.streamJobId !== job.id){    // 换任务 → 译文流从头开始
        state.streamJobId = job.id;
        state.streamSeq = 0;
        $("tr-stream").innerHTML = "";
      }
      $("tr-progress-wrap").style.display="";
      $("tr-bar").style.width = job.progress+"%";
      $("tr-msg").textContent = job.message;
      renderEta(job);
      $("tr-stream-wrap").style.display = "";
      renderStream(job);
      $("btn-translate").disabled = true;
      $("btn-stop").style.display = "";      // 翻译运行中 → 显示停止按钮
      alertLog(job, false, true);
    }
    if (job.kind==="quests"){
      $("qs-progress-wrap").style.display="";
      $("qs-bar").style.width = job.progress+"%";
      $("qs-msg").textContent = job.message;
      $("btn-quests").disabled = true;
      alertLog(job, false, true);
    }
    if (job.kind==="scan" && job.id===state.scanJobId){
      // 扫描进度（v0.3.3）：提示行跟随轮询实时刷新，可观察是否卡住
      $("home-pack-hint").textContent = job.message + "（" +
        Math.round(job.progress) + "%）";
    }
  }
  if (!job || job.status!=="running"){ $("btn-translate").disabled=false; $("btn-quests").disabled=false; $("btn-stop").style.display="none"; }
  // 游标推进：只认服务端最新 seq，绝不回退（回退会导致重复追加）
  if (job && job.entry_seq != null && job.entry_seq > state.streamSeq){
    state.streamSeq = job.entry_seq;
  }
}

async function stopTranslate(){
  try{
    const d = await api("/api/cancel", {});
    toast(d.message || "停止请求已发出", "");
  }catch(e){ toast(e.message || e, "err"); }
}
function alertLog(job, isErr, keepSize){
  const box = $("logbox");
  if (state.page!=="home" && state.page!=="quests") return;
  box.style.display = job.logs.length ? "block" : box.style.display;
  const prev = keepSize ? box.dataset.count||0 : 0;
  const lines = job.logs.slice(prev);
  if (lines.length){
    const frag = document.createElement("div");
    frag.innerHTML = lines.map(l=>esc(l)).join("\n");
    if (isErr) frag.innerHTML += "";
    box.appendChild(document.createTextNode(lines.join("\n") + "\n"));
    box.dataset.count = job.logs.length;
    box.scrollTop = box.scrollHeight;
  }
}

/* ---------- 工作台 ---------- */
/* v0.3.3：扫描异步化。POST /api/scan 立即返回，进度经 /api/status 轮询
   （renderJob 的 scan 分支），完成后从 job.summary 渲染统计卡片。
   applyScanResult：把扫描结果渲染到工作台（done 回调与缓存复用共用）。 */
function applyScanResult(d){
  state.scanResult = d;
  $("home-scan").style.display = "";
  $("st-files").textContent = d.stats.language_files;
  $("st-src").textContent = d.stats.source_candidates;
  $("st-entries").textContent = d.stats.total_entries;
  $("st-quests").textContent = d.quest_entries;
  $("home-pack-hint").textContent =
    state.pack.split(/[\\\/]/).pop() + "（" + d.stats.language_files + " 个语言文件）";
  loadReport();
}
async function doScan(silent, force){
  if (!state.pack){ $("home-pack-hint").textContent = "先选择整合包目录"; return; }
  // 切页复用：同一整合包已有扫描结果且不在扫描中 → 直接渲染缓存，不重扫
  // （「重新扫描」按钮传 force=true 跳过缓存强制重扫）
  if (state.scanResult && !state.scanJobId && !force){
    applyScanResult(state.scanResult);
    if (!silent) toast("扫描完成：" + state.scanResult.stats.source_candidates +
      " 个源文件 / " + state.scanResult.stats.total_entries + " 条目", "");
    return;
  }
  if (state.scanJobId) return;        // 扫描进行中：轮询会接管 UI，不重复发起
  $("home-pack-hint").textContent = "扫描中…";
  try{
    const d = await api("/api/scan", {pack: state.pack, include_quests: true,
      source_lang: $("tr-src").value.trim()||"en_us",
      target_lang: $("tr-dst").value.trim()||"zh_cn"});
    if (!d.started){
      // 任务槽被占（如翻译运行中切页）：不算失败，静默跳过等下次手动扫描
      if (!silent) toast(d.message || "当前有任务运行中，暂无法开始扫描", "err");
      $("home-pack-hint").textContent = "有任务运行中，暂缓扫描";
      return;
    }
    state.scanJobId = d.job.id;       // 后续由 renderJob 轮询接管
  }catch(e){ $("home-pack-hint").textContent = "扫描失败"; toast(e.message, "err"); }
}

async function doTranslate(){
  if (!state.pack){ toast("请先选择整合包目录", "err"); return; }
  // v0.3.7 方案A：引擎不再从工作台读——由设置页持久化到 config.yaml，
  // 后端按 "请求参数 → config.engine.primary" 解析，这里传 state.engine
  // 仅作为"用户刚刚在设置页确认过的值"的冗余传递。
  if (state.engine === "demo"){
    toast("当前是演示引擎，不会真正翻译；请先到设置页选择引擎", "err");
    gotoSettings();
    return;
  }
  $("logbox").textContent=""; boxReset(); boxResetStream();
  const custom = $("set-packout-custom").checked;
  try{
    const d = await api("/api/translate", {
      pack: state.pack,
      engine: state.engine || "",
      source_lang: $("tr-src").value.trim()||"en_us",
      target_lang: $("tr-dst").value.trim()||"zh_cn",
      use_glossary: $("tr-glossary").checked,
      pack_zip: $("tr-zip").checked,
      skip_existing: ($("tr-existing-policy").value||"skip")==="skip",
      existing_policy: $("tr-existing-policy").value||"skip",
      pack_out: custom ? ($("set-pack-out").value.trim()||"") : "",
    });
    if (!d.started) toast(d.message, "err");
    else toast("翻译任务已启动", "info");
  }catch(e){ toast(e.message, "err"); }
}
function boxReset(){ const b=$("logbox"); b.textContent=""; b.dataset.count=0; }
/* v0.3.8：清空实时译文流（开始新任务前调用；游标一并归零） */
function boxResetStream(){
  state.streamSeq = 0; state.streamJobId = null;
  $("tr-stream").innerHTML = "";
  $("tr-stream-stat").textContent = "";
  $("tr-stream-wrap").style.display = "none";
  $("tr-rate").style.display = "none";
  $("tr-eta").style.display = "none";
  $("tr-elapsed").style.display = "none";
}

async function doPack(){
  if (!state.pack){ toast("请先选择整合包目录", "err"); return; }
  const custom = $("set-packout-custom").checked;
  try{
    const d = await api("/api/pack", {
      pack: state.pack,
      target_lang: $("tr-dst").value.trim()||"zh_cn",
      pack_out: custom ? ($("set-pack-out").value.trim()||"") : "",
    });
    toast("资源包已生成（" + d.files + " 个文件）：" + d.zip, "");
  }catch(e){ toast(e.message, "err"); }
}

async function loadReport(){
  if (!state.pack) return;
  try{
    const d = await api("/api/report?pack=" + encodeURIComponent(state.pack));
    if (d.report) showReportSummary(d.report.stats, d.report.finished_at, d.report.engine);
  }catch(e){ /* 无报告时静默 */ }
}
function showReportSummary(s, when, engine){
  if (!s || !s.entries_translated && !s.files_total) return;
  $("report-card").style.display = "";
  $("rp-entries").textContent = s.entries_translated ?? 0;
  $("rp-cache").textContent = s.entries_from_cache ?? 0;
  $("rp-fail").textContent = s.entries_failed ?? 0;
  $("rp-new").textContent = s.entries_new ?? 0;
  $("report-time").textContent = (when ? ("完成于 " + when + " · ") : "") +
    (s.duration_sec!=null ? ("耗时 " + s.duration_sec + "s") : "");
  const bits = [];
  if (s.files_total!=null) bits.push("文件 " + s.files_ok + "/" + s.files_total + " 成功");
  if (s.files_skipped_existing) bits.push("已有中文跳过 " + s.files_skipped_existing + " 个（未覆盖）");
  if (s.api_calls!=null) bits.push("API 调用 " + s.api_calls + " 次 / " + (s.chars_sent||0) + " 字符");
  if (s.zip) bits.push("资源包：" + s.zip);
  $("rp-extra").textContent = bits.join(" · ");
}

/* ---------- 任务书页 ---------- */
async function questsScan(){
  if (!state.pack) return;
  try{
    const d = await api("/api/quests/scan", {pack: state.pack});
    $("quests-result").style.display = "";
    $("quests-total").textContent = d.files.length + " 个文件 / " + d.total_entries + " 条可翻译";
    const tb = $("quests-tbody"); tb.innerHTML = "";
    d.files.forEach(f=>{
      const tr = document.createElement("tr");
      tr.innerHTML = '<td class="mono" style="font-size:12px">'+esc(f.path)+"</td>" +
        "<td>"+f.count+"</td>";
      tb.appendChild(tr);
    });
    if (!d.files.length)
      tb.innerHTML = '<tr><td colspan="2" class="empty">未找到 .snbt 文件（config/ftbquests/quests/chapters/）</td></tr>';
  }catch(e){ toast(e.message, "err"); }
}
async function doQuestsTranslate(){
  if (!state.pack){ toast("请先选择整合包目录", "err"); return; }
  // v0.3.8 方案A：引擎不再从任务书页读（与工作台对齐）——设置页是唯一真相源。
  // 与工作台一致，传 state.engine 仅作冗余传递；后端 _resolve_engine_name()
  // 按「请求参数 → config.engine.primary → demo」解析。
  if (state.engine === "demo"){
    toast("当前是演示引擎，不会真正翻译；请先到设置页选择引擎", "err");
    gotoSettings();
    return;
  }
  $("logbox").textContent=""; boxReset();
  try{
    const d = await api("/api/quests/translate", {pack: state.pack, engine: state.engine || ""});
    if (!d.started) toast(d.message, "err");
    else toast("任务书翻译已启动", "info");
  }catch(e){ toast(e.message, "err"); }
}
function loadQuestsDefaults(){ toast("语言方向跟随工作台设置（en → zh）", "info"); }

/* ---------- 校对台 ---------- */
async function reviewLoad(){
  if (!state.pack) return;
  // v0.3.8：翻译完成后自动跳进来时，focus=true → 自动选中"有待处理条目"的文件
  const focus = state.reviewFocus; state.reviewFocus = false;
  try{
    const d = await api("/api/review/files?pack=" + encodeURIComponent(state.pack));
    state.reviewFiles = d.files; state.reviewMap = d.source_map;
    state.reviewPendingTotal = d.pending_total || 0;
    renderPendingBanner(d.pending_total || 0);
    const box = $("review-files");
    if (!d.files.length){
      box.innerHTML = '<div class="empty">还没有译文。<br>先在工作台完成一次翻译。</div>';
      return;
    }
    box.innerHTML = "";
    d.files.forEach(f=>{
      const el = document.createElement("div");
      el.className = "fileitem" + (f.rel===state.reviewRel ? " sel" : "");
      const pending = f.pending || 0;
      el.innerHTML = esc(f.rel) +
        (pending ? '<span class="badge err">待处理 ' + pending + '</span>' :
         (state.reviewMap[f.rel] ? "" : '<span class="no-map">无对照</span>'));
      el.onclick = ()=> reviewSelect(f.rel, el);
      box.appendChild(el);
    });
    // 选中目标：优先"有待处理条目"的文件 → 上次选中的文件 → 第一个
    let target = null;
    if (focus) target = d.files.find(f => (f.pending || 0) > 0) || null;
    if (!target && state.reviewRel) target = d.files.find(f => f.rel === state.reviewRel) || null;
    if (!target && d.pending_total) target = d.files.find(f => (f.pending || 0) > 0) || null;
    if (!target) target = d.files[0];
    if (target) await reviewSelect(target.rel, box.children[d.files.indexOf(target)]);
  }catch(e){ toast(e.message, "err"); }
}
/* v0.3.8：待处理横幅（"只看待处理"一键过滤 + 说明为什么跳到这里） */
function renderPendingBanner(total){
  const el = $("rv-pending-banner");
  if (!total){ el.style.display = "none"; return; }
  el.style.display = "";
  el.innerHTML = '⚠️ 上次翻译有 <b>' + total + '</b> 条需要人工处理（翻译失败＝文件里仍是原文；' +
    '待复核＝译文已导出但占位符存疑）。' +
    '<a href="#" onclick="rvFocusIssues();return false;">只看这些条目 ›</a>';
}
function rvFocusIssues(){
  $("rv-only-issue").checked = true;
  $("rv-only-new").checked = false;
  $("rv-nosrc").checked = false;
  renderReviewEntries();
  const c = $("rv-count").textContent;
  toast("已筛选出待处理条目（" + c + "）", "");
}
async function reviewSelect(rel, el){
  document.querySelectorAll(".fileitem").forEach(x=>x.classList.remove("sel"));
  el.classList.add("sel");
  state.reviewRel = rel;
  $("rv-file-label").textContent = rel;
  try{
    const d = await api("/api/review/entries?pack=" + encodeURIComponent(state.pack) +
      "&rel=" + encodeURIComponent(rel));
    state.reviewEntries = d.entries;
    renderReviewEntries();
  }catch(e){ toast(e.message, "err"); }
}
function renderReviewEntries(){
  const tb = $("review-tbody");
  const kw = ($("rv-search").value||"").toLowerCase();
  const onlyNew = $("rv-only-new").checked, onlyNoSrc = $("rv-nosrc").checked;
  const onlyIssue = $("rv-only-issue").checked;      // v0.3.8
  const rows = state.reviewEntries.filter(e=>{
    if (onlyIssue && !e.failed && !e.need_review) return false;
    if (onlyNew && !e.is_new) return false;
    if (onlyNoSrc && !e.not_in_source) return false;
    if (kw && !(e.key+"\n"+e.source+"\n"+e.translated).toLowerCase().includes(kw)) return false;
    return true;
  });
  const issueCount = state.reviewEntries.filter(e=> e.failed || e.need_review).length;
  $("rv-count").textContent = rows.length + " / " + state.reviewEntries.length + " 条" +
    (issueCount ? "（待处理 " + issueCount + "）" : "");
  tb.innerHTML = "";
  rows.forEach((e, idx)=>{
    const reviewedKey = "rv|" + state.pack + "|" + state.reviewRel + "|" + e.key;
    const reviewed = localStorage.getItem(reviewedKey) === "1";
    const tr = document.createElement("tr");
    // v0.3.8：待处理条目整行标红/标橙，并带上原因（鼠标悬停可见）
    if (e.failed) tr.className = "row-bad";
    else if (e.need_review) tr.className = "row-warn";
    const marks =
      (e.failed ? '<span class="badge err" title="' + esc(e.fail_reason || "") + '">失败·保留原文</span>' : "") +
      (e.need_review ? '<span class="badge new" title="' + esc(e.review_reason || "") + '">待复核</span>' : "");
    tr.innerHTML =
      '<td><div class="src mono" style="font-size:12px">'+esc(e.source)+
        '<span style="color:#4a5560"> · '+esc(e.key)+"</span></div>" +
        (marks ? '<div style="margin-top:3px">'+marks+"</div>" : "") + "</td>" +
      '<td><input class="txt" data-idx="'+state.reviewEntries.indexOf(e)+'" value="'+
        esc(e.translated)+'"></td>' +
      '<td><button class="btn ghost" style="padding:3px 10px;font-size:12px" '+
        'onclick="reviewSave(this,'+state.reviewEntries.indexOf(e)+')">保存</button>'+
        (reviewed ? '<span class="badge ok">已校对</span>' : "") +
        (e.is_new ? '<span class="badge new">新增</span>' : "") + "</td>";
    tb.appendChild(tr);
  });
  if (!rows.length)
    tb.innerHTML = '<tr><td colspan="3" class="empty">没有匹配的条目</td></tr>';
}
async function reviewSave(btn, idx){
  const e = state.reviewEntries[idx];
  const input = btn.closest("tr").querySelector("input.txt");
  try{
    await api("/api/review/save", {pack: state.pack, rel: state.reviewRel,
      key: e.key, value: input.value});
    e.translated = input.value;
    localStorage.setItem("rv|"+state.pack+"|"+state.reviewRel+"|"+e.key, "1");
    toast("已保存：" + e.key, "");
    renderReviewEntries();
  }catch(err){ toast(err.message, "err"); }
}

/* ---------- 术语表 ---------- */
async function glossaryLoad(){
  if (!state.pack){ $("gl-tbody").innerHTML = '<tr><td colspan="3" class="empty">先选择整合包目录</td></tr>'; return; }
  try{
    const d = await api("/api/glossary?pack=" + encodeURIComponent(state.pack));
    state.glDefaults = d.defaults || {};          // 内置术语（查看弹层数据源）
    $("gl-defaults-count").textContent = d.defaults_count || Object.keys(state.glDefaults).length;
    $("gl-defaults-total").textContent = "共 " + (d.defaults_count || Object.keys(state.glDefaults).length) + " 条";
    const tb = $("gl-tbody"); tb.innerHTML = "";
    Object.entries(d.terms||{}).forEach(([k,v])=> glAddRow(k, v));
    if (!Object.keys(d.terms||{}).length) glAddRow();
    glCount();
  }catch(e){ toast(e.message, "err"); }
}
/* 内置术语查看弹层：关键词过滤 + 只读列表（原文 → 译名） */
function glViewDefaults(){ $("gl-defaults-mask").classList.add("show"); $("gl-defaults-filter").value=""; glDefaultsRender(); }
function glCloseDefaults(){ $("gl-defaults-mask").classList.remove("show"); }
function glDefaultsRender(){
  const kw = ($("gl-defaults-filter").value || "").toLowerCase();
  const box = $("gl-defaults-list"); box.innerHTML = "";
  const entries = Object.entries(state.glDefaults || {})
    .filter(([k,v]) => !kw || k.toLowerCase().includes(kw) || v.includes(kw));
  if (!entries.length){ box.innerHTML = '<div class="empty">没有匹配的术语</div>'; return; }
  entries.forEach(([k,v])=>{
    const row = document.createElement("div");
    row.className = "diritem";
    row.style.cursor = "default";
    row.innerHTML = '<span class="mono">' + esc(k) + '</span>' +
      '<span><span style="color:var(--fg-dim);margin-right:8px">→</span>' + esc(v) + '</span>';
    box.appendChild(row);
  });
}
/* 把内置术语合并导入为可编辑条目：已有键不覆盖（用户改过的译法不丢） */
async function glImportDefaults(){
  if (!state.pack){ toast("请先选择整合包目录", "err"); return; }
  try{
    const d = await api("/api/glossary/import_defaults", {pack: state.pack});
    toast("已导入内置术语（本次新增 " + d.added + " 条，共 " + d.count + " 条）", "");
    glCloseDefaults();
    glossaryLoad();
  }catch(e){ toast(e.message, "err"); }
}
function glAddRow(k, v){
  const tb = $("gl-tbody");
  const tr = document.createElement("tr");
  tr.innerHTML = '<td><input class="txt gl-k" value="'+esc(k||"")+'" placeholder="Enderman"></td>' +
    '<td><input class="txt gl-v" value="'+esc(v||"")+'" placeholder="末影人"></td>' +
    '<td><button class="btn danger" style="padding:3px 10px;font-size:12px" onclick="this.closest(\'tr\').remove();glCount()">删除</button></td>';
  tb.appendChild(tr);
  glCount();
}
function glCount(){ $("gl-count").textContent = document.querySelectorAll(".gl-k").length + " 条术语"; }
async function glossarySave(){
  if (!state.pack){ toast("请先选择整合包目录", "err"); return; }
  const terms = {};
  document.querySelectorAll("#gl-tbody tr").forEach(tr=>{
    const k = tr.querySelector(".gl-k").value.trim();
    const v = tr.querySelector(".gl-v").value.trim();
    if (k && v) terms[k] = v;
  });
  try{
    const d = await api("/api/glossary/save", {pack: state.pack, terms});
    toast("术语表已保存（" + d.count + " 条）", "");
  }catch(e){ toast(e.message, "err"); }
}

/* ---------- 引擎选择（三处下拉统一由 JS 填充，避免选项漂移） ---------- */
const ENGINES = [
  {id:"google", label:"谷歌翻译（免费 · 无需密钥 · 推荐）"},
  {id:"youdao", label:"有道翻译（官方 API）"},
  {id:"baidu",  label:"百度翻译"},
  {id:"deepl",  label:"DeepL"},
  {id:"openai", label:"AI 大模型（GLM/DeepSeek/通义/Kimi）"},
  {id:"demo",   label:"演示引擎（无需配置，试跑流程）"},
];
function engineLabel(id){
  const e = ENGINES.find(x=>x.id===id);
  return e ? e.label : (id || "未设置");
}
function fillEngineSelects(){
  // v0.3.8 方案A：引擎选择完全收敛到设置页唯一入口。
  // 工作台（v0.3.7）与任务书页（v0.3.8）均已改为只读回显，
  // 可写下拉框仅剩设置页这一个。
  const sel = $("set-engine"); if (!sel) return;
  sel.innerHTML = ENGINES.map(e=>
    '<option value="'+e.id+'">'+esc(e.label)+"</option>").join("");
}
/* 工作台 + 任务书页引擎只读回显 + demo 警示（v0.3.7 工作台 / v0.3.8 任务书页） */
function renderEngineView(engineId){
  const name = engineId || state.engine || "google";
  state.engine = name;
  // 回显用短标签：去掉"（...）"补充说明，保持胶囊紧凑
  const short = engineLabel(name).replace(/（[^）]*）/g, "").trim();
  const isDemo = (name === "demo");
  // 两处只读回显共用同一份渲染逻辑，避免各写一套导致漂移
  [["tr-engine-view","tr-engine-warn"],["qs-engine-view","qs-engine-warn"]]
    .forEach(pair=>{
      const pill = $(pair[0]);
      if (pill) pill.textContent = short;
      const warn = $(pair[1]);
      if (warn) warn.style.display = isDemo ? "block" : "none";
    });
}
/* 跳转到设置页（工作台"去设置修改"链接）—— 复用统一的 showPage */
function gotoSettings(){
  showPage("settings");
}

/* ---------- AI 服务商预设（一键填充地址与模型） ---------- */
let aiPresets = {};               // /api/presets 返回的预设表
async function loadPresets(){
  try{
    const d = await api("/api/presets");
    aiPresets = d.presets || {};
    // 预设按钮文案以后端为准（模型名调整时无需改前端）
    document.querySelectorAll(".preset-btn").forEach(btn=>{
      const p = aiPresets[btn.dataset.preset];
      if (p) btn.textContent = p.label;
    });
  }catch(e){ /* 预设加载失败不影响其他功能 */ }
}
function applyPreset(key){
  const p = aiPresets[key];
  if (!p) return;
  $("set-openai-url").value = p.base_url;
  $("set-openai-model").value = p.model;
  document.querySelectorAll(".preset-btn").forEach(b=>
    b.classList.toggle("active", b.dataset.preset===key));
  $("set-openai-key").focus();
  toast("已填充 " + p.label + " 的地址与模型，再填 API Key 即可", "info");
}

/* ---------- 测试连接（用表单当前值，可先测再保存） ---------- */
async function testEngine(engine, btn){
  const result = $("test-"+engine);
  const old = btn ? btn.textContent : "";
  if (btn){ btn.disabled = true; btn.textContent = "⏳ 测试中…"; }
  if (result){ result.className="test-result"; result.textContent=""; }
  try{
    const d = await api("/api/test-engine", {engine: engine, settings: collectSettings()});
    if (result){
      result.className = "test-result " + (d.ok ? "ok" : "bad");
      result.textContent = (d.ok ? "✓ " : "✗ ") + d.message;
    }
    toast(d.message, d.ok ? "" : "err");
  }catch(e){
    if (result){ result.className="test-result bad"; result.textContent = "✗ " + e.message; }
    toast(e.message, "err");
  }finally{
    if (btn){ btn.disabled = false; btn.textContent = old; }
  }
}

/* ---------- 收集设置表单（保存与测试连接共用） ---------- */
function collectSettings(){
  const settings = {
    engine: {primary: $("set-engine").value},
  };
  const gHost = $("set-google-endpoint").value.trim();
  if (gHost) settings.google = {endpoint: gHost};
  const yid = $("set-youdao-id").value.trim(), ykey = $("set-youdao-key").value.trim();
  if (yid || ykey) settings.youdao = {app_id: yid, app_key: ykey};
  const bid = $("set-baidu-id").value.trim(), bkey = $("set-baidu-key").value.trim();
  if (bid || bkey) settings.baidu = {app_id: bid, app_key: bkey};
  const dkey = $("set-deepl-key").value.trim(), dhost = $("set-deepl-host").value.trim();
  if (dkey || dhost) settings.deepl = {api_key: dkey, api_host: dhost};
  const ourl = $("set-openai-url").value.trim(), okey = $("set-openai-key").value.trim(),
        omodel = $("set-openai-model").value.trim();
  if (ourl || okey || omodel) settings.openai = {base_url: ourl, api_key: okey, model: omodel};
  const workers = parseInt($("set-workers").value, 10);
  if (workers >= 1) settings.workers = workers;
  // 汉化包产出位置（v0.2.8）：自定义且填了路径才写入，否则空串=默认 resourcepacks
  const poVal = $("set-packout-custom").checked ? ($("set-pack-out").value.trim()||"") : "";
  settings.output = {pack_out: poVal};
  return settings;
}

/* ---------- 设置 ---------- */
/* ---------- 设置页折叠卡片与"已配置"标记 ---------- */
function toggleFold(id){
  const card = $("fold-"+id);
  card.classList.toggle("open");               // 箭头方向由 CSS 类切换
}
function setCfgTag(id, ok){
  const el = $("cfg-"+id);
  if (el) el.innerHTML = ok ? '<span class="tag g">已配置</span>' : "";
}
function updateCfgTags(){
  setCfgTag("google", !!$("set-google-endpoint").value.trim());
  setCfgTag("youdao", !!($("set-youdao-id").value.trim() && $("set-youdao-key").value.trim()));
  setCfgTag("baidu",  !!($("set-baidu-id").value.trim() && $("set-baidu-key").value.trim()));
  setCfgTag("deepl",  !!$("set-deepl-key").value.trim());
  setCfgTag("openai", !!($("set-openai-url").value.trim() && $("set-openai-key").value.trim()
                          && $("set-openai-model").value.trim()));
}
async function settingsLoad(){
  if (!state.pack) return;
  try{
    const d = await api("/api/settings?pack=" + encodeURIComponent(state.pack));
    const s = d.settings || {};
    $("set-engine").value = (s.engine && s.engine.primary) || "google";
    // v0.3.7 方案A：设置页是引擎唯一真相源 → 加载后立即同步工作台只读回显
    renderEngineView((s.engine && s.engine.primary) || "google");
    $("set-workers").value = s.workers || "";
    $("set-google-endpoint").value = (s.google && s.google.endpoint) || "";
    $("set-youdao-id").value = (s.youdao && s.youdao.app_id) || "";
    $("set-youdao-key").value = (s.youdao && s.youdao.app_key) || "";
    $("set-baidu-id").value = (s.baidu && s.baidu.app_id) || "";
    $("set-baidu-key").value = (s.baidu && s.baidu.app_key) || "";
    $("set-deepl-key").value = (s.deepl && s.deepl.api_key) || "";
    $("set-deepl-host").value = (s.deepl && s.deepl.api_host) || "";
    $("set-openai-url").value = (s.openai && s.openai.base_url) || "";
    $("set-openai-key").value = (s.openai && s.openai.api_key) || "";
    $("set-openai-model").value = (s.openai && s.openai.model) || "";
    // 汉化包产出位置（v0.2.8）
    const po = (s.output && typeof s.output.pack_out === "string") ? s.output.pack_out : "";
    if (po) {
      $("set-packout-custom").checked = true;
      $("set-pack-out").value = po;
    } else {
      $("set-packout-auto").checked = true;
      $("set-pack-out").value = "";
    }
    updateCfgTags();                            // 收起状态下标出已配置的引擎
    updatePackOutUI();                          // 渲染产出位置卡片与提示
  }catch(e){ /* 静默 */ }
}
async function settingsSave(){
  if (!state.pack){ toast("请先选择整合包目录", "err"); return; }
  try{
    await api("/api/settings/save", {pack: state.pack, settings: collectSettings()});
    updateCfgTags();
    // v0.3.7 方案A：保存即生效 → 同步工作台回显，用户无需刷新页面
    renderEngineView($("set-engine").value);
    toast("设置已保存到 .mc-i18n/config.yaml", "");
  }catch(e){ toast(e.message, "err"); }
}

/* ---------- 启动 ---------- */
fillEngineSelects();
loadPresets();
document.querySelectorAll(".preset-btn").forEach(btn=>{
  btn.onclick = ()=> applyPreset(btn.dataset.preset);
});
applyPackChip();
pollStatus();
if (state.pack){ settingsLoad(); showPage("home"); }
</script>
</body>
</html>
"""
