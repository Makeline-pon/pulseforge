/**
 * 核心逻辑单元测试：吸附、BPM 夹紧、WAV 头、normalizeProject。
 *
 * 与 smoke.mjs 的区别：smoke 覆盖「整条装配链能否跑通」，本文件只盯住
 * 纯业务函数的边界行为——这些函数与 DSH 宿主完全无关（不碰 ctx），
 * 所以它们也是将来 PWA 版本唯一需要保留的测试。
 */

import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const clientDir = join(here, '..', 'src', 'client')

/** 与 build.mjs 相同的分片顺序：先核心，再业务，最后渲染与入口。 */
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
  'defaultTracks',
  'defaultFx',
  'dampingCutoff',
  'DAMPING_OPEN_HZ',
  'DAMPING_CLOSED_HZ',
  'encodeWav',
  'projectDurationSeconds',
  'setBpm',
  'getDawState',
  'BPM_MIN',
  'BPM_MAX',
  'STEP_COUNT',
  'TRACK_COUNT',
  'PROJECT_VERSION',
  'NOTE_MIN_STEPS',
  'NOTE_MAX_STEPS',
  'SNAP_STEPS',
  'TOTAL_STEPS',
  'BAR_COUNT',
  'OFFSET_MIN_MS',
  'OFFSET_MAX_MS',
  'offsetSeconds',
  'noteStartSeconds',
  'stepToPage',
  'notesInRect',
  'moveNoteTo',
  'resolveFx',
  'trackFx',
  'noteFx',
  'hasFxOverride',
  'normalizeFx',
  'parseFxOverrides',
]

/** 最小 React 桩：只实现分片初始化时会用到的 hook 形态。 */
const React = {
  createElement: function (type, props, ...children) {
    return { type: type, props: props ?? {}, children: children.flat() }
  },
  useRef: function (initial) {
    return { current: initial ?? null }
  },
  useEffect: function () {},
  useMemo: function (factory) {
    return factory()
  },
  useCallback: function (fn) {
    return fn
  },
  useState: function (initial) {
    return [initial, function () {}]
  },
  useSyncExternalStore: function (subscribe, getSnapshot) {
    return getSnapshot()
  },
}

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
  localStorage: { getItem: function () { return null }, setItem: function () {} },
  console: { log: function () {}, warn: function () {}, error: function () {} },
  React: React,
  h: React.createElement,
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
const api = new Function(...Object.keys(sandbox), body)(...Object.values(sandbox))

let checks = 0
function check(name, run) {
  run()
  checks += 1
  void name
}

/** 异步断言组（Blob → ArrayBuffer 需要 await）。 */
async function checkAsync(name, run) {
  await run()
  checks += 1
  void name
}

// ---------------------------------------------------------------------------
// 1. 吸附：1/4 → 4 的倍数、1/8 → 2 的倍数、1/16 原样，且不越出一小节
// ---------------------------------------------------------------------------
check('snap 1/4', function () {
  assert.equal(api.snapStep(0, '1/4'), 0)
  assert.equal(api.snapStep(1, '1/4'), 0)
  assert.equal(api.snapStep(2, '1/4'), 4)
  assert.equal(api.snapStep(3, '1/4'), 4)
  assert.equal(api.snapStep(6, '1/4'), 8)
  assert.equal(api.snapStep(12, '1/4'), 12)
})

check('snap 1/8', function () {
  assert.equal(api.snapStep(1, '1/8'), 2)
  assert.equal(api.snapStep(5, '1/8'), 6)
  assert.equal(api.snapStep(9, '1/8'), 10)
  assert.equal(api.snapStep(14, '1/8'), 14)
})

check('snap 1/16', function () {
  for (let step = 0; step < api.TOTAL_STEPS; step += 1) {
    assert.equal(api.snapStep(step, '1/16'), step, '1/16 不应改变 ' + step)
  }
})

check('snap 边界夹紧', function () {
  assert.equal(api.snapStep(-3, '1/16'), 0, '负位置夹到 0')
  assert.equal(api.snapStep(999, '1/16'), api.TOTAL_STEPS - 1, '不越出 4 小节')
  assert.equal(api.snapStep(999, '1/4'), api.TOTAL_STEPS - 1, '末尾保持可见步')
})

check('总步数与翻页', function () {
  assert.equal(api.BAR_COUNT, 4)
  assert.equal(api.TOTAL_STEPS, api.STEP_COUNT * api.BAR_COUNT)
  assert.equal(api.TOTAL_STEPS, 64)
  assert.equal(api.stepToPage(0), 0)
  assert.equal(api.stepToPage(15), 0)
  assert.equal(api.stepToPage(16), 1)
  assert.equal(api.stepToPage(63), 3)
})

