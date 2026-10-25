; desktop-mt: 由 installer.nsh 的 customHeader 引入。此时模板已按默认引入运行检查要用的 getProcessInfo.nsh 和 $pid，
; 这里定义的 customCheckAppRunning 先换掉解压方式，再执行模板原来的运行检查。
!macro customCheckAppRunning
  !include "${UNIWORK_NSIS_DIR}\direct-extract.nsh"
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  ; The template's uninstallOldVersion uses a blocking ExecWait with no timeout.
  ; A wedged old-uninstaller (it deletes the tree, then spins at 100% CPU) then
  ; blocks the installer forever. Normal uninstall of ~95k files finishes well
  ; inside 12 minutes, so a late watchdog is harmless; a wedged one is killed.
  ExecShell "open" "powershell.exe" "-NoProfile -WindowStyle Hidden -Command Start-Sleep -Seconds 720; Get-Process old-uninstaller -ErrorAction SilentlyContinue | Stop-Process -Force" SW_HIDE
!macroend
