/**
 * 纯函数层：网格几何、音高换算、工程默认值与工程 JSON 归一化。
 *
 * 本文件不接触 DOM、Web Audio 与宿主 API，因此可以在测试中被单独求值。
 */

/** 轨道数：16 轨，每小节 16 步。 */
const TRACK_COUNT = 16
/** 每小节步进数。 */
const STEP_COUNT = 16
/** 小节数：1–4 小节，共 64 步（数据模型的 step 是绝对步数）。 */
const BAR_COUNT = 4
/** 一整个工程的步数上限。 */
const TOTAL_STEPS = STEP_COUNT * BAR_COUNT
/** 单音符时序微调区间（毫秒）。 */
const OFFSET_MIN_MS = -50
const OFFSET_MAX_MS = 50
/** 音高范围 C2–C7（MIDI 36–96，共 61 键）。 */
const PITCH_LOW = 36
const PITCH_HIGH = 96
const PITCH_COUNT = PITCH_HIGH - PITCH_LOW + 1
/** BPM 合法区间与导出上限。 */
const BPM_MIN = 60
const BPM_MAX = 200
const MAX_EXPORT_SECONDS = 8 * 60
/** 音符时长区间，单位为步。 */
const NOTE_MIN_STEPS = 1
const NOTE_MAX_STEPS = 16
/** 工程格式版本。 */
const PROJECT_VERSION = 1
/** 保存节流窗口（毫秒）。 */
const AUTOSAVE_DELAY_MS = 1000
/** 插件版本号：必须与 package.json 的 version 一致（发布时同步修改）。 */
const PLUGIN_VERSION = '1.0.0'

/**
 * 更新日志：按「新 → 旧」排列，第一条即当前版本。
 *
 * 只记录用户可感知的变化，内部重构不写进来；每条 kind 用于状态栏弹窗的
 * 彩色角标（feat 新增 / fix 修复 / chore 杂项）。
 */
