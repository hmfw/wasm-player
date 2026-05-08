<script setup lang="ts">
// 长视频(>60s)MSE 流式播放器:把两个 composable 组合起来。
// - useMediaSourcePipeline 管 MSE 管线(append/remove/updateend 状态机)
// - useSegmentScheduler   管 20s 分段转码调度与失败重试
// 本组件只负责:UI 绑定、video 事件 → composable 调用、失败段 UI 提示。
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useFFmpeg } from '../composables/useFFmpeg'
import { useMediaSourcePipeline } from '../composables/useMediaSourcePipeline'
import { useSegmentScheduler } from '../composables/useSegmentScheduler'
import PlayerControls from './PlayerControls.vue'

interface Props {
  src: string
  duration: number
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

const SEGMENT_DURATION = 20
// MSE codec 字符串与 Worker 端转码参数(libx264 + aac)强耦合,改一侧必须改另一侧。
const CODECS = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'

const videoRef = ref<HTMLVideoElement | null>(null)
const status = ref<'loading' | 'playing' | 'error'>('loading')
const error = ref<string | null>(null)

const isPlaying = ref(false)
const isEnded = ref(false)
const currentTime = ref(0)
const duration = ref(props.duration)
const volume = ref(1)

const { transcodeSegmentBySrc, loadFFmpeg } = useFFmpeg()

const pipeline = useMediaSourcePipeline({
  codecs: CODECS,
  totalDuration: props.duration,
  onError: (err) => {
    error.value = err.message
    status.value = 'error'
  },
})

const scheduler = useSegmentScheduler({
  src: props.src,
  totalDuration: props.duration,
  segmentDuration: SEGMENT_DURATION,
  transcode: transcodeSegmentBySrc,
  onSegmentReady: (seg) => pipeline.enqueue(seg),
  onAllComplete: () => pipeline.endOfStream(),
  onFatal: (err) => {
    error.value = err.message
    status.value = 'error'
  },
})

const togglePlay = async () => {
  if (!videoRef.value) return
  if (isEnded.value) {
    videoRef.value.currentTime = 0
    isEnded.value = false
  }
  if (isPlaying.value) {
    videoRef.value.pause()
  } else {
    try {
      await videoRef.value.play()
    } catch (err) {
      console.error('Playback error:', err)
    }
  }
}

const handleSeek = (time: number) => {
  if (!videoRef.value) return
  videoRef.value.currentTime = time
  currentTime.value = time
  if (isEnded.value && time < duration.value) isEnded.value = false
}

const handleVolumeChange = (vol: number) => {
  volume.value = vol
  if (videoRef.value) videoRef.value.volume = vol
}

const handleLoadedMetadata = () => {
  if (!videoRef.value) return
  const d = videoRef.value.duration
  // MSE 下 endOfStream 前 video.duration 为 Infinity,此时沿用 props.duration(从 probe 拿到的总时长)
  if (Number.isFinite(d) && d > 0) duration.value = d
}

const handleTimeUpdate = () => {
  if (!videoRef.value) return
  currentTime.value = videoRef.value.currentTime

  // 计算当前 buffer 尾端,驱动 scheduler 预取
  const buffered = videoRef.value.buffered
  const bufferedEnd = buffered.length > 0 ? buffered.end(buffered.length - 1) : 0
  scheduler.onTimeUpdate(videoRef.value.currentTime, bufferedEnd)

  // 淘汰 currentTime 之前的旧 buffer,保留一段长度的容忍回退区
  if (videoRef.value.currentTime > SEGMENT_DURATION * 2) {
    pipeline.removeBefore(videoRef.value.currentTime - SEGMENT_DURATION)
  }
}

const handleCanPlay = () => {
  if (status.value === 'loading') {
    status.value = 'playing'
    if (props.autoplay && videoRef.value) {
      videoRef.value.play().catch((err) => console.warn('Autoplay failed:', err))
    }
  }
}

const handleEnded = () => {
  isEnded.value = true
  isPlaying.value = false
}

onMounted(async () => {
  if (!videoRef.value) return
  pipeline.attach(videoRef.value)
  try {
    await loadFFmpeg()
  } catch (err) {
    error.value = (err as Error).message
    status.value = 'error'
    return
  }
  scheduler.start()
})

onBeforeUnmount(() => {
  scheduler.cancel()
  pipeline.destroy()
})
</script>

<template>
  <div class="wasm-player-streaming">
    <div v-if="status === 'loading'" class="wasm-player-loading">
      <div class="wasm-player-spinner"></div>
      <p>正在转码第 {{ Math.floor(scheduler.progress.value * scheduler.totalSegments) }} / {{ scheduler.totalSegments }} 段...</p>
      <div class="wasm-player-progress-bar">
        <div class="wasm-player-progress-fill" :style="{ width: `${scheduler.progress.value * 100}%` }"></div>
      </div>
    </div>

    <div v-else-if="status === 'error'" class="wasm-player-error">
      <p>加载失败: {{ error }}</p>
    </div>

    <div v-show="status === 'playing'" class="wasm-player-video-container">
      <div
        v-if="scheduler.failedSegments.value.length > 0"
        class="wasm-player-warning"
      >
        第 {{ scheduler.failedSegments.value.map((i) => i + 1).join('、') }} 段加载失败,可能有短暂黑屏或静音
      </div>
      <div class="wasm-player-video-wrapper" :style="{ height: height + 'px' }">
        <video
          ref="videoRef"
          @timeupdate="handleTimeUpdate"
          @loadedmetadata="handleLoadedMetadata"
          @canplay="handleCanPlay"
          @play="isPlaying = true"
          @pause="isPlaying = false"
          @ended="handleEnded"
        ></video>
        <img
          v-if="poster && !isPlaying"
          :src="poster"
          class="wasm-player-poster-overlay"
          @click="togglePlay"
        />
      </div>

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
  </div>
</template>
