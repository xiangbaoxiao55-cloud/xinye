chcp 65001
@echo off
title 炘也 OmniVoice TTS 启动器

echo 正在启动 cpolar 隧道...
start "cpolar-omni-tts" cmd /k "cpolar start xinye-Omni-tts"

timeout /t 6 /nobreak >nul

echo 正在启动 OmniVoice 中间件...
start "OmniVoice-Bridge" cmd /k "D:\omnivoice-env\Scripts\activate && python D:\omnivoice-env\omnivoice_bridge.py"

echo.
echo 两个服务已启动！
echo cpolar: https://xinye-omni-tts.cpolar.top
echo 中间件: http://localhost:8002
echo.
echo 可以关闭这个窗口了～
pause