const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.0.0',
    date: '2026-11-10',
    items: [
      { kind: 'fix', text: '框选在网格外松手不再丢失选区：命中判定改用按下瞬间量出的格子几何，指针坐标越界时夹到最近的格子' },
      { kind: 'fix', text: '钢琴卷帘框选同样以记录下来的起止坐标算包围盒，拖出面板外再松手也能选中' },
      { kind: 'feat', text: '正式版：音序器、钢琴卷帘、三层效果器、WAV 导出与三种分发形态（DSH 插件 / PWA / 桌面安装包）' },
    ],
  },
  {
    version: '0.9.0',
    date: '2026-11-10',
    items: [
      { kind: 'fix', text: '内存回收：voice 结束即断开节点并释放计数，AudioContext 挂起时也有兜底回收' },
      { kind: 'fix', text: '所有延迟回调登记进统一计时器集合，停止播放与卸载时全部清空，不再堆积僵尸节点' },
      { kind: 'feat', text: '框选改为 window 级指针监听：拖出面板再拖回仍连续，选区框实时跟随并高亮命中格子' },
      { kind: 'feat', text: '控制台可用 __pfAudioStats() / __pfLogAudioStats() 查看存活 voice、借出链与计时器数量' },
    ],
  },
  {
    version: '0.8.0',
    date: '2026-11-10',
    items: [
      { kind: 'feat', text: '安装器版本核对：旧版本提示「是否更新至当前版本」，同版本或更高版本提示「已是最新版本」' },
      { kind: 'feat', text: '构建产物新增 version.json，安装目录与 PWA 共用同一份版本身份（含构建哈希）' },
      { kind: 'feat', text: 'PWA 运行时轮询 version.json，发现服务器版本变新就弹「发现新版本，点击刷新更新」' },
      { kind: 'fix', text: '版本清单绕过 Service Worker 缓存，避免永远比不出新版本' },
    ],
  },
  {
    version: '0.7.0',
    date: '2026-11-10',
    items: [
      { kind: 'feat', text: 'GitHub Actions 发布流：推送 v* 标签自动测试、构建并发布安装包' },
      { kind: 'feat', text: '新增 release/ 分发包：安装程序 + 源码压缩包 + SHA256 校验清单' },
      { kind: 'chore', text: 'README 重写为开源项目门面：下载安装、快捷键指南、开发构建' },
    ],
  },
  {
    version: '0.6.0',
    date: '2026-11-10',
    items: [
      { kind: 'feat', text: 'Windows 安装包：NSIS 钩子实现旧版本检测、损坏自动清理与覆盖安装确认' },
      { kind: 'feat', text: '安装前校验目标磁盘剩余空间（低于 150MB 直接中止并清理临时文件）' },
      { kind: 'feat', text: '安装 / 卸载会写入 PulseForge 注册表标记，卸载时可选择保留本地作品数据' },
      { kind: 'feat', text: 'PWA 增量更新：新版本就绪时右下角轻提示「点击刷新更新」，不再强制刷新' },
      { kind: 'chore', text: '安装目录附带 package.json 清单，安装器据此判断目录是否完整' },
    ],
  },
  {
    version: '0.5.0',
    date: '2026-11-10',
    items: [
      { kind: 'feat', text: '音序器左上角新增快捷键图例，格子上悬停也会提示 Shift 框选与 Alt 涂抹' },
      { kind: 'feat', text: '音符偏移可视化：音序器格子下沿的短线、钢琴卷帘的位移与原始网格线' },
      { kind: 'feat', text: '单音符独立效果器并发达到上限时用 toast 说明降级原因，不再静默' },
      { kind: 'feat', text: '新增 npm run build:release，一次产出 dist-plugin 与 dist-pwa 两个目录' },
      { kind: 'feat', text: '新增 Tauri 桌面外壳（src-tauri），可打包成独立的 Windows 应用' },
      { kind: 'chore', text: '版本号以 package.json 为唯一来源，注入插件补丁、service worker 与 tauri.conf.json' },
    ],
  },
  {
    version: '0.4.0',
    date: '2026-11-10',
    items: [
      { kind: 'feat', text: '顶栏新增「清空音序」按钮（二次确认），一键清掉全部音符' },
      { kind: 'feat', text: '音序器与钢琴卷帘支持 Shift + 拖拽框选，选中后可整体拖动' },
      { kind: 'feat', text: '涂抹 / 擦除改为 Alt（或 Ctrl）+ 左键拖拽，普通左键仍是单点切换' },
      { kind: 'feat', text: '音符新增 offset 微调（-50–+50ms），可用 [ ] 快捷键或属性面板调整' },
      { kind: 'feat', text: '支持 4 小节共 64 步，顶栏可翻页；音符 step 改为绝对步数' },
      { kind: 'feat', text: '每条轨道拥有独立效果器，单个音符还可再覆盖一层专属参数' },
      { kind: 'feat', text: '右侧面板顶部可切换 Master / 轨道 / 音符编辑目标，覆盖音符带小圆点标记' },
    ],
  },
  {
    version: '0.3.1',
    date: '2026-11-10',
    items: [
      { kind: 'feat', text: '混响新增 Damping 阻尼滑块（0–100%，默认 75%），卷积之后串联低通，高频尾音被更快吸收' },
      { kind: 'feat', text: '混响默认 Decay 由 1.4s 调整为 2.0s，配合阻尼后尾音更短更干净，音符不再糊在一起' },
      { kind: 'feat', text: '混响曲线图同时画出整体能量与高频能量，虚线标记 HF 的衰减速度' },
      { kind: 'fix', text: 'WAV 离线导出与实时播放共用同一套效果链，Damping 在导出文件中同样生效' },
    ],
  },
  {
    version: '0.3.0',
    date: '2026-11-10',
    items: [
      { kind: 'feat', text: '打开即选中 Bass 1 并预置四四拍示例节奏（底鼓 / 军鼓 / 踩镲 / 贝斯线）' },
      { kind: 'feat', text: '钢琴卷帘按选中轨自动纵向聚焦，默认停在 C3–C5 区间' },
      { kind: 'feat', text: '键盘条区分黑键与白键，每个八度的 C 加橙色分割线与小白点' },
      { kind: 'feat', text: '音序器顶部 16 步刻度标尺，4 / 8 / 12 / 16 加粗高亮' },
      { kind: 'feat', text: 'BPM 滑杆两端显示 60 / 200 极值刻度，拖动时跟随数值气泡' },
      { kind: 'chore', text: '轨道名宽度放宽到 140px，超长截断并可用 title 悬停查看全名' },
      { kind: 'chore', text: '效果器数值列右侧留 8px 间距，Q 与 Cutoff 数值严格对齐' },
      { kind: 'chore', text: '核心逻辑与宿主 ctx 彻底解耦，为 PWA 迁移预留 Web 入口' },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-11-09',
    items: [
      { kind: 'feat', text: '状态栏右下角显示版本号，点击展开本更新日志' },
      { kind: 'feat', text: '更新日志按版本从新到旧排列，标注新增 / 修复 / 杂项' },
      { kind: 'fix', text: '修复宿主半部激活失败（cannot get property "tools" without inject）' },
      { kind: 'fix', text: '面板关闭时同时移除注入的样式表，避免残留样式影响宿主界面' },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-11-09',
    items: [
      { kind: 'feat', text: '16 轨 × 16 步音序器，支持点击、拖拽涂抹与 1/4 / 1/8 / 1/16 吸附' },
      { kind: 'feat', text: '钢琴卷帘 C2–C7（61 键），拖动改音高与位置，右边缘改时值，双击改力度' },
      { kind: 'feat', text: '纯 Web Audio 合成引擎：鼓组、贝斯、三波形合成器，全部带 ADSR' },
      { kind: 'feat', text: '四路效果器串联：失真 → 低通 → 延迟 → 混响，每路带 240×60 曲线可视化' },
      { kind: 'feat', text: '离线渲染导出 44.1kHz / 16-bit / 立体声 WAV，上限 8 分钟' },
      { kind: 'feat', text: '工程 JSON 自动保存到 IndexedDB（节流 1s），并支持一键导出 JSON 备份' },
      { kind: 'feat', text: '/pulseforge 与 /daw 命令打开或聚焦面板，侧边栏底部提供入口按钮' },
    ],
  },
]

const SNAP_VALUES: SnapValue[] = ['1/4', '1/8', '1/16']
const SNAP_STEPS: Record<SnapValue, number> = { '1/4': 4, '1/8': 2, '1/16': 1 }
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const BLACK_KEYS = new Set([1, 3, 6, 8, 10])

/** 夹紧到闭区间。 */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** 夹紧为整数。 */
function clampInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max))
}

