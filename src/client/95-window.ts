/**
 * 编辑器窗口：48px 顶栏 + 左主区（音序器 / 钢琴卷帘）+ 260px 效果栏 + 28px 状态栏。
 *
 * 生命周期：本组件只负责「已打开」时的界面；打开/关闭由 store 的 open 字段驱动，
 * 关闭时窗口卸载，所有定时器与 AudioContext 由 closeDaw / ctx.effect 释放。
 */

/**
 * 顶栏 BPM 控件：数字框 + 带极值刻度的滑杆 + 拖动时跟随的数值气泡。
 *
 * 气泡只在拖动期间出现（pointerdown 起、pointerup/cancel/blur 止），
 * 位置按当前 BPM 在 60–200 区间的比例水平移动，避免遮挡刻度文字。
 */
function BpmControl(props: { bpm: number }) {
  const [dragging, setDragging] = React.useState(false)
  const ratio = (clampInt(props.bpm, BPM_MIN, BPM_MAX) - BPM_MIN) / (BPM_MAX - BPM_MIN)
  return h(
    'div',
    { className: 'pf-field pf-bpm-field' },
    h('span', { className: 'pf-label' }, 'BPM'),
    h('input', {
      className: 'pf-number',
      type: 'number',
      min: BPM_MIN,
      max: BPM_MAX,
      step: 1,
      value: props.bpm,
      'aria-label': 'BPM 每分钟拍数，范围 60 到 200',
      onChange: function (event: { target: { value: string } }) {
        setBpm(Number(event.target.value))
      },
    }),
    h(
      'div',
      { className: 'pf-bpm-slider' },
      h('span', { className: 'pf-bpm-tick', 'aria-hidden': 'true' }, String(BPM_MIN)),
      h(
        'div',
        { className: 'pf-bpm-track' },
        h('input', {
          className: 'pf-range pf-bpm-range',
          type: 'range',
          min: BPM_MIN,
          max: BPM_MAX,
          step: 1,
          value: props.bpm,
          'aria-label': 'BPM 滑杆',
          onPointerDown: function () {
            setDragging(true)
          },
          onPointerUp: function () {
            setDragging(false)
          },
          onPointerCancel: function () {
            setDragging(false)
          },
          onBlur: function () {
            setDragging(false)
          },
          onChange: function (event: { target: { value: string } }) {
            setBpm(Number(event.target.value))
          },
        }),
        dragging
          ? h(
              'span',
              {
                className: 'pf-bpm-bubble',
                role: 'status',
                'aria-live': 'polite',
                style: { left: String(ratio * 100) + '%' },
              },
              String(props.bpm),
            )
          : null,
      ),
      h('span', { className: 'pf-bpm-tick', 'aria-hidden': 'true' }, String(BPM_MAX)),
    ),
  )
}

/** 顶栏：品牌、传输控制、BPM、吸附、导出与关闭。 */
function TopBar(props: { state: DawState; onClose: () => void }) {
  const project = props.state.project
  const bpm = project.bpm
  const snap = project.ui.snap

  return h(
    'header',
    { className: 'pf-top' },
    h('div', { className: 'pf-brand' }, h(WaveIcon, { size: 18 }), h('span', null, 'PULSEFORGE'), h('small', null, 'DAW')),
    h(
      'div',
      { className: 'pf-transport' },
      h(
        Button,
        {
          label: props.state.playing ? '停止播放' : '开始播放',
          onClick: togglePlayback,
          active: props.state.playing,
          iconOnly: true,
          title: '播放 / 停止（空格）',
        },
        props.state.playing ? h(StopIcon) : h(PlayIcon),
      ),
      h(BpmControl, { bpm: bpm }),
      h(Select, {
        label: '吸附',
        value: snap,
        options: [
          { value: '1/4' as SnapValue, label: '1/4' },
          { value: '1/8' as SnapValue, label: '1/8' },
          { value: '1/16' as SnapValue, label: '1/16' },
        ],
        onChange: function (value: SnapValue) {
          setSnap(value)
        },
      }),
    ),
    h(
      'div',
      { className: 'pf-pager', role: 'group', 'aria-label': '小节翻页' },
      h(
        Button,
        {
          label: '上一小节',
          iconOnly: true,
          disabled: props.state.page <= 0,
          onClick: function () {
            setPage(props.state.page - 1)
          },
        },
        h('span', { 'aria-hidden': 'true' }, '‹'),
      ),
      h(
        'span',
        { className: 'pf-pager-label', 'aria-live': 'polite' },
        '第 ' + String(props.state.page + 1) + ' 小节 / 共 ' + String(BAR_COUNT) + ' 小节',
      ),
      h(
        Button,
        {
          label: '下一小节',
          iconOnly: true,
          disabled: props.state.page >= BAR_COUNT - 1,
          onClick: function () {
            setPage(props.state.page + 1)
          },
        },
        h('span', { 'aria-hidden': 'true' }, '›'),
      ),
    ),
    h(
      'div',
      { className: 'pf-top-actions' },
      h(
        Button,
        {
          label: '清空音序',
          onClick: function () {
            const total = props.state.project.notes.length
            if (total === 0) {
              setStatus('音序本来就空的')
              return
            }
            const confirmed = window.confirm('将删除全部 ' + String(total) + ' 个音符，且无法撤销。确定清空音序吗？')
            if (!confirmed) return
            clearAllNotes()
            setStatus('已清空音序（' + String(total) + ' 个音符）')
          },
          disabled: props.state.project.notes.length === 0,
          title: '删除所有轨道的全部音符（会二次确认，并触发自动保存）',
        },
        h(TrashIcon),
        h('span', null, '清空音序'),
      ),
      h(
        Button,
        {
          label: '导出 WAV',
          onClick: function () {
            if (!props.state.exporting) void exportWav()
          },
          disabled: props.state.exporting === true,
          title: '离线渲染为 44.1kHz / 16-bit / 立体声 WAV',
        },
        h(DownloadIcon),
        h('span', null, props.state.exporting ? '渲染中…' : '导出 WAV'),
      ),
      h(
        Button,
        {
          label: '导出工程 JSON',
          onClick: exportProjectJson,
          title: '下载工程 JSON 备份（IndexedDB 会被清缓存影响）',
        },
        h('span', null, '导出工程'),
      ),
      h(
        Button,
        {
          label: '关闭编辑器',
          onClick: props.onClose,
          iconOnly: true,
          title: '关闭（Esc）',
        },
        h(CloseIcon),
      ),
    ),
  )
}

