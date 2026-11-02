; desktop-mt: 由 installer.nsh 的 customHeader 引入。此时模板已按默认引入运行检查要用的 getProcessInfo.nsh 和 $pid，
; 这里定义的 customCheckAppRunning 先换掉解压方式，再执行模板原来的运行检查。
;
; 运行检查之后判断这次是不是升级同一个安装目录（incremental-update.nsh 的 UNIWORK_DECIDE）。
; 是的话先把本安装上下文的 UninstallString 藏起来：模板随后插入的 uninstallOldVersion 读到空串就原地返回，
; 旧卸载器不会把整个安装目录删掉；旧文件由升级计划在解压前删掉，注册表和快捷方式由安装器自己重写。
; NSIS 不允许在宏里定义宏，所以不能直接替换 uninstallOldVersion。
; 卸载程序编译时（BUILD_UNINSTALLER）没有 installUtil.nsh，这段跳过。
!macro customCheckAppRunning
  ; desktop-mt: 模板在段首把 SetDetailsPrint 设成 none（templates/nsis/installSection.nsh），
  ; 会把后面所有 DetailPrint 丢掉，这里覆盖回来。必须是 both：实测 NSIS 3.12 的 MUI2 安装页里，
  ; textonly 只更新进度条上方那行「当前操作」文字，详情列表（SysListView32）一条都不进，
  ; 用户点开"显示详情"只能看到空白；both 才把 DetailPrint 写成列表行，而且面板隐藏期间打印的行
  ; 会留着，点开就能看到从头到尾的过程。
  ; 当年选 textonly 是怕 both 把九万个文件的解压噪音灌进面板——现在解压是 7za 自己做的
  ; （direct-extract.nsh），NSIS 的 File 只剩几个辅助脚本，both 不再产生那种噪音。
  ; 安装器本身没有静默模式（模板只给卸载器写 SilentInstall silent），所以不用判断 ${Silent}。
  ;
  ; 注意这个宏在卸载器那一遍编译里也会展开（templates/nsis/uninstaller.nsh:2 的
  ; un.checkAppRunning 调 CHECK_APP_RUNNING）。install-log.nsh 的阶段变量只在
  ; !ifndef BUILD_UNINSTALLER 里声明，卸载器单元里引用会得到 warning 6000，
  ; 而打包用的 makensis 带 -WX，警告直接变成错误、整个打包失败——所以整块只给安装器。
  !ifndef BUILD_UNINSTALLER
    SetDetailsPrint both
    !insertmacro UniPhaseBegin 1 "检查正在运行的程序"
  !endif
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
