/**
 * 纯 Web Audio 合成引擎：零采样、零第三方库。
 *
 * 结构：每个 voice 独立建振荡器/噪声 + 包络，播放结束在 onended 中断开节点。
 * 效果链分三层：Master（所有轨道共用）→ 每条轨道一条独立链 → 单音符覆盖时
 * 再从「点号池」借一条临时链。音符链数量有上限，避免几十个 Convolver 同时
 * 运行把渲染线程拖死；借不到时该音符退回轨道链，参数差异被降级而不是崩溃。
 */

/** 同时存在的单音符专属效果链上限（每条链含一个 Convolver，很吃 CPU）。 */
const NOTE_CHAIN_LIMIT = 4
/** 借出的音符链在音符结束后再占用多久（秒），让混响尾音自然收尾。 */
const NOTE_CHAIN_TAIL_SECONDS = 1.2
/** 池满提示的最小间隔（毫秒）：连续降级时只提醒一次，别刷屏。 */
const NOTE_CHAIN_WARN_INTERVAL_MS = 8000

/** 上一次「池满降级」提示的时间戳。 */
let noteChainWarnAt = 0

/* -------------------------------------------------------------------------
 * 运行期计数与诊断
 *
 * 内存问题最难查的部分是「到底有多少节点还活着」。这里维护一组轻量计数，
 * 每次创建 / 回收节点都会更新；控制台随时可以 `__pfAudioStats()` 查看，
 * 排查完不需要动构建配置。
 * ---------------------------------------------------------------------- */

interface AudioStats {
  /** 当前存活的 voice 数（正在发声或等待结束）。 */
  voices: number
  /** 当前被借出的音符链数。 */
  chainsInUse: number
  /** 池中空闲的音符链数。 */
  chainsIdle: number
  /** 常驻轨道链数量。 */
  trackChains: number
  /** 尚未触发的定时器数量（归还链、光标回推、voice 兜底回收）。 */
  timers: number
  /** 缓存过的脉冲响应条数。 */
  impulseCache: number
  /** AudioContext 是否活跃。 */
  context: string
}

const audioCounters = {
  voices: 0,
  timers: 0,
}

/** 当前音频引擎的存活对象快照。 */
function audioStats(): AudioStats {
  return {
    voices: audioCounters.voices,
    chainsInUse: noteChainsInUse,
    chainsIdle: noteChainPool.length,
    trackChains: trackChains.length,
    timers: audioCounters.timers,
    impulseCache: impulseCache.size,
    context: audioCtx === null ? 'closed' : audioCtx.state,
  }
}

/** 把计数打到控制台（同时暴露给页面上的 `__pfAudioStats()`）。 */
function logAudioStats(reason: string): void {
  // 测试沙箱与部分嵌入环境没有 console.info，统计本身不能因为日志缺席而抛错
  if (typeof console === 'undefined' || typeof console.info !== 'function') return
  const stats = audioStats()
  console.info(
    '[pulseforge] 音频对象统计（' +
      reason +
      '）：voices ' +
      stats.voices +
      '，借出链 ' +
      stats.chainsInUse +
      '，空闲链 ' +
      stats.chainsIdle +
      '，轨道链 ' +
      stats.trackChains +
      '，定时器 ' +
      stats.timers +
      '，IR 缓存 ' +
      stats.impulseCache +
      '，context ' +
      stats.context,
  )
}

/* -------------------------------------------------------------------------
 * 定时器记账：所有「过一会儿再做」的工作都必须登记，卸载时统一清掉。
 * ---------------------------------------------------------------------- */

const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

function scheduleLater(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(function () {
    pendingTimers.delete(timer)
    audioCounters.timers = pendingTimers.size
    callback()
  }, Math.max(0, delayMs))
  pendingTimers.add(timer)
  audioCounters.timers = pendingTimers.size
  return timer
}

function clearPendingTimers(): void {
  pendingTimers.forEach(function (timer) {
    clearTimeout(timer)
  })
  pendingTimers.clear()
  audioCounters.timers = 0
}

/**
 * 把诊断入口挂到 window 上。
 *
 * 控制台里 `__pfAudioStats()` 返回当前存活对象数，`__pfLogAudioStats()` 直接打印。
 * 排查「内存一直涨」时先看借出链与定时器有没有回落，再看 voices 是否为 0。
 */
