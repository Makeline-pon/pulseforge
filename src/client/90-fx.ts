/**
 * 右侧效果器面板：失真 → 低通 → 延迟 → 混响，串联在同一条链上。
 *
 * 每张卡片内嵌 240×60 的 canvas 曲线；参数变更时在下一帧（约 16ms 内）重绘，
 * 只重绘受影响的卡片，避免拖动滑杆时反复跑满主线程。
 */

const ACCENT = '#ff8c2b'
const ACCENT_2 = '#ffb066'
const GRID = 'rgba(255,255,255,.08)'

/** 遍历 canvas 像素网格并绘制背景。 */
function paintBackdrop(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.clearRect(0, 0, width, height)
  ctx.strokeStyle = GRID
  ctx.lineWidth = 1
  for (let x = 0; x <= width; x += 30) {
    ctx.beginPath()
    ctx.moveTo(x + 0.5, 0)
    ctx.lineTo(x + 0.5, height)
    ctx.stroke()
  }
  for (let y = 0; y <= height; y += 15) {
    ctx.beginPath()
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(width, y + 0.5)
    ctx.stroke()
  }
}

/** 失真转移曲线：横轴输入 -1..1，纵轴输出 -1..1。 */
function drawDistortionCurve(canvas: HTMLCanvasElement, drive: number): void {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  const width = canvas.width
  const height = canvas.height
  paintBackdrop(ctx, width, height)
  const curve = buildDistortionCurve(drive)
  ctx.strokeStyle = 'rgba(255,255,255,.25)'
  ctx.beginPath()
  ctx.moveTo(0, height)
  ctx.lineTo(width, 0)
  ctx.stroke()
  ctx.strokeStyle = ACCENT
  ctx.lineWidth = 2
  ctx.beginPath()
  for (let i = 0; i < curve.length; i += 1) {
    const x = (i / (curve.length - 1)) * width
    const y = height / 2 - (curve[i] * height) / 2
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
}

/** 低通幅频响应：横轴对数频率 20Hz–20kHz，纵轴 0..1 增益。 */
function drawLowpassCurve(canvas: HTMLCanvasElement, cutoff: number, q: number): void {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  const width = canvas.width
  const height = canvas.height
  paintBackdrop(ctx, width, height)
  const minF = Math.log10(20)
  const maxF = Math.log10(20000)
  ctx.strokeStyle = ACCENT_2
  ctx.lineWidth = 2
  ctx.beginPath()
  for (let px = 0; px < width; px += 1) {
    const freq = Math.pow(10, minF + ((maxF - minF) * px) / width)
    const omega = freq / clamp(cutoff, 20, 20000)
    const omega2 = omega * omega
    const real = 1 - omega2
    const imag = omega / clamp(q, 0.1, 20)
    const magnitude = 1 / Math.sqrt(real * real + imag * imag)
    const db = 20 * Math.log10(Math.max(1e-4, magnitude))
    const norm = clamp((db + 40) / 40, 0, 1)
    const y = height - norm * height
    if (px === 0) ctx.moveTo(px, y)
    else ctx.lineTo(px, y)
  }
  ctx.stroke()
}

/** 音符偏移示意：横轴 -50ms..+50ms，竖线标出当前提前/延后量。 */
function drawOffsetCurve(canvas: HTMLCanvasElement, offset: number): void {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  const width = canvas.width
  const height = canvas.height
  paintBackdrop(ctx, width, height)
  const span = OFFSET_MAX_MS - OFFSET_MIN_MS
  const center = width / 2
  // 零线
  ctx.strokeStyle = 'rgba(255,255,255,.35)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(center + 0.5, 0)
  ctx.lineTo(center + 0.5, height)
  ctx.stroke()
  const value = clamp(offset, OFFSET_MIN_MS, OFFSET_MAX_MS)
  const x = ((value - OFFSET_MIN_MS) / span) * width
  const early = value < 0
  ctx.fillStyle = early ? ACCENT_2 : ACCENT
  ctx.fillRect(Math.min(center, x), height / 2 - 9, Math.abs(x - center), 18)
  ctx.strokeStyle = early ? ACCENT_2 : ACCENT
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x + 0.5, 6)
  ctx.lineTo(x + 0.5, height - 6)
  ctx.stroke()
  ctx.fillStyle = 'rgba(255,255,255,.55)'
  ctx.font = '9px ui-monospace, monospace'
  ctx.fillText(early ? 'EARLY' : 'LATE', 3, 10)
  ctx.fillText(Math.round(value) + 'ms', width - 34, height - 4)
}

