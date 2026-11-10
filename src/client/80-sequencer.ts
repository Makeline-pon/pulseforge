/**
 * 音序器：16 轨 × 16 步（4 小节共 64 步，分页显示）。
 *
 * 交互约定（三种手势严格区分，互不抢事件）：
 *  - 普通左键：单击切换这一格；按住不放移到别的格子不会连画（单击语义）。
 *  - Shift + 左键拖拽：拉出半透明选区框，框内的格子实时高亮，松手后选中框内
 *    所有音符；在已选中的格子上拖拽则是整体平移（不改动单个格子的开关）。
 *  - Alt / Ctrl + 左键拖拽：批量涂抹或擦除，方向由起点那一格的状态决定。
 *
 * 框选过程中 pointermove / pointerup 挂在 window 上，而不是网格元素上：这样即使
 * 鼠标被拖出网格、拖出窗口再拖回来，选框也不会「冻结」在离开时的位置。
 *
 * 单元格可拖拽（HTML5 DnD），拖到钢琴卷帘即按当前吸附粒度落成音符。
 */

const DRAG_MIME = 'application/x-pulseforge-step'

/** 涂抹手势的当前方向：只在 Alt/Ctrl 拖拽期间非空。 */
let paintMode: 'add' | 'remove' | null = null

/** 框选矩形（相对网格左上角的像素值）。 */
interface MarqueeBox {
  left: number
  top: number
  width: number
  height: number
}

/** 框选覆盖的格子范围（绝对步数 + 轨道号）。 */
interface MarqueeRange {
  trackFrom: number
  trackTo: number
  stepFrom: number
  stepTo: number
}

type SeqGesture =
  | {
      kind: 'marquee'
      range: MarqueeRange
      startX: number
      startY: number
      originLeft: number
      originTop: number
    }
  | { kind: 'move'; startTrack: number; startStep: number; ids: string[]; base: NoteSpec[] }
  | null

/**
 * 网格几何快照。
 *
 * 框选必须能在「指针已经拖到网格外面」时仍然算出正确的行列，所以这里在按下
 * 那一刻把每一行的上下边界、每一列的左右边界量出来，之后纯靠坐标推算，
 * 不再依赖 elementFromPoint——指针离开网格后那个函数只会返回网格外的元素。
 */
interface GridMetrics {
  rows: Array<{ track: number; top: number; bottom: number }>
  columns: Array<{ step: number; left: number; right: number }>
}

/** 量一次网格几何；结构不完整时返回 null（调用方退回按下时的单格）。 */
function measureGrid(grid: HTMLElement): GridMetrics | null {
  const rowElements = grid.querySelectorAll('.pf-track-row')
  if (rowElements.length === 0) return null
  const rows: GridMetrics['rows'] = []
  for (let i = 0; i < rowElements.length; i += 1) {
    const row = rowElements[i]
    const cell = row.querySelector('.pf-step')
    if (!(cell instanceof HTMLElement)) continue
    const track = Number(cell.getAttribute('data-track'))
    if (!Number.isFinite(track)) continue
    const rect = row.getBoundingClientRect()
    rows.push({ track: track, top: rect.top, bottom: rect.bottom })
  }
  if (rows.length === 0) return null

  const firstRowCells = rowElements[0].querySelectorAll('.pf-step')
  const columns: GridMetrics['columns'] = []
  for (let i = 0; i < firstRowCells.length; i += 1) {
    const cell = firstRowCells[i]
    if (!(cell instanceof HTMLElement)) continue
    const step = Number(cell.getAttribute('data-step'))
    if (!Number.isFinite(step)) continue
    const rect = cell.getBoundingClientRect()
    columns.push({ step: step, left: rect.left, right: rect.right })
  }
  if (columns.length === 0) return null
  return { rows: rows, columns: columns }
}

/**
 * 视口坐标 → 格子坐标。
 *
 * 落在某一格内就直接用；落在网格外则夹到最近的一格（这正是「拖出去松手」要的
 * 行为：选区停在边界上，而不是整个消失）。
 */
