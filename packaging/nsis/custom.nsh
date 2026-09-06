; OMP Studio NSIS hooks (electron-builder `nsis.include`).
;
; LogicLib is required for ${If}/${EndIf} macros. electron-builder injects
; this file in the shared header *before* MUI2.nsh (which normally provides
; LogicLib), so we must include it explicitly here.
!include LogicLib.nsh
!include x64.nsh
;
; 可见向导是 `packaging/ui`（WebView2 宿主 OmpInstallerUi.exe）。
; NSIS 只做提权拷贝引擎：隐藏 MUI 页、读 options.ini、写文件。
; 目录解析表与 `scripts/installer-dir.mjs` / HTML `resolveInstallDir` 保持一致。
; 缺少 WebView2 时回退到默认目录 + 原生 InstFiles。
; HTML 不从 $PLUGINSDIR 用 file:// 打开：NSIS 3 提权后该目录仅 Administrators
; 可读，WebView2 子进程会 ERR_ACCESS_DENIED。宿主拷到 ProgramData 并用
; https://omp-installer/ 虚拟主机加载。握手 INI 仍写 $PLUGINSDIR。
;
; 范围
;   - 所有用户（perMachine: true），默认 %PROGRAMFILES%\OMP Studio，需要管理员。
; 目录（浏览/手输的是选中文件夹，写入的是解析后的安装根）
;   - 末级已是 OMP Studio，或路径里已有本应用 exe / 卸载器 → 原样使用
;   - 升级 / 修复 / 降级：锁定上次 InstallLocation
;   - 盘符根、Program Files / 桌面 / 文档等容器、已存在且非空的目录
;     → 追加 \OMP Studio（避免卸到盘根，也避免和别人的文件混在一起）
;   - 空目录、尚不存在的路径 → 原样作为安装根，由安装过程创建
;   - 连续的 \OMP Studio\OMP Studio 会收成一层
; 版本
;   - 旧版本 → 原地更新；升级时留下 $INSTDIR\userdata 供首次启动把头像迁到 AppData
;   - 相同版本 → 确认后修复覆盖程序文件（静默 /S 默认修复）
;   - 更高版本 → 确认后才允许降级（静默 /S 默认拒绝）
;   - 进程占用 → 确认后结束 OMP Studio.exe（及 $INSTDIR 下的 omp.exe）再写文件
;   - electron-updater `/updated` 跳过版本确认（仍锁目录、仍处理进程占用）
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
;     不给 Users 额外授权：应用是 requireAdministrator，首次写 current.json 走的是提权进程；
;     放开 Modify 会让任何标准用户改掉已签名的 runtime-manifest.json，而解析端只比对哈希。

!ifndef BUILD_UNINSTALLER
  !include "WordFunc.nsh"
  !insertmacro VersionCompare
  !include "${BUILD_RESOURCES_DIR}\installer-host\runtime-version.nsh"
  !ifndef OMP_RUNTIME_VERSION
    !define OMP_RUNTIME_VERSION ""
  !endif
  Var ompExistingVersion
  Var ompExistingDir
  Var ompDirLocked
  Var ompHtmlUi
  Var ompHtmlResolved
  !define MUI_CUSTOMFUNCTION_GUIINIT ompHideNsisUi
!endif
!include "getProcessInfo.nsh"
Var pid

!define OMP_PRODUCT_DIR "OMP Studio"