/** 延迟脉冲响应：横轴 0–1000ms。 */
function drawDelayCurve(canvas: HTMLCanvasElement, delayMs: number, feedback: number, wet: number): void {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  const width = canvas.width
  const height = canvas.height
  paintBackdrop(ctx, width, height)
  const span = 1000
  ctx.strokeStyle = ACCENT
  ctx.lineWidth = 2
  ctx.beginPath()
  let amplitude = clamp(wet, 0, 1)
  let time = clamp(delayMs, 20, 1000)
  let guard = 0
  while (time < span && guard < 12 && amplitude > 0.02) {
    const x = (time / span) * width
    ctx.moveTo(x, height)
    ctx.lineTo(x, height - amplitude * height)
    time += clamp(delayMs, 20, 1000)
    amplitude *= clamp(feedback, 0, 0.9)
    guard += 1
  }
  ctx.stroke()
}

/**
 * 混响衰减包络：横轴 0–4s，纵轴 -60dB..0dB。
 *
 * 实线是整体混响能量（由 decay 决定），虚线是其中的高频能量：
 * 阻尼越大，高频分量衰减得越快、电平也越低——这正是「房间吸掉高频」的直观画面。
 * 两条线之间的张角越大，说明尾音越「暗」，糊音越少。
 */
function drawReverbCurve(canvas: HTMLCanvasElement, decay: number, wet: number, damping: number): void {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return
  const width = canvas.width
  const height = canvas.height
  paintBackdrop(ctx, width, height)
  const seconds = clamp(decay, 0.2, 4)
  const damp = clamp(damping, 0, 1)
  // 阻尼越高，高频包络相对整体包络的额外衰减指数越大，起点电平也越低
  const hfExponent = 1 + damp * 5
  const hfLevel = 1 - damp * 0.55
  const level = clamp(wet, 0, 1)

  ctx.strokeStyle = ACCENT
  ctx.lineWidth = 2
  ctx.beginPath()
  for (let px = 0; px < width; px += 1) {
    const t = (px / width) * 4
    const envelope = t <= seconds ? Math.pow(1 - t / seconds, 2.2) : 0
    const y = height - clamp(envelope * level, 0, 1) * height
    if (px === 0) ctx.moveTo(px, y)
    else ctx.lineTo(px, y)
  }
  ctx.stroke()

  // 高频尾音：同样的时间轴，但衰减更快
  ctx.strokeStyle = ACCENT_2
  ctx.lineWidth = 1.5
  ctx.setLineDash([4, 3])
  ctx.beginPath()
  for (let px = 0; px < width; px += 1) {
    const t = (px / width) * 4
    const envelope = t <= seconds ? Math.pow(1 - t / seconds, 2.2) : 0
    const y = height - clamp(Math.pow(envelope, hfExponent) * level * hfLevel, 0, 1) * height
    if (px === 0) ctx.moveTo(px, y)
    else ctx.lineTo(px, y)
  }
  ctx.stroke()
  ctx.setLineDash([])

  // 角标：虚线 = 高频（HF），实线 = 整体
  ctx.fillStyle = ACCENT_2
  ctx.font = '9px ui-monospace, monospace'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'top'
  ctx.fillText('HF', width - 4, 3)
}

