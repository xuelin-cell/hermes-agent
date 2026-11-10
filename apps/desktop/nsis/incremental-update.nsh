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
Var UNIWORK_EXTRACT_RC
; 跳过式解压是否跑过（0/1）：退回整包时用它判断"之前是否真跳过了东西"
Var UNIWORK_EXTRACT_BATCH
; 藏起来的卸载登记，退回老流程时原样写回
Var UNIWORK_UNINSTALLER
!ifdef UNINSTALL_REGISTRY_KEY_2
Var UNIWORK_UNINSTALLER_2
!endif

; keep.txt 的读取状态：句柄、当前行、是否读到结尾
Var UNIWORK_KEEP_FP
Var UNIWORK_KEEP_LINE
Var UNIWORK_KEEP_EOF
; 一条记录拆出来的五个字段，加上换成中文说法的组件名
Var UNIWORK_KEEP_KIND
Var UNIWORK_KEEP_NAME
Var UNIWORK_KEEP_VER
Var UNIWORK_KEEP_FILES
Var UNIWORK_KEEP_MB
Var UNIWORK_KEEP_LABEL
; 保留组件个数，以及文件数/体积合计（$UNIWORK_KEEP_NUM 为 0 表示至少有一条没有数字）
Var UNIWORK_KEEP_COUNT
Var UNIWORK_KEEP_FILES_SUM
Var UNIWORK_KEEP_MB_SUM
Var UNIWORK_KEEP_NUM
; 当前要解压的 archive 组件名（如 "venv" 或 "hermes-agent"）
Var UNIWORK_ARCHIVE_KIND
; 批量删除时 delete.txt 里的路径条数，给用户看进度用
Var UNIWORK_DELETE_COUNT
!endif

; 由 customCheckAppRunning 展开：是不是在升级同一个安装目录？
; $INSTDIR 可能被自定义目录页改过，注册表里的 InstallLocation 才代表上一次真正的安装位置；
; 目录不同就是另一次安装，旧卸载器照常跑。PowerShell 不可用时没有计划，也走老流程。
!macro UNIWORK_DECIDE
  Push $0
  StrCpy $UNIWORK_INCREMENTAL 0
  StrCpy $UNIWORK_PLANNED 0
  StrCpy $UNIWORK_EXTRACT_BATCH 0
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
    !insertmacro UniSay "升级现有安装：比对后保留未变化的组件"
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

; 把 update-plan.ps1 的说明落进日志文件：保留了哪些组件、为什么退回整包解压，事后支持能读到。
; 这些行是英文的技术流水（NSIS 只能安全读 ASCII，中文得由安装器自己拼），不往详情面板上堆；
; 面板上给用户看的是 UNIWORK_PrintKept 的中文逐条明细和退回整包那几句结论。
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
    !insertmacro UniLog "$1"
    Goto uniwork_log_loop
  uniwork_log_close:
    FileClose $0
  uniwork_log_done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; 解压主安装包：要跳过的归档路径全部写在 exclude-patterns.txt（一行一个模式），
