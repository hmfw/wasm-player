import { ref, watch, onUnmounted, type Ref } from 'vue'
import {
  Input, UrlSource, CanvasSink, ALL_FORMATS,
} from 'mediabunny'
import { extractAudioToNative, applyAudioToElement } from './extractAudioToNative'

type WrappedCanvas = {
  canvas: HTMLCanvasElement | OffscreenCanvas
  timestamp: number
  duration: number
}

interface UseMediabunnyPlayerOptions {
  src: string
  canvasRef: Ref<HTMLCanvasElement | null>
  audioRef?: Ref<HTMLAudioElement | null>
  autoplay?: boolean
  volume?: number
  onError?: (error: Error) => void
  onLoadedMetadata?: (metadata: { duration: number; width: number; height: number }) => void
}

interface UseMediabunnyPlayerReturn {
  isPlaying: Ref<boolean>
  currentTime: Ref<number>
  duration: Ref<number>
  isEnded: Ref<boolean>
  hasAudio: Ref<boolean>
  play: () => Promise<void>
  pause: () => void
  seek: (time: number) => Promise<void>
  setVolume: (volume: number) => void
  destroy: () => void
}

export function useMediabunnyPlayer(
  options: UseMediabunnyPlayerOptions
): UseMediabunnyPlayerReturn {
  const { src, canvasRef, audioRef, autoplay = false, volume = 1, onError, onLoadedMetadata } = options

  const isPlaying = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const isEnded = ref(false)
  const hasAudio = ref(false)

  let videoSink: CanvasSink | null = null
  let videoFrameIterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null
  let nextFrame: WrappedCanvas | null = null
  let context: CanvasRenderingContext2D | null = null
  // mediabunny 时间戳单位为秒，firstTimestamp 通常为 0，但部分容器（如 MKV）首帧不从 0 开始
  let firstTimestamp = 0
  let endTimestamp = 0
  // 暂停或 seek 后记录恢复点；播放中时间源切换为 audioRef.currentTime
  let playbackTimeAtStart = 0
  let rafId = -1
  // 每次 startVideoIterator 递增，用于检测 seek 竞态：异步帧到达时若 asyncId 已变则丢弃
  let asyncId = 0
  let audioBlobUrl: string | null = null

  const setupCanvas = () => {
    if (!canvasRef.value) throw new Error('Canvas ref is null')
    context = canvasRef.value.getContext('2d')
    if (!context) throw new Error('Failed to get 2D context')
  }

  const setupInput = async () => {
    const input = new Input({ source: new UrlSource(src), formats: ALL_FORMATS })
    const videoTrack = await input.getPrimaryVideoTrack()
    const audioTrack = await input.getPrimaryAudioTrack()

    if (!videoTrack) throw new Error('No video track found')
    const codec = await videoTrack.getCodec()
    if (!codec) throw new Error('Unsupported video codec')
    const canDecode = await videoTrack.canDecode()
    if (!canDecode) throw new Error(`Unable to decode video codec: ${codec}`)

    const tracks = [videoTrack, audioTrack].filter((t) => t !== null)
    firstTimestamp = Math.max(await input.getFirstTimestamp(tracks), 0)
    // 优先从元数据读取时长，避免扫描整个文件；元数据缺失时才 computeDuration（会读到 EOF）
    endTimestamp =
      (await input.getDurationFromMetadata(tracks, { skipLiveWait: true })) ??
      (await input.computeDuration(tracks, { skipLiveWait: true }))

    playbackTimeAtStart = firstTimestamp
    duration.value = endTimestamp - firstTimestamp

    const width = await videoTrack.getDisplayWidth()
    const height = await videoTrack.getDisplayHeight()
    canvasRef.value!.width = width
    canvasRef.value!.height = height

    return { videoTrack, audioTrack, width, height }
  }

  const setupVideoSink = async (videoTrack: Awaited<ReturnType<typeof setupInput>>['videoTrack']) => {
    const canBeTransparent = await videoTrack.canBeTransparent()
    videoSink = new CanvasSink(videoTrack, { poolSize: 2, fit: 'contain', alpha: canBeTransparent })
  }

  const init = async () => {
    try {
      setupCanvas()
      const { videoTrack, audioTrack, width, height } = await setupInput()
      await setupVideoSink(videoTrack)

      if (audioTrack) {
        if (!audioRef?.value) throw new Error('audioRef is required when the media has an audio track')
        const result = await extractAudioToNative(audioTrack)
        if (result) {
          audioBlobUrl = result.blobUrl
          hasAudio.value = true
          applyAudioToElement(audioRef.value, result.blobUrl, volume)
        }
      }

      onLoadedMetadata?.({ duration: duration.value, width, height })
      await startVideoIterator()

      if (autoplay) await play()
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      onError?.(error)
      throw error
    }
  }

  const startVideoIterator = async () => {
    if (!videoSink || !context || !canvasRef.value) return

    asyncId++
    const currentAsyncId = asyncId

    // 终止旧迭代器，释放 mediabunny 内部解码队列
    await videoFrameIterator?.return()

    videoFrameIterator = videoSink.canvases(getPlaybackTime())

    // 预取两帧：第一帧立即绘制作为静止预览，第二帧存入 nextFrame 供 render 使用
    const firstFrame = (await videoFrameIterator.next()).value ?? null
    const secondFrame = (await videoFrameIterator.next()).value ?? null

    // seek 竞态检测：若在等待期间又触发了新的 startVideoIterator，则丢弃本次结果
    if (currentAsyncId !== asyncId) return

    nextFrame = secondFrame

    if (firstFrame && canvasRef.value) {
      context.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
      context.drawImage(firstFrame.canvas, 0, 0)
    }
  }

  const getPlaybackTime = (): number => {
    // 播放中以音频时钟为准，保证音视频同步；暂停/seek 时用 playbackTimeAtStart 作为静止时间点
    if (isPlaying.value && audioRef?.value && hasAudio.value) {
      return audioRef.value.currentTime
    }
    return playbackTimeAtStart
  }

  const updateNextFrame = async () => {
    const currentAsyncId = asyncId
    let lastBehindFrame: WrappedCanvas | null = null

    while (true) {
      if (!videoFrameIterator) break

      const newNextFrame = (await videoFrameIterator.next()).value ?? null
      if (!newNextFrame) break

      if (currentAsyncId !== asyncId) break

      const playbackTime = getPlaybackTime()
      if (newNextFrame.timestamp <= playbackTime) {
        // 帧落后于播放时间：继续追帧，不绘制中间帧
        lastBehindFrame = newNextFrame
      } else {
        nextFrame = newNextFrame
        break
      }
    }

    // 所有帧都落后时（如 seek 后快速播放），只绘制最新的一帧
    if (lastBehindFrame && context && canvasRef.value) {
      context.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
      context.drawImage(lastBehindFrame.canvas, 0, 0)
    }
  }

  const render = () => {
    if (!isPlaying.value) return

    const playbackTime = getPlaybackTime()

    currentTime.value = playbackTime

    if (playbackTime >= endTimestamp) {
      pause()
      playbackTimeAtStart = endTimestamp
      isEnded.value = true
      return
    }

    if (nextFrame && nextFrame.timestamp <= playbackTime) {
      if (context && canvasRef.value) {
        context.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
        context.drawImage(nextFrame.canvas, 0, 0)
      }
      nextFrame = null
      void updateNextFrame()
    }

    rafId = requestAnimationFrame(render)
  }

  const play = async () => {
    if (isPlaying.value) return

    if (isEnded.value) {
      await seek(firstTimestamp)
      isEnded.value = false
    }

    isPlaying.value = true

    if (audioRef?.value && hasAudio.value) {
      audioRef.value.currentTime = playbackTimeAtStart
      await audioRef.value.play()
    }

    rafId = requestAnimationFrame(render)
  }

  const pause = () => {
    if (!isPlaying.value) return

    playbackTimeAtStart = getPlaybackTime()
    isPlaying.value = false

    if (audioRef?.value && hasAudio.value) {
      audioRef.value.pause()
    }

    if (rafId !== -1) {
      cancelAnimationFrame(rafId)
      rafId = -1
    }
  }

  const seek = async (time: number) => {
    const wasPlaying = isPlaying.value

    if (wasPlaying) {
      pause()
    }

    playbackTimeAtStart = Math.max(firstTimestamp, Math.min(time, endTimestamp))
    currentTime.value = playbackTimeAtStart

    if (isEnded.value && playbackTimeAtStart < endTimestamp) {
      isEnded.value = false
    }

    if (audioRef?.value && hasAudio.value) {
      audioRef.value.currentTime = playbackTimeAtStart
    }

    await startVideoIterator()

    if (wasPlaying && playbackTimeAtStart < endTimestamp) {
      await play()
    }
  }

  const setVolume = (vol: number) => {
    const clampedVol = Math.max(0, Math.min(1, vol))
    if (audioRef?.value) {
      audioRef.value.volume = clampedVol
    }
  }

  const destroy = () => {
    pause()
    void videoFrameIterator?.return()
    videoFrameIterator = null
    videoSink = null
    nextFrame = null
    context = null
    if (audioBlobUrl) {
      URL.revokeObjectURL(audioBlobUrl)
      audioBlobUrl = null
    }
  }

  watch(
    canvasRef,
    (newCanvas) => {
      if (newCanvas) {
        void init()
      }
    },
    { immediate: true }
  )

  onUnmounted(() => {
    destroy()
  })

  return {
    isPlaying,
    currentTime,
    duration,
    isEnded,
    hasAudio,
    play,
    pause,
    seek,
    setVolume,
    destroy,
  }
}
