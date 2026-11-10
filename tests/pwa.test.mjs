/**
 * PWA 测试：两件事分开验证。
 *
 * 1. 运行时语义：用极简 DOM 垫片直接跑 `src/pwa/react-lite.ts`，确认
 *    状态更新、节点复用、effect 生命周期、事件映射与外部 store 订阅都正确。
 *    （这是 PWA 里唯一没有宿主兜底的部分，必须单测。）
 * 2. 构建产物：`pwa/` 下的 HTML / manifest / service worker / PNG 图标是否自洽，
 *    以及 app.js 是否真的「零外部依赖、无 ModuleLoader 痕迹」。
 */

import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pwaDir = join(root, 'pwa')

// ---------------------------------------------------------------------------
// DOM 垫片
// ---------------------------------------------------------------------------

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType
    this.childNodes = []
    this.parentNode = null
  }

  get firstChild() {
    return this.childNodes.length === 0 ? null : this.childNodes[0]
  }

  get lastChild() {
    return this.childNodes.length === 0 ? null : this.childNodes[this.childNodes.length - 1]
  }
}

class FakeText extends FakeNode {
  constructor(data) {
    super(3)
    this.data = data
  }

  get textContent() {
    return this.data
  }
}

class FakeElement extends FakeNode {
  constructor(tag, namespace) {
    super(1)
    this.tagName = tag.toUpperCase()
    this.namespaceURI = namespace ?? null
    this.attributes = {}
    this.listeners = new Map()
    this.style = {
      props: {},
      setProperty: function (name, value) {
        this.props[name] = value
      },
      removeProperty: function (name) {
        delete this.props[name]
      },
    }
    this.value = ''
    this.checked = false
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }

  removeAttribute(name) {
    delete this.attributes[name]
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(handler)
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type)
    if (list === undefined) return
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  }

  /** 测试专用：模拟浏览器派发事件。 */
  dispatch(type, event) {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }

  appendChild(node) {
    return this.insertBefore(node, null)
  }

  insertBefore(node, reference) {
    if (node.parentNode !== null) node.parentNode.removeChild(node)
    const index = reference === null ? this.childNodes.length : this.childNodes.indexOf(reference)
    this.childNodes.splice(index, 0, node)
    node.parentNode = this
    return node
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node)
    if (index >= 0) this.childNodes.splice(index, 1)
    node.parentNode = null
    return node
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join('')
  }

  focus() {
    this.focused = true
  }
}

const fakeDocument = {
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (namespace, tag) => new FakeElement(tag, namespace),
  createTextNode: (data) => new FakeText(data),
  getElementById: () => null,
  head: new FakeElement('head'),
  body: new FakeElement('body'),
}

const liteSource = stripTypeScriptTypes(readFileSync(join(root, 'src', 'pwa', 'react-lite.ts'), 'utf8'), {
  mode: 'strip',
  sourceUrl: 'react-lite.ts',
})
const createReactLite = new Function('document', 'queueMicrotask', liteSource + '\nreturn createReactLite')(
  fakeDocument,
  queueMicrotask,
)

const React = createReactLite()
const h = React.createElement

/** 等一次微任务，让合并后的重渲染跑完。 */
function tick() {
  return new Promise((resolve) => queueMicrotask(resolve))
}

async function settle() {
  await tick()
  await tick()
}

const container = new FakeElement('div')
const mountRoot = React.createRoot(container)

// --- 1. 基本渲染 ------------------------------------------------------------
mountRoot.render(h('div', { className: 'shell' }, h('span', null, 'hi'), ' tail'))
assert.equal(container.childNodes.length, 1, '根节点应只有一个子元素')
const shell = container.childNodes[0]
assert.equal(shell.getAttribute('class'), 'shell', 'className 应写入 class 属性')
assert.equal(shell.childNodes.length, 2, '应渲染 span 与文本两个子节点')
assert.equal(shell.textContent, 'hi tail', '文本子节点顺序应正确')
assert.equal(createReactLite().version, 'pulseforge-lite-1', '运行时版本标识')

// --- 2. 状态更新与 DOM 复用 -------------------------------------------------
let setCount = null
function Counter() {
  const pair = React.useState(0)
  setCount = pair[1]
  return h('div', { className: 'counter' }, h('b', null, String(pair[0])))
}
mountRoot.render(h(Counter))
const counterOuter = container.childNodes[0]
const counterInner = counterOuter.firstChild
assert.equal(counterInner.textContent, '0')

