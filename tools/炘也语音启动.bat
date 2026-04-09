@echo off
title Xinye TTS Launcher

echo Starting GPT-SoVITS...
start "GPT-SoVITS" /D "E:\TM\G\GPT-SoVITS-0822-cu124" runtime\python.exe api_v2.py

echo Starting cpolar...
start "cpolar" /D "D:\Cpolar" cpolar.exe http 9880

echo Waiting for cpolar to connect...
timeout /t 8 /nobreak > nul

echo Getting tunnel URL...
powershell -NoProfile -Command "$ports=@(4042,4040,4041);foreach($p in $ports){try{$r=Invoke-RestMethod \"http://127.0.0.1:$p/api/tunnels\" -TimeoutSec 3;$url=($r.tunnels|Where-Object{$_.proto -eq 'https'}).public_url;if($url){Write-Host '';Write-Host '================================';Write-Host 'Copy this URL to phone app TTS:';Write-Host '';Write-Host $url;Write-Host '================================';Write-Host '';break}}catch{}}"

pause
