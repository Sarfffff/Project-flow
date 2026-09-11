@echo off
title Flow Project Manager
python -B "%~dp0src\open_flow.py"
if errorlevel 1 pause