function exposeAudioDiagnostics(): void {
  if (typeof window === 'undefined') return
  const target = window as unknown as {
    __pfAudioStats?: () => AudioStats
    __pfLogAudioStats?: (reason?: string) => void
  }
  target.__pfAudioStats = audioStats
  target.__pfLogAudioStats = function (reason?: string) {
    logAudioStats(reason === undefined ? '手动' : reason)
  }
}

/**
 * 池满时的轻量提示。
 *
 * 降级本身是静默的（音符照常发声，只是换成轨道效果），用户只会觉得「这个音符的
 * 混响怎么跟旁边不一样」，所以必须给出一次可见的解释；但一次播放里可能连续几百次
 * 借不到链，这里按 8 秒节流，避免 toast 把界面糊满。
 */
function warnNoteChainStarved(): void {
  const now = Date.now()
  if (now - noteChainWarnAt < NOTE_CHAIN_WARN_INTERVAL_MS) return
  noteChainWarnAt = now
  showToast('独立效果器并发已达上限（' + NOTE_CHAIN_LIMIT + ' 条），部分音符改用轨道默认效果', 'warn')
}

/** 失真曲线：tanh(k·x)，drive 0–1 映射到 k 1–50。 */
function buildDistortionCurve(drive: number): Float32Array {
  const size = 1024
  const curve = new Float32Array(size)
  const k = 1 + clamp(drive, 0, 1) * 49
  for (let i = 0; i < size; i += 1) {
    const x = (i / (size - 1)) * 2 - 1
    curve[i] = Math.tanh(k * x) / Math.tanh(k)
  }
  return curve
}

/** 混响阻尼映射的截止频率上下限（Hz）：0 = 全开，1 = 收到 1.2kHz。 */
const DAMPING_OPEN_HZ = 20000
const DAMPING_CLOSED_HZ = 1200

/**
 * 把 0–1 的阻尼值映射成混响低通的截止频率。
 *
 * 采用对数映射而不是线性：人耳对高频衰减的感知接近倍频程，
 * 线性映射会让滑杆前半段几乎没有变化。0.75 落在约 2.4kHz，
 * 正好让镲片、齿音这类高频在尾音里先消失，而贝斯与军鼓的主体还在，
 * 听感上就是「房间把高频吸掉了」，而不是整条混响被压暗。
 */
function dampingCutoff(damping: number): number {
  const amount = clamp(damping, 0, 1)
  return DAMPING_OPEN_HZ * Math.pow(DAMPING_CLOSED_HZ / DAMPING_OPEN_HZ, amount)
}

/**
 * 生成的 IR 按「采样率 + 衰减时间」缓存。
 *
 * 每条轨道、每个音符链都带一个 Convolver；如果每次创建链都重新生成 2 秒
 * 立体声噪声，光初始化就会卡住主线程。同衰减时间的 IR 完全可以共用。
 */
const impulseCache = new Map<string, AudioBuffer>()

/** 程序生成混响 IR：指数衰减的立体声白噪声。 */
function generateImpulse(ctx: BaseAudioContext, decay: number): AudioBuffer {
  const seconds = clamp(decay, 0.2, 4)
  const key = ctx.sampleRate + ':' + seconds.toFixed(2)
  const cached = impulseCache.get(key)
  if (cached !== undefined) return cached
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds))
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < length; i += 1) {
      const t = i / length
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.2)
    }
  }
  // 缓存上限：用户连续拖 Decay 滑杆也不会无限增长
  if (impulseCache.size > 16) impulseCache.clear()
  impulseCache.set(key, buffer)
  return buffer
}

/** 白噪声缓存（每 2 秒一段，循环使用，避免每次触发都分配）。 */
let noiseBuffer: AudioBuffer | null = null
function getNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  if (noiseBuffer !== null && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer
  const length = Math.floor(ctx.sampleRate * 2)
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1
  noiseBuffer = buffer
  return buffer
}

/** 一条效果链的句柄。 */
interface FxChainHandle {
  input: GainNode
  output: GainNode
  update(fx: FxState): void
  dispose(): void
}

