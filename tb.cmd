@echo off
rem 命令行版快捷入口：tb render forest inn -o out\inn.png
rem 需要 Node 18+；PowerShell 里请写 .\tb.cmd
node "%~dp0cli\tb.js" %*
