/**
 * 压力场景回归：64 步全涂抹 + 大量带独立长混响的音符。
 *
 * 目的（对应 m01580 的三条边界）：
 *   1. 音频节点有上限：单音符效果链走对象池，最多同时存在 NOTE_CHAIN_LIMIT 条；
 *   2. 播完必须归还并断开，不允许节点泄漏；
 *   3. 离线导出同样受池约束，且旧工程（无 fxOverrides）能直接导出。
 *
 * 这里不产生真实声音，用可计数的假 AudioContext / OfflineAudioContext 驱动
 * 真实的调度与导出代码，因此断言的是「节点数量上限」而不是波形。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const fragments = ['10-core.ts', '20-store.ts', '30-idb.ts', '40-audio.ts', '50-export.ts', '60-icons.ts', '70-controls.ts']
const source = fragments
  .map(function (name) {
    const text = readFileSync(join(here, '..', 'src', 'client', name), 'utf8')
    return stripTypeScriptTypes(text, { mode: 'strip', sourceUrl: name })
  })
  .join('\n')

// ---------------------------------------------------------------------------
// 假 Web Audio：所有节点都登记到所属 context 的计数里
// ---------------------------------------------------------------------------
class FakeParam {
  constructor(value) {
    this.value = value
    this.defaultValue = value
  }
  setValueAtTime(value) {
    this.value = value
    return this
  }
  linearRampToValueAtTime(value) {
    this.value = value
    return this
  }
  exponentialRampToValueAtTime(value) {
    this.value = value
    return this
  }
  setTargetAtTime(value) {
    this.value = value
    return this
  }
  cancelScheduledValues() {
    return this
  }
}

class FakeNode {
  constructor(owner, kind) {
    this.owner = owner
    this.kind = kind
    this.connections = []
    owner.nodes.push(this)
    if (kind === 'convolver') owner.convolvers += 1
  }
  connect(target) {
    this.connections.push(target)
    return target
  }
  disconnect() {
    this.connections.length = 0
    this.disconnected = true
  }
}

class FakeContext {
  constructor(offline) {
    this.offline = offline
    this.sampleRate = 44100
    this.currentTime = 0
    this.state = 'running'
    this.nodes = []
    this.convolvers = 0
    this.startedSources = 0
    this.destination = new FakeNode(this, 'destination')
  }
  createGain() {
    const node = new FakeNode(this, 'gain')
    node.gain = new FakeParam(1)
    return node
  }
  createBiquadFilter() {
    const node = new FakeNode(this, 'biquad')
    node.type = 'lowpass'
    node.frequency = new FakeParam(350)
    node.Q = new FakeParam(1)
    node.gain = new FakeParam(0)
    return node
  }
  createWaveShaper() {
    const node = new FakeNode(this, 'shaper')
    node.curve = null
    node.oversample = 'none'
    return node
  }
  createDelay() {
    const node = new FakeNode(this, 'delay')
    node.delayTime = new FakeParam(0.28)
    return node
  }
  createConvolver() {
    const node = new FakeNode(this, 'convolver')
    node.buffer = null
    node.normalize = true
    return node
  }
  createBuffer(channels, length, sampleRate) {
    const data = []
    for (let i = 0; i < channels; i += 1) data.push(new Float32Array(length))
    return {
      numberOfChannels: channels,
      length: length,
      sampleRate: sampleRate,
      duration: length / sampleRate,
      getChannelData: function (index) {
        return data[index]
      },
    }
  }
  createBufferSource() {
    const node = new FakeNode(this, 'source')
    node.buffer = null
    node.loop = false
    node.playbackRate = new FakeParam(1)
    node.onended = null
    node.start = () => {
      this.startedSources += 1
    }
    node.stop = () => {}
    return node
  }
  createOscillator() {
    const node = new FakeNode(this, 'oscillator')
    node.type = 'sine'
    node.frequency = new FakeParam(440)
    node.detune = new FakeParam(0)
    node.onended = null
    node.start = () => {
      this.startedSources += 1
    }
    node.stop = () => {}
    return node
  }
  createDynamicsCompressor() {
    const node = new FakeNode(this, 'compressor')
    node.threshold = new FakeParam(-24)
    node.ratio = new FakeParam(4)
    node.knee = new FakeParam(30)
    node.attack = new FakeParam(0.003)
    node.release = new FakeParam(0.25)
    return node
  }
  resume() {
    this.state = 'running'
    return Promise.resolve()
  }
  close() {
    this.state = 'closed'
    return Promise.resolve()
  }
  startRendering() {
    // 离线渲染：返回一段足够长的静音缓冲，长度按已排程的时长推算
    const seconds = Math.max(2, Math.min(480, this.renderSeconds || 2))
    const length = Math.round(seconds * this.sampleRate)
    const data = [new Float32Array(length), new Float32Array(length)]
    return Promise.resolve({
      numberOfChannels: 2,
      length: length,
      sampleRate: this.sampleRate,
      duration: seconds,
      getChannelData: function (index) {
        return data[index]
      },
    })
  }
}

let offlineContexts = []
const realtimeContexts = []

class FakeOfflineContext extends FakeContext {
  constructor(channels, length, sampleRate) {
    super(true)
    this.sampleRate = sampleRate || 44100
    this.renderSeconds = length / this.sampleRate
    offlineContexts.push(this)
  }
}

// ---------------------------------------------------------------------------
// 沙箱
// ---------------------------------------------------------------------------
const downloads = []
const documentStub = {
  getElementById: function () {
    return null
  },
  createElement: function (tag) {
    if (tag === 'canvas') {
      return { width: 0, height: 0, getContext: function () { return null } }
    }
    return {
      style: {},
      href: '',
      download: '',
      click: function () {
        downloads.push(this.download)
      },
      remove: function () {},
      appendChild: function () {},
      setAttribute: function () {},
    }
  },
  head: { appendChild: function () {} },
  body: { appendChild: function () {}, removeChild: function () {} },
}

const sandbox = {
  window: { addEventListener: function () {}, removeEventListener: function () {} },
  document: documentStub,
  localStorage: { getItem: function () { return null }, setItem: function () {} },
  // 只放行 error，方便定位引擎初始化失败，正常的 warn 噪音不刷屏
  console: { log: function () {}, warn: function () {}, error: function () { console.error.apply(console, arguments) } },
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
  URL: { createObjectURL: function () { return 'blob:stress' }, revokeObjectURL: function () {} },
  indexedDB: undefined,
  AudioContext: function () {
    const context = new FakeContext(false)
    realtimeContexts.push(context)
    return context
  },
  OfflineAudioContext: function (channels, length, sampleRate) {
    return new FakeOfflineContext(channels, length, sampleRate)
  },
}

const EXPORTS = [
  'defaultProject',
  'normalizeProject',
  'patchDaw',
  'getDawState',
  'ensureAudioEngine',
  'acquireNoteChain',
  'releaseNoteChain',
  'disposeAudioEngine',
  'audioStats',
  'scheduleStep',
  'exportWav',
  'defaultFx',
  'noteFx',
  'TRACK_COUNT',
  'NOTE_CHAIN_LIMIT',
  'TOTAL_STEPS',
]
const body = source + '\nreturn {' + EXPORTS.join(',') + '}'
const api = new Function(...Object.keys(sandbox), body)(...Object.values(sandbox))

let checks = 0
function check(name, run) {
  run()
  checks += 1
}

// ---------------------------------------------------------------------------
// 场景：64 步全部填满，其中一半带「4 秒混响 + 全湿」的独立效果器
// ---------------------------------------------------------------------------
const project = api.defaultProject()
const notes = []
for (let step = 0; step < api.TOTAL_STEPS; step += 1) {
  const track = step % api.TRACK_COUNT
  const note = {
    id: 'stress-' + step,
    track: track,
    step: step,
    pitch: 48,
    length: 4,
    velocity: 110,
    offset: step % 7 === 0 ? 40 : 0,
  }
  // 一半音符带独立效果器覆盖（长混响），用来逼出对象池上限
  if (step % 2 === 0) note.fxOverrides = { decay: 4, reverbWet: 1, damping: 0 }
  notes.push(note)
}
api.patchDaw({ project: Object.assign({}, project, { notes: notes }) })
assert.equal(api.getDawState().project.notes.length, 64, '64 步全部有音符')

check('引擎启动后每轨一条效果链', function () {
  assert.equal(api.ensureAudioEngine(), true, '假 AudioContext 下引擎应能启动')
  assert.equal(realtimeContexts.length, 1, '只应创建一个实时 AudioContext')
  assert.equal(realtimeContexts[0].convolvers, api.TRACK_COUNT, '启动时每条轨道各一条效果链')
})

// ---------------------------------------------------------------------------
// 池：借满后返回 null，归还后能再次借出（在排程之前跑，池是空的）
// ---------------------------------------------------------------------------
{
  const fx = api.defaultFx()
  const borrowed = []
  for (let i = 0; i < api.NOTE_CHAIN_LIMIT; i += 1) {
    const chain = api.acquireNoteChain(fx)
    assert.ok(chain !== null, '上限内应借到链')
    borrowed.push(chain)
  }
  assert.equal(api.acquireNoteChain(fx), null, '超过上限后必须返回 null（退回轨道链）')
  borrowed.forEach(function (chain) {
    api.releaseNoteChain(chain, 0)
  })
  await new Promise(function (resolve) {
    setTimeout(resolve, 30)
  })
  const again = api.acquireNoteChain(fx)
  assert.ok(again !== null, '归还后应能再次借出')
  api.releaseNoteChain(again, 0)
  checks += 1
  await new Promise(function (resolve) {
    setTimeout(resolve, 20)
  })
}

// 逐 64 步排程：这是最坏情况——一半音符请求独立长混响链
check('64 步连续排程不爆节点', function () {  for (let step = 0; step < api.TOTAL_STEPS; step += 1) {
    api.scheduleStep(step, step * 0.125)
  }
  const ctx = realtimeContexts[0]
  // 16 条轨道链各 1 个 Convolver + 池上限 4 条音符链
  assert.equal(ctx.convolvers, api.TRACK_COUNT + api.NOTE_CHAIN_LIMIT, '卷积器数量必须被池上限锁死')
  assert.ok(ctx.startedSources >= 64, '每个音符都应被排程，实际 ' + String(ctx.startedSources))
  assert.ok(ctx.nodes.length < 16 * 20 + 4 * 20 + 64 * 8, '节点总数应有上界（实际 ' + String(ctx.nodes.length) + '）')
})

// ---------------------------------------------------------------------------
// 离线导出：含 fxOverrides 的大工程也要成功，且同样受池限制
// ---------------------------------------------------------------------------
const exportResult = api.exportWav().then(function () {
  return true
})

await exportResult
checks += 1
assert.ok(downloads.length >= 1, '导出应触发一次文件下载')
assert.match(downloads[downloads.length - 1], /^pulseforge-\d{8}-\d{6}\.wav$/, '文件名形如 pulseforge-<timestamp>.wav')
assert.equal(offlineContexts.length >= 1, true, '应创建离线上下文')
const offline = offlineContexts[offlineContexts.length - 1]
assert.equal(offline.convolvers, api.TRACK_COUNT + api.NOTE_CHAIN_LIMIT, '离线导出同样限制卷积器数量')

// ---------------------------------------------------------------------------
// 旧工程（无 fxOverrides / offset）照样能导出
// ---------------------------------------------------------------------------
const legacy = api.normalizeProject({
  version: 1,
  bpm: 140,
  notes: [
    { id: 'legacy-1', track: 0, step: 0, pitch: 36, length: 1, velocity: 100 },
    { id: 'legacy-2', track: 4, step: 3, pitch: 48, length: 2, velocity: 90 },
  ],
  ui: { snap: '1/16', selectedTrack: 4 },
})
api.patchDaw({ project: legacy })
const offlineBefore = offlineContexts.length
await api.exportWav()
checks += 1
assert.equal(offlineContexts.length, offlineBefore + 1, '旧工程也应完成一次离线渲染')
const legacyOffline = offlineContexts[offlineContexts.length - 1]
assert.ok(legacyOffline.convolvers <= api.TRACK_COUNT + api.NOTE_CHAIN_LIMIT, '旧工程不产生额外卷积器')

// ---------------------------------------------------------------------------
// 回收：排程完立刻卸载，所有计数必须归零（僵尸节点曾把内存吃满）
// ---------------------------------------------------------------------------
check('卸载后音频对象计数归零', function () {
  const before = api.audioStats()
  assert.ok(before.voices > 0, '排程后应存在存活 voice，实际 ' + String(before.voices))
  assert.ok(before.timers > 0, '兜底回收定时器必须被登记，实际 ' + String(before.timers))
  api.disposeAudioEngine()
  const after = api.audioStats()
  assert.equal(after.voices, 0, '卸载后存活 voice 必须为 0')
  assert.equal(after.timers, 0, '卸载后登记中的定时器必须为 0')
  assert.equal(after.chainsInUse, 0, '卸载后借出的链必须为 0')
  assert.equal(after.chainsIdle, 0, '卸载后空闲链必须为 0')
  assert.equal(after.trackChains, 0, '卸载后轨道链必须为 0')
})

console.log('stress ok：' + String(checks) + ' 组压力场景通过（64 步全填 + 32 个独立长混响音符）')
