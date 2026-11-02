; desktop-mt: 安装时把应用直接解到安装目录，不再先解到临时目录再逐个复制；升级同一个安装目录时
; 再进一步，比对载荷里的组件指纹，没变化的 venv、pm-runtime、tools 留在原位。
;
; electron-builder 默认先解到 $PLUGINSDIR\7z-out，再 CopyFiles 到安装目录（为了旧版文件被占用时能整体替换）；
; 安装包有约 9.6 万个文件，这次复制要多花约 5 分钟。复制之前 CHECK_APP_RUNNING 已经关掉了安装目录里的进程，
; 所以直接解压即可（模板在复制失败时的兜底做法也是直接解压）。
;
; 模板的宏要等到后面才定义，本文件又在模板之前处理，所以分三步接进去：
;   本文件定义 customHeader → 模板引入运行检查之后展开它，引入 incremental-update.nsh（变量、函数）
;   和 app-running.nsh（定义 customCheckAppRunning）
;   → 安装段解压之前展开 CHECK_APP_RUNNING，引入 direct-extract.nsh 换掉 extractUsing7za，再照常做运行检查。
; customHeader 展开时已经在脚本顶层，函数只能放在这里引入的文件里；app-running.nsh 和 direct-extract.nsh
; 是在宏体里展开的，那里只能定义宏（NSIS 不允许宏里再定义宏）。

!define UNIWORK_NSIS_DIR "${__FILEDIR__}"

; desktop-mt: 安装目录不叫 UniWork。老 UniWork 按机器装在 %ProgramFiles%\UniWork，appId 不同、认不出是旧版，
; 同一个目录会混装，卸载其中一个会把整个目录连另一个一起删掉。名字和数据目录 uniworker 对齐；
; 检查脚本 scripts/bundles/check-windows-installer.ps1 从这一行读安装目录名。
!undef APP_FILENAME
!define APP_FILENAME "UniWorker"

!macro customHeader
  !include "${UNIWORK_NSIS_DIR}\incremental-update.nsh"
  !include "${UNIWORK_NSIS_DIR}\app-running.nsh"
!macroend