/**
 * 安全取数：把任意输入转成数字，非有限值（undefined / null / 'abc' / NaN）退回 fallback。
 *
 * 直接对坏数据调用 clamp 会把 NaN 悄悄变成下界（例如 BPM 变 60），
 * 归一化工程时必须以出厂值兜底，而不是以边界值兜底。
 */
function numOr(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 把任意步进吸附到当前粒度的整数倍，并限制在 4 小节（64 步）范围内。 */
function snapStep(step: number, snap: SnapValue): number {
  const grid = SNAP_STEPS[snap] ?? 1
  return clampInt(Math.round(step / grid) * grid, 0, TOTAL_STEPS - 1)
}

/** 绝对步数 → 所在小节（0–3）。 */
function stepToPage(step: number): number {
  return clampInt(Math.floor(step / STEP_COUNT), 0, BAR_COUNT - 1)
}

/** 毫秒偏移 → 秒（带范围夹紧），排程时直接加到音频时间轴上。 */
function offsetSeconds(offset: number): number {
  return clamp(numOr(offset, 0), OFFSET_MIN_MS, OFFSET_MAX_MS) / 1000
}

/**
 * 计算一声部的实际起始时间。
 *
 * offset 只能在音频时间轴上偏移；若负偏移把起点推到过去，则夹到 now，
 * 避免浏览器把已过去的时间点排成「立刻播放」导致听起来错位。
 */
function noteStartSeconds(when: number, offset: number, now: number): number {
  return Math.max(now, when + offsetSeconds(offset))
}

/** 一步的秒数：60 / BPM / 4（即十六分音符）。 */
function stepDuration(bpm: number): number {
  return 60 / clamp(bpm, BPM_MIN, BPM_MAX) / 4
}

/** MIDI 音高 → 频率（A4 = 440Hz）。 */
function midiToFreq(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12)
}

