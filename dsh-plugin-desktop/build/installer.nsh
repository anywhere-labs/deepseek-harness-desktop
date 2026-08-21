; Closing the window only hides DSH Desktop to the tray, so electron-builder's
; default WM_CLOSE check cannot release the install directory. Ask the running
; instance to quit through the single-instance lock, then force-kill the process
; tree if it is still holding files.
!macro customCheckAppRunning
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 dsh_skip_quit_request
    ; ExecWait returns when this helper process exits, not when the first
    ; instance finishes teardown. Sleep afterwards to give shutdown a chance.
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit'
    Sleep 2000
  dsh_skip_quit_request:

  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $R0
  Sleep 800
!macroend
