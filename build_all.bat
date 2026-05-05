@echo off
setlocal EnableDelayedExpansion

rem Build Markdown Interpreter for Windows (NSIS/exe) and Linux (deb/rpm/AppImage).
rem Linux build runs inside WSL. Run this from the repo root.

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo.
echo === Markdown Interpreter: build all ===
echo Repo: %ROOT%
echo.

rem ---- Windows build ---------------------------------------------------------
echo [1/2] Building Windows target...
pushd "%ROOT%" || (echo Failed to cd into repo root. & exit /b 1)

where npm >nul 2>&1
if errorlevel 1 (
    echo ERROR: npm not found on PATH. Install Node.js first.
    popd & exit /b 1
)

where cargo >nul 2>&1
if errorlevel 1 (
    echo ERROR: cargo not found on PATH. Install Rust ^(https://rustup.rs^) first.
    popd & exit /b 1
)

call npm install
if errorlevel 1 (echo ERROR: npm install failed. & popd & exit /b 1)

call npm run build
if errorlevel 1 (echo ERROR: Windows build failed. & popd & exit /b 1)

popd
echo [1/2] Windows build OK.
echo.

rem ---- Linux build via WSL ---------------------------------------------------
echo [2/2] Building Linux target via WSL...

where wsl >nul 2>&1
if errorlevel 1 (
    echo ERROR: WSL not found. Install WSL ^(`wsl --install`^) and a Linux distro,
    echo        then rerun this script. Skipping Linux build.
    exit /b 1
)

wsl -e bash -lc "true" >nul 2>&1
if errorlevel 1 (
    echo ERROR: No WSL distro is available. Run `wsl --install -d Ubuntu` and retry.
    exit /b 1
)

rem Convert the Windows repo path to a WSL path (e.g. /mnt/c/...).
for /f "usebackq delims=" %%P in (`wsl -e wslpath -a "%ROOT%"`) do set "WSL_ROOT=%%P"
if not defined WSL_ROOT (
    echo ERROR: Could not translate repo path to WSL path.
    exit /b 1
)

echo WSL repo path: %WSL_ROOT%

rem Check that Linux toolchain is present inside WSL; if not, tell the user.
wsl -e bash -lc "command -v cargo >/dev/null && command -v npm >/dev/null && command -v cargo-tauri >/dev/null || cargo tauri --version >/dev/null 2>&1"
if errorlevel 1 (
    echo WSL is missing build tools. Installing Linux dependencies...
    wsl -e bash -lc "cd '%WSL_ROOT%' && bash scripts/install-linux-deps.sh"
    if errorlevel 1 (
        echo ERROR: Failed to install Linux dependencies in WSL.
        echo        Open WSL and run: bash scripts/install-linux-deps.sh
        exit /b 1
    )
)

wsl -e bash -lc "cd '%WSL_ROOT%' && . \"$HOME/.cargo/env\" 2>/dev/null; npm install && npm run build"
if errorlevel 1 (
    echo ERROR: Linux build failed inside WSL.
    exit /b 1
)

echo [2/2] Linux build OK.
echo.

rem ---- Summary ---------------------------------------------------------------
set "OUT=%ROOT%\src-tauri\target\release\bundle"
echo === Build complete ===
echo Windows artifacts: %OUT%\nsis\  (and raw exe in src-tauri\target\release\)
echo Linux artifacts:   %OUT%\deb\, %OUT%\rpm\, %OUT%\appimage\
echo.

endlocal
exit /b 0
