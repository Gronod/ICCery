@echo off
setlocal
set "TARGET=%~1"
if "%TARGET%"=="" (
    echo [sign.cmd] Error: No target file specified.
    exit /b 1
)

:: Find sign-windows.ps1
set "SCRIPT_PATH="
if exist "%~dp0sign-windows.ps1" set "SCRIPT_PATH=%~dp0sign-windows.ps1"
if not defined SCRIPT_PATH if exist "%~dp0scripts\sign-windows.ps1" set "SCRIPT_PATH=%~dp0scripts\sign-windows.ps1"
if not defined SCRIPT_PATH if exist "%~dp0..\scripts\sign-windows.ps1" set "SCRIPT_PATH=%~dp0..\scripts\sign-windows.ps1"
if not defined SCRIPT_PATH if exist "scripts\sign-windows.ps1" set "SCRIPT_PATH=scripts\sign-windows.ps1"
if not defined SCRIPT_PATH if exist "..\scripts\sign-windows.ps1" set "SCRIPT_PATH=..\scripts\sign-windows.ps1"

if not defined SCRIPT_PATH (
    echo [sign.cmd] Error: sign-windows.ps1 could not be found.
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_PATH%" "%TARGET%"
exit /b %ERRORLEVEL%
