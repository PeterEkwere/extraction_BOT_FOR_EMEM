@echo off
set PATH=%PATH%;C:\Perl64\bin
title (RFQ_Inquiry)
@REM color 0aa
:StartRFQDoings
npx electron db-worker.js
cls
:end
exit /s
