; OMP Studio NSIS hooks (electron-builder `nsis.include`).
;
; LogicLib is required for ${If}/${EndIf} macros. electron-builder injects
; this file in the shared header *before* MUI2.nsh (which normally provides
; LogicLib), so we must include it explicitly here.
!include LogicLib.nsh
!include x64.nsh
;
; 可见向导是 `packaging/ui`（WebView2 宿主 OmpInstallerUi.exe）。
; NSIS 隐藏原生页、读取 options.ini、写程序文件；旧全机迁移单独提权。
; 目录解析表与 `scripts/installer-dir.mjs` / HTML `resolveInstallDir` 保持一致。
; 缺少 WebView2 时回退到完整的原生欢迎、目录、进度与完成页。
; HTML 从当前账户下每次安装独立的目录经 https://omp-installer/ 加载；
; 握手 INI 留在该次 NSIS 的 $PLUGINSDIR，宿主通过 PID 握手绑定。
;
; 范围
;   - 当前用户（perMachine: false），默认 %LOCALAPPDATA%\Programs\OMP Studio。
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
;   - 进程占用 → 提示从托盘退出，再重试；不强制终止任务
;   - electron-updater `/updated` 跳过版本确认（仍锁目录、仍处理进程占用）
; 快捷方式
;   - 开始菜单：始终创建（当前用户开始菜单）
;   - 桌面：全新安装默认创建；升级沿用用户已有图标状态
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
;   - $INSTDIR\runtime 提供签名 Runtime 种子；活跃副本在 LocalAppData。
;     升级与卸载清程序树，保留外置 Runtime、会话与日志。

!ifndef BUILD_UNINSTALLER
  !include "WordFunc.nsh"
  !insertmacro VersionCompare
  !include "${BUILD_RESOURCES_DIR}\installer-host\runtime-version.nsh"
  !ifndef OMP_RUNTIME_VERSION
    !define OMP_RUNTIME_VERSION ""
  !endif
  Var ompExistingVersion
  Var ompExistingDir
  Var ompLegacyMachineDir
  Var ompDirLocked
  Var ompHtmlUi
  Var ompHtmlResolved
  Var ompUiProcess
  !define MUI_CUSTOMFUNCTION_GUIINIT ompHideNsisUi