check('吸附档位定义', function () {
  assert.deepEqual(api.SNAP_STEPS, { '1/4': 4, '1/8': 2, '1/16': 1 })
})

// ---------------------------------------------------------------------------
// 2. BPM：60–200 夹紧、非整数取整、步长换算
// ---------------------------------------------------------------------------
check('BPM 夹紧', function () {
  api.setBpm(999)
  assert.equal(api.getDawState().project.bpm, api.BPM_MAX, '上限 200')
  api.setBpm(-10)
  assert.equal(api.getDawState().project.bpm, api.BPM_MIN, '下限 60')
  api.setBpm(90.6)
  assert.equal(api.getDawState().project.bpm, 91, '四舍五入到整数')
  api.setBpm(120)
  assert.equal(api.getDawState().project.bpm, 120)
})

check('BPM 边界常量', function () {
  assert.equal(api.BPM_MIN, 60)
  assert.equal(api.BPM_MAX, 200)
})

check('步长与 BPM 关系', function () {
  // 十六分音符 = 60 / bpm / 4 秒
  assert.equal(api.stepDuration(120), 0.125)
  assert.equal(api.stepDuration(60), 0.25)
  assert.equal(api.stepDuration(200), 0.075)
  assert.ok(api.stepDuration(60) > api.stepDuration(120), 'BPM 越低每步越长')
})

// ---------------------------------------------------------------------------
// 3. WAV 头：RIFF/WAVE/fmt /data、44.1kHz、16-bit、立体声、量化
// ---------------------------------------------------------------------------
await checkAsync('WAV 头与量化', async function () {
  const frames = 4
  const fake = {
    numberOfChannels: 2,
    length: frames,
    sampleRate: 44100,
    getChannelData: function (channel) {
      const data = new Float32Array(frames)
      for (let i = 0; i < frames; i += 1) data[i] = channel === 0 ? 0.5 : -0.5
      return data
    },
  }
  const bytes = Buffer.from(await api.encodeWav(fake).arrayBuffer())
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF')
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE')
  assert.equal(bytes.toString('ascii', 12, 16), 'fmt ')
  assert.equal(bytes.toString('ascii', 36, 40), 'data')
  assert.equal(bytes.readUInt16LE(20), 1, 'PCM 格式号')
  assert.equal(bytes.readUInt16LE(22), 2, '立体声 2 声道')
  assert.equal(bytes.readUInt32LE(24), 44100, '44.1kHz')
  assert.equal(bytes.readUInt16LE(34), 16, '16-bit')
  assert.equal(bytes.readUInt32LE(28), 44100 * 2 * 2, 'byteRate')
  assert.equal(bytes.readUInt32LE(40), frames * 2 * 2, 'data 段长度')
  assert.equal(bytes.length, 44 + frames * 2 * 2, '总长度 = 头 + 数据')
  assert.equal(bytes.readInt16LE(44), 0x3fff, '0.5 → 16383')
  assert.equal(bytes.readInt16LE(46), -0x4000, '-0.5 → -16384')
})

// ---------------------------------------------------------------------------
// 4. normalizeProject：缺字段补默认、越界夹紧、脏数据丢弃
// ---------------------------------------------------------------------------
check('normalizeProject 空输入退回出厂工程', function () {
  const project = api.normalizeProject(null)
  assert.equal(project.version, api.PROJECT_VERSION)
  assert.equal(project.bpm, 120)
  assert.equal(project.tracks.length, api.TRACK_COUNT)
  assert.equal(typeof project.fx.drive, 'number', 'fx 是单份参数对象')
  assert.ok(project.fx.cutoff >= 20 && project.fx.cutoff <= 20000)
  assert.ok(project.notes.length > 0, '出厂工程自带示例节奏')
  assert.equal(project.ui.selectedTrack, 4, '默认选中 Bass 1')
})

check('normalizeProject 坏数字退回出厂值', function () {
  const project = api.normalizeProject({ bpm: 'abc', fx: { cutoff: 'x' }, ui: { selectedTrack: 'y' } })
  assert.equal(project.bpm, 120, 'NaN 不能变成 60')
  assert.equal(project.fx.cutoff, 12000, 'NaN 不能变成 20')
  assert.equal(project.ui.selectedTrack, 4)
})