setCount(1)
setCount(2)
await settle()
assert.equal(container.childNodes[0], counterOuter, '重渲染应复用外层 DOM 节点')
assert.equal(container.childNodes[0].firstChild, counterInner, '重渲染应复用内层 DOM 节点')
assert.equal(counterInner.textContent, '2', '连续 setState 合并后取最后一次值')
assert.equal(container.childNodes[0].childNodes.length, 1, '重渲染不能重复插入节点')

// 函数式更新
setCount(function (previous) {
  return previous + 40
})
await settle()
assert.equal(counterInner.textContent, '42', 'setState 应支持函数式更新')

// --- 3. effect 生命周期 -----------------------------------------------------
let effectRuns = 0
let effectCleanups = 0
function WithEffect() {
  React.useEffect(
    function () {
      effectRuns += 1
      return function () {
        effectCleanups += 1
      }
    },
    [7],
  )
  return h('i', null, 'e')
}
mountRoot.render(h(WithEffect))
await settle()
assert.equal(effectRuns, 1, 'effect 首次渲染后执行一次')
mountRoot.render(h(WithEffect))
await settle()
assert.equal(effectRuns, 1, 'deps 不变时 effect 不应重复执行')
mountRoot.render(h('div', null, 'gone'))
await settle()
assert.equal(effectCleanups, 1, '组件被替换时应执行 cleanup')

// --- 4. 事件映射 ------------------------------------------------------------
let clicks = 0
let typed = ''
mountRoot.render(
  h(
    'div',
    null,
    h('button', { 'aria-label': 'click me', onClick: function () { clicks += 1 } }, 'go'),
    h('input', { 'aria-label': 'text', onChange: function (event) { typed = event.target.value } }),
  ),
)
const button = container.firstChild.childNodes[0]
const input = container.firstChild.childNodes[1]
button.dispatch('click', {})
assert.equal(clicks, 1, 'onClick 应绑定到 click')
assert.equal(button.getAttribute('aria-label'), 'click me', 'aria 属性应写入')
input.value = 'abc'
input.dispatch('input', { target: input })
assert.equal(typed, 'abc', 'onChange 应映射到 input 事件')
assert.equal(input.listeners.has('input'), true)

// --- 5. useSyncExternalStore ------------------------------------------------
let externalValue = 0
const externalListeners = new Set()
function ExternalView() {
  const value = React.useSyncExternalStore(
    function (listener) {
      externalListeners.add(listener)
      return function () {
        externalListeners.delete(listener)
      }
    },
    function () {
      return externalValue
    },
  )
  return h('em', null, String(value))
}
mountRoot.render(h(ExternalView))
assert.equal(externalListeners.size, 1, '外部 store 应被订阅一次')
assert.equal(container.firstChild.textContent, '0')
externalValue = 5
for (const listener of Array.from(externalListeners)) listener()
await settle()
assert.equal(container.firstChild.textContent, '5', '外部 store 变化应触发重渲染')
mountRoot.render(h('div', null, 'unmounted'))
await settle()
assert.equal(externalListeners.size, 0, '组件卸载时应退订外部 store')

// --- 6. 卸载 -----------------------------------------------------------------
mountRoot.unmount()
assert.equal(container.childNodes.length, 0, 'unmount 后容器应为空')

// ---------------------------------------------------------------------------
// 构建产物
// ---------------------------------------------------------------------------

const html = readFileSync(join(pwaDir, 'index.html'), 'utf8')
assert.match(html, /id="pf-root"/, 'index.html 需要 #pf-root 容器')
assert.match(html, /src="\.\/app\.js"/, 'index.html 需要引用 app.js')
assert.match(html, /rel="manifest"/, 'index.html 需要引用 manifest')
assert.match(html, /name="theme-color" content="#ff8c2b"/, 'index.html 需要 theme-color')

const manifest = JSON.parse(readFileSync(join(pwaDir, 'manifest.json'), 'utf8'))
assert.equal(manifest.name, 'PulseForge', 'manifest.name 必须是 PulseForge')
assert.equal(manifest.display, 'standalone', 'manifest.display 必须是 standalone')
assert.equal(manifest.theme_color, '#ff8c2b', 'manifest.theme_color 必须是 #ff8c2b')
assert.equal(manifest.short_name, 'PulseForge')
assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3, '至少要有 3 个图标条目')
assert.ok(
  manifest.icons.some((icon) => icon.purpose === 'maskable'),
  '需要 maskable 图标',
)
assert.ok(
  manifest.icons.some((icon) => icon.sizes === '192x192'),
  '需要 192px 图标',
)