!ifndef BUILD_UNINSTALLER
Function ompHideNsisUi
  Push $0
  Push $1

  ; 1. Strip WS_EX_APPWINDOW (0x00040000) and add WS_EX_TOOLWINDOW (0x00000080)
  ;    + WS_EX_LAYERED (0x00080000) so NSIS never appears in the taskbar.
  System::Call 'user32::GetWindowLong(p $HWNDPARENT, i -20) i .r0'
  IntOp $0 $0 & 0xFFFBFFFF ; ~WS_EX_APPWINDOW (0x40000)
  IntOp $0 $0 | 0x00000080 ; WS_EX_TOOLWINDOW (0x80)
  IntOp $0 $0 | 0x00080000 ; WS_EX_LAYERED (0x80000)
  System::Call 'user32::SetWindowLong(p $HWNDPARENT, i -20, i r0)'

  ; 2. Make window 100% transparent (alpha = 0, LWA_ALPHA = 2).
  System::Call 'user32::SetLayeredWindowAttributes(p $HWNDPARENT, i 0, i 0, i 2)'

  ; 3. Move offscreen and collapse size so it never renders visible pixels.
  ;    SWP_NOACTIVATE(0x10) | SWP_NOZORDER(0x04) | SWP_HIDEWINDOW(0x80) | SWP_FRAMECHANGED(0x20) = 0xB4
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i -32000, i -32000, i 0, i 0, i 0x00B4)'

  ; 4. Hide NSIS parent window and inner dialog.
  HideWindow
  ShowWindow $HWNDPARENT 0
  FindWindow $1 "#32770" "" $HWNDPARENT
  ${If} $1 != 0
    ShowWindow $1 0
  ${EndIf}

  Pop $1
  Pop $0
FunctionEnd

Function ompRestoreNsisUi
  Push $0
  System::Call 'user32::GetWindowLong(p $HWNDPARENT, i -20) i .r0'
  IntOp $0 $0 | 0x00040000 ; WS_EX_APPWINDOW
  IntOp $0 $0 & 0xFFFFFF7F ; ~WS_EX_TOOLWINDOW
  IntOp $0 $0 & 0xFFF7FFFF ; ~WS_EX_LAYERED
  System::Call 'user32::SetWindowLong(p $HWNDPARENT, i -20, i r0)'
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 100, i 100, i 500, i 380, i 0x0060)'
  ShowWindow $HWNDPARENT 5
  BringToFront
  Pop $0
FunctionEnd
!endif

!macro ompReadExistingInstall
  StrCpy $ompDirLocked "0"
  StrCpy $ompExistingVersion ""
  StrCpy $ompExistingDir ""

  ReadRegStr $ompExistingDir HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $ompExistingDir == ""
    ReadRegStr $ompExistingDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${endIf}

  ReadRegStr $ompExistingVersion HKLM "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
  ${if} $ompExistingVersion == ""
    ReadRegStr $ompExistingVersion HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
  ${endIf}
  !ifdef UNINSTALL_REGISTRY_KEY_2
    ${if} $ompExistingVersion == ""
      ReadRegStr $ompExistingVersion HKLM "${UNINSTALL_REGISTRY_KEY_2}" DisplayVersion
    ${endIf}
    ${if} $ompExistingVersion == ""
      ReadRegStr $ompExistingVersion HKCU "${UNINSTALL_REGISTRY_KEY_2}" DisplayVersion
    ${endIf}
  !endif

  ${if} $ompExistingDir != ""
    StrCpy $R9 $ompExistingDir 1 -1
    ${if} $R9 == "\"
      StrCpy $ompExistingDir $ompExistingDir -1
    ${endIf}
    StrCpy $INSTDIR $ompExistingDir
    StrCpy $ompDirLocked "1"
  ${endIf}
!macroend

