/**
 * PWA 启动集成测试：用 DOM 垫片直接执行构建产物 `pwa/app.js`，
 * 确认「一个空 HTML + app.js」就能把整套界面渲染出来（这是离线可用的前提）。
 *
 * 只验证「能起来 + 关键结构存在 + 交互不抛异常」，不做像素级断言。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const pwaDir = join(here, '..', 'pwa')
const appJs = readFileSync(join(pwaDir, 'app.js'), 'utf8')

// --- DOM 垫片 ---------------------------------------------------------------

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

/** 2D 上下文桩：任何方法调用都返回 undefined，属性可读写。 */
function makeContext2d() {
  const context = {
    canvas: null,
    clearRect: function () {},
    fillRect: function () {},
    beginPath: function () {},
    moveTo: function () {},
    lineTo: function () {},
    closePath: function () {},
    stroke: function () {},
    fill: function () {},
    save: function () {},
    restore: function () {},
    setLineDash: function () {},
    createLinearGradient: function () {
      return { addColorStop: function () {} }
    },
    fillText: function () {},
  }
  return context
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
    this.className = ''
    this.value = ''
    this.checked = false
    this.scrollTop = 0
    this.scrollLeft = 0
    this.scrollHeight = 854
    this.clientHeight = 480
    this.clientWidth = 900
    this.offsetWidth = 900
    this.offsetHeight = 480
    this.offsetTop = 0
  }

  get classList() {
    const self = this
    return {
      add: function (name) {
        if (!self.className.split(' ').includes(name)) self.className = (self.className + ' ' + name).trim()
      },
      remove: function (name) {
        self.className = self.className
          .split(' ')
          .filter((item) => item !== name)
          .join(' ')
      },
      contains: function (name) {
        return self.className.split(' ').includes(name)
      },
    }
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
    if (name === 'class') this.className = String(value)
  }

  removeAttribute(name) {
    delete this.attributes[name]
    if (name === 'class') this.className = ''
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
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

  dispatch(type, event) {
    const list = this.listeners.get(type) ?? []
    for (const handler of list) handler(event)
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

  set textContent(value) {
    for (const child of this.childNodes.slice()) this.removeChild(child)
    this.appendChild(new FakeText(String(value)))
  }

  querySelector() {
    return null
  }

  querySelectorAll() {
    return []
  }

  getBoundingClientRect() {
    return { top: 0, left: 0, width: 900, height: 480, right: 900, bottom: 480 }
  }

  focus() {
    this.focused = true
  }

  blur() {
    this.focused = false
  }

  setPointerCapture() {}

  releasePointerCapture() {}

  getContext() {
    const context = makeContext2d()
    context.canvas = this
    return context
  }

  get firstElementChild() {
    return this.childNodes.find((node) => node.nodeType === 1) ?? null
  }
}

/**
 * 按 class 递归查找（测试用，不影响被测代码）。
 *
 * 带访问集合与深度上限：如果被测代码把同一个节点挂到两处（甚至形成环），
 * 这里会直接报错，而不是把测试进程的内存吃光。
 */
function findAll(node, className, results = [], seen = new Set(), depth = 0) {
  if (depth > 120) throw new Error('DOM 树深度异常（> 120），可能存在节点环')
  if (seen.has(node)) throw new Error('DOM 树出现重复节点或环：' + node.tagName)
  seen.add(node)
  if (node.nodeType === 1) {
    const classes = String(node.getAttribute('class') ?? '').split(/\s+/)
    if (classes.includes(className)) results.push(node)
    for (const child of node.childNodes) findAll(child, className, results, seen, depth + 1)
  }
  return results
}

/** 找到第一个匹配的节点，没有就返回 null。 */
function firstFind(node, className) {
  return findAll(node, className)[0] ?? null
}

const rootElement = new FakeElement('div')
rootElement.tagName = 'DIV'
const headElement = new FakeElement('head')
const bodyElement = new FakeElement('body')
bodyElement.appendChild(rootElement)

/*
 * 页面里的本地版本元信息：真实构建会把 `版本+哈希` 写进 index.html，
 * 这里用产物根目录的 version.json 造一份等价节点，供运行时比对。
 */
const localVersionDoc = JSON.parse(readFileSync(join(pwaDir, 'version.json'), 'utf8'))
const versionMeta = new FakeElement('meta')
versionMeta.setAttribute('name', 'pulseforge-version')
versionMeta.setAttribute('content', localVersionDoc.id)
headElement.appendChild(versionMeta)

/** 远端清单：默认与本地一致（不该弹提示），测试里再改成更新版本。 */
let remoteVersionDoc = localVersionDoc
const versionRequests = []

function fakeFetch(url, options) {
  versionRequests.push({ url: url, options: options })
  return Promise.resolve({
    ok: true,
    json: function () {
      return Promise.resolve(remoteVersionDoc)
    },
  })
}

const fakeDocument = {
  documentElement: new FakeElement('html'),
  head: headElement,
  body: bodyElement,
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (namespace, tag) => new FakeElement(tag, namespace),
  createTextNode: (data) => new FakeText(data),
  getElementById: (id) => (id === 'pf-root' ? rootElement : null),
  querySelector: (selector) => (String(selector).includes('pulseforge-version') ? versionMeta : null),
  addEventListener: function () {},
  removeEventListener: function () {},
  visibilityState: 'visible',
}

const fakeWindow = {
  location: { href: 'http://localhost:5180/', origin: 'http://localhost:5180' },
  addEventListener: function () {},
  removeEventListener: function () {},
  dispatchEvent: function () {
    return true
  },
  matchMedia: function () {
    return { matches: false, addEventListener: function () {}, removeEventListener: function () {} }
  },  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 1,
  requestAnimationFrame: function (fn) {
    return setTimeout(fn, 0)
  },
  cancelAnimationFrame: function (id) {
    clearTimeout(id)
  },
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  performance: { now: () => Date.now() },
}

class FakeURL extends URL {
  static createObjectURL() {
    return 'blob:test'
  }
  static revokeObjectURL() {}
}

const fakeNavigator = {
  serviceWorker: {
    register: function () {
      // 真实浏览器里 waiting/installing 没东西时是 null，这里保持同样的形状
      return Promise.resolve({ waiting: null, installing: null, addEventListener: function () {} })
    },
    addEventListener: function () {},
  },
  onLine: true,
}

// 沙箱：把浏览器全局注入后执行 app.js（IIFE，无 import/export）
const sandboxNames = ['window', 'document', 'navigator', 'location', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Blob', 'URL', 'indexedDB', 'AudioContext', 'OfflineAudioContext', 'performance', 'queueMicrotask', 'crypto', 'fetch']
const sandboxValues = [
  fakeWindow,
  fakeDocument,
  fakeNavigator,
  fakeWindow.location,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fakeWindow.requestAnimationFrame,
  fakeWindow.cancelAnimationFrame,
  Blob,
  FakeURL,
  undefined,
  undefined,
  undefined,
  fakeWindow.performance,
  queueMicrotask,
  globalThis.crypto,
  fakeFetch,
]

const run = new Function(...sandboxNames, appJs)
process.on('unhandledRejection', function (reason) {
  console.error('UNHANDLED', reason && reason.name, reason && reason.message)
  console.error(reason && reason.stack)
})
try {
  run(...sandboxValues)
} catch (error) {
  console.error('BOOT FAILED:', error && error.name, error && error.message)
  console.error(error && error.stack)
  throw error
}

// --- 断言 -------------------------------------------------------------------

const shell = findAll(rootElement, 'pf-root')
assert.equal(shell.length, 1, '应渲染出 .pf-root 外壳')

const windows = findAll(rootElement, 'pf-window')
assert.equal(windows.length, 1, '应渲染出 .pf-window')

assert.equal(findAll(rootElement, 'pf-step').length, 16 * 16, '音序器应有 16 轨 × 16 步')
assert.equal(findAll(rootElement, 'pf-note').length > 0, true, '钢琴卷帘应显示示例音符')
assert.equal(findAll(rootElement, 'pf-fx-card').length, 4, '效果器面板应有 4 张卡片')
assert.equal(findAll(rootElement, 'pf-version').length, 1, '状态栏应有版本按钮')
assert.equal(findAll(rootElement, 'pf-pwa-style').length, 0, '样式表不应出现在 body 内')

const styleTags = headElement.childNodes.filter((node) => node.nodeType === 1)
assert.ok(styleTags.length >= 2, '应注入主样式表与 PWA 样式表')

// 交互：点一次「播放」不应抛异常（AudioContext 缺失时应走降级路径）
const playButtons = findAll(rootElement, 'pf-btn').filter((node) => {
  const label = node.getAttribute('aria-label') ?? ''
  return label.includes('播放') || label.includes('停止')
})
assert.ok(playButtons.length >= 1, '顶栏应有播放按钮')
playButtons[0].dispatch('click', {
  preventDefault: function () {},
  stopPropagation: function () {},
  target: playButtons[0],
  currentTarget: playButtons[0],
})

// 版本按钮：存在且带可访问名称
const versionButton = findAll(rootElement, 'pf-version')[0]
assert.match(versionButton.getAttribute('aria-label') ?? '', /当前版本/, '版本按钮应有 aria-label')

// --- 版本核对：远端与本地一致时不打扰用户 -----------------------------------

assert.equal(typeof fakeWindow.__pfCheckVersion, 'function', '应暴露 __pfCheckVersion 调试入口')
console.log('probe: 开始第一次版本检查')
const sameResult = await fakeWindow.__pfCheckVersion()
console.log('probe: 第一次返回 ' + JSON.stringify(sameResult))
assert.equal(sameResult.version, localVersionDoc.version, '应返回远端版本号')
console.log('probe: 检查提示是否出现')
const earlyPill = firstFind(rootElement, 'pf-update')
console.log('probe: earlyPill=' + (earlyPill === null ? 'null' : 'found'))
assert.ok(earlyPill === null, '版本一致时不该出现更新提示')

// 版本清单必须绕过缓存，否则部署新版本后页面永远比不出来
const versionCall = versionRequests[versionRequests.length - 1]
assert.ok(versionCall.url.includes('version.json'), '应请求 version.json')
assert.ok(versionCall.url.includes('?t='), '请求要带时间戳，绕过 HTTP 缓存')
assert.equal(versionCall.options.cache, 'no-store', '请求必须禁用缓存')

// --- 版本核对：远端更新时弹非阻塞提示 ---------------------------------------

remoteVersionDoc = {
  schema: 1,
  name: 'PulseForge',
  version: '99.0.0',
  build: '0123456789',
  id: '99.0.0+0123456789',
  builtAt: '2026-11-10T00:00:00.000Z',
}
console.log('probe: 第二次版本检查')
try {
  const remote = await fakeWindow.__pfCheckVersion()
  console.log('probe: 第二次返回 ' + JSON.stringify(remote))
} catch (error) {
  console.error('probe: 第二次失败', error && error.name, error && error.message)
  console.error(error && error.stack)
  throw error
}
await new Promise((resolve) => setTimeout(resolve, 20))
console.log('probe: 渲染后检查提示')

const banner = firstFind(rootElement, 'pf-update')
assert.ok(banner !== null, '远端版本更新时应渲染 .pf-update 提示')
const bannerText = banner.textContent ?? ''
assert.match(bannerText, /发现新版本/, '提示文案应是「发现新版本」')
assert.match(bannerText, /99\.0\.0/, '提示里应带上远端版本号')

// 再次拉取同一版本不应重复弹（状态已在外部 store 里）
await fakeWindow.__pfCheckVersion()
await new Promise((resolve) => setTimeout(resolve, 20))
assert.equal(findAll(rootElement, 'pf-update').length, 1, '同一新版本只该有一个提示')

console.log('pwa boot ok：' + findAll(rootElement, 'pf-step').length + ' 个步进、' + findAll(rootElement, 'pf-note').length + ' 个音符、4 张效果卡、版本按钮与更新提示就绪')

// 应用里的版本巡检与 rAF 会留下长生命周期定时器，测试跑完主动退出
process.exit(0)
