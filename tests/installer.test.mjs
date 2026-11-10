// 安装器与增量更新校验。
//
// 这层测试不做宏展开，而是把「安装器应当满足的商业级行为」逐条钉成断言：
//   - installer-hooks.nsh 被 tauri.conf.json 正确引用，四个生命周期钩子都存在；
//   - 检测 → 清理/确认 → 磁盘校验 的顺序不能被改乱；
//   - 关键文案、注册表路径、150MB 阈值、临时文件清理调用都在位；
//   - service worker 不再在 install 里自动 skipWaiting，而是广播更新提示；
//   - 产物里真的带上了提示文案与版本哈希。
//
// 任何一条失败都意味着：用户装到一半会被静默覆盖、装到没空间的盘上失败，
// 或者编曲途中被强制刷新丢掉未保存的改动。
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const tauri = join(root, 'src-tauri')
const hooksPath = join(tauri, 'installer-hooks.nsh')
const confPath = join(tauri, 'tauri.conf.json')
const swPath = join(root, 'src', 'pwa', 'sw.js')

let passed = 0
function check(label, run) {
  try {
    run()
    passed += 1
    console.log('  ✓ ' + label)
  } catch (error) {
    console.error('  ✗ ' + label)
    throw error
  }
}

function read(path) {
  return readFileSync(path, 'utf8')
}

const hooks = read(hooksPath)
const conf = JSON.parse(read(confPath))
const sw = read(swPath)
const appSource = read(join(root, 'src', 'client', 'web-entry.ts'))

/** 取某个钩子宏的正文，方便只看这一段里的调用顺序。 */
function hookBody(name) {
  const start = hooks.indexOf('!macro ' + name)
  assert.notEqual(start, -1, '缺少宏 ' + name)
  const end = hooks.indexOf('!macroend', start)
  assert.notEqual(end, -1, name + ' 没有正确闭合')
  return hooks.slice(start, end)
}

console.log('installer：检查安装器配置与 NSIS 钩子')

check('tauri.conf.json 引用 installer-hooks.nsh 且文件存在', function () {
  assert.ok(existsSync(hooksPath), '缺少 src-tauri/installer-hooks.nsh')
  const nsis = conf.bundle.windows.nsis
  assert.equal(nsis.installerHooks, 'installer-hooks.nsh', 'nsis.installerHooks 必须指向钩子文件')
})

check('打包目标为 nsis 且安装模式是 perMachine', function () {
  assert.deepEqual(conf.bundle.targets, ['nsis'])
  const nsis = conf.bundle.windows.nsis
  // perMachine 才会写入 HKLM、装到 C:\Program Files；currentUser 装到 AppData 会让默认路径失效
  assert.equal(nsis.installMode, 'perMachine')
  assert.equal(nsis.compression, 'lzma')
  assert.equal(nsis.startMenuFolder, 'PulseForge')
})

check('安装目录会带上 package.json 清单（完整性校验的判据）', function () {
  const resources = conf.bundle.resources
  assert.ok(resources !== undefined, 'bundle.resources 必须映射 resources/package.json')
  const entry = Object.keys(resources).find(function (key) {
    return resources[key] === 'package.json'
  })
  assert.ok(entry !== undefined, 'resources 里必须有落到安装根目录的 package.json')
  assert.ok(existsSync(join(tauri, entry)), '资源文件不存在：' + entry)
  const manifest = JSON.parse(read(join(tauri, entry)))
  assert.equal(manifest.name, 'PulseForge')
  assert.equal(manifest.entry, 'PulseForge.exe')
  assert.equal(manifest.version, conf.version, '清单版本必须与 tauri.conf.json 一致')
})

check('四个安装生命周期宏都存在且闭合', function () {
  for (const name of [
    'NSIS_HOOK_PREINSTALL',
    'NSIS_HOOK_POSTINSTALL',
    'NSIS_HOOK_PREUNINSTALL',
    'NSIS_HOOK_POSTUNINSTALL',
  ]) {
    hookBody(name)
  }
  // LogicLib/FileFunc 是 ${If}、${DriveSpace} 的前提，缺了打包直接报语法错
  assert.match(hooks, /!include "LogicLib\.nsh"/)
  assert.match(hooks, /!include "FileFunc\.nsh"/)
})