/** 构建一条 失真 → 低通 → 延迟 → 混响 的串联链。 */
function createFxChain(ctx: BaseAudioContext, fx: FxState): FxChainHandle {
  const input = ctx.createGain()
  const shaper = ctx.createWaveShaper()
  shaper.oversample = '4x'
  const filter = ctx.createBiquadFilter()
  filter.type = 'lowpass'
  const delay = ctx.createDelay(1.2)
  const feedback = ctx.createGain()
  const delayWet = ctx.createGain()
  const reverbDry = ctx.createGain()
  const convolver = ctx.createConvolver()
  // 混响阻尼：接在卷积之后，只削混响尾音的高频，不影响干声与直达声
  const dampingFilter = ctx.createBiquadFilter()
  dampingFilter.type = 'lowpass'
  dampingFilter.Q.setValueAtTime(0.7, 0)
  const reverbWet = ctx.createGain()
  const output = ctx.createGain()

  input.connect(shaper)
  shaper.connect(filter)
  // 延迟段：干路直通 + 湿路带反馈
  filter.connect(reverbDry)
  filter.connect(delay)
  delay.connect(feedback)
  feedback.connect(delay)
  delay.connect(delayWet)
  delayWet.connect(reverbDry)
  // 混响段：干湿并联，湿路先过卷积再被阻尼低通
  reverbDry.connect(output)
  reverbDry.connect(convolver)
  convolver.connect(dampingFilter)
  dampingFilter.connect(reverbWet)
  reverbWet.connect(output)

  let currentImpulse = -1
  let disposed = false

  function update(next: FxState): void {
    if (disposed) return
    const now = ctx.currentTime
    shaper.curve = buildDistortionCurve(next.drive)
    filter.frequency.setTargetAtTime(clamp(next.cutoff, 20, 20000), now, 0.01)
    filter.Q.setTargetAtTime(clamp(next.resonance, 0.1, 20), now, 0.01)
    delay.delayTime.setTargetAtTime(clamp(next.delayMs, 20, 1000) / 1000, now, 0.02)
    feedback.gain.setTargetAtTime(clamp(next.feedback, 0, 0.9), now, 0.02)
    delayWet.gain.setTargetAtTime(clamp(next.delayWet, 0, 1), now, 0.02)
    reverbDry.gain.setTargetAtTime(1 - clamp(next.reverbWet, 0, 1), now, 0.02)
    reverbWet.gain.setTargetAtTime(clamp(next.reverbWet, 0, 1), now, 0.02)
    // 阻尼用 20ms 平滑跟随，避免拖动滑杆时出现「zipper」噪声
    dampingFilter.frequency.setTargetAtTime(dampingCutoff(next.damping), now, 0.02)
    dampingFilter.Q.setTargetAtTime(0.7, now, 0.02)
    // IR 只在衰减时间明显变化时重建，避免拖动滑杆时不断分配大缓冲
    if (Math.abs(currentImpulse - next.decay) > 0.05) {
      currentImpulse = next.decay
      convolver.buffer = generateImpulse(ctx, next.decay)
    }
  }

  function dispose(): void {
    disposed = true
    ;[input, shaper, filter, delay, feedback, delayWet, reverbDry, convolver, dampingFilter, reverbWet, output].forEach(function (node) {
      try {
        node.disconnect()
      } catch (error) {
        logDaw('warn', '效果器节点断开失败', error)
      }
    })
  }

  update(fx)
  return { input: input, output: output, update: update, dispose: dispose }
}

/** 单个 voice 的清理函数集合。 */
interface VoiceHandle {
  stop(at: number): void
  /** 试听时立刻释放。 */
  release(): void
}

/**
 * 统一的节点回收：在 onended 里断开所有节点。
 *
 * 除了正常的 onended，还会挂一个「兜底回收」定时器：AudioContext 被挂起
 * （切后台、系统休眠）时 onended 可能迟迟不触发，那些振荡器与增益就永远
 * 挂在图上，内存只涨不落。兜底定时器在预计结束时间之后强制 release 一次，
 * release 本身是幂等的，不会重复断开。
 */
