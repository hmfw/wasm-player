<script setup lang="ts">
// H.265/HEVC 视频播放器：使用 mediabunny CanvasSink 直接解码渲染到 Canvas
// 音频：优先使用 Web Audio API，Safari 不支持时回退到原生 <audio> 标签
import { ref, onBeforeUnmount } from 'vue'
import { useMediabunnyPlayer } from '../composables/useMediabunnyPlayer'
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
  height: 450,
})

const canvasRef = ref<HTMLCanvasElement | null>(null)
const audioRef = ref<HTMLAudioElement | null>(null)
const playerContainerRef = ref<HTMLDivElement | null>(null)
const status = ref<'loading' | 'playing' | 'error'>('loading')
const error = ref<string | null>(null)

const volume = ref(1)
const controlsVisible = ref(false)
const volumeMuted = ref(false)
let hideControlsTimer = -1

const {
  isPlaying,
  currentTime,
  duration,
  isEnded,
  play,
  pause,
  seek,
  setVolume,
  destroy,
} = useMediabunnyPlayer({
  src: props.src,
  canvasRef,
  audioRef,
  autoplay: props.autoplay,
  volume: volume.value,
  onError: (err) => {
    console.error('Playback error:', err)
    error.value = err.message
    status.value = 'error'
  },
  onLoadedMetadata: (meta) => {
    console.log('Loaded metadata:', meta)
    status.value = 'playing'
  },
})

const togglePlay = async () => {
  if (isEnded.value) {
    await seek(0)
  }
  if (isPlaying.value) {
    pause()
  } else {
    try {
      await play()
    } catch (err) {
      console.error('Playback error:', err)
    }
  }
}

const handleSeek = (time: number) => {
  void seek(time)
}

const handleVolumeChange = (vol: number) => {
  volume.value = vol
  setVolume(vol)
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
  setVolume(volumeMuted.value ? 0 : volume.value)
}

const toggleFullscreen = () => {
  if (document.fullscreenElement) {
    document.exitFullscreen()
  } else {
    playerContainerRef.value?.requestFullscreen().catch(console.error)
  }
}

const onKeyDown = (e: KeyboardEvent) => {
  if (status.value !== 'playing') return
  switch (e.code) {
    case 'Space':
    case 'KeyK':
      togglePlay()
      break
    case 'KeyF':
      toggleFullscreen()
      break
    case 'ArrowLeft':
      handleSeek(Math.max(0, currentTime.value - 5))
      break
    case 'ArrowRight':
      handleSeek(Math.min(duration.value, currentTime.value + 5))
      break
    case 'KeyM':
      handleToggleMute()
      break
    default:
      return
  }
  showControlsTemporarily()
  e.preventDefault()
}

onBeforeUnmount(() => {
  destroy()
  window.removeEventListener('keydown', onKeyDown)
  clearTimeout(hideControlsTimer)
})

// 挂载键盘监听
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeyDown)
}
</script>

<template>
  <div class="wasm-player-streaming">
    <div v-if="status === 'loading'" class="wasm-player-loading">
      <div class="wasm-player-spinner"></div>
      <p>正在加载视频...</p>
    </div>

    <div v-else-if="status === 'error'" class="wasm-player-error">
      <p>加载失败: {{ error }}</p>
    </div>

    <div
      v-show="status === 'playing'"
      ref="playerContainerRef"
      class="wasm-player-video-container"
      :style="{ width: width + 'px', height: height + 'px' }"
      @pointermove="onContainerPointerMove"
      @pointerleave="onContainerPointerLeave"
      @click="onContainerClick"
    >
      <div class="wasm-player-video-wrapper" :style="{ height: height + 'px' }">
        <canvas ref="canvasRef" :width="width" :height="height"></canvas>
        <!-- 隐藏的 audio 元素，用于 Safari 回退 -->
        <audio ref="audioRef" style="display: none"></audio>
        <img
          v-if="poster && !isPlaying"
          :src="poster"
          class="wasm-player-poster-overlay"
          @click.stop="togglePlay"
        />
      </div>

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

<style scoped>
.wasm-player-streaming {
  position: relative;
  background: #000;
}

.wasm-player-loading,
.wasm-player-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 300px;
  color: #fff;
  padding: 2rem;
}

.wasm-player-spinner {
  width: 40px;
  height: 40px;
  border: 4px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.wasm-player-video-container {
  position: relative;
  background: #000;
  overflow: hidden;
}

.wasm-player-video-wrapper {
  position: relative;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

canvas {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.wasm-player-poster-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  cursor: pointer;
}

.wasm-player-error p {
  color: #ff6b6b;
  font-size: 14px;
}
</style>
