@echo off
rem Preview of day 7 with 3000 fake visitors. Uses a separate folder (data_preview),
rem the real exhibition data in "data" is not touched.
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe call install.bat
.venv\Scripts\python run.py --data data_preview --seed 3000 --day 7 --simulate 30 --port 8077
pause
