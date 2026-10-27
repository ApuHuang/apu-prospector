@echo off
rem Start APU Prospector from source (requires Python 3.10+); opens its own window with pywebview, otherwise the browser
cd /d "%~dp0"
python serve.py
