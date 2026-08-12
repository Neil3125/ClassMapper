@echo off
setlocal
cd /d "%~dp0"

set PORT=8765
set URL=http://localhost:%PORT%

rem Is something already serving on the port? If so just open it.
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >NUL 2>&1
if not errorlevel 1 (
    echo ClassMapper is already running.
    start "" "%URL%"
    goto :eof
)

rem Make sure python exists before promising anything.
where python >NUL 2>&1
if errorlevel 1 (
    echo.
    echo ERROR: Python was not found on your PATH.
    echo Install it from python.org, then run this again.
    echo.
    pause
    goto :eof
)

echo Starting ClassMapper server on port %PORT%...
start "ClassMapper server" /MIN python "%~dp0serve.py" %PORT%

rem Wait for it to actually accept connections (max ~15s).
set /a TRIES=0
:waitloop
set /a TRIES+=1
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >NUL 2>&1
if not errorlevel 1 goto ready
if %TRIES% GEQ 15 (
    echo.
    echo ERROR: Server did not start. Is port %PORT% blocked?
    echo.
    pause
    goto :eof
)
ping -n 2 127.0.0.1 >NUL
goto waitloop

:ready
echo Server is up. Opening browser...
start "" "%URL%"
echo.
echo ClassMapper is running at %URL%
echo Run stop.bat when you are done.
ping -n 4 127.0.0.1 >NUL
