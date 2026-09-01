@echo off
setlocal
set "SCRIPT_DIR=%~dp0"

if exist "%SCRIPT_DIR%sign-windows.ps1" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%sign-windows.ps1" "%~1"
) else if exist "%SCRIPT_DIR%scripts\sign-windows.ps1" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%scripts\sign-windows.ps1" "%~1"
) else if exist "%SCRIPT_DIR%..\scripts\sign-windows.ps1" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%..\scripts\sign-windows.ps1" "%~1"
) else (
    echo [sign.cmd] Error: sign-windows.ps1 not found in %SCRIPT_DIR%
    exit /b 1
)
