/*
 * PulseForge NSIS 安装器钩子（Tauri 2 的 installerHooks）。
 *
 * 这个文件被 tauri-bundler 以 !include 方式插进生成的 installer.nsi，
 * 由 Tauri 在固定位置调用四个宏：
 *
 *   NSIS_HOOK_PREINSTALL   解压文件之前 —— 旧版本检测、损坏清理、磁盘空间校验
 *   NSIS_HOOK_POSTINSTALL  文件落盘之后 —— 写标记键、补充卸载信息
 *   NSIS_HOOK_PREUNINSTALL 卸载开始 —— 询问是否保留本地作品数据
 *   NSIS_HOOK_POSTUNINSTALL 卸载结束 —— 清理标记键
 *
 * 注册表布局（我们只额外写两个位置，不新建应用列表条目）：
 *   HKLM\Software\PulseForge                       安装标记：InstallDir / Version / InstalledAt
 *   HKLM\...\Uninstall\PulseForge                  仅当 Tauri 已创建同名键时追加 InstallLocation 等
 *
 * 所有检查都基于 $INSTDIR，所以用户在向导里改了安装目录后，磁盘校验会跟着走。
 */

!include "LogicLib.nsh"
!include "FileFunc.nsh"

; 解压后大约占用 60–80 MB，留出余量后要求 150 MB 空闲空间
!define PF_MIN_FREE_MB 150
; 安装目录里必须存在的主程序与资源清单（resources 里显式带了一个 package.json）
!define PF_APP_EXE "PulseForge.exe"
!define PF_MANIFEST "package.json"
; 版本清单：安装目录里的第二份版本来源（注册表被清掉时靠它判断）
!define PF_VERSION_FILE "version.json"
!define PF_MARKER_KEY "Software\PulseForge"
!define PF_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\PulseForge"
; WebView2 的本地数据（IndexedDB 里的自动保存工程）按 identifier 存放
!define PF_DATA_DIR "$LOCALAPPDATA\dev.pulseforge.app"

/*
 * 检测已有的 PulseForge 安装。
 *
 * 输出（寄存器，调用方负责保存）：
 *   $R0 = "missing" | "intact" | "broken"
 *   $R1 = 已安装版本（可能为空）
 *   $R2 = 已安装目录（可能为空）
 *
 * 判定顺序：标记键 → 卸载键的 InstallLocation → 默认路径。
 * 「完整」要求安装目录里同时存在主程序与 package.json；缺任意一个即视为损坏。
 */
Function PfDetectInstall
  Push $R3
  Push $R4

  StrCpy $R0 "missing"
  StrCpy $R1 ""
  StrCpy $R2 ""

  SetRegView 64
  ClearErrors
  ReadRegStr $R2 HKLM "${PF_MARKER_KEY}" "InstallDir"
  ${If} ${Errors}
    ReadRegStr $R2 HKCU "${PF_MARKER_KEY}" "InstallDir"
  ${EndIf}
  ReadRegStr $R1 HKLM "${PF_MARKER_KEY}" "Version"
  ${If} $R1 == ""
    ReadRegStr $R1 HKCU "${PF_MARKER_KEY}" "Version"
  ${EndIf}

  ${If} $R2 == ""
    ReadRegStr $R2 HKLM "${PF_UNINSTALL_KEY}" "InstallLocation"
    ${If} $R2 == ""
      ReadRegStr $R2 HKCU "${PF_UNINSTALL_KEY}" "InstallLocation"
    ${EndIf}
  ${EndIf}

  ${If} $R2 == ""
    ReadRegStr $R3 HKLM "${PF_UNINSTALL_KEY}" "DisplayName"
    ${If} $R3 != ""
      ; 有卸载条目但没记录目录：退回默认安装位置再判断
      StrCpy $R2 "$PROGRAMFILES64\PulseForge"
    ${EndIf}
  ${EndIf}
  SetRegView 32

  ${If} $R2 == ""
    StrCpy $R0 "missing"
  ${ElseIf} ${FileExists} "$R2\${PF_APP_EXE}"
    ${If} ${FileExists} "$R2\${PF_MANIFEST}"
      StrCpy $R0 "intact"
    ${Else}
      StrCpy $R0 "broken"
    ${EndIf}
  ${ElseIf} ${DirExists} "$R2"
    ; 目录还在但没有主程序：多半是上次安装中断
    StrCpy $R0 "broken"
  ${Else}
    ; 注册表有记录、目录已不存在：同样按损坏处理（清理记录后重装）
    StrCpy $R0 "broken"
  ${EndIf}

  DetailPrint "PulseForge 安装状态：$R0（目录 $R2，版本 $R1）"

  Pop $R4
  Pop $R3