/** 一张效果卡片：标题 + 曲线 + 参数控件。 */
function FxCard(props: { title: string; draw: (canvas: HTMLCanvasElement) => void; deps: unknown[]; children?: unknown }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const frameRef = React.useRef<number | null>(null)

  React.useEffect(function () {
    const canvas = canvasRef.current
    if (canvas === null) return undefined
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(function () {
      frameRef.current = null
      props.draw(canvas)
    })
    return function () {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
    // 依赖数组由调用方显式提供，确保参数变更后一帧内重绘
  }, props.deps)

  return h(
    'section',
    { className: 'pf-fx-card', 'aria-label': props.title + ' 参数' },
    h('header', { className: 'pf-fx-title' }, h('span', null, props.title)),
    h('canvas', { ref: canvasRef, className: 'pf-fx-canvas', width: 240, height: 60, 'aria-hidden': 'true' }),
    props.children,
  )
}

/** 右侧效果器面板。 */
function EffectPanel(props: { state: DawState }) {
  const project = props.state.project
  const scope = props.state.fxScope
  const fx = scopedFx(props.state)
  const scopedNote =
    scope.note === undefined
      ? undefined
      : project.notes.find(function (note) {
          return note.id === scope.note
        })

  /** 下拉框的取值：master / track:<id> / note:<id>。 */
  const scopeValue =
    scope.kind === 'note' && scope.note !== undefined
      ? 'note:' + scope.note
      : scope.kind === 'track'
        ? 'track:' + String(scope.track ?? 0)
        : 'master'
  const scopeOptions: { value: string; label: string }[] = [{ value: 'master', label: '全局 Master' }]
  for (const track of project.tracks) {
    scopeOptions.push({ value: 'track:' + String(track.id), label: '轨道 ' + track.name })
  }
  if (scopedNote !== undefined) {
    scopeOptions.push({
      value: 'note:' + scopedNote.id,
      label: '音符 ' + pitchName(scopedNote.pitch) + ' @ 第 ' + (scopedNote.step + 1) + ' 步',
    })
  }

  function parseScope(value: string): FxScope {
    if (value.indexOf('note:') === 0) return { kind: 'note', note: value.slice(5) }
    if (value.indexOf('track:') === 0) return { kind: 'track', track: clampInt(Number(value.slice(6)), 0, TRACK_COUNT - 1) }
    return { kind: 'master' }
  }

  return h(
    'aside',
    { className: 'pf-fx', 'aria-label': '效果器' },
    h(
      'div',
      { className: 'pf-scope' },
      h(Select, {
        label: '编辑',
        value: scopeValue,
        options: scopeOptions,
        onChange: function (value: string) {
          setFxScope(parseScope(value))
        },
      }),
      h(
        'p',
        { className: 'pf-scope-hint' },
        scope.kind === 'note'
          ? '正在编辑单音符覆盖：只写你改过的字段，其余继承轨道'
          : scope.kind === 'track'
            ? '轨道参数覆盖 Master，所有走这条轨的音符共享'
            : 'Master 参数是所有轨道的基准值',
      ),
    ),
    scopedNote === undefined
      ? null
      : h(
          FxCard,
          {
            title: '音符属性 ' + pitchName(scopedNote.pitch),
            deps: [scopedNote.offset, scopedNote.velocity],
            draw: function (canvas: HTMLCanvasElement) {
              drawOffsetCurve(canvas, scopedNote.offset)
            },
          },
          h(Slider, {
            label: 'Offset',
            value: scopedNote.offset,
            min: OFFSET_MIN_MS,
            max: OFFSET_MAX_MS,
            step: 1,
            format: function (value: number) {
              return Math.round(value) + 'ms'
            },
            onChange: function (value: number) {
              setNoteOffset(scopedNote.id, value)
            },
          }),
          h(
            'div',
            { className: 'pf-note-fx-actions' },
            h(
              Button,
              {
                label: '清除该音符的效果覆盖',
                onClick: function () {
                  clearNoteFx(scopedNote.id)
                },
                disabled: !hasFxOverride(scopedNote),
                title: hasFxOverride(scopedNote) ? '恢复为轨道参数' : '该音符当前没有覆盖',
              },
              h('span', null, '清除覆盖'),
            ),
          ),
        ),
    h(
      FxCard,
      {
        title: '失真 Distortion',
        deps: [fx.drive],
        draw: function (canvas: HTMLCanvasElement) {
          drawDistortionCurve(canvas, fx.drive)
        },
      },
      h(Slider, {
        label: 'Drive',
        value: fx.drive,
        min: 0,
        max: 1,
        step: 0.01,
        format: function (value: number) {
          return Math.round(value * 100) + '%'
        },
        onChange: function (value: number) {
          setFx({ drive: value })
        },
      }),
    ),
    h(
      FxCard,
      {
        title: '低通 Lowpass',
        deps: [fx.cutoff, fx.resonance],
        draw: function (canvas: HTMLCanvasElement) {
          drawLowpassCurve(canvas, fx.cutoff, fx.resonance)
        },
      },
      h(Slider, {
        label: 'Cutoff',
        value: fx.cutoff,
        min: 20,
        max: 20000,
        step: 10,
        format: function (value: number) {
          return Math.round(value) + 'Hz'
        },
        onChange: function (value: number) {
          setFx({ cutoff: value })
        },
      }),
      h(Slider, {
        label: 'Q',
        value: fx.resonance,
        min: 0.1,
        max: 20,
        step: 0.1,
        format: function (value: number) {
          return value.toFixed(1)
        },
        onChange: function (value: number) {
          setFx({ resonance: value })
        },
      }),
    ),
    h(
      FxCard,
      {
        title: '延迟 Delay',
        deps: [fx.delayMs, fx.feedback, fx.delayWet],
        draw: function (canvas: HTMLCanvasElement) {
          drawDelayCurve(canvas, fx.delayMs, fx.feedback, fx.delayWet)
        },
      },
      h(Slider, {
        label: 'Time',
        value: fx.delayMs,
        min: 20,
        max: 1000,
        step: 5,
        format: function (value: number) {
          return Math.round(value) + 'ms'
        },
        onChange: function (value: number) {
          setFx({ delayMs: value })
        },
      }),
      h(Slider, {
        label: 'Fdbk',
        value: fx.feedback,
        min: 0,
        max: 0.9,
        step: 0.01,
        format: function (value: number) {
          return Math.round(value * 100) + '%'
        },
        onChange: function (value: number) {
          setFx({ feedback: value })
        },
      }),
      h(Slider, {
        label: 'Wet',
        value: fx.delayWet,
        min: 0,
        max: 1,
        step: 0.01,
        format: function (value: number) {
          return Math.round(value * 100) + '%'
        },
        onChange: function (value: number) {
          setFx({ delayWet: value })
        },
      }),
    ),
    h(
      FxCard,
      {
        title: '混响 Reverb',
        deps: [fx.decay, fx.reverbWet, fx.damping],
        draw: function (canvas: HTMLCanvasElement) {
          drawReverbCurve(canvas, fx.decay, fx.reverbWet, fx.damping)
        },
      },
      h(Slider, {
        label: 'Decay',
        value: fx.decay,
        min: 0.2,
        max: 4,
        step: 0.05,
        format: function (value: number) {
          return value.toFixed(2) + 's'
        },
        onChange: function (value: number) {
          setFx({ decay: value })
        },
      }),
      h(Slider, {
        label: 'Damping',
        value: fx.damping,
        min: 0,
        max: 1,
        step: 0.01,
        format: function (value: number) {
          return Math.round(value * 100) + '%'
        },
        onChange: function (value: number) {
          setFx({ damping: value })
        },
      }),
      h(Slider, {
        label: 'Wet',
        value: fx.reverbWet,
        min: 0,
        max: 1,
        step: 0.01,
        format: function (value: number) {
          return Math.round(value * 100) + '%'
        },
        onChange: function (value: number) {
          setFx({ reverbWet: value })
        },
      }),
    ),
  )
}
