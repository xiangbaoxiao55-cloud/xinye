@echo off
cd /d C:\Users\25809\xinye-app
if errorlevel 1 (
  echo [ERROR] 找不到目录 C:\Users\25809\xinye-app
  pause
  exit /b 1
)
echo 正在同步 Android...
call npx cap sync android
echo.
if errorlevel 1 (
  echo [FAIL] 同步失败，请看上方错误信息
) else (
  echo [OK] 同步完成！
)
pause
