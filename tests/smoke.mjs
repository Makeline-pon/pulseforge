/**
 * 冒烟测试：直接在 Node 里求值「擦除类型后的客户端源码」。
 *
 * 目的不是模拟浏览器，而是尽早暴露三类问题：
 *  1. 分片拼接顺序导致的初始化错误（例如 store 依赖的常量还没定义）；
 *  2. 纯函数逻辑错误（吸附、BPM 夹紧、音高换算、WAV 头）；
 *  3. `apply(ctx)` 的注册面是否符合宿主契约（命令 2 条、槽位 2 个、可全部撤销）。
 */

import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const clientDir = join(here, '..', 'src', 'client')

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

const source = FRAGMENTS.map(function (file) {
  const text = readFileSync(join(clientDir, file), 'utf8')
  return stripTypeScriptTypes(text, { mode: 'strip', sourceUrl: file })
}).join('\n')

const EXPORTS = [
  'clampInt',
  'snapStep',
  'stepDuration',
  'midiToFreq',
  'pitchName',
  'normalizeProject',
  'defaultProject',
  'encodeWav',
  'projectDurationSeconds',
  'createPulseForge',
  'TopBar',
  'StatusBar',
  'ChangelogDialog',
  'PLUGIN_VERSION',
  'CHANGELOG',
  'Sequencer',
  'PianoRoll',
  'EffectPanel',
  'getDawState',
  'subscribeDaw',
  'openDaw',
  'closeDaw',
  'setBpm',
  'toggleStepNote',
  'createFxChain',
  'buildDistortionCurve',
  'SNAP_STEPS',
  'STEP_COUNT',
  'TOTAL_STEPS',
  'BAR_COUNT',
  'TRACK_COUNT',
  'PITCH_LOW',
  'PITCH_HIGH',
]

/** React 桩：只需支撑 hook 的调用形态与 createElement。 */
function makeReactStub() {
  return {
    createElement: function (type, props, ...children) {
      return { type: type, props: props ?? {}, children: children.flat() }
    },
    useRef: function (initial) {
      return { current: initial ?? null }
    },
    /** 测试里只求值一次，setState 为 noop：足以让组件树完整渲染。 */
    useState: function (initial) {
      const value = typeof initial === 'function' ? initial() : initial
      return [value, function () {}]
    },
    useEffect: function () {
      /* 测试环境不执行副作用 */
    },
    useMemo: function (factory) {
      return factory()
    },
    useCallback: function (fn) {
      return fn
    },
    useSyncExternalStore: function (subscribe, getSnapshot) {
      return getSnapshot()
    },
  }
}

const React = makeReactStub()
const h = React.createElement
const store = { localStorage: undefined }
const sandbox = {
  window: { __ModuleLoader__: null, addEventListener: function () {}, removeEventListener: function () {} },
  document: {
    getElementById: function () {
      return null
    },
    createElement: function () {
      return { style: {}, appendChild: function () {}, parentNode: null }
    },
    head: { appendChild: function () {} },
    body: { appendChild: function () {}, removeChild: function () {} },
  },
  localStorage: store,
  console: console,
  React: React,
  h: h,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  requestAnimationFrame: function (fn) {
    return setTimeout(fn, 0)
  },
  cancelAnimationFrame: function (id) {
    clearTimeout(id)
  },
  Blob: Blob,
  URL: { createObjectURL: function () { return 'blob:test' }, revokeObjectURL: function () {} },
  indexedDB: undefined,
  AudioContext: undefined,
  OfflineAudioContext: undefined,
}

const body = source + '\nreturn {' + EXPORTS.join(',') + '}'
const factory = new Function(...Object.keys(sandbox), body)
const api = factory(...Object.values(sandbox))

// --- 纯函数 ---------------------------------------------------------------
assert.equal(api.clampInt(1.6, 0, 2), 2, 'clampInt 应四舍五入并夹紧')
assert.equal(api.clampInt(-5, 0, 10), 0, 'clampInt 下界')
assert.equal(api.snapStep(3, '1/4'), 4, '1/4 吸附到 4 的倍数')
assert.equal(api.snapStep(5, '1/8'), 6, '1/8 吸附到最近的 2 的倍数')
assert.equal(api.snapStep(7, '1/16'), 7, '1/16 不改变位置')
assert.equal(api.snapStep(20, '1/16'), 20, '1/16 下 20 仍是合法落点（共 64 步）')
assert.equal(api.snapStep(999, '1/16'), api.TOTAL_STEPS - 1, '吸附后不能越出 4 小节')
assert.equal(api.stepDuration(120), 0.125, '120BPM 下十六分音符 0.125s')
assert.equal(api.midiToFreq(69), 440, 'A4 = 440Hz')
assert.equal(api.pitchName(60), 'C4', 'MIDI 60 = C4')
assert.equal(api.pitchName(36), 'C2', 'MIDI 36 = C2')
assert.equal(api.pitchName(96), 'C7', 'MIDI 96 = C7')

