!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\nexus" "" "URL:NEXUS Protocol"
  WriteRegStr SHCTX "Software\Classes\nexus" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\nexus\DefaultIcon" "" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr SHCTX "Software\Classes\nexus\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ReadRegStr $0 SHCTX "Software\Classes\nexus\shell\open\command" ""
  StrCmp $0 '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"' +2 0
  StrCmp $0 "" 0 +2
  DeleteRegKey SHCTX "Software\Classes\nexus"
!macroend
