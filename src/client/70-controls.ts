/**
 * 控件原语与全局样式。
 *
 * 所有视觉数值都走 CSS 变量（见 :root），因此主题、圆角与描边只有一处定义；
 * 控件只暴露语义化属性，不把颜色写进组件。
 */

const STYLE_ID = 'pulseforge-style'

const STYLE_CSS = `
.pf-root{position:fixed;inset:0;z-index:60;pointer-events:none;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text)}
.pf-root *{box-sizing:border-box}
.pf-root button,.pf-root input,.pf-root select{font:inherit;color:inherit}
.pf-window{pointer-events:auto;position:absolute;inset:0;display:grid;grid-template-rows:48px 1fr 28px;background:var(--bg);border:1px solid var(--line);border-radius:10px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.55);min-width:1024px;min-height:640px}
.pf-top{display:flex;align-items:center;gap:14px;height:48px;padding:0 12px;background:var(--panel);border-bottom:1px solid var(--line)}
.pf-brand{display:flex;align-items:center;gap:8px;font-weight:600;letter-spacing:.04em;font-size:13px;color:var(--accent)}
.pf-brand small{color:var(--muted);font-weight:400;letter-spacing:.02em}
.pf-transport{display:flex;align-items:center;gap:8px}
.pf-top-actions{margin-left:auto;display:flex;align-items:center;gap:8px}
.pf-body{display:grid;grid-template-columns:1fr 260px;min-height:0}
.pf-main{display:flex;flex-direction:column;min-width:0;min-height:0;border-right:1px solid var(--line)}
.pf-status{display:flex;align-items:center;gap:12px;height:28px;padding:0 12px;background:var(--panel);border-top:1px solid var(--line);font-size:11px;color:var(--muted)}
.pf-status .pf-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);opacity:.8}
.pf-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 10px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:var(--panel);color:var(--text);font-size:12px;cursor:pointer;transition:background .12s ease,filter .12s ease,box-shadow .12s ease}
.pf-btn:hover{filter:brightness(1.08)}
.pf-btn:active{box-shadow:inset 0 1px 4px rgba(0,0,0,.5)}
.pf-btn:focus-visible{outline:2px solid var(--accent-2);outline-offset:2px}
.pf-btn[disabled]{opacity:.45;cursor:not-allowed}
.pf-btn.is-active{background:var(--accent);border-color:var(--accent);color:#1b1204;font-weight:600}
.pf-icon-btn{width:28px;padding:0}
.pf-field{display:flex;align-items:center;gap:8px}
.pf-label{font-size:11px;color:var(--muted);letter-spacing:.02em;min-width:40px;flex:none}
.pf-value{font-family:ui-monospace,"JetBrains Mono",monospace;font-size:12px;color:var(--text);min-width:52px;text-align:right}
.pf-range{appearance:none;width:100%;height:4px;border-radius:3px;background:rgba(255,255,255,.14);outline:none}
.pf-range::-webkit-slider-thumb{appearance:none;width:12px;height:12px;border-radius:50%;background:var(--accent);border:1px solid rgba(0,0,0,.4);cursor:pointer}
.pf-range:focus-visible{outline:2px solid var(--accent-2);outline-offset:4px}
.pf-select{height:26px;padding:0 6px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:var(--panel);font-size:12px}
.pf-number{width:58px;height:26px;padding:0 6px;border-radius:6px;border:1px solid rgba(255,255,255,.12);background:var(--bg);font-family:ui-monospace,"JetBrains Mono",monospace;font-size:12px}
/* BPM 组：数字框 + [60 ── 滑杆 ── 200]，两端刻度为 9px 等宽小字 */
.pf-bpm-field{gap:6px}
.pf-bpm-slider{display:flex;align-items:center;gap:5px}
.pf-bpm-track{position:relative;display:flex;align-items:center;width:110px}
.pf-bpm-range{width:110px}
.pf-bpm-tick{font-family:ui-monospace,"JetBrains Mono",monospace;font-size:9px;color:rgba(138,138,146,.7);user-select:none}
/* 拖动气泡：贴在滑杆正上方，随 BPM 比例水平移动 */
.pf-bpm-bubble{position:absolute;bottom:14px;transform:translateX(-50%);padding:2px 6px;border-radius:4px;background:var(--accent);color:#1b1204;font-family:ui-monospace,"JetBrains Mono",monospace;font-size:10px;line-height:1.2;pointer-events:none;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.45);z-index:5}

/* 音序器 */
.pf-seq{display:flex;flex-direction:column;min-height:0;overflow:auto;padding:10px 12px 4px}
.pf-ruler{display:flex;margin-left:140px;gap:2px;height:18px;align-items:center}
.pf-ruler-tick{width:28px;text-align:center;font-family:ui-monospace,"JetBrains Mono",monospace;font-size:9px;color:rgba(138,138,146,.55);border-left:1px solid rgba(255,255,255,.06);line-height:18px}
.pf-ruler-tick.is-quarter{color:var(--muted)}
.pf-ruler-tick.is-bar{color:var(--accent-2);font-weight:700;border-left:1px solid rgba(255,176,102,.55);border-right:1px solid rgba(255,176,102,.35);background:rgba(255,140,43,.07)}
.pf-track-row{display:flex;align-items:center;gap:6px;height:28px;margin-bottom:2px}
.pf-track-head{display:flex;align-items:center;gap:6px;width:140px;min-width:140px;height:28px;padding:0 6px;border-radius:6px;border:1px solid transparent;background:transparent;text-align:left;font-size:11px;color:var(--text);cursor:pointer;overflow:hidden}
.pf-track-head:hover{background:rgba(255,255,255,.04)}
.pf-track-head.is-selected{border-color:var(--accent);background:rgba(255,140,43,.12)}
.pf-track-swatch{width:6px;height:16px;border-radius:3px;background:var(--accent);flex:none}
.pf-track-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pf-track-mute{width:20px;height:20px;flex:none;border-radius:4px;border:1px solid rgba(255,255,255,.12);background:transparent;color:var(--muted);font-size:9px;cursor:pointer}
.pf-track-mute.is-muted{background:rgba(255,140,43,.2);color:var(--accent);border-color:var(--accent)}
.pf-steps{display:flex;gap:2px}
.pf-step{width:28px;height:28px;flex:none;border-radius:6px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.02);cursor:pointer;padding:0;position:relative;transition:background .08s ease}
.pf-step:nth-child(4n+1){border-left-color:rgba(255,255,255,.2)}
.pf-step:hover{filter:brightness(1.1)}
.pf-step.is-on{background:var(--note);border-color:var(--accent)}
.pf-step.is-cursor{box-shadow:inset 0 0 0 1px var(--accent-2)}
.pf-step.is-drop{background:rgba(255,176,102,.25)}
/* 框选命中：加一圈亮边，不改变底色以便看清是否同时是实心步 */
.pf-step.is-selected{box-shadow:inset 0 0 0 1px var(--accent-2),0 0 0 1px rgba(255,176,102,.4)}
/* 该步所在轨道若含带独立效果器的音符，右上角点一个小橙点 */
.pf-step.is-override::after{content:"";position:absolute;top:2px;right:2px;width:4px;height:4px;border-radius:50%;background:var(--accent-2)}
/* 网格相对定位，供选框浮层使用；行内元素按需滚动 */
.pf-seq-grid{position:relative;display:flex;flex-direction:column;flex:none}
/* 半透明选区框：不拦截指针，否则会打断拖拽 */
.pf-marquee{position:absolute;border:1px solid var(--accent);background:rgba(255,140,43,.14);border-radius:3px;pointer-events:none;z-index:4;box-shadow:0 0 0 1px rgba(255,140,43,.25) inset}
.pf-step.is-marquee{background:rgba(255,140,43,.22);box-shadow:inset 0 0 0 1px rgba(255,176,102,.55)}
.pf-step.is-marquee.is-on{background:var(--accent)}
.pf-track-row.is-marquee-track .pf-track-swatch{opacity:1;box-shadow:0 0 0 1px var(--accent-2)}

/* 钢琴卷帘 */
.pf-roll{display:flex;flex:1;min-height:180px;border-top:1px solid var(--line);background:#18181a}
.pf-keys{width:64px;min-width:64px;overflow:hidden;border-right:1px solid var(--line);background:var(--panel)}
.pf-key{position:relative;height:14px;display:flex;align-items:center;justify-content:flex-end;padding-right:6px;font-family:ui-monospace,"JetBrains Mono",monospace;font-size:9px;color:rgba(232,232,234,.7);border-bottom:1px solid rgba(255,255,255,.04);background:transparent;border-left:0;border-right:0;border-top:0;cursor:pointer;width:100%}
/* 白键亮灰、黑键深灰：黑键更短更暗，模拟真实键盘的视觉层次 */
.pf-key.is-white{background:#2b2b30;color:rgba(232,232,234,.82)}
.pf-key.is-black{background:#141416;color:#77777f;box-shadow:inset 0 -1px 0 rgba(0,0,0,.5)}
/* 每个八度的 C：加一条橙色分割线，并在右侧点一个小白点，便于定位 */
.pf-key.is-c{border-bottom:1px solid rgba(255,140,43,.55);color:var(--accent-2)}
.pf-key-dot{position:absolute;left:6px;width:4px;height:4px;border-radius:50%;background:var(--accent-2)}
.pf-key:hover{background:var(--accent);color:#1b1204}
.pf-lane{position:relative;flex:1;overflow:auto}
.pf-lane-inner{position:relative;height:854px;background-image:linear-gradient(to right,rgba(255,255,255,.07) 1px,transparent 1px),linear-gradient(to bottom,rgba(255,255,255,.04) 1px,transparent 1px);background-size:40px 100%,100% 14px}
.pf-note{position:absolute;height:12px;border-radius:3px;background:var(--note);border:1px solid var(--accent);cursor:grab;overflow:hidden;display:flex;align-items:center;padding:0 4px;font-size:9px;font-family:ui-monospace,"JetBrains Mono",monospace;color:#1b1204;white-space:nowrap;user-select:none}
.pf-note.is-selected{border-color:var(--accent-2);background:var(--accent-2)}
.pf-note.is-marquee{outline:1px dashed rgba(255,176,102,.9);outline-offset:1px}
.pf-note-handle{position:absolute;right:0;top:0;bottom:0;width:6px;cursor:ew-resize;background:rgba(0,0,0,.25)}
/* 带独立效果器覆盖的音符：右上角小圆点 */
.pf-note.is-override::after{content:"";position:absolute;top:1px;right:8px;width:4px;height:4px;border-radius:50%;background:#1b1204;box-shadow:0 0 0 1px rgba(255,255,255,.55)}
.pf-note.is-selected.is-override::after{background:#1b1204}

/* 效果器 */
.pf-fx{display:flex;flex-direction:column;gap:8px;padding:10px;overflow:auto;background:var(--bg)}
.pf-fx-card{border:1px solid var(--line);border-radius:6px;background:var(--panel);padding:8px;display:flex;flex-direction:column;gap:6px}
/* 效果器数值列：右侧留 8px 呼吸位，避免贴到卡片边缘；固定宽度让 Q 与 Cutoff 的小数位对齐 */
.pf-fx-card .pf-field{gap:6px}
.pf-fx-card .pf-label{min-width:62px;font-size:10px;text-transform:uppercase;letter-spacing:.06em}
.pf-fx-card .pf-value{min-width:60px;padding-right:8px;font-size:11px;font-variant-numeric:tabular-nums}
.pf-fx-card .pf-range{flex:1;min-width:0}
.pf-fx-title{display:flex;align-items:center;justify-content:space-between;font-size:11px;letter-spacing:.04em;color:var(--accent-2);text-transform:uppercase}
.pf-fx-canvas{width:100%;height:60px;display:block;border-radius:4px;background:#141416;border:1px solid rgba(255,255,255,.06)}
/* 作用域选择：Master / 轨道 / 单音符 */
.pf-scope{display:flex;flex-direction:column;gap:4px;padding:8px;border:1px solid var(--line);border-radius:6px;background:rgba(255,140,43,.05)}
.pf-scope .pf-field{justify-content:space-between}
.pf-scope select{max-width:170px}
.pf-scope-hint{margin:0;font-size:10px;line-height:1.4;color:var(--muted)}
.pf-note-fx-actions{display:flex;justify-content:flex-end;margin-top:2px}
/* 小节翻页控件，位于顶栏传输区右侧 */
.pf-pager{display:flex;align-items:center;gap:4px;flex:none}
.pf-pager-label{font-family:ui-monospace,"JetBrains Mono",monospace;font-size:10px;color:var(--muted);white-space:nowrap;min-width:104px;text-align:center}

/* 版本号与更新日志 */
.pf-version{flex:none;padding:0 5px;height:20px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--muted);font-family:ui-monospace,"JetBrains Mono",monospace;font-size:10px;letter-spacing:.02em;cursor:pointer}
.pf-version:hover{color:var(--accent-2);border-color:rgba(255,255,255,.12)}
.pf-version:focus-visible{outline:2px solid var(--accent-2);outline-offset:2px}
.pf-changelog{position:absolute;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)}
.pf-changelog-card{display:flex;flex-direction:column;width:min(520px,86vw);max-height:min(520px,80vh);background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:0 24px 60px rgba(0,0,0,.6);overflow:hidden}
.pf-changelog-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent-2)}
.pf-changelog-head .pf-btn{margin-left:auto}
.pf-changelog-list{overflow:auto;padding:4px 14px 14px}
.pf-changelog-version{display:flex;align-items:baseline;gap:8px;margin:12px 0 6px;font-family:ui-monospace,"JetBrains Mono",monospace;font-size:13px;color:var(--text)}
.pf-changelog-version small{font-family:system-ui,sans-serif;font-size:10px;color:var(--muted)}
.pf-changelog-item{display:flex;align-items:flex-start;gap:8px;padding:2px 0 2px 2px;font-size:12px;line-height:1.5;color:var(--text)}
.pf-change-kind{flex:none;min-width:34px;height:16px;margin-top:3px;border:1px solid rgba(255,255,255,.14);border-radius:4px;font-size:9px;line-height:15px;text-align:center;color:var(--muted)}
.pf-change-kind.is-feat{color:var(--accent);border-color:var(--accent)}
.pf-change-kind.is-fix{color:#6fd18b;border-color:rgba(111,209,139,.6)}

/* 提示 */
.pf-toast{position:absolute;left:50%;bottom:44px;transform:translateX(-50%);padding:8px 14px;border-radius:6px;background:rgba(35,35,38,.96);border:1px solid var(--accent);font-size:12px;color:var(--text);box-shadow:0 10px 30px rgba(0,0,0,.5);pointer-events:none}
.pf-toast.is-warn{border-color:#ff5c5c}
.pf-hidden{display:none}

/* 快捷键图例：贴在音序器网格左上角，与轨道头对齐 */
.pf-legend{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 0 4px 140px;padding:0 2px;font-family:system-ui,sans-serif;font-size:10px;color:var(--muted)}
.pf-legend-item{display:inline-flex;align-items:center;gap:5px}
.pf-legend-key{display:inline-block;padding:1px 5px;border:1px solid rgba(255,255,255,.16);border-radius:4px;background:rgba(255,255,255,.03);font-family:ui-monospace,"JetBrains Mono",monospace;font-size:9px;color:var(--accent-2);white-space:nowrap}
.pf-legend-text{color:var(--muted)}

/* 偏移可视化：音序器里的小横线 / 卷帘里的原始网格线 */
.pf-step-offset{position:absolute;bottom:3px;height:2px;border-radius:1px;background:var(--accent-2);opacity:.9;pointer-events:none}
.pf-step-offset.is-early{left:3px}
.pf-step-offset.is-late{right:3px}
.pf-step.is-early{box-shadow:inset 2px 0 0 rgba(255,176,102,.9)}
.pf-step.is-late{box-shadow:inset -2px 0 0 rgba(255,176,102,.9)}
.pf-note-origin{position:absolute;top:1px;bottom:1px;width:2px;background:var(--accent-2);opacity:.85;pointer-events:none}
.pf-note.is-early{border-left-color:var(--accent-2)}
.pf-note.is-late{border-right-color:var(--accent-2)}
`

