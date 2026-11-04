; desktop-mt: 由 installer.nsh 的 customHeader 引入。此时模板已按默认引入运行检查要用的 getProcessInfo.nsh 和 $pid，
; 这里定义的 customCheckAppRunning 先换掉解压方式，再执行模板原来的运行检查。
;
; 运行检查之后判断这次是不是升级同一个安装目录（incremental-update.nsh 的 UNIWORK_DECIDE）。
; 是的话先把本安装上下文的 UninstallString 藏起来：模板随后插入的 uninstallOldVersion 读到空串就原地返回，
; 旧卸载器不会把整个安装目录删掉；旧文件由升级计划在解压前删掉，注册表和快捷方式由安装器自己重写。
; NSIS 不允许在宏里定义宏，所以不能直接替换 uninstallOldVersion。
; 卸载程序编译时（BUILD_UNINSTALLER）没有 installUtil.nsh，这段跳过。

; desktop-mt: 跳过模板的 IS_POWERSHELL_AVAILABLE（要启动 powershell.exe 两次，AV 下每次 10-20 秒），
; 改用 cmd 的文件存在性检查（毫秒级）。$IsPowerShellAvailable 仍保留两态供 UNIWORK_DECIDE 和
; update-plan.ps1 使用；FIND_PROCESS / KILL_PROCESS 则在下面重定义为 tasklist / taskkill，
; 彻底省掉进程检测的 PowerShell 冷启动。
Var /GLOBAL IsPowerShellAvailable

; 重定义 FIND_PROCESS：用 tasklist + findstr 按文件名匹配，替代模板里 Get-CimInstance 按路径匹配。
; tasklist 是 cmd 内置命令，不启动 PowerShell，AV 下毫秒级返回。
; 对 Electron 应用：所有子进程（main/renderer/GPU）文件名都是 ${APP_EXECUTABLE_FILENAME}，
; tasklist /FI "IMAGENAME eq" 能全部匹配到，效果等同模板的 PS 路径前缀匹配。
!ifdef FIND_PROCESS
  !undef FIND_PROCESS
!endif
!macro FIND_PROCESS _FILE _RETURN
  nsExec::Exec `"$CmdPath" /C tasklist /FI "IMAGENAME eq ${_FILE}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:""${_FILE}""`
  Pop ${_RETURN}
!macroend

; 重定义 KILL_PROCESS：用 taskkill 替代模板里 Stop-Process。
; 不带 /F 时 taskkill 先发 WM_CLOSE（比 PS 的 Stop-Process 更温和，给了应用保存状态的机会）；
; _FORCE=1 时加 /F 强制终止。/FI "PID ne $pid" 排除安装器自身进程。
!ifdef KILL_PROCESS
  !undef KILL_PROCESS
!endif
!macro KILL_PROCESS _FILE _FORCE
  ${If} ${_FORCE} == 1
    nsExec::Exec `"$CmdPath" /C taskkill /F /IM "${_FILE}" /FI "PID ne $pid"`
  ${Else}
    nsExec::Exec `"$CmdPath" /C taskkill /IM "${_FILE}" /FI "PID ne $pid"`
  ${EndIf}
  Pop $0
!macroend

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
  ; desktop-mt: 用 cmd 的文件存在性检查替代模板的 IS_POWERSHELL_AVAILABLE（省掉两次 PowerShell 冷启动，
  ; AV 下约 20-40 秒）。$PowerShellPath 由模板 CHECK_APP_RUNNING 在调本宏之前已设好。
  ; 执行策略不再单独检查：我们调 PowerShell 时始终带 -ExecutionPolicy Bypass。
  !insertmacro UniSay "正在检测运行环境..."
  ${If} ${FileExists} "$PowerShellPath"
    StrCpy $IsPowerShellAvailable 0
  ${Else}
    StrCpy $IsPowerShellAvailable 1
  ${EndIf}
  ; FIND_PROCESS / KILL_PROCESS 已在文件顶层重定义为 tasklist / taskkill，
  ; _CHECK_APP_RUNNING 展开时会用我们的版本，不再启动 PowerShell 做进程检测。
  !insertmacro UniSay "正在检查程序运行状态..."
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    !insertmacro UniSay "正在判断升级方式..."
    !insertmacro UNIWORK_DECIDE
  !endif
  ; The template's uninstallOldVersion uses a blocking ExecWait with no timeout.
  ; A wedged old-uninstaller (it deletes the tree, then spins at 100% CPU) then
  ; blocks the installer forever. Normal uninstall of ~95k files finishes well
  ; inside 12 minutes, so a late watchdog is harmless; a wedged one is killed.
  ExecShell "open" "powershell.exe" "-NoProfile -WindowStyle Hidden -Command Start-Sleep -Seconds 720; Get-Process old-uninstaller -ErrorAction SilentlyContinue | Stop-Process -Force" SW_HIDE
!macroend
