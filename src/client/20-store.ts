/**
 * 编辑器单例状态：不可变快照 + 订阅者集合。
 *
 * 面板可能在多处挂载（斜杠命令、侧边栏按钮、overlay 窗口），因此状态必须活在
 * 模块作用域而不是某个 React 组件里；组件通过 useSyncExternalStore 订阅。
 */

let dawState: DawState = {
  project: defaultProject(),
  open: false,
  playing: false,
  cursor: -1,
  status: '就绪',
  toast: null,
  focusSeq: 0,
  audioState: 'idle',
  exporting: false,
  selection: [],
  fxScope: { kind: 'master' },
  page: 0,
}

const dawSubscribers = new Set<() => void>()
/** 自动保存定时器句柄。 */
let autosaveTimer: ReturnType<typeof setTimeout> | null = null
/** 提示消息序号，用于丢弃过期的隐藏定时器。 */
let toastSeq = 0

/** 发布一次快照变更。 */
function emitDaw(): void {
  dawSubscribers.forEach(function (listener) {
    listener()
  })
}

function getDawState(): DawState {
  return dawState
}

function subscribeDaw(listener: () => void): () => void {
  dawSubscribers.add(listener)
  return function () {
    dawSubscribers.delete(listener)
  }
}

/** 浅合并补丁；字段未变化时不触发渲染。 */
function patchDaw(patch: Partial<DawState>): void {
  let changed = false
  for (const key of Object.keys(patch) as (keyof DawState)[]) {
    if (dawState[key] !== patch[key]) {
      changed = true
      break
    }
  }
  if (!changed) return
  dawState = Object.assign({}, dawState, patch)
  emitDaw()
}

/** 以不可变方式替换工程，并顺手触发节流自动保存。 */
function updateProject(mutator: (project: ProjectFile) => ProjectFile): void {
  const next = mutator(dawState.project)
  if (next === dawState.project) return
  dawState = Object.assign({}, dawState, { project: next })
  emitDaw()
  scheduleAutosave()
}

/** React 侧读取快照。 */
function useDaw(): DawState {
  return React.useSyncExternalStore(subscribeDaw, getDawState, getDawState)
}

/** 节流 1 秒写入 IndexedDB；写入失败只提示，不阻塞编辑。 */
function scheduleAutosave(): void {
  if (autosaveTimer !== null) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(function () {
    autosaveTimer = null
    flushAutosave()
  }, AUTOSAVE_DELAY_MS)
}

/** 立即把当前工程写入 IndexedDB（关闭/卸载时调用）。 */
function flushAutosave(): void {
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
  saveProjectRecord(dawState.project).then(
    function () {
      patchDaw({ status: '已保存到本地库' })
    },
    function (error: unknown) {
      logDaw('warn', '自动保存失败', error)
      patchDaw({ status: '自动保存失败' })
    },
  )
}

/** 统一日志出口；宿主未注入 logger 时退回 console。 */
function logDaw(level: 'info' | 'warn' | 'error', message: string, detail?: unknown): void {
  const logger = dawLogger
  if (logger !== null) {
    logger[level](message, detail)
    return
  }
  const target = level === 'info' ? console.log : level === 'warn' ? console.warn : console.error
  target('[pulseforge] ' + message, detail ?? '')
}

/** 由 apply() 注入的 logger('pulseforge')。 */
let dawLogger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void } | null = null

// ---------------------------------------------------------------------------
// 动作：工程参数
// ---------------------------------------------------------------------------

function setBpm(bpm: number): void {
  const value = clampInt(bpm, BPM_MIN, BPM_MAX)
  updateProject(function (project) {
    return Object.assign({}, project, { bpm: value })
  })
  applyEngineBpm(value)
  patchDaw({ status: 'BPM ' + value })
}

function setSnap(snap: SnapValue): void {
  updateProject(function (project) {
    return Object.assign({}, project, { ui: Object.assign({}, project.ui, { snap: snap }) })
  })
}

function selectTrack(track: number): void {
  const value = clampInt(track, 0, TRACK_COUNT - 1)
  updateProject(function (project) {
    return Object.assign({}, project, { ui: Object.assign({}, project.ui, { selectedTrack: value }) })
  })
}

/** 翻页：只影响显示，不动音符数据（step 是绝对步数）。 */
function setPage(page: number): void {
  const value = clampInt(page, 0, BAR_COUNT - 1)
  if (value === dawState.page) return
  patchDaw({ page: value, status: '第 ' + (value + 1) + ' / ' + BAR_COUNT + ' 小节' })
}