/** 注入样式表；返回 disposer 供插件卸载时移除。 */
function ensureStyle(): () => void {
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) {
    return function () {
      /* 已存在时由创建者负责移除，避免互相拆台 */
    }
  }
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = STYLE_CSS
  document.head.appendChild(style)
  return function () {
    if (style.parentNode !== null) style.parentNode.removeChild(style)
  }
}

/** 主题变量挂在窗口根节点上，避免污染宿主全局样式。 */
const THEME_STYLE: Record<string, string> = {
  '--bg': '#1b1b1d',
  '--panel': '#232326',
  '--line': '#3a3a3f',
  '--accent': '#ff8c2b',
  '--accent-2': '#ffb066',
  '--note': 'rgba(255,140,43,.55)',
  '--text': '#e8e8ea',
  '--muted': '#8a8a92',
}

/** 通用按钮。 */
function Button(props: {
  label: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  title?: string
  iconOnly?: boolean
  children?: unknown
}) {
  return h(
    'button',
    {
      type: 'button',
      className: 'pf-btn' + (props.iconOnly === true ? ' pf-icon-btn' : '') + (props.active === true ? ' is-active' : ''),
      'aria-label': props.label,
      'aria-pressed': props.active === true ? 'true' : undefined,
      title: props.title ?? props.label,
      disabled: props.disabled === true,
      onClick: props.onClick,
    },
    props.children ?? props.label,
  )
}

