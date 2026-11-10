/**
 * 产物契约测试：验证 client.js 的载体形状与 index.js 的宿主导出。
 *
 * 这一层不关心业务逻辑，只回答三个问题：
 *  1. client.js 是否以 `window.__ModuleLoader__.load({ id, factory })` 的形式出现；
 *  2. factory(require) 是否只依赖 'react' 并返回 `{ inject, apply }`；
 *  3. index.js 是否导出 name = 'pulseforge' 与 apply 函数。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// --- client.js ------------------------------------------------------------
const clientSource = readFileSync(join(root, 'client.js'), 'utf8')
assert.ok(clientSource.includes('window.__ModuleLoader__.load('), 'client.js 必须以 ModuleLoader.load 开头')
assert.ok(clientSource.includes("id: '@dsh/plugin-pulseforge'"), 'client.js 的 id 必须是包名')
assert.ok(!/^\s*import\s/m.test(clientSource), 'client.js 不得包含 ESM import')

let captured = null
const windowStub = {
  __ModuleLoader__: {
    load: function (module) {
      captured = module
    },
  },
  addEventListener: function () {},
  removeEventListener: function () {},
}
const globalWindow = globalThis.window
globalThis.window = windowStub
// 直接求值：脚本本身只调用 load()，不触碰 DOM
// eslint-disable-next-line no-new-func
new Function('window', clientSource)(windowStub)
globalThis.window = globalWindow

assert.ok(captured !== null, 'client.js 应调用 __ModuleLoader__.load')
assert.equal(captured.id, '@dsh/plugin-pulseforge', '模块 id')
assert.equal(typeof captured.factory, 'function', 'factory 必须是函数')

const requested = []
const ReactStub = {
  createElement: function () {
    return { type: 'div', props: {}, children: [] }
  },
  useRef: function () {
    return { current: null }
  },
  useEffect: function () {},
  useSyncExternalStore: function (_subscribe, getSnapshot) {
    return getSnapshot()
  },
}
const plugin = captured.factory(function (id) {
  requested.push(id)
  if (id === 'react') return ReactStub
  throw new Error('未预期的 require：' + id)
})
assert.deepEqual(requested, ['react'], 'factory 只应 require react')
assert.deepEqual(plugin.inject, ['slots', 'commandUi'], '客户端插件依赖声明')
assert.equal(typeof plugin.apply, 'function', '客户端插件必须有 apply')

// --- index.js ------------------------------------------------------------
const host = await import(pathToFileURL(join(root, 'index.js')).href)
assert.equal(host.name, 'pulseforge', '宿主插件名')
assert.equal(typeof host.apply, 'function', '宿主插件必须有 apply')

// 用一个最小 ctx 验证工具注册与撤销
const registeredTools = []
const disposed = []
const effects = []
const injected = []
const ctx = {
  logger: function () {
    return { info: function () {}, warn: function () {}, error: function () {} }
  },
  // cordis 的服务注入：记录依赖并用同一个 ctx 立即执行作用域回调
  inject: function (deps, callback) {
    injected.push(deps)
    callback(ctx)
    return {}
  },
  effect: function (factory) {
    const disposer = factory()
    effects.push(disposer)
    return function () {
      if (typeof disposer === 'function') disposer()
    }
  },
  tools: {
    register: function (definition) {
      registeredTools.push(definition)
      return function () {
        disposed.push(definition.name)
      }
    },
  },
}
host.apply(ctx)

assert.deepEqual(injected, [['tools']], '宿主半部必须先注入 tools 服务再读取')

assert.equal(registeredTools.length, 1, '应注册一个工具')
const tool = registeredTools[0]
assert.equal(tool.name, 'pulseforge_set_bpm', '工具名')
assert.equal(typeof tool.output, 'object', '工具必须带 output')
assert.equal(typeof tool.output.schema, 'object', 'output.schema 必填')
assert.equal(typeof tool.output.render, 'function', 'output.render 必填')
assert.equal(tool.parameters.type, 'object', '参数是对象 Schema')
assert.deepEqual(tool.parameters.required, ['bpm'], 'bpm 必填')

const ok = await tool.execute({ bpm: 128 })
assert.deepEqual(ok, { ok: true, bpm: 128, clamped: false, note: ok.note }, '合法 BPM 原样返回')
const high = await tool.execute({ bpm: 999 })
assert.equal(high.bpm, 200, '越界夹紧到 200')
assert.equal(high.clamped, true, '标记已夹紧')
const low = await tool.execute({ bpm: 10 })
assert.equal(low.bpm, 60, '下界夹紧到 60')
const nan = await tool.execute({ bpm: 'abc' })
assert.equal(nan.ok, false, '非法输入返回 ok:false')

const blocks = tool.output.render({ bpm: 999 }, high)
assert.equal(blocks.length, 1, 'render 返回一个内容块')
assert.equal(blocks[0].type, 'text', '内容块类型为 text')
assert.ok(blocks[0].text.includes('200'), 'render 文本包含归一化后的 BPM')

// 依赖纯净性：cordis / schemastery 由宿主提供，不能写进 dependencies，
// 否则干净环境执行 npm install 会 `No matching version found for cordis@^4.1.0`。
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const runtimeDeps = Object.keys(manifest.dependencies || {})
assert.equal(runtimeDeps.includes('cordis'), false, 'dependencies 不得包含 cordis')
assert.equal(runtimeDeps.includes('schemastery'), false, 'dependencies 不得包含 schemastery')
assert.equal(runtimeDeps.length, 0, '运行时不应有 npm 依赖（全部由宿主提供）')

const hostSource = readFileSync(join(root, 'index.ts'), 'utf8')
assert.equal(/from\s+'cordis'/.test(hostSource), false, "index.ts 不得从 'cordis' 导入")
assert.equal(/from\s+'schemastery'/.test(hostSource), false, "index.ts 不得从 'schemastery' 导入")
const indexSource = readFileSync(join(root, 'index.js'), 'utf8')
assert.equal(/^\s*import\s[^\n]*from\s+'(?!\.)/m.test(indexSource), false, 'index.js 产物不得有裸模块 import')

effects.forEach(function (disposer) {
  if (typeof disposer === 'function') disposer()
})
assert.deepEqual(disposed, ['pulseforge_set_bpm'], '卸载时撤销工具注册')

console.log('dist ok: client.js 载体、index.js 导出、工具 schema/execute/render/撤销全部通过')