/** 当前页的起止步（闭区间），音序器与卷帘都用它换算显示坐标。 */
function pageRange(page: number): { from: number; to: number } {
  const index = clampInt(page, 0, BAR_COUNT - 1)
  return { from: index * STEP_COUNT, to: index * STEP_COUNT + STEP_COUNT - 1 }
}

// ---------------------------------------------------------------------------
// 动作：选区
// ---------------------------------------------------------------------------

/** 整体替换选区并去重；空数组即取消选中。 */
function selectNotes(ids: string[]): void {
  const unique: string[] = []
  for (const id of ids) {
    if (unique.indexOf(id) < 0) unique.push(id)
  }
  if (unique.length === dawState.selection.length && unique.every(function (id, index) {
    return dawState.selection[index] === id
  })) {
    return
  }
  patchDaw({ selection: unique })
}

function toggleNoteSelection(id: string): void {
  const exists = dawState.selection.indexOf(id) >= 0
  selectNotes(exists ? dawState.selection.filter(function (item) {
    return item !== id
  }) : dawState.selection.concat([id]))
}

function clearSelection(): void {
  if (dawState.selection.length === 0) return
  patchDaw({ selection: [], fxScope: dawState.fxScope.kind === 'note' ? { kind: 'master' } : dawState.fxScope })
}

// ---------------------------------------------------------------------------
// 动作：音符
// ---------------------------------------------------------------------------

/** 网格点击：该步已有音符则删除，否则按轨道默认音高写入一个 1 步音符。 */
function toggleStepNote(trackIndex: number, stepIndex: number): boolean {
  const track = trackAt(dawState.project, trackIndex)
  const step = clampInt(stepIndex, 0, TOTAL_STEPS - 1)
  const existing = dawState.project.notes.find(function (note) {
    return note.track === track.id && note.step === step
  })
  if (existing !== undefined) {
    removeNote(existing.id)
    return false
  }
  addNote({
    id: uid('note'),
    track: track.id,
    step: step,
    pitch: track.pitch,
    length: 1,
    velocity: 100,
    offset: 0,
  })
  return true
}

/**
 * 涂抹 / 擦除（Alt 或 Ctrl 拖拽时调用）。
 *
 * mode 由手势起点那一格的状态决定：从空格开始就是「画」，从实心格开始就是「擦」；
 * 与单击不同，这里只做单向操作，不会在同一手势里反复增删。
 */
function paintStep(trackIndex: number, stepIndex: number, mode: 'add' | 'remove'): boolean {
  const track = trackAt(dawState.project, trackIndex)
  const step = clampInt(stepIndex, 0, TOTAL_STEPS - 1)
  const existing = dawState.project.notes.find(function (note) {
    return note.track === track.id && note.step === step
  })
  if (mode === 'remove') {
    if (existing === undefined) return false
    removeNote(existing.id)
    return true
  }
  if (existing !== undefined) return false
  addNote({
    id: uid('note'),
    track: track.id,
    step: step,
    pitch: track.pitch,
    length: 1,
    velocity: 100,
    offset: 0,
  })
  return true
}

function addNote(note: NoteSpec): void {
  updateProject(function (project) {
    return Object.assign({}, project, { notes: project.notes.concat([note]) })
  })
}

function removeNote(id: string): void {
  updateProject(function (project) {
    return Object.assign({}, project, {
      notes: project.notes.filter(function (note) {
        return note.id !== id
      }),
    })
  })
  if (dawState.selection.indexOf(id) >= 0) {
    selectNotes(dawState.selection.filter(function (item) {
      return item !== id
    }))
  }
  if (dawState.fxScope.kind === 'note' && dawState.fxScope.note === id) {
    patchDaw({ fxScope: { kind: 'master' } })
  }
}

/** 删除当前选中的所有音符（Delete / Backspace）。 */
function removeSelectedNotes(): number {
  const ids = dawState.selection
  if (ids.length === 0) return 0
  updateProject(function (project) {
    return Object.assign({}, project, {
      notes: project.notes.filter(function (note) {
        return ids.indexOf(note.id) < 0
      }),
    })
  })
  patchDaw({ selection: [], fxScope: { kind: 'master' }, status: '已删除 ' + ids.length + ' 个音符' })
  return ids.length
}

