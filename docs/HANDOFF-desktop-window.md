# 交接：桌面版改成獨立視窗（pywebview）

> 2026-10-27 從雲端 session 交接到筆電。用 Claude Code 接手的話，直接說「照 docs/HANDOFF-desktop-window.md 做」。

## 目標

- **電腦（exe／Mac app）**：雙擊後直接開 APU Prospector 自己的視窗，不再開瀏覽器分頁、也不需要現在那個 tkinter 小視窗。
- **手機**：用網頁版 <https://apuhuang.github.io/apu-prospector/>，不受這次修改影響。
- 兩邊共用同一份 `index.html`／`js/`／`css/`／`data/`／`icons/`，不維護兩套程式。
- **一定要保留退路**：獨立視窗開不起來（沒有 pywebview、沒有 WebView2…）就自動退回現在的「小視窗＋瀏覽器」，最壞情況跟 0.1.1 一樣。

## 現況

| 分支 | 內容 |
|---|---|
| `main` | 0.1.1（瀏覽器版 exe） |
| `claude/kind-goodall-3gbqsu` | main 加上：GitHub Pages 與 README、手機版面與觸控讀值、`publish-web.yml`、這份文件。**先合併到 main 再開始** |
| `gh-pages` | 網頁版，只有 `index.html`、`manifest.webmanifest`、`css/`、`js/`、`data/`、`icons/`、`.nojekyll`。合併後由 `.github/workflows/publish-web.yml` 在 main 的網頁檔案變動時自動整個重建，**不要手動改** |

合併到 main 之後，到 Actions 確認「發布網頁版」跑完、接著出現「pages build and deployment」。
如果後者沒有出現（用 `GITHUB_TOKEN` 推送理論上會觸發 Pages 部署，但這裡還沒實測過），
把「發布網頁版」手動再跑一次；還是不行就到 Settings → Pages 把來源改成 GitHub Actions，改用 `actions/deploy-pages`。

## pywebview 6.2.1 已確認的行為（讀過原始碼）

| 項目 | 預設 | 不處理的後果 | 處理方式 |
|---|---|---|---|
| `webview.start(private_mode=...)` | `True` | 每次關掉，localStorage（地點、鏡筒、圖層設定）全部清空 | `private_mode=False`，`storage_path` 指到使用者資料夾 |
| `webview.settings['ALLOW_DOWNLOADS']` | `False` | `<a download>` 被取消，**匯出 NINA CSV 按了沒反應** | 用 `js_api` 叫 Python 開「另存新檔」（`window.create_file_dialog(webview.FileDialog.SAVE, ...)`；舊的 `webview.SAVE_DIALOG` 已標 deprecated） |
| Windows 沒有 WebView2 | `platforms/winforms.py` 退回 `renderer = 'mshtml'`（IE 核心） | 不支援 ES module、WebGL2，畫面空白 | 開視窗前用 `webview.guilib.initialize().renderer` 檢查，不是 `edgechromium` 就退回瀏覽器模式 |
| 定位權限 | `edgechromium.py`、`cocoa.py` 都沒處理 | 「使用目前位置」可能沒反應（未實測） | 接受；電腦多半沒有 GPS，手動填經緯度 |
| Mac 的 ATS | `cocoa.py` 會自己設 `NSAllowsArbitraryLoads` | — | 載入 `http://localhost` 不用另外處理 |
| 依賴 | Windows：`pythonnet`；Mac：`pyobjc-*` | — | `pip install pywebview` 會一起裝；wheel 內附 PyInstaller hook（`webview/__pyinstaller/hook-webview.py`） |
| `http_server=True` | 內建伺服器 | — | **不要用**，繼續用 serve.py 自己的伺服器（固定 8765；localStorage 依 origin 區分，換 port 設定就分開） |

> 測試退回機制：Windows 上 `set PYWEBVIEW_GUI=mshtml` 後執行，會強制走 IE 核心，應該要自動退回瀏覽器模式。
> 這個環境變數是在 `guilib.initialize()` 裡讀的，所以檢查一定要透過 `initialize()`，不要直接 `import webview.platforms.winforms`（那樣會略過環境變數）。

## 實作步驟

### 1. serve.py

加在 `run_window` 前面（草稿，沒有在 Windows 上跑過）：