; 用 -x@listfile 传给 7za，一次解压完成。以前受 NSIS 1024 字符串上限限制，要把
; -x! 参数攒成多批、每批都重扫并覆写整个包；listfile 让批数和保留组件数量无关。
; 只取结果码：这条命令的输出不值得塞进 nsExec 的栈里。
; 失败时重试一次（7za 偶尔会因为文件被占用而失败）。
Function UNIWORK_ExtractExcluded
  !insertmacro UniPhaseBegin 3 "解压程序文件"
  StrCpy $UNIWORK_EXTRACT_BATCH 1
  !insertmacro UniSay "正在解压程序文件..."
  !insertmacro UniTick $UNIWORK_SUBPHASE_START
  nsExec::Exec '"$PLUGINSDIR\uniwork\7za.exe" x "$UNIWORK_ARCHIVE" -o"$INSTDIR" -y -aoa "-x@$PLUGINSDIR\uniwork\exclude-patterns.txt"'
  Pop $UNIWORK_EXTRACT_RC
  ${If} $UNIWORK_EXTRACT_RC != 0
    !insertmacro UniLog "首次增量解压失败（$UNIWORK_EXTRACT_RC），重试..."
    Sleep 1000
    nsExec::Exec '"$PLUGINSDIR\uniwork\7za.exe" x "$UNIWORK_ARCHIVE" -o"$INSTDIR" -y -aoa "-x@$PLUGINSDIR\uniwork\exclude-patterns.txt"'
    Pop $UNIWORK_EXTRACT_RC
  ${EndIf}
  !insertmacro UniTick $UNIWORK_SUBPHASE_END
  !insertmacro UniSubphaseElapsed
  ${If} $UNIWORK_EXTRACT_RC == 0
    !insertmacro UniSay "程序文件解压完成，耗时 $UNIWORK_PHASE_DURATION"
  ${Else}
    !insertmacro UniLog "重试后仍失败（$UNIWORK_EXTRACT_RC）"
  ${EndIf}
FunctionEnd

; keep.txt 一行一行读：去掉行尾换行，读到结尾（或出错）时把 $UNIWORK_KEEP_EOF 置 1。
; 文件里全是 ASCII，中文由 UNIWORK_PrintKept 现拼——PowerShell 只交数字和英文名。
Function UNIWORK_ReadKeepLine
  Push $0
  StrCpy $UNIWORK_KEEP_EOF 1
  ClearErrors
  FileRead $UNIWORK_KEEP_FP $UNIWORK_KEEP_LINE
  ${IfNot} ${Errors}
    StrCpy $UNIWORK_KEEP_EOF 0
    uniwork_read_keep_trim:
      StrCpy $0 $UNIWORK_KEEP_LINE 1 -1
      ${If} $0 == "$\r"
      ${OrIf} $0 == "$\n"
        StrCpy $UNIWORK_KEEP_LINE $UNIWORK_KEEP_LINE -1
        Goto uniwork_read_keep_trim
      ${EndIf}
  ${EndIf}
  Pop $0
FunctionEnd