check('安装前钩子包含环境检测与完整性判定', function () {
  const body = hookBody('NSIS_HOOK_PREINSTALL')
  assert.match(body, /Call PfDetectInstall/)
  assert.match(hooks, /ReadRegStr \$R2 HKLM "\$\{PF_MARKER_KEY\}" "InstallDir"/, '应从注册表标记键读取安装目录')
  assert.match(hooks, /Uninstall\\PulseForge/, '应能回退到卸载键的 InstallLocation')
  assert.match(hooks, /PF_APP_EXE/, '应检查主程序')
  assert.match(hooks, /PF_MANIFEST/, '应检查 package.json')
  assert.match(hooks, /\$\{FileExists\} "\$R2\\\$\{PF_APP_EXE\}"/)
  assert.match(hooks, /\$\{FileExists\} "\$R2\\\$\{PF_MANIFEST\}"/)
})

check('完整 / 损坏 / 不存在 三种状态都有对应分支与文案', function () {
  const body = hookBody('NSIS_HOOK_PREINSTALL')
  assert.match(hooks, /StrCpy \$R0 "intact"/)
  assert.match(hooks, /StrCpy \$R0 "broken"/)
  assert.match(hooks, /StrCpy \$R0 "missing"/)
  assert.ok(body.includes('检测到已安装旧版本'), '旧版本应提示可升级')
  assert.ok(body.includes('是否更新至当前版本'), '升级询问要写清目标版本')
  assert.ok(body.includes('读不到它的版本信息'), '版本未知时应退化为覆盖安装询问')
  assert.ok(body.includes('检测到损坏的旧版本'), '损坏安装应提示自动清理')
  assert.match(body, /RMDir \/r "\$R2"/, '损坏时应静默删除旧目录')
  assert.match(body, /Call PfPurgeMarker/, '损坏时应清理注册表残留')
})

check('用户取消时退出安装而不是继续解压', function () {
  const body = hookBody('NSIS_HOOK_PREINSTALL')
  // 对话框用 /SD IDYES $R9 回传选择，取消分支必须 Quit，否则会把文件解压到一半
  assert.match(body, /MB_YESNO[^\n]*\/SD IDYES \$R9/)
  assert.match(body, /\$\{If\} \$R9 == IDNO/)
  const quitIndex = body.indexOf('Call PfCleanupTemp', body.indexOf('$R9 == IDNO'))
  assert.notEqual(quitIndex, -1, '取消分支应先清理临时文件')
  assert.match(body.slice(quitIndex, quitIndex + 60), /Quit/, '取消分支必须 Quit')
})

check('磁盘空间阈值 150MB 且不足时清理临时文件后中止', function () {
  assert.match(hooks, /!define PF_MIN_FREE_MB 150/)
  const body = hookBody('NSIS_HOOK_PREINSTALL')
  assert.match(body, /Call PfFreeSpaceMb/)
  assert.ok(body.includes('此磁盘剩余空间不足'), '空间不足必须有明确提示')
  assert.ok(body.includes('选择其他磁盘'), '提示里应引导用户换盘')
  const spaceIndex = body.indexOf('$R3 < ${PF_MIN_FREE_MB}')
  assert.notEqual(spaceIndex, -1, '需要比较剩余空间与阈值')
  const after = body.slice(spaceIndex)
  assert.match(after, /Call PfCleanupTemp/, '空间不足时必须删除本次临时安装文件')
})

check('检测先于磁盘校验（顺序不能颠倒）', function () {
  const body = hookBody('NSIS_HOOK_PREINSTALL')
  const detect = body.indexOf('Call PfDetectInstall')
  const space = body.indexOf('Call PfFreeSpaceMb')
  assert.ok(detect !== -1 && space !== -1)
  assert.ok(detect < space, '必须先判断旧版本，再校验磁盘空间')
})