FunctionEnd

/*
 * 从 version.json 里读出版本号。
 *
 * 输入：$R4 = 文件完整路径
 * 输出：$R5 = 版本号（读不到时为空串）
 *
 * 为什么自己写解析而不用第三方 JSON 插件：NSIS 没有内置 JSON，引一个插件只为读一个
 * 我们亲手生成的字段不值得。这里做的是「全文扫描找到 "version"，跳过冒号与空格，
 * 取两个引号之间的内容」—— 对 `{"version": "1.2.3"}` 这种固定形状足够，遇到任何
 * 意外结构只会返回空串，调用方会退回「版本未知」的保守分支。
 */
Function PfReadVersionFile
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  Push $R10

  StrCpy $R5 ""
  IfFileExists "$R4" pf_vf_open pf_vf_done

  pf_vf_open:
    ClearErrors
    FileOpen $R6 "$R4" r
    IfErrors pf_vf_done
    ; 文件只有一两百字节，逐行拼成整串（读完一行自动往后，直到文件末尾）
    StrCpy $R7 ""
    pf_vf_read:
      ClearErrors
      FileRead $R6 $R10
      IfErrors pf_vf_read_done
      StrCmp $R10 "" pf_vf_read_done
      StrCpy $R7 "$R7$R10"
      Goto pf_vf_read
    pf_vf_read_done:
    FileClose $R6

  StrLen $R8 $R7
  StrCpy $R9 0
  pf_vf_scan:
    IntCmp $R9 $R8 pf_vf_done pf_vf_scan_char pf_vf_done
  pf_vf_scan_char:
    ; `"version"` 正好 9 个字符（含两侧引号）
    StrCpy $R6 $R7 9 $R9
    StrCmp $R6 '"version"' pf_vf_found
    IntOp $R9 $R9 + 1
    Goto pf_vf_scan

  pf_vf_found:
    IntOp $R9 $R9 + 9
    ; 跳过 `:` 与空白，找到值的开引号
  pf_vf_seek:
    IntCmp $R9 $R8 pf_vf_done pf_vf_seek_char pf_vf_done
  pf_vf_seek_char:
    StrCpy $R6 $R7 1 $R9
    IntOp $R9 $R9 + 1
    StrCmp $R6 '"' pf_vf_collect pf_vf_seek
  pf_vf_collect:
    IntCmp $R9 $R8 pf_vf_done pf_vf_collect_char pf_vf_done
  pf_vf_collect_char:
    StrCpy $R6 $R7 1 $R9
    IntOp $R9 $R9 + 1
    StrCmp $R6 '"' pf_vf_done
    StrCpy $R5 "$R5$R6"
    Goto pf_vf_collect

  pf_vf_done:
  ${If} $R5 != ""
    DetailPrint "version.json 里的版本号：$R5"
  ${EndIf}

  Pop $R10
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
FunctionEnd

/*
 * 把 `1.2.3` 拆成三段数字。
 *
 * 输入：$R6 = 版本串
 * 输出：$0 = major，$1 = minor，$2 = patch（缺失段补 0）
 *
 * 只认数字、`.` 与 `+`：`+` 之后是构建哈希，直接停止，因此
 * `0.8.0+91b15c222a` 与 `0.8.0` 拆出来的三段完全一致 —— 同一版本的重建不算新版本。
 */
