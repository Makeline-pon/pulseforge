/**
 * 发布构建：一次产出两个可分发的目录，并把版本号注入所有「会被人看到」的地方。
 *
 *   dist-plugin/  DSH 插件包（index.js + client.js + cordis.patch.yml + icon + locale + package.json）
 *   dist-pwa/     独立部署的 PWA（app.js + index.html + manifest.json + sw.js + 图标）
 *   src-tauri/    Tauri 桌面外壳，静态资源直接指向 ../dist-pwa，版本号同步写入 tauri.conf.json
 *
 * 版本来源只有一个：仓库根的 package.json。任何一处版本不同步都会在最后的一致性检查里报错，
 * 避免出现「插件是 0.5.0、PWA 缓存还是 0.4.x」这种经典问题。
 *
 * 用法：node scripts/build-release.mjs [--silent]
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, cpSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, relative } from 'node:path'
import { gzipSync } from 'node:zlib'
import { renderIcon, encodeIco } from './lib/icons.mjs'
import { packRelease } from './lib/release-bundle.mjs'
import { readVersionJson, writeVersionJson, createVersionDocument } from './lib/version-json.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const silent = process.argv.includes('--silent')
// --pack-only：跳过所有编译步骤，只重新收集 release/（CI 在 tauri build 之后用它补上安装器）
const packOnly = process.argv.includes('--pack-only')

const pluginDir = join(root, 'dist-plugin')
const pwaDir = join(root, 'dist-pwa')
const tauriDir = join(root, 'src-tauri')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const VERSION = pkg.version

function log(line) {
  if (!silent) console.log(line)
}

if (packOnly) {
  log('')
  log('PulseForge ' + VERSION + ' · 打包 release/')
  log('─'.repeat(58))
  try {
    packRelease({ root: root, version: VERSION, log: log, requireInstaller: process.argv.includes('--require-installer') })
  } catch (error) {
    // 只打印人话，不打 Node 堆栈：CI 日志里堆栈会盖住真正的失败原因
    console.error('')
    console.error('✗ ' + (error instanceof Error ? error.message : String(error)))
    console.error('')
    process.exit(1)
  }
  log('')
  process.exit(0)
}

/**
 * 删除一个构建目录。
 *
 * 只允许删仓库根下的 `dist-*` / `src-tauri/target`，防止参数写错把源码删了。
 */
function clean(dir) {
  const target = resolve(dir)
  const allowed =
    target === resolve(pluginDir) ||
    target === resolve(pwaDir) ||
    target.startsWith(resolve(root) + '\\dist-') ||
    target.startsWith(resolve(root) + '/dist-')
  if (!allowed) throw new Error('拒绝清理非构建目录：' + target)
  rmSync(target, { recursive: true, force: true })
}

/** 同步跑一步构建；失败立刻退出，不要产出半个包。 */
function run(script, args) {
  const result = spawnSync(process.execPath, [script].concat(args), {
    cwd: root,
    // 必须用 inherit：沙箱下带管道的 stdio 会 EPERM，而且我们要实时看到体积
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error('子构建失败：' + relative(root, script) + '（exit ' + String(result.status) + '）')
  }
}

// ---------------------------------------------------------------------------
// 1. 两个目标目录
// ---------------------------------------------------------------------------

clean(pluginDir)
clean(pwaDir)
mkdirSync(pluginDir, { recursive: true })
mkdirSync(pwaDir, { recursive: true })

log('')
log('PulseForge ' + VERSION + ' · 发布构建')
log('─'.repeat(58))

run(join(root, 'build.mjs'), [pluginDir])
run(join(root, 'scripts', 'build-pwa.mjs'), [pwaDir])

// 根目录的 client.js / index.js 是「以本仓库目录直接安装插件」时被加载的文件，
// 必须与发布产物同步，否则本地链接安装的 DSH 还在跑旧版本。
run(join(root, 'build.mjs'), [])

// 根目录的 pwa/ 是 `npm run serve` 的预览目录，同样要刷新，
// 否则本地预览的还是上一个版本（Service Worker 会继续用旧缓存）。
run(join(root, 'scripts', 'build-pwa.mjs'), [])

// ---------------------------------------------------------------------------
// 2. DSH 插件包：补丁、图标、locale、包清单
// ---------------------------------------------------------------------------

/** 补丁文件里带一行版本注解，方便安装后肉眼核对是哪个版本。 */
const patch = `# PulseForge 的 bundle 补丁：向 profile 的注入图插入一个插件条目。
# 安装时由 DSH 的 bundle 安装器读取；id 必须与插件 id 一致。
# version: ${VERSION}
- insert:
    - id: pulseforge
      name: '${pkg.name}'
`
writeFileSync(join(pluginDir, 'cordis.patch.yml'), patch, 'utf8')
copyFileSync(join(root, 'icon.svg'), join(pluginDir, 'icon.svg'))
copyFileSync(join(root, 'LICENSE'), join(pluginDir, 'LICENSE'))

if (existsSync(join(root, 'locale'))) {
  cpSync(join(root, 'locale'), join(pluginDir, 'locale'), { recursive: true })
}

/**
 * 发布用的 package.json：去掉 scripts/devDependencies/files，
 * 只保留运行时需要被宿主读到的字段（dsh 声明、exports、依赖）。
 */
const releasePkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  type: pkg.type,
  main: pkg.main,
  exports: pkg.exports,
  dsh: pkg.dsh,
  peerDependencies: pkg.peerDependencies,
  dependencies: pkg.dependencies,
}
writeFileSync(join(pluginDir, 'package.json'), JSON.stringify(releasePkg, null, 2) + '\n', 'utf8')

