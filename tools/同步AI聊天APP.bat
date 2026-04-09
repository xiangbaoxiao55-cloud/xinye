@echo off
cd /d C:\Users\25809\ai-chat-app
if errorlevel 1 ( echo [ERROR] 找不到项目目录 C:\Users\25809\ai-chat-app & pause & exit /b 1 )
echo 正在复制最新文件并同步 Android...
copy /Y "D:\Download\Claude code\chat-app\index.html" "www\index.html"
copy /Y "D:\Download\Claude code\chat-app\manifest.json" "www\manifest.json"
copy /Y "D:\Download\Claude code\chat-app\sw.js" "www\sw.js"
copy /Y "D:\Download\Claude code\chat-app\icon.svg" "www\icon.svg"
if errorlevel 1 ( echo [ERROR] 复制文件失败 & pause & exit /b 1 )
call npx cap sync android
if errorlevel 1 ( echo [FAIL] 同步失败 & pause & exit /b 1 )
echo [OK] 同步完成！
pause
