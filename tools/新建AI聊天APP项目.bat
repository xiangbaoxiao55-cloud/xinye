@echo off
chcp 65001 > nul
echo ================================================
echo  新建 AI Chat APK 项目（一次性运行）
echo ================================================
echo.

set PROJECT_DIR=C:\Users\25809\ai-chat-app
set SRC_HTML=D:\Download\Claude code\chat-app\index.html

echo 项目目录: %PROJECT_DIR%
echo.

if exist "%PROJECT_DIR%" (
  echo [提示] 目录已存在，跳过初始化
  goto :sync
)

echo [1/5] 创建项目目录...
mkdir "%PROJECT_DIR%"
cd /d "%PROJECT_DIR%"

echo [2/5] 初始化 npm...
call npm init -y
if errorlevel 1 ( echo [ERROR] npm init 失败 & pause & exit /b 1 )

echo [3/5] 安装 Capacitor...
call npm install @capacitor/core @capacitor/cli @capacitor/android
if errorlevel 1 ( echo [ERROR] 安装失败 & pause & exit /b 1 )

echo [4/5] 初始化 Capacitor 项目...
call npx cap init "AI Chat" "com.aichat.app" --web-dir www
if errorlevel 1 ( echo [ERROR] cap init 失败 & pause & exit /b 1 )

echo [5/5] 添加 Android 平台...
call npx cap add android
if errorlevel 1 ( echo [ERROR] cap add android 失败 & pause & exit /b 1 )

:sync
echo.
echo [同步] 复制所有文件并同步到 Android...
cd /d "%PROJECT_DIR%"
if not exist "www" mkdir www
copy /Y "%SRC_HTML%" "%PROJECT_DIR%\www\index.html"
copy /Y "D:\Download\Claude code\chat-app\manifest.json" "%PROJECT_DIR%\www\manifest.json"
copy /Y "D:\Download\Claude code\chat-app\sw.js" "%PROJECT_DIR%\www\sw.js"
copy /Y "D:\Download\Claude code\chat-app\icon.svg" "%PROJECT_DIR%\www\icon.svg"
if errorlevel 1 ( echo [ERROR] 复制文件失败 & pause & exit /b 1 )
call npx cap sync android
if errorlevel 1 ( echo [ERROR] cap sync 失败 & pause & exit /b 1 )

echo.
echo ================================================
echo  完成！用 Android Studio 打开以下目录打包 APK：
echo  %PROJECT_DIR%\android
echo ================================================
pause
