; desktop-mt: 由 app-running.nsh 的 customCheckAppRunning 引入，把模板的 extractUsing7za 换成直接解到当前输出目录（安装目录）。
; 卸载程序也会展开 CHECK_APP_RUNNING，但它不定义 extractUsing7za，这里跳过。
!ifndef UNIWORK_DIRECT_EXTRACT
  !ifmacrodef extractUsing7za
    !define UNIWORK_DIRECT_EXTRACT
    !macroundef extractUsing7za
    !macro extractUsing7za FILE
      DetailPrint "Extracting to $OUTDIR"
      Nsis7z::Extract "${FILE}"
    !macroend
  !endif
!endif
