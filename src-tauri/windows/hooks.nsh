!include "LogicLib.nsh"
!include "FileFunc.nsh"

Var InstallArgyllUSB

!macro NSIS_HOOK_PREINSTALL
  StrCpy $InstallArgyllUSB 0

  ; Ensure $INSTDIR is on a local fixed drive (not a network/remote drive or UNC path)
  ${GetRoot} "$INSTDIR" $0
  System::Call 'kernel32::GetDriveType(t "$0") i .r1'
  ${If} $1 != 3
  ${OrIf} "$0" == "\\\\"
  ${OrIf} "$0" == "\\"
    UserInfo::GetAccountType
    Pop $0
    ${If} $0 == "Admin"
      StrCpy $INSTDIR "$PROGRAMFILES64\ICCery"
    ${Else}
      StrCpy $INSTDIR "$LOCALAPPDATA\Programs\ICCery"
    ${EndIf}
  ${EndIf}

  UserInfo::GetAccountType
  Pop $0
  ${If} $0 == "Admin"
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Install ArgyllCMS USB instrument drivers?$\r$\n$\r$\nRequired for spectrophotometers (i1Pro, ColorMunki, SpyderPrint, etc.)." \
      IDNO skip_usb_prompt
    StrCpy $InstallArgyllUSB 1
    skip_usb_prompt:
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $InstallArgyllUSB == 1
    IfFileExists "$INSTDIR\argyll\usb\ArgyllCMS_install_USB.exe" 0 check_resources
      ExecWait '"$INSTDIR\argyll\usb\ArgyllCMS_install_USB.exe"'
      Goto usb_done
    check_resources:
    IfFileExists "$INSTDIR\resources\argyll\usb\ArgyllCMS_install_USB.exe" 0 usb_missing
      ExecWait '"$INSTDIR\resources\argyll\usb\ArgyllCMS_install_USB.exe"'
      Goto usb_done
    usb_missing:
      MessageBox MB_ICONEXCLAMATION "ArgyllCMS USB driver installer was not found in the package."
    usb_done:
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Do not auto-run ArgyllCMS_uninstall_USB.exe. Driver removal is a
  ; separate admin action and can break other Argyll-based apps.
!macroend
