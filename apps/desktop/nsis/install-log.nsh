; desktop-mt: 安装详情落盘 + 阶段耗时，配合 ShowInstDetails / SetDetailsPrint 使用。
;
; 为什么不用 electron-builder 自带的 NSIS 日志（common.nsh 的 LogSet / ENABLE_LOGGING_ELECTRON_BUILDER）：
; 打包用的 NSIS 3.12 编译时没有开 NSIS_CONFIG_LOG，LogSet 是编译期错误
; （makensis: "LogSet specified, NSIS_CONFIG_LOG not defined"），加那个开关只会让打包失败。
;
; 位置用 ProgramData（C:\ProgramData\UniWork\logs\install.log）而不是 $TEMP：辅助安装需要提权时会
; 再起一个内层实例（templates/nsis/multiUser.nsh 的 UAC_RunElevated），$TEMP 跟着提权账户走，换管理员
; 账户授权时普通用户找不到日志；ProgramData 两个实例看到的是同一个，默认继承的权限也允许普通用户读。
; NSIS 没有 $COMMONAPPDATA / $PROGRAMDATA 常量（实测 3.12 报 unknown variable），所以用
; CSIDL_COMMON_APPDATA 问 shell 要路径。卸载不删这份日志——它是那次安装的凭据，每次安装重开一份。
;
; 写盘失败绝不影响安装：第一次落盘前建好目录，之后每条打不开文件就什么也不做。
;
; 编码：NSIS 的 FileWrite 按系统 ANSI 码页写（实测中文 Windows 落的是 GBK，不是 UTF-8），
; 打包用的 NSIS 3.12 没有 SetFileEncoding 命令可改。中文 Windows 上记事本直接可读，够用。
;
; 阶段耗时按进程各自记账：安装段可能在外层和内层实例里各走一遍，UniPhaseBegin 靠阶段号去重，
; 同一个阶段在一个进程里只有一条开始行和一条完成行；另一个进程会自己起头，日志里表现为同一个
; 阶段出现两次（外层一次、内层一次），不会串成假的耗时。
;
; 变量、函数只在安装器编译单元里需要：卸载器也会展开 customHeader，但不会展开安装段，声明了
; 没人引用会被 -WX 当成错误（NSIS warning 6001），所以包在 !ifndef BUILD_UNINSTALLER 里。
;
; 宏参数不要用半角逗号：NSIS 把逗号当参数分隔符。

!include "LogicLib.nsh"
!include "FileFunc.nsh"

; 安装阶段总数，改阶段数只改这一处（阶段行按 "阶段 N/这里" 输出）。
!define UNIWORK_PHASE_TOTAL 4

; 供打包前的编译探针覆盖，正常构建用下面两个默认值。日志根目录运行时问 shell 要（见 UniLogPath）。
!ifndef UNIWORK_INSTALL_LOG_SUBDIR
  !define UNIWORK_INSTALL_LOG_SUBDIR "UniWork\logs"
!endif
!ifndef UNIWORK_INSTALL_LOG_NAME
  !define UNIWORK_INSTALL_LOG_NAME "install.log"
!endif

!ifndef BUILD_UNINSTALLER
Var UNIWORK_LOG_DIR
Var UNIWORK_LOG_FILE
; 本进程是否已经写过文件头（空 = 没写过）
Var UNIWORK_LOG_HEADER
Var UNIWORK_PHASE_TICK_NOW
Var UNIWORK_PHASE_TICK_PREV
Var UNIWORK_PHASE_TICK_START
Var UNIWORK_PHASE_MS
Var UNIWORK_PHASE_SEC
Var UNIWORK_PHASE_TENTH
Var UNIWORK_PHASE_MIN
Var UNIWORK_PHASE_DURATION
Var UNIWORK_PHASE_NUM
Var UNIWORK_PHASE_STAMP
Var UNIWORK_TIME_DAY
Var UNIWORK_TIME_MONTH
Var UNIWORK_TIME_YEAR
Var UNIWORK_TIME_WEEK
Var UNIWORK_TIME_HOUR
Var UNIWORK_TIME_MINUTE
Var UNIWORK_TIME_SECOND
; 子阶段（主包解压、archive 组件解压）的起止 tick，耗时算完落在 UNIWORK_PHASE_DURATION 里
Var UNIWORK_SUBPHASE_START
Var UNIWORK_SUBPHASE_END
!endif

!macro UniTick OUT
  Push $8
  System::Call 'kernel32::GetTickCount() i .r8'
  StrCpy ${OUT} $8
  Pop $8