!macro customInit
  ; A single-target package must never install an emulated payload for another
  ; architecture (the small x86 bootstrap UI on ARM64 is intentional).
  !if "${OMP_TARGET_ARCH}" == "arm64"
    ${IfNot} ${IsNativeARM64}
      MessageBox MB_OK|MB_ICONSTOP "This installer requires Windows ARM64."
      Quit
    ${EndIf}
  !else
    ${If} ${IsNativeARM64}
      MessageBox MB_OK|MB_ICONSTOP "Please use the Windows ARM64 installer."
      Quit
    ${EndIf}
    ${IfNot} ${RunningX64}
      MessageBox MB_OK|MB_ICONSTOP "This installer requires Windows x64."
      Quit
    ${EndIf}
  !endif
  ; Hide the MUI parent before the first custom page is created. The GUI-init
  ; hook below repeats this because NSIS may create the dialog after .onInit.
  Call ompHideNsisUi
  !insertmacro ompReadExistingInstall

  ${If} ${Silent}
  ${AndIfNot} ${UAC_IsInnerInstance}
  ${AndIfNot} ${isUpdated}
  ${AndIf} $ompExistingVersion != ""
    ${VersionCompare} "${VERSION}" "$ompExistingVersion" $R0
    ${if} $R0 == 0
      MessageBox MB_YESNO|MB_ICONQUESTION "已安装相同版本$\r$\n$\r$\n本机已安装 OMP Studio $ompExistingVersion。修复会覆盖程序文件；AppData 中的会话与头像文件保留（头像仍是覆盖写入）。$\r$\n$\r$\n是否修复当前安装？" /SD IDYES IDYES omp_custom_init_done
      Quit
    ${elseif} $R0 == 2
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "确认降级？$\r$\n$\r$\n已安装 $ompExistingVersion，继续将覆盖为 ${VERSION}。用户数据会保留，但新版本写入的配置可能无法被旧版本读取。$\r$\n$\r$\n仍然降级？" /SD IDNO IDYES omp_custom_init_done
      Quit
    ${endIf}
  ${EndIf}

  omp_custom_init_done:
!macroend

