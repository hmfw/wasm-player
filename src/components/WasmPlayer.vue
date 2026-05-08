<script setup lang="ts">
// 统一入口组件：所有来源的 src 先到这里，经过"快判 → probe → codec 策略 → 路由"四步
// 决定最终渲染 VideoPlayer / AudioPlayer / StreamingPlayer 中的哪一个。
// 子播放器本身只认识 src，不关心格式识别，职责边界清晰。
import { ref, watch } from 'vue'
import VideoPlayer from './VideoPlayer.vue'
import AudioPlayer from './AudioPlayer.vue'
import StreamingPlayer from './StreamingPlayer.vue'
import { detectMediaType } from '../shared/mediaProbe'
import { resolveCodecPlayback, fallbackMediaProbe, probeMediaBySrc } from '../shared'
import type { PlaybackDecision, ProbeResult } from '../shared'

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

type RouteTarget = 'video' | 'audio' | 'stream-video' | null
type Status = 'idle' | 'probing' | 'ready' | 'error'

const status = ref<Status>('idle')
const routeTarget = ref<RouteTarget>(null)
const playbackUrl = ref<string>('')
const probeResult = ref<ProbeResult | null>(null)
const decision = ref<PlaybackDecision | null>(null)
const error = ref<string | null>(null)

// 切换 src 时清理上一次的状态
const reset = () => {
  status.value = 'idle'
  routeTarget.value = null
  playbackUrl.value = ''
  probeResult.value = null
  decision.value = null
  error.value = null
}

const ALLOWED_PROTOCOLS = ['http:', 'https:', 'blob:', 'data:']

// 只放行 http(s)/blob/data;其他协议(file:/javascript:/自定义 scheme)在入口层就拒绝,
// 避免把不可控 URL 传到 fetch/FFmpeg Worker。相对路径(无协议)也允许,由浏览器按页面 base 解析。
function isSrcAllowed(src: string): boolean {
  try {
    const u = new URL(src, window.location.href)
    return ALLOWED_PROTOCOLS.includes(u.protocol)
  } catch {
    return false
  }
}

const process = async (src: string) => {
  reset()
  if (!isSrcAllowed(src)) {
    error.value = `不支持的 URL 协议: ${src}`
    status.value = 'error'
    return
  }
  // 第一步快判：音频扩展名直接短路，跳过 FFmpeg 启动（可省下 30MB WASM 下载）。
  const quickType = detectMediaType(src)
  if (quickType === 'audio') {
    routeTarget.value = 'audio'
    playbackUrl.value = src
    status.value = 'ready'
    return
  }

  status.value = 'probing'

  // probe：用 mediabunny Input 在主线程直接解析，无需 Worker 往返。
  // 失败（非 MP4 或网络错误）则按扩展名兜底。
  let probe: ProbeResult
  try {
    probe = await probeMediaBySrc(src)
  } catch {
    probe = fallbackMediaProbe(src)
  }
  probeResult.value = probe

  if (!probe.ok && probe.mediaType === 'unknown') {
    error.value = probe.error || '无法识别媒体格式'
    status.value = 'error'
    return
  }

  // 第三步策略：按 codec 分发到 features/ 下各自的决策函数。
  const dec = resolveCodecPlayback(probe)
  decision.value = dec
  if (dec.mode === 'native') {
    routeTarget.value = dec.routeTarget  // 'video' | 'audio'
    playbackUrl.value = src
    status.value = 'ready'
    return
  }

  if (dec.mode === 'transcode') {
    routeTarget.value = 'stream-video'
    status.value = 'ready'
    return
  }

  error.value = `不支持的格式: ${probe.videoCodec || probe.audioCodec || '未知'}`
  status.value = 'error'
}

watch(() => props.src, (src) => {
  if (src) process(src)
}, { immediate: true })
</script>

<template>
  <div class="wasm-player-wrapper">
    <div v-if="status === 'probing'" class="wasm-player-loading">
      <div class="wasm-player-spinner"></div>
      <p>正在识别媒体格式...</p>
    </div>

    <div v-else-if="status === 'error'" class="wasm-player-error">
      <p>加载失败: {{ error }}</p>
    </div>

    <template v-else-if="status === 'ready'">
      <VideoPlayer
        v-if="routeTarget === 'video'"
        :src="playbackUrl"
        :autoplay="autoplay"
        :width="width"
        :height="height"
        :poster="poster"
      />
      <AudioPlayer
        v-else-if="routeTarget === 'audio'"
        :src="playbackUrl"
        :autoplay="autoplay"
      />
      <StreamingPlayer
        v-else-if="routeTarget === 'stream-video'"
        :key="src"
        :src="src"
        :autoplay="autoplay"
        :width="width"
        :height="height"
        :poster="poster"
      />
    </template>
  </div>
</template>