```python
def storage_dir():
    """獨立視窗的 localStorage 存放位置。"""
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home())
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path.home() / ".local" / "share"
    return base / "APUProspector" / "webview"


class Api:
    """網頁裡用 window.pywebview.api.<名稱>() 呼叫。"""

    def save_text(self, filename, text):
        import webview

        result = webview.windows[0].create_file_dialog(
            webview.FileDialog.SAVE, save_filename=filename, file_types=("CSV (*.csv)",))
        if not result:
            return None  # 按了取消
        path = result if isinstance(result, str) else result[0]
        Path(path).write_text(text, encoding="utf-8", newline="")  # text 已經是 \r\n，不要再轉換
        return path


def run_app_window(url):
    """用系統內建的網頁核心開獨立視窗；不支援就丟例外，由 main() 退回瀏覽器模式。"""
    import webview
    from webview.guilib import initialize

    if sys.platform == "win32" and initialize().renderer != "edgechromium":
        raise RuntimeError("沒有 WebView2")
    webview.create_window(
        f"APU Prospector {__version__}", url, js_api=Api(),
        width=1400, height=900, min_size=(900, 600), background_color="#0b0e14")
    path = storage_dir()
    path.mkdir(parents=True, exist_ok=True)
    webview.start(private_mode=False, storage_path=str(path))
```

`main()` 裡，`serve_in_background(server)` 之後、`run_window` 之前：

```python
    if "--browser" not in argv:
        try:
            run_app_window(url)
            server.shutdown()
            return
        except Exception:
            pass  # 沒有 pywebview 或 WebView2：退回原本的小視窗＋瀏覽器
```

- 加一個 `--browser` 參數強制用舊模式（除錯、或使用者遇到視窗問題時用），docstring 和 README 一起更新
- `smoke_test()` 比照 `tk=yes/no` 加一個 `webview=yes/no`（只確認 `import webview` 成功，不開視窗）
- `Path.write_text(newline=...)` 要 Python 3.10，README 已經寫 3.10 以上

### 2. js/app.js 的 `exportNina`

現在是 Blob + `<a download>`，在 pywebview 裡會被擋。改成先判斷是不是在桌面視窗裡：

```js
async function exportNina(rig) {
  const lines = [/* 跟現在一樣 */];
  const text = lines.join("\r\n") + "\r\n";
  const safe = `${state.targetName}_${rig.name}`.replace(/[\\/:*?"<>|\s]+/g, "_");
  if (window.pywebview?.api?.save_text) {
    // 桌面視窗版擋下載，改用系統的「另存新檔」
    const path = await window.pywebview.api.save_text(`${safe}.csv`, text);
    if (path) $("#search-msg").textContent = `已存到 ${path}`;
    return;
  }
  // 以下是原本的 Blob 下載，網頁版（手機、瀏覽器）繼續用
}
```

網頁版沒有 `window.pywebview`，行為不變。改完網頁版也會自動更新（publish-web.yml），用手機確認匯出還正常。

### 3. 複製座標

`copyCoords` 用 `navigator.clipboard.writeText`。`http://localhost` 算安全來源，WebView2／WKWebView 應該可以用，**要實測**。
不行的話在 `Api` 加 `copy_text(text)`（例如用 tkinter 的 `clipboard_append`），JS 比照上面先判斷 `window.pywebview`。

### 4. 打包

- `.github/workflows/build-windows.yml`、`build-macos.yml`：`pip install pyinstaller pillow` 加上 `pywebview`
- `packaging/build_exe.py`：`EXCLUDES` 已經排除 PyQt／PySide，保持，免得 pywebview 把 Qt 拉進來
- 打包完的自我測試只測得到伺服器和 `import webview`，測不到視窗，**視窗一定要實機開一次**

## Windows 筆電測試清單

先用原始碼（`pip install pywebview`），通過再打包：

1. `python serve.py` → 出現獨立視窗，沒有開瀏覽器
2. 天圖、Hα 疊圖正常（WebGL2），滑鼠讀值、框內訊號有數字
3. 改地點、鏡筒 → 關掉重開 → 設定還在
4. 匯出 NINA CSV → 跳出另存新檔 → NINA 簡易序列「匯入目標」讀得進去
5. 複製座標 → 貼到記事本
6. 紅光模式、搜尋、探勘
7. 關掉視窗後程式完全結束（工作管理員裡沒有殘留）
8. `set PYWEBVIEW_GUI=mshtml` 再 `python serve.py` → 自動退回小視窗＋瀏覽器
9. `python serve.py --browser` → 舊模式
10. `python packaging/build_exe.py` → 用打包好的 exe 再跑一次 1–7，記下 exe 大小和 0.1.1 比較

Mac 版由 Actions 打包，要找實體 Mac 測同樣的項目（目前兩個 Mac 版本來就還沒實機測過）。

## 收尾

- `serve.py` 的 `__version__` 改成 `0.2.0`
- README「下載」段落：改成「會開一個獨立視窗」；Windows 沒有 WebView2 時會自動改用瀏覽器；`--browser` 參數
- 發 Release `v0.2.0`，Actions 會打包並附上 Windows／Mac 檔案

## 已經否決的做法

- **Electron**：每個 exe 自帶 Chromium，100MB 以上，打包要整套換成 Node
- **Tauri**：要 Rust 工具鏈，用的跟 pywebview 是同樣的系統網頁核心，沒有實質好處
- **PWA（加到主畫面）**：可以之後再加，跟這次無關
