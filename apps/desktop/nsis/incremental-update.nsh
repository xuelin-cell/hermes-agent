; desktop-mt: 升级同一个安装目录时，比对载荷里的组件指纹，没变化的运行时组件留在原位。
;
; 由 installer.nsh 的 customHeader 引入：customHeader 在脚本顶层展开，所以这里可以声明变量、定义函数；
; app-running.nsh 和 direct-extract.nsh 是在宏体里展开的，那里只能定义宏（NSIS 不允许宏里再定义宏）。
;
; 流程：
;   1. UNIWORK_DECIDE（在 customCheckAppRunning 里展开）判断这次是不是升级同一个安装目录；是则把
;      本安装上下文的 UninstallString 藏起来，模板随后插入的 uninstallOldVersion 读到空串就原地返回，
;      旧卸载器不会把整个安装目录删掉。
;   2. direct-extract.nsh 的 extractUsing7za 先调 UNIWORK_TryIncremental：用随包的 7za 只从新包里取出
;      payload-stamp.txt，再跑 update-plan.ps1 逐个组件比对。新指纹只能信包里那份（构建结束后签名还会
;      改动载荷里的可执行文件），旧指纹是上次安装留下的同一文件，安装目录里的实际字节再由载荷自带的
;      解释器重算，损坏或有变化就整体替换。
;   3. 按计划删掉新版不再提供的文件（这是旧卸载器原本的清理职责），再用 7za 解压并跳过保留的组件。
;
; 计划没跑成、7za 失败都退回整包解压；计划没跑成时还先写回登记、跑一遍旧卸载器，保持以前的清理效果。

!include "LogicLib.nsh"

!define UNIWORK_PLAN "${UNIWORK_NSIS_DIR}\update-plan.ps1"
!define UNIWORK_DIGEST "${UNIWORK_NSIS_DIR}\payload-digest.py"
; run-electron-builder.mjs 的 stageIncrementalExtractor 把 sevenZip 工具集里的 7za.exe 放到这里。
!define UNIWORK_7ZA "${UNIWORK_NSIS_DIR}\..\build\nsis-tools\7za.exe"

; 卸载程序编译时不需要这些状态，声明了也只会多出一条未使用变量的警告。
!ifndef BUILD_UNINSTALLER
; 0 = 不走增量，1 = 已藏起登记、等解压时出计划，2 = 计划已执行完
Var UNIWORK_INCREMENTAL
; 1 = 删除计划已经执行过（旧卸载器不用再跑）
Var UNIWORK_PLANNED
; 当前要解压的包：$PLUGINSDIR\app-64.7z；nsis-web 时是下载到本地的那份
Var UNIWORK_ARCHIVE
; 进本流程之前的 $OUTDIR（安装目录），函数里会切到 $PLUGINSDIR 暂存工具
Var UNIWORK_OUTDIR
; 攒起来的一批 -x! 参数（一次 7za 调用的全部排除项）
Var UNIWORK_EXCLUDES
Var UNIWORK_EXTRACT_RC
; 藏起来的卸载登记，退回老流程时原样写回
Var UNIWORK_UNINSTALLER
!ifdef UNINSTALL_REGISTRY_KEY_2
Var UNIWORK_UNINSTALLER_2
!endif
!endif

; 由 customCheckAppRunning 展开：是不是在升级同一个安装目录？
; $INSTDIR 可能被自定义目录页改过，注册表里的 InstallLocation 才代表上一次真正的安装位置；
; 目录不同就是另一次安装，旧卸载器照常跑。PowerShell 不可用时没有计划，也走老流程。
!macro UNIWORK_DECIDE
  Push $0
  StrCpy $UNIWORK_INCREMENTAL 0
  StrCpy $UNIWORK_PLANNED 0
  ${If} $IsPowerShellAvailable == 0
  ${AndIf} ${FileExists} "$appExe"
  ${AndIf} ${FileExists} "$INSTDIR\resources\agent-payload\manifest.json"
  ${AndIf} ${FileExists} "$INSTDIR\resources\agent-payload\payload-stamp.txt"
    ClearErrors
    ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 == $INSTDIR
      ${If} $installMode != "all"
        StrCpy $UNIWORK_INCREMENTAL 1
      ${Else}
        ; 整机安装时模板还会跑 HKCU 里登记的旧卸载器；它指向同一个目录就会删掉整个安装目录。
        ClearErrors
        ReadRegStr $0 HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" InstallLocation
        ${If} $0 != $INSTDIR
          StrCpy $UNIWORK_INCREMENTAL 1
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $UNIWORK_INCREMENTAL == 1
    !insertmacro UNIWORK_HIDE_UNINSTALLER "${UNINSTALL_REGISTRY_KEY}" $UNIWORK_UNINSTALLER
    !ifdef UNINSTALL_REGISTRY_KEY_2
      !insertmacro UNIWORK_HIDE_UNINSTALLER "${UNINSTALL_REGISTRY_KEY_2}" $UNIWORK_UNINSTALLER_2
    !endif
    DetailPrint "升级现有安装：比对后保留未变化的组件"
  ${EndIf}
  Pop $0