; 每个被跳过的组件报一条：名字 + 版本 + 包里占的文件数和体积，让用户知道这次少解压了什么。
; 数字来自包本身，读不到就只报名字，不影响解压计划。
Function UNIWORK_PrintKept
  ClearErrors
  FileOpen $UNIWORK_KEEP_FP "$PLUGINSDIR\uniwork\keep.txt" r
  IfErrors uniwork_keep_done
  StrCpy $UNIWORK_KEEP_COUNT 0
  StrCpy $UNIWORK_KEEP_FILES_SUM 0
  StrCpy $UNIWORK_KEEP_MB_SUM 0
  StrCpy $UNIWORK_KEEP_NUM 1
  uniwork_keep_loop:
    Call UNIWORK_ReadKeepLine
    ${If} $UNIWORK_KEEP_EOF == 1
      Goto uniwork_keep_report
    ${EndIf}
    StrCpy $UNIWORK_KEEP_KIND $UNIWORK_KEEP_LINE
    Call UNIWORK_ReadKeepLine
    StrCpy $UNIWORK_KEEP_NAME $UNIWORK_KEEP_LINE
    Call UNIWORK_ReadKeepLine
    StrCpy $UNIWORK_KEEP_VER $UNIWORK_KEEP_LINE
    Call UNIWORK_ReadKeepLine
    StrCpy $UNIWORK_KEEP_FILES $UNIWORK_KEEP_LINE
    Call UNIWORK_ReadKeepLine
    StrCpy $UNIWORK_KEEP_MB $UNIWORK_KEEP_LINE
    ; 第五条也没读到才算一条完整记录，被截断的尾巴直接丢掉。
    ${If} $UNIWORK_KEEP_EOF == 1
      Goto uniwork_keep_report
    ${EndIf}
    ${If} $UNIWORK_KEEP_KIND == "component"
      ; 这些是构建里的目录名，用户看不懂，换成中文说法（和整包解压那几条措辞一致）。
      ${If} $UNIWORK_KEEP_NAME == "venv"
        StrCpy $UNIWORK_KEEP_LABEL "Python 依赖环境"
      ${ElseIf} $UNIWORK_KEEP_NAME == "hermes-agent"
        StrCpy $UNIWORK_KEEP_LABEL "应用代码"
      ${ElseIf} $UNIWORK_KEEP_NAME == "pm-runtime"
        StrCpy $UNIWORK_KEEP_LABEL "内置包管理运行时"
      ${ElseIf} $UNIWORK_KEEP_NAME == "uv-cache.zip"
        StrCpy $UNIWORK_KEEP_LABEL "uv 下载缓存"
      ${Else}
        StrCpy $UNIWORK_KEEP_LABEL "$UNIWORK_KEEP_NAME"
      ${EndIf}
      !insertmacro UniSay "保留 $UNIWORK_KEEP_LABEL：$UNIWORK_KEEP_FILES 个文件 / $UNIWORK_KEEP_MB MB 不再解压"
    ${Else}
      ; 工具直接用 python、npm、uv 这些名字，正是用户想看到的。
      !insertmacro UniSay "保留工具 $UNIWORK_KEEP_NAME $UNIWORK_KEEP_VER：$UNIWORK_KEEP_FILES 个文件 / $UNIWORK_KEEP_MB MB 不再解压"
    ${EndIf}
    IntOp $UNIWORK_KEEP_COUNT $UNIWORK_KEEP_COUNT + 1
    ${If} $UNIWORK_KEEP_FILES == "-"
    ${OrIf} $UNIWORK_KEEP_MB == "-"
      StrCpy $UNIWORK_KEEP_NUM 0
    ${Else}
      IntOp $UNIWORK_KEEP_FILES_SUM $UNIWORK_KEEP_FILES_SUM + $UNIWORK_KEEP_FILES
      IntOp $UNIWORK_KEEP_MB_SUM $UNIWORK_KEEP_MB_SUM + $UNIWORK_KEEP_MB
    ${EndIf}
    Goto uniwork_keep_loop
  uniwork_keep_report:
    FileClose $UNIWORK_KEEP_FP
    ${If} $UNIWORK_KEEP_COUNT > 0
      ${If} $UNIWORK_KEEP_NUM == 1
        !insertmacro UniSay "共保留 $UNIWORK_KEEP_COUNT 个组件，省下 $UNIWORK_KEEP_FILES_SUM 个文件不解压（约 $UNIWORK_KEEP_MB_SUM MB）"
      ${Else}
        !insertmacro UniSay "共保留 $UNIWORK_KEEP_COUNT 个组件"
      ${EndIf}
    ${EndIf}
  uniwork_keep_done:
FunctionEnd