Function PfVersionParts
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9

  StrCpy $0 0
  StrCpy $1 0
  StrCpy $2 0
  StrCpy $R7 0
  StrCpy $R8 0
  StrCpy $R9 0
  StrLen $R5 $R6

  pf_vp_loop:
    IntCmp $R9 $R5 pf_vp_end pf_vp_char pf_vp_end
  pf_vp_char:
    StrCpy $R4 $R6 1 $R9
    IntOp $R9 $R9 + 1
    StrCmp $R4 "." pf_vp_dot 0
    StrCmp $R4 "+" pf_vp_end 0
    StrCmp $R4 "0" pf_vp_n0
    StrCmp $R4 "1" pf_vp_n1
    StrCmp $R4 "2" pf_vp_n2
    StrCmp $R4 "3" pf_vp_n3
    StrCmp $R4 "4" pf_vp_n4
    StrCmp $R4 "5" pf_vp_n5
    StrCmp $R4 "6" pf_vp_n6
    StrCmp $R4 "7" pf_vp_n7
    StrCmp $R4 "8" pf_vp_n8
    StrCmp $R4 "9" pf_vp_n9
    ; 非数字（例如 rc1 的字母）：忽略，继续往后看
    Goto pf_vp_loop

  pf_vp_n0:
    StrCpy $R3 0
    Goto pf_vp_accum
  pf_vp_n1:
    StrCpy $R3 1
    Goto pf_vp_accum
  pf_vp_n2:
    StrCpy $R3 2
    Goto pf_vp_accum
  pf_vp_n3:
    StrCpy $R3 3
    Goto pf_vp_accum
  pf_vp_n4:
    StrCpy $R3 4
    Goto pf_vp_accum
  pf_vp_n5:
    StrCpy $R3 5
    Goto pf_vp_accum
  pf_vp_n6:
    StrCpy $R3 6
    Goto pf_vp_accum
  pf_vp_n7:
    StrCpy $R3 7
    Goto pf_vp_accum
  pf_vp_n8:
    StrCpy $R3 8
    Goto pf_vp_accum
  pf_vp_n9:
    StrCpy $R3 9
    Goto pf_vp_accum

  pf_vp_accum:
    IntOp $R8 $R8 * 10
    IntOp $R8 $R8 + $R3
    Goto pf_vp_loop

  pf_vp_dot:
    Call PfVersionStore
    StrCpy $R8 0
    Goto pf_vp_loop

  pf_vp_end:
    Call PfVersionStore

  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
FunctionEnd

/** 把当前累积值 $R8 存进第 $R7 段（0/1/2），然后段号 +1。 */
Function PfVersionStore
  ${If} $R7 == 0
    StrCpy $0 $R8
  ${ElseIf} $R7 == 1
    StrCpy $1 $R8
  ${ElseIf} $R7 == 2
    StrCpy $2 $R8
  ${EndIf}
  IntOp $R7 $R7 + 1
FunctionEnd

/** 删除安装标记键（损坏清理与卸载时调用）。 */
Function PfPurgeMarker
  SetRegView 64
  DeleteRegKey HKLM "${PF_MARKER_KEY}"
  DeleteRegKey HKCU "${PF_MARKER_KEY}"
  SetRegView 32
FunctionEnd

/*
 * 清理「本次安装」产生的临时文件。
 *
 * 说明：安装器自身是一个 exe，运行期间被 Windows 独占，无法自我删除；
 * 这里清掉的是 NSIS 插件目录、WebView2 引导程序缓存以及我们自己的临时目录，
 * 用户下次运行新安装包时不会累积残留。
 */
Function PfCleanupTemp
  DetailPrint "清理本次安装的临时文件"
  RMDir /r "$PLUGINSDIR"
  Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
  Delete "$TEMP\MicrosoftEdgeWebView2Setup.exe"
  Delete "$TEMP\PulseForge-Setup-*.exe"
  RMDir /r "$TEMP\PulseForge-Setup"