function makeVoice(oscillators: AudioScheduledSourceNode[], envelope: GainNode, extra: AudioNode[]): VoiceHandle {
  let released = false
  audioCounters.voices += 1
  function release(): void {
    if (released) return
    released = true
    audioCounters.voices = Math.max(0, audioCounters.voices - 1)
    oscillators.forEach(function (node) {
      try {
        node.stop()
      } catch (error) {
        // 已经停过的源再 stop 会抛 InvalidStateError，属于正常路径
        void error
      }
      try {
        node.onended = null
        node.disconnect()
      } catch (error) {
        logDaw('warn', '振荡器断开失败', error)
      }
    })
    extra.forEach(function (node) {
      try {
        node.disconnect()
      } catch (error) {
        logDaw('warn', '音频节点断开失败', error)
      }
    })
    try {
      envelope.disconnect()
    } catch (error) {
      logDaw('warn', '包络断开失败', error)
    }
  }
  oscillators.forEach(function (node) {
    node.onended = release
  })
  return {
    stop: function (at: number) {
      oscillators.forEach(function (node) {
        try {
          node.stop(at)
        } catch (error) {
          logDaw('warn', '定时停止失败', error)
        }
      })
    },
    release: release,
  }
}

/**
 * 触发一个音符。所有时间参数都是 AudioContext 时间轴上的绝对秒数，
 * 因此同一函数既服务实时播放，也服务 OfflineAudioContext 离线渲染。
 *
 * 真实发声逻辑在 `buildVoice` 里；这里额外挂一个兜底回收定时器——AudioContext
 * 被挂起时 `onended` 不会按时触发，节点会一直挂在图上。定时器只保留到
 * 「预计结束 + 混响尾巴」之后，触发时直接 release（幂等）。
 */
function scheduleVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  track: TrackSpec,
  pitch: number,
  velocity: number,
  when: number,
  duration: number,
): VoiceHandle {
  const voice = buildVoice(ctx, dest, track, pitch, velocity, when, duration)
  const tailSeconds = Math.max(0, when - ctx.currentTime) + Math.max(0.02, duration) + 2.5
  scheduleLater(function () {
    voice.release()
  }, tailSeconds * 1000)
  return voice
}

/** 建立一个 voice：选引擎、建节点、排包络、启动并在结束时回收。 */
function buildVoice(
  ctx: BaseAudioContext,
  dest: AudioNode,
  track: TrackSpec,
  pitch: number,
  velocity: number,
  when: number,
  duration: number,
): VoiceHandle {
  const vel = clamp(velocity, 0, 127) / 127
  const peak = clamp(track.gain, 0, 1) * vel
  const env = ctx.createGain()
  env.gain.setValueAtTime(0, when)
  env.connect(dest)
  const extra: AudioNode[] = []
  const oscillators: AudioScheduledSourceNode[] = []
  const adsr = track.adsr
  const attack = clamp(adsr.attack, 0.001, 1)
  const decay = clamp(adsr.decay, 0.01, 1)
  const sustain = clamp(adsr.sustain, 0, 1)
  const releaseTime = clamp(adsr.release, 0.01, 2)
  const holdEnd = when + Math.max(0.02, duration)

  function adsrEnvelope(): void {
    env.gain.linearRampToValueAtTime(Math.max(0.0001, peak), when + attack)
    env.gain.linearRampToValueAtTime(Math.max(0.0001, peak * sustain), when + attack + decay)
    env.gain.setValueAtTime(Math.max(0.0001, peak * sustain), holdEnd)
    env.gain.linearRampToValueAtTime(0.0001, holdEnd + releaseTime)
  }

  if (track.engine === 'kick') {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(150, when)
    osc.frequency.exponentialRampToValueAtTime(45, when + 0.12)
    const amp = ctx.createGain()
    amp.gain.setValueAtTime(Math.max(0.0001, peak), when)
    amp.gain.exponentialRampToValueAtTime(0.0001, when + 0.34)
    osc.connect(amp)
    amp.connect(env)
    env.gain.setValueAtTime(Math.max(0.0001, 1), when)
    osc.start(when)
    osc.stop(when + 0.36)
    oscillators.push(osc)
    extra.push(amp)
    return makeVoice(oscillators, env, extra)
  }

  if (track.engine === 'snare' || track.engine === 'hat') {
    const noise = ctx.createBufferSource()
    noise.buffer = getNoiseBuffer(ctx)
    noise.loop = true
    const highpass = ctx.createBiquadFilter()
    highpass.type = 'highpass'
    const duration2 = track.engine === 'snare' ? 0.2 : track.engine === 'hat' ? 0.06 : 0.3
    highpass.frequency.setValueAtTime(track.engine === 'snare' ? 1800 : 7200, when)
    const amp = ctx.createGain()
    amp.gain.setValueAtTime(Math.max(0.0001, peak), when)
    amp.gain.exponentialRampToValueAtTime(0.0001, when + duration2)
    env.gain.setValueAtTime(Math.max(0.0001, 1), when)
    noise.connect(highpass)
    highpass.connect(amp)
    amp.connect(env)
    noise.start(when)
    noise.stop(when + duration2 + 0.01)
    oscillators.push(noise)
    extra.push(highpass, amp)
    return makeVoice(oscillators, env, extra)
  }

  // 贝斯：锯齿 + 低通 + ADSR；合成器：可选波形 + ADSR
  const osc = ctx.createOscillator()
  osc.type = track.engine === 'bass' ? 'sawtooth' : track.wave
  osc.frequency.setValueAtTime(midiToFreq(pitch), when)
  let tail: AudioNode = osc
  if (track.engine === 'bass') {
    const lowpass = ctx.createBiquadFilter()
    lowpass.type = 'lowpass'
    lowpass.frequency.setValueAtTime(clamp(220 + pitch * 8, 120, 4000), when)
    lowpass.Q.setValueAtTime(6, when)
    osc.connect(lowpass)
    tail = lowpass
    extra.push(lowpass)
  }
  tail.connect(env)
  adsrEnvelope()
  osc.start(when)
  osc.stop(holdEnd + releaseTime + 0.05)
  oscillators.push(osc)
  return makeVoice(oscillators, env, extra)
}

