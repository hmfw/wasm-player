<script setup lang="ts">
// 纯渲染音频播放器：与 VideoPlayer 对称，只接受已可播的 src，不做格式判断。
// <audio> 元素被隐藏（display:none），UI 完全自绘，以便统一项目内的外观风格。
import { ref, onMounted, watch } from 'vue'
import PlayerControls from './PlayerControls.vue'

interface Props {
  src: string
  autoplay?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  autoplay: false
})

const audioRef = ref<HTMLAudioElement | null>(null)
const isPlaying = ref(false)
const isEnded = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const volume = ref(1)
const error = ref<string | null>(null)

const togglePlay = async () => {
  if (!audioRef.value) return

  if (isEnded.value) {
    audioRef.value.currentTime = 0
    isEnded.value = false
    try {
      await audioRef.value.play()
      isPlaying.value = true
    } catch (err) {
      error.value = (err as Error).message
    }
    return
  }

  if (isPlaying.value) {
    audioRef.value.pause()
    isPlaying.value = false
  } else {
    try {
      await audioRef.value.play()
      isPlaying.value = true
    } catch (err) {
      // play() 可能因浏览器 autoplay 策略或解码失败而拒绝；把 message 透出给 UI 即可。
      error.value = (err as Error).message
    }
  }
}

const handleEnded = () => {
  isEnded.value = true
  isPlaying.value = false
}

const handleTimeUpdate = () => {
  if (audioRef.value) {
    currentTime.value = audioRef.value.currentTime
  }
}

const handleLoadedMetadata = () => {
  if (audioRef.value) {
    duration.value = audioRef.value.duration
  }
}

const handleAudioError = () => {
  error.value = '音频播放失败'
}

const handleSeek = (time: number) => {
  if (audioRef.value) {
    audioRef.value.currentTime = time
    currentTime.value = time
    if (isEnded.value && time < duration.value) {
      isEnded.value = false
    }
  }
}

const handleVolumeChange = (vol: number) => {
  volume.value = vol
  if (audioRef.value) {
    audioRef.value.volume = vol
  }
}

// 每次 src 变化都手动重置播放状态：不依赖 <audio> 元素的内部状态重置，
// 避免上一次播放的 currentTime/isPlaying 残留到新 src 的 UI 上。
const loadAudio = async () => {
  if (!props.src) return
  error.value = null
  isPlaying.value = false
  isEnded.value = false
  currentTime.value = 0
  duration.value = 0

  if (audioRef.value) {
    audioRef.value.src = props.src
    if (props.autoplay) {
      try {
        await audioRef.value.play()
        isPlaying.value = true
      } catch (err) {
        error.value = (err as Error).message
      }
    }
  }
}

watch(() => props.src, () => {
  if (props.src) loadAudio()
})

onMounted(() => {
  if (props.src) loadAudio()
})
</script>

<template>
  <div class="wasm-player-audio">
    <div v-if="error" class="wasm-player-error">
      <p>加载失败: {{ error }}</p>
    </div>

    <audio
      ref="audioRef"
      @timeupdate="handleTimeUpdate"
      @loadedmetadata="handleLoadedMetadata"
      @ended="handleEnded"
      @error="handleAudioError"
      style="display: none;"
    ></audio>

    <PlayerControls
      :is-playing="isPlaying"
      :is-ended="isEnded"
      :current-time="currentTime"
      :duration="duration"
      :volume="volume"
      @toggle-play="togglePlay"
      @seek="handleSeek"
      @volume-change="handleVolumeChange"
    />
  </div>
</template>