check('normalizeProject 越界夹紧', function () {
  const project = api.normalizeProject({
    bpm: 5000,
    tracks: [{ name: '', gain: 99, pitch: -40 }],
    notes: [{ track: 999, step: -5, pitch: 500, length: 99, velocity: 999 }],
    fx: { drive: 5, cutoff: 1, resonance: 999, delayMs: 99999, feedback: 5, delayWet: 9, decay: 99, damping: 9, reverbWet: -3 },
    ui: { snap: '1/2', selectedTrack: 99 },
  })
  assert.equal(project.bpm, api.BPM_MAX)
  assert.equal(project.fx.drive, 1)
  assert.equal(project.fx.cutoff, 20)
  assert.equal(project.fx.resonance, 20)
  assert.equal(project.fx.delayMs, 1000)
  assert.equal(project.fx.feedback, 0.9)
  assert.equal(project.fx.delayWet, 1)
  assert.equal(project.fx.decay, 4)
  assert.equal(project.fx.damping, 1, '阻尼夹进 0–1')
  assert.equal(project.fx.reverbWet, 0)
  const note = project.notes[0]
  assert.ok(note.track >= 0 && note.track < api.TRACK_COUNT, '轨道夹进范围')
  assert.ok(note.step >= 0 && note.step < api.STEP_COUNT, '步进夹进小节')
  assert.ok(note.pitch >= 36 && note.pitch <= 96, '音高夹进 C2–C7')
  assert.ok(note.length >= 1 && note.length <= 16, '时值 1–16 步')
  assert.ok(note.velocity >= 0 && note.velocity <= 127, '力度 0–127')
  assert.equal(project.ui.snap, '1/16', '非法吸附档位回退 1/16')
})

check('normalizeProject 丢弃脏音符', function () {
  const project = api.normalizeProject({ notes: [null, 'x', 42, { track: 0, step: 0, pitch: 36, length: 1 }] })
  assert.equal(project.notes.length, 1, '只保留唯一合法的音符对象')
})

check('normalizeProject 保留合法工程', function () {
  const raw = {
    version: 1,
    bpm: 140,
    tracks: [{ name: '自定义', engine: 'synth', pitch: 60 }],
    notes: [{ id: 'keep-me', track: 0, step: 8, pitch: 40, length: 3, velocity: 77 }],
    fx: { drive: 0.3 },
    ui: { snap: '1/8', selectedTrack: 2 },
  }
  const project = api.normalizeProject(raw)
  assert.equal(project.bpm, 140)
  assert.equal(project.tracks.length, api.TRACK_COUNT, '轨道补齐到 16 条')
  assert.equal(project.tracks[0].name, '自定义', '用户改名保留')
  assert.equal(project.notes[0].id, 'keep-me', '音符 id 保留')
  assert.equal(project.notes[0].velocity, 77)
  assert.equal(project.ui.snap, '1/8')
  assert.equal(project.ui.selectedTrack, 2)
})

// ---------------------------------------------------------------------------
// 5. 出厂工程：默认选中 Bass 1，且带可见的示例节奏
// ---------------------------------------------------------------------------
check('默认工程有内容', function () {
  const project = api.defaultProject()
  assert.equal(project.ui.selectedTrack, 4, '默认选中 Bass 1')
  assert.ok(project.notes.length >= 8, '示例节奏音符数')
  const kick = project.notes.filter(function (note) {
    return note.track === 0
  })
  assert.deepEqual(
    kick.map(function (note) {
      return note.step
    }),
    [0, 4, 8, 12],
    '四四拍底鼓落在 1 / 5 / 9 / 13 步',
  )
  const ids = new Set(
    project.notes.map(function (note) {
      return note.id
    }),
  )
  assert.equal(ids.size, project.notes.length, '音符 id 唯一')
})

check('默认轨道表', function () {
  const tracks = api.defaultTracks()
  assert.equal(tracks.length, api.TRACK_COUNT)
  assert.equal(tracks[0].engine, 'kick')
  assert.equal(tracks[4].engine, 'bass')
  assert.equal(tracks[4].pitch, 48, 'Bass 1 默认 C3')
  assert.equal(tracks[15].engine, 'synth')
})

