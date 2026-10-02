@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Accumulation of Presence - install ===
set "PY=python"
where py >nul 2>nul && set "PY=py -3"
%PY% --version >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install Python 3.11 or 3.12 from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH" during setup. Then run install.bat again.
  pause
  exit /b 1
)
if not exist .venv\Scripts\python.exe %PY% -m venv .venv
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\python -m pip install -r requirements.txt
if errorlevel 1 (
  echo Installation failed. Check your internet connection and try again.
  pause
  exit /b 1
)
echo Downloading face models (about 75 MB, once)...
.venv\Scripts\python -m presence.models
echo.
echo Installed. Run start.bat to start the work.
pause