!macroend

; ${GetTime} 的返回顺序（实测）：日 月 年 星期 时 分 秒。
!macro UniNow OUT
  ${GetTime} "" "L" $UNIWORK_TIME_DAY $UNIWORK_TIME_MONTH $UNIWORK_TIME_YEAR $UNIWORK_TIME_WEEK $UNIWORK_TIME_HOUR $UNIWORK_TIME_MINUTE $UNIWORK_TIME_SECOND
  StrCpy ${OUT} "$UNIWORK_TIME_YEAR-$UNIWORK_TIME_MONTH-$UNIWORK_TIME_DAY $UNIWORK_TIME_HOUR:$UNIWORK_TIME_MINUTE:$UNIWORK_TIME_SECOND"
!macroend

!macro UniFormatDuration
  IntOp $UNIWORK_PHASE_SEC $UNIWORK_PHASE_MS / 1000
  IntOp $UNIWORK_PHASE_TENTH $UNIWORK_PHASE_MS % 1000
  IntOp $UNIWORK_PHASE_TENTH $UNIWORK_PHASE_TENTH / 100
  ${If} $UNIWORK_PHASE_SEC >= 60
    IntOp $UNIWORK_PHASE_MIN $UNIWORK_PHASE_SEC / 60
    IntOp $UNIWORK_PHASE_SEC $UNIWORK_PHASE_SEC % 60
    StrCpy $UNIWORK_PHASE_DURATION "$UNIWORK_PHASE_MIN 分 $UNIWORK_PHASE_SEC.$UNIWORK_PHASE_TENTH 秒"
  ${Else}
    StrCpy $UNIWORK_PHASE_DURATION "$UNIWORK_PHASE_SEC.$UNIWORK_PHASE_TENTH 秒"
  ${EndIf}
!macroend

; 结算一个子阶段的间隔：结果同样落在 $UNIWORK_PHASE_DURATION（超过一分钟自动带分），
; 分步耗时行和阶段完成行因此用同一种写法。
!macro UniSubphaseElapsed
  IntOp $UNIWORK_PHASE_MS $UNIWORK_SUBPHASE_END - $UNIWORK_SUBPHASE_START
  !insertmacro UniFormatDuration
!macroend

; 解析一次日志路径，之后复用。问不到 ProgramData 就留空，所有落盘都变成空操作。
; 顺带在本进程第一次落盘前重写文件：头几行必须在任何明细之前写好，不然会被自己截掉。
; 提权的内层实例同样会重写一次，覆盖外层已经写的那几行——重活儿都在内层，文件留下的是有用的
; 那一半；外层那几行现场还在详情面板里。
!macro UniLogPath
  ${If} $UNIWORK_LOG_FILE == ""
    Push $9
    Push $7
    ; 0x23 = CSIDL_COMMON_APPDATA（ProgramData）；0x24 是 Windows 目录，写不进去。
    System::Call 'shell32::SHGetFolderPath(i 0, i 0x23, i 0, i 0, t .r9) i .r7'
    ${If} $7 == 0
      StrCpy $UNIWORK_LOG_DIR "$9\${UNIWORK_INSTALL_LOG_SUBDIR}"
      StrCpy $UNIWORK_LOG_FILE "$UNIWORK_LOG_DIR\${UNIWORK_INSTALL_LOG_NAME}"
    ${EndIf}
    Pop $7
    Pop $9
  ${EndIf}
  ${If} $UNIWORK_LOG_FILE != ""
  ${AndIf} $UNIWORK_LOG_HEADER == ""
    StrCpy $UNIWORK_LOG_HEADER 1
    Push $9
    CreateDirectory "$UNIWORK_LOG_DIR"
    ClearErrors
    FileOpen $9 "$UNIWORK_LOG_FILE" w
    ${IfNot} ${Errors}
      !insertmacro UniNow $UNIWORK_PHASE_STAMP
      FileWrite $9 "UniWork 安装日志$\r$\n"
      FileWrite $9 "开始时间：$UNIWORK_PHASE_STAMP$\r$\n"
      FileWrite $9 "版本：${VERSION}$\r$\n"
      FileWrite $9 "安装目录：$INSTDIR$\r$\n"
      FileWrite $9 "----------------------------------------$\r$\n"
      FileClose $9
    ${EndIf}
    Pop $9
  ${EndIf}
!macroend

; 追加一行原文。追加模式必须显式移到文件末尾，少了 FileSeek 每次都会从开头覆盖。
!macro UniLog TEXT
  !insertmacro UniLogPath
  ${If} $UNIWORK_LOG_FILE != ""
    Push $9
    ClearErrors
    FileOpen $9 "$UNIWORK_LOG_FILE" a
    ${IfNot} ${Errors}
      FileSeek $9 0 END
      FileWrite $9 "${TEXT}$\r$\n"
      FileClose $9
    ${EndIf}
    Pop $9
  ${EndIf}
!macroend

; 现场看和事后查用同一句话：详情面板给装着的人看，带时间戳的那行进文件给支持排查的人看。
; 卸载器那一遍（BUILD_UNINSTALLER）也会展开 customCheckAppRunning 里的两句 UniSay，但那一遍没有
; 上面这些变量；而且卸载时重开日志会把这台机器上这次安装的记录抹掉。那边只把话打到详情面板。
!ifndef BUILD_UNINSTALLER
!macro UniSay TEXT
  DetailPrint "${TEXT}"
  !insertmacro UniNow $UNIWORK_PHASE_STAMP
  !insertmacro UniLog "[$UNIWORK_PHASE_STAMP] ${TEXT}"
!macroend
!else
!macro UniSay TEXT
  DetailPrint "${TEXT}"
!macroend
!endif

; 每个阶段开始时调用：结算上一阶段的耗时，再登记本阶段。阶段号重复时整块跳过。
!macro UniPhaseBegin NUM NAME
  ${If} $UNIWORK_PHASE_NUM != "${NUM}"
    !insertmacro UniTick $UNIWORK_PHASE_TICK_NOW
    ${If} $UNIWORK_PHASE_NUM == ""
      ; 本进程的第一条：记下总耗时起点（文件头由 UniLogPath 在第一次落盘时写好）。
      StrCpy $UNIWORK_PHASE_TICK_START $UNIWORK_PHASE_TICK_NOW
    ${Else}
      IntOp $UNIWORK_PHASE_MS $UNIWORK_PHASE_TICK_NOW - $UNIWORK_PHASE_TICK_PREV
      !insertmacro UniFormatDuration
      !insertmacro UniSay "阶段 $UNIWORK_PHASE_NUM/${UNIWORK_PHASE_TOTAL} 完成，用时 $UNIWORK_PHASE_DURATION"
    ${EndIf}
    StrCpy $UNIWORK_PHASE_TICK_PREV $UNIWORK_PHASE_TICK_NOW
    StrCpy $UNIWORK_PHASE_NUM "${NUM}"
    DetailPrint " "
    DetailPrint "==================== 阶段 ${NUM}/${UNIWORK_PHASE_TOTAL}：${NAME} ===================="
    DetailPrint " "
    !insertmacro UniNow $UNIWORK_PHASE_STAMP
    !insertmacro UniLog "[$UNIWORK_PHASE_STAMP] 阶段 ${NUM}/${UNIWORK_PHASE_TOTAL} 开始：${NAME}"
  ${EndIf}
!macroend

; 收尾：结算最后一个阶段，再打总耗时。
; 落点在 customInstall（模板在安装段末尾展开它），之后的写登记、建快捷方式只有几秒，不计入总耗时。
!macro UniPhaseFinish
  ${If} $UNIWORK_PHASE_NUM != ""
    !insertmacro UniTick $UNIWORK_PHASE_TICK_NOW
    IntOp $UNIWORK_PHASE_MS $UNIWORK_PHASE_TICK_NOW - $UNIWORK_PHASE_TICK_PREV
    !insertmacro UniFormatDuration
    !insertmacro UniSay "阶段 $UNIWORK_PHASE_NUM/${UNIWORK_PHASE_TOTAL} 完成，用时 $UNIWORK_PHASE_DURATION"
    IntOp $UNIWORK_PHASE_MS $UNIWORK_PHASE_TICK_NOW - $UNIWORK_PHASE_TICK_START
    !insertmacro UniFormatDuration
    !insertmacro UniSay "安装完成，总耗时 $UNIWORK_PHASE_DURATION"
    !insertmacro UniSay "安装日志：$UNIWORK_LOG_FILE"
  ${EndIf}
!macroend

; 阶段 4 的落点：模板在安装段末尾展开 customInstall（templates/nsis/installSection.nsh），
; 那时程序文件已经就位。
!ifndef BUILD_UNINSTALLER
!macro customInstall
  !insertmacro UniPhaseBegin 4 "写入安装登记和快捷方式"
  !insertmacro UniPhaseFinish
!macroend
!endif