/** MIDI 音高 → 科学音高记号，例如 60 → C4。 */
function pitchName(pitch: number): string {
  const p = clampInt(pitch, 0, 127)
  return NOTE_NAMES[p % 12] + (Math.floor(p / 12) - 1)
}

/** 是否是黑键（用于钢琴卷帘键盘条着色）。 */
function isBlackKey(pitch: number): boolean {
  return BLACK_KEYS.has(((pitch % 12) + 12) % 12)
}

/** 生成音符/工程标识。 */
let uidCounter = 0
function uid(prefix: string): string {
  uidCounter += 1
  return prefix + '-' + Date.now().toString(36) + '-' + uidCounter.toString(36)
}

/** 16 条轨道的出厂配置：4 鼓 + 4 贝斯 + 8 合成器。 */
function defaultTracks(): TrackSpec[] {
  const tracks: TrackSpec[] = []
  const drumNames = ['底鼓 Kick', '军鼓 Snare', '闭镲 Hat', '开镲 Open Hat']
  for (let i = 0; i < 4; i += 1) {
    tracks.push({
      id: i,
      name: drumNames[i],
      engine: i === 0 ? 'kick' : i === 1 ? 'snare' : 'hat',
      wave: 'sine',
      gain: 0.9,
      muted: false,
      pitch: 36,
      adsr: { attack: 0.001, decay: 0.2, sustain: 0.2, release: 0.2 },
      fx: defaultFx(),
    })
  }
  for (let i = 4; i < 8; i += 1) {
    tracks.push({
      id: i,
      name: '贝斯 Bass ' + (i - 3),
      engine: 'bass',
      wave: 'sawtooth',
      gain: 0.7,
      muted: false,
      // Bass 1 = C3(48)、Bass 2 = A2(45)、Bass 3 = G2(43)、Bass 4 = F2(41)
      pitch: 48 - [0, 3, 5, 7][i - 4],
      adsr: { attack: 0.005, decay: 0.16, sustain: 0.55, release: 0.12 },
      fx: defaultFx(),
    })
  }
  const waves: OscillatorType[] = ['sawtooth', 'square', 'sine']
  for (let i = 8; i < TRACK_COUNT; i += 1) {
    tracks.push({
      id: i,
      name: '合成器 Synth ' + (i - 7),
      engine: 'synth',
      wave: waves[(i - 8) % waves.length],
      gain: 0.5,
      muted: false,
      pitch: 60 + ((i - 8) % 12),
      adsr: { attack: 0.01, decay: 0.2, sustain: 0.6, release: 0.3 },
      fx: defaultFx(),
    })
  }
  return tracks
}

/** 四路效果链共用的出厂参数（每条链各持一份独立节点，参数值相同）。 */
function defaultFx(): FxState {
  return {
    drive: 0.18,
    cutoff: 12000,
    resonance: 0.9,
    delayMs: 280,
    feedback: 0.3,
    delayWet: 0.18,
    // 2.0s + 75% 阻尼：尾音在两秒内收干净，高频先消失，音符不会互相糊住
    decay: 2,
    damping: 0.75,
    reverbWet: 0.16,
  }
}