; 返回时 $UNIWORK_INCREMENTAL == 2 表示计划中的文件已经就位；其余情况由调用方整包解压。
; 阶段 2 两个分支都有，只是内容不同：这里比对组件、算更新计划，整包那边是准备解压。
Function UNIWORK_TryIncremental
  !insertmacro UniPhaseBegin 2 "比对组件并生成更新计划"
  Push $0
  Push $1
  Push $2

  SetOutPath "$PLUGINSDIR\uniwork"
  File "/oname=update-plan.ps1" "${UNIWORK_PLAN}"
  File "/oname=payload-digest.py" "${UNIWORK_DIGEST}"
  File "/oname=7za.exe" "${UNIWORK_7ZA}"

  ; 只从包里取出指纹文件，不展开整个包。失败时重试一次（AV 扫描或磁盘繁忙可能导致瞬时失败）。
  nsExec::ExecToStack '"$PLUGINSDIR\uniwork\7za.exe" e "$UNIWORK_ARCHIVE" "resources\agent-payload\payload-stamp.txt" -o"$PLUGINSDIR\uniwork\stamp" -y'
  Pop $0
  Pop $1
  ${If} $0 != 0
  ${OrIfNot} ${FileExists} "$PLUGINSDIR\uniwork\stamp\payload-stamp.txt"
    !insertmacro UniLog "首次提取指纹失败（$0），重试..."
    Sleep 500
    nsExec::ExecToStack '"$PLUGINSDIR\uniwork\7za.exe" e "$UNIWORK_ARCHIVE" "resources\agent-payload\payload-stamp.txt" -o"$PLUGINSDIR\uniwork\stamp" -y'
    Pop $0
    Pop $1
  ${EndIf}
  ${If} $0 != 0
  ${OrIfNot} ${FileExists} "$PLUGINSDIR\uniwork\stamp\payload-stamp.txt"
    !insertmacro UniSay "升级改为完整安装：包里没有组件指纹（重试后仍失败，$0）"
    Goto uniwork_try_done
  ${EndIf}

  ; update-plan.ps1 只读安装目录：算出要删的路径和要跳过的解压路径，失败时什么都不改。
  ; -Archive/-SevenZip 只用来数包里被保留组件的文件数和体积（只读归档头，实测一秒多），
  ; 结果写进 keep.txt 交给 UNIWORK_PrintKept；读不到数字也不影响计划。
  ; 失败时重试一次（PowerShell 启动偶尔会超时）。
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\uniwork\update-plan.ps1" -Install "$INSTDIR" -NewStamp "$PLUGINSDIR\uniwork\stamp\payload-stamp.txt" -DeleteFile "$PLUGINSDIR\uniwork\delete.txt" -PatternsFile "$PLUGINSDIR\uniwork\exclude-patterns.txt" -KeepFile "$PLUGINSDIR\uniwork\keep.txt" -Archive "$UNIWORK_ARCHIVE" -SevenZip "$PLUGINSDIR\uniwork\7za.exe" -Log "$PLUGINSDIR\uniwork\plan.log"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    ; 清掉首次调用留在栈上的 stdout 行，再重试一次。
    ${Do}
      ${If} $1 == ""
        ${ExitDo}
      ${EndIf}
      Pop $1
    ${Loop}
    !insertmacro UniLog "首次生成更新计划失败（$0），重试..."
    Sleep 1000
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\uniwork\update-plan.ps1" -Install "$INSTDIR" -NewStamp "$PLUGINSDIR\uniwork\stamp\payload-stamp.txt" -DeleteFile "$PLUGINSDIR\uniwork\delete.txt" -PatternsFile "$PLUGINSDIR\uniwork\exclude-patterns.txt" -KeepFile "$PLUGINSDIR\uniwork\keep.txt" -Archive "$UNIWORK_ARCHIVE" -SevenZip "$PLUGINSDIR\uniwork\7za.exe" -Log "$PLUGINSDIR\uniwork\plan.log"'
    Pop $0
    Pop $1
  ${EndIf}
  ${If} $0 != 0
    ; 重试也失败：清栈后退回完整安装。
    ${Do}
      ${If} $1 == ""
        ${ExitDo}
      ${EndIf}
      Pop $1
    ${Loop}
    !insertmacro UniSay "升级改为完整安装：无法生成更新计划（重试后仍失败，$0）"
    Call UNIWORK_PrintLog
    Goto uniwork_try_done
  ${EndIf}
  ; 把 PowerShell 写到 stdout 的中文摘要逐行打到详情面板。
  ${Do}
    ${If} $1 == ""
      ${ExitDo}
    ${EndIf}
    DetailPrint $1
    Pop $1
  ${Loop}
  Call UNIWORK_PrintLog
  Call UNIWORK_PrintKept

  ; 批量删除旧版文件：一次 cmd 调用处理 delete.txt 里所有路径，替代逐条 Delete/RMDir。
  ; 39 个路径逐条删要触发 AV 实时扫描 39 次（实测 6-7 分钟）；批量删只触发 1 次（预估 30-90 秒）。
  ; cmd 的 for /f 逐行读 delete.txt，先试 rd /s /q（目录），失败再试 del /f /q（文件）。
  ; 旧卸载器文件 ${UNINSTALL_FILENAME} 由 update-plan.ps1 在生成 delete.txt 时已经排除。
  ClearErrors
  FileOpen $0 "$PLUGINSDIR\uniwork\delete.txt" r
  IfErrors uniwork_try_done
  StrCpy $UNIWORK_PLANNED 1
  ; 统计路径条数给用户看进度。
  StrCpy $UNIWORK_DELETE_COUNT 0
  uniwork_delete_count_loop:
    ClearErrors
    FileRead $0 $1
    IfErrors uniwork_delete_count_done
    IntOp $UNIWORK_DELETE_COUNT $UNIWORK_DELETE_COUNT + 1
    Goto uniwork_delete_count_loop
  uniwork_delete_count_done:
  FileClose $0
  !insertmacro UniSay "正在清除 $UNIWORK_DELETE_COUNT 个旧版路径..."
  !insertmacro UniTick $UNIWORK_SUBPHASE_START
  nsExec::Exec '"$SYSDIR\cmd.exe" /C for /f "usebackq delims= eol=|" %f in ("$PLUGINSDIR\uniwork\delete.txt") do @(rd /s /q "$INSTDIR\%f" >NUL 2>&1 || del /f /q "$INSTDIR\%f" >NUL 2>&1)'
  !insertmacro UniTick $UNIWORK_SUBPHASE_END
  !insertmacro UniSubphaseElapsed
  !insertmacro UniSay "旧版路径已清除，耗时 $UNIWORK_PHASE_DURATION"

  ; exclude-patterns.txt 一行一个排除模式（update-plan.ps1 写出）。一个组件都没保留时
  ; 这个文件不存在，不跑跳过式解压，退回整包让解压进度走模板的老路。
  ClearErrors
  FileOpen $0 "$PLUGINSDIR\uniwork\exclude-patterns.txt" r
  IfErrors uniwork_try_exclude_done
  FileClose $0
  Call UNIWORK_ExtractExcluded
  ${If} $UNIWORK_EXTRACT_RC != 0
    !insertmacro UniSay "升级改为完整安装：增量解压失败（重试后仍失败，$UNIWORK_EXTRACT_RC）"
    Goto uniwork_try_done
  ${EndIf}
  uniwork_try_exclude_done:

  ; 增量更新后，解压 archive 组件（venv.7z/tar.xz, hermes-agent.7z/tar.xz）
  ; 这些组件在 exclude-patterns.txt 里被排除（保留旧版本），但如果组件指纹变了，
  ; 它们不在 exclude 里，archive 文件会被解压出来，需要进一步解压缩。
  StrCpy $UNIWORK_ARCHIVE_KIND "venv"
  Call UNIWORK_ExtractArchive
  StrCpy $UNIWORK_ARCHIVE_KIND "hermes-agent"
  Call UNIWORK_ExtractArchive

  ${IfNot} ${FileExists} "$appExe"
    !insertmacro UniSay "升级改为完整安装：程序文件没有解压完整"
    Goto uniwork_try_done
  ${EndIf}
  StrCpy $UNIWORK_INCREMENTAL 2
  !insertmacro UniSay "未变化的组件已保留，其余文件已更新"

  uniwork_try_done:
  SetOutPath $UNIWORK_OUTDIR
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; 解压单个 archive 组件到安装目录。
; $UNIWORK_ARCHIVE_KIND = "venv" 或 "hermes-agent"
; 如果 archive 存在则解压，否则跳过（目录形式或旧版本）。
Function UNIWORK_ExtractArchive
  Push $0
  Push $1
  Push $2
  StrCpy $0 "$INSTDIR\resources\agent-payload\$UNIWORK_ARCHIVE_KIND.7z"
  StrCpy $1 "$INSTDIR\resources\agent-payload\$UNIWORK_ARCHIVE_KIND.tar.xz"

  ; 组件的目录名给用户看没意义，面板上说中文，实际路径留给日志。
  ${If} $UNIWORK_ARCHIVE_KIND == "venv"
    StrCpy $2 "Python 依赖环境"
  ${ElseIf} $UNIWORK_ARCHIVE_KIND == "hermes-agent"
    StrCpy $2 "应用代码"
  ${Else}
    StrCpy $2 "$UNIWORK_ARCHIVE_KIND"
  ${EndIf}

  ${If} ${FileExists} "$0"
    !insertmacro UniSay "正在安装 $2..."
    !insertmacro UniLog "解压 archive: $0"
    !insertmacro UniTick $UNIWORK_SUBPHASE_START
    nsExec::Exec '"$PLUGINSDIR\uniwork\7za.exe" x "$0" -o"$INSTDIR\resources\agent-payload" -y -aoa'
    Pop $UNIWORK_EXTRACT_RC
    !insertmacro UniTick $UNIWORK_SUBPHASE_END
    ${If} $UNIWORK_EXTRACT_RC != 0
      !insertmacro UniLog "$UNIWORK_ARCHIVE_KIND.7z 解压失败（$UNIWORK_EXTRACT_RC）"
      !insertmacro UniSay "$2 解压失败，安装可能不完整"
    ${Else}
      !insertmacro UniSubphaseElapsed
      !insertmacro UniSay "$2 安装完成，耗时 $UNIWORK_PHASE_DURATION"
      ; 解压成功后删除 archive 文件，节省磁盘空间
      Delete "$0"
    ${EndIf}
  ${ElseIf} ${FileExists} "$1"
    ; Fallback: .tar.xz archive (slower, but no 7z dependency)
    !insertmacro UniSay "正在安装 $2..."
    !insertmacro UniLog "解压 archive: $1"
    !insertmacro UniTick $UNIWORK_SUBPHASE_START
    nsExec::Exec '"$PLUGINSDIR\uniwork\7za.exe" x "$1" -o"$INSTDIR\resources\agent-payload" -y -aoa'
    Pop $UNIWORK_EXTRACT_RC
    !insertmacro UniTick $UNIWORK_SUBPHASE_END
    ${If} $UNIWORK_EXTRACT_RC != 0
      !insertmacro UniLog "$UNIWORK_ARCHIVE_KIND.tar.xz 解压失败（$UNIWORK_EXTRACT_RC）"
      !insertmacro UniSay "$2 解压失败，安装可能不完整"
    ${Else}
      !insertmacro UniSubphaseElapsed
      !insertmacro UniSay "$2 安装完成，耗时 $UNIWORK_PHASE_DURATION"
      Delete "$1"
    ${EndIf}
  ${Else}
    !insertmacro UniLog "$UNIWORK_ARCHIVE_KIND archive 不存在，跳过（可能是目录形式）"
  ${EndIf}

  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; 整包解压完补一条总量：组件数和工具数都从包里的 payload-stamp.txt 数出来，