/** 清空整首曲子（顶栏「清空音序」按钮，调用前已二次确认）。 */
function clearAllNotes(): void {
  updateProject(function (project) {
    return Object.assign({}, project, { notes: [] })
  })
  patchDaw({ selection: [], fxScope: { kind: 'master' }, status: '已清空全部音符' })
}

/**
 * 整体移动一批音符：dx 为步数增量，dy 为轨道增量。
 *
 * 每个音符都以「移动前的位置」为基准，因此连续拖动不会累积漂移；
 * 任一音符越界时按整批能移动的最大幅度收敛，保证相对位置不变。
 */
function moveNotes(ids: string[], dx: number, dy: number, base?: NoteSpec[]): void {
  const source = base ?? dawState.project.notes.filter(function (note) {
    return ids.indexOf(note.id) >= 0
  })
  if (source.length === 0) return
  let stepDelta = Math.round(dx)
  let trackDelta = Math.round(dy)
  for (const note of source) {
    if (stepDelta < 0) stepDelta = Math.max(stepDelta, -note.step)
    if (stepDelta > 0) stepDelta = Math.min(stepDelta, TOTAL_STEPS - 1 - note.step)
    if (trackDelta < 0) trackDelta = Math.max(trackDelta, -note.track)
    if (trackDelta > 0) trackDelta = Math.min(trackDelta, TRACK_COUNT - 1 - note.track)
  }
  if (stepDelta === 0 && trackDelta === 0) return
  const targets = new Map<string, { step: number; track: number }>()
  for (const note of source) {
    targets.set(note.id, { step: note.step + stepDelta, track: note.track + trackDelta })
  }
  updateProject(function (project) {
    return Object.assign({}, project, {
      notes: project.notes.map(function (note) {
        const target = targets.get(note.id)
        return target === undefined ? note : Object.assign({}, note, target)
      }),
    })
  })
}

function updateNote(id: string, changes: Partial<NoteSpec>): void {
  updateProject(function (project) {
    return Object.assign({}, project, {
      notes: project.notes.map(function (note) {
        return note.id === id ? Object.assign({}, note, changes) : note
      }),
    })
  })
}

/** 给选中的音符统一加一个毫秒偏移（[ / ] 快捷键）。 */
function nudgeSelection(deltaMs: number): void {
  const ids = dawState.selection
  if (ids.length === 0) return
  updateProject(function (project) {
    return Object.assign({}, project, {
      notes: project.notes.map(function (note) {
        if (ids.indexOf(note.id) < 0) return note
        return Object.assign({}, note, {
          offset: clamp(note.offset + deltaMs, OFFSET_MIN_MS, OFFSET_MAX_MS),
        })
      }),
    })
  })
  const sample = dawState.project.notes.find(function (note) {
    return ids.indexOf(note.id) >= 0
  })
  if (sample !== undefined) patchDaw({ status: '偏移 ' + Math.round(sample.offset) + 'ms' })
}

function setNoteOffset(id: string, offset: number): void {
  updateNote(id, { offset: clamp(offset, OFFSET_MIN_MS, OFFSET_MAX_MS) })
}

// ---------------------------------------------------------------------------
// 动作：效果器作用域
// ---------------------------------------------------------------------------

function setFxScope(scope: FxScope): void {
  patchDaw({ fxScope: scope })
}

/** 当前作用域下生效的参数（Master / 轨道 / 音符三层解析后的结果）。 */
function scopedFx(state: DawState): FxState {
  const scope = state.fxScope
  if (scope.kind === 'note' && scope.note !== undefined) {
    const note = state.project.notes.find(function (item) {
      return item.id === scope.note
    })
    if (note !== undefined) return noteFx(state.project, note)
  }
  if (scope.kind === 'track') return trackFx(state.project, scope.track ?? 0)
  return state.project.fx
}

/**
 * 写入效果器参数。
 *
 * Master 写 project.fx；轨道写 tracks[i].fx（整份替换，保证字段完整）；
 * 音符写 fxOverrides，只覆盖本次改动的字段，其余继承轨道。
 */