const fallback = api.normalizeProject(null)
assert.equal(fallback.bpm, 120, '损坏输入回退到 120BPM')
const clamped = api.normalizeProject({ bpm: 999, notes: [{ track: 99, step: 99, pitch: 999, length: 99 }] })
assert.equal(clamped.bpm, 200, 'BPM 上限 200')
assert.equal(clamped.notes[0].track, 15, '轨道号夹紧')
assert.equal(clamped.notes[0].step, api.TOTAL_STEPS - 1, '步进夹紧到最后一个合法步')
assert.equal(clamped.notes[0].pitch, 96, '音高夹紧到 C7')
assert.equal(clamped.notes[0].length, 1, '音符长度不能超出小节')

const curve = api.buildDistortionCurve(1)
assert.equal(curve.length, 1024, '失真曲线采样数')
assert.ok(curve[512] >= 0 && curve[512] <= 1, '失真曲线中点应在 0..1')

// --- WAV 编码 -------------------------------------------------------------
const frames = 8
const fakeBuffer = {
  numberOfChannels: 2,
  length: frames,
  sampleRate: 44100,
  getChannelData: function (channel) {
    const data = new Float32Array(frames)
    for (let i = 0; i < frames; i += 1) data[i] = channel === 0 ? 0.5 : -0.5
    return data
  },
}
const blob = api.encodeWav(fakeBuffer)
const bytes = Buffer.from(await blob.arrayBuffer())
assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', 'WAV 头 RIFF')
assert.equal(bytes.toString('ascii', 8, 12), 'WAVE', 'WAV 头 WAVE')
assert.equal(bytes.toString('ascii', 36, 40), 'data', 'WAV 头 data')
assert.equal(bytes.readUInt16LE(22), 2, '立体声')
assert.equal(bytes.readUInt32LE(24), 44100, '44.1kHz')
assert.equal(bytes.readUInt16LE(34), 16, '16-bit')
assert.equal(bytes.length, 44 + frames * 2 * 2, 'WAV 长度 = 头 + 双声道 16bit 数据')
assert.equal(bytes.readInt16LE(44), 0x3fff, '正样本量化')
assert.equal(bytes.readInt16LE(46), -0x4000, '负样本量化')

// --- 工程时长 -------------------------------------------------------------
const project = api.defaultProject()
project.notes = [{ id: 'n1', track: 0, step: 0, pitch: 36, length: 16, velocity: 100 }]
const duration = api.projectDurationSeconds(project)
assert.ok(duration >= 2 && duration <= 8 * 60, '导出时长在 2 秒到 8 分钟之间')

// --- 状态与编辑动作 -------------------------------------------------------
const seen = []
const off = api.subscribeDaw(function () {
  seen.push(api.getDawState().status)
})
api.setBpm(500)
assert.equal(api.getDawState().project.bpm, 200, 'setBpm 会被夹紧到 200')
api.setBpm(10)
assert.equal(api.getDawState().project.bpm, 60, 'setBpm 会被夹紧到 60')
// 注意：出厂工程自带示例节奏（track 0 的第 0/4/8/12 步已有底鼓），这里选空步 1 测试写入
const before = api.getDawState().project.notes.length
assert.equal(api.toggleStepNote(0, 1), true, '空格写入音符')
assert.equal(api.getDawState().project.notes.length, before + 1, '音符数量 +1')
assert.equal(api.toggleStepNote(0, 1), false, '再次点击删除音符')
assert.equal(api.getDawState().project.notes.length, before, '音符数量还原')
off()
assert.ok(seen.length > 0, '订阅者应收到状态变化')

// --- apply(ctx) 注册面 ----------------------------------------------------
const created = []
const registered = []
const disposed = []
const ctx = {
  logger: function () {
    return { info: function () {}, warn: function () {}, error: function () {} }
  },
  effect: function (factory) {
    const disposer = factory()
    created.push(disposer)
    return function () {
      if (typeof disposer === 'function') disposer()
    }
  },
  commandUi: {
    register: function (contribution) {
      registered.push(contribution)
      return function () {
        disposed.push('command:' + contribution.name)
      }
    },
  },
  slots: {
    inject: function (slot, factory) {
      const disposer = factory()
      return function () {
        if (typeof disposer === 'function') disposer()
      }
    },
    register: function (meta, component) {
      registered.push(Object.assign({ slot: meta.name }, meta))
      assert.equal(typeof component, 'function', '槽位组件必须是函数')
      return function () {
        disposed.push('slot:' + meta.id)
      }
    },
  },
}