// ---------------------------------------------------------------------------
// 6. 混响阻尼：默认 75%、衰减约 2s，且映射出的截止频率落在 2–4kHz
// ---------------------------------------------------------------------------
check('默认混响参数干净好弹', function () {
  const fx = api.defaultFx()
  assert.equal(fx.damping, 0.75, '默认阻尼 75%')
  assert.ok(fx.decay >= 1.8 && fx.decay <= 2.2, '默认 decay 在 1.8–2.2s，实际 ' + String(fx.decay))
  assert.ok(fx.reverbWet > 0 && fx.reverbWet < 1, '湿量在中间位置')
  assert.equal(api.defaultProject().fx.damping, 0.75, '出厂工程同样带 75% 阻尼')
})

check('阻尼映射到低通截止频率', function () {
  assert.equal(api.dampingCutoff(0), api.DAMPING_OPEN_HZ, '0% 时全开')
  assert.equal(api.dampingCutoff(1), api.DAMPING_CLOSED_HZ, '100% 时收到 1.2kHz')
  const atDefault = api.dampingCutoff(0.75)
  assert.ok(atDefault >= 2000 && atDefault <= 4000, '75% 应落在 2–4kHz，实际 ' + String(Math.round(atDefault)))
  // 单调性：阻尼越大，截止越低
  let previous = api.dampingCutoff(0)
  for (let i = 1; i <= 20; i += 1) {
    const next = api.dampingCutoff(i / 20)
    assert.ok(next < previous, '阻尼必须单调压低截止频率')
    previous = next
  }
  assert.equal(api.dampingCutoff(-1), api.DAMPING_OPEN_HZ, '负值夹到 0')
  assert.equal(api.dampingCutoff(5), api.DAMPING_CLOSED_HZ, '超过 1 夹到 100%')
})

// ---------------------------------------------------------------------------
// 7. 音符偏移：毫秒 → 秒，且不会把音符排到过去
// ---------------------------------------------------------------------------
check('offset 换算与夹紧', function () {
  assert.equal(api.OFFSET_MIN_MS, -50)
  assert.equal(api.OFFSET_MAX_MS, 50)
  assert.equal(api.offsetSeconds(0), 0)
  assert.equal(api.offsetSeconds(50), 0.05)
  assert.equal(api.offsetSeconds(-50), -0.05)
  assert.equal(api.offsetSeconds(999), 0.05, '上限夹到 +50ms')
  assert.equal(api.offsetSeconds(-999), -0.05, '下限夹到 -50ms')
})

check('offset 生效且不早于当前时间', function () {
  // 正常情况：按偏移量提前/延后
  assert.ok(Math.abs(api.noteStartSeconds(1, 50, 0) - 1.05) < 1e-9, '延后 50ms')
  assert.ok(Math.abs(api.noteStartSeconds(1, -50, 0) - 0.95) < 1e-9, '提前 50ms')
  // 提前到过去时，被 now 兜住，避免调度器把音符塞进已过去的时间点
  assert.equal(api.noteStartSeconds(0.01, -50, 0.5), 0.5)
  assert.equal(api.noteStartSeconds(2, 0, 0.5), 2)
})

// ---------------------------------------------------------------------------
// 8. 框选：矩形换算、长音交集、音高区间
// ---------------------------------------------------------------------------
function makeNote(id, track, step, pitch, length) {
  return { id: id, track: track, step: step, pitch: pitch, length: length, velocity: 100, offset: 0 }
}

check('矩形框选命中', function () {
  const notes = [
    makeNote('a', 0, 2, 48, 1),
    makeNote('b', 0, 5, 50, 4),
    makeNote('c', 0, 10, 60, 1),
    makeNote('d', 1, 3, 48, 1),
  ]
  const ids = function (rect) {
    return api.notesInRect(notes, rect).slice().sort()
  }
  // 轨道 0、步 1–8、音高 47–52：a 与 b 命中（b 起点 5，长 4 步）
  assert.deepEqual(ids({ trackFrom: 0, trackTo: 0, stepFrom: 1, stepTo: 8, pitchFrom: 47, pitchTo: 52 }), ['a', 'b'])
  // 长音部分重叠也算命中：只框住 b 的尾部（步 7–8）
  assert.deepEqual(ids({ trackFrom: 0, trackTo: 0, stepFrom: 7, stepTo: 8, pitchFrom: 49, pitchTo: 51 }), ['b'])
  // 音高范围排除 c
  assert.deepEqual(ids({ trackFrom: 0, trackTo: 0, stepFrom: 9, stepTo: 12, pitchFrom: 47, pitchTo: 52 }), [])
  // 跨轨道：包含轨道 1 的 d
  assert.deepEqual(ids({ trackFrom: 0, trackTo: 1, stepFrom: 1, stepTo: 8, pitchFrom: 47, pitchTo: 52 }), ['a', 'b', 'd'])
  // 不给音高区间时只按 步/轨 过滤
  assert.deepEqual(ids({ trackFrom: 0, trackTo: 0, stepFrom: 0, stepTo: 64 }), ['a', 'b', 'c'])
})

