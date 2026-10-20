@echo off
setlocal EnableExtensions EnableDelayedExpansion
title ClearCare - test execution
cd /d "%~dp0"
echo ============================================================
echo  ClearCare - automated test run (English / Espanol / Hindi)
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Node.js is not installed or not on PATH.
  echo        Install Node.js 22 LTS from https://nodejs.org and run this file again.
  goto :end
)
for /f "tokens=*" %%v in ('node -p "process.versions.node"') do set NODEVER=%%v
for /f "tokens=1,2 delims=." %%a in ("%NODEVER%") do (set NODEMAJOR=%%a& set NODEMINOR=%%b)
echo Node.js version: %NODEVER%
if %NODEMAJOR% LSS 18 (
  echo [FAIL] Node.js 18 or newer is required. Node 22.13+ is recommended.
  goto :end
)
if %NODEMAJOR% LSS 22 echo [NOTE] Node ^< 22.13: server-side pdf.js tests will be SKIPPED ^(browser still uses pdf.js^).
if %NODEMAJOR% EQU 22 if %NODEMINOR% LSS 13 echo [NOTE] Node ^< 22.13: server-side pdf.js tests will be SKIPPED ^(browser still uses pdf.js^).

rem Optional .env (GEMINI_API_KEY=..., GEMINI_MODEL=..., PORT=...). Lines starting with # are ignored.
if exist ".env" (
  echo Gemini settings will be read by ClearCare from .env.
)
echo The smoke test makes ONE live Gemini request only when GEMINI_API_KEY is configured.
echo.

set LOG=test-results.txt
echo ClearCare test run %DATE% %TIME% > "%LOG%"
echo Node %NODEVER% >> "%LOG%"

echo [1/3] Syntax check ...
set SYNTAX_OK=1
for %%F in (server.js public\app.js public\ext\main.js lib\ext\routes.js) do (
  node --check "%%F" >> "%LOG%" 2>&1 || set SYNTAX_OK=0
)
if "!SYNTAX_OK!"=="1" (echo       PASS) else (echo       FAIL - see %LOG%)

echo [2/3] Unit, safety, language, calendar, Gemini-mock and security tests (node --test) ...
call npm test >> "%LOG%" 2>&1
set UNIT_RC=!errorlevel!
for /f "tokens=2,3" %%a in ('findstr /b /c:"# tests" /c:"# pass" /c:"# fail" /c:"# skipped" "%LOG%"') do echo       %%a %%b
if "!UNIT_RC!"=="0" (echo       PASS) else (echo       FAIL - see %LOG%)

echo [3/3] Execution smoke test (starts the real server and calls it) ...
node tools\smoke.mjs > smoke-results.txt 2>&1
set SMOKE_RC=!errorlevel!
type smoke-results.txt
type smoke-results.txt >> "%LOG%"

echo.
set E2E_RC=skipped
choice /c YN /t 15 /d N /m "Also run the 23 browser (end-to-end) tests? Needs internet once to install Playwright"
if errorlevel 2 goto :summary
if not exist "node_modules\playwright" (
  echo Installing Playwright + axe-core locally ^(not saved to package.json^) ...
  call npm i --no-save playwright@1.56.0 axe-core@4.10.2 >> "%LOG%" 2>&1
  call npx playwright install chromium >> "%LOG%" 2>&1
)
node e2e\run-e2e.mjs
set E2E_RC=!errorlevel!

:summary
echo.
echo ======================= SUMMARY ===========================
if "!SYNTAX_OK!"=="1" (echo  Syntax check ........ PASS) else (echo  Syntax check ........ FAIL)
if "!UNIT_RC!"=="0" (echo  Automated tests ..... PASS) else (echo  Automated tests ..... FAIL)
if "!SMOKE_RC!"=="0" (echo  Smoke test .......... PASS) else (echo  Smoke test .......... FAIL)
if "!E2E_RC!"=="skipped" (echo  Browser E2E ......... skipped) else if "!E2E_RC!"=="0" (echo  Browser E2E ......... PASS) else (echo  Browser E2E ......... FAIL)
echo  Full log: %CD%\%LOG%
echo ============================================================
echo.
choice /c YN /t 20 /d N /m "Open the ClearCare desktop app now"
if errorlevel 2 goto :end
call "%~dp0START_CLEARCARE.bat"

:end
echo.
pause
endlocal