function setFx(changes: Partial<FxState>): void {
  const scope = dawState.fxScope
  updateProject(function (project) {
    if (scope.kind === 'track') {
      const index = clampInt(scope.track ?? 0, 0, TRACK_COUNT - 1)
      return Object.assign({}, project, {
        tracks: project.tracks.map(function (track) {
          return track.id === index
            ? Object.assign({}, track, { fx: normalizeFx(Object.assign({}, track.fx, changes), track.fx) })
            : track
        }),
      })
    }
    if (scope.kind === 'note' && scope.note !== undefined) {
      return Object.assign({}, project, {
        notes: project.notes.map(function (note) {
          if (note.id !== scope.note) return note
          return Object.assign({}, note, {
            fxOverrides: parseFxOverrides(Object.assign({}, note.fxOverrides ?? {}, changes)),
          })
        }),
      })
    }
    return Object.assign({}, project, { fx: normalizeFx(Object.assign({}, project.fx, changes), project.fx) })
  })
  applyEngineFx()
}

/** 清除某个音符的效果覆盖（恢复继承轨道参数）。 */
function clearNoteFx(id: string): void {
  updateProject(function (project) {
    return Object.assign({}, project, {
      notes: project.notes.map(function (note) {
        return note.id === id ? Object.assign({}, note, { fxOverrides: undefined }) : note
      }),
    })
  })
  applyEngineFx()
  patchDaw({ status: '已恢复轨道默认参数' })
}

function updateTrack(id: number, changes: Partial<TrackSpec>): void {
  updateProject(function (project) {
    return Object.assign({}, project, {
      tracks: project.tracks.map(function (track) {
        return track.id === id ? Object.assign({}, track, changes) : track
      }),
    })
  })
}

function setStatus(text: string): void {
  patchDaw({ status: text })
}

/** 弹出一条 2.4 秒后自动消失的提示。 */
function showToast(text: string, kind: 'info' | 'warn'): void {
  toastSeq += 1
  const id = toastSeq
  patchDaw({ toast: { id: id, text: text, kind: kind } })
  setTimeout(function () {
    if (dawState.toast !== null && dawState.toast.id === id) patchDaw({ toast: null })
  }, 2400)
}

// ---------------------------------------------------------------------------
// 打开 / 聚焦 / 关闭
// ---------------------------------------------------------------------------

/** 打开编辑器并载入上次工程（不存在则用出厂工程）。 */
function openDaw(): void {
  if (dawState.open) {
    focusDaw()
    return
  }
  patchDaw({ open: true, status: '正在打开编辑器…', focusSeq: dawState.focusSeq + 1 })
  loadProjectRecord().then(
    function (record) {
      if (record !== null) {
        dawState = Object.assign({}, dawState, { project: normalizeProject(record) })
        emitDaw()
        patchDaw({ status: '已载入上次工程' })
      } else {
        patchDaw({ status: '新建工程' })
      }
    },
    function (error: unknown) {
      logDaw('warn', '读取本地工程失败，使用新建工程', error)
      patchDaw({ status: '本地工程读取失败，已新建' })
    },
  )
}

/** 已打开时把焦点收回面板（/pulseforge 二次调用走这里）。 */
function focusDaw(): void {
  if (!dawState.open) {
    openDaw()
    return
  }
  patchDaw({ focusSeq: dawState.focusSeq + 1, status: '编辑器已获得焦点' })
}

/** 关闭编辑器：停播、写入最终工程、释放音频与定时器。 */
function closeDaw(): void {
  if (!dawState.open) return
  stopPlayback()
  flushAutosave()
  disposeAudioEngine()
  patchDaw({ open: false, playing: false, cursor: -1, selection: [] })
}

// ---------------------------------------------------------------------------
// 传输控制
// ---------------------------------------------------------------------------

function togglePlayback(): void {
  if (dawState.playing) {
    stopPlayback()
    return
  }
  startPlayback()
}

function startPlayback(): void {
  const started = startAudioEngine()
  if (!started) {
    showToast('音频尚未解锁：请先点击一次面板或按空格', 'warn')
    patchDaw({ status: '音频上下文被浏览器挂起' })
    return
  }
  patchDaw({ playing: true, status: '播放中' })
}

function stopPlayback(): void {
  stopAudioEngine()
  patchDaw({ playing: false, cursor: -1, status: '已停止' })
}

/** 播放时的光标推进（由音频引擎按音频时钟回调）。 */
function setPlayCursor(step: number): void {
  const page = stepToPage(step)
  if (dawState.cursor === step && dawState.page === page) return
  patchDaw({ cursor: step, page: dawState.playing ? page : dawState.page })
}

/** 音频上下文状态变化回写到状态栏。 */
function setAudioStateLabel(label: string): void {
  patchDaw({ audioState: label })
}