check('整体移动音符', function () {
  const note = makeNote('x', 3, 5, 50, 2)
  const moved = api.moveNoteTo(note, 7, 5)
  assert.equal(moved.step, 7)
  assert.equal(moved.track, 5)
  assert.equal(note.step, 5, '不修改原对象')
  assert.equal(api.moveNoteTo(note, -10, -4).step, 0, '负数夹到 0')
  assert.equal(api.moveNoteTo(note, -10, -4).track, 0)
  assert.equal(api.moveNoteTo(note, 999, 99).step, api.TOTAL_STEPS - 1, '不越出 4 小节')
  assert.equal(api.moveNoteTo(note, 999, 99).track, api.TRACK_COUNT - 1)
})

// ---------------------------------------------------------------------------
// 9. 效果器分层：Master → 轨道 → 音符
// ---------------------------------------------------------------------------
check('效果器分层覆盖', function () {
  const project = api.defaultProject()
  const master = api.defaultFx()
  const trackFx = api.trackFx(project, 4)
  assert.equal(trackFx.drive, master.drive, '轨道初始继承 Master')

  const note = project.notes.find(function (item) {
    return item.track === 4
  })
  assert.ok(note !== undefined, '示例节奏里应有贝斯音符')
  assert.equal(api.hasFxOverride(note), false, '默认没有覆盖')
  assert.equal(api.noteFx(project, note).drive, trackFx.drive, '无覆盖时等于轨道值')

  // 逐层覆盖：音符字段优先于轨道，轨道优先于 Master
  const layered = api.resolveFx(master, { drive: 0.5 }, { drive: 0.9, cutoff: 800 })
  assert.equal(layered.drive, 0.9)
  assert.equal(layered.cutoff, 800)
  assert.equal(layered.decay, master.decay, '未覆盖字段保留 Master 值')

  const withOverride = Object.assign({}, note, { fxOverrides: { cutoff: 900 } })
  assert.equal(api.hasFxOverride(withOverride), true)
  assert.equal(api.noteFx(project, withOverride).cutoff, 900)
  assert.equal(api.noteFx(project, withOverride).drive, trackFx.drive, '未覆盖字段继承轨道')
})

check('normalizeFx 与 fxOverrides 解析', function () {
  const base = api.defaultFx()
  const fixed = api.normalizeFx({ drive: 5, cutoff: -1, damping: 'abc' }, base)
  assert.equal(fixed.drive, 1, 'drive 上限夹到 1')
  assert.equal(fixed.cutoff, 20, 'cutoff 下限夹到 20Hz')
  assert.equal(fixed.damping, base.damping, '非数字回退到 fallback')
  assert.equal(api.normalizeFx(null, base).drive, base.drive, 'null 回退')

  assert.equal(api.parseFxOverrides(undefined), undefined, '没有覆盖时保持 undefined')
  assert.equal(api.parseFxOverrides({}), undefined, '空对象视为没有覆盖')
  assert.deepEqual(api.parseFxOverrides({ cutoff: 900, junk: 1 }), { cutoff: 900 }, '只保留合法字段')
  assert.deepEqual(api.parseFxOverrides({ cutoff: 999999 }), { cutoff: 20000 }, '越界值被夹紧')
})

// ---------------------------------------------------------------------------
// 10. 旧工程兼容：没有 offset / fxOverrides 也能正常加载
// ---------------------------------------------------------------------------
check('旧工程向下兼容', function () {
  const legacy = {
    version: 1,
    bpm: 128,
    tracks: [],
    notes: [{ id: 'old', track: 4, step: 2, pitch: 48, length: 2, velocity: 90 }],
    ui: { snap: '1/8', selectedTrack: 4 },
  }
  const project = api.normalizeProject(legacy)
  const note = project.notes[0]
  assert.equal(note.offset, 0, '缺 offset 时补 0')
  assert.equal(note.fxOverrides, undefined, '缺 fxOverrides 时不伪造覆盖')
  assert.equal(project.notes.length, 1)
  assert.equal(project.bpm, 128)
  // 音符级 fx 也要在 64 步范围内
  assert.ok(note.step < api.TOTAL_STEPS)
})

console.log('core ok：' + String(checks) + ' 组断言全部通过')
