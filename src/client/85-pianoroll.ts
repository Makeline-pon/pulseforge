/**
 * 钢琴卷帘：C2–C7 共 61 键，左侧键盘条可试听，右侧为音符编辑区。
 *
 * 仅显示「当前选中轨道」的音符，避免 16 轨音符互相压盖；从音序器拖入音符时会
 * 自动切换选中轨道，因此拖拽落点与视觉反馈始终一致。显示范围跟随音序器翻页。
 */

/** 每步的像素宽度，需与样式表中的背景网格一致。 */
const PX_PER_STEP = 40
/** 每个半音的像素高度，需与 .pf-key 的行高一致。 */
const PX_PER_KEY = 14

/** 当前双击打开力度编辑器的音符。 */
let selectedNoteId: string | null = null
let velocityEditor = false
/** 卷帘纵向滚动同步：键盘条与网格共享同一 scrollTop。 */
let rollScrollSync: { keys: HTMLElement | null; lane: HTMLElement | null } = { keys: null, lane: null }

/** 一个音符块。 */
function NoteBlock(props: {
  note: NoteSpec
  page: number
  bpm: number
  selected: boolean
  highlighted: boolean
  onDragStart: (event: ReactPointer<HTMLDivElement>) => void
  onResize: (event: ReactPointer<HTMLSpanElement>) => void
  onVelocity: () => void
  onRemove: () => void
}) {
  const note = props.note
  const top = (PITCH_HIGH - note.pitch) * PX_PER_KEY
  const visibleStep = note.step - props.page * STEP_COUNT
  /**
   * offset 的可视化：把「毫秒偏移」换算成步长的比例，再折算成像素。
   *
   * 上限压到 ±0.35 步，避免一个 50ms 的音符在 120BPM 下直接跨出去半个格子、
   * 让用户误以为它换了位置；真实时间关系由块内的竖线（原始网格线）表示。
   */
  const stepMs = stepDuration(props.bpm) * 1000
  const shiftRatio = stepMs <= 0 ? 0 : note.offset / stepMs
  const shift = clamp(shiftRatio, -0.35, 0.35) * PX_PER_STEP
  const left = visibleStep * PX_PER_STEP + shift
  const width = Math.max(8, note.length * PX_PER_STEP - 2)

  return h(
    'div',
    {
      className:
        'pf-note' +
        (props.selected ? ' is-selected' : '') +
        (props.highlighted ? ' is-marquee' : '') +
        (hasFxOverride(note) ? ' is-override' : '') +
        (note.offset < 0 ? ' is-early' : note.offset > 0 ? ' is-late' : ''),
      style: { top: top + 'px', left: left + 'px', width: width + 'px' },
      role: 'button',
      tabIndex: 0,
      'aria-label': '音符 ' + pitchName(note.pitch) + ' 起点第 ' + (note.step + 1) + ' 步，时长 ' + note.length + ' 步',
      title:
        pitchName(note.pitch) +
        ' · ' +
        note.length +
        ' 步 · 力度 ' +
        note.velocity +
        (note.offset === 0 ? '' : ' · 偏移 ' + Math.round(note.offset) + 'ms') +
        (hasFxOverride(note) ? ' · 独立效果器' : ''),
      onPointerDown: props.onDragStart,
      onDoubleClick: function (event: { stopPropagation: () => void }) {
        event.stopPropagation()
        props.onVelocity()
      },
      onContextMenu: function (event: { preventDefault: () => void }) {
        event.preventDefault()
        props.onRemove()
      },
      onKeyDown: function (event: { key: string; preventDefault: () => void }) {
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault()
          props.onRemove()
        }
      },
    },
    pitchName(note.pitch) + ' ' + Math.round(note.velocity),
    note.offset === 0
      ? null
      : h('span', {
          // 原始网格线：块被平移后，这条线标出该音符「本该」开始的位置
          className: 'pf-note-origin' + (note.offset < 0 ? ' is-early' : ' is-late'),
          style: { left: -shift + 'px' },
          'aria-hidden': 'true',
        }),
    h('span', { className: 'pf-note-handle', onPointerDown: props.onResize, 'aria-hidden': 'true' }),
  )
}

