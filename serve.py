"""APU Prospector 本機伺服器：只聽 localhost、不讓瀏覽器快取（改完程式重新整理就生效）。

    python serve.py                  開 APU Prospector 自己的視窗（pywebview）；
                                     沒有 pywebview 或 WebView2 時改開小視窗＋瀏覽器
    python serve.py --browser        不開獨立視窗，直接用小視窗＋瀏覽器
    python serve.py --console        不開視窗，在主控台執行（Ctrl+C 結束）
    python serve.py 8770 --no-browser
    python serve.py --smoke-test out.txt   打包後的自我測試：啟動、讀回所有網頁檔案後結束

打包成執行檔後，網頁檔案從程式內部讀取。
"""
import errno
import functools
import http.server
import json
import os
import sys
import threading
import urllib.request
import webbrowser
from pathlib import Path

__version__ = "0.2.1"
DEFAULT_PORT = 8765
WEB_FILES = ["index.html", "manifest.webmanifest", "icons/apple-touch-icon.png", "css/style.css", "js/app.js", "js/panels.js",
             "js/config.js", "js/astro.js", "js/fits.js", "data/catalogs.json"]


def web_root():
    # PyInstaller 打包後檔案解壓在 sys._MEIPASS
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows 登錄檔有時把 .js 對應成 text/plain，ES module 會載不進來；舊版 Python 不認得 .webmanifest
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".webmanifest": "application/manifest+json"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 不洗版

    def log_error(self, fmt, *args):
        if sys.stderr:  # 視窗版沒有 stderr
            sys.stderr.write("錯誤：" + (fmt % args) + "\n")


class Server(http.server.ThreadingHTTPServer):
    # Windows 的 SO_REUSEADDR 會讓兩個程式綁同一個 port，關掉才能偵測到被占用
    allow_reuse_address = os.name != "nt"
    daemon_threads = True


def start_server(port):
    """port 0 表示隨便找一個空的；否則從 port 開始往後找。"""
    handler = functools.partial(Handler, directory=str(web_root()))
    if port == 0:
        server = Server(("127.0.0.1", 0), handler)
        return server, server.server_address[1]
    # 換 port 後瀏覽器裡存的設定是分開的，所以盡量用固定的 8765
    for p in range(port, port + 10):
        try:
            return Server(("127.0.0.1", p), handler), p
        except OSError as e:
            if e.errno not in (errno.EADDRINUSE, 10048, 10013):
                raise
    raise SystemExit(f"{port}–{port + 9} 的連接埠都被占用了")


def serve_in_background(server):
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return t


class NoWebView2(RuntimeError):
    pass


def storage_dir():
    """Windows 獨立視窗的 localStorage 存放位置（Mac 的 WKWebView 自己存在 ~/Library/WebKit）。"""
    return Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "APUProspector" / "webview"


class Api:
    """網頁裡用 window.pywebview.api.<名稱>() 呼叫。"""

    def save_text(self, filename, text):
        """獨立視窗擋下載，匯出 CSV 改用系統的「另存新檔」；回傳存好的路徑，按取消回傳 None。"""
        import webview

        result = webview.windows[0].create_file_dialog(
            webview.FileDialog.SAVE, save_filename=filename, file_types=("CSV (*.csv)",))
        if not result:
            return None
        path = result if isinstance(result, str) else result[0]
        Path(path).write_text(text, encoding="utf-8", newline="")  # text 已經是 \r\n，不要再轉換
        return path


# pywebview 自己的選單與對話框文字（預設英文）；Mac 選單會自動接上程式名稱，例如「結束 APUProspector」
LOCALIZATION = {
    "global.quitConfirmation": "確定要結束嗎？",
    "global.ok": "好",
    "global.quit": "結束",
    "global.cancel": "取消",
    "global.saveFile": "另存新檔",
    "cocoa.menu.about": "關於",
    "cocoa.menu.services": "服務",
    "cocoa.menu.view": "顯示方式",
    "cocoa.menu.edit": "編輯",
    "cocoa.menu.hide": "隱藏",
    "cocoa.menu.hideOthers": "隱藏其他",
    "cocoa.menu.showAll": "顯示全部",
    "cocoa.menu.quit": "結束",
    "cocoa.menu.fullscreen": "進入全螢幕",
    "cocoa.menu.cut": "剪下",
    "cocoa.menu.copy": "拷貝",
    "cocoa.menu.paste": "貼上",
    "cocoa.menu.selectAll": "全選",
    "windows.fileFilter.allFiles": "所有檔案",
    "windows.fileFilter.otherFiles": "其他檔案類型",
}


def run_app_window(url):
    """用系統內建的網頁核心開獨立視窗，關掉才返回；不支援就丟例外，由 main() 退回瀏覽器模式。"""
    import webview
    from webview.guilib import initialize

    options = {}
    if sys.platform == "win32":
        # 沒有 WebView2 時 pywebview 會改用 IE 核心，不支援 ES module 和 WebGL2，畫面會是空白
        if initialize().renderer != "edgechromium":
            raise NoWebView2()
        path = storage_dir()
        path.mkdir(parents=True, exist_ok=True)
        options["storage_path"] = str(path)
    webview.create_window(
        f"APU Prospector {__version__}", url, js_api=Api(),
        width=1400, height=900, min_size=(900, 600), background_color="#0b0e14")
    # 預設 private_mode=True 每次關掉都會清空 localStorage（地點、鏡筒、圖層設定）
    webview.start(private_mode=False, localization=LOCALIZATION, **options)


