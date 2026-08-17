; OMP Studio NSIS hooks (electron-builder `nsis.include`).
;
; 头像等用户文件写在 $INSTDIR\userdata\，不在安装清单里。
; 默认卸载会 RMDir /r $INSTDIR，升级时会清掉它；这里改成只删打包文件。

!macro customRemoveFiles
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
  ; userdata 留下。目录非空时这一行不会删掉安装根。
  RMDir "$INSTDIR"
!macroend