check('磁盘剩余空间按 $INSTDIR 所在盘读取，UNC 路径跳过', function () {
  assert.match(hooks, /\$\{DriveSpace\} "\$R4" "\/D=F \/S=M" \$R3/)
  assert.match(hooks, /StrCpy \$R4 \$INSTDIR 2/, '取前两字符判断 UNC')
  assert.match(hooks, /\$\{If\} \$R4 == "\\\\"/)
})

check('默认安装路径为 Program Files 下的 PulseForge', function () {
  assert.match(hooks, /StrCpy \$INSTDIR "\$PROGRAMFILES64\\PulseForge"/)
  const body = hookBody('NSIS_HOOK_PREINSTALL')
  assert.match(body, /\$\{If\} \$INSTDIR == ""/, '只在向导没给路径时才用默认值，不能覆盖用户选择')
})

check('安装后写入卸载 / 标记注册表信息', function () {
  const body = hookBody('NSIS_HOOK_POSTINSTALL')
  assert.match(body, /WriteRegStr HKLM "\$\{PF_MARKER_KEY\}" "InstallDir" "\$INSTDIR"/)
  assert.match(body, /WriteRegStr HKLM "\$\{PF_MARKER_KEY\}" "Version" "\$\{VERSION\}"/)
  assert.match(body, /"InstallLocation" "\$INSTDIR"/)
  assert.match(body, /"DisplayIcon"/)
  assert.match(body, /EstimatedSize/)
  // 不能凭空新建卸载条目，否则「应用和功能」里会出现两条 PulseForge
  assert.match(body, /ReadRegStr \$R0 HKLM "\$\{PF_UNINSTALL_KEY\}" "DisplayName"/)
})

check('注册表视图用完复位，避免影响 Tauri 自己的写入', function () {
  assert.match(hooks, /SetRegView 64/)
  const resets = hooks.match(/SetRegView 32/g) || []
  assert.ok(resets.length >= 3, '每个写注册表的函数都要复位到 32 位视图')
})

check('卸载会询问是否删除本地作品数据，并清理标记键', function () {
  const pre = hookBody('NSIS_HOOK_PREUNINSTALL')
  assert.ok(pre.includes('是否同时删除本地作品数据'), '卸载应询问是否保留工程数据')
  assert.match(pre, /RMDir \/r "\$\{PF_DATA_DIR\}"/)
  assert.match(hookBody('NSIS_HOOK_POSTUNINSTALL'), /Call PfPurgeMarker/)
})

check('临时文件清理覆盖 WebView2 引导程序与 NSIS 插件目录', function () {
  assert.match(hooks, /RMDir \/r "\$PLUGINSDIR"/)
  assert.match(hooks, /MicrosoftEdgeWebView2Setup\.exe/)
  assert.match(hooks, /PulseForge-Setup-\*\.exe/)
})

console.log('installer：检查 PWA 增量更新')

