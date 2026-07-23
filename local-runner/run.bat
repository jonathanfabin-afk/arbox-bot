@echo off
REM Self-restarting wrapper. race-runner.mjs uses a lock file so if we're a
REM duplicate spawn (Task Scheduler fired us while another instance is running)
REM node will detect that and exit immediately with code 0 — in which case
REM we back off for a long time before checking again, so we don't burn CPU.
cd /d %~dp0
:loop
echo [%date% %time%] launching race-runner... >> run.log
node race-runner.mjs >> run.log 2>&1
if %errorlevel%==0 (
  echo [%date% %time%] clean exit ^(likely duplicate detected^) - sleeping 60s >> run.log
  timeout /t 60 /nobreak > nul
) else (
  echo [%date% %time%] race-runner crashed with code %errorlevel% - restarting in 3s >> run.log
  timeout /t 3 /nobreak > nul
)
goto loop