/** 底部状态栏：保存状态、音频状态、光标与工程统计，右下角为版本号入口。 */
function StatusBar(props: { state: DawState; onShowChangelog: () => void }) {
  const project = props.state.project
  const notes = project.notes.length
  return h(
    'footer',
    { className: 'pf-status' },
    h('span', { className: 'pf-dot', 'aria-hidden': 'true' }),
    h('span', null, props.state.status),
    h('span', null, 'BPM ' + project.bpm),
    h('span', null, '吸附 ' + project.ui.snap),
    h('span', null, '音符 ' + notes),
    h('span', null, '选中 ' + props.state.selection.length),
    h(
      'span',
      null,
      props.state.cursor >= 0
        ? '步 ' + String(props.state.cursor + 1) + ' / ' + String(TOTAL_STEPS) + ' · 小节 ' + String(props.state.page + 1)
        : '已停止',
    ),
    h('span', { style: { marginLeft: 'auto' } }, props.state.audioState),
    h(
      'button',
      {
        type: 'button',
        className: 'pf-version',
        'aria-label': '查看更新日志，当前版本 ' + PLUGIN_VERSION,
        title: '更新日志',
        onClick: props.onShowChangelog,
      },
      'v' + PLUGIN_VERSION,
    ),
  )
}

/** 更新日志弹窗：版本从新到旧，每条变更带类型角标。 */
function ChangelogDialog(props: { onClose: () => void }) {
  return h(
    'div',
    {
      className: 'pf-changelog',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'PulseForge 更新日志',
      onClick: function (event: ReactMouse<HTMLDivElement>) {
        // 点击遮罩关闭；点击卡片本身不关闭
        if (event.target === event.currentTarget) props.onClose()
      },
    },
    h(
      'div',
      { className: 'pf-changelog-card' },
      h(
        'div',
        { className: 'pf-changelog-head' },
        h('span', null, '更新日志'),
        h(
          Button,
          { label: '关闭更新日志', onClick: props.onClose, iconOnly: true, title: '关闭（Esc）' },
          h(CloseIcon),
        ),
      ),
      h(
        'div',
        { className: 'pf-changelog-list' },
        CHANGELOG.map(function (entry: ChangelogEntry) {
          return h(
            'section',
            { key: entry.version },
            h(
              'div',
              { className: 'pf-changelog-version' },
              h('span', null, 'v' + entry.version),
              h('small', null, entry.date),
              entry.version === PLUGIN_VERSION ? h('small', null, '当前版本') : null,
            ),
            entry.items.map(function (item: ChangelogItem, index: number) {
              const kindLabel = item.kind === 'feat' ? '新增' : item.kind === 'fix' ? '修复' : '杂项'
              return h(
                'div',
                { className: 'pf-changelog-item', key: entry.version + '-' + String(index) },
                h('span', { className: 'pf-change-kind is-' + item.kind }, kindLabel),
                h('span', null, item.text),
              )
            }),
          )
        }),
      ),
    ),
  )
}

