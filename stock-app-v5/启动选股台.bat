@echo off
cd /d "%~dp0"
python launch_check.py
if errorlevel 2 (pause & exit /b 2)
if errorlevel 1 (python bridge.py --port 8775 --open) else (start "" "http://127.0.0.1:8775/index.html")
pause