const plugin = api.createPulseForge()
assert.deepEqual(plugin.inject, ['slots', 'commandUi'], '客户端插件依赖声明')
plugin.apply(ctx)

const commands = registered.filter(function (entry) {
  return typeof entry.ui !== 'undefined'
})
assert.equal(commands.length, 2, '注册 /pulseforge 与 /daw 两条命令')
assert.deepEqual(
  commands.map(function (command) {
    return command.name
  }),
  ['pulseforge', 'daw'],
  '命令名与顺序',
)
commands.forEach(function (command) {
  assert.equal(command.ui.kind, 'action', '命令类型必须是 action')
  assert.equal(typeof command.ui.run, 'function', 'action 必须有 run(session)')
  assert.equal(typeof command.available, 'function', 'available(session) 必须存在')
})
const slots = registered.filter(function (entry) {
  return typeof entry.slot !== 'undefined'
})
assert.deepEqual(
  slots.map(function (entry) {
    return entry.slot
  }),
  ['sidebar.footer.action', 'shell.overlay'],
  '两个槽位注册名',
)
slots.forEach(function (entry) {
  assert.equal(entry.id, 'pulseforge', '槽位 id 必须是插件 id')
})

// 命令的 run 在没有 DOM 的测试环境里也不能抛错
commands[0].ui.run({})
assert.equal(api.getDawState().open, true, '/pulseforge 首次调用应打开面板')
commands[1].ui.run({})
assert.equal(api.getDawState().open, true, '/daw 二次调用保持打开（聚焦而非重复挂载）')

// 撤销：effect 的 disposer 必须能收回命令与槽位
created.forEach(function (disposer) {
  if (typeof disposer === 'function') disposer()
})
assert.equal(disposed.filter(function (name) {
  return name.indexOf('command:') === 0
}).length, 2, '两条命令都被撤销')
assert.equal(disposed.filter(function (name) {
  return name.indexOf('slot:') === 0
}).length, 2, '两个槽位都被撤销')

api.closeDaw()
assert.equal(api.getDawState().open, false, 'closeDaw 关闭面板')

// --- 组件渲染冒烟（React 桩）-----------------------------------------------
api.toggleStepNote(12, 2)
api.toggleStepNote(0, 4)
const renderState = Object.assign({}, api.getDawState(), { open: true, playing: false, cursor: 3, exporting: false })
for (const name of ['TopBar', 'StatusBar', 'Sequencer', 'PianoRoll', 'EffectPanel']) {
  const node = api[name](
    name === 'TopBar' ? { state: renderState, onClose: function () {} } : { state: renderState },
  )
  assert.ok(node !== null && typeof node === 'object', name + ' 应返回 React 元素')
  assert.ok(typeof node.type === 'string' || typeof node.type === 'function', name + ' 根节点类型合法')
}
/** 递归展开函数组件，检查某个 class 是否出现在渲染结果里。 */
function findClass(node, cls) {
  if (node === null || typeof node !== 'object') return false
  if (typeof node.type === 'function') return findClass(node.type(node.props), cls)
  if (node.props && typeof node.props.className === 'string' && node.props.className.indexOf(cls) >= 0) return true
  const kids = node.children || []
  return kids.some(function (child) {
    return findClass(child, cls)
  })
}
assert.ok(findClass(api.Sequencer({ state: renderState }), 'pf-step is-on'), '音序器应渲染出已启用的步进')
assert.ok(findClass(api.PianoRoll({ state: renderState }), 'pf-note'), '钢琴卷帘应渲染出音符块')
console.log('render ok: TopBar / StatusBar / Sequencer / PianoRoll / EffectPanel 均可渲染，音符块可见')

