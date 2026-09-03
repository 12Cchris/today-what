@echo off
cd /d "%~dp0"

echo ================================
echo       GitHub Upload
echo ================================
echo.

git add .

git commit -m "Update"

git push origin main

echo.
echo ================================
echo       Upload Complete
echo ================================
pause