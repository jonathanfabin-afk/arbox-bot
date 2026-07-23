' Silent launcher — spawns run.bat with NO visible console window.
' Task Scheduler points at wscript.exe launcher.vbs so the user can never
' accidentally close a stray cmd window.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
' 0 = SW_HIDE, False = don't wait for the process to finish
sh.Run """" & scriptDir & "\run.bat""", 0, False
