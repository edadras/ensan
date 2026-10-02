@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Accumulation of Presence
if not exist .venv\Scripts\python.exe call install.bat
.venv\Scripts\python run.py %*
:loop
echo The program stopped. Restarting in 5 seconds... (close this window to stop)
timeout /t 5 >nul
.venv\Scripts\python run.py --no-browser %*
goto loop
