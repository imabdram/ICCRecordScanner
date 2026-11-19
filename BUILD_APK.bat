@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title ICC Record Scanner - Flutter APK Builder

echo ======================================================
echo       ICC RECORD SCANNER - FLUTTER APK BUILDER
echo ======================================================
echo.

where flutter >nul 2>nul
if errorlevel 1 (
  echo ERROR: Flutter was not found in PATH.
  echo Add Flutter\bin to Windows PATH, then reopen this window.
  pause
  exit /b 1
)

echo [1/6] Checking Flutter and Android toolchain...
call flutter doctor
if errorlevel 1 (
  echo.
  echo Flutter Doctor reported a blocking problem.
  pause
  exit /b 1
)

echo.
echo [2/6] Creating Android platform files...
if not exist "android\gradlew.bat" (
  call flutter create --platforms=android --org com.dhom --project-name icc_record_scanner .
  if errorlevel 1 goto :failed
)

echo.
echo [3/6] Adding camera permission safely...
powershell -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\prepare_android.ps1"
if errorlevel 1 goto :failed

echo.
echo [4/7] Downloading Flutter packages...
call flutter pub get
if errorlevel 1 goto :failed

echo.
echo [5/7] Generating launcher icon...
call dart run flutter_launcher_icons
if errorlevel 1 goto :failed

echo.
echo [6/7] Stopping Gradle and cleaning old build...
if exist "android\gradlew.bat" (
  pushd android
  call gradlew.bat --stop >nul 2>nul
  popd
)

rem Flutter clean can fail when Windows temporarily locks a file.
call flutter clean
if exist "build" (
  echo Build folder is still locked. Retrying removal...
  timeout /t 2 /nobreak >nul
  rmdir /s /q "build" 2>nul
)
if exist "build" (
  echo WARNING: The old build folder is still in use.
  echo Continuing; Gradle may still build successfully.
)

call flutter pub get
if errorlevel 1 goto :failed

echo.
echo [7/7] Building release APK...
call flutter build apk --release
if errorlevel 1 goto :failed

if not exist "build\app\outputs\flutter-apk\app-release.apk" (
  echo ERROR: Flutter reported success, but the APK was not found.
  goto :failed
)

if not exist "output" mkdir "output"
copy /Y "build\app\outputs\flutter-apk\app-release.apk" "output\ICCRecordScanner.apk" >nul

echo.
echo ======================================================
echo BUILD SUCCESSFUL
echo APK: %CD%\output\ICCRecordScanner.apk
echo ======================================================
start "" "%CD%\output"
pause
exit /b 0

:failed
echo.
echo ======================================================
echo BUILD FAILED. Read the first error shown above.
echo ======================================================
pause
exit /b 1
