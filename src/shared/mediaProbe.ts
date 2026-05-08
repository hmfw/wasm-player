import type { ProbeResult } from './types'

// 基于扩展名的快速判断，用于在真正启动 FFmpeg 之前做一次廉价筛选：
// 音频扩展名直接路由到 AudioPlayer，省去 30MB WASM 的下载与 probe 耗时。
// 视频类扩展名仍需 probe，因为 mp4/mkv 等容器里可能封装 H.265。
export function detectMediaType(src: string): 'video' | 'audio' | 'unknown' {
  const ext = src.split('?')[0].split('.').pop()?.toLowerCase() || ''

  if (['mp4', 'mov', 'm4v', 'webm', 'mkv', 'flv', 'avi'].includes(ext)) {
    return 'video'
  }

  if (['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a'].includes(ext)) {
    return 'audio'
  }

  return 'unknown'
}

// 目前是恒等函数，保留为将来合并多路 probe（如 MediaSource 能力检测）预留接口：
// 调用点不再需要分别处理"是否合并"的逻辑。
export function mergeProbeResult(result: ProbeResult): ProbeResult {
  return result
}
