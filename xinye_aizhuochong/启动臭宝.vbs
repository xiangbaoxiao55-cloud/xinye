Set ws = CreateObject("WScript.Shell")
ws.CurrentDirectory = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1) & "\choubao"
ws.Run "electron .", 0, False
