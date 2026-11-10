@echo off
rem PulseForge one-key release.
rem Usage: just double-click, or: git_push.bat --version 0.8.0 --message "feat: xxx"
rem Every release prepends its changelog to CHANGELOG.md (newest first).
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js not found in PATH. Install Node 20+ first.
  pause
  exit /b 1
)
where git >nul 2>nul
if errorlevel 1 (
  echo [X] git not found in PATH. Install Git first.
  pause
  exit /b 1
)

echo.
echo   PulseForge release helper
echo   ------------------------------------------------------------
echo   Interactive: press Enter and follow the prompts.
echo   Shortcut   : git_push.bat --version 0.8.0 --message "feat: xxx"
echo   Dry run    : git_push.bat --dry-run
echo   Changelog  : entries are prepended to CHANGELOG.md automatically.
echo.

node "%~dp0scripts\publish.mjs" %*
set "CODE=%ERRORLEVEL%"

echo.
if "%CODE%"=="0" (
  echo [OK] Release finished. GitHub Actions will build the installer.
) else (
  echo [X] Release aborted, exit code %CODE%.
)
echo.
pause
exit /b %CODE%
