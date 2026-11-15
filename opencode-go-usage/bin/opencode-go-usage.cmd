@echo off
setlocal
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0opencode-go-usage.ps1" %1
exit /b %ERRORLEVEL%