FunctionEnd

/** 读取 $INSTDIR 所在磁盘的空闲空间（MB）到 $R3；网络路径返回空串表示跳过。 */
Function PfFreeSpaceMb
  Push $R4
  StrCpy $R3 ""
  StrCpy $R4 $INSTDIR 2
  ${If} $R4 == "\\"
    DetailPrint "安装目录位于网络路径，跳过磁盘空间检查"
  ${Else}
    StrCpy $R4 "$INSTDIR" 3
    ${If} $R4 != ""
      ${DriveSpace} "$R4" "/D=F /S=M" $R3
    ${EndIf}
  ${EndIf}
  Pop $R4
FunctionEnd

; ---------------------------------------------------------------------------
; 1) 安装前：旧版本检测 / 损坏清理 / 磁盘空间
; ---------------------------------------------------------------------------
!macro NSIS_HOOK_PREINSTALL
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

  ; 默认安装位置：C:\Program Files\PulseForge（perMachine 模式）
  ${If} $INSTDIR == ""
    StrCpy $INSTDIR "$PROGRAMFILES64\PulseForge"
  ${EndIf}

  Call PfDetectInstall
  ; 状态存进 $R8：后面的版本解析会反复借用 $R0~$R2
  StrCpy $R8 $R0

  ; 注册表里没记版本时，退回安装目录里的 version.json（第二份版本来源）
  ${If} $R1 == ""
  ${AndIf} $R2 != ""
    StrCpy $R4 "$R2\${PF_VERSION_FILE}"
    Call PfReadVersionFile
    StrCpy $R1 $R5
  ${EndIf}

  ${If} $R8 == "broken"
    MessageBox MB_OK|MB_ICONEXCLAMATION "检测到损坏的旧版本（$R2）。$\r$\n安装目录缺少 ${PF_APP_EXE} 或 ${PF_MANIFEST}，将自动清理残留并重新安装。" /SD IDOK
    DetailPrint "清理损坏的安装目录：$R2"
    ${If} $R2 != ""
      RMDir /r "$R2"
    ${EndIf}
    Call PfPurgeMarker
  ${ElseIf} $R8 == "intact"
    ${If} $R1 == ""
      ; 装是装过，但注册表与 version.json 都读不到版本：按「未知版本」询问覆盖
      MessageBox MB_YESNO|MB_ICONQUESTION "PulseForge 已存在于 $R2，但读不到它的版本信息。$\r$\n$\r$\n是否覆盖安装为 ${VERSION}？（工程数据会保留）" /SD IDYES $R9
      ${If} $R9 == IDNO
        DetailPrint "用户取消安装"
        Call PfCleanupTemp
        Quit
      ${EndIf}
    ${Else}
      ; 已装版本拆成 $R4/$R5/$R3，安装包版本拆成 $0/$1/$2
      StrCpy $R6 "$R1"
      Call PfVersionParts
      StrCpy $R4 $0
      StrCpy $R5 $1
      StrCpy $R3 $2
      StrCpy $R6 "${VERSION}"
      Call PfVersionParts

      ; $R7：-1 = 已装更旧（可升级），0 = 同版本，1 = 已装更新
      ${If} $0 > $R4
        StrCpy $R7 1
      ${ElseIf} $0 < $R4
        StrCpy $R7 -1
      ${ElseIf} $1 > $R5
        StrCpy $R7 1
      ${ElseIf} $1 < $R5
        StrCpy $R7 -1
      ${ElseIf} $2 > $R3
        StrCpy $R7 1
      ${ElseIf} $2 < $R3
        StrCpy $R7 -1
      ${Else}
        StrCpy $R7 0
      ${EndIf}

      ${If} $R7 < 0
        MessageBox MB_YESNO|MB_ICONQUESTION "检测到已安装旧版本 (v$R1)，是否更新至当前版本 (v${VERSION})？$\r$\n$\r$\n更新将保留工程数据。" /SD IDYES $R9
        ${If} $R9 == IDNO
          DetailPrint "用户选择不更新（已装 v$R1，安装包 v${VERSION}），退出安装"
          Call PfCleanupTemp
          Quit
        ${EndIf}
        DetailPrint "覆盖升级：v$R1 → v${VERSION}（$R2）"
      ${Else}
        MessageBox MB_OK|MB_ICONINFORMATION "当前已是最新版本 (v$R1)，无需覆盖安装。$\r$\n$\r$\n如需修复安装，请先在「应用和功能」里卸载 PulseForge 再运行安装程序。" /SD IDOK
        DetailPrint "已装版本 v$R1 ≥ 安装包 v${VERSION}，退出安装"
        Call PfCleanupTemp
        Quit
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; 磁盘空间：选好路径后按目标磁盘的剩余空间判断
  Call PfFreeSpaceMb
  ${If} $R3 != ""
  ${AndIf} $R3 < ${PF_MIN_FREE_MB}
    MessageBox MB_OK|MB_ICONSTOP "此磁盘剩余空间不足。$\r$\n$\r$\n目标磁盘仅剩 $R3 MB，PulseForge 至少需要 ${PF_MIN_FREE_MB} MB。$\r$\n请清理该磁盘后重试，或返回上一步选择其他磁盘。" /SD IDOK
    Call PfCleanupTemp
    Quit
  ${EndIf}
  ${If} $R3 != ""
    DetailPrint "目标磁盘剩余空间 $R3 MB，满足 ${PF_MIN_FREE_MB} MB 要求"
  ${EndIf}

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
!macroend