function pointToCell(metrics: GridMetrics, x: number, y: number): { track: number; step: number } {
  let row = metrics.rows[0]
  let closestRow = Infinity
  for (const candidate of metrics.rows) {
    if (y >= candidate.top && y <= candidate.bottom) {
      row = candidate
      closestRow = 0
      break
    }
    const distance = y < candidate.top ? candidate.top - y : y - candidate.bottom
    if (distance < closestRow) {
      closestRow = distance
      row = candidate
    }
  }
  let column = metrics.columns[0]
  let closestColumn = Infinity
  for (const candidate of metrics.columns) {
    if (x >= candidate.left && x <= candidate.right) {
      column = candidate
      closestColumn = 0
      break
    }
    const distance = x < candidate.left ? candidate.left - x : x - candidate.right
    if (distance < closestColumn) {
      closestColumn = distance
      column = candidate
    }
  }
  return { track: row.track, step: column.step }
}

/** 读取事件目标所在的步进格（格子带 data-track / data-step）。 */
function stepCellOf(target: EventTarget | null): HTMLElement | null {
  if (target === null || !(target instanceof Element)) return null
  const cell = target.closest('.pf-step')
  return cell instanceof HTMLElement ? cell : null
}

/** 从格子读取轨道与绝对步数。 */
function cellCoords(cell: HTMLElement | null): { track: number; step: number } | null {
  if (cell === null) return null
  const track = Number(cell.getAttribute('data-track'))
  const step = Number(cell.getAttribute('data-step'))
  if (!Number.isFinite(track) || !Number.isFinite(step)) return null
  return { track: track, step: step }
}

/** 偏移标记：提前（负）贴左边缘、延后（正）贴右边缘，长度按 |offset| / 50ms 缩放。 */
function offsetMarker(offset: number): unknown {
  if (offset === 0) return null
  const ratio = clamp(Math.abs(offset) / OFFSET_MAX_MS, 0, 1)
  return h('span', {
    className: 'pf-step-offset' + (offset < 0 ? ' is-early' : ' is-late'),
    style: { width: Math.round(14 + ratio * 38) + '%' },
    'aria-hidden': 'true',
  })
}

/** 单元格。 */
function StepCell(props: {
  track: TrackSpec
  step: number
  on: boolean
  override: boolean
  selected: boolean
  cursor: boolean
  offset: number
  highlighted: boolean
  onPointerDown: (event: ReactPointer<HTMLButtonElement>) => void
}) {
  const cellStyle = {
    backgroundImage:
      props.on && props.track.engine !== 'kick'
        ? 'linear-gradient(180deg,rgba(255,255,255,.18),rgba(255,255,255,0))'
        : undefined,
  }

  return h(
    'button',
    {
      type: 'button',
      className:
        'pf-step' +
        (props.on ? ' is-on' : '') +
        (props.cursor ? ' is-cursor' : '') +
        (props.selected ? ' is-selected' : '') +
        (props.override ? ' is-override' : '') +
        (props.highlighted ? ' is-marquee' : '') +
        (props.on && props.offset !== 0 ? (props.offset < 0 ? ' is-early' : ' is-late') : ''),
      style: cellStyle,
      draggable: true,
      'data-track': props.track.id,
      'data-step': props.step,
      // 悬停提示：把看不见的手势写在这里，用户不用先读文档
      title:
        props.track.name +
        ' · 第 ' +
        (props.step + 1) +
        ' 步\nShift + 拖拽：框选 　Alt / Ctrl + 拖拽：涂抹\n拖到钢琴卷帘可落成音符' +
        (props.on && props.offset !== 0 ? '\n偏移 ' + Math.round(props.offset) + 'ms' : ''),
      'aria-label':
        '轨道 ' +
        props.track.name +
        ' 第 ' +
        (props.step + 1) +
        ' 步' +
        (props.on ? '（已启用）' : '') +
        (props.on && props.offset !== 0 ? '（偏移 ' + Math.round(props.offset) + ' 毫秒）' : ''),
      'aria-pressed': props.on ? 'true' : 'false',
      onPointerDown: props.onPointerDown,
      onPointerEnter: function () {
        // 涂抹只在 Alt/Ctrl 手势内生效；普通点击即使拖过别的格子也不会画
        if (paintMode === null) return
        if (paintMode === 'add' && props.on) return
        if (paintMode === 'remove' && !props.on) return
        paintStep(props.track.id, props.step, paintMode)
      },
      onDragStart: function (event: DragEvent) {
        if (event.dataTransfer === null) return
        event.dataTransfer.setData(DRAG_MIME, JSON.stringify({ track: props.track.id, step: props.step }))
        event.dataTransfer.effectAllowed = 'copy'
        paintMode = null
      },
    },
    props.on ? offsetMarker(props.offset) : null,
  )
}

