; desktop-mt: 安装时把应用直接解到安装目录，不再先解到临时目录再逐个复制。
; electron-builder 默认先解到 $PLUGINSDIR\7z-out，再 CopyFiles 到安装目录（为了旧版文件被占用时能整体替换）；
; 安装包有约 9.6 万个文件，这次复制要多花约 5 分钟。复制之前 CHECK_APP_RUNNING 已经关掉了安装目录里的进程，
; 旧版也已卸载，所以直接解压即可（模板在复制失败时的兜底做法也是直接解压）。
;
; 模板的宏要等到后面才定义，本文件又在模板之前处理，所以分三步接进去：
;   本文件定义 customHeader → 模板引入运行检查之后展开它，引入 app-running.nsh 定义 customCheckAppRunning
;   → 安装段解压之前展开 CHECK_APP_RUNNING，引入 direct-extract.nsh 换掉 extractUsing7za，再照常做运行检查。
; 本文件不能直接引入用到插件的 .nsh：这时 electron-builder 可能还没登记插件目录，NSIS 会报插件冲突。

!define UNIWORK_NSIS_DIR "${__FILEDIR__}"

!macro customHeader
  !include "${UNIWORK_NSIS_DIR}\app-running.nsh"
!macroend