; ---------------------------------------------------------------------------
; 2) 安装后：写标记键 + 补充卸载信息
; ---------------------------------------------------------------------------
!macro NSIS_HOOK_POSTINSTALL
  Push $R0

  SetRegView 64
  WriteRegStr HKLM "${PF_MARKER_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${PF_MARKER_KEY}" "Version" "${VERSION}"
  WriteRegStr HKLM "${PF_MARKER_KEY}" "InstalledAt" "$INSTDIR"

  ; 只在 Tauri 已经创建了卸载条目时追加信息，避免生成第二个「应用和功能」条目
  ReadRegStr $R0 HKLM "${PF_UNINSTALL_KEY}" "DisplayName"
  ${If} $R0 != ""
    WriteRegStr HKLM "${PF_UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
    WriteRegStr HKLM "${PF_UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${PF_APP_EXE}"
    WriteRegStr HKLM "${PF_UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
    WriteRegDWORD HKLM "${PF_UNINSTALL_KEY}" "EstimatedSize" 153600
  ${Else}
    DetailPrint "未找到卸载条目，仅写入 PulseForge 标记键"
  ${EndIf}
  SetRegView 32

  DetailPrint "已记录安装信息：$INSTDIR（${VERSION}）"
  Pop $R0
!macroend

; ---------------------------------------------------------------------------
; 3) 卸载前：询问是否保留本地作品数据
; ---------------------------------------------------------------------------
!macro NSIS_HOOK_PREUNINSTALL
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除本地作品数据？$\r$\n$\r$\n包含自动保存的工程与缓存（${PF_DATA_DIR}）。$\r$\n选择「否」会保留，重新安装后仍可继续使用。" /SD IDNO IDYES pf_purge_data IDNO pf_keep_data
  pf_purge_data:
    DetailPrint "删除本地作品数据"
    RMDir /r "${PF_DATA_DIR}"
    Goto pf_data_done
  pf_keep_data:
    DetailPrint "保留本地作品数据"
  pf_data_done:
!macroend

; ---------------------------------------------------------------------------
; 4) 卸载后：清理标记键
; ---------------------------------------------------------------------------
!macro NSIS_HOOK_POSTUNINSTALL
  Call PfPurgeMarker
  DetailPrint "已移除 PulseForge 安装标记"
!macroend