// --- 混响阻尼滑块（默认 75%）----------------------------------------------
/** 在未展开的原始元素树里找第一个 props[key] === value 的节点。 */
function findByProp(node, key, value) {
  if (node === null || typeof node !== 'object') return null
  if (node.props && node.props[key] === value) return node
  const kids = node.children || []
  for (const child of kids) {
    const hit = findByProp(child, key, value)
    if (hit !== null) return hit
  }
  return null
}
const panelTree = api.EffectPanel({ state: renderState })
const dampSlider = findByProp(panelTree, 'label', 'Damping')
assert.ok(dampSlider !== null, '混响卡片里应有 Damping 滑块')
assert.equal(dampSlider.props.value, 0.75, 'Damping 默认 75%')
assert.equal(dampSlider.props.min, 0, 'Damping 下限 0')
assert.equal(dampSlider.props.max, 1, 'Damping 上限 1')
assert.equal(dampSlider.props.format(0.75), '75%', 'Damping 以百分比显示')
const decaySlider = findByProp(panelTree, 'label', 'Decay')
assert.ok(decaySlider.props.value >= 1.8 && decaySlider.props.value <= 2.2, 'Decay 默认在 2s 左右')
assert.ok(findByProp(panelTree, 'label', 'Wet') !== null, '混响湿量滑块仍在')
console.log('reverb ok: Damping 默认 75%、Decay 默认 2s、湿量滑块就位')

// --- 重构后的交互控件：清空音序 / 小节翻页 / 效果作用域 -------------------
const topTree = api.TopBar({ state: renderState, onClose: function () {} })
const clearButton = findByProp(topTree, 'label', '清空音序')
assert.ok(clearButton !== null, '顶栏应有「清空音序」按钮')
assert.equal(typeof clearButton.props.onClick, 'function', '清空音序需要二次确认的点击处理器')
assert.ok(findClass(topTree, 'pf-pager'), '顶栏应显示小节翻页控件')
const pagerLabel = findByProp(topTree, 'className', 'pf-pager-label')
assert.ok(pagerLabel !== null, '翻页控件应显示当前小节')
assert.match(String(pagerLabel.children[0]), /第 \d+ 小节 \/ 共 4 小节/, '翻页文案形如「第 1 小节 / 共 4 小节」')

const seqTree = api.Sequencer({ state: renderState })
const seqRoot = seqTree
assert.match(String(seqRoot.props['aria-label']), /共 4 小节/, '音序器无障碍名称应说明 4 小节')
assert.ok(findClass(seqTree, 'pf-seq-grid'), '音序器网格应包裹选框容器')
const renderRange = api.Sequencer({ state: Object.assign({}, renderState, { page: 2 }) })
assert.ok(renderRange !== null, '翻到第 3 小节也能渲染')

const scopeSelect = findByProp(panelTree, 'label', '编辑')
assert.ok(scopeSelect !== null, '效果面板顶部应有作用域下拉')
assert.equal(scopeSelect.props.value, 'master', '默认作用域是全局 Master')
assert.equal(scopeSelect.props.options.length, 1 + api.TRACK_COUNT, '作用域选项 = Master + 16 轨')
console.log('refactor ui ok: 清空音序、小节翻页与效果作用域下拉均已就位')

// --- 0.5.0：快捷键图例 / 偏移可视化 / 池满提示 ----------------------------
assert.ok(findClass(seqTree, 'pf-legend'), '音序器左上角应有快捷键图例')
const legendKeys = []
/**
 * 收集图例里的按键徽章文字：图例项由 kbd + span 组成，
 * 这里只看文本子节点，避免把整棵音序器树都算进来。
 */
function collectLegend(node, out) {
  if (node === null || typeof node !== 'object') return out
  if (node.props && typeof node.props.className === 'string' && node.props.className.indexOf('pf-legend-key') >= 0) {
    out.push((node.children || []).map(String).join(''))
  }
  for (const child of node.children || []) collectLegend(child, out)
  return out
}
collectLegend(seqTree, legendKeys)
assert.ok(legendKeys.some(function (key) { return key.indexOf('Shift') >= 0 }), '图例应说明 Shift 框选')
assert.ok(legendKeys.some(function (key) { return key.indexOf('Alt') >= 0 }), '图例应说明 Alt 涂抹')

// 把第一个音符提前 30ms，检查格子下沿出现偏移短线且有 is-early 标记
const earlyState = Object.assign({}, renderState, {
  project: Object.assign({}, renderState.project, {
    notes: renderState.project.notes.map(function (note) {
      // 全部提前 30ms：钢琴卷帘只渲染当前选中轨，逐轨改才不会漏
      return Object.assign({}, note, { offset: -30 })
    }),
  }),
})
const earlyTree = api.Sequencer({ state: earlyState })
assert.ok(findClass(earlyTree, 'pf-step-offset'), '有偏移的音符应在格子上画出偏移短线')
assert.ok(findClass(earlyTree, 'pf-step-offset is-early'), '提前的音符应标记为 is-early')
assert.ok(findClass(api.PianoRoll({ state: earlyState }), 'pf-note-origin'), '钢琴卷帘应画出原始网格位置的起源线')

