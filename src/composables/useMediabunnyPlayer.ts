import { ref, watch, onUnmounted, type Ref } from 'vue'
import {
  Input, UrlSource, CanvasSink, AudioBufferSink, ALL_FORMATS,
  Output, AdtsOutputFormat, BufferTarget,
  EncodedPacketSink, EncodedAudioPacketSource,
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

  // 状态
  const isPlaying = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const isEnded = ref(false)
  const hasAudio = ref(false)

  // 内部状态
  let videoSink: CanvasSink | null = null
  let audioSink: AudioBufferSink | null = null
  let audioContext: AudioContext | null = null
  let gainNode: GainNode | null = null
  let videoFrameIterator: AsyncGenerator<any, void, unknown> | null = null
  let audioBufferIterator: AsyncGenerator<any, void, unknown> | null = null
  let nextFrame: any = null
  let context: CanvasRenderingContext2D | null = null
  let firstTimestamp = 0
  let endTimestamp = 0
  let playbackTimeAtStart = 0
  let audioContextStartTime = 0
  let rafId = -1
  let asyncId = 0
  let performanceStartTime = 0
  let useNativeAudio = false // 是否使用原生 audio 标签
  let inputInstance: Input | null = null
  let audioBlobUrl: string | null = null
  const queuedAudioNodes = new Set<AudioBufferSourceNode>()

  // 提取音频轨道为 ADTS Blob URL，赋给原生 audio 元素
  const extractAudioToNative = async (audioEl: HTMLAudioElement, vol: number) => {
    if (!inputInstance) return
    const audioTrack = await inputInstance.getPrimaryAudioTrack()
    if (!audioTrack) return
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
      // Skip packets with negative timestamps (AAC encoder delay / priming samples)
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
    useNativeAudio = true
    hasAudio.value = true
    audioEl.src = audioBlobUrl
    audioEl.volume = vol
    console.log('Using native <audio> with extracted ADTS audio track')
  }

  // 初始化
  const init = async () => {
    try {
      if (!canvasRef.value) {
        throw new Error('Canvas ref is null')
      }

      context = canvasRef.value.getContext('2d')
      if (!context) {
        throw new Error('Failed to get 2D context')
      }

      // 创建 Input
      const input = new Input({
        source: new UrlSource(src),
        formats: ALL_FORMATS,
      })
      inputInstance = input

      // 获取视频和音频轨道
      const videoTrack = await input.getPrimaryVideoTrack()
      const audioTrack = await input.getPrimaryAudioTrack()

      if (!videoTrack) {
        throw new Error('No video track found')
      }

      // 检查 video codec 支持
      const codec = await videoTrack.getCodec()
      if (!codec) {
        throw new Error('Unsupported video codec')
      }

      console.log('Video codec:', codec)

      const canDecode = await videoTrack.canDecode()
      console.log('Can decode video:', canDecode)

      if (!canDecode) {
        throw new Error(`Unable to decode video codec: ${codec}`)
      }

      // 获取时间范围
      const tracks = [videoTrack, audioTrack].filter((t) => t !== null)
      firstTimestamp = Math.max(await input.getFirstTimestamp(tracks), 0)
      endTimestamp =
        (await input.getDurationFromMetadata(tracks, { skipLiveWait: true })) ??
        (await input.computeDuration(tracks, { skipLiveWait: true }))

      playbackTimeAtStart = firstTimestamp
      duration.value = endTimestamp - firstTimestamp

      console.log('Duration:', duration.value, 'firstTimestamp:', firstTimestamp, 'endTimestamp:', endTimestamp)

      // 获取视频尺寸
      const width = await videoTrack.getDisplayWidth()
      const height = await videoTrack.getDisplayHeight()

      console.log('Video dimensions:', width, 'x', height)

      // 设置 canvas 尺寸
      canvasRef.value.width = width
      canvasRef.value.height = height

      // 创建 CanvasSink
      console.log('Creating CanvasSink...')
      const canBeTransparent = await videoTrack.canBeTransparent()
      console.log('Can be transparent:', canBeTransparent)

      videoSink = new CanvasSink(videoTrack, {
        poolSize: 2,
        fit: 'contain',
        alpha: canBeTransparent,
      })

      console.log('CanvasSink created successfully')

      // 创建 AudioContext 和 AudioBufferSink
      if (audioTrack) {
        try {
          // 检查 audio codec 支持
          const audioCodec = await audioTrack.getCodec()
          if (audioCodec && (await audioTrack.canDecode())) {
            const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
            const sampleRate = await audioTrack.getSampleRate()
            audioContext = new AudioContextClass({ sampleRate })
            gainNode = audioContext.createGain()
            gainNode.connect(audioContext.destination)
            gainNode.gain.value = volume

            audioSink = new AudioBufferSink(audioTrack)
            hasAudio.value = true
            console.log('Audio track initialized with WebCodecs:', audioCodec)
          } else {
            console.warn('Audio codec not supported by WebCodecs, extracting audio track:', audioCodec)
            // 回退到原生 audio 标签（提取纯音频轨道）
            if (audioRef?.value) {
              await extractAudioToNative(audioRef.value, volume)
            }
          }
        } catch (err) {
          console.warn('Failed to initialize WebCodecs audio, extracting audio track:', err)
          // 回退到原生 audio 标签（提取纯音频轨道）
          if (audioRef?.value) {
            await extractAudioToNative(audioRef.value, volume)
          }
        }
      }

      // 触发 metadata 回调
      onLoadedMetadata?.({ duration: duration.value, width, height })

      // 启动视频迭代器
      await startVideoIterator()

      // 自动播放
      if (autoplay) {
        await play()
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      onError?.(error)
      throw error
    }
  }

  // 启动视频迭代器
  const startVideoIterator = async () => {
    if (!videoSink || !context || !canvasRef.value) return

    asyncId++
    const currentAsyncId = asyncId

    await videoFrameIterator?.return()

    // 创建新迭代器
    videoFrameIterator = videoSink.canvases(getPlaybackTime())

    // 获取前两帧
    const firstFrame = (await videoFrameIterator.next()).value ?? null
    const secondFrame = (await videoFrameIterator.next()).value ?? null

    if (currentAsyncId !== asyncId) return

    nextFrame = secondFrame

    if (firstFrame && canvasRef.value) {
      context.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
      context.drawImage(firstFrame.canvas, 0, 0)
    }
  }

  // 获取当前播放时间
  const getPlaybackTime = (): number => {
    if (isPlaying.value) {
      if (useNativeAudio && audioRef?.value) {
        // 使用原生 audio 的 currentTime
        return audioRef.value.currentTime
      } else if (audioContext) {
        // 使用 AudioContext 时钟确保音视频同步
        return audioContext.currentTime - audioContextStartTime + playbackTimeAtStart
      } else {
        // 无音频时使用 performance.now()
        const elapsed = (performance.now() - performanceStartTime) / 1000
        return playbackTimeAtStart + elapsed
      }
    }
    return playbackTimeAtStart
  }

  // 更新下一帧
  const updateNextFrame = async () => {
    const currentAsyncId = asyncId

    while (true) {
      if (!videoFrameIterator) break

      const newNextFrame = (await videoFrameIterator.next()).value ?? null
      if (!newNextFrame) break

      if (currentAsyncId !== asyncId) break

      const playbackTime = getPlaybackTime()
      if (newNextFrame.timestamp <= playbackTime) {
        // 立即绘制
        if (context && canvasRef.value) {
          context.clearRect(0, 0, canvasRef.value.width, canvasRef.value.height)
          context.drawImage(newNextFrame.canvas, 0, 0)
        }
      } else {
        // 保存为下一帧
        nextFrame = newNextFrame
        break
      }
    }
  }

  // 音频播放循环
  const runAudioIterator = async () => {
    if (!audioSink || !audioContext || !gainNode) return

    try {
      for await (const { buffer, timestamp } of audioBufferIterator!) {
        const node = audioContext.createBufferSource()
        node.buffer = buffer
        node.connect(gainNode)

        let startTimestamp = audioContextStartTime + timestamp - playbackTimeAtStart
        // 对齐到采样边界，避免音频毛刺
        startTimestamp =
          Math.round(audioContext.sampleRate * startTimestamp) / audioContext.sampleRate

        if (startTimestamp >= audioContext.currentTime) {
          node.start(startTimestamp)
        } else {
          // 如果音频起点在过去，只播放剩余部分
          node.start(audioContext.currentTime, audioContext.currentTime - startTimestamp)
        }

        queuedAudioNodes.add(node)
        node.onended = () => {
          queuedAudioNodes.delete(node)
        }

        // 如果音频缓冲超前 1 秒，减慢循环
        if (timestamp - getPlaybackTime() >= 1) {
          await new Promise<void>((resolve) => {
            const id = setInterval(() => {
              if (timestamp - getPlaybackTime() < 1) {
                clearInterval(id)
                resolve()
              }
            }, 100)
          })
        }
      }
    } catch (err) {
      // 迭代器被中止（seek 或 pause）
      console.debug('Audio iterator stopped:', err)
    }
  }

  // 渲染循环
  const render = () => {
    if (!isPlaying.value) return

    const playbackTime = getPlaybackTime()

    // 更新 currentTime
    currentTime.value = playbackTime

    // 检查是否到达结尾
    if (playbackTime >= endTimestamp) {
      pause()
      playbackTimeAtStart = endTimestamp
      isEnded.value = true
      return
    }

    // 检查是否需要渲染下一帧
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

  // 播放
  const play = async () => {
    if (isPlaying.value) return

    // 如果已结束，重置到开头
    if (isEnded.value) {
      await seek(firstTimestamp)
      isEnded.value = false
    }

    // 恢复 AudioContext
    if (audioContext && audioContext.state === 'suspended') {
      await audioContext.resume()
    }

    // 记录播放开始时间
    if (audioContext) {
      audioContextStartTime = audioContext.currentTime
    } else {
      performanceStartTime = performance.now()
    }

    isPlaying.value = true

    // 启动音频播放
    if (useNativeAudio && audioRef?.value) {
      // 使用原生 audio 标签
      audioRef.value.currentTime = playbackTimeAtStart
      await audioRef.value.play()
    } else if (audioSink && audioContext) {
      // 使用 Web Audio API
      await audioBufferIterator?.return()
      audioBufferIterator = audioSink.buffers(getPlaybackTime())
      void runAudioIterator()
    }

    rafId = requestAnimationFrame(render)
  }

  // 暂停
  const pause = () => {
    if (!isPlaying.value) return

    playbackTimeAtStart = getPlaybackTime()
    isPlaying.value = false

    // 暂停原生 audio
    if (useNativeAudio && audioRef?.value) {
      audioRef.value.pause()
    }

    // 停止音频迭代器
    void audioBufferIterator?.return()
    audioBufferIterator = null

    // 停止所有已调度的音频节点
    for (const node of queuedAudioNodes) {
      node.stop()
    }
    queuedAudioNodes.clear()

    if (rafId !== -1) {
      cancelAnimationFrame(rafId)
      rafId = -1
    }
  }

  // Seek
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

    // Seek 原生 audio
    if (useNativeAudio && audioRef?.value) {
      audioRef.value.currentTime = playbackTimeAtStart
    }

    await startVideoIterator()

    if (wasPlaying && playbackTimeAtStart < endTimestamp) {
      await play()
    }
  }

  // 设置音量
  const setVolume = (vol: number) => {
    const clampedVol = Math.max(0, Math.min(1, vol))
    if (useNativeAudio && audioRef?.value) {
      audioRef.value.volume = clampedVol
    } else if (gainNode) {
      gainNode.gain.value = clampedVol
    }
  }

  // 销毁
  const destroy = () => {
    pause()
    void videoFrameIterator?.return()
    void audioBufferIterator?.return()
    videoFrameIterator = null
    audioBufferIterator = null
    videoSink = null
    audioSink = null
    nextFrame = null
    context = null
    if (audioContext) {
      audioContext.close()
      audioContext = null
    }
    gainNode = null
  }

  // 监听 canvas ref 变化，初始化
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