!macroend

; 先记下再删掉。宏体里的 ${KEY} 在展开时才解析，所以只能写成宏。
!macro UNIWORK_HIDE_UNINSTALLER KEY VAR
  ClearErrors
  ReadRegStr ${VAR} SHELL_CONTEXT "${KEY}" UninstallString
  ${If} ${VAR} != ""
    DeleteRegValue SHELL_CONTEXT "${KEY}" UninstallString
  ${EndIf}
!macroend

; 安装器结束前总会重写这条登记（registryAddInstallInfo），提前写回只是不让安装中途失败时
; 留下一条没有卸载命令的登记。
!macro UNIWORK_RESTORE_UNINSTALLER
  ${If} $UNIWORK_UNINSTALLER != ""
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString "$UNIWORK_UNINSTALLER"
    StrCpy $UNIWORK_UNINSTALLER ""
  ${EndIf}
  !ifdef UNINSTALL_REGISTRY_KEY_2
    ${If} $UNIWORK_UNINSTALLER_2 != ""
      WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" UninstallString "$UNIWORK_UNINSTALLER_2"
      StrCpy $UNIWORK_UNINSTALLER_2 ""
    ${EndIf}
  !endif
!macroend

!ifndef BUILD_UNINSTALLER

; 把 update-plan.ps1 的说明打进安装详情：用户展开详情就能看到保留了哪些组件、为什么退回整包解压。
Function UNIWORK_PrintLog
  Push $0
  Push $1
  Push $2
  ClearErrors
  FileOpen $0 "$PLUGINSDIR\uniwork\plan.log" r
  IfErrors uniwork_log_done
  uniwork_log_loop:
    ClearErrors
    FileRead $0 $1
    IfErrors uniwork_log_close
  uniwork_log_trim:
    StrCpy $2 $1 1 -1
    ${If} $2 == "$\r"
    ${OrIf} $2 == "$\n"
      StrCpy $1 $1 -1
      Goto uniwork_log_trim
    ${EndIf}
    DetailPrint "$1"
    Goto uniwork_log_loop
  uniwork_log_close:
    FileClose $0
  uniwork_log_done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; 解压一批：$UNIWORK_EXCLUDES 是这批要跳过的归档路径。
; 只取结果码：这条命令的输出不值得塞进 nsExec 的栈里。
Function UNIWORK_ExtractExcluded
  nsExec::Exec '"$PLUGINSDIR\uniwork\7za.exe" x "$UNIWORK_ARCHIVE" -o"$INSTDIR" -y -aoa $UNIWORK_EXCLUDES'
  Pop $UNIWORK_EXTRACT_RC
FunctionEnd

