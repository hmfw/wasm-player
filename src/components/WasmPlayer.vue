<script setup lang="ts">
// 统一入口组件：所有来源的 src 先到这里，经过"快判 → probe → codec 策略 → 路由"四步
// 决定最终渲染 VideoPlayer / AudioPlayer / StreamingPlayer 中的哪一个。
// 子播放器本身只认识 src，不关心格式识别，职责边界清晰。
import { ref, watch } from 'vue'
import VideoPlayer from './VideoPlayer.vue'
import AudioPlayer from './AudioPlayer.vue'
import StreamingPlayer from './StreamingPlayer.vue'
import { useFFmpeg } from '../composables/useFFmpeg'
import { detectMediaType } from '../shared/mediaProbe'
import { resolveCodecPlayback, fallbackMediaProbe, lightProbeMP4 } from '../shared'
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

const { loadFFmpeg, probeMediaBySrc, terminate } = useFFmpeg()

// 切换 src 时清理上一次的状态。
// 如果正在转码，立即销毁 Worker 以真正停止 FFmpeg 执行并释放所有资源（CPU、内存、临时文件）。
// 下次需要 FFmpeg 时会自动重新创建 Worker 并加载 WASM（约 1-3 秒）。
const reset = () => {
  if (status.value === 'probing' || routeTarget.value === 'stream-video') {
    terminate()
  }
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

  // 第二步 probe：先尝试轻量级 MP4 二进制解析（无需加载 WASM）。
  // 成功则直接用结果；失败（非 faststart MP4、MKV、FLV 等）才启动 FFmpeg。
  let probe: ProbeResult
  const lightResult = await lightProbeMP4(src)
  if (lightResult) {
    probe = lightResult
  } else {
    try {
      await loadFFmpeg()
      probe = await probeMediaBySrc(src)
    } catch (err) {
      probe = fallbackMediaProbe(src)
    }
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
        :duration="probeResult?.duration || 0"
        :autoplay="autoplay"
        :width="width"
        :height="height"
        :poster="poster"
      />
    </template>
  </div>
</template>
