/**
 * 离线渲染与文件下载：WAV（OfflineAudioContext + 16-bit PCM）与工程 JSON。
 */

/** 工程中最后一个音符的结束时间（秒）；空工程给出 2 秒。 */
function projectDurationSeconds(project: ProjectFile): number {
  const step = stepDuration(project.bpm)
  let lastStep = 0
  project.notes.forEach(function (note) {
    lastStep = Math.max(lastStep, note.step + clamp(note.length, NOTE_MIN_STEPS, NOTE_MAX_STEPS))
  })
  return clamp(Math.max(2, lastStep * step + 1.2), 2, MAX_EXPORT_SECONDS)
}

/** 16-bit 立体声 PCM 编码为 WAV 容器。 */
function encodeWav(buffer: AudioBuffer): Blob {
  const channels = Math.min(2, buffer.numberOfChannels)
  const frames = buffer.length
  const bytesPerSample = 2
  const blockAlign = channels * bytesPerSample
  const dataSize = frames * blockAlign
  const view = new DataView(new ArrayBuffer(44 + dataSize))

  function writeAscii(offset: number, text: string): void {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataSize, true)

  const data: Float32Array[] = []
  for (let channel = 0; channel < channels; channel += 1) data.push(buffer.getChannelData(channel))

  let offset = 44
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = clamp(data[channel][frame], -1, 1)
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return new Blob([view.buffer], { type: 'audio/wav' })
}

/** 触发一次浏览器下载；URL 在校验后立即释放。 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  setTimeout(function () {
    URL.revokeObjectURL(url)
  }, 4000)
}

/** 时间戳形如 20261109-211530，用于导出文件名。 */
function fileTimestamp(): string {
  const now = new Date()
  function pad(value: number): string {
    return value < 10 ? '0' + value : String(value)
  }
  return (
    String(now.getFullYear()) +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  )
}

/** 导出工程 JSON（用户可留存的备份）。 */
function exportProjectJson(): void {
  try {
    const payload = JSON.stringify(dawState.project, null, 2)
    downloadBlob(new Blob([payload], { type: 'application/json' }), 'pulseforge-' + fileTimestamp() + '.json')
    setStatus('已导出工程 JSON')
  } catch (error) {
    logDaw('error', '导出工程 JSON 失败', error)
    showToast('工程 JSON 导出失败，请重试', 'warn')
  }
}

/**
 * 用 OfflineAudioContext 渲染整首曲子并下载 WAV。
 * 失败时保留工程数据，只弹提示，不改变编辑状态。
 */
function exportWav(): Promise<void> {
  const project = dawState.project
  const seconds = projectDurationSeconds(project)
  const sampleRate = 44100
  const frames = Math.ceil(seconds * sampleRate)
  setStatus('正在离线渲染…')
  patchDaw({ exporting: true })

  return Promise.resolve()
    .then(function () {
      const Ctor: typeof OfflineAudioContext | undefined =
        typeof OfflineAudioContext !== 'undefined'
          ? OfflineAudioContext
          : (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext
      if (Ctor === undefined) throw new Error('当前环境不支持 OfflineAudioContext')
      const ctx = new Ctor(2, frames, sampleRate)
      const master = ctx.createGain()
      master.gain.value = 0.8
      master.connect(ctx.destination)
      // 每条轨道一条独立链，参数 = Master + 轨道覆盖（与实时引擎完全一致）
      const trackChainsOffline: FxChainHandle[] = []
      for (let i = 0; i < TRACK_COUNT; i += 1) {
        const chain = createFxChain(ctx, trackFx(project, i))
        chain.output.connect(master)
        trackChainsOffline.push(chain)
      }
      /**
       * 音符专属链池（离线版）。
       *
       * 离线渲染一次性把整首排完，没法靠 onended 回收，因此按「时间窗内同时
       * 存活的链数」限流：窗口内空闲的链直接复用，全部忙且已达 NOTE_CHAIN_LIMIT
       * 时该音符退回轨道链。这样即使几十个音符都带长混响，Convolver 数量也只
       * 有上限个，导出不会因为节点爆炸而中断。
       */
      const offlinePool: { chain: FxChainHandle; endAt: number }[] = []
      function pickOfflineChain(fx: FxState, startAt: number, endAt: number): FxChainHandle | null {
        for (const item of offlinePool) {
          if (item.endAt <= startAt) {
            item.chain.update(fx)
            item.endAt = endAt
            return item.chain
          }
        }
        if (offlinePool.length >= NOTE_CHAIN_LIMIT) return null
        const chain = createFxChain(ctx, fx)
        chain.output.connect(master)
        offlinePool.push({ chain: chain, endAt: endAt })
        return chain
      }
      const step = stepDuration(project.bpm)
      for (const note of project.notes) {
        const track = trackAt(project, note.track)
        if (track.muted) continue
        const dest = trackChainsOffline[clampInt(note.track, 0, TRACK_COUNT - 1)]
        if (dest === undefined) continue
        const when = note.step * step
        if (when >= seconds) continue
        const start = noteStartSeconds(when, note.offset, 0)
        const duration = step * clamp(note.length, NOTE_MIN_STEPS, NOTE_MAX_STEPS)
        if (!hasFxOverride(note)) {
          scheduleVoice(ctx, dest.input, track, note.pitch, note.velocity, start, duration)
          continue
        }
        const chain = pickOfflineChain(noteFx(project, note), start, start + duration + NOTE_CHAIN_TAIL_SECONDS)
        scheduleVoice(
          ctx,
          chain === null ? dest.input : chain.input,
          track,
          note.pitch,
          note.velocity,
          start,
          duration,
        )
      }
      return ctx.startRendering().then(function (rendered) {
        trackChainsOffline.forEach(function (chain) {
          chain.dispose()
        })
        offlinePool.forEach(function (item) {
          item.chain.dispose()
        })
        return encodeWav(rendered)
      })
    })
    .then(function (blob) {
      downloadBlob(blob, 'pulseforge-' + fileTimestamp() + '.wav')
      patchDaw({ exporting: false })
      setStatus('已导出 WAV（' + seconds.toFixed(1) + ' 秒）')
    })
    .catch(function (error: unknown) {
      patchDaw({ exporting: false })
      logDaw('error', 'WAV 导出失败', error)
      showToast('WAV 导出失败，工程数据已保留', 'warn')
      setStatus('导出失败')
    })
}
