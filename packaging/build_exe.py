"""打包成可直接執行的程式，方便分享。

    pip install pyinstaller pillow
    python packaging/build_exe.py

- Windows：單一執行檔 dist/APUProspector.exe → dist/APUProspector-<版本>-win64.exe（下載後直接雙擊）
- macOS：  dist/APUProspector.app            → dist/APUProspector-<版本>-macos-<arm64|x86_64>.zip
  （.app 本身是資料夾，要壓成 zip 才能下載）
  （PyInstaller 不能跨平台，Mac 版要在 Mac 上打包，平常由 GitHub Actions 的雲端 Mac 負責）

打包完會實際執行一次打包好的程式（--smoke-test），確認網頁檔案和目錄資料都讀得到才算成功。
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from serve import __version__  # noqa: E402

NAME = "APUProspector"
DIST = ROOT / "dist"
BUILD = ROOT / "build"
IS_MAC = sys.platform == "darwin"
# Windows 打包成單一 exe，下載就能雙擊；Mac 的 onefile .app 不受 PyInstaller 支援，維持資料夾形式
ONEFILE = sys.platform == "win32"
WEB = ["index.html", "manifest.webmanifest", "css", "js", "data", "icons"]
# 伺服器只用標準函式庫；這些大套件環境裡可能有，避免被順手打包進去
EXCLUDES = ["numpy", "PIL", "pytest", "IPython", "PyQt5", "PyQt6", "PySide2", "PySide6", "matplotlib"]


def platform_tag() -> str:
    if sys.platform == "win32":
        return "win64"
    if IS_MAC:
        return f"macos-{platform.machine()}"
    return f"{sys.platform}-{platform.machine()}"


def build() -> Path:
    """回傳打包好的執行檔路徑。"""
    import PyInstaller.__main__

    args = [
        str(ROOT / "serve.py"),
        "--name", NAME,
        "--windowed",  # Windows 不跳黑色主控台；Mac 產生 .app
        "--noconfirm", "--clean",
        "--icon", str(ROOT / "packaging" / "app.ico"),  # Mac 上會自動轉成 .icns（需要 Pillow）
        "--distpath", str(DIST),
        "--workpath", str(BUILD),
        "--specpath", str(BUILD),
    ]
    for item in WEB:
        src = ROOT / item
        args += ["--add-data", f"{src}{os.pathsep}{item if src.is_dir() else '.'}"]
    if IS_MAC:
        args += ["--osx-bundle-identifier", "tw.apu-astrophotography.apu-prospector"]
    if ONEFILE:
        args += ["--onefile"]
    for mod in EXCLUDES:
        args += ["--exclude-module", mod]
    PyInstaller.__main__.run(args)
    if IS_MAC:
        app = DIST / f"{NAME}.app"
        set_bundle_info(app)
        return app / "Contents" / "MacOS" / NAME
    if ONEFILE:
        return DIST / f"{NAME}.exe"
    return DIST / NAME / f"{NAME}.exe"


def set_bundle_info(app: Path) -> None:
    """補齊 Info.plist 的版本與語系，改完重新做 ad-hoc 簽章（否則 Apple 晶片的 Mac 會說 app「已損毀」）。"""
    import plistlib

    plist = app / "Contents" / "Info.plist"
    info = plistlib.loads(plist.read_bytes())
    info["CFBundleShortVersionString"] = __version__
    info["CFBundleVersion"] = __version__
    info["CFBundleAllowMixedLocalizations"] = True
    info["CFBundleLocalizations"] = ["zh-Hant", "en"]
    plist.write_bytes(plistlib.dumps(info))
    subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(app)], check=True)
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)


def smoke_test(exe: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "smoke.txt"
        proc = subprocess.run([str(exe), "--smoke-test", str(out)], timeout=300)
        text = out.read_text(encoding="utf-8") if out.exists() else "(沒有輸出)"
        if proc.returncode != 0 or not text.startswith(f"ok version={__version__} "):
            raise SystemExit(f"打包好的程式測試失敗（exit {proc.returncode}）：\n{text}")
        if "tk=yes" not in text:
            # 沒有 tkinter 就沒有控制視窗，Mac 版會變成關不掉的背景程式
            raise SystemExit(f"打包好的程式沒有 tkinter（打包用的 Python 缺少 Tcl/Tk）：\n{text}")
        print(f"打包好的程式測試通過：{text.strip()}")


def archive() -> tuple[Path, Path]:
    """回傳 (打包好的程式, 分享用的檔案)。"""
    base = DIST / f"{NAME}-{__version__}-{platform_tag()}"
    if ONEFILE:
        exe = DIST / f"{NAME}.exe"
        target = Path(f"{base}.exe")
        shutil.copy2(exe, target)
        return exe, target
    if IS_MAC:
        app = DIST / f"{NAME}.app"
        # 用 ditto 壓縮才會保留 .app 裡的符號連結和執行權限
        subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app), f"{base}.zip"],
                       check=True)
        return app, Path(f"{base}.zip")
    return DIST / NAME, Path(shutil.make_archive(str(base), "zip", root_dir=DIST, base_dir=NAME))


def folder_size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file() and not p.is_symlink())


def main() -> None:
    exe = build()
    smoke_test(exe)
    bundle, zip_path = archive()
    print(f"\n程式：{bundle}（{folder_size(bundle) / 2**20:.0f} MB）")
    print(f"分享用：{zip_path}（{zip_path.stat().st_size / 2**20:.0f} MB）")


if __name__ == "__main__":
    main()