/** 默认界面状态：打开即选中 Bass 1（id 4），钢琴卷帘随之聚焦 C3。 */
function defaultUi(): UiState {
  return { snap: '1/16', selectedTrack: 4 }
}

/**
 * 出厂示例节奏：四四拍底鼓 / 军鼓 / 反拍踩镲 + 一条合成贝斯线。
 *
 * 只在「首次打开、本地没有工程记录」时作为默认工程出现；一旦用户改动并保存，
 * 之后恢复的就是用户工程。音符 id 固定，避免同一工程内出现重复 key。
 */
function demoNotes(): NoteSpec[] {
  const notes: NoteSpec[] = []
  const kickSteps = [0, 4, 8, 12]
  const snareSteps = [4, 12]
  const hatSteps = [2, 6, 10, 14]
  const bassSteps = [0, 3, 6, 10, 12]
  const bassPitches = [48, 48, 45, 43, 41]
  for (const step of kickSteps) {
    notes.push({ id: 'demo-kick-' + step, track: 0, step: step, pitch: 36, length: 1, velocity: 118, offset: 0 })
  }
  for (const step of snareSteps) {
    notes.push({ id: 'demo-snare-' + step, track: 1, step: step, pitch: 38, length: 1, velocity: 104, offset: 0 })
  }
  for (const step of hatSteps) {
    notes.push({ id: 'demo-hat-' + step, track: 2, step: step, pitch: 42, length: 1, velocity: 82, offset: 0 })
  }
  for (let index = 0; index < bassSteps.length; index += 1) {
    notes.push({
      id: 'demo-bass-' + String(index),
      track: 4,
      step: bassSteps[index],
      pitch: bassPitches[index],
      length: index === bassSteps.length - 1 ? 2 : 1,
      velocity: 96,
      offset: 0,
    })
  }
  return notes
}

/** 完整的出厂工程（含示例节奏，第一眼就有内容）。 */
function defaultProject(): ProjectFile {
  return {
    version: PROJECT_VERSION,
    bpm: 120,
    tracks: defaultTracks(),
    notes: demoNotes(),
    fx: defaultFx(),
    ui: defaultUi(),
  }
}

/** 效果器参数的全部键，用于归一化与覆盖合并。 */
const FX_KEYS: (keyof FxState)[] = [
  'drive',
  'cutoff',
  'resonance',
  'delayMs',
  'feedback',
  'delayWet',
  'decay',
  'damping',
  'reverbWet',
]

/** 各字段的合法区间，归一化与覆盖写入都以此为准。 */
const FX_RANGES: Record<keyof FxState, [number, number]> = {
  drive: [0, 1],
  cutoff: [20, 20000],
  resonance: [0.1, 20],
  delayMs: [20, 1000],
  feedback: [0, 0.9],
  delayWet: [0, 1],
  decay: [0.2, 4],
  damping: [0, 1],
  reverbWet: [0, 1],
}

/** 把任意输入归一化成一份完整的效果器参数。 */
function normalizeFx(input: unknown, fallback: FxState): FxState {
  const value = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const next = {} as FxState
  for (const key of FX_KEYS) {
    const range = FX_RANGES[key]
    next[key] = clamp(numOr(value[key], fallback[key]), range[0], range[1])
  }
  return next
}

/**
 * 解析单音符的效果器覆盖：只保留确实出现且为有限数字的字段。
 *
 * 返回 undefined 表示「该音符没有覆盖」，这样 `hasFxOverride` 与 UI 的小圆点
 * 就不会因为 `{}` 这种空对象而误判。
 */
