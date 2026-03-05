Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d C:\cygwin64\home\sulej\projects\boogagart-crm && node server.js", 0, False