; 不写死名单（构建加了组件也不用改这里）。工具（python、node、git…）在主包内一起解压，
; 解压过程看不到逐条进度，只能事后报个数。
Var UNIWORK_STAMP_FP
Var UNIWORK_STAMP_LINE
Var UNIWORK_COMPONENT_COUNT
Var UNIWORK_TOOL_COUNT
Function UNIWORK_PrintInstalledSummary
  Push $0
  StrCpy $UNIWORK_COMPONENT_COUNT 0
  StrCpy $UNIWORK_TOOL_COUNT 0

  ClearErrors
  FileOpen $UNIWORK_STAMP_FP "$INSTDIR\resources\agent-payload\payload-stamp.txt" r
  IfErrors uniwork_summary_report
  uniwork_summary_loop:
    ClearErrors
    FileRead $UNIWORK_STAMP_FP $UNIWORK_STAMP_LINE
    IfErrors uniwork_summary_close
    ; 只认行首：tool 是工具，schema/target 是文件头，剩下的行都是组件。
    StrCpy $0 $UNIWORK_STAMP_LINE 5
    ${If} $0 == "tool "
      IntOp $UNIWORK_TOOL_COUNT $UNIWORK_TOOL_COUNT + 1
    ${Else}
      StrCpy $0 $UNIWORK_STAMP_LINE 6
      ${If} $0 != "schema"
      ${AndIf} $0 != "target"
        IntOp $UNIWORK_COMPONENT_COUNT $UNIWORK_COMPONENT_COUNT + 1
      ${EndIf}
    ${EndIf}
    Goto uniwork_summary_loop
  uniwork_summary_close:
    FileClose $UNIWORK_STAMP_FP

  uniwork_summary_report:
  ${If} $UNIWORK_COMPONENT_COUNT > 0
    ${If} $UNIWORK_TOOL_COUNT > 0
      !insertmacro UniSay "共安装 $UNIWORK_COMPONENT_COUNT 个组件、$UNIWORK_TOOL_COUNT 个内置工具"
    ${Else}
      !insertmacro UniSay "共安装 $UNIWORK_COMPONENT_COUNT 个组件"
    ${EndIf}
  ${EndIf}
  Pop $0
