@echo off
setlocal
set "SCRIPT_DIR=%~dp0"

if exist "%SCRIPT_DIR%.venv\Scripts\python.exe" (
  "%SCRIPT_DIR%.venv\Scripts\python.exe" "%SCRIPT_DIR%start.py" %*
  exit /b %ERRORLEVEL%
)

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -3 "%SCRIPT_DIR%start.py" %*
  exit /b %ERRORLEVEL%
)

where python >nul 2>nul
if %ERRORLEVEL%==0 (
  python "%SCRIPT_DIR%start.py" %*
  exit /b %ERRORLEVEL%
)

echo Error: Python 3 was not found. Install Python 3, or use the prebuilt remote-control release zip.
exit /b 1
