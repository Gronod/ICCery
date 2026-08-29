!include "LogicLib.nsh"
!include "FileFunc.nsh"

Var InstallArgyllUSB
Var MappedDrivesList

; Macro to check and map a drive if it is inaccessible/missing in the current session
!macro CheckAndMapMissingDrive DRIVE_PATH
  Push $0
  Push $1
  Push $2

  StrCpy $0 "${DRIVE_PATH}"
  ; Extract drive letter and colon (e.g. "Z:")
  StrCpy $1 "$0" 1 0
  StrCpy $0 "$1:"

  ; Verify if it is a valid drive letter A-Z
  System::Call 'kernel32::GetDriveType(t "$0\\") i .r1'
  ${If} $1 <= 1
    ; Drive letter does not exist in this elevated session (e.g. domain user network home drive).
    ; Create temporary DOS device mapping to local $LOCALAPPDATA to prevent "Invalid Drive" error.
    System::Call 'kernel32::DefineDosDevice(i 0, t "$0", t "$LOCALAPPDATA") i .r2'
    ${If} $2 != 0
      StrCpy $MappedDrivesList "$MappedDrivesList$0|"
    ${EndIf}
  ${EndIf}

  Pop $2
  Pop $1
  Pop $0
!macroend

!macro ScanAndMapShellFolderDrives
  Push $0 ; loop index
  Push $1 ; reg value name
  Push $2 ; reg value data
  Push $3 ; string length / extracted drive
  Push $4 ; colon char

  ; 1. Scan HKCU User Shell Folders
  StrCpy $0 0
  loop_user_shell_folders:
    EnumRegValue $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders" $0
    StrCmp $1 "" done_user_shell_folders
    ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders" $1
    IntOp $0 $0 + 1

    StrLen $3 $2
    ${If} $3 >= 2
      StrCpy $4 $2 1 1 ; 2nd character
      ${If} $4 == ":"
        StrCpy $3 $2 2 0 ; "X:"
        !insertmacro CheckAndMapMissingDrive $3
      ${EndIf}
    ${EndIf}
    Goto loop_user_shell_folders
  done_user_shell_folders:

  ; 2. Scan HKCU Shell Folders
  StrCpy $0 0
  loop_shell_folders:
    EnumRegValue $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders" $0
    StrCmp $1 "" done_shell_folders
    ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders" $1
    IntOp $0 $0 + 1

    StrLen $3 $2
    ${If} $3 >= 2
      StrCpy $4 $2 1 1
      ${If} $4 == ":"
        StrCpy $3 $2 2 0
        !insertmacro CheckAndMapMissingDrive $3
      ${EndIf}
    ${EndIf}
    Goto loop_shell_folders
  done_shell_folders:

  ; 3. Scan $EXEDIR drive
  ${GetRoot} "$EXEDIR" $3
  ${If} $3 != ""
    !insertmacro CheckAndMapMissingDrive $3
  ${EndIf}

  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro CleanupTemporaryMappedDrives
  Push $0
  Push $1
  Push $2

  loop_cleanup_drives:
    StrCmp $MappedDrivesList "" done_cleanup_drives
    StrCpy $1 $MappedDrivesList 2 0 ; "X:"
    StrCpy $MappedDrivesList $MappedDrivesList "" 3 ; strip "X:|"

    System::Call 'kernel32::DefineDosDevice(i 2, t "$1", t "$LOCALAPPDATA") i .r2'
    Goto loop_cleanup_drives
  done_cleanup_drives:

  Pop $2
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  StrCpy $InstallArgyllUSB 0
  StrCpy $MappedDrivesList ""

  ; 1. Dynamically detect and map any missing shell folder drives referenced in HKCU
  !insertmacro ScanAndMapShellFolderDrives

  ; 2. Ensure $INSTDIR is on a local fixed drive (not a network/remote drive or UNC path)
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

  ; 3. Prompt for optional USB driver installation if running as Admin
  UserInfo::GetAccountType
  Pop $0
  ${If} $0 == "Admin"
    SetShellVarContext all
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Install ArgyllCMS USB instrument drivers?$\r$\n$\r$\nRequired for spectrophotometers (i1Pro, ColorMunki, SpyderPrint, etc.)." \
      IDNO skip_usb_prompt
    StrCpy $InstallArgyllUSB 1
    skip_usb_prompt:
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 1. Execute Argyll USB driver installer if opted in
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

  ; 2. Clean up any temporary virtual DOS device mappings created during install
  !insertmacro CleanupTemporaryMappedDrives
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $MappedDrivesList ""
  !insertmacro ScanAndMapShellFolderDrives
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro CleanupTemporaryMappedDrives

  ; Do not auto-run ArgyllCMS_uninstall_USB.exe. Driver removal is a
  ; separate admin action and can break other Argyll-based apps.
!macroend
