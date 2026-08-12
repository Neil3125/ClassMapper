@echo off
setlocal
cd /d "%~dp0"

set PORT=8765

echo Looking for the ClassMapper server on port %PORT%...

powershell -NoProfile -Command ^
  "$c = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue;" ^
  "if (-not $c) { Write-Host 'Nothing is running on port %PORT%.'; exit 0 }" ^
  "$pids = $c | Select-Object -ExpandProperty OwningProcess -Unique;" ^
  "foreach ($id in $pids) {" ^
  "  $p = Get-Process -Id $id -ErrorAction SilentlyContinue;" ^
  "  if (-not $p) { continue }" ^
  "  Write-Host ('Stopping ' + $p.ProcessName + ' (PID ' + $id + ')...');" ^
  "  try { Stop-Process -Id $id -Force -ErrorAction Stop } catch { Write-Host ('  could not stop PID ' + $id + ': ' + $_.Exception.Message) }" ^
  "}" ^
  "Start-Sleep -Milliseconds 600;" ^
  "if (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue) { Write-Host 'Port %PORT% is still in use.'; exit 1 } else { Write-Host 'Stopped. Port %PORT% is free.' }"

if exist "%~dp0.server.pid" del "%~dp0.server.pid" >NUL 2>&1

ping -n 4 127.0.0.1 >NUL
