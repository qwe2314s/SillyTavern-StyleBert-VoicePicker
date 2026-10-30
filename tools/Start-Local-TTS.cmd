@echo off
chcp 65001 >nul
set "SBVP_PY=E:\sbv2\venv\Scripts\python.exe"
if not exist "%SBVP_PY%" (
  echo Python not found: %SBVP_PY%
  pause
  exit /b 1
)
"%SBVP_PY%" -B "%~dp0voice_server.py" --sbv2-dir "E:\sbv2\Style-Bert-VITS2" %*
pause
