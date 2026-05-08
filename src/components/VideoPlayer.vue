<script setup lang="ts">
// 纯渲染视频播放器：只接受一个已经"可播"的 src（无论是原始 URL 还是转码后的 blob URL），
// 不做任何格式探测或转码。所有路由决策都在上层 WasmPlayer 完成。
// 如果需要对 H.265 做别的处理，改的是 features/ 下的策略，而不是这里。
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import PlayerControls from './PlayerControls.vue'

interface Props {
  src: string
  autoplay?: boolean
  width?: number
  height?: number
  poster?: string
}

const props = withDefaults(defineProps<Props>(), {
  autoplay: false,
  width: 800,
  height: 450
})

const videoRef = ref<HTMLVideoElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const playerContainerRef = ref<HTMLDivElement | null>(null)
const isPlaying = ref(false)
const isEnded = ref(false)
const posterUrl = ref<string | null>(null)
const currentTime = ref(0)
const duration = ref(0)
const volume = ref(1)
const isLoading = ref(false)
const error = ref<string | null>(null)
const controlsVisible = ref(false)
const volumeMuted = ref(false)
let hideControlsTimer = -1

const togglePlay = async () => {
  if (!videoRef.value) return

  // 如果播放已结束，重新播放
  if (isEnded.value) {
    videoRef.value.currentTime = 0
    isEnded.value = false
    try {
      await videoRef.value.play()
      isPlaying.value = true
      posterUrl.value = null
    } catch (err) {
      error.value = (err as Error).message
      console.error('Playback error:', err)
    }
    return
  }

  // 正常的播放/暂停切换
  if (isPlaying.value) {
    videoRef.value.pause()
    isPlaying.value = false
  } else {
    try {
      await videoRef.value.play()
      isPlaying.value = true
      posterUrl.value = null
    } catch (err) {
      error.value = (err as Error).message
      console.error('Playback error:', err)
    }
  }
}

const handleTimeUpdate = () => {
  if (videoRef.value) {
    currentTime.value = videoRef.value.currentTime
  }
}

const handleLoadedMetadata = () => {
  if (videoRef.value) {
    duration.value = videoRef.value.duration
  }
}

// 未提供外部 poster 时，用 canvas 抓第一帧做封面。seek 到 1s 是因为 0s 可能还没解码出画面；
// 绑定 seeked/{ once: true } 保证只画一帧，避免后续 seek 重复触发。
const captureFirstFrame = () => {
  const video = videoRef.value
  const canvas = canvasRef.value
  if (!video || !canvas) return

  const draw = () => {
    try {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight)
      posterUrl.value = canvas.toDataURL('image/jpeg', 0.8)
    } catch {
      // 跨源视频会让 canvas 被 taint，toDataURL 抛 SecurityError。静默跳过而非报错——
      // 这条路径只是"有最好、没有也行"的体验优化。
    }
  }

  video.addEventListener('seeked', draw, { once: true })
  video.currentTime = 1
}

const handleLoadedData = () => {
  // 仅在既没有外部 poster 又没 autoplay 时才生成首帧封面：
  // autoplay 情形用户马上会看到真实画面，没必要预生成封面；外部 poster 优先级更高。
  if (!props.poster && !props.autoplay) {
    captureFirstFrame()
  }
}

const handleVideoError = () => {
  const video = videoRef.value
  const mediaError = video?.error
  if (!mediaError) return
  error.value = '视频播放失败'
}

const handleEnded = () => {
  isEnded.value = true
  isPlaying.value = false
}

const handleSeek = (time: number) => {
  if (videoRef.value) {
    videoRef.value.currentTime = time
    currentTime.value = time
    // 如果从结束状态拖动进度条，清除 ended 标记
    if (isEnded.value && time < duration.value) {
      isEnded.value = false
    }
  }
}

const handleVolumeChange = (vol: number) => {
  volume.value = vol
  if (videoRef.value) {
    videoRef.value.volume = vol
  }
}

const showControlsTemporarily = () => {
  controlsVisible.value = true
  clearTimeout(hideControlsTimer)
  hideControlsTimer = window.setTimeout(() => {
    controlsVisible.value = false
  }, 2000)
}

const hideControlsNow = () => {
  controlsVisible.value = false
  clearTimeout(hideControlsTimer)
}