// ---------------------------------------------------------------------------
// 实时引擎单例
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null
let masterGain: GainNode | null = null
/** 每条轨道一条独立效果链；轨道参数 = Master + 轨道覆盖。 */
let trackChains: FxChainHandle[] = []
/** 单音符覆盖用的链池：空闲链等待复用，占用数用于限流。 */
let noteChainPool: FxChainHandle[] = []
let noteChainsInUse = 0
/** 排程循环的 interval 句柄；停止播放时清掉。 */
let schedulerTimer: ReturnType<typeof setInterval> | null = null
let nextStepTime = 0
let playStep = 0
let playbackActive = false
/** 上一次打印对象统计的时刻；播放中每 10 秒打一条，便于观察回收是否跟上。 */
let lastStatsLogAt = 0
const STATS_LOG_INTERVAL_MS = 10000
const LOOKAHEAD_SECONDS = 0.12
const SCHEDULER_INTERVAL_MS = 25

/** 惰性创建 AudioContext 与固定 FX 拓扑；重复调用返回同一实例。 */
function ensureAudioEngine(): boolean {
  if (audioCtx !== null) return true
  try {
    const Ctor: typeof AudioContext | undefined =
      typeof AudioContext !== 'undefined' ? AudioContext : (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (Ctor === undefined) {
      logDaw('error', '当前环境不支持 Web Audio')
      return false
    }
    const ctx = new Ctor()
    const master = ctx.createGain()
    master.gain.value = 0.8
    master.connect(ctx.destination)
    const chains: FxChainHandle[] = []
    for (let i = 0; i < TRACK_COUNT; i += 1) {
      const chain = createFxChain(ctx, trackFx(dawState.project, i))
      chain.output.connect(master)
      chains.push(chain)
    }
    audioCtx = ctx
    masterGain = master
    trackChains = chains
    // 允许在控制台直接查对象数：__pfAudioStats() / __pfLogAudioStats('播放中')
    exposeAudioDiagnostics()
    setAudioStateLabel(ctx.state === 'running' ? '音频运行中' : '音频已挂起')
    ctx.onstatechange = function () {
      setAudioStateLabel(ctx.state === 'running' ? '音频运行中' : '音频已挂起')
    }
    return true
  } catch (error) {
    logDaw('error', '创建 AudioContext 失败', error)
    showToast('音频初始化失败，编辑器仍可编辑与导出工程', 'warn')
    return false
  }
}

/** 首次用户手势里调用：把挂起的上下文恢复为 running。 */
function resumeAudioContext(): Promise<boolean> {
  if (!ensureAudioEngine() || audioCtx === null) return Promise.resolve(false)
  if (audioCtx.state === 'running') return Promise.resolve(true)
  return audioCtx.resume().then(
    function () {
      setAudioStateLabel('音频运行中')
      return true
    },
    function (error: unknown) {
      logDaw('warn', 'AudioContext resume 失败', error)
      showToast('浏览器拒绝了音频播放，请再点一次面板', 'warn')
      setAudioStateLabel('音频被拒绝')
      return false
    },
  )
}

/** 把某个轨道接到它自己的效果链入口。 */
function trackInput(trackId: number): GainNode | null {
  const chain = trackChains[clampInt(trackId, 0, TRACK_COUNT - 1)]
  return chain === undefined ? null : chain.input
}

/**
 * 借一条音符专属效果链（对象池）。
 *
 * 池里没有空闲链时就新建，但总数不超过 NOTE_CHAIN_LIMIT；达到上限后返回 null，
 * 调用方会让这个音符退回轨道链——宁可少一点效果差异，也不能让几十个
 * Convolver 同时跑。链的输出在创建时就接到主增益，归还后不再重连。
 */
function acquireNoteChain(fx: FxState): FxChainHandle | null {
  const ctx = audioCtx
  const master = masterGain
  if (ctx === null || master === null) return null
  if (noteChainsInUse >= NOTE_CHAIN_LIMIT) return null
  let chain = noteChainPool.pop()
  if (chain === undefined) {
    chain = createFxChain(ctx, fx)
    chain.output.connect(master)
  } else {
    chain.update(fx)
  }
  noteChainsInUse += 1
  return chain
}

/**
 * 归还音符链：等混响尾音收完再放回池里，避免复用把上一个音符的尾音掐断。
 *
 * 这里有三道防线，任何一道失效都会变成「僵尸链」：
 *  1. 归还定时器登记在 pendingTimers 里，卸载时会被统一清掉；
 *  2. 引擎已经关闭时不再入池，直接 dispose（否则链及其 Convolver 永远不释放）；
 *  3. 入池后再做一次上限裁剪，超出部分立即 dispose。
 */
function releaseNoteChain(chain: FxChainHandle, delaySeconds: number): void {
  let returned = false
  scheduleLater(function () {
    if (returned) return
    returned = true
    noteChainsInUse = Math.max(0, noteChainsInUse - 1)
    if (audioCtx === null) {
      // 播放期间面板被关掉：没有池可归，直接销毁，别把节点留在图上
      chain.dispose()
      return
    }
    noteChainPool.push(chain)
    if (noteChainPool.length > NOTE_CHAIN_LIMIT) {
      const extra = noteChainPool.pop()
      if (extra !== undefined) extra.dispose()
    }
  }, Math.max(0, delaySeconds) * 1000)
}

/** 开始实时播放：从第 0 步起按音频时钟排程。 */
function startAudioEngine(): boolean {
  if (!ensureAudioEngine() || audioCtx === null) return false
  if (audioCtx.state === 'suspended') {
    resumeAudioContext().then(function (ok) {
      if (ok && dawState.playing) startScheduler()
    })
  }
  startScheduler()
  return true
}

/** 排程循环：提前 120ms 把步子写进音频时间轴，光标靠定时器回推。 */
function startScheduler(): void {
  if (audioCtx === null) return
  if (schedulerTimer !== null) clearInterval(schedulerTimer)
  playbackActive = true
  playStep = 0
  lastStatsLogAt = Date.now()
  nextStepTime = audioCtx.currentTime + 0.06
  schedulerTimer = setInterval(function () {
    pumpScheduler()
  }, SCHEDULER_INTERVAL_MS)
  pumpScheduler()
}

function pumpScheduler(): void {
  const ctx = audioCtx
  if (ctx === null || !playbackActive) return
  const horizon = ctx.currentTime + LOOKAHEAD_SECONDS
  while (nextStepTime < horizon) {
    scheduleStep(playStep, nextStepTime)
    const stepIndex = playStep
    const delayMs = Math.max(0, (nextStepTime - ctx.currentTime) * 1000)
    // 光标回推也走登记过的定时器：停止播放时统一清掉，不会留下几百个待触发回调
    scheduleLater(function () {
      if (playbackActive) setPlayCursor(stepIndex)
    }, delayMs)
    nextStepTime += stepDuration(dawState.project.bpm)
    playStep = (playStep + 1) % TOTAL_STEPS
  }
  const now = Date.now()
  if (now - lastStatsLogAt >= STATS_LOG_INTERVAL_MS) {
    lastStatsLogAt = now
    logAudioStats('播放中')
  }
}

/**
 * 排程一步内的所有音符（只排 step 完全相等的音符，长音按自身长度延展）。
 *
 * - offset 以毫秒为单位加到音频时间轴上，负偏移被夹到当前时刻；
 * - 带 fxOverrides 的音符从池里借一条专属链，播放结束（含混响尾音）后归还；
 * - 借不到专属链时退回轨道链，UI 上的小圆点仍然保留（表示数据层面有覆盖）。
 */
function scheduleStep(step: number, when: number): void {
  const ctx = audioCtx
  if (ctx === null) return
  for (const note of dawState.project.notes) {
    if (note.step !== step) continue
    const track = trackAt(dawState.project, note.track)
    if (track.muted) continue
    const start = noteStartSeconds(when, note.offset, ctx.currentTime)
    const duration = stepDuration(dawState.project.bpm) * clamp(note.length, NOTE_MIN_STEPS, NOTE_MAX_STEPS)
    const dest = trackInput(note.track)
    if (dest === null) continue
    if (!hasFxOverride(note)) {
      scheduleVoice(ctx, dest, track, note.pitch, note.velocity, start, duration)
      continue
    }
    const chain = acquireNoteChain(noteFx(dawState.project, note))
    if (chain === null) {
      // 池满：降级到轨道链，同时（节流地）告诉用户发生了什么
      warnNoteChainStarved()
      scheduleVoice(ctx, dest, track, note.pitch, note.velocity, start, duration)
      continue
    }
    scheduleVoice(ctx, chain.input, track, note.pitch, note.velocity, start, duration)
    releaseNoteChain(chain, start - ctx.currentTime + duration + NOTE_CHAIN_TAIL_SECONDS)
  }
}

/** 停止播放并清空排程定时器。 */
function stopAudioEngine(): void {
  playbackActive = false
  if (schedulerTimer !== null) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
  }
  // 光标回推、voice 兜底回收都登记在 pendingTimers 里；停止播放后它们再无意义
  clearPendingTimers()
  logAudioStats('停止播放')
}

