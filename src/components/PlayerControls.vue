<script setup lang="ts">
import { ref, computed } from 'vue'

interface Props {
  isPlaying: boolean
  isEnded?: boolean
  currentTime: number
  duration: number
  volume: number
  controlsVisible?: boolean
  showFullscreen?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  isEnded: false,
  controlsVisible: true,
  showFullscreen: true
})

const emit = defineEmits<{
  'toggle-play': []
  'seek': [time: number]
  'volume-change': [volume: number]
  'toggle-mute': []
  'toggle-fullscreen': []
  'controls-click': []
}>()

const progressBarRef = ref<HTMLDivElement | null>(null)
const volumeBarRef = ref<HTMLDivElement | null>(null)

let draggingProgress = false
let draggingVolume = false

const volumeMuted = ref(false)

const progressPercent = computed(() =>
  props.duration > 0 ? (props.currentTime / props.duration) * 100 : 0
)

const volumePercent = computed(() => props.volume * 100)

const volumeIconIndex = computed(() => {
  if (volumeMuted.value) return 0
  if (props.volume === 0) return 1
  if (props.volume < 0.33) return 2
  if (props.volume < 0.67) return 3
  return 4
})

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
}

const currentTimeFormatted = computed(() => formatTime(props.currentTime))
const durationFormatted = computed(() => formatTime(props.duration))

const onProgressPointerDown = (e: PointerEvent) => {
  draggingProgress = true
  progressBarRef.value!.setPointerCapture(e.pointerId)
  updateProgressFromEvent(e)
}

const onProgressPointerMove = (e: PointerEvent) => {
  if (!draggingProgress) return
  updateProgressFromEvent(e)
}

const onProgressPointerUp = (e: PointerEvent) => {
  if (!draggingProgress) return
  draggingProgress = false
  progressBarRef.value!.releasePointerCapture(e.pointerId)
  const rect = progressBarRef.value!.getBoundingClientRect()
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  emit('seek', pct * props.duration)
}

const updateProgressFromEvent = (e: PointerEvent) => {
  const rect = progressBarRef.value!.getBoundingClientRect()
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  emit('seek', pct * props.duration)
}

const onVolumePointerDown = (e: PointerEvent) => {
  draggingVolume = true
  volumeBarRef.value!.setPointerCapture(e.pointerId)
  updateVolumeFromEvent(e)
}

const onVolumePointerMove = (e: PointerEvent) => {
  if (!draggingVolume) return
  updateVolumeFromEvent(e)
}

const onVolumePointerUp = (e: PointerEvent) => {
  if (!draggingVolume) return
  draggingVolume = false
  volumeBarRef.value!.releasePointerCapture(e.pointerId)
}

const updateVolumeFromEvent = (e: PointerEvent) => {
  const rect = volumeBarRef.value!.getBoundingClientRect()
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  volumeMuted.value = false
  emit('volume-change', pct)
}

const toggleMute = () => {
  volumeMuted.value = !volumeMuted.value
  emit('toggle-mute')
}
</script>

<template>
  <div
    class="wasm-player-controls"
    :class="{ 'wasm-player-controls--visible': controlsVisible }"
    @click="emit('controls-click')"
  >
    <button class="wasm-player-control-btn" :aria-label="isPlaying ? '暂停' : '播放'" @click.stop="emit('toggle-play')">
      <div class="wasm-player-icon-wrapper">
        <img v-show="!isPlaying" src="../assets/play-icon.svg" class="wasm-player-icon wasm-player-icon--invert" alt="播放" />
        <img v-show="isPlaying" src="../assets/pause-icon.svg" class="wasm-player-icon wasm-player-icon--invert" alt="暂停" />
      </div>
    </button>

    <div class="wasm-player-volume-group">
      <button class="wasm-player-control-btn wasm-player-volume-btn" aria-label="切换静音" @click.stop="toggleMute">
        <div class="wasm-player-icon-wrapper">
          <img v-show="volumeIconIndex === 0" src="../assets/volume-off-icon.svg" class="wasm-player-icon wasm-player-icon--invert" />
          <img v-show="volumeIconIndex === 1" src="../assets/volume-x-icon.svg" class="wasm-player-icon wasm-player-icon--invert" />
          <img v-show="volumeIconIndex === 2" src="../assets/volume-0-icon.svg" class="wasm-player-icon wasm-player-icon--invert" />
          <img v-show="volumeIconIndex === 3" src="../assets/volume-1-icon.svg" class="wasm-player-icon wasm-player-icon--invert" />
          <img v-show="volumeIconIndex === 4" src="../assets/volume-2-icon.svg" class="wasm-player-icon wasm-player-icon--invert" />
        </div>
      </button>
      <div
        ref="volumeBarRef"
        class="wasm-player-volume-bar-container wasm-player-bar-group"
        @pointerdown="onVolumePointerDown"
        @pointermove="onVolumePointerMove"
        @pointerup="onVolumePointerUp"
      >
        <div class="wasm-player-bar-fill" :style="{ width: volumePercent + '%' }">
          <div class="wasm-player-bar-handle"></div>
        </div>
      </div>
    </div>

    <p class="wasm-player-time wasm-player-current-time">{{ currentTimeFormatted }}</p>

    <div
      ref="progressBarRef"
      class="wasm-player-progress-bar-container wasm-player-bar-group"
      @pointerdown="onProgressPointerDown"
      @pointermove="onProgressPointerMove"
      @pointerup="onProgressPointerUp"
    >
      <div class="wasm-player-bar-fill" :style="{ width: progressPercent + '%' }">
        <div class="wasm-player-bar-handle wasm-player-progress-handle"></div>
      </div>
    </div>

    <p class="wasm-player-time wasm-player-duration">{{ durationFormatted }}</p>

    <button v-if="showFullscreen" class="wasm-player-control-btn" aria-label="全屏" @click.stop="emit('toggle-fullscreen')">
      <div class="wasm-player-icon-wrapper">
        <img src="../assets/fullscreen-icon.svg" class="wasm-player-icon wasm-player-icon--invert" alt="全屏" />
      </div>
    </button>
  </div>
</template>
