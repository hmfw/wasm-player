<script setup lang="ts">
interface Props {
  isPlaying: boolean
  isEnded?: boolean
  currentTime: number
  duration: number
  volume: number
}

const props = withDefaults(defineProps<Props>(), {
  isEnded: false
})

const emit = defineEmits<{
  'toggle-play': []
  'seek': [time: number]
  'volume-change': [volume: number]
}>()

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

const handleSeek = (event: Event) => {
  emit('seek', parseFloat((event.target as HTMLInputElement).value))
}

const handleVolumeChange = (event: Event) => {
  emit('volume-change', parseFloat((event.target as HTMLInputElement).value))
}
</script>

<template>
  <div class="wasm-player-controls">
    <button
      @click="emit('toggle-play')"
      class="wasm-player-play-btn"
      :aria-label="isEnded ? '重播' : (isPlaying ? '暂停' : '播放')"
    >
      {{ isEnded ? '↻' : (isPlaying ? '⏸' : '▶') }}
    </button>

    <input
      type="range"
      class="wasm-player-progress-slider"
      :value="currentTime"
      :max="duration || 0"
      step="0.1"
      @input="handleSeek"
      aria-label="播放进度"
    />

    <span class="wasm-player-time">
      {{ formatTime(currentTime) }} / {{ formatTime(duration) }}
    </span>

    <div class="wasm-player-volume-control">
      <span aria-hidden="true">🔊</span>
      <input
        type="range"
        class="wasm-player-volume-slider"
        :value="volume"
        min="0"
        max="1"
        step="0.1"
        @input="handleVolumeChange"
        aria-label="音量"
      />
    </div>
  </div>
</template>
