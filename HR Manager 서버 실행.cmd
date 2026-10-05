@echo off
chcp 65001 >nul
title HR Manager 서버
cd /d "%~dp0"

echo ==================================================
echo   HR Manager 서버 실행기
echo ==================================================

rem 1. Node.js 확인
where node >nul 2>nul
if errorlevel 1 (
  echo [오류] Node.js 가 설치되어 있지 않습니다. 설치 페이지를 엽니다.
  start "" https://nodejs.org/ko
  pause
  exit /b 1
)

rem 2. 패키지 설치 (처음 한 번, 또는 package.json 이 바뀌었을 때)
if not exist "node_modules\.package-lock.json" goto install
for %%A in ("package.json") do set PKG_TIME=%%~tA
if not exist "node_modules\.installed" goto install
set /p INSTALLED=<"node_modules\.installed"
if not "%INSTALLED%"=="%PKG_TIME%" goto install
goto certs

:install
echo [준비] 패키지를 설치합니다...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo [오류] 패키지 설치에 실패했습니다.
  pause
  exit /b 1
)
for %%A in ("package.json") do echo %%~tA>"node_modules\.installed"

:certs
rem 3. https 인증서 준비 + 이 PC에 사내 인증서 등록 (처음 한 번, 확인 창에서 [예])
for /f %%T in ('node server\tls.js prepare') do set CA_THUMB=%%T
if "%CA_THUMB%"=="" (
  echo [오류] https 인증서를 만들지 못했습니다.
  pause
  exit /b 1
)
powershell -NoProfile -NonInteractive -Command "$s=New-Object Security.Cryptography.X509Certificates.X509Store('Root','CurrentUser');$s.Open('ReadOnly');if($s.Certificates.Find('FindByThumbprint','%CA_THUMB%',$false).Count){exit 0}else{exit 1}"
if errorlevel 1 (
  echo [준비] 이 PC에 HR Manager 사내 인증서를 등록합니다. 확인 창이 뜨면 [예]를 누르세요.
  certutil -user -addstore Root "data\certs\ca.crt" >nul
)

rem 4. 서버가 뜨면 브라우저 열기
start "" /min cmd /c "timeout /t 3 >nul & start https://localhost:3443"

rem 5. 서버 실행 (비정상 종료 시 5초 후 자동 재시작, 끝내려면 이 창을 닫으세요)
:run
echo.
echo [실행] 서버를 시작합니다. 끝내려면 이 창을 닫으세요.
node server\index.js
echo.
echo [알림] 서버가 종료되었습니다 (코드 %errorlevel%). 5초 후 다시 시작합니다...
timeout /t 5 >nul
goto run