; Defined after common.nsh so ${APP_EXECUTABLE_FILENAME} exists.
!macro customHeader
  !ifndef BUILD_UNINSTALLER
  Function ompResolveInstDir
    StrCmp $ompHtmlResolved "1" omp_res_done
    StrCmp $ompDirLocked "1" omp_res_locked
    StrCmp $INSTDIR "" omp_res_done

    Push $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    Push $R5
    Push $R6
    Push $R7
    Push $R8
    Push $R9

    StrCpy $R0 $INSTDIR

    omp_res_strip:
      StrLen $R2 $R0
      IntCmp $R2 3 omp_res_stripped omp_res_stripped 0
      StrCpy $R9 $R0 1 -1
      StrCmp $R9 "\" 0 omp_res_stripped
      StrCpy $R0 $R0 -1
      Goto omp_res_strip
    omp_res_stripped:

    omp_res_collapse:
      StrCpy $R4 0
      StrLen $R2 $R0
      omp_res_last1:
        IntOp $R4 $R4 + 1
        IntCmp $R4 $R2 omp_res_last1_all 0 omp_res_last1_all
        StrCpy $R3 $R0 1 -$R4
        StrCmp $R3 "\" omp_res_last1_got
        Goto omp_res_last1
      omp_res_last1_all:
        StrCpy $R7 $R0
        StrCpy $R6 ""
        Goto omp_res_last1_done
      omp_res_last1_got:
        IntOp $R5 $R4 - 1
        StrCpy $R7 $R0 $R5 -$R5
        IntOp $R8 $R2 - $R4
        StrCpy $R6 $R0 $R8
      omp_res_last1_done:
      StrCmp $R7 "${OMP_PRODUCT_DIR}" 0 omp_res_after_collapse
      StrCmp $R6 "" omp_res_after_collapse
      StrCpy $R4 0
      StrLen $R2 $R6
      omp_res_last2:
        IntOp $R4 $R4 + 1
        IntCmp $R4 $R2 omp_res_last2_all 0 omp_res_last2_all
        StrCpy $R3 $R6 1 -$R4
        StrCmp $R3 "\" omp_res_last2_got
        Goto omp_res_last2
      omp_res_last2_all:
        StrCpy $R7 $R6
        Goto omp_res_last2_done
      omp_res_last2_got:
        IntOp $R5 $R4 - 1
        StrCpy $R7 $R6 $R5 -$R5
      omp_res_last2_done:
      StrCmp $R7 "${OMP_PRODUCT_DIR}" 0 omp_res_after_collapse
      StrCpy $R0 $R6
      Goto omp_res_collapse
    omp_res_after_collapse:

    StrCpy $R4 0
    StrLen $R2 $R0
    omp_res_last3:
      IntOp $R4 $R4 + 1
      IntCmp $R4 $R2 omp_res_last3_all 0 omp_res_last3_all
      StrCpy $R3 $R0 1 -$R4
      StrCmp $R3 "\" omp_res_last3_got
      Goto omp_res_last3
    omp_res_last3_all:
      StrCpy $R7 $R0
      Goto omp_res_last3_done
    omp_res_last3_got:
      IntOp $R5 $R4 - 1
      StrCpy $R7 $R0 $R5 -$R5
    omp_res_last3_done:

    StrCmp $R7 "${OMP_PRODUCT_DIR}" omp_res_keep
    IfFileExists "$R0\${APP_EXECUTABLE_FILENAME}" omp_res_keep
    IfFileExists "$R0\${UNINSTALL_FILENAME}" omp_res_keep

    StrLen $R2 $R0
    IntCmp $R2 3 omp_res_root3 omp_res_root2 omp_res_notroot
    omp_res_root2:
      StrCpy $R3 $R0 1 1
      StrCmp $R3 ":" omp_res_append omp_res_notroot
    omp_res_root3:
      StrCpy $R3 $R0 1 1
      StrCmp $R3 ":" 0 omp_res_notroot
      StrCpy $R3 $R0 1 -1
      StrCmp $R3 "\" omp_res_append omp_res_notroot
    omp_res_notroot:

    StrCmp $R0 "$PROGRAMFILES" omp_res_append
    StrCmp $R0 "$PROGRAMFILES32" omp_res_append
    StrCmp $R0 "$PROGRAMFILES64" omp_res_append
    StrCmp $R0 "$DESKTOP" omp_res_append
    StrCmp $R0 "$DOCUMENTS" omp_res_append
    StrCmp $R0 "$WINDIR" omp_res_append
    StrCmp $R0 "$PROFILE" omp_res_append
    StrCmp $R0 "$APPDATA" omp_res_append
    StrCmp $R0 "$LOCALAPPDATA" omp_res_append
    StrCmp $R0 "$TEMP" omp_res_append
    StrCmp $R0 "$SMPROGRAMS" omp_res_append

    StrCmp $R7 "Program Files" omp_res_append
    StrCmp $R7 "Program Files (x86)" omp_res_append
    StrCmp $R7 "Desktop" omp_res_append
    StrCmp $R7 "Documents" omp_res_append
    StrCmp $R7 "Downloads" omp_res_append
    StrCmp $R7 "Windows" omp_res_append
    StrCmp $R7 "Users" omp_res_append
    StrCmp $R7 "ProgramData" omp_res_append
    StrCmp $R7 "Public" omp_res_append

    ClearErrors
    FindFirst $R1 $R2 "$R0\*.*"
    IfErrors omp_res_keep
    omp_res_enum:
      StrCmp $R2 "" omp_res_empty
      StrCmp $R2 "." omp_res_enum_next
      StrCmp $R2 ".." omp_res_enum_next
      FindClose $R1
      Goto omp_res_append
    omp_res_enum_next:
      ClearErrors
      FindNext $R1 $R2
      IfErrors omp_res_empty
      Goto omp_res_enum
    omp_res_empty:
      FindClose $R1
      Goto omp_res_keep

    omp_res_append:
      StrCpy $R9 $R0 1 -1
      StrCmp $R9 "\" omp_res_append_plain 0
      StrCpy $R0 "$R0\${OMP_PRODUCT_DIR}"
      Goto omp_res_keep
    omp_res_append_plain:
      StrCpy $R0 "$R0${OMP_PRODUCT_DIR}"

    omp_res_keep:
      StrCpy $INSTDIR $R0
      Pop $R9
      Pop $R8
      Pop $R7
      Pop $R6
      Pop $R5
      Pop $R4
      Pop $R3
      Pop $R2
      Pop $R1
      Pop $R0
      Goto omp_res_done

    omp_res_locked:
      StrCpy $INSTDIR $ompExistingDir
    omp_res_done:
  FunctionEnd

  Function ompHtmlWelcomeShow
    StrCpy $ompHtmlUi "0"
    StrCpy $ompHtmlResolved "0"
    ${If} ${Silent}
      Abort
    ${EndIf}
    ${if} ${isUpdated}
      Abort
    ${endIf}

    Call ompHideNsisUi
    InitPluginsDir

    IfFileExists "$PLUGINSDIR\omp-host\OmpInstallerUi.exe" omp_html_have_host
      SetOutPath "$PLUGINSDIR\omp-ui"
      File /r "${BUILD_RESOURCES_DIR}\installer-ui\*.*"
      SetOutPath "$PLUGINSDIR\omp-host"
      File /r "${BUILD_RESOURCES_DIR}\installer-host\*.*"
    omp_html_have_host:

    IfFileExists "$PLUGINSDIR\omp-host\OmpInstallerUi.exe" omp_html_write_ini
      Goto omp_html_fallback

    omp_html_write_ini:
    WriteINIStr "$PLUGINSDIR\host.ini" "Setup" "Version" "${VERSION}"
    WriteINIStr "$PLUGINSDIR\host.ini" "Setup" "RuntimeVersion" "${OMP_RUNTIME_VERSION}"
    WriteINIStr "$PLUGINSDIR\host.ini" "Setup" "DefaultDir" "$INSTDIR"
    WriteINIStr "$PLUGINSDIR\host.ini" "Setup" "ExistingVersion" "$ompExistingVersion"
    WriteINIStr "$PLUGINSDIR\host.ini" "Setup" "ExistingDir" "$ompExistingDir"
    !ifdef APP_64_UNPACKED_SIZE
      IntOp $R7 ${APP_64_UNPACKED_SIZE} + 512
      IntOp $R7 $R7 / 1024
      WriteINIStr "$PLUGINSDIR\host.ini" "Setup" "SpaceRequiredMB" "$R7"
    !endif

    StrCpy $R6 ""
    ${If} $ompExistingVersion != ""
      ${VersionCompare} "${VERSION}" "$ompExistingVersion" $R5
      ${If} $R5 == 0
        StrCpy $R6 "same"
      ${ElseIf} $R5 == 2
        StrCpy $R6 "downgrade"
      ${Else}
        StrCpy $R6 "upgrade"
      ${EndIf}
    ${EndIf}
    WriteINIStr "$PLUGINSDIR\host.ini" "Setup" "Occupancy" "$R6"

    Delete "$PLUGINSDIR\options.ini"
    Delete "$PLUGINSDIR\cancel.ini"
    Delete "$PLUGINSDIR\done.ini"
    Delete "$PLUGINSDIR\finish.ini"
    Delete "$PLUGINSDIR\host-ready.txt"
    Delete "$PLUGINSDIR\webview2-missing.txt"
    Delete "$PLUGINSDIR\webview2-error.txt"

    ; --ui 仍指向 PLUGINSDIR 抽出物；宿主会拷到 ProgramData 再虚拟主机加载。
    ; --dir 必须留在 PLUGINSDIR：握手 INI 由已提权的 Setup 读写。
    Exec '"$PLUGINSDIR\omp-host\OmpInstallerUi.exe" --ui "$PLUGINSDIR\omp-ui" --dir "$PLUGINSDIR"'

    StrCpy $R0 0
    omp_html_wait_ready:
      Sleep 200
      IfFileExists "$PLUGINSDIR\host-ready.txt" omp_html_wait_opt
      IfFileExists "$PLUGINSDIR\webview2-missing.txt" omp_html_fallback
      IfFileExists "$PLUGINSDIR\webview2-error.txt" omp_html_fallback
      IfFileExists "$PLUGINSDIR\cancel.ini" omp_html_cancel
      IntOp $R0 $R0 + 1
      IntCmp $R0 75 omp_html_fallback omp_html_wait_ready omp_html_fallback

    omp_html_wait_opt:
      Sleep 200
      IfFileExists "$PLUGINSDIR\options.ini" omp_html_ready
      IfFileExists "$PLUGINSDIR\cancel.ini" omp_html_cancel
      IfFileExists "$PLUGINSDIR\webview2-missing.txt" omp_html_fallback
      IfFileExists "$PLUGINSDIR\webview2-error.txt" omp_html_fallback
      nsProcess::_FindProcess /NOUNLOAD "OmpInstallerUi.exe"
      Pop $R1
      StrCmp $R1 0 omp_html_wait_opt
      IfFileExists "$PLUGINSDIR\options.ini" omp_html_ready
      Goto omp_html_cancel

    omp_html_ready:
      StrCpy $ompHtmlUi "1"
      ReadINIStr $R9 "$PLUGINSDIR\options.ini" "Install" "Dir"
      StrCmp $R9 "" omp_html_ready_dir
        StrCpy $INSTDIR $R9
      omp_html_ready_dir:
      StrCpy $ompHtmlResolved "1"
      ; Abort skips painting the empty native custom page (Leave will not run).
      Abort

    omp_html_cancel:
      StrCpy $ompHtmlUi "0"
      Quit

    omp_html_fallback:
      StrCpy $ompHtmlUi "0"
      Call ompRestoreNsisUi
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "无法加载安装向导。$\r$\n$\r$\n将安装到默认位置 $INSTDIR。" /SD IDOK IDOK omp_html_fallback_ok
      Quit
    omp_html_fallback_ok:
  FunctionEnd

  Function ompHtmlWelcomeLeave
    StrCmp $ompHtmlUi "1" 0 omp_html_leave_done
    ReadINIStr $INSTDIR "$PLUGINSDIR\options.ini" "Install" "Dir"
    StrCmp $INSTDIR "" omp_html_leave_done
    StrCpy $ompHtmlResolved "1"
    omp_html_leave_done:
  FunctionEnd

  Function ompHtmlFinishShow
    ; The finish page can be entered after MUI briefly re-shows its parent.
    ; Hide it before checking the HTML handshake so the normal path never
    ; flashes the native NSIS completion window.
    Call ompHideNsisUi
    StrCmp $ompHtmlUi "1" omp_html_fin_wait
    Call ompRestoreNsisUi
    Abort

    omp_html_fin_wait:
    Call ompHideNsisUi
    omp_html_fin_loop:
      Sleep 300
      IfFileExists "$PLUGINSDIR\finish.ini" omp_html_fin_done
      nsProcess::_FindProcess /NOUNLOAD "OmpInstallerUi.exe"
      Pop $R1
      StrCmp $R1 0 omp_html_fin_loop
    omp_html_fin_done:
    ReadINIStr $R2 "$PLUGINSDIR\finish.ini" "Install" "Run"
    ${If} $R2 == "1"
      ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" ""
    ${EndIf}
    Abort
  FunctionEnd

  !endif
