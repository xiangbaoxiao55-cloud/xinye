@echo off
chcp 65001 > nul
echo ================================================
echo  AI Chat APP 图标生成工具
echo ================================================
echo.
echo 使用方法：
echo 1. 准备一张正方形图片（推荐 512x512 或更大）
echo 2. 把图片放到：D:\Download\Claude code\chat-app\
echo    命名为：icon-source.png
echo 3. 按任意键开始生成...
echo.
pause

cd /d "D:\Download\Claude code\chat-app"

echo 检查 sharp 模块...
if not exist "node_modules\sharp" (
  echo 首次使用，正在安装 sharp...
  call npm install sharp
  if errorlevel 1 ( echo [ERROR] 安装 sharp 失败 & pause & exit /b 1 )
)

echo 正在生成各尺寸图标...
node make-icons.cjs
if errorlevel 1 (
  echo.
  echo [提示] 如果报错 cannot find module 'sharp'，请先运行：
  echo   cd C:\Users\25809\ai-chat-app
  echo   npm install sharp
  echo.
  pause
  exit /b 1
)

echo.
echo 图标已更新！记得重新打包 APK。
pause