!endif

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

  ReadRegStr $ompLegacyMachineDir HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $ompExistingDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation

  ReadRegStr $ompExistingVersion HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
  !ifdef UNINSTALL_REGISTRY_KEY_2
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
  !insertmacro setInstallModePerUser

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
    StrCmp $ompHtmlResolved "1" omp_res_html
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

    omp_res_html:
      ; PAGE_INSTALL_MODE runs after the HTML page and resets $INSTDIR through
      ; setInstallModePerUser. Restore the directory the user actually chose.
      ReadINIStr $INSTDIR "$PLUGINSDIR\options.ini" "Install" "Dir"
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
    WriteINIStr "$PLUGINSDIR\host.ini" "Setup" "Arch" "${OMP_TARGET_ARCH}"
    WriteINIStr "$PLUGINSDIR\host.ini" "Setup" "DefaultDir" "$INSTDIR"
    WriteINIStr "$PLUGINSDIR\host.ini" "Setup" "ExistingVersion" "$ompExistingVersion"
    WriteINIStr "$PLUGINSDIR\host.ini" "Setup" "ExistingDir" "$ompExistingDir"
    !ifdef APP_64_UNPACKED_SIZE
      IntOp $R7 ${APP_64_UNPACKED_SIZE} + 512
      IntOp $R7 $R7 / 1024
      WriteINIStr "$PLUGINSDIR\host.ini" "Setup" "SpaceRequiredMB" "$R7"
    !endif
    !ifdef APP_ARM64_UNPACKED_SIZE
      IntOp $R7 ${APP_ARM64_UNPACKED_SIZE} + 512
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
    Delete "$PLUGINSDIR\native.ini"
    Delete "$PLUGINSDIR\status.ini"

    ; --ui 指向抽出的源码，宿主拷到当前账户的独立目录再加载。
    ; --dir 留在 PLUGINSDIR，归属于此次 Setup 的握手文件。
    ClearErrors
    Exec '"$PLUGINSDIR\omp-host\OmpInstallerUi.exe" --ui "$PLUGINSDIR\omp-ui" --dir "$PLUGINSDIR" --parent $HWNDPARENT'
    IfErrors omp_html_fallback

    StrCpy $R0 0
    omp_html_wait_ready:
      Sleep 200
      IfFileExists "$PLUGINSDIR\host-ready.txt" omp_html_open_process
      IfFileExists "$PLUGINSDIR\webview2-missing.txt" omp_html_fallback
      IfFileExists "$PLUGINSDIR\webview2-error.txt" omp_html_fallback
      IfFileExists "$PLUGINSDIR\cancel.ini" omp_html_cancel
      IntOp $R0 $R0 + 1
      IntCmp $R0 75 omp_html_fallback omp_html_wait_ready omp_html_fallback

    omp_html_open_process:
      ; Open the PID published by this host. StdUtils wait tokens are opaque
      ; strings, not Win32 process handles usable by GetExitCodeProcess.
      ReadINIStr $1 "$PLUGINSDIR\host-ready.txt" "Host" "Pid"
      System::Call 'kernel32::OpenProcess(i 0x00101000, i 0, i r1) p .r0'
      StrCpy $ompUiProcess $0
      StrCmp $ompUiProcess 0 omp_html_cancel
    omp_html_wait_opt:
      Sleep 200
      IfFileExists "$PLUGINSDIR\options.ini" omp_html_ready
      IfFileExists "$PLUGINSDIR\cancel.ini" omp_html_cancel
      IfFileExists "$PLUGINSDIR\webview2-missing.txt" omp_html_fallback
      IfFileExists "$PLUGINSDIR\webview2-error.txt" omp_html_fallback
      System::Call 'kernel32::GetExitCodeProcess(p $ompUiProcess, *i .r1)'
      StrCmp $1 259 omp_html_wait_opt ; STILL_ACTIVE, this host only
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
      System::Call 'kernel32::CloseHandle(p $ompUiProcess)'
      SetErrorLevel 1
      Quit

    omp_html_fallback:
      StrCpy $ompHtmlUi "0"
      WriteINIStr "$PLUGINSDIR\native.ini" "Setup" "Fallback" "1"
      System::Call 'kernel32::CloseHandle(p $ompUiProcess)'
      Call ompRestoreNsisUi
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "无法加载图形向导，将使用 Windows 标准安装界面。$\r$\n$\r$\n安装内容与用户数据保留规则相同。" /SD IDOK IDOK omp_html_fallback_ok
      Quit
    omp_html_fallback_ok:
      ${If} $ompExistingVersion != ""
        ${VersionCompare} "${VERSION}" "$ompExistingVersion" $R5
        ${If} $R5 == 0
          MessageBox MB_OKCANCEL|MB_ICONQUESTION "已安装 OMP Studio $ompExistingVersion。继续将修复程序文件，保留会话与设置。" IDOK omp_native_version_done
          Quit
        ${ElseIf} $R5 == 2
          MessageBox MB_YESNO|MB_ICONEXCLAMATION "已安装较新版本 $ompExistingVersion，当前安装包为 ${VERSION}。降级可能无法读取新版配置。$\r$\n$\r$\n仍然降级？" IDYES omp_native_version_done
          Quit
        ${EndIf}
      ${EndIf}
    omp_native_version_done:
  FunctionEnd

  Function ompNativeWelcomePre
    StrCmp $ompHtmlUi "1" 0 +2
      Abort
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    Call ompRestoreNsisUi
  FunctionEnd

  Function ompNativeWelcomeShow
    ; The preceding custom bootstrap is not a page the user can go back to.
    GetDlgItem $0 $HWNDPARENT 3
    EnableWindow $0 0
  FunctionEnd

  Function ompNativeDirectoryPre
    StrCmp $ompHtmlUi "1" 0 +2
      Abort
    StrCmp $ompDirLocked "1" 0 +2
      Abort
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    Call ompRestoreNsisUi
  FunctionEnd

  Function ompNativeFinishPre
    StrCmp $ompHtmlUi "1" 0 +2
      Abort
    Call ompRestoreNsisUi
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
      System::Call 'kernel32::GetExitCodeProcess(p $ompUiProcess, *i .r1)'
      StrCmp $1 259 omp_html_fin_loop
    omp_html_fin_done:
    System::Call 'kernel32::CloseHandle(p $ompUiProcess)'
    ReadINIStr $R2 "$PLUGINSDIR\finish.ini" "Install" "Run"
    ${If} $R2 == "1"
      ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" ""
    ${EndIf}
    ; HTML already collected the finish choice. Complete the hidden copy
    ; engine with a success status and release its installer-instance lock.
    !insertmacro quitSuccess
  FunctionEnd

  !endif
!macroend