function parseFxOverrides(input: unknown): Partial<FxState> | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const value = input as Record<string, unknown>
  const result: Partial<FxState> = {}
  let count = 0
  for (const key of FX_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    const parsed = Number(value[key])
    if (!Number.isFinite(parsed)) continue
    const range = FX_RANGES[key]
    result[key] = clamp(parsed, range[0], range[1])
    count += 1
  }
  return count === 0 ? undefined : result
}

/**
 * 按 Master → 轨道 → 音符的顺序逐层覆盖，返回最终生效的完整参数。
 *
 * 后一层只覆盖自己声明过的字段，因此「只改延迟」的音符仍然继承轨道的混响。
 */
function resolveFx(...layers: (FxState | Partial<FxState> | undefined)[]): FxState {
  const result = defaultFx()
  for (const layer of layers) {
    if (layer === undefined) continue
    for (const key of FX_KEYS) {
      const value = layer[key]
      if (value === undefined || !Number.isFinite(value)) continue
      const range = FX_RANGES[key]
      result[key] = clamp(value, range[0], range[1])
    }
  }
  return result
}

/** 某条轨道最终生效的参数（Master + 轨道）。 */
function trackFx(project: ProjectFile, trackIndex: number): FxState {
  return resolveFx(project.fx, trackAt(project, trackIndex).fx)
}

/** 某个音符最终生效的参数（Master + 轨道 + 音符覆盖）。 */
function noteFx(project: ProjectFile, note: NoteSpec): FxState {
  return resolveFx(project.fx, trackAt(project, note.track).fx, note.fxOverrides)
}

/** 该音符是否有独立的参数覆盖（决定网格上的小圆点与专属链路）。 */
function hasFxOverride(note: NoteSpec): boolean {
  return note.fxOverrides !== undefined && Object.keys(note.fxOverrides).length > 0
}

/** 框选区域：轨道与步进都是闭区间，音高区间可选（钢琴卷帘用）。 */
interface SelectionRect {
  trackFrom: number
  trackTo: number
  stepFrom: number
  stepTo: number
  pitchFrom?: number
  pitchTo?: number
}

/**
 * 框选命中测试：音序器按「轨道 × 步进」判断，钢琴卷帘额外带上音高区间。
 *
 * 音符只要占据的步进区间与选区有交集就算命中（长音被框住一角即可）。
 */
function notesInRect(notes: NoteSpec[], rect: SelectionRect): string[] {
  const trackLow = Math.min(rect.trackFrom, rect.trackTo)
  const trackHigh = Math.max(rect.trackFrom, rect.trackTo)
  const stepLow = Math.min(rect.stepFrom, rect.stepTo)
  const stepHigh = Math.max(rect.stepFrom, rect.stepTo)
  const hasPitch = rect.pitchFrom !== undefined && rect.pitchTo !== undefined
  const pitchLow = hasPitch ? Math.min(rect.pitchFrom as number, rect.pitchTo as number) : 0
  const pitchHigh = hasPitch ? Math.max(rect.pitchFrom as number, rect.pitchTo as number) : 127
  const hits: string[] = []
  for (const note of notes) {
    if (note.track < trackLow || note.track > trackHigh) continue
    if (note.step > stepHigh || note.step + note.length - 1 < stepLow) continue
    if (note.pitch < pitchLow || note.pitch > pitchHigh) continue
    hits.push(note.id)
  }
  return hits
}

/** 整体移动一个音符后的新位置（不修改原对象，越界自动夹紧）。 */
function moveNoteTo(note: NoteSpec, step: number, track: number): NoteSpec {
  return Object.assign({}, note, {
    step: clampInt(step, 0, TOTAL_STEPS - 1),
    track: clampInt(track, 0, TRACK_COUNT - 1),
  })
}

