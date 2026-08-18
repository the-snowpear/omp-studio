; OMP Studio NSIS hooks (electron-builder `nsis.include`).
;
; 产品行为与 `packaging/ui/index.html` 原型对齐：
;
; 范围
;   - 所有用户（perMachine: true），默认 %PROGRAMFILES%\OMP Studio，需要管理员。
; 目录
;   - 浏览/手输的路径，若末级目录名不是「OMP Studio」（忽略大小写），
;     则追加 \OMP Studio；已是产品目录或已有本应用安装则原样使用。
;   - 升级 / 修复 / 降级：锁定上次 InstallLocation，不另建文件夹。
; 版本
;   - 旧版本 → 原地更新；升级时留下 $INSTDIR\userdata 供首次启动把头像迁到 AppData
;   - 相同版本 → 确认后修复覆盖程序文件
;   - 更高版本 → 确认后才允许降级
;   - 进程占用 → 确认后结束 OMP Studio.exe 再写文件
; 快捷方式
;   - 开始菜单：始终创建（所有用户开始菜单）
;   - 桌面：全新安装默认创建（公共桌面）；升级不强制重建用户已删的图标
;     （createDesktopShortcut: true，不要改 always）
; 头像
;   - 现写 %APPDATA%\omp-studio\profile\（覆盖，无历史）
;   - 仅真卸载时删除该目录，并清掉旧版 $INSTDIR\userdata
;
; 卸载注意（electron-builder 会在升级时先跑旧版 Uninstall 段）：
;   - customUnInstall / customRemoveFiles 升级和卸载都会进来，必须用 ${isUpdated} 区分。
;   - 自定义 customRemoveFiles 会完全替换默认的 RMDir /r $INSTDIR。
;     真卸载必须先 SetOutPath $TEMP，再整目录删除。
;   - perMachine 时默认 $APPDATA 是 ProgramData；删头像前切到 current。
;   - $INSTDIR\runtime 是正在跑的 Runtime（extraFiles → versions\<ver>\omp.exe）。
;     升级时删掉旧树再写入新版本；真卸载随 $INSTDIR 一起删。
;     AppData 会话/日志保留；旧版若在 AppData 留下过 runtimes 也不主动删。
;     Users 对 $INSTDIR\runtime 有修改权，以便首次写入 current.json 和诊断页更新。

!macro customRemoveFiles
  ${if} ${isUpdated}
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\locales"
    Delete "$INSTDIR\*.exe"
    Delete "$INSTDIR\*.dll"
    Delete "$INSTDIR\*.pak"
    Delete "$INSTDIR\*.dat"
    Delete "$INSTDIR\*.bin"
    Delete "$INSTDIR\*.json"
    Delete "$INSTDIR\*.html"
    Delete "$INSTDIR\LICENSE*"
    RMDir /r "$INSTDIR\runtime"
    RMDir /r "$INSTDIR\runtime-keys"
    ; 留下 userdata，供首次启动把头像迁到 AppData。
    RMDir "$INSTDIR"
  ${else}
    SetOutPath "$TEMP"
    RMDir /r "$INSTDIR"
  ${endIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    RMDir /r "$APPDATA\omp-studio\profile"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
    RMDir /r "$INSTDIR\userdata"
  ${endIf}
!macroend

!macro customInstall
  IfFileExists "$INSTDIR\runtime" 0 customInstall_runtime_acl_done
    nsExec::ExecToLog 'icacls "$INSTDIR\runtime" /grant *S-1-5-32-545:(OI)(CI)M /T /C /Q'
  customInstall_runtime_acl_done:
!macroend