// ---------------------------------------------------------------------------
// 3. Tauri 外壳：版本号 + 图标
// ---------------------------------------------------------------------------

const confPath = join(tauriDir, 'tauri.conf.json')
if (existsSync(confPath)) {
  const conf = JSON.parse(readFileSync(confPath, 'utf8'))
  conf.version = VERSION
  if (conf.package !== undefined && conf.package.productName !== undefined) {
    // Tauri v1 兼容位：v2 不再使用，但保留读取容错
    delete conf.package
  }
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n', 'utf8')
}

const cargoPath = join(tauriDir, 'Cargo.toml')
if (existsSync(cargoPath)) {
  const cargo = readFileSync(cargoPath, 'utf8')
  // Cargo.toml 的 [package] version 必须跟 package.json 一致，否则 exe 属性里的版本会对不上
  const next = cargo.replace(/^version = "[^"]*"$/m, 'version = "' + VERSION + '"')
  if (next !== cargo) writeFileSync(cargoPath, next, 'utf8')
}

const iconsDir = join(tauriDir, 'icons')
mkdirSync(iconsDir, { recursive: true })
const icoEntries = []
for (const size of [32, 64, 128, 256]) {
  const buffer = renderIcon(size, false, 0.78)
  icoEntries.push({ size: size, buffer: buffer })
  if (size === 32) writeFileSync(join(iconsDir, '32x32.png'), buffer)
  if (size === 128) writeFileSync(join(iconsDir, '128x128.png'), buffer)
  if (size === 256) writeFileSync(join(iconsDir, '128x128@2x.png'), buffer)
}
writeFileSync(join(iconsDir, 'icon.png'), renderIcon(512, false, 0.78))
writeFileSync(join(iconsDir, 'icon.ico'), encodeIco(icoEntries))

/*
 * 安装器用的资源清单。
 *
 * Tauri 会把前端打进 exe，安装目录里本来没有任何 JSON 文件；但 NSIS 钩子需要一个
 * 「目录是否完整」的判据（主程序 + 清单文件都在才算完整），所以在 bundle.resources
 * 里显式带一份最小 package.json 落到安装根目录，内容只写版本与入口，不泄露依赖信息。
 */
const resourcesDir = join(tauriDir, 'resources')
mkdirSync(resourcesDir, { recursive: true })
const appManifest = {
  name: 'PulseForge',
  version: VERSION,
  entry: 'PulseForge.exe',
  identifier: 'dev.pulseforge.app',
  description: 'PulseForge 桌面版安装清单：由 scripts/build-release.mjs 生成，供安装器做完整性校验。',
}
writeFileSync(join(resourcesDir, 'package.json'), JSON.stringify(appManifest, null, 2) + '\n', 'utf8')

/*
 * 安装目录里的 version.json。
 *
 * 安装器（installer-hooks.nsh）在注册表读不到版本时，会解析这个文件做版本核对；
 * 它同时被 bundle.resources 打进安装根目录。构建哈希取自 dist-pwa/version.json ——
 * 那是本次发布的真实构建，安装器与 PWA 因此共享同一个版本身份。
 */
const pwaVersionDoc = readVersionJson(pwaDir)
const installerVersionDoc = createVersionDocument({
  name: 'PulseForge',
  version: VERSION,
  build: pwaVersionDoc === null ? VERSION : String(pwaVersionDoc.build),
  builtAt: new Date().toISOString(),
})
writeVersionJson(resourcesDir, installerVersionDoc)