!macroend

!macro customWelcomePage
  Page custom ompHtmlWelcomeShow ompHtmlWelcomeLeave
!macroend

!macro customFinishPage
  Page custom ompHtmlFinishShow
!macroend

; Steal InstFiles PRE so electron-builder's StrContains append cannot
; re-nest an empty custom folder that does not contain "OMP Studio".
!macro customPageAfterChangeDir
  !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif
  !ifdef MUI_PAGE_CUSTOMFUNCTION_SHOW
    !undef MUI_PAGE_CUSTOMFUNCTION_SHOW
  !endif
  Function ompInstFilesPre
    Call ompResolveInstDir
    StrCmp $ompHtmlUi "1" 0 omp_instfiles_pre_done
      Call ompHideNsisUi
    omp_instfiles_pre_done:
  FunctionEnd
  Function ompInstFilesShow
    StrCmp $ompHtmlUi "1" 0 omp_instfiles_show_done
      Call ompHideNsisUi
    omp_instfiles_show_done:
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_PRE ompInstFilesPre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ompInstFilesShow
!macroend

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${GetProcessInfo} 0 $pid $1 $2 $3 $4
  ${if} $3 == "${APP_EXECUTABLE_FILENAME}"
    Goto omp_app_not_running
  ${endIf}

  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 != 0
    !insertmacro FIND_PROCESS "omp.exe" $R0
  ${endIf}
  ${if} $R0 != 0
    Goto omp_app_not_running
  ${endIf}

  ${if} ${isUpdated}
    Sleep 300
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 != 0
      !insertmacro FIND_PROCESS "omp.exe" $R0
    ${endIf}
    ${if} $R0 != 0
      Goto omp_app_not_running
    ${endIf}
    Sleep 1000
    Goto omp_stop_process
  ${endIf}

  ReadINIStr $R8 "$PLUGINSDIR\options.ini" "Install" "Kill"
  ${If} $R8 == "1"
    Goto omp_stop_process
  ${EndIf}

  !ifdef BUILD_UNINSTALLER
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "OMP Studio 正在运行$\r$\n$\r$\n卸载前需要先结束 OMP Studio。未保存的对话请先在应用内处理，然后继续。" /SD IDOK IDOK omp_stop_process
  !else
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "OMP Studio 正在运行$\r$\n$\r$\n安装前需要先结束 OMP Studio。未保存的对话请先在应用内处理，然后继续。" /SD IDOK IDOK omp_stop_process
  !endif
  Quit

  omp_stop_process:
  DetailPrint "正在结束 OMP Studio..."
  !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 0
  !insertmacro KILL_PROCESS "omp.exe" 0
  Sleep 300
  StrCpy $R1 0

  omp_stop_loop:
    IntOp $R1 $R1 + 1
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 != 0
      !insertmacro FIND_PROCESS "omp.exe" $R0
    ${endIf}
    ${if} $R0 != 0
      Goto omp_app_not_running
    ${endIf}
    Sleep 1000
    !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1
    !insertmacro KILL_PROCESS "omp.exe" 1
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 != 0
      !insertmacro FIND_PROCESS "omp.exe" $R0
    ${endIf}
    ${if} $R0 != 0
      Goto omp_app_not_running
    ${endIf}
    ${if} $R1 > 1
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "无法结束 OMP Studio。请手动退出后再重试。" /SD IDCANCEL IDRETRY omp_stop_loop
      Quit
    ${else}
      Goto omp_stop_loop
    ${endIf}

  omp_app_not_running:
!macroend

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
  StrCmp $ompHtmlUi "1" 0 omp_custom_install_ui
    Call ompHideNsisUi
  omp_custom_install_ui:
  ; electron-builder normally creates this link in installSection.nsh. Keep a
  ; deterministic all-users copy as a final guard: custom UI directory choices
  ; must never make the Start menu shortcut disappear.
  StrCpy $R7 $installMode
  SetShellVarContext all
  CreateDirectory "$SMPROGRAMS"
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "${APP_ID}"
  ${If} $R7 == "current"
    SetShellVarContext current
  ${EndIf}
  ReadINIStr $R8 "$PLUGINSDIR\options.ini" "Install" "Desktop"
  ${If} $R8 == "0"
    Delete "$DESKTOP\OMP Studio.lnk"
  ${ElseIf} $R8 == "1"
    IfFileExists "$DESKTOP\OMP Studio.lnk" omp_desktop_done
      CreateShortCut "$DESKTOP\OMP Studio.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$DESKTOP\OMP Studio.lnk" "${APP_ID}"
    omp_desktop_done:
  ${EndIf}
  WriteINIStr "$PLUGINSDIR\done.ini" "Install" "Done" "1"
  WriteINIStr "$PLUGINSDIR\done.ini" "Install" "InstDir" "$INSTDIR"
!macroend
