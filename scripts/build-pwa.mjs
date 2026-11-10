/**
 * PWA 构建脚本：把 `src/client/10-core.ts` ~ `95-window.ts` 加上 `web-entry.ts`
 * 与自带的 `react-lite` 运行时，打成一个自包含的 `app.js`。
 *
 * 与 `build.mjs` 的关系：两者共用同一批源码分片，但载体不同 ——
 *  - `build.mjs`     → DSH ModuleLoader 的 CJS 工厂（需要宿主注入 React）
 *  - `build-pwa.mjs` → 浏览器 `<script>` 直接执行的 IIFE（React 用内置 react-lite）
 *
 * 用法：`node scripts/build-pwa.mjs [输出目录]`
 *  - 省略输出目录时写到仓库根下的 `pwa/`（开发预览用）
 *  - `build-release.mjs` 会传 `dist-pwa`，避免开发目录与发布产物互相覆盖
 *
 * 同时产出：
 *  - `index.html` / `manifest.json` / `sw.js`（写入版本与内容哈希）
 *  - `version.json`（版本清单：运行时轮询它判断服务器上有没有新版本）
 *  - `icon-192.png` / `icon-512.png` / `icon-maskable-512.png` / `icon.svg`
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, relative } from 'node:path'
import { renderIcon } from './lib/icons.mjs'
import { createVersionDocument, writeVersionJson } from './lib/version-json.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const clientDir = join(root, 'src', 'client')
const pwaSrcDir = join(root, 'src', 'pwa')
const outDir = process.argv[2] === undefined ? join(root, 'pwa') : resolve(process.argv[2])

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** PWA 不包含 99-entry（那是 Cordis 入口），其余顺序与 DSH 构建一致。 */
const FRAGMENTS = [
  '10-core.ts',
  '20-store.ts',
  '30-idb.ts',
  '40-audio.ts',
  '50-export.ts',
  '60-icons.ts',
  '70-controls.ts',
  '80-sequencer.ts',
  '85-pianoroll.ts',
  '90-fx.ts',
  '95-window.ts',
  'web-entry.ts',
]

function strip(source, label) {
  try {
    return stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: label })
  } catch (error) {
    throw new Error('擦除类型失败：' + label + '\n' + (error && error.message ? error.message : String(error)))
  }
}

function stripFile(dir, file) {
  return strip(readFileSync(join(dir, file), 'utf8'), file)
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map(function (line) {
      return line.length > 0 ? pad + line : line
    })
    .join('\n')
}

// ---------------------------------------------------------------------------
// 1. 组装 app.js
// ---------------------------------------------------------------------------

const reactLite = stripFile(pwaSrcDir, 'react-lite.ts')
const clientBody = FRAGMENTS.map((file) => stripFile(clientDir, file)).join('\n')

const appJs = `/**
 * PulseForge PWA 产物（由 scripts/build-pwa.mjs 生成，请勿手改）。
 * 版本：${pkg.version}
 * 运行时：内置 react-lite（无外部依赖，可离线运行）。
 */
(function () {
  'use strict'
${indent(reactLite, 2)}
  const React = createReactLite()
  const h = React.createElement
${indent(clientBody, 2)}
})()
`

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'app.js'), appJs, 'utf8')

const buildHash = createHash('sha256').update(appJs).digest('hex').slice(0, 10)
const version = pkg.version + '+' + buildHash

// ---------------------------------------------------------------------------
// 2. 静态外壳（写入版本 / 构建哈希）
// ---------------------------------------------------------------------------

function writeTemplate(sourceName, targetName, replacements) {
  let text = readFileSync(join(pwaSrcDir, sourceName), 'utf8')
  for (const key of Object.keys(replacements)) {
    text = text.split(key).join(replacements[key])
  }
  writeFileSync(join(outDir, targetName), text, 'utf8')
}

writeTemplate('index.html', 'index.html', { __PF_VERSION__: version })
writeTemplate('manifest.json', 'manifest.json', {})
writeTemplate('sw.js', 'sw.js', { __PF_VERSION__: version, __PF_BUILD__: buildHash })
copyFileSync(join(root, 'icon.svg'), join(outDir, 'icon.svg'))

// ---------------------------------------------------------------------------
// 3. version.json —— 运行时热更新比对用
// ---------------------------------------------------------------------------

/*
 * 这个文件必须**单独存在**且不被 Service Worker 缓存：
 * 页面靠它判断「服务器上的版本是不是比本地新」，一旦被缓存就永远比不出新版本。
 * 对应地，sw.js 里对 `version.json` 的请求走 network-only。
 */
const versionDocument = createVersionDocument({
  name: 'PulseForge',
  version: pkg.version,
  build: buildHash,
  builtAt: new Date().toISOString(),
})
writeVersionJson(outDir, versionDocument)

// ---------------------------------------------------------------------------
// 3. 图标（纯手写 PNG：SDF 光栅化 + zlib）
// ---------------------------------------------------------------------------

writeFileSync(join(outDir, 'icon-192.png'), renderIcon(192, true, 0.82))
writeFileSync(join(outDir, 'icon-512.png'), renderIcon(512, true, 0.82))
writeFileSync(join(outDir, 'icon-maskable-512.png'), renderIcon(512, false, 0.66))

// ---------------------------------------------------------------------------
// 4. 报告
// ---------------------------------------------------------------------------

const rawBytes = Buffer.byteLength(appJs, 'utf8')
const gzipBytes = gzipSync(Buffer.from(appJs, 'utf8')).length
const label = relative(root, join(outDir, 'app.js')).replace(/\\/g, '/')
console.log(label.padEnd(24) + ' raw ' + (rawBytes / 1024).toFixed(1) + ' KB  gzip ' + (gzipBytes / 1024).toFixed(1) + ' KB')
console.log('version'.padEnd(24) + ' ' + version)
console.log('version.json'.padEnd(24) + ' ' + versionDocument.id)
console.log('icons'.padEnd(24) + ' 192 / 512 / maskable-512')

if (!existsSync(join(outDir, 'app.js'))) {
  throw new Error('PWA 产物缺失：' + join(outDir, 'app.js'))
}