!macro customWelcomePage
  Page custom ompHtmlWelcomeShow ompHtmlWelcomeLeave
  !define MUI_PAGE_CUSTOMFUNCTION_PRE ompNativeWelcomePre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ompNativeWelcomeShow
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customFinishPage
  Page custom ompHtmlFinishShow
  !define MUI_PAGE_CUSTOMFUNCTION_PRE ompNativeFinishPre
  !insertmacro MUI_PAGE_FINISH
!macroend

; Steal InstFiles PRE so electron-builder's StrContains append cannot
; re-nest an empty custom folder that does not contain "OMP Studio".
!macro customPageAfterChangeDir
  ; The fallback directory page runs after PAGE_INSTALL_MODE, so its choice
  ; cannot be reset by multi-user initialization. HTML and updates skip it.
  !define MUI_PAGE_CUSTOMFUNCTION_PRE ompNativeDirectoryPre
  !insertmacro MUI_PAGE_DIRECTORY
  !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif
  !ifdef MUI_PAGE_CUSTOMFUNCTION_SHOW
    !undef MUI_PAGE_CUSTOMFUNCTION_SHOW
  !endif
  Function ompInstFilesPre
    Call ompResolveInstDir
    WriteINIStr "$PLUGINSDIR\status.ini" "Setup" "Phase" "preparing"
    StrCmp $ompHtmlUi "1" 0 omp_instfiles_pre_done
      ; A custom finish page does not enable MUI's automatic advance. Without
      ; this, NSIS waits on an invisible Next button after copying the files.
      SetAutoClose true
      Call ompHideNsisUi
    omp_instfiles_pre_done:
  FunctionEnd
  Function ompInstFilesShow
    StrCmp $ompHtmlUi "1" 0 omp_instfiles_show_done
      Call ompHideNsisUi
    omp_instfiles_show_done:
  FunctionEnd
  Function ompInstFilesLeave
    ; MUI invokes the install-page leave hook when its worker finishes,
    ; including a section Abort, before painting the aborted-page header.
    StrCmp $ompHtmlUi "1" 0 omp_inst_leave_done
    IfAbort 0 omp_inst_leave_done
      SetErrorLevel 2
      Quit
    omp_inst_leave_done:
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_PRE ompInstFilesPre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ompInstFilesShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE ompInstFilesLeave
!macroend

!macro customCheckAppRunning
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\omp-maintenance"
  File /r "${BUILD_RESOURCES_DIR}\installer-host\*.*"
  ExecWait '"$PLUGINSDIR\omp-maintenance\OmpInstallerUi.exe" --wait-install-root "$INSTDIR"' $R0
  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "请从托盘菜单退出此安装的 OMP Studio，再重试。安装程序不会强制终止任务。" /SD IDOK
    Abort
  ${EndIf}
  WriteINIStr "$PLUGINSDIR\status.ini" "Setup" "Phase" "files"
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

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstall
  ${If} $ompLegacyMachineDir != ""
    WriteINIStr "$PLUGINSDIR\status.ini" "Setup" "Phase" "migrating"
    ExecWait '"$PLUGINSDIR\omp-maintenance\OmpInstallerUi.exe" --migrate-machine "$ompLegacyMachineDir" "$INSTDIR"' $R0
    ${If} $R0 == 11
      ; 注册表残留但卸载程序已缺失：重新运行安装包必然同样失败，只能引导人工清理。
      MessageBox MB_OK|MB_ICONEXCLAMATION "检测到旧全机版本的安装记录残留，但其卸载程序已缺失，无法自动迁移。$\r$\n$\r$\n请打开「设置 → 应用 → 安装的应用」移除残留的 OMP Studio 条目；若无法移除，请删除注册表项 HKLM\${INSTALL_REGISTRY_KEY} 和 HKLM\${UNINSTALL_REGISTRY_KEY}，然后重新运行安装包。" /SD IDOK
      SetErrorLevel 20
      Quit
    ${ElseIf} $R0 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "当前用户版本已安装，但旧全机版本尚未移除。请关闭所有 OMP 任务后重新运行安装包完成迁移。" /SD IDOK
      SetErrorLevel 20
      Quit
    ${EndIf}
  ${EndIf}
  WriteINIStr "$PLUGINSDIR\status.ini" "Setup" "Phase" "finishing"
  StrCmp $ompHtmlUi "1" 0 omp_custom_install_ui
    Call ompHideNsisUi
  omp_custom_install_ui:
  ; electron-builder normally creates this link in installSection.nsh. Keep a
  ; deterministic current-user copy: custom UI directory choices
  ; must never make the Start menu shortcut disappear.
  StrCpy $R7 $installMode
  SetShellVarContext current
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
  WriteINIStr "$PLUGINSDIR\done.ini" "Install" "InstDir" "$INSTDIR"
!macroend
