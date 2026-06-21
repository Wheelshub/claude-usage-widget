Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\WheelsHub\iCUe\collector"
sh.Run """C:\Program Files\nodejs\node.exe"" ""D:\WheelsHub\iCUe\collector\server.js""", 0, False