FunctionEnd

; 整包解压：直接解到安装目录（本分支原来的做法），不再先解到 $PLUGINSDIR\7z-out 再复制。
Function UNIWORK_ExtractFull
  ; 阶段 2 在整包这边就是准备工作：建目录、把解压 archive 组件要用的 7za.exe 放好。
  ; 增量退回时阶段 2 已经由 UNIWORK_TryIncremental 报过，阶段号相同会被去重，不会重复打头。
  !insertmacro UniPhaseBegin 2 "准备全量安装"
  CreateDirectory "$UNIWORK_OUTDIR"
  SetOutPath "$UNIWORK_OUTDIR"
  ; 增量分支已经往这里放过一份；File 覆盖同名文件不会失败，多解压 850 KB 也不算什么。
  SetOutPath "$PLUGINSDIR\uniwork"
  File "/oname=7za.exe" "${UNIWORK_7ZA}"
  SetOutPath "$UNIWORK_OUTDIR"

  !insertmacro UniPhaseBegin 3 "解压程序文件"
  ${If} $UNIWORK_EXTRACT_BATCH > 0
    ; 增量解压到一半退回：刚才被跳过的组件这次要跟着整包一起重新写出来。
    ; 用批次计数而不是"跑过计划"，因为计划完全可以一条都没跳过（没有组件可保留）。
    !insertmacro UniSay "整包覆盖：之前跳过的组件这次一并重新写入"
  ${EndIf}

  !insertmacro UniSay "正在解压主安装包..."
  !insertmacro UniTick $UNIWORK_SUBPHASE_START
  Nsis7z::Extract "$UNIWORK_ARCHIVE"
  !insertmacro UniTick $UNIWORK_SUBPHASE_END
  !insertmacro UniSubphaseElapsed
  !insertmacro UniSay "程序文件解压完成，耗时 $UNIWORK_PHASE_DURATION"

  ; 解压 archive 组件（venv.7z, hermes-agent.7z）
  StrCpy $UNIWORK_ARCHIVE_KIND "venv"
  Call UNIWORK_ExtractArchive
  StrCpy $UNIWORK_ARCHIVE_KIND "hermes-agent"
  Call UNIWORK_ExtractArchive

  Call UNIWORK_PrintInstalledSummary

  SetOutPath $UNIWORK_OUTDIR
  ${IfNot} ${FileExists} "$appExe"
    MessageBox MB_OK|MB_ICONSTOP "安装没有完成：程序文件没有解压到 $INSTDIR。"
    Quit
  ${EndIf}
FunctionEnd

!endif
