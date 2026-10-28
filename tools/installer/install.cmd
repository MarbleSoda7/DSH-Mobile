@echo off
rem 7zSD 自解压包的入口。解压目录由 SFX 指定（%TEMP%\...），这里只用相对路径。
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-DshMobile.ps1"
if errorlevel 1 (
  echo.
  echo 安装失败，请把上面的红字发给开发者。
  pause
)
exit /b %errorlevel%
