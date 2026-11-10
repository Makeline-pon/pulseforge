// 发布产物校验：确认 build:release 生成的 dist-plugin 与 dist-pwa 可以直接分发。
//
// 这个测试只读文件，不启动浏览器，也不依赖网络；任何一项失败都意味着
// 某个分发形态在用户机器上会装不上或跑不起来，因此断言尽量贴住关键契约。
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const distPlugin = join(root, 'dist-plugin')
const distPwa = join(root, 'dist-pwa')
const tauri = join(root, 'src-tauri')

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

function gzipKB(path) {
  return gzipSync(readFileSync(path)).length / 1024
}

/** ICO 目录里前 6 字节是保留位+类型+数量，之后每 16 字节一个目录项。 */
function icoCount(buffer) {
  return buffer.readUInt16LE(4)
}

console.log('release：检查双端产物')

check('两个分发目录都已生成', function () {
  assert.ok(existsSync(distPlugin), '缺少 dist-plugin，请先执行 npm run build:release')
  assert.ok(existsSync(distPwa), '缺少 dist-pwa，请先执行 npm run build:release')
})

check('dist-plugin 文件齐全', function () {
  for (const name of ['index.js', 'client.js', 'cordis.patch.yml', 'package.json', 'icon.svg', 'LICENSE']) {
    assert.ok(existsSync(join(distPlugin, name)), 'dist-plugin 缺少 ' + name)
  }
  for (const name of ['en.json', 'zh.json']) {
    assert.ok(existsSync(join(distPlugin, 'locale', name)), 'dist-plugin/locale 缺少 ' + name)
  }
})

check('dist-plugin 不夹带源码与多余文件', function () {
  const entries = readdirSync(distPlugin)
  const allowed = new Set(['index.js', 'client.js', 'cordis.patch.yml', 'package.json', 'icon.svg', 'LICENSE', 'locale', 'README.md'])
  for (const entry of entries) {
    assert.ok(allowed.has(entry), 'dist-plugin 出现预期外的条目：' + entry)
  }
  assert.ok(!entries.some(function (entry) { return entry.endsWith('.ts') }), 'dist-plugin 不应包含 TypeScript 源码')
})

