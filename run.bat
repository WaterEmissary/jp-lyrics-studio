@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv (
  echo [1/2] 创建虚拟环境 .venv ...
  python -m venv .venv || (echo 需要先安装 Python 3.9+ & pause & exit /b 1)
  .venv\Scripts\python -m pip install -r requirements.txt || (pause & exit /b 1)
)
echo [2/2] 启动 JP Lyrics Studio ...
.venv\Scripts\python run.py %*
pause