/** 一条轨道（轨道头 + 16 个步进）。 */
function TrackRow(props: {
  track: TrackSpec
  page: number
  selected: boolean
  cursor: number
  notes: NoteSpec[]
  selection: string[]
  marqueeRange: MarqueeRange | null
  onCellDown: (event: ReactPointer<HTMLButtonElement>, trackId: number, step: number, noteId: string | null) => void
}) {
  const byStep = new Map<number, NoteSpec>()
  for (const note of props.notes) {
    if (note.track === props.track.id) byStep.set(note.step, note)
  }

  const range = props.marqueeRange
  const inMarqueeTrack =
    range !== null &&
    props.track.id >= Math.min(range.trackFrom, range.trackTo) &&
    props.track.id <= Math.max(range.trackFrom, range.trackTo)
  const stepLow = range === null ? 0 : Math.min(range.stepFrom, range.stepTo)
  const stepHigh = range === null ? -1 : Math.max(range.stepFrom, range.stepTo)

  const steps: unknown[] = []
  const page = pageRange(props.page)
  for (let index = 0; index < STEP_COUNT; index += 1) {
    const step = page.from + index
    const note = byStep.get(step)
    steps.push(
      h(StepCell, {
        key: step,
        track: props.track,
        step: step,
        on: note !== undefined,
        override: note !== undefined && hasFxOverride(note),
        selected: note !== undefined && props.selection.indexOf(note.id) >= 0,
        cursor: props.cursor === step,
        offset: note === undefined ? 0 : note.offset,
        highlighted: inMarqueeTrack && step >= stepLow && step <= stepHigh,
        onPointerDown: function (event: ReactPointer<HTMLButtonElement>) {
          props.onCellDown(event, props.track.id, step, note === undefined ? null : note.id)
        },
      }),
    )
  }

  return h(
    'div',
    { className: 'pf-track-row' + (inMarqueeTrack ? ' is-marquee-track' : '') },
    h(
      'button',
      {
        type: 'button',
        className: 'pf-track-head' + (props.selected ? ' is-selected' : ''),
        title: props.track.name + ' · ' + props.track.engine + ' · 默认 ' + pitchName(props.track.pitch),
        onClick: function () {
          selectTrack(props.track.id)
        },
        'aria-label': '选择轨道 ' + props.track.name,
      },
      h('span', { className: 'pf-track-swatch', style: { opacity: props.track.muted ? 0.25 : 1 } }),
      h('span', { className: 'pf-track-name', title: props.track.name }, props.track.name),
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'pf-track-mute' + (props.track.muted ? ' is-muted' : ''),
        'aria-label': (props.track.muted ? '取消静音 ' : '静音 ') + props.track.name,
        'aria-pressed': props.track.muted ? 'true' : 'false',
        onClick: function () {
          updateTrack(props.track.id, { muted: !props.track.muted })
        },
      },
      'M',
    ),
    h('div', { className: 'pf-steps' }, steps),
  )
}

