import { ref, watch, onUnmounted, type Ref } from 'vue'
import {
  Input, UrlSource, CanvasSink, ALL_FORMATS,
  Output, AdtsOutputFormat, BufferTarget,
  EncodedPacketSink, EncodedAudioPacketSource,
  InputAudioTrack,
} from 'mediabunny'

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
  let videoFrameIterator: AsyncGenerator<any, void, unknown> | null = null
  let nextFrame: any = null
  let context: CanvasRenderingContext2D | null = null
  let firstTimestamp = 0
  let endTimestamp = 0
  let playbackTimeAtStart = 0
  let rafId = -1
  let asyncId = 0
  let audioBlobUrl: string | null = null

  const extractAudioToNative = async (audioEl: HTMLAudioElement, vol: number, audioTrack: InputAudioTrack) => {
    const audioCodec = await audioTrack.getCodec()
    if (!audioCodec) return

    const audioSource = new EncodedAudioPacketSource(audioCodec)
    const audioOutput = new Output({
      format: new AdtsOutputFormat(),
      target: new BufferTarget(),
    })
    audioOutput.addAudioTrack(audioSource)
    await audioOutput.start()

    const decoderConfig = await audioTrack.getDecoderConfig()
    const sink = new EncodedPacketSink(audioTrack)
    let isFirst = true
    for await (const packet of sink.packets()) {
      if (packet.timestamp < 0) continue
      const meta = isFirst && decoderConfig ? { decoderConfig } : undefined
      await audioSource.add(packet, meta)
      isFirst = false
    }
    await audioOutput.finalize()

    const buffer = (audioOutput.target as BufferTarget).buffer
    if (!buffer) return
    const mimeType = await audioOutput.getMimeType()
    const blob = new Blob([buffer], { type: mimeType })
    audioBlobUrl = URL.createObjectURL(blob)
    hasAudio.value = true
    audioEl.src = audioBlobUrl
    audioEl.volume = vol
  }

  const init = async () => {
    try {
      if (!canvasRef.value) {
        throw new Error('Canvas ref is null')
      }

      context = canvasRef.value.getContext('2d')
      if (!context) {
        throw new Error('Failed to get 2D context')
      }

      const input = new Input({
        source: new UrlSource(src),
        formats: ALL_FORMATS,
      })

      const videoTrack = await input.getPrimaryVideoTrack()
      const audioTrack = await input.getPrimaryAudioTrack()

      if (!videoTrack) {
        throw new Error('No video track found')
      }

      const codec = await videoTrack.getCodec()
      if (!codec) {
        throw new Error('Unsupported video codec')
      }

      const canDecode = await videoTrack.canDecode()
      if (!canDecode) {
        throw new Error(`Unable to decode video codec: ${codec}`)
      }

      const tracks = [videoTrack, audioTrack].filter((t) => t !== null)
      firstTimestamp = Math.max(await input.getFirstTimestamp(tracks), 0)
      endTimestamp =
        (await input.getDurationFromMetadata(tracks, { skipLiveWait: true })) ??
        (await input.computeDuration(tracks, { skipLiveWait: true }))

      playbackTimeAtStart = firstTimestamp
      duration.value = endTimestamp - firstTimestamp

      const width = await videoTrack.getDisplayWidth()
      const height = await videoTrack.getDisplayHeight()

      canvasRef.value.width = width
      canvasRef.value.height = height

      const canBeTransparent = await videoTrack.canBeTransparent()
      videoSink = new CanvasSink(videoTrack, {
        poolSize: 2,
        fit: 'contain',
        alpha: canBeTransparent,
      })

      if (audioTrack) {
        if (!audioRef?.value) throw new Error('audioRef is required when the media has an audio track')
        await extractAudioToNative(audioRef.value, volume, audioTrack)
      }

      onLoadedMetadata?.({ duration: duration.value, width, height })

      await startVideoIterator()

      if (autoplay) {
        await play()
      }
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

    await videoFrameIterator?.return()

    videoFrameIterator = videoSink.canvases(getPlaybackTime())

    const firstFrame = (await videoFrameIterator.next()).value ?? null
    const secondFrame = (await videoFrameIterator.next()).value ?? null

    if (currentAsyncId !== asyncId) return

    nextFrame = secondFrame

    if (firstFrame && canvasRef.value) {
      context.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
      context.drawImage(firstFrame.canvas, 0, 0)
    }
  }

  const getPlaybackTime = (): number => {
    if (isPlaying.value && audioRef?.value && hasAudio.value) {
      return audioRef.value.currentTime
    }
    return playbackTimeAtStart
  }

  const updateNextFrame = async () => {
    const currentAsyncId = asyncId

    while (true) {
      if (!videoFrameIterator) break

      const newNextFrame = (await videoFrameIterator.next()).value ?? null
      if (!newNextFrame) break

      if (currentAsyncId !== asyncId) break

      const playbackTime = getPlaybackTime()
      if (newNextFrame.timestamp <= playbackTime) {
        if (context && canvasRef.value) {
          context.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
          context.drawImage(newNextFrame.canvas, 0, 0)
        }
      } else {
        nextFrame = newNextFrame
        break
      }
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