const sw = readFileSync(join(pwaDir, 'sw.js'), 'utf8')
assert.match(sw, /'\.\/app\.js'/, 'service worker 必须预缓存 app.js')
assert.match(sw, /'\.\/index\.html'/, 'service worker 必须预缓存 index.html')
assert.match(sw, /'\.\/icon-192\.png'/, 'service worker 必须预缓存 192 图标')
assert.match(sw, /fonts\.gstatic\.com/, 'service worker 必须处理字体域名')
assert.ok(!sw.includes('__PF_VERSION__'), '构建应把版本占位符替换掉')
assert.ok(!sw.includes('__PF_BUILD__'), '构建应把构建哈希占位符替换掉')
assert.match(sw, /const VERSION = '\d+\.\d+\.\d+\+[0-9a-f]{10}'/, 'sw 版本号应带内容哈希')
assert.match(sw, /const CACHE = 'pulseforge-v' \+ VERSION/, '缓存名应随版本变化')

const appJs = readFileSync(join(pwaDir, 'app.js'), 'utf8')
assert.ok(!/__ModuleLoader__\.load/.test(appJs), 'PWA 产物不应调用 DSH ModuleLoader')
assert.ok(!/^import\s/m.test(appJs), 'PWA 产物不应有 import 语句')
assert.ok(!/^export\s/m.test(appJs), 'PWA 产物不应有 export 语句')
assert.ok(appJs.includes('createReactLite'), 'PWA 产物应内联 react-lite')
assert.ok(appJs.includes('bootPwa'), 'PWA 产物应包含启动入口')

const appGzip = gzipSync(Buffer.from(appJs, 'utf8')).length
assert.ok(appGzip < 500 * 1024, 'PWA 产物 gzip 后应小于 500KB，实际 ' + (appGzip / 1024).toFixed(1) + ' KB')

/** 校验 PNG 签名与 IHDR 中的尺寸。 */
function checkPng(name, expectedSize) {
  const buffer = readFileSync(join(pwaDir, name))
  const signature = buffer.subarray(0, 8)
  assert.deepEqual(
    Array.from(signature),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    name + ' 不是合法 PNG',
  )
  assert.equal(buffer.readUInt32BE(16), expectedSize, name + ' 宽度不符')
  assert.equal(buffer.readUInt32BE(20), expectedSize, name + ' 高度不符')
}

checkPng('icon-192.png', 192)
checkPng('icon-512.png', 512)
checkPng('icon-maskable-512.png', 512)

// --- version.json：运行时的版本来源 ------------------------------------------

const versionDoc = JSON.parse(readFileSync(join(pwaDir, 'version.json'), 'utf8'))
assert.equal(versionDoc.schema, 1, 'version.json 需要 schema 字段')
assert.equal(versionDoc.name, 'PulseForge')
assert.match(versionDoc.version, /^\d+\.\d+\.\d+$/, 'version.json 的 version 应是三段版本号')
assert.match(versionDoc.build, /^[0-9a-f]{10}$/, 'version.json 的 build 应是 10 位构建哈希')
assert.equal(versionDoc.id, versionDoc.version + '+' + versionDoc.build, 'id 应是 version+build')

assert.match(sw, /const VERSION_FILE = '\.\/version\.json'/, 'service worker 应声明版本清单路径')
assert.match(sw, /url\.pathname\.endsWith\('\/version\.json'\)/, '版本清单要单独分流')
assert.match(sw, /function networkOnly\(/, '版本清单必须直接走网络')
assert.match(sw, /cache: 'no-store'/, '版本清单不能命中 HTTP 缓存')
assert.match(sw, /data\.type === 'purge-caches'/, '刷新前需要能清掉旧缓存')
assert.match(html, /name="pulseforge-version"/, '页面要带上本地构建号，供运行时比对')
assert.ok(
  html.includes(versionDoc.id),
  'index.html 里的本构建号应与 version.json 一致',
)
assert.ok(
  appJs.includes('发现新版本'),
  'PWA 产物应包含「发现新版本」提示文案',
)

console.log('pwa runtime ok：状态 / 复用 / effect / 事件 / 外部 store / 卸载')
console.log('pwa assets ok：manifest、service worker、app.js（gzip ' + (appGzip / 1024).toFixed(1) + ' KB）、PNG 图标')
console.log('pwa ok')
