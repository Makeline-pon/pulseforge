/**
 * 构建脚本：把 TypeScript 分片转成宿主可加载的两种产物。
 *
 * 本机没有可用的 typescript / esbuild（npm registry 不可达），因此改用 Node 内置的
 * `module.stripTypeScriptTypes({ mode: 'strip' })` 做类型擦除：它只删类型、不改语法，
 * 所以源码里不能出现 JSX、enum、namespace 等需要「转译」而非「擦除」的语法，
 * 这也是全套客户端代码统一使用 `h()` 而不是 JSX 的原因。
 *
 * 产物：
 *  - client.js：CJS 工厂函数（window.__ModuleLoader__.load({ id, factory })）
 *  - index.js ：ESM 宿主半部
 *
 * 用法：`node build.mjs [输出目录]`
 *  - 省略时写到仓库根（开发时被 profile 里的 link 直接使用）
 *  - `scripts/build-release.mjs` 会传 `dist-plugin`，让发布产物与开发产物分离
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, relative } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientDir = join(here, 'src', 'client')
const outDir = process.argv[2] === undefined ? here : resolve(process.argv[2])
mkdirSync(outDir, { recursive: true })

/** 拼接顺序即依赖顺序；types.d.ts 只参与类型检查，不参与构建。 */
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
  '99-entry.ts',
]

const PACKAGE_NAME = '@dsh/plugin-pulseforge'

/** 擦除类型；失败时把文件名带进错误信息，便于定位分片。 */
function stripFragment(file) {
  const source = readFileSync(join(clientDir, file), 'utf8')
  try {
    return stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: file })
  } catch (error) {
    throw new Error('擦除类型失败：' + file + '\n' + (error && error.message ? error.message : String(error)))
  }
}

const clientBody = FRAGMENTS.map(stripFragment).join('\n')

const clientBundle = `/**
 * PulseForge 客户端产物（由 build.mjs 从 src/client/*.ts 生成，请勿手改）。
 * 载体为 DSH ModuleLoader 的 CJS 工厂函数格式。
 */
window.__ModuleLoader__.load({
  id: '${PACKAGE_NAME}',
  factory: function (require) {
    const React = require('react')
    const h = React.createElement
${indent(clientBody, 4)}
    return createPulseForge()
  },
})
`

writeFileSync(join(outDir, 'client.js'), clientBundle, 'utf8')
report('client.js', clientBundle)

if (existsSync(join(here, 'index.ts'))) {
  const hostSource = readFileSync(join(here, 'index.ts'), 'utf8')
  const hostJs = stripTypeScriptTypes(hostSource, { mode: 'strip', sourceUrl: 'index.ts' })
  writeFileSync(join(outDir, 'index.js'), hostJs, 'utf8')
  report('index.js', hostJs)
}

/** 打印体积（同时给出 gzip，验收要求是 gzip < 500KB）。 */
function report(name, text) {
  const raw = Buffer.byteLength(text, 'utf8')
  const gz = gzipSync(Buffer.from(text, 'utf8')).length
  const target = outDir === here ? name : relative(here, join(outDir, name)).replace(/\\/g, '/')
  console.log(target.padEnd(24) + ' raw ' + (raw / 1024).toFixed(1) + ' KB  gzip ' + (gz / 1024).toFixed(1) + ' KB')
}

/** 给整段代码统一缩进，保留首行空行结构。 */
function indent(text, spaces) {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map(function (line) {
      return line.length > 0 ? pad + line : line
    })
    .join('\n')
}
