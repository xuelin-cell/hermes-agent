; desktop-mt: 由 installer.nsh 的 customHeader 引入。此时模板已按默认引入运行检查要用的 getProcessInfo.nsh 和 $pid，
; 这里定义的 customCheckAppRunning 先换掉解压方式，再执行模板原来的运行检查。
!macro customCheckAppRunning
  !include "${UNIWORK_NSIS_DIR}\direct-extract.nsh"
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend
