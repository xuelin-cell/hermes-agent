; desktop-mt: 由 app-running.nsh 的 customCheckAppRunning 引入，把模板的 extractUsing7za 换成直接解到当前输出目录
; （安装目录），升级同一个安装目录时再先交给 incremental-update.nsh 按计划跳过没变化的组件。
;
; 模板的 uninstallOldVersion / handleUninstallResult 要等 installUtil.nsh 引入后才定义好，也就是本文件在安装段
; 展开的时候；退回老流程的调用只能放在这里，不能放进 incremental-update.nsh 的函数里。
; 卸载程序也会展开 CHECK_APP_RUNNING，但它不定义 extractUsing7za，这里跳过。
!ifndef UNIWORK_DIRECT_EXTRACT
  !ifmacrodef extractUsing7za
    !define UNIWORK_DIRECT_EXTRACT
    !macroundef extractUsing7za
    !macro extractUsing7za FILE
      StrCpy $UNIWORK_ARCHIVE "${FILE}"
      StrCpy $UNIWORK_OUTDIR $OUTDIR
      ${If} $UNIWORK_INCREMENTAL == 1
        Call UNIWORK_TryIncremental
      ${EndIf}
      ${If} $UNIWORK_INCREMENTAL == 2
        ; 解压成功，写回登记（紧接着的 registryAddInstallInfo 还会再写一次）。
        !insertmacro UNIWORK_RESTORE_UNINSTALLER
      ${ElseIf} $UNIWORK_INCREMENTAL == 1
        !insertmacro UNIWORK_RESTORE_UNINSTALLER
        ${If} $UNIWORK_PLANNED == 0
          ; 计划没跑成，旧文件还没人清过：照以前的流程跑一遍旧卸载器。
          !insertmacro uninstallOldVersion SHELL_CONTEXT
          !insertmacro handleUninstallResult SHELL_CONTEXT
        ${EndIf}
        StrCpy $UNIWORK_INCREMENTAL 0
        Call UNIWORK_ExtractFull
      ${Else}
        Call UNIWORK_ExtractFull
      ${EndIf}
    !macroend
  !endif
!endif