/** 音序器整体。 */
function Sequencer(props: { state: DawState }) {
  const project = props.state.project
  const gridRef = React.useRef<HTMLDivElement | null>(null)
  const gestureRef = React.useRef<SeqGesture>(null)
  const marqueeCleanupRef = React.useRef<(() => void) | null>(null)
  const [marquee, setMarquee] = React.useState<MarqueeBox | null>(null)
  const [marqueeRange, setMarqueeRange] = React.useState<MarqueeRange | null>(null)

  /**
   * 结束框选：摘掉 window 监听、清掉选框。
   *
   * 卸载或取消（pointercancel / Escape）都必须走这里，否则 window 上的监听会
   * 一直挂着，下一次点击就会莫名奇妙地开始画框。
   */
  function endMarquee(): void {
    const cleanup = marqueeCleanupRef.current
    marqueeCleanupRef.current = null
    if (cleanup !== null) cleanup()
    gestureRef.current = null
    setMarquee(null)
    setMarqueeRange(null)
    paintMode = null
  }

  // 组件卸载时兜底：不能把 window 监听留在页面上
  React.useEffect(function () {
    return function () {
      if (marqueeCleanupRef.current !== null) {
        marqueeCleanupRef.current()
        marqueeCleanupRef.current = null
      }
    }
  }, [])

  /**
   * 开始框选。
   *
   * 关键点有两个：
   *  1. move / up 绑在 window 上（不是网格元素），指针拖出网格甚至拖出窗口再
   *     拖回来都还能收到事件；
   *  2. 行列换算用按下瞬间量出的几何（`measureGrid`），而不是鼠标位置下面的
   *     DOM 元素——在网格外松手时 elementFromPoint 只会返回网格外的东西，
   *     选区就会整个丢掉。这里只认坐标，落在外面就夹到最近的一格。
   */
  function beginMarquee(event: ReactPointer<HTMLButtonElement>, trackId: number, step: number): void {
    const grid = gridRef.current
    if (grid === null) return
    const gridRect = grid.getBoundingClientRect()
    const metrics = measureGrid(grid)
    const startX = event.clientX
    const startY = event.clientY
    const initial: MarqueeRange = { trackFrom: trackId, trackTo: trackId, stepFrom: step, stepTo: step }
    gestureRef.current = {
      kind: 'marquee',
      range: initial,
      startX: startX,
      startY: startY,
      originLeft: gridRect.left,
      originTop: gridRect.top,
    }
    setMarquee({ left: startX - gridRect.left, top: startY - gridRect.top, width: 0, height: 0 })
    setMarqueeRange(initial)

    /** 视口坐标 → 行列；没有几何数据时退回起点那一格。 */
    function locate(x: number, y: number): { track: number; step: number } {
      if (metrics === null) return { track: trackId, step: step }
      return pointToCell(metrics, x, y)
    }

    /** 把当前指针位置写进手势范围与高亮状态。 */
    function track(x: number, y: number): void {
      const gesture = gestureRef.current
      if (gesture === null || gesture.kind !== 'marquee') return
      const target = locate(x, y)
      gesture.range = {
        trackFrom: trackId,
        trackTo: target.track,
        stepFrom: step,
        stepTo: target.step,
      }
      setMarqueeRange(gesture.range)
    }

    function onMove(moveEvent: PointerEvent): void {
      const gesture = gestureRef.current
      if (gesture === null || gesture.kind !== 'marquee') return
      // 选框用原始视口坐标算（允许超出网格），视觉上跟随鼠标
      const left = Math.min(gesture.startX, moveEvent.clientX) - gesture.originLeft
      const top = Math.min(gesture.startY, moveEvent.clientY) - gesture.originTop
      const width = Math.abs(moveEvent.clientX - gesture.startX)
      const height = Math.abs(moveEvent.clientY - gesture.startY)
      setMarquee({ left: left, top: top, width: width, height: height })
      track(moveEvent.clientX, moveEvent.clientY)
    }

    function onUp(upEvent: PointerEvent): void {
      const gesture = gestureRef.current
      if (gesture !== null && gesture.kind === 'marquee') {
        // 松手位置也要参与计算：最后一次 move 可能停在抬起前的几个像素处
        track(upEvent.clientX, upEvent.clientY)
        const ids = notesInRect(project.notes, gesture.range)
        selectNotes(ids)
        setStatus(ids.length === 0 ? '框选为空' : '已选中 ' + ids.length + ' 个音符')
      }
      endMarquee()
    }

    function onCancel(): void {
      endMarquee()
    }

    function onKeyDown(keyEvent: KeyboardEvent): void {
      if (keyEvent.key === 'Escape') endMarquee()
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

  /**
   * 单元格按下：按修饰键分派三种手势。
   *
   * 平移手势用 pointer capture：拖出网格再松开也能收到 up，避免「拖到一半松开」
   * 留下半截手势；涂抹模式不 capture（需要继续收到各格子的 pointerenter）。
   */
  function handleCellDown(
    event: ReactPointer<HTMLButtonElement>,
    trackId: number,
    step: number,
    noteId: string | null,
  ): void {
    if (event.button !== 0) return
    // Shift：框选（与「已选中后拖动」区分开——Shift 永远只做框选）
    if (event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      beginMarquee(event, trackId, step)
      return
    }
    // Alt / Ctrl：批量涂抹或擦除
    if (event.altKey || event.ctrlKey || event.metaKey) {
      event.preventDefault()
      paintMode = noteId === null ? 'add' : 'remove'
      paintStep(trackId, step, paintMode)
      return
    }
    // 已选中的格子（且选区不止一个）：开始整体平移
    if (noteId !== null && props.state.selection.length > 1 && props.state.selection.indexOf(noteId) >= 0) {
      const base = project.notes.filter(function (note) {
        return props.state.selection.indexOf(note.id) >= 0
      })
      gestureRef.current = { kind: 'move', startTrack: trackId, startStep: step, ids: props.state.selection, base: base }
      const grid = gridRef.current
      if (grid !== null && typeof grid.setPointerCapture === 'function') grid.setPointerCapture(event.pointerId)
      return
    }
    // 普通点击：单点切换
    toggleStepNote(trackId, step)
  }

  /** 指针移动：平移手势实时预览目标位置（框选由 window 监听处理）。 */
  function handleGridMove(event: ReactPointer<HTMLDivElement>): void {
    const gesture = gestureRef.current
    if (gesture === null || gesture.kind !== 'move') return
    const coords = cellCoords(stepCellOf(event.target))
    if (coords === null) return
    moveNotes(gesture.ids, coords.step - gesture.startStep, coords.track - gesture.startTrack, gesture.base)
  }

  /** 指针抬起：提交整体平移（框选由 window 监听收尾）。 */
  function handleGridUp(event: ReactPointer<HTMLDivElement>): void {
    const gesture = gestureRef.current
    if (gesture === null || gesture.kind !== 'move') return
    gestureRef.current = null
    const coords = cellCoords(stepCellOf(event.target))
    if (coords !== null) {
      moveNotes(gesture.ids, coords.step - gesture.startStep, coords.track - gesture.startTrack, gesture.base)
      setStatus('已移动 ' + gesture.ids.length + ' 个音符')
    }
    paintMode = null
  }

  const rows: unknown[] = []
  for (const track of project.tracks) {
    rows.push(
      h(TrackRow, {
        key: track.id,
        track: track,
        page: props.state.page,
        selected: project.ui.selectedTrack === track.id,
        cursor: props.state.cursor,
        notes: project.notes,
        selection: props.state.selection,
        marqueeRange: marqueeRange,
        onCellDown: handleCellDown,
      }),
    )
  }

  // 刻度标尺：本页 1–16 全部标出，4/8/12/16 加粗（每小节第一拍与结尾）
  const ruler: unknown[] = []
  for (let index = 0; index < STEP_COUNT; index += 1) {
    const isBar = (index + 1) % 4 === 0
    ruler.push(
      h(
        'span',
        {
          key: index,
          className: 'pf-ruler-tick' + (isBar ? ' is-bar' : '') + (index % 4 === 0 ? ' is-quarter' : ''),
          'aria-hidden': 'true',
        },
        String(index + 1),
      ),
    )
  }

  /**
   * 快捷键图例。
   *
   * 框选与涂抹这两个手势没有可见入口，光靠 tooltip 用户永远发现不了，
   * 所以固定显示在网格左上角（与轨道头同宽对齐），带 `kbd` 语义便于读屏。
   */
  const legendItems = [
    { key: 'Shift + 拖拽', text: '框选' },
    { key: 'Alt / Ctrl + 拖拽', text: '涂抹' },
    { key: '[ ]', text: '偏移' },
    { key: '双击音符', text: '力度' },
  ]
  const legend = h(
    'div',
    { className: 'pf-legend', role: 'note', 'aria-label': '音序器快捷键提示' },
    legendItems.map(function (item) {
      return h(
        'span',
        { key: item.key, className: 'pf-legend-item' },
        h('kbd', { className: 'pf-legend-key' }, item.key),
        h('span', { className: 'pf-legend-text' }, item.text),
      )
    }),
  )

  return h(
    'div',
    {
      className: 'pf-seq',
      role: 'grid',
      'aria-label': '音序器 16 轨，每页 16 步，共 4 小节',
    },
    legend,
    h('div', { className: 'pf-ruler' }, ruler),
    h(
      'div',
      {
        className: 'pf-seq-grid',
        ref: function (node: HTMLDivElement | null) {
          gridRef.current = node
        },
        onPointerMove: handleGridMove,
        onPointerUp: handleGridUp,
        onPointerLeave: function () {
          // 涂抹在指针离开网格时结束；框选靠 window 监听收尾，不受影响
          if (gestureRef.current === null) paintMode = null
        },
      },
      rows,
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
    ),
  )
}