assert.ok(source.indexOf('独立效果器并发已达上限') >= 0, '对象池降级时应有 toast 提示文案')
assert.ok(source.indexOf('warnNoteChainStarved') >= 0, '借链失败的降级路径应调用提示函数')
console.log('polish ok: 快捷键图例、偏移短线与池满提示均已接入')

// --- 内存回收与框选 -------------------------------------------------------
// 这两条靠「源码结构」断言：DOM 事件与 AudioContext 生命周期在 Node 里没有真实实现，
// 但「监听是否挂在 window 上」「计时器是否集中登记」「诊断入口是否暴露」是纯结构事实。
assert.ok(source.indexOf("window.addEventListener('pointermove', onMove)") >= 0, '框选的 move 必须挂在 window 上')
assert.ok(source.indexOf("window.addEventListener('pointerup', onUp)") >= 0, '框选的 up 必须挂在 window 上')
assert.ok(source.indexOf('function endMarquee') >= 0, '框选必须有统一的收尾函数（摘监听）')
assert.ok(source.indexOf('is-marquee') >= 0, '框选命中的格子/音符应有高亮标记')
assert.ok(source.indexOf('function scheduleLater') >= 0, '延迟回调必须集中登记')
assert.ok(source.indexOf('clearPendingTimers') >= 0, '停止/卸载时必须能清空全部延迟回调')
assert.ok(source.indexOf('function audioStats') >= 0, '应提供音频对象统计')
assert.ok(source.indexOf('__pfAudioStats') >= 0, '统计入口应挂到 window 供控制台调用')
// 框选命中必须靠几何表而不是「鼠标下面的元素」：elementFromPoint 在网格外返回 null，
// 曾经导致「拖出网格再松手」时选区被退化成单格。
assert.ok(source.indexOf('document.elementFromPoint(') < 0, '框选不得调用 elementFromPoint（网格外会命中失败）')
assert.ok(source.indexOf('function measureGrid') >= 0, '框选需要按下瞬间量出格子几何')
assert.ok(source.indexOf('function pointToCell') >= 0, '视口坐标必须能换算成行列（越界夹紧）')
console.log('leak ok: 框选走 window 监听、几何换算不依赖 DOM、定时器集中登记、对象统计已暴露')


// --- 版本号与更新日志 -----------------------------------------------------
// 版本号只在两处出现：package.json 与 10-core.ts 的 PLUGIN_VERSION；此处断言二者一致，
// 避免升级时只改了一边（发布脚本也会做同样的检查）。
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
assert.equal(api.PLUGIN_VERSION, pkg.version, 'PLUGIN_VERSION 必须与 package.json 的 version 一致')
assert.match(api.PLUGIN_VERSION, /^\d+\.\d+\.\d+$/, '版本号必须是 x.y.z')
assert.ok(Array.isArray(api.CHANGELOG) && api.CHANGELOG.length >= 2, '更新日志至少包含两个版本')
assert.equal(api.CHANGELOG[0].version, api.PLUGIN_VERSION, '更新日志首条必须是当前版本（新 → 旧）')
for (let i = 1; i < api.CHANGELOG.length; i += 1) {
  const newer = api.CHANGELOG[i - 1].version.split('.').map(Number)
  const older = api.CHANGELOG[i].version.split('.').map(Number)
  const ordered =
    newer[0] !== older[0] ? newer[0] > older[0] : newer[1] !== older[1] ? newer[1] > older[1] : newer[2] >= older[2]
  assert.ok(ordered, '更新日志必须从新到旧排列：' + api.CHANGELOG[i - 1].version + ' → ' + api.CHANGELOG[i].version)
  for (const item of api.CHANGELOG[i].items) {
    assert.ok(['feat', 'fix', 'chore'].indexOf(item.kind) >= 0, '变更类型合法')
    assert.ok(typeof item.text === 'string' && item.text.length > 0, '变更说明非空')
  }
}

const statusNode = api.StatusBar({ state: renderState, onShowChangelog: function () {} })
assert.ok(findClass(statusNode, 'pf-version'), '状态栏应渲染版本号按钮')
assert.ok(findClass(statusNode, 'pf-status'), '状态栏根节点')

const dialogNode = api.ChangelogDialog({ onClose: function () {} })
assert.ok(findClass(dialogNode, 'pf-changelog'), '更新日志弹窗根节点')
assert.ok(findClass(dialogNode, 'pf-changelog-item'), '更新日志应渲染出条目')
assert.ok(findClass(dialogNode, 'pf-changelog-version'), '更新日志应渲染出版本行')
console.log('changelog ok: 版本角标、弹窗与版本排序均符合预期')

console.log('smoke ok: 纯函数 ' + 22 + ' 项断言、WAV 编码、注册面与撤销全部通过')