check('dist-plugin 的 package.json 是裁剪版但保留宿主所需字段', function () {
  const dist = JSON.parse(read(join(distPlugin, 'package.json')))
  assert.equal(dist.name, pkg.name)
  assert.equal(dist.version, version)
  assert.equal(dist.type, 'module')
  assert.equal(dist.main, 'index.js')
  assert.equal(dist.exports['.'], './index.js')
  assert.equal(dist.exports['./client'], './client.js')
  assert.equal(dist.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(dist.dsh.client.platform, 'web')
  assert.deepEqual(dist.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-conversation'])
  assert.ok(dist.peerDependencies && dist.peerDependencies.react, '必须声明 react peer 依赖')
  assert.ok(!dist.scripts, '裁剪版不应带脚本')
})

check('dist-plugin/client.js 是 ModuleLoader 的 CJS 工厂', function () {
  const source = read(join(distPlugin, 'client.js'))
  assert.match(source, /window\.__ModuleLoader__\.load\(/)
  assert.ok(source.includes("id: '@dsh/plugin-pulseforge'"), 'id 必须是包名')
  assert.ok(!/^\s*import\s/m.test(source), '不允许出现裸 ESM import')
  assert.ok(source.includes('createPulseForge'), '工厂函数应被导出')
  assert.ok(source.includes('ctx.slots.inject'), '应通过 slots 注入 UI')
})

check('dist-plugin/index.js 是宿主半部且注入 tools', function () {
  const source = read(join(distPlugin, 'index.js'))
  assert.ok(source.includes("name = 'pulseforge'"), '应导出 name = pulseforge')
  assert.ok(/export function apply/.test(source), '应导出 apply')
  assert.ok(source.includes('pulseforge_set_bpm'), '应注册 pulseforge_set_bpm 工具')
  assert.ok(source.includes("inject"), '读取 ctx.tools 前必须先 inject')
})

check('cordis.patch.yml 的版本与包名一致', function () {
  const yml = read(join(distPlugin, 'cordis.patch.yml'))
  assert.ok(yml.includes('# version: ' + version), '补丁文件应记录当前版本')
  assert.ok(yml.includes('- id: pulseforge'))
  assert.ok(yml.includes("name: '@dsh/plugin-pulseforge'"))
})

check('dist-pwa 文件齐全', function () {
  for (const name of ['app.js', 'index.html', 'manifest.json', 'sw.js', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
    assert.ok(existsSync(join(distPwa, name)), 'dist-pwa 缺少 ' + name)
  }
})

check('dist-pwa/app.js 是自包含 IIFE 且体积达标', function () {
  const source = read(join(distPwa, 'app.js'))
  assert.ok(!source.includes('window.__ModuleLoader__.load('), 'PWA 产物不应依赖 DSH 模块加载器（注释里提到可以）')
  assert.ok(source.includes('createReactLite'), '应内联 react-lite 运行时')
  assert.ok(source.includes('bootPwa'), '应包含 PWA 启动入口')
  assert.ok(!/^\s*(import|export)\s/m.test(source), '不允许出现裸 ESM 语句')
  const kb = gzipKB(join(distPwa, 'app.js'))
  console.log('    app.js gzip ' + kb.toFixed(1) + ' KB')
  assert.ok(kb < 500, 'gzip 后必须小于 500KB，实际 ' + kb.toFixed(1) + ' KB')
})

check('service worker 注入了版本与构建哈希', function () {
  const source = read(join(distPwa, 'sw.js'))
  assert.ok(!source.includes('__PF_VERSION__'), '版本占位符必须被替换')
  const match = source.match(/const VERSION = '([^']+)'/)
  assert.ok(match, 'sw.js 应声明 VERSION 常量')
  assert.ok(match[1].startsWith(version + '+'), 'VERSION 必须以 package.json 版本开头，实际 ' + match[1])
  assert.match(match[1], /^\d+\.\d+\.\d+\+[0-9a-f]{10}$/, 'VERSION 应为 版本+10 位哈希')
  assert.match(source, /const CACHE = 'pulseforge-v' \+ VERSION/)
  for (const asset of ['./app.js', './manifest.json', './icon-192.png', './icon-maskable-512.png']) {
    assert.ok(source.includes("'" + asset + "'"), '预缓存清单缺少 ' + asset)
  }
  assert.ok(source.includes('fonts.gstatic.com'), '字体应走独立缓存')
})

check('index.html 声明清单、版本与入口', function () {
  const html = read(join(distPwa, 'index.html'))
  assert.ok(html.includes('id="pf-root"'), '缺少挂载点')
  assert.ok(html.includes('rel="manifest"'))
  assert.ok(html.includes('src="./app.js"'))
  assert.ok(html.includes('theme-color'))
  const meta = html.match(/name="pulseforge-version" content="([^"]+)"/)
  assert.ok(meta, '应写入版本 meta')
  assert.ok(meta[1].startsWith(version + '+'), 'meta 版本应与 sw 一致，实际 ' + meta[1])
})

check('manifest.json 符合可安装 PWA 要求', function () {
  const manifest = JSON.parse(read(join(distPwa, 'manifest.json')))
  assert.equal(manifest.name, 'PulseForge')
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.theme_color, '#ff8c2b')
  assert.equal(manifest.start_url, './')
  assert.ok(manifest.icons.length >= 4, '至少 192 / 512 / maskable / svg 四个图标')
  assert.ok(manifest.icons.some(function (icon) { return icon.sizes === '512x512' && icon.purpose === 'maskable' }))
  for (const icon of manifest.icons) {
    assert.ok(existsSync(join(distPwa, icon.src.replace(/^\.\//, ''))), '图标不存在：' + icon.src)
  }
})

check('PNG 图标是合法的 8bit RGBA', function () {
  const buffer = readFileSync(join(distPwa, 'icon-512.png'))
  assert.deepEqual([...buffer.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG 签名不对')
  assert.equal(buffer.readUInt32BE(16), 512)
  assert.equal(buffer.readUInt32BE(20), 512)
  assert.equal(buffer[24], 8, '位深必须是 8')
  assert.equal(buffer[25], 6, '颜色类型必须是 RGBA')
})

check('tauri.conf.json 指向 dist-pwa 且版本一致', function () {
  const conf = JSON.parse(read(join(tauri, 'tauri.conf.json')))
  assert.equal(conf.productName, 'PulseForge')
  assert.equal(conf.version, version, 'tauri.conf.json 版本必须与 package.json 一致')
  assert.equal(conf.identifier, 'dev.pulseforge.app')
  assert.equal(conf.build.frontendDist, '../dist-pwa')
  assert.equal(conf.build.beforeBuildCommand, 'npm run build:release')
  assert.equal(conf.app.windows[0].minWidth, 1024)
  assert.equal(conf.app.windows[0].minHeight, 640)
  assert.ok(conf.app.windows[0].additionalBrowserArgs.includes('autoplay-policy'), '需要放开自动播放策略')
  assert.ok(conf.bundle.targets.includes('nsis'))
  assert.equal(conf.bundle.windows.webviewInstallMode.type, 'downloadBootstrapper')
})

check('Tauri 图标与配置声明的路径一致', function () {
  const conf = JSON.parse(read(join(tauri, 'tauri.conf.json')))
  assert.ok(conf.bundle.icon.length >= 4, '至少声明 32/128/128@2x/ico')
  for (const icon of conf.bundle.icon) {
    assert.ok(existsSync(join(tauri, icon)), 'tauri 图标缺失：' + icon)
  }
  const ico = readFileSync(join(tauri, 'icons', 'icon.ico'))
  assert.equal(ico.readUInt16LE(2), 1, 'ICO 类型必须是 1（图标）')
  const count = icoCount(ico)
  assert.equal(count, 4, 'ico 应打包 32/64/128/256 四个尺寸，实际 ' + count)
  const firstOffset = ico.readUInt32LE(6 + 12)
  assert.deepEqual([...ico.subarray(firstOffset, firstOffset + 4)], [0x89, 0x50, 0x4e, 0x47], 'ICO 内嵌的应是 PNG')
})

check('Cargo 清单版本一致且启用了 tauri-build', function () {
  const cargo = read(join(tauri, 'Cargo.toml'))
  assert.match(cargo, new RegExp('^version = "' + version.replace(/\./g, '\\.') + '"', 'm'))
  assert.match(cargo, /^name = "pulseforge"$/m)
  assert.match(cargo, /tauri-build/)
  assert.match(cargo, /^tauri = \{ version = "2"/m)
  assert.match(cargo, /panic = "abort"/)
})

check('Tauri 入口与权限配置可用', function () {
  const main = read(join(tauri, 'src', 'main.rs'))
  assert.ok(main.includes('windows_subsystem = "windows"'), '发布版不应弹出控制台窗口')
  assert.ok(main.includes('pulseforge_lib::run()'))
  const lib = read(join(tauri, 'src', 'lib.rs'))
  assert.ok(lib.includes('generate_context!()'))
  assert.ok(lib.includes('get_webview_window("main")'))
  const capabilities = JSON.parse(read(join(tauri, 'capabilities', 'default.json')))
  assert.deepEqual(capabilities.windows, ['main'])
  assert.ok(capabilities.permissions.includes('core:default'))
})

check('发布脚本与 npm 命令接线正确', function () {
  assert.equal(pkg.scripts['build:release'], 'node scripts/build-release.mjs')
  assert.equal(pkg.scripts.tauri, 'node scripts/tauri.mjs')
  assert.equal(pkg.scripts['test:release'], 'node scripts/build-release.mjs --silent && node tests/release.test.mjs')
  assert.ok(pkg.scripts['test:all'].includes('npm run test:release'), 'test:all 应包含发布校验')
  for (const file of ['scripts/build-release.mjs', 'scripts/tauri.mjs', 'scripts/lib/icons.mjs']) {
    assert.ok(existsSync(join(root, file)), '缺少脚本 ' + file)
  }
})

check('dist-plugin 的 client.js 与根目录构建产物一致', function () {
  const a = read(join(root, 'client.js'))
  const b = read(join(distPlugin, 'client.js'))
  assert.equal(a, b, 'dist-plugin/client.js 应与最近一次 node build.mjs 的结果相同')
  assert.ok(statSync(join(distPlugin, 'client.js')).size > 0)
})

/**
 * 读取 ZIP 的中央目录，返回条目名列表。
 *
 * 这里不复用 scripts/lib/zip.mjs：测试要独立验证「写出来的字节能不能被读回」，
 * 用同一份代码读写会掩盖偏移量算错这类 bug。
 */
function listZipEntries(path) {
  const buffer = readFileSync(path)
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(eocd > 0, '找不到 ZIP 结束记录（EOCD）')
  const count = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const names = []
  for (let i = 0; i < count; i += 1) {
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    names.push(buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'))
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return names
}

const releaseDir = join(root, 'release')
const sourceZip = join(releaseDir, 'PulseForge-v' + version + '-source.zip')

check('release/ 生成了源码包与校验清单', function () {
  assert.ok(existsSync(sourceZip), '缺少 release/PulseForge-v' + version + '-source.zip')
  assert.ok(existsSync(join(releaseDir, 'SHA256SUMS.txt')), '缺少 SHA256SUMS.txt')
  assert.ok(existsSync(join(releaseDir, 'release-manifest.json')), '缺少 release-manifest.json')
  const manifest = JSON.parse(read(join(releaseDir, 'release-manifest.json')))
  assert.equal(manifest.version, version)
  assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 1)
  for (const file of manifest.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/, file.name + ' 的 sha256 格式不对')
  }
  const sums = read(join(releaseDir, 'SHA256SUMS.txt'))
  assert.match(sums, /^[0-9a-f]{64} {2}PulseForge-v[\d.]+-source\.zip$/m)
})

check('源码包排除依赖与构建产物、保留工程文件', function () {
  const names = listZipEntries(sourceZip)
  assert.ok(names.includes('package.json'))
  assert.ok(names.includes('README.md'))
  assert.ok(names.includes('LICENSE'))
  assert.ok(names.includes('src/client/10-core.ts'), '源码包必须带核心分片')
  assert.ok(names.includes('src-tauri/installer-hooks.nsh'), '源码包必须带安装向导钩子')
  assert.ok(names.includes('.github/workflows/release.yml'), '源码包应带发布流水线，方便他人复现')
  for (const banned of ['node_modules/', 'dist-plugin/', 'dist-pwa/', 'release/', 'pwa/', 'src-tauri/target/']) {
    assert.equal(
      names.some((name) => name.startsWith(banned)),
      false,
      '源码包不应包含 ' + banned,
    )
  }
  assert.ok(
    names.some((name) => name.startsWith('src/pwa/')),
    'src/pwa 是 PWA 源码，必须保留（只有根目录的 pwa/ 产物要排除）',
  )
})

check('GitHub Actions 发布流覆盖测试、构建与发布', function () {
  const workflow = read(join(root, '.github', 'workflows', 'release.yml'))
  assert.match(workflow, /tags:\s*\n\s*- 'v\*'/, '应由 v* 标签触发')
  assert.match(workflow, /runs-on: windows-latest/)
  assert.match(workflow, /npm run test:all/, '发布前必须跑测试')
  assert.match(workflow, /npm run build:release/)
  assert.match(workflow, /dtolnay\/rust-toolchain/)
  assert.match(workflow, /npm run tauri build/)
  assert.match(workflow, /npm run release:pack -- --require-installer/, '没有安装器时应当失败而不是发半个版本')
  assert.match(workflow, /softprops\/action-gh-release/, '需要自动创建 Release')
  assert.match(workflow, /files: release\/\*/)
  assert.match(workflow, /contents: write/, '创建 Release 需要写权限')
})

check('仓库忽略规则排除构建产物', function () {
  const ignore = read(join(root, '.gitignore'))
  for (const rule of ['node_modules/', 'dist-plugin/', 'dist-pwa/', 'release/', 'pwa/', 'src-tauri/target/']) {
    assert.ok(ignore.includes(rule), '.gitignore 缺少 ' + rule)
  }
})

check('README 具备开源项目门面要素', function () {
  const readme = read(join(root, 'README.md'))
  assert.match(readme, /^# PulseForge/m)
  assert.ok(readme.includes('Releases'), '需要指向 GitHub Releases 的下载指引')
  assert.ok(readme.includes('快捷键指南'))
  assert.ok(readme.includes('npm run build:release'))
  assert.ok(readme.includes('MIT'))
  assert.ok(readme.includes('PulseForge-Setup-v'), '需要写清安装包文件名')
  assert.ok(readme.includes('installer-hooks.nsh'), '需要指出安装向导钩子位置')
})

console.log('release ok：' + passed + ' 组校验通过（插件 / PWA / Tauri / 版本联动）')