const isTouchDevice = () => 'ontouchstart' in window

const onContainerPointerMove = (e: PointerEvent) => {
  if (e.pointerType !== 'touch') showControlsTemporarily()
}

const onContainerPointerLeave = (e: PointerEvent) => {
  if (e.pointerType === 'touch') return
  hideControlsNow()
}

const onContainerClick = () => {
  if (isTouchDevice()) {
    controlsVisible.value ? hideControlsNow() : showControlsTemporarily()
  } else {
    togglePlay()
  }
}

const onControlsClick = () => {
  showControlsTemporarily()
}

const handleToggleMute = () => {
  volumeMuted.value = !volumeMuted.value
  if (videoRef.value) {
    videoRef.value.volume = volumeMuted.value ? 0 : volume.value
  }
}

const toggleFullscreen = () => {
  if (document.fullscreenElement) {
    document.exitFullscreen()
  } else {
    playerContainerRef.value?.requestFullscreen().catch(console.error)
  }
}

const onKeyDown = (e: KeyboardEvent) => {
  if (error.value || isLoading.value) return
  switch (e.code) {
    case 'Space': case 'KeyK': togglePlay(); break
    case 'KeyF': toggleFullscreen(); break
    case 'ArrowLeft': handleSeek(Math.max(0, currentTime.value - 5)); break
    case 'ArrowRight': handleSeek(Math.min(duration.value, currentTime.value + 5)); break
    case 'KeyM': handleToggleMute(); break
    default: return
  }
  showControlsTemporarily()
  e.preventDefault()
}

const loadVideo = async () => {
  if (!props.src) return

  posterUrl.value = props.poster ?? null
  isLoading.value = true
  error.value = null

  try {
    if (videoRef.value) {
      videoRef.value.src = props.src
    }

    if (props.autoplay && videoRef.value) {
      await videoRef.value.play()
      isPlaying.value = true
    }
  } catch (err) {
    error.value = (err as Error).message
    console.error('Video loading error:', err)
  } finally {
    isLoading.value = false
  }
}

// src 变化时重新加载；首次挂载也走同一路径。immediate watch 与 onMounted 的组合
// 覆盖了"父组件切换 src"与"组件首次挂载已有 src"两种初始化场景。
watch(() => props.src, () => {
  if (props.src) {
    loadVideo()
  }
})

onMounted(() => {
  if (props.src) {
    loadVideo()
  }
  window.addEventListener('keydown', onKeyDown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  clearTimeout(hideControlsTimer)
})
</script>

<template>
  <div class="wasm-player-video" :style="{ width: width + 'px' }">
    <div v-if="isLoading" class="wasm-player-loading">
      <div class="wasm-player-spinner"></div>
      <p>正在加载视频...</p>
    </div>

    <div v-if="error" class="wasm-player-error">
      <p>加载失败: {{ error }}</p>
    </div>

    <div
      v-show="!isLoading && !error"
      ref="playerContainerRef"
      class="wasm-player-video-container"
      @pointermove="onContainerPointerMove"
      @pointerleave="onContainerPointerLeave"
      @click="onContainerClick"
    >
      <div class="wasm-player-video-wrapper" :style="{ height: height + 'px' }">
        <video
          ref="videoRef"
          @timeupdate="handleTimeUpdate"
          @loadedmetadata="handleLoadedMetadata"
          @loadeddata="handleLoadedData"
          @error="handleVideoError"
          @ended="handleEnded"
        ></video>
        <img
          v-if="posterUrl && !isPlaying"
          :src="posterUrl"
          class="wasm-player-poster-overlay"
          @click.stop="togglePlay"
        />
      </div>

      <canvas
        ref="canvasRef"
        style="display: none;"
      ></canvas>

      <PlayerControls
        :is-playing="isPlaying"
        :is-ended="isEnded"
        :current-time="currentTime"
        :duration="duration"
        :volume="volume"
        :controls-visible="controlsVisible"
        @toggle-play="togglePlay"
        @seek="handleSeek"
        @volume-change="handleVolumeChange"
        @toggle-mute="handleToggleMute"
        @toggle-fullscreen="toggleFullscreen"
        @controls-click="onControlsClick"
      />
    </div>
  </div>
</template>
