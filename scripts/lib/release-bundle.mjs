/**
 * 生成可分发的 `release/` 目录。
 *
 * 这里只做「收集与打包」，不重新编译：
 *   - `PulseForge-Setup-v<ver>.exe`  从 Tauri 的 NSIS 产物复制过来（没有就跳过并提示）；
 *   - `PulseForge-v<ver>-source.zip` 源码包，排除 node_modules、.git、dist-plugin、dist-pwa、release、target 等；
 *   - `SHA256SUMS.txt` 两个附件的校验和，内测同学下载后可以核对；
 *   - `release-manifest.json` 机器可读的清单（文件名、大小、sha256、是否包含安装器）。
 *
 * 被 `scripts/build-release.mjs` 与 CI 共同调用：CI 先 `npm run build:release` + `npm run tauri build`，
 * 再 `npm run release:pack`，这样安装器已经存在，两个附件都会齐全。
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, resolve } from 'node:path'
import { createZip } from './zip.mjs'

/**
 * 源码包排除规则。
 *
 * 只按「相对仓库根的路径」精确匹配：`pwa` 目录要排除，但 `src/pwa`（自带 React 子集的实现）
 * 必须保留；`target` 只在 `src-tauri/target` 这一层排除（Rust 构建缓存可能几十 GB）。
 */
const EXCLUDED_TOP_DIRS = new Set(['node_modules', '.git', 'dist-plugin', 'dist-pwa', 'release', 'pwa'])

const EXCLUDED_FILES = new Set(['server.log', 'server.err', '.DS_Store', 'Thumbs.db'])

const EXCLUDED_EXT = ['.log', '.tmp', '.tsbuildinfo']

/** 汇总目录下所有要打进的源码文件（相对路径，正斜杠）。 */
function collectSources(root, dir, base, out) {
  const absolute = join(root, dir)
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relativePath = base === '' ? entry.name : base + '/' + entry.name
    if (entry.isDirectory()) {
      if (base === '' && EXCLUDED_TOP_DIRS.has(entry.name)) continue
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      if (relativePath === 'src-tauri/target') continue
      collectSources(root, join(dir, entry.name), relativePath, out)
      continue
    }
    if (!entry.isFile()) continue
    if (EXCLUDED_FILES.has(entry.name)) continue
    if (EXCLUDED_EXT.some((ext) => entry.name.endsWith(ext))) continue
    out.push(relativePath)
  }
  return out
}

/** 在 Tauri 的产物目录里找安装器（NSIS 优先，其次 MSI）。 */
function findInstaller(root) {
  const candidates = [
    join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis'),
    join(root, 'src-tauri', 'target', 'release', 'bundle', 'msi'),
  ]
  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    const files = readdirSync(dir).filter((name) => /\.(exe|msi)$/i.test(name))
    if (files.length > 0) {
      // setup.exe 比裸 exe 更合适；按名字排序保证可重复
      files.sort((a, b) => (b.includes('setup') ? 1 : 0) - (a.includes('setup') ? 1 : 0))
      return join(dir, files[0])
    }
  }
  return null
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return Math.max(1, Math.round(bytes / 1024)) + ' KB'
}

/**
 * 打包 release/ 目录。
 *
 * @param {{ root: string, version: string, log?: (line: string) => void, requireInstaller?: boolean }} options
 * @returns {{ dir: string, files: Array<{ name: string, size: number, sha256: string }>, installer: boolean }}
 */
export function packRelease(options) {
  const root = options.root
  const version = options.version
  const log = options.log || function () {}
  const releaseDir = join(root, 'release')

  const target = resolve(releaseDir)
  if (target !== resolve(root, 'release')) throw new Error('拒绝清理非 release 目录：' + target)
  rmSync(releaseDir, { recursive: true, force: true })
  mkdirSync(releaseDir, { recursive: true })

  const files = []

  // 1) 安装器：有就放进来，没有就明确提示（本地通常没装 Rust 工具链）
  const installer = findInstaller(root)
  const installerExt = installer === null ? '.exe' : installer.slice(installer.lastIndexOf('.')).toLowerCase()
  const installerName = 'PulseForge-Setup-v' + version + installerExt
  if (installer !== null) {
    copyFileSync(installer, join(releaseDir, installerName))
    const buffer = readFileSync(join(releaseDir, installerName))
    files.push({ name: installerName, size: buffer.length, sha256: sha256(buffer) })
    log('  ✓ ' + installerName + '  ' + formatSize(buffer.length) + '（来自 ' + relative(root, installer) + '）')
  } else if (options.requireInstaller === true) {
    throw new Error(
      'release/ 需要安装器，但 src-tauri/target/release/bundle 下没有找到 .exe。' +
        '请先执行 npm run tauri build（需要 Rust 工具链）。',
    )
  } else {
    log('  ⚠ 未找到安装器，release/ 只包含源码包；CI 会在 tauri build 之后重新打包')
  }

  // 2) 源码包
  const sourceName = 'PulseForge-v' + version + '-source.zip'
  const entries = collectSources(root, '.', '', [])
  // 固定时间戳，保证同一份源码两次打包得到相同字节（便于核对）
  const buildDate = new Date('2026-01-01T00:00:00Z')
  const zip = createZip(
    entries
      .sort()
      .map(function (path) {
        return { name: path, data: readFileSync(join(root, path)) }
      }),
    { date: buildDate },
  )
  writeFileSync(join(releaseDir, sourceName), zip)
  files.push({ name: sourceName, size: zip.length, sha256: sha256(zip) })
  log('  ✓ ' + sourceName + '  ' + formatSize(zip.length) + '（' + entries.length + ' 个文件）')

  // 3) 校验和与清单
  const sums = files.map((file) => file.sha256 + '  ' + file.name).join('\n') + '\n'
  writeFileSync(join(releaseDir, 'SHA256SUMS.txt'), sums, 'utf8')
  writeFileSync(
    join(releaseDir, 'release-manifest.json'),
    JSON.stringify(
      {
        name: 'PulseForge',
        version: version,
        generatedAt: new Date().toISOString(),
        installerIncluded: installer !== null,
        files: files,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )

  log('')
  log('  release/   ' + files.map((file) => file.name).join('、') + '（另含 SHA256SUMS.txt、release-manifest.json）')

  return { dir: releaseDir, files: files, installer: installer !== null }
}