/** 把未知输入归一化成一个合法工程；任何字段损坏都退回到出厂值。 */
function normalizeProject(raw: unknown): ProjectFile {
  const base = defaultProject()
  if (raw === null || typeof raw !== 'object') return base
  const input = raw as Record<string, unknown>
  const bpm = clampInt(numOr(input.bpm, base.bpm), BPM_MIN, BPM_MAX)

  const tracks: TrackSpec[] = base.tracks.map(function (fallback) {
    const list = Array.isArray(input.tracks) ? (input.tracks as unknown[]) : []
    const candidate = list[fallback.id]
    if (candidate === null || typeof candidate !== 'object') return fallback
    const t = candidate as Record<string, unknown>
    const adsrInput = (t.adsr ?? {}) as Record<string, unknown>
    const engine = t.engine
    return {
      id: fallback.id,
      name: typeof t.name === 'string' && t.name.length > 0 ? t.name.slice(0, 40) : fallback.name,
      engine:
        engine === 'kick' || engine === 'snare' || engine === 'hat' || engine === 'bass' || engine === 'synth'
          ? engine
          : fallback.engine,
      wave:
        t.wave === 'sine' || t.wave === 'square' || t.wave === 'sawtooth' || t.wave === 'triangle'
          ? t.wave
          : fallback.wave,
      gain: clamp(numOr(t.gain, fallback.gain), 0, 1),
      muted: Boolean(t.muted),
      pitch: clampInt(numOr(t.pitch, fallback.pitch), PITCH_LOW, PITCH_HIGH),
      adsr: {
        attack: clamp(numOr(adsrInput.attack, fallback.adsr.attack), 0.001, 1),
        decay: clamp(numOr(adsrInput.decay, fallback.adsr.decay), 0.01, 1),
        sustain: clamp(numOr(adsrInput.sustain, fallback.adsr.sustain), 0, 1),
        release: clamp(numOr(adsrInput.release, fallback.adsr.release), 0.01, 2),
      },
      fx: normalizeFx(t.fx, fallback.fx),
    }
  })

  const notes: NoteSpec[] = []
  const rawNotes = Array.isArray(input.notes) ? (input.notes as unknown[]) : []
  for (const item of rawNotes) {
    if (item === null || typeof item !== 'object') continue
    const n = item as Record<string, unknown>
    const step = clampInt(numOr(n.step, 0), 0, TOTAL_STEPS - 1)
    const length = clampInt(numOr(n.length, 1), NOTE_MIN_STEPS, NOTE_MAX_STEPS)
    notes.push({
      id: typeof n.id === 'string' && n.id.length > 0 ? n.id : uid('note'),
      track: clampInt(numOr(n.track, 0), 0, TRACK_COUNT - 1),
      step: step,
      pitch: clampInt(numOr(n.pitch, 60), PITCH_LOW, PITCH_HIGH),
      length: Math.min(length, TOTAL_STEPS - step),
      velocity: clampInt(numOr(n.velocity, 100), 0, 127),
      offset: clamp(numOr(n.offset, 0), OFFSET_MIN_MS, OFFSET_MAX_MS),
      fxOverrides: parseFxOverrides(n.fxOverrides),
    })
  }

  const uiInput = (input.ui ?? {}) as Record<string, unknown>
  const snap = uiInput.snap
  return {
    version: PROJECT_VERSION,
    bpm: bpm,
    tracks: tracks,
    notes: notes,
    fx: normalizeFx(input.fx, base.fx),
    ui: {
      snap: snap === '1/4' || snap === '1/8' || snap === '1/16' ? snap : base.ui.snap,
      selectedTrack: clampInt(numOr(uiInput.selectedTrack, base.ui.selectedTrack), 0, TRACK_COUNT - 1),
    },
  }
}

/** 取某一步上所有发声的音符。 */
function notesAtStep(project: ProjectFile, step: number): NoteSpec[] {
  return project.notes.filter(function (note) {
    return note.step === step
  })
}

/** 读取一条轨道；越界时回退到第 0 轨，保证渲染不崩。 */
function trackAt(project: ProjectFile, index: number): TrackSpec {
  return project.tracks[clampInt(index, 0, project.tracks.length - 1)] ?? project.tracks[0]
}
