// MC Toolbox — WebView2 无边框窗口宿主
//
// 职责：
//   1. 打开一个无系统标题栏的窗口，内嵌 WebView2 加载 http://127.0.0.1:<port>/?host=webview2
//   2. 页面通过 window.chrome.webview.postMessage 控制窗口：min / max / close / drag dx dy
//   3. 窗口关闭时向后端 POST /api/shutdown（心跳机制兜底）
//
// 编译（构建脚本 build.mjs 自动完成）：
//   csc /nologo /target:winexe /platform:anycpu /out:host.exe /r:Microsoft.Web.WebView2.Core.dll
//       /r:Microsoft.Web.WebView2.WinForms.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll host.cs
//
// 退出码约定：
//   3 = WebView2 运行时不可用 / 初始化失败（server.js 检测到会回退到 Edge --app 窗口）

using System;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace McToolbox
{
    static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        private static readonly IntPtr PER_MONITOR_AWARE_V2 = new IntPtr(-4);

        [STAThread]
        static void Main(string[] args)
        {
            try { SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string url = (args != null && args.Length > 0 && !string.IsNullOrWhiteSpace(args[0]))
                ? args[0]
                : "http://127.0.0.1:8756/?host=webview2";
            try
            {
                Application.Run(new HostForm(url));
            }
            catch { Environment.Exit(3); }
        }
    }

    class HostForm : Form
    {
        // 让 WebView2 填满的客户区也能靠系统原生逻辑缩放窗口
        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();
        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
        private const int WM_NCLBUTTONDOWN = 0xA1;
        private const int HTCAPTION = 2;

        private readonly string _url;
        private WebView2 _web;
        private bool _closingPosted = false;
        private bool _lastMaximized = false;

        public HostForm(string url)
        {
            _url = url;
            Text = "Minecraft 工具箱";
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            FormBorderStyle = FormBorderStyle.None;      // 无系统标题栏
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(0x1B, 0x1E, 0x24);
            ShowInTaskbar = true;
            MinimumSize = new Size(720, 480);

            var wa = Screen.PrimaryScreen.WorkingArea;
            int w = Math.Min(1280, Math.Max(MinimumSize.Width, wa.Width - 120));
            int h = Math.Min(820, Math.Max(MinimumSize.Height, wa.Height - 120));
            ClientSize = new Size(w, h);

            // 先探测 WebView2 运行时是否可用（不可用 → 退出码 3，交给 server 回退 Edge）
            try
            {
                string ver = CoreWebView2Environment.GetAvailableBrowserVersionString();
                if (string.IsNullOrEmpty(ver)) throw new Exception("no runtime");
            }
            catch { Environment.Exit(3); }

            _web = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(_web);
            _web.CoreWebView2InitializationCompleted += OnInitCompleted;
            InitWebViewAsync();   // fire-and-forget（async void，异常已在内部捕获）
        }

        private async void InitWebViewAsync()
        {
            try
            {
                string udf = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "MC Toolbox", "webview2");
                var env = await CoreWebView2Environment.CreateAsync(null, udf, null);
                _web.EnsureCoreWebView2Async(env);
            }
            catch { Environment.Exit(3); }
        }

        private void OnInitCompleted(object sender, CoreWebView2InitializationCompletedEventArgs e)
        {
            try
            {
                if (!e.IsSuccess)
                    throw e.InitializationException ?? new Exception("WebView2 init failed");
            }
            catch { Environment.Exit(3); }

            var wv = _web.CoreWebView2;
            wv.Settings.AreDevToolsEnabled = false;
            wv.Settings.IsStatusBarEnabled = false;
            wv.Settings.AreDefaultContextMenusEnabled = true;
            wv.Settings.IsZoomControlEnabled = false;
            try { wv.Settings.IsPinchZoomEnabled = false; } catch { }
            wv.WebMessageReceived += OnWebMessage;
            wv.Navigate(_url);
        }

        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string msg = null;
            try
            {
                // postMessage 的是普通字符串，在 WebMessageAsJson 里是带引号的 JSON 字符串
                string json = e.WebMessageAsJson;
                if (!string.IsNullOrEmpty(json) && json.Length >= 2 && json[0] == '"' && json[json.Length - 1] == '"')
                {
                    msg = json.Substring(1, json.Length - 2).Replace("\\\"", "\"").Replace("\\\\", "\\");
                }
                else msg = json;
            }
            catch { }
            if (string.IsNullOrWhiteSpace(msg)) return;
            msg = msg.Trim();
            try
            {
                if (msg == "min")
                {
                    WindowState = FormWindowState.Minimized;
                }
                else if (msg == "max")
                {
                    WindowState = WindowState == FormWindowState.Maximized
                        ? FormWindowState.Normal
                        : FormWindowState.Maximized;
                }
                else if (msg == "close")
                {
                    BeginInvoke(new Action(() => Close()));
                }
                else if (msg == "cap")
                {
                    // 顶栏拖拽：交给系统原生移动（WM_NCLBUTTONDOWN + HTCAPTION），
                    // 比逐帧 postMessage 搬窗口平滑得多
                    if (WindowState == FormWindowState.Maximized) return;
                    try
                    {
                        ReleaseCapture();
                        SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
                    }
                    catch { }
                }
                else if (msg.StartsWith("rsz ", StringComparison.Ordinal))
                {
                    // 页面边缘悬浮层触发：交给系统原生缩放（对 WebView2 全覆盖也有效）
                    int code = HTCAPTION;
                    int v = 0;
                    if (int.TryParse(msg.Substring(4).Trim(), out v)) code = v;
                    if (WindowState == FormWindowState.Maximized) return;
                    try
                    {
                        ReleaseCapture();
                        SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)code, IntPtr.Zero);
                    }
                    catch { }
                }
                else if (msg.StartsWith("drag ", StringComparison.Ordinal))
                {
                    if (WindowState == FormWindowState.Maximized) return;
                    string[] parts = msg.Substring(5).Split(' ');
                    int dx = 0, dy = 0;
                    if (parts.Length > 0) int.TryParse(parts[0], out dx);
                    if (parts.Length > 1) int.TryParse(parts[1], out dy);
                    if (dx != 0 || dy != 0)
                    {
                        var p = Location;
                        p.Offset(dx, dy);
                        Location = p;
                    }
                }
            }
            catch { }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            try { if (_web != null) _web.Focus(); } catch { }
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            if (!_closingPosted)
            {
                _closingPosted = true;
                try { NotifyShutdown(); } catch { }
            }
            base.OnFormClosed(e);
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            bool mx = WindowState == FormWindowState.Maximized;
            if (mx != _lastMaximized)
            {
                _lastMaximized = mx;
                try
                {
                    if (_web != null && _web.CoreWebView2 != null)
                        _web.CoreWebView2.PostWebMessageAsString(mx ? "wm 1" : "wm 0");
                }
                catch { }
            }
        }

        // 窗口已关：通知后端退出（heartbeat 兜底之外的最快路径）
        private void NotifyShutdown()
        {
            try
            {
                var uri = new Uri(_url);
                string baseUrl = uri.GetLeftPart(UriPartial.Authority);
                var th = new Thread(() =>
                {
                    try
                    {
                        var req = (HttpWebRequest)WebRequest.Create(baseUrl + "/api/shutdown");
                        req.Method = "POST";
                        req.ContentLength = 0;
                        req.Timeout = 1200;
                        using (var resp = (HttpWebResponse)req.GetResponse()) { }
                    }
                    catch { }
                });
                th.IsBackground = true;
                th.Start();
                if (!th.Join(1500)) { try { th.Abort(); } catch { } }
            }
            catch { }
        }

        // 无边框窗口的鼠标边缘拉伸（WebView2 占满客户区）
        protected override void WndProc(ref Message m)
        {
            const int WM_NCHITTEST = 0x84;
            const int HT_CLIENT = 1;
            const int HT_LEFT = 10, HT_RIGHT = 11, HT_TOP = 12,
                      HT_TOPLEFT = 13, HT_TOPRIGHT = 14,
                      HT_BOTTOM = 15, HT_BOTTOMLEFT = 16, HT_BOTTOMRIGHT = 17;

            if (m.Msg == WM_NCHITTEST && WindowState != FormWindowState.Maximized)
            {
                base.WndProc(ref m);
                if (m.Result != (IntPtr)HT_CLIENT) return;
                int x = unchecked((short)(long)m.LParam & 0xFFFF);
                int y = unchecked((short)(((long)m.LParam >> 16) & 0xFFFF));
                Point pt = PointToClient(new Point(x, y));
                const int EDGE = 8;
                bool left = pt.X <= EDGE, right = pt.X >= ClientSize.Width - EDGE;
                bool top = pt.Y <= EDGE, bottom = pt.Y >= ClientSize.Height - EDGE;
                IntPtr hit = (IntPtr)HT_CLIENT;
                if (top && left) hit = (IntPtr)HT_TOPLEFT;
                else if (top && right) hit = (IntPtr)HT_TOPRIGHT;
                else if (bottom && left) hit = (IntPtr)HT_BOTTOMLEFT;
                else if (bottom && right) hit = (IntPtr)HT_BOTTOMRIGHT;
                else if (left) hit = (IntPtr)HT_LEFT;
                else if (right) hit = (IntPtr)HT_RIGHT;
                else if (top) hit = (IntPtr)HT_TOP;
                else if (bottom) hit = (IntPtr)HT_BOTTOM;
                m.Result = hit;
                return;
            }
            base.WndProc(ref m);
        }
    }
}