def run_window(url, open_browser, note=None):
    import tkinter as tk
    from tkinter import ttk

    root = tk.Tk()
    root.title(f"APU Prospector {__version__}")
    root.resizable(False, False)
    frame = ttk.Frame(root, padding=18)
    frame.pack(fill="both", expand=True)
    ttk.Label(frame, text="APU Prospector 正在執行", font=("", 13, "bold")).pack(anchor="w")
    link = ttk.Label(frame, text=url, foreground="#1c7ed6", cursor="hand2")
    link.pack(anchor="w", pady=(6, 10))
    link.bind("<Button-1>", lambda e: webbrowser.open(url))
    ttk.Label(frame, text="在瀏覽器裡使用，關掉這個視窗就會結束。", foreground="#666").pack(anchor="w")
    if note:
        ttk.Label(frame, text=note, foreground="#666", wraplength=360, justify="left").pack(anchor="w", pady=(6, 0))
    buttons = ttk.Frame(frame)
    buttons.pack(fill="x", pady=(14, 0))
    ttk.Button(buttons, text="開啟瀏覽器", command=lambda: webbrowser.open(url)).pack(side="left")
    ttk.Button(buttons, text="結束", command=root.destroy).pack(side="right")
    if open_browser:
        root.after(400, lambda: webbrowser.open(url))
    root.mainloop()


def run_console(server, url, open_browser):
    print(f"APU Prospector {__version__} 已啟動：{url}")
    print("按 Ctrl+C 結束。")
    if open_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


def smoke_test(out_path):
    """啟動伺服器、讀回每個網頁檔案並檢查內容，結果寫進 out_path（視窗版沒有主控台可印）。"""
    server, port = start_server(0)
    serve_in_background(server)
    base = f"http://127.0.0.1:{port}/"
    try:
        sizes = {}
        for name in WEB_FILES:
            with urllib.request.urlopen(base + name, timeout=10) as resp:
                body = resp.read()
                ctype = resp.headers.get("Content-Type", "")
            if name.endswith(".js") and not ctype.startswith("text/javascript"):
                raise RuntimeError(f"{name} 的 Content-Type 是 {ctype}")
            sizes[name] = len(body)
        with urllib.request.urlopen(base + "data/catalogs.json", timeout=10) as resp:
            catalogs = json.loads(resp.read().decode("utf-8"))["catalogs"]
        rows = sum(len(c["rows"]) for c in catalogs.values())
        # 每列：名稱、RA、Dec、半徑、別名、說明、Hα、100µm、等級
        if len(catalogs) < 9 or rows < 10000 or any(len(r) != 9 for c in catalogs.values() for r in c["rows"]):
            raise RuntimeError(f"目錄資料不完整：{len(catalogs)} 個目錄、{rows} 筆")
        try:
            import tkinter  # noqa: F401  控制視窗要用；只確認有打包進來，不開視窗
            tk = "yes"
        except ImportError:
            tk = "no"
        try:
            # 載入系統網頁核心的介面，確認有打包進來，不開視窗；Windows 會是 edgechromium 或 mshtml（沒有 WebView2）
            from webview.guilib import initialize
            renderer = initialize().renderer
        except Exception:
            renderer = "no"
        result = (f"ok version={__version__} files={len(sizes)} catalogs={len(catalogs)} objects={rows} "
                  f"tk={tk} webview={renderer}\n")
        code = 0
    except Exception as e:  # 寫進結果檔，讓打包腳本看得到原因
        result = f"fail: {e}\n"
        code = 1
    finally:
        server.shutdown()
    Path(out_path).write_text(result, encoding="utf-8")
    return code


def main():
    argv = sys.argv[1:]
    if "--smoke-test" in argv:
        sys.exit(smoke_test(argv[argv.index("--smoke-test") + 1]))
    args = [a for a in argv if not a.startswith("--")]
    port = int(args[0]) if args else DEFAULT_PORT
    open_browser = "--no-browser" not in argv
    server, port = start_server(port)
    url = f"http://localhost:{port}/"
    if "--console" in argv:
        run_console(server, url, open_browser)
        return
    serve_in_background(server)
    note = None
    if "--browser" not in argv:
        try:
            run_app_window(url)
            server.shutdown()
            return
        except NoWebView2:
            note = "這台電腦沒有 WebView2，所以改用瀏覽器。安裝 Microsoft Edge WebView2 Runtime 後就會開獨立視窗。"
        except Exception:
            pass  # 沒有 pywebview（從原始碼執行沒裝）：退回小視窗＋瀏覽器
    try:
        run_window(url, open_browser, note)
    except Exception:
        # 沒有 tkinter 或沒有圖形環境：退回主控台模式
        run_console(server, url, open_browser)
        return
    server.shutdown()


if __name__ == "__main__":
    main()
