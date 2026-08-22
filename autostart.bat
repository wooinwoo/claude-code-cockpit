@echo off
:: Claude Code Dashboard - Auto-start script
:: Runs the dashboard server in background on Windows login
:: 스크립트 자신의 위치(%~dp0)를 기준으로 동작 — 저장소 루트에 두면 OK

cd /d "%~dp0"
start /min "Claude Dashboard" node server.js
