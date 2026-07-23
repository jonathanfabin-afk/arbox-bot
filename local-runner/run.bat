@echo off
REM Self-restarting wrapper. If node.exe dies for any reason, restart it after 3s.
REM Task Scheduler handles the higher-level "make sure cmd.exe is alive" via 1-min repetition.
cd /d %~dp0
:loop
echo [%date% %time%] starting race-runner... >> run.log
node race-runner.mjs >> run.log 2>&1
echo [%date% %time%] race-runner exited with code %errorlevel%, restarting in 3s >> run.log
timeout /t 3 /nobreak > nul
goto loop
