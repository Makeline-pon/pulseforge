/**
 * Tauri 打包入口：把 `npm run tauri build` 变成一个「有诊断的转发器」。
 *
 * 直接依赖全局 tauri CLI 的问题是——在没装 Rust 的机器上它只会抛一段看不懂的
 * Node 堆栈。这里先做三项检查（前端产物、Rust 工具链、Tauri CLI），
 * 缺哪一项就打印对应的安装命令，然后以退出码 1 结束，不产生半成品。
 *
 * 用法：
 *   node scripts/tauri.mjs build      # 产出 dist-pwa + Windows 安装包（.exe/NSIS）
 *   node scripts/tauri.mjs dev        # 开发模式（热重载，需要先起 5180 预览或由 CLI 拉起）
 *   node scripts/tauri.mjs --check    # 只做环境检查，不执行构建
 */

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const rawArgs = process.argv.slice(2)
const checkOnly = rawArgs.includes('--check')
const args = rawArgs.filter((arg) => arg !== '--check')

/**
 * 探测一个可执行文件是否存在。
 * 注意 stdio 必须是 ignore：沙箱下带管道的子进程会直接 EPERM。
 */
function has(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore', shell: process.platform === 'win32' })
  return !result.error && result.status === 0
}

function fail(lines) {
  console.error('')
  for (const line of lines) console.error(line)
  console.error('')
  process.exit(1)
}

// 1. 前端产物
if (!existsSync(join(root, 'dist-pwa', 'app.js'))) {
  if (checkOnly) {
    fail(['✗ 缺少 dist-pwa/（先运行 npm run build:release）'])
  }
  console.log('dist-pwa/ 不存在，先执行发布构建…')
  const build = spawnSync(process.execPath, [join(here, 'build-release.mjs')], { cwd: root, stdio: 'inherit' })
  if (build.status !== 0) fail(['✗ 发布构建失败，已中止 Tauri 打包'])
} else if (!checkOnly) {
  // 每次打包都重新生成，保证 exe 里的资源与 package.json 版本一致
  const build = spawnSync(process.execPath, [join(here, 'build-release.mjs'), '--silent'], { cwd: root, stdio: 'inherit' })
  if (build.status !== 0) fail(['✗ 发布构建失败，已中止 Tauri 打包'])
}

// 2. Rust 工具链
const hasCargo = has('cargo', ['--version'])
const hasRustc = has('rustc', ['--version'])

// 3. Tauri CLI：本地装的包优先（CI 与开发机都走这条），其次 npx 缓存，最后 cargo 子命令。
//    注意 @tauri-apps/cli 的入口文件名在 v2 里变过，所以先用 npx 调它的 bin，
//    只有 npx 不可用时才退回直接执行 tauri.js。
const localCliDir = join(root, 'node_modules', '@tauri-apps', 'cli')
let cli = null
if (existsSync(localCliDir) && has('npx', ['--no-install', 'tauri', '--version'])) {
  cli = { command: 'npx', prefix: ['--no-install', 'tauri'] }
} else if (existsSync(join(localCliDir, 'tauri.js'))) {
  cli = { command: process.execPath, prefix: [join(localCliDir, 'tauri.js')] }
} else if (has('npx', ['--no-install', 'tauri', '--version'])) {
  cli = { command: 'npx', prefix: ['--no-install', 'tauri'] }
} else if (hasCargo && has('cargo', ['tauri', '--version'])) {
  cli = { command: 'cargo', prefix: ['tauri'] }
}

console.log('')
console.log('Tauri 环境检查')
console.log('─'.repeat(46))
console.log((hasRustc ? '  ✓ ' : '  ✗ ') + 'rustc')
console.log((hasCargo ? '  ✓ ' : '  ✗ ') + 'cargo')
console.log((cli === null ? '  ✗ ' : '  ✓ ') + 'tauri CLI' + (cli === null ? '' : '（' + cli.command + '）'))
console.log((existsSync(join(root, 'dist-pwa', 'app.js')) ? '  ✓ ' : '  ✗ ') + 'dist-pwa/app.js')
console.log((existsSync(join(root, 'src-tauri', 'Cargo.toml')) ? '  ✓ ' : '  ✗ ') + 'src-tauri/Cargo.toml')
console.log('─'.repeat(46))
console.log('')

if (checkOnly) {
  const problems = []
  if (!hasRustc || !hasCargo) {
    problems.push(
      '✗ 未检测到 Rust 工具链：',
      '  1) 安装 Rust：https://rustup.rs → rustup-init.exe（默认 MSVC 工具链）',
      '  2) 同时安装 Visual Studio Build Tools 的「使用 C++ 的桌面开发」组件',
      '  3) 重开终端确认 cargo --version 与 rustc --version 可用',
    )
  }
  if (cli === null) {
    problems.push('✗ 未找到 Tauri CLI：npm i -D @tauri-apps/cli（或 cargo install tauri-cli --version "^2"）')
  }
  if (problems.length > 0) {
    console.error('')
    for (const line of problems) console.error(line)
    console.error('')
    process.exit(1)
  }
  console.log('环境齐备：可以运行 npm run tauri build')
  process.exit(0)
}

if (!hasCargo || !hasRustc) {
  fail([
    '✗ 未检测到 Rust 工具链，无法生成 .exe。',
    '',
    '请按顺序执行（只需一次）：',
    '  1) 安装 Rust：https://rustup.rs  → 运行 rustup-init.exe，选择默认 MSVC 工具链',
    '     还需要 Visual Studio Build Tools 的「使用 C++ 的桌面开发」组件',
    '  2) 重开一个终端，确认：cargo --version',
    '  3) 回到本目录再跑：npm run tauri build',
    '',
    '（WebView2 运行时由 Tauri 的 downloadBootstrapper 自动安装，不需要手动准备。）',
  ])
}

if (cli === null) {
  fail([
    '✗ 未找到 Tauri CLI。任选一种方式安装：',
    '',
    '  A) 装到本项目（推荐，版本可控）：',
    '     npm i -D @tauri-apps/cli',
    '',
    '  B) 装成 cargo 子命令：',
    '     cargo install tauri-cli --version "^2"',
    '',
    '装好后重跑：npm run tauri build',
  ])
}

const command = cli.command
const commandArgs = cli.prefix.concat(args.length === 0 ? ['build'] : args)
console.log('执行：' + command + ' ' + commandArgs.join(' '))
console.log('')

const result = spawnSync(command, commandArgs, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32' && (command === 'npx' || command === 'cargo'),
})

if (result.error) {
  fail(['✗ 启动 Tauri 失败：' + result.error.message])
}
if (result.status !== 0) {
  fail(['✗ Tauri 构建失败（exit ' + String(result.status) + '）。产物不会出现在 dist-plugin/ 或 dist-pwa/。'])
}

console.log('')
console.log('✓ 构建完成。安装包位置：src-tauri/target/release/bundle/nsis/')
console.log('  绿色版可执行文件：src-tauri/target/release/pulseforge.exe')
