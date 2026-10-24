@echo off
rem Build dist\APUProspector-<version>-win64.zip with PyInstaller in an isolated venv
cd /d "%~dp0"
if not exist .venv-build\Scripts\python.exe python -m venv .venv-build || exit /b 1
.venv-build\Scripts\python -m pip install --quiet --disable-pip-version-check pyinstaller pillow || exit /b 1
set PYTHONUTF8=1
.venv-build\Scripts\python packaging\build_exe.py || exit /b 1
