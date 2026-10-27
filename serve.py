"""APU Prospector 本機伺服器：只聽 localhost、不讓瀏覽器快取（改完程式重新整理就生效）。

    python serve.py                  開小視窗（開啟瀏覽器／結束），並自動開瀏覽器
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

__version__ = "0.1.1"
DEFAULT_PORT = 8765
WEB_FILES = ["index.html", "css/style.css", "js/app.js", "js/panels.js", "js/config.js", "js/astro.js", "js/fits.js", "data/catalogs.json"]


def web_root():
    # PyInstaller 打包後檔案解壓在 sys._MEIPASS
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows 登錄檔有時把 .js 對應成 text/plain，ES module 會載不進來
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript"}

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


def run_window(url, open_browser):
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
        if len(catalogs) < 9 or rows < 10000 or any(len(c["rows"][0]) != 8 for c in catalogs.values()):
            raise RuntimeError(f"目錄資料不完整：{len(catalogs)} 個目錄、{rows} 筆")
        try:
            import tkinter  # noqa: F401  控制視窗要用；只確認有打包進來，不開視窗
            tk = "yes"
        except ImportError:
            tk = "no"
        result = f"ok version={__version__} files={len(sizes)} catalogs={len(catalogs)} objects={rows} tk={tk}\n"
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
    try:
        run_window(url, open_browser)
    except Exception:
        # 沒有 tkinter 或沒有圖形環境：退回主控台模式
        run_console(server, url, open_browser)
        return
    server.shutdown()


if __name__ == "__main__":
    main()