/** 带数值读数的滑杆。 */
function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  format?: (value: number) => string
  onChange: (value: number) => void
}) {
  const display = props.format !== undefined ? props.format(props.value) : String(Math.round(props.value * 100) / 100)
  return h(
    'label',
    { className: 'pf-field' },
    h('span', { className: 'pf-label' }, props.label),
    h('input', {
      className: 'pf-range',
      type: 'range',
      min: props.min,
      max: props.max,
      step: props.step,
      value: props.value,
      'aria-label': props.label,
      onChange: function (event: { target: { value: string } }) {
        props.onChange(Number(event.target.value))
      },
    }),
    h('span', { className: 'pf-value' }, display + (props.unit !== undefined ? props.unit : '')),
  )
}

/** 下拉选择。 */
function Select<T extends string>(props: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return h(
    'label',
    { className: 'pf-field' },
    h('span', { className: 'pf-label' }, props.label),
    h(
      'select',
      {
        className: 'pf-select',
        value: props.value,
        'aria-label': props.label,
        onChange: function (event: { target: { value: string } }) {
          props.onChange(event.target.value as T)
        },
      },
      props.options.map(function (option) {
        return h('option', { key: option.value, value: option.value }, option.label)
      }),
    ),
  )
}

/**
 * 指针拖拽助手：按下后持续回调位移，直到指针抬起。
 * 使用 setPointerCapture，确保指针移出元素后依然收到事件。
 */
function beginPointerDrag(
  event: { clientX: number; clientY: number; button: number; pointerId: number; currentTarget: EventTarget | null; preventDefault: () => void },
  onMove: (dx: number, dy: number) => void,
  onEnd?: () => void,
): void {
  if (event.button !== 0) return
  event.preventDefault()
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) return
  const startX = event.clientX
  const startY = event.clientY
  try {
    target.setPointerCapture(event.pointerId)
  } catch (error) {
    logDaw('warn', '指针捕获失败', error)
  }
  function handleMove(moveEvent: PointerEvent): void {
    onMove(moveEvent.clientX - startX, moveEvent.clientY - startY)
  }
  function handleUp(): void {
    target.removeEventListener('pointermove', handleMove)
    target.removeEventListener('pointerup', handleUp)
    target.removeEventListener('pointercancel', handleUp)
    try {
      target.releasePointerCapture(event.pointerId)
    } catch (error) {
      logDaw('warn', '指针释放失败', error)
    }
    if (onEnd !== undefined) onEnd()
  }
  target.addEventListener('pointermove', handleMove)
  target.addEventListener('pointerup', handleUp)
  target.addEventListener('pointercancel', handleUp)
}
