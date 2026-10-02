@echo off
rem No camera: 20 fake visitors per minute (to test the TV and the website)
cd /d "%~dp0"
call start.bat --simulate 20 --no-camera
