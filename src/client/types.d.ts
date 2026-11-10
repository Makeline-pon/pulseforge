/**
 * PulseForge 客户端共享类型声明。
 *
 * 这些声明是「全局脚本」形式：客户端源码分片在构建时被拼接进同一个函数作用域，
 * 因此类型也必须是全局可见的，才能与运行期的作用域保持一致。
 */

/** 合成引擎种类。鼓组三类为一次性噪声/正弦打击，贝斯与合成器为持续音。 */
type EngineName = 'kick' | 'snare' | 'hat' | 'bass' | 'synth'

/** 振幅包络：attack/decay/release 单位为秒，sustain 为 0–1 的比例。 */
interface AdsrSpec {
  attack: number
  decay: number
  sustain: number
  release: number
}

/** 一条轨道：音色参数 + 默认音高 + 混音状态。 */
interface TrackSpec {
  id: number
  name: string
  engine: EngineName
  wave: OscillatorType
  gain: number
  muted: boolean
  /** 网格点击时写入的默认 MIDI 音高（鼓组忽略此值）。 */
  pitch: number
  adsr: AdsrSpec
  /** 轨道级效果器：覆盖全局 Master 后作为该轨的链路参数。 */
  fx: FxState
}

/**
 * 一个音符：step 为绝对步数（0–63，4 小节 × 16 步），pitch 为 MIDI 音高，
 * length 为步数，offset 为毫秒级的时序微调（-50–50）。
 */
interface NoteSpec {
  id: string
  track: number
  step: number
  pitch: number
  length: number
  velocity: number
  /** 单音符时序微调（毫秒）：正数延后触发，负数提前。 */
  offset: number
  /** 单音符效果器覆盖：只写需要偏离轨道默认值的字段。 */
  fxOverrides?: Partial<FxState>
}

/** 主输出效果链（失真 → 低通 → 延迟 → 混响）的完整参数。 */
interface FxState {
  drive: number
  cutoff: number
  resonance: number
  delayMs: number
  feedback: number
  delayWet: number
  decay: number
  /** 混响阻尼 0–1：越大，混响尾音里的高频越快被吸收。 */
  damping: number
  reverbWet: number
}

/** 吸附粒度：1/4 = 4 步，1/8 = 2 步，1/16 = 1 步。 */
type SnapValue = '1/4' | '1/8' | '1/16'

/**
 * 右侧效果面板正在编辑的目标。
 *
 * - master：全局 Master，写入 `project.fx`，作用于所有轨道；
 * - track：单条轨道，写入 `tracks[i].fx`，覆盖 Master；
 * - note：单个音符，写入 `note.fxOverrides`，只覆盖该音符。
 */
interface FxScope {
  kind: 'master' | 'track' | 'note'
  /** kind === 'track' 时的轨道下标。 */
  track?: number
  /** kind === 'note' 时的音符 id。 */
  note?: string
}

/** 与工程一起持久化的界面状态。 */
interface UiState {
  snap: SnapValue
  selectedTrack: number
}

/** 工程 JSON 的完整结构，与导出文件、IndexedDB 记录一一对应。 */
interface ProjectFile {
  version: number
  bpm: number
  tracks: TrackSpec[]
  notes: NoteSpec[]
  fx: FxState
  ui: UiState
}

/** 一条短暂提示。 */
interface ToastMessage {
  id: number
  text: string
  kind: 'info' | 'warn'
}

/** 编辑器单例状态；不可变更新，供 useSyncExternalStore 做引用比较。 */
interface DawState {
  project: ProjectFile
  open: boolean
  playing: boolean
  /** 当前播放到的步进；-1 表示停止。 */
  cursor: number
  status: string
  toast: ToastMessage | null
  /** 每次 /pulseforge 聚焦请求自增，窗口据此把焦点移回面板。 */
  focusSeq: number
  audioState: string
  /** 离线渲染进行中：用于禁用导出按钮并提示进度。 */
  exporting: boolean
  /** 当前选中的音符 id 列表（框选、Shift 点选都会写入这里）。 */
  selection: string[]
  /** 右侧效果面板正在编辑的目标。 */
  fxScope: FxScope
  /** 音序器当前显示的小节（0–3）。 */
  page: number
}

/** 一条变更记录：kind 决定角标文字与配色。 */
interface ChangelogItem {
  kind: 'feat' | 'fix' | 'chore'
  text: string
}

/** 一个版本的更新内容；数组本身按「新 → 旧」排列。 */
interface ChangelogEntry {
  version: string
  date: string
  items: ChangelogItem[]
}

/** 由 ModuleLoader 注入的 React 与 createElement 快捷方式。 */
declare const React: typeof import('react')
declare const h: any

/**
 * React 事件的全局别名。
 *
 * 客户端源码是「全局脚本」形态（构建时拼接进同一个函数作用域），不能用
 * `import * as React` 引入命名空间，因此这里用 `import('react')` 的类型查询
 * 暴露事件类型，供组件签名使用。
 */
type ReactPointer<T = Element> = import('react').PointerEvent<T>
type ReactDrag<T = Element> = import('react').DragEvent<T>
type ReactMouse<T = Element> = import('react').MouseEvent<T>
type ReactChange<T = Element> = import('react').ChangeEvent<T>
type ReactFocus<T = Element> = import('react').FocusEvent<T>
