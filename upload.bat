@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "REPO_URL=https://github.com/12Cchris/today-what.git"
set "BRANCH=main"

echo ================================
echo       GitHub Upload
echo ================================
echo.

rem Git 설치 확인
git --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Git이 설치되어 있지 않습니다.
    echo Git을 설치한 후 다시 실행해주세요.
    goto :FAIL
)

rem 새 폴더에 .git이 없으면 저장소를 자동으로 연결
if not exist ".git\" (
    echo [1/5] Git 저장소 초기화 중...
    git init
    if errorlevel 1 goto :FAIL

    git remote add origin "%REPO_URL%"
    if errorlevel 1 goto :FAIL

    echo [2/5] 기존 GitHub 저장소 정보 가져오는 중...
    git fetch origin
    if errorlevel 1 (
        echo [ERROR] GitHub 저장소를 가져오지 못했습니다.
        echo 로그인 상태와 저장소 주소를 확인해주세요.
        goto :FAIL
    )

    rem 원격 main을 기준으로 새 폴더의 작업 파일을 유지
    git checkout -B "%BRANCH%"
    if errorlevel 1 goto :FAIL

    git reset --mixed "origin/%BRANCH%"
    if errorlevel 1 (
        echo [ERROR] 원격 main 브랜치와 연결하지 못했습니다.
        goto :FAIL
    )
) else (
    echo [1/5] 기존 Git 저장소 확인 완료.
)

rem origin이 없으면 다시 설정
for /f "delims=" %%A in ('git remote get-url origin 2^>nul') do set "CURRENT_REMOTE=%%A"
if not defined CURRENT_REMOTE (
    git remote add origin "%REPO_URL%"
    if errorlevel 1 goto :FAIL
) else (
    echo 현재 원격 저장소: %CURRENT_REMOTE%
)

echo [3/5] 파일 변경사항 확인 중...
git add .
if errorlevel 1 goto :FAIL

git diff --cached --quiet
if not errorlevel 1 (
    echo.
    echo 변경된 파일이 없습니다. 업로드할 내용이 없습니다.
    goto :SUCCESS
)

echo [4/5] 커밋 생성 중...
git commit -m "Update"
if errorlevel 1 goto :FAIL

echo [5/5] GitHub에 업로드 중...
git push -u origin "%BRANCH%"
if errorlevel 1 goto :FAIL

goto :SUCCESS

:SUCCESS
echo.
echo ================================
echo       Upload Complete
echo ================================
echo.
pause
exit /b 0

:FAIL
echo.
echo ================================
echo          Upload Failed
echo ================================
echo 위의 오류 메시지를 확인해주세요.
echo.
pause
exit /b 1