check('service worker 不再在 install 阶段自动 skipWaiting', function () {
  const installStart = sw.indexOf("addEventListener('install'")
  assert.notEqual(installStart, -1)
  const installEnd = sw.indexOf("addEventListener('activate'", installStart)
  const installBody = sw.slice(installStart, installEnd)
  // 注意只看真实调用：代码里的注释会提到 skipWaiting()，不算数
  assert.ok(!/self\.skipWaiting\s*\(/.test(installBody), 'install 里不能直接 skipWaiting，否则会打断正在编曲的页面')
  assert.match(installBody, /announceUpdate\(\)/, '装好后应广播更新提示')
})

check('新版本通过 clients 广播 pf-update-ready', function () {
  assert.match(sw, /function announceUpdate\(\)/)
  assert.match(sw, /\.matchAll\(\{ type: 'window', includeUncontrolled: true \}\)/)
  assert.match(sw, /type: 'pf-update-ready'/)
  assert.match(sw, /version: VERSION/)
})

check('message 支持对象与字符串两种 skip-waiting', function () {
  assert.match(sw, /data === 'skip-waiting'/)
  assert.match(sw, /data\.type === 'skip-waiting'/)
  assert.match(sw, /self\.skipWaiting\(\)\.then\(announceUpdate\)/)
})

check('页面侧展示「新版本已就绪」轻提示并能刷新', function () {
  assert.ok(appSource.includes('新版本已就绪，点击刷新更新'), '缺少提示文案')
  assert.match(appSource, /className: 'pf-update'/)
  assert.match(appSource, /function applyUpdate\(\)/)
  assert.match(appSource, /registration\.waiting !== null/, '已有 waiting worker 时要直接提示')
  assert.match(appSource, /controllerchange/, '切换后应监听 controllerchange 再刷新')
  assert.match(appSource, /pf-update-ready/, '应处理 SW 广播')
})

check('PWA 产物里带上了提示文案（构建已完成时）', function () {
  const bundled = join(root, 'dist-pwa', 'app.js')
  if (!existsSync(bundled)) return // 未执行 build:release 时跳过产物断言
  const app = read(bundled)
  assert.ok(app.includes('新版本已就绪'), 'dist-pwa/app.js 没有更新提示，可能忘了重新构建')
  const distSw = read(join(root, 'dist-pwa', 'sw.js'))
  assert.ok(distSw.includes('pf-update-ready'))
  assert.ok(!distSw.includes('__PF_VERSION__'), 'sw.js 的版本占位符未被替换')
})

console.log('installer：检查版本核对')

check('安装器声明 version.json 作为第二版本来源', function () {
  assert.match(hooks, /!define PF_VERSION_FILE "version\.json"/)
  assert.match(hooks, /Function PfReadVersionFile/)
  assert.match(hooks, /StrCpy \$R4 "\$R2\\\$\{PF_VERSION_FILE\}"/, '应从安装目录拼出 version.json 路径')
})

check('读不到注册表版本时退回 version.json', function () {
  assert.match(hooks, /Call PfReadVersionFile/)
  assert.match(hooks, /StrCpy \$R1 \$R5/, '应把解析结果写回已安装版本变量')
})

check('版本号按三段数字解析，构建哈希不参与比较', function () {
  assert.match(hooks, /Function PfVersionParts/)
  assert.match(hooks, /StrCmp \$R4 "\+" pf_vp_end 0/, '遇到 + 应停止解析，否则重建会被误判为新版本')
  assert.match(hooks, /Function PfVersionStore/)
})

check('旧版本提示「是否更新至当前版本」并保留工程数据', function () {
  assert.match(hooks, /检测到已安装旧版本 \(v\$R1\)，是否更新至当前版本 \(v\$\{VERSION\}\)/)
  assert.match(hooks, /更新将保留工程数据/)
})

check('同版本或更高版本提示「已是最新版本」并退出安装', function () {
  assert.match(hooks, /当前已是最新版本 \(v\$R1\)，无需覆盖安装/)
  assert.match(hooks, /\$\{If\} \$R7 < 0/)
  assert.match(hooks, /Call PfCleanupTemp\s*\r?\n\s*Quit/, '提示后应清理临时文件再退出')
})

check('选择「否」时退出而不是继续覆盖', function () {
  assert.match(hooks, /\/SD IDYES \$R9/)
  assert.match(hooks, /\$\{If\} \$R9 == IDNO/)
})

check('安装包与安装目录都带 version.json', function () {
  const conf = JSON.parse(read(join(root, 'src-tauri', 'tauri.conf.json')))
  assert.equal(conf.bundle.resources['resources/version.json'], 'version.json')
  const doc = JSON.parse(read(join(root, 'src-tauri', 'resources', 'version.json')))
  assert.equal(typeof doc.version, 'string')
  assert.equal(typeof doc.build, 'string')
  assert.equal(doc.id, doc.version + '+' + doc.build)
})

console.log('installer ok：' + passed + ' 组断言通过')
