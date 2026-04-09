@echo off
set /p HOUR=Hour (0-23):
set /p MIN=Minute (0-59, Enter=00):
if "%MIN%"=="" set MIN=0
powershell -NoProfile -Command "$now=Get-Date;$h=[int]'%HOUR%';$m=[int]'%MIN%';$target=$now.Date.AddHours($h).AddMinutes($m);if($target -le $now){$target=$target.AddDays(1)};$sec=[int]($target-$now).TotalSeconds;shutdown /s /f /t $sec;Write-Host ('Shutdown at ' + $target.ToString('HH:mm') + '  -  close this window to cancel')"
pause
