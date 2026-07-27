@echo off
REM Atomic single-instance guard at the wrapper level. `9>>wrapper.lock` opens
REM an EXCLUSIVE handle on the lock file — a second invocation's redirect
REM fails, and the outer `||` fires the fast exit. Handle releases automatically
REM on process death, so there's no stale-PID problem to solve.
cd /d %~dp0
2>nul ( 9>>"%~dp0wrapper.lock" ( call :run ) ) || ( echo [%date% %time%] wrapper already running, exit >> run.log & exit /b 0 )
exit /b

:run
:loop
echo [%date% %time%] launching race-runner... >> run.log
node race-runner.mjs >> run.log 2>&1
if %errorlevel%==0 (
  echo [%date% %time%] clean exit ^(duplicate node detected^) - sleep 60s >> run.log
  timeout /t 60 /nobreak > nul
) else (
  echo [%date% %time%] race-runner crashed with code %errorlevel% - restart in 3s >> run.log
  timeout /t 3 /nobreak > nul
)
goto loop
