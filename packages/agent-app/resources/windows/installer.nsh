; Muster Agent NSIS hooks (electron-builder.yml nsis.include).
; electron-builder registers URL schemes on macOS and Linux only, so the installer registers muster:// for this user
; (HKCU, no admin) with the same values Electron's app.setAsDefaultProtocolClient writes on every launch, and the
; uninstaller removes it. An update runs the old uninstaller with --updated: the scheme stays registered then.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\muster" "" "URL:muster"
  WriteRegStr HKCU "Software\Classes\muster" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\muster\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\muster\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\muster"
  ${endIf}
!macroend
