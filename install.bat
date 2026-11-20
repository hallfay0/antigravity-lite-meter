@echo off
setlocal
cd /d "%~dp0"
node cli.js install %*
pause
