@echo off
REM Launcher for the local race runner. Point Task Scheduler here.
REM Logs go to run.log so we can see what happened after the fact.
cd /d %~dp0
node race-runner.mjs >> run.log 2>&1
