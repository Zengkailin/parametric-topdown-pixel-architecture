@echo off
rem 用默认浏览器打开本地工具；纯静态页面，不需要服务器。
cd /d "%~dp0"
start "" "%~dp0index.html"
