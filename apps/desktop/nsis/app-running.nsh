; desktop-mt: 由 installer.nsh 的 customHeader 引入。此时模板已按默认引入运行检查要用的 getProcessInfo.nsh 和 $pid，
; 这里定义的 customCheckAppRunning 先换掉解压方式，再执行模板原来的运行检查。
;
; 运行检查之后判断这次是不是升级同一个安装目录（incremental-update.nsh 的 UNIWORK_DECIDE）。
; 是的话先把本安装上下文的 UninstallString 藏起来：模板随后插入的 uninstallOldVersion 读到空串就原地返回，
; 旧卸载器不会把整个安装目录删掉；旧文件由升级计划在解压前删掉，注册表和快捷方式由安装器自己重写。
; NSIS 不允许在宏里定义宏，所以不能直接替换 uninstallOldVersion。
; 卸载程序编译时（BUILD_UNINSTALLER）没有 installUtil.nsh，这段跳过。
!macro customCheckAppRunning
  !include "${UNIWORK_NSIS_DIR}\direct-extract.nsh"
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    !insertmacro UNIWORK_DECIDE
  !endif
  ; The template's uninstallOldVersion uses a blocking ExecWait with no timeout.
  ; A wedged old-uninstaller (it deletes the tree, then spins at 100% CPU) then
  ; blocks the installer forever. Normal uninstall of ~95k files finishes well
  ; inside 12 minutes, so a late watchdog is harmless; a wedged one is killed.
  ExecShell "open" "powershell.exe" "-NoProfile -WindowStyle Hidden -Command Start-Sleep -Seconds 720; Get-Process old-uninstaller -ErrorAction SilentlyContinue | Stop-Process -Force" SW_HIDE
!macroend