/** 力度编辑浮层。 */
function VelocityEditor(props: { note: NoteSpec }) {
  return h(
    'div',
    {
      className: 'pf-btn',
      style: {
        position: 'absolute',
        right: '10px',
        top: '6px',
        zIndex: 5,
        height: 'auto',
        padding: '6px 8px',
        gap: '8px',
        cursor: 'default',
        pointerEvents: 'auto',
      },
      role: 'group',
      'aria-label': '音符力度编辑器',
    },
    h('span', { className: 'pf-label' }, '力度'),
    h('input', {
      className: 'pf-range',
      type: 'range',
      min: 0,
      max: 127,
      step: 1,
      value: props.note.velocity,
      'aria-label': '力度 0 到 127',
      style: { width: '120px' },
      onChange: function (event: { target: { value: string } }) {
        updateNote(props.note.id, { velocity: clampInt(Number(event.target.value), 0, 127) })
      },
    }),
    h('span', { className: 'pf-value' }, String(props.note.velocity)),
    h(
      'button',
      {
        type: 'button',
        className: 'pf-btn pf-icon-btn',
        'aria-label': '关闭力度编辑器',
        onClick: function () {
          velocityEditor = false
          emitDaw()
        },
      },
      '×',
    ),
  )
}

/** 卷帘整体。 */
function PianoRoll(props: { state: DawState }) {
  const project = props.state.project
  const page = props.state.page
  const range = pageRange(page)
  const trackIndex = project.ui.selectedTrack
  const track = trackAt(project, trackIndex)
  const laneRef = React.useRef<HTMLDivElement | null>(null)
  const keysRef = React.useRef<HTMLDivElement | null>(null)
  const innerRef = React.useRef<HTMLDivElement | null>(null)
  const marqueeCleanupRef = React.useRef<(() => void) | null>(null)
  const [marquee, setMarquee] = React.useState<{ left: number; top: number; width: number; height: number } | null>(null)
  /** 框选覆盖的 步/音高 区间：用于实时高亮命中的音符块。 */
  const [marqueeRange, setMarqueeRange] = React.useState<{
    stepFrom: number
    stepTo: number
    pitchFrom: number
    pitchTo: number
  } | null>(null)

  const trackNotes = project.notes.filter(function (note) {
    return note.track === track.id
  })
  const notes = trackNotes.filter(function (note) {
    return note.step >= range.from && note.step <= range.to
  })
  const selectedNote = trackNotes.find(function (note) {
    return note.id === selectedNoteId
  })

  const keys: unknown[] = []
  for (let pitch = PITCH_HIGH; pitch >= PITCH_LOW; pitch -= 1) {
    const isC = pitch % 12 === 0
    keys.push(
      h(
        'button',
        {
          key: pitch,
          type: 'button',
          className:
            'pf-key' + (isBlackKey(pitch) ? ' is-black' : ' is-white') + (isC ? ' is-c' : ''),
          'aria-label': '试听 ' + pitchName(pitch),
          title: pitchName(pitch) + (isC ? '（八度起点）' : ''),
          onClick: function () {
            auditionPitch(trackIndex, pitch)
          },
        },
        isC ? h('span', { className: 'pf-key-dot', 'aria-hidden': 'true' }) : null,
        pitchName(pitch),
      ),
    )
  }

  /**
   * 音符拖动：选中的音符整体平移，未选中的先成为唯一选区再拖动。
   *
   * 平移始终以「按下瞬间的位置」为基准重算，因此连续拖动不会累积误差；
   * 越界由 moveNotes 按整批能做的最小幅度收敛，相对位置保持不变。
   */
  function startNoteDrag(note: NoteSpec, event: ReactPointer<HTMLDivElement>): void {
    event.stopPropagation()
    const selection = props.state.selection
    const ids = selection.indexOf(note.id) >= 0 ? selection.slice() : [note.id]
    if (selection.indexOf(note.id) < 0) {
      selectNotes([note.id])
      // 选中单个音符时把右侧面板切到它的参数，省去手动下拉
      setFxScope({ kind: 'note', note: note.id })
    }
    const base = project.notes.filter(function (item) {
      return ids.indexOf(item.id) >= 0
    })
    const startStep = note.step
    const startPitch = note.pitch
    beginPointerDrag(event, function (dx, dy) {
      const deltaStep = snapStep(startStep + Math.round(dx / PX_PER_STEP), project.ui.snap) - startStep
      const deltaPitch = clampInt(startPitch - Math.round(dy / PX_PER_KEY), PITCH_LOW, PITCH_HIGH) - startPitch
      if (deltaStep === 0 && deltaPitch === 0) return
      moveNotes(ids, deltaStep, deltaPitch, base)
    })
  }

  function startResize(note: NoteSpec, event: ReactPointer<HTMLSpanElement>): void {
    event.stopPropagation()
    const startLength = note.length
    beginPointerDrag(event, function (dx) {
      const raw = startLength + Math.round(dx / PX_PER_STEP)
      const maxLength = Math.min(NOTE_MAX_STEPS, TOTAL_STEPS - note.step)
      const length = clampInt(raw, NOTE_MIN_STEPS, maxLength)
      if (length !== note.length) updateNote(note.id, { length: length })
    })
  }

  const blocks: unknown[] = notes.map(function (note) {
    return h(NoteBlock, {
      key: note.id,
      note: note,
      page: page,
      bpm: project.bpm,
      selected: props.state.selection.indexOf(note.id) >= 0,
      highlighted: inMarquee(note),
      onDragStart: function (event: ReactPointer<HTMLDivElement>) {
        startNoteDrag(note, event)
      },
      onResize: function (event: ReactPointer<HTMLSpanElement>) {
        startResize(note, event)
      },
      onVelocity: function () {
        selectedNoteId = note.id
        selectNotes([note.id])
        setFxScope({ kind: 'note', note: note.id })
        velocityEditor = true
        emitDaw()
      },
      onRemove: function () {
        selectedNoteId = null
        velocityEditor = false
        removeNote(note.id)
      },
    })
  })

  /** 从音序器拖入：把落点换算成 步/音高（步数加上当前页偏移）。 */
  function handleDrop(event: ReactDrag<HTMLDivElement>): void {
    event.preventDefault()
    const raw = event.dataTransfer.getData(DRAG_MIME)
    if (raw.length === 0) return
    let payload: { track: number; step: number } | null = null
    try {
      payload = JSON.parse(raw) as { track: number; step: number }
    } catch (error) {
      logDaw('warn', '拖拽数据解析失败', error)
      return
    }
    if (payload === null) return
    const rect = event.currentTarget.getBoundingClientRect()
    const localX = event.clientX - rect.left
    const localY = event.clientY - rect.top + event.currentTarget.scrollTop
    const step = snapStep(range.from + Math.floor(localX / PX_PER_STEP), project.ui.snap)
    const pitch = clampInt(PITCH_HIGH - Math.floor(localY / PX_PER_KEY), PITCH_LOW, PITCH_HIGH)
    const targetTrack = clampInt(payload.track, 0, TRACK_COUNT - 1)
    selectTrack(targetTrack)
    const note: NoteSpec = {
      id: uid('note'),
      track: targetTrack,
      step: step,
      pitch: pitch,
      length: Math.min(Math.max(1, SNAP_STEPS[project.ui.snap]), TOTAL_STEPS - step),
      velocity: 100,
      offset: 0,
    }
    addNote(note)
    selectNotes([note.id])
    selectedNoteId = note.id
    setStatus('已拖入音符 ' + pitchName(pitch) + ' · 第 ' + (step + 1) + ' 步')
  }

  /** 拖拽悬停允许放置。 */
  function handleDragOver(event: ReactDrag<HTMLDivElement>): void {
    if (event.dataTransfer.types.indexOf(DRAG_MIME) >= 0) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
  }

  /** 把「相对网格内容左上角的像素点」换算成 步/音高（越界自动夹紧）。 */
  function pointToCell(localX: number, localY: number): { step: number; pitch: number } {
    return {
      step: clampInt(range.from + Math.floor(localX / PX_PER_STEP), range.from, range.to),
      pitch: clampInt(PITCH_HIGH - Math.floor(localY / PX_PER_KEY), PITCH_LOW, PITCH_HIGH),
    }
  }

  /** 结束框选：摘掉 window 监听并清掉选框与高亮。 */
  function endLaneMarquee(): void {
    const cleanup = marqueeCleanupRef.current
    marqueeCleanupRef.current = null
    if (cleanup !== null) cleanup()
    setMarquee(null)
    setMarqueeRange(null)
  }

  React.useEffect(function () {
    return function () {
      if (marqueeCleanupRef.current !== null) {
        marqueeCleanupRef.current()
        marqueeCleanupRef.current = null
      }
    }
  }, [])

  /**
   * Shift 拉框。
   *
   * move / up 绑在 window 上：卷帘是最容易「拖到边缘还想继续拉」的区域，绑在
   * 元素上会因为指针离开元素而丢事件。坐标系用 inner 的 rect（已含滚动偏移），
   * 因此纵向滚动时选框与音符始终对齐。
   *
   * 松手时不用「鼠标下面的元素」判定，而是用按下点与最后一点这两个坐标算包围盒：
   * 指针拖到卷帘外甚至窗口外松手，坐标仍会夹回内容边界，选区不会凭空消失。
   */
  function beginLaneMarquee(event: ReactPointer<HTMLDivElement>): void {
    const inner = innerRef.current
    if (inner === null) return
    const rect = inner.getBoundingClientRect()
    const startX = event.clientX - rect.left
    const startY = event.clientY - rect.top
    /** 最后一次已知的坐标（内容坐标系）；松手时以它为准。 */
    const last = { x: startX, y: startY }
    /** 最近一次算出的 步/音高 包围盒，松手时直接复用。 */
    let box = { stepFrom: 0, stepTo: 0, pitchFrom: 0, pitchTo: 0 }

    function update(x: number, y: number): void {
      // 夹回内容边界：允许拖出面板，但不允许把坐标算到网格外面去
      last.x = Math.min(Math.max(x, 0), rect.width)
      last.y = Math.min(Math.max(y, 0), rect.height)
      setMarquee({
        left: Math.min(startX, last.x),
        top: Math.min(startY, last.y),
        width: Math.abs(startX - last.x),
        height: Math.abs(startY - last.y),
      })
      const from = pointToCell(startX, startY)
      const to = pointToCell(last.x, last.y)
      box = {
        stepFrom: Math.min(from.step, to.step),
        stepTo: Math.max(from.step, to.step),
        pitchFrom: Math.min(from.pitch, to.pitch),
        pitchTo: Math.max(from.pitch, to.pitch),
      }
      setMarqueeRange(box)
    }

    update(startX, startY)

    function onMove(moveEvent: PointerEvent): void {
      update(moveEvent.clientX - rect.left, moveEvent.clientY - rect.top)
    }

    function onUp(upEvent: PointerEvent): void {
      // 抬起前的最后一次 move 可能差几像素，这里再更新一次再用记录下来的包围盒
      update(upEvent.clientX - rect.left, upEvent.clientY - rect.top)
      const ids = notesInRect(trackNotes, {
        trackFrom: track.id,
        trackTo: track.id,
        stepFrom: box.stepFrom,
        stepTo: box.stepTo,
        pitchFrom: box.pitchFrom,
        pitchTo: box.pitchTo,
      })
      selectNotes(ids)
      setStatus(ids.length === 0 ? '框选为空' : '已选中 ' + ids.length + ' 个音符')
      endLaneMarquee()
    }

    function onCancel(): void {
      endLaneMarquee()
    }

    function onKeyDown(keyEvent: KeyboardEvent): void {
      if (keyEvent.key === 'Escape') endLaneMarquee()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKeyDown)
    marqueeCleanupRef.current = function () {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKeyDown)
    }
  }

  /** 空白处按下：Shift 拉框，否则清除选中。 */
  function handleLaneDown(event: ReactPointer<HTMLDivElement>): void {
    if (event.button !== 0) return
    if (event.shiftKey) {
      event.preventDefault()
      beginLaneMarquee(event)
      return
    }
    if (event.target === event.currentTarget || (event.target as HTMLElement).className === 'pf-lane-inner') {
      selectedNoteId = null
      velocityEditor = false
      clearSelection()
    }
  }

  /** 音符是否落在当前框选范围内（用于实时高亮）。 */
  function inMarquee(note: NoteSpec): boolean {
    const box = marqueeRange
    if (box === null) return false
    if (note.pitch < box.pitchFrom || note.pitch > box.pitchTo) return false
    return note.step <= box.stepTo && note.step + note.length - 1 >= box.stepFrom
  }

  function syncScroll(): void {
    rollScrollSync = { keys: keysRef.current, lane: laneRef.current }
  }

  /**
   * 纵向聚焦：选中轨道变化时把该轨默认音高滚到视口中线。
   *
   * Bass 1（默认选中）的默认音高是 C3(48)，所以首次打开面板时卷帘恰好停在
   * C3–C5 区间，而不是从 C7 顶部开始。键盘条与网格共用同一个 scrollTop。
   */
  React.useEffect(
    function () {
      const lane = laneRef.current
      if (lane === null) return
      const rowTop = (PITCH_HIGH - track.pitch) * PX_PER_KEY
      const half = Math.max(0, lane.clientHeight / 2 - PX_PER_KEY / 2)
      lane.scrollTop = Math.max(0, rowTop - half)
      if (keysRef.current !== null) keysRef.current.scrollTop = lane.scrollTop
    },
    [track.id, track.pitch],
  )

  return h(
    'div',
    { className: 'pf-roll' },
    h(
      'div',
      {
        className: 'pf-keys',
        ref: function (node: HTMLDivElement | null) {
          keysRef.current = node
          syncScroll()
        },
        onScroll: function (event: { currentTarget: HTMLDivElement }) {
          if (laneRef.current !== null) laneRef.current.scrollTop = event.currentTarget.scrollTop
        },
      },
      keys,
    ),
    h(
      'div',
      {
        className: 'pf-lane',
        ref: function (node: HTMLDivElement | null) {
          laneRef.current = node
          syncScroll()
        },
        onScroll: function (event: { currentTarget: HTMLDivElement }) {
          if (keysRef.current !== null) keysRef.current.scrollTop = event.currentTarget.scrollTop
        },
        onDragOver: handleDragOver,
        onDrop: handleDrop,
        onPointerDown: handleLaneDown,
        'aria-label': '钢琴卷帘 ' + track.name,
      },
      h(
        'div',
        {
          className: 'pf-lane-inner',
          ref: function (node: HTMLDivElement | null) {
            innerRef.current = node
          },
        },
        blocks,
        marquee === null
          ? null
          : h('div', {
              className: 'pf-marquee',
              style: {
                left: marquee.left + 'px',
                top: marquee.top + 'px',
                width: marquee.width + 'px',
                height: marquee.height + 'px',
              },
              'aria-hidden': 'true',
            }),
        velocityEditor && selectedNote !== undefined ? h(VelocityEditor, { note: selectedNote }) : null,
      ),
    ),
  )
}