/** 编辑器窗口主体。 */
function PulseForgeWindow(props: { state: DawState }) {
  const state = props.state
  const windowRef = React.useRef<HTMLDivElement | null>(null)
  const styleDisposerRef = React.useRef<(null | (() => void))>(null)
  /** 更新日志弹窗是否展开；Esc 优先关弹窗，其次关面板。 */
  const changelogPair = React.useState(false)
  const changelogOpen = changelogPair[0] as boolean
  const setChangelogOpen = changelogPair[1] as (value: boolean) => void

  // 样式表：挂载时注入，卸载时移除（与插件卸载保持一致）
  React.useEffect(function () {
    const dispose = ensureStyle()
    styleDisposerRef.current = dispose
    return function () {
      if (styleDisposerRef.current !== null) {
        styleDisposerRef.current()
        styleDisposerRef.current = null
      }
    }
  }, [])

  // 焦点回收：/pulseforge 二次调用只把焦点挪回面板，不重复挂载
  React.useEffect(
    function () {
      if (state.open && windowRef.current !== null) windowRef.current.focus()
    },
    [state.focusSeq, state.open],
  )

  // 键盘：空格播放/停止，Esc 先关更新日志再关面板；输入框内不拦截
  React.useEffect(
    function () {
      function handleKey(event: KeyboardEvent): void {
        const target = event.target as HTMLElement | null
        const tag = target !== null ? target.tagName : ''
        const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
        if (event.key === 'Escape') {
          if (changelogOpen) {
            event.preventDefault()
            setChangelogOpen(false)
            return
          }
          closeDaw()
          return
        }
        if (event.code === 'Space' && !typing) {
          event.preventDefault()
          togglePlayback()
          return
        }
        if (typing) return
        // [] 微调选中音符的时间偏移（±5ms），与右侧面板滑杆等价
        if (event.key === '[') {
          event.preventDefault()
          nudgeSelection(-5)
          return
        }
        if (event.key === ']') {
          event.preventDefault()
          nudgeSelection(5)
          return
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
          if (dawState.selection.length === 0) return
          event.preventDefault()
          removeSelectedNotes()
        }
      }
      window.addEventListener('keydown', handleKey)
      return function () {
        window.removeEventListener('keydown', handleKey)
      }
    },
    [changelogOpen],
  )

  // 首次用户手势：恢复被浏览器挂起的 AudioContext
  React.useEffect(function () {
    if (!state.open) return undefined
    function handleFirstGesture(): void {
      void resumeAudioContext()
    }
    const node = windowRef.current
    if (node !== null) node.addEventListener('pointerdown', handleFirstGesture, { once: true })
    return function () {
      if (node !== null) node.removeEventListener('pointerdown', handleFirstGesture)
    }
  }, [state.open])

  if (!state.open) return null

  const themeStyle = Object.assign({}, THEME_STYLE, { inset: '16px' })

  return h(
    'div',
    { className: 'pf-root', role: 'region', 'aria-label': 'PulseForge 电子音乐编辑器' },
    h(
      'div',
      {
        className: 'pf-window',
        ref: windowRef,
        tabIndex: -1,
        style: themeStyle,
        onKeyDown: function (event: KeyboardEvent) {
          // 阻止空格滚动页面，同时不吞掉输入框里的空格
          const target = event.target as HTMLElement | null
          const tag = target !== null ? target.tagName : ''
          if (event.code === 'Space' && tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') {
            event.preventDefault()
          }
        },
      },
      h(TopBar, { state: state, onClose: closeDaw }),
      h(
        'div',
        { className: 'pf-body' },
        h('div', { className: 'pf-main' }, h(Sequencer, { state: state }), h(PianoRoll, { state: state })),
        h(EffectPanel, { state: state }),
      ),
      h(StatusBar, {
        state: state,
        onShowChangelog: function () {
          setChangelogOpen(true)
        },
      }),
      state.toast !== null
        ? h('div', { className: 'pf-toast' + (state.toast.kind === 'warn' ? ' is-warn' : ''), role: 'status' }, state.toast.text)
        : null,
      changelogOpen
        ? h(ChangelogDialog, {
            onClose: function () {
              setChangelogOpen(false)
            },
          })
        : null,
    ),
  )
}

/** 订阅式外壳：状态变化时重渲染窗口。 */
function PulseForgeOverlay() {
  const state = useDaw()
  React.useEffect(function () {
    // 面板关闭即释放音频资源；打开时由 store 负责载入工程
    if (!state.open) disposeAudioEngine()
    return undefined
  }, [state.open])
  return h(PulseForgeWindow, { state: state })
}