/** 卸载时彻底释放音频资源。 */
function disposeAudioEngine(): void {
  stopAudioEngine()
  // 归还链的定时器已由 clearPendingTimers 清掉，池里与借出的链在这里统一销毁
  clearPendingTimers()
  trackChains.forEach(function (chain) {
    chain.dispose()
  })
  trackChains = []
  noteChainPool.forEach(function (chain) {
    chain.dispose()
  })
  noteChainPool = []
  noteChainsInUse = 0
  noteChainWarnAt = 0
  audioCounters.voices = 0
  impulseCache.clear()
  noiseBuffer = null
  if (masterGain !== null) {
    try {
      masterGain.disconnect()
    } catch (error) {
      logDaw('warn', '主增益断开失败', error)
    }
    masterGain = null
  }
  if (audioCtx !== null) {
    const ctx = audioCtx
    audioCtx = null
    ctx.close().catch(function (error: unknown) {
      logDaw('warn', 'AudioContext 关闭失败', error)
    })
  }
  setAudioStateLabel('音频已释放')
  logAudioStats('释放引擎')
}

/** BPM 变化即时生效：下一步的步长直接用新 BPM 计算，这里只更新状态栏。 */
function applyEngineBpm(bpm: number): void {
  if (dawState.playing) patchDaw({ status: 'BPM ' + clampInt(bpm, BPM_MIN, BPM_MAX) + ' · 播放中' })
}

/** 参数变化时把「Master + 各轨道覆盖」推给每条轨道链。 */
function applyEngineFx(): void {
  const project = dawState.project
  for (let i = 0; i < trackChains.length; i += 1) {
    trackChains[i].update(trackFx(project, i))
  }
}

/** 从钢琴卷帘键盘条试听一个音高（约 0.4 秒）。 */
function auditionPitch(trackId: number, pitch: number): void {
  if (!ensureAudioEngine() || audioCtx === null) return
  const ctx = audioCtx
  const start = function (): void {
    const track = trackAt(dawState.project, trackId)
    const dest = trackInput(trackId)
    if (dest === null) return
    scheduleVoice(ctx, dest, track, clampInt(pitch, PITCH_LOW, PITCH_HIGH), 100, ctx.currentTime + 0.01, 0.28)
  }
  if (ctx.state === 'running') {
    start()
    return
  }
  resumeAudioContext().then(function (ok) {
    if (ok) start()
  })
}