// ---------------------------------------------------------------------------
// 4. 一致性检查与报告
// ---------------------------------------------------------------------------

/** 从产物里把版本读回来，确认三端完全一致。 */
function readVersion(file, pattern) {
  const text = readFileSync(file, 'utf8')
  const match = pattern.exec(text)
  return match === null ? null : match[1]
}

const versions = {
  'package.json': VERSION,
  'dist-plugin/package.json': JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version,
  'dist-plugin/cordis.patch.yml': readVersion(join(pluginDir, 'cordis.patch.yml'), /# version: ([^\s]+)/),
  'dist-pwa/sw.js': readVersion(join(pwaDir, 'sw.js'), /const VERSION = '([^']+)'/),
  'dist-pwa/index.html': readVersion(join(pwaDir, 'index.html'), /name="pulseforge-version" content="([^"]+)"/),
  'src-tauri/tauri.conf.json': existsSync(confPath)
    ? JSON.parse(readFileSync(confPath, 'utf8')).version
    : null,
  'src-tauri/Cargo.toml': existsSync(cargoPath)
    ? readVersion(cargoPath, /^version = "([^"]+)"/m)
    : null,
  'src-tauri/resources/package.json': existsSync(join(tauriDir, 'resources', 'package.json'))
    ? JSON.parse(readFileSync(join(tauriDir, 'resources', 'package.json'), 'utf8')).version
    : null,
  'dist-pwa/version.json': existsSync(join(pwaDir, 'version.json'))
    ? String(JSON.parse(readFileSync(join(pwaDir, 'version.json'), 'utf8')).version)
    : null,
  'src-tauri/resources/version.json': existsSync(join(tauriDir, 'resources', 'version.json'))
    ? String(JSON.parse(readFileSync(join(tauriDir, 'resources', 'version.json'), 'utf8')).version)
    : null,
}

let consistent = true
for (const key of Object.keys(versions)) {
  const value = versions[key]
  // sw.js 与 index.html 是「版本+构建哈希」，只比较前缀
  const ok = value !== null && (key.startsWith('dist-pwa/') ? value.startsWith(VERSION) : value === VERSION)
  if (!ok) consistent = false
  log((ok ? '  ✓ ' : '  ✗ ') + key.padEnd(30) + ' ' + String(value))
}

const appJs = readFileSync(join(pwaDir, 'app.js'), 'utf8')
const gzipKb = (gzipSync(Buffer.from(appJs, 'utf8')).length / 1024).toFixed(1)
log('─'.repeat(58))
log('  dist-plugin  ' + ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'package.json', 'locale/'].join('、'))
log('  dist-pwa     ' + ['app.js', 'index.html', 'manifest.json', 'sw.js', 'version.json', '图标 ×3'].join('、') + '（gzip ' + gzipKb + ' KB）')
log('  src-tauri    tauri.conf.json / Cargo.toml / installer-hooks.nsh / resources（package.json + version.json）/ icons（32·64·128·256 + ico）')
log('')

if (!consistent) throw new Error('版本号不一致：请检查上面标 ✗ 的产物')

/**
 * 沙箱里 cargo 往往不可用，这里只做「配置齐不齐」的静态检查，
 * 真正的 `cargo tauri build` 交给 `npm run tauri build`（见 scripts/tauri.mjs）。
 */
const tauriFiles = [
  'tauri.conf.json',
  'Cargo.toml',
  'build.rs',
  'src/main.rs',
  'src/lib.rs',
  'capabilities/default.json',
  'installer-hooks.nsh',
  'resources/package.json',
  'resources/version.json',
]
const missing = tauriFiles.filter(function (file) {
  return !existsSync(join(tauriDir, file))
})
if (missing.length > 0) {
  log('  ⚠ src-tauri 缺少：' + missing.join('、') + '（Tauri 打包会失败）')
} else {
  log('  ✓ src-tauri 配置齐备，可用 `npm run tauri build`（需 Rust 工具链）')
}

// ---------------------------------------------------------------------------
// 5. release/ 分发包
// ---------------------------------------------------------------------------

log('')
log('收集分发包')
try {
  packRelease({ root: root, version: VERSION, log: log })
} catch (error) {
  // 打包失败不影响 dist-*，但要让人看见原因（比如权限或磁盘满）
  log('  ✗ release/ 打包失败：' + (error instanceof Error ? error.message : String(error)))
  throw error
}
log('')
