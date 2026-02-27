@echo off
:: Claude Code Dashboard - Auto-start script
:: Runs the dashboard server in background on Windows login

cd /d "C:\_project\template\wiw_claude-code\dashboard"
start /min "Claude Dashboard" node server.js
