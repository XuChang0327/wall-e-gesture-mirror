@echo off
REM Wall-E Gesture Mirror - Windows launcher (ASCII only, avoids encoding crash)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" -Port 8080
echo.
echo Server stopped. Press any key to exit.
pause >nul