; 返回时 $UNIWORK_INCREMENTAL == 2 表示计划中的文件已经就位；其余情况由调用方整包解压。
Function UNIWORK_TryIncremental
  Push $0
  Push $1
  Push $2

  SetOutPath "$PLUGINSDIR\uniwork"
  File "/oname=update-plan.ps1" "${UNIWORK_PLAN}"
  File "/oname=payload-digest.py" "${UNIWORK_DIGEST}"
  File "/oname=7za.exe" "${UNIWORK_7ZA}"

  ; 只从包里取出指纹文件，不展开整个包。
  nsExec::ExecToStack '"$PLUGINSDIR\uniwork\7za.exe" e "$UNIWORK_ARCHIVE" "resources\agent-payload\payload-stamp.txt" -o"$PLUGINSDIR\uniwork\stamp" -y'
  Pop $0
  Pop $1
  ${If} $0 != 0
  ${OrIfNot} ${FileExists} "$PLUGINSDIR\uniwork\stamp\payload-stamp.txt"
    DetailPrint "升级改为完整安装：包里没有组件指纹"
    Goto uniwork_try_done
  ${EndIf}

  ; update-plan.ps1 只读安装目录：算出要删的路径和要跳过的解压路径，失败时什么都不改。
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\uniwork\update-plan.ps1" -Install "$INSTDIR" -NewStamp "$PLUGINSDIR\uniwork\stamp\payload-stamp.txt" -DeleteFile "$PLUGINSDIR\uniwork\delete.txt" -ExcludeFile "$PLUGINSDIR\uniwork\exclude.txt" -Log "$PLUGINSDIR\uniwork\plan.log"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "升级改为完整安装：无法生成更新计划（$0）"
    Call UNIWORK_PrintLog
    Goto uniwork_try_done
  ${EndIf}
  Call UNIWORK_PrintLog

  ; 计划里的条目可能是文件也可能是目录，两个命令各管一种；不存在时留下的错误标志由下一轮清掉。
  ClearErrors
  FileOpen $0 "$PLUGINSDIR\uniwork\delete.txt" r
  IfErrors uniwork_try_done
  StrCpy $UNIWORK_PLANNED 1
  uniwork_try_delete_loop:
    ClearErrors
    FileRead $0 $1
    IfErrors uniwork_try_delete_close
  uniwork_try_delete_trim:
    StrCpy $2 $1 1 -1
    ${If} $2 == "$\r"
    ${OrIf} $2 == "$\n"
      StrCpy $1 $1 -1
      Goto uniwork_try_delete_trim
    ${EndIf}
    ; 旧卸载器文件要留到计划之外：计划没跑成时还得靠它，装完由安装段重新写一份。
    ${If} $1 != ""
    ${AndIf} $1 != "${UNINSTALL_FILENAME}"
      DetailPrint "移除 $1"
      Delete "$INSTDIR\$1"
      RMDir /r "$INSTDIR\$1"
    ${EndIf}
    Goto uniwork_try_delete_loop
  uniwork_try_delete_close:
    FileClose $0

  ; exclude.txt 一行一个 -x! 参数：组件多的时候全部拼进一条命令会超出 NSIS 的字符串上限，
  ; 所以攒够一批就先解压一次。一个组件都没保留时整包解压，让解压进度走模板的老路。
  StrCpy $UNIWORK_EXCLUDES ""
  ClearErrors
  FileOpen $0 "$PLUGINSDIR\uniwork\exclude.txt" r
  IfErrors uniwork_try_exclude_done
  uniwork_try_exclude_loop:
    ClearErrors
    FileRead $0 $1
    IfErrors uniwork_try_exclude_close
  uniwork_try_exclude_trim:
    StrCpy $2 $1 1 -1
    ${If} $2 == "$\r"
    ${OrIf} $2 == "$\n"
      StrCpy $1 $1 -1
      Goto uniwork_try_exclude_trim
    ${EndIf}
    ${If} $1 == ""
      Goto uniwork_try_exclude_loop
    ${EndIf}
    StrLen $2 $UNIWORK_EXCLUDES
    ${If} $2 > 700
      Call UNIWORK_ExtractExcluded
      ${If} $UNIWORK_EXTRACT_RC != 0
        DetailPrint "升级改为完整安装：增量解压失败（$UNIWORK_EXTRACT_RC）"
        Goto uniwork_try_done
      ${EndIf}
      StrCpy $UNIWORK_EXCLUDES ""
    ${EndIf}
    ${If} $UNIWORK_EXCLUDES == ""
      StrCpy $UNIWORK_EXCLUDES "$1"
    ${Else}
      StrCpy $UNIWORK_EXCLUDES "$UNIWORK_EXCLUDES $1"
    ${EndIf}
    Goto uniwork_try_exclude_loop
  uniwork_try_exclude_close:
    FileClose $0
  uniwork_try_exclude_done:

  ${If} $UNIWORK_EXCLUDES != ""
    Call UNIWORK_ExtractExcluded
    ${If} $UNIWORK_EXTRACT_RC != 0
      DetailPrint "升级改为完整安装：增量解压失败（$UNIWORK_EXTRACT_RC）"
      Goto uniwork_try_done
    ${EndIf}
    StrCpy $UNIWORK_EXCLUDES ""
  ${EndIf}

  ${IfNot} ${FileExists} "$appExe"
    DetailPrint "升级改为完整安装：程序文件没有解压完整"
    Goto uniwork_try_done
  ${EndIf}
  StrCpy $UNIWORK_INCREMENTAL 2
  DetailPrint "未变化的组件已保留，其余文件已更新"

  uniwork_try_done:
  SetOutPath $UNIWORK_OUTDIR
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; 整包解压：直接解到安装目录（本分支原来的做法），不再先解到 $PLUGINSDIR\7z-out 再复制。
Function UNIWORK_ExtractFull
  CreateDirectory "$UNIWORK_OUTDIR"
  SetOutPath "$UNIWORK_OUTDIR"
  DetailPrint "解压程序文件..."
  Nsis7z::Extract "$UNIWORK_ARCHIVE"
  SetOutPath $UNIWORK_OUTDIR
  ${IfNot} ${FileExists} "$appExe"
    MessageBox MB_OK|MB_ICONSTOP "安装没有完成：程序文件没有解压到 $INSTDIR。"
    Quit
  ${EndIf}
FunctionEnd

!endif
