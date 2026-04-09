@echo off
title 炘也启动器

echo 启动 GPT-SoVITS...
start "GPT-SoVITS" /D "E:\TM\G\GPT-SoVITS-0822-cu124" runtime\python.exe api_v2.py

echo 启动 cpolar 隧道（主API + TTS）...
timeout /t 5 /nobreak > nul
cpolar start xinye xinye-tts

pause
