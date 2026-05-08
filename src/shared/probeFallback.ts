import type { ProbeResult } from './types'
import { detectMediaType } from './mediaProbe'

// FFmpeg probe 失败时的兜底：跨域 fetch 被拒、WASM 加载异常、网络中断等场景下，
// 如果直接报错体验太差。退而求其次按扩展名猜，假设是最常见的 H.264。
// 猜错会在 <video error> 事件里表现，由 UI 正常报错，不会引起静默失败。
export function fallbackH264Probe(src: string): ProbeResult {
  return {
    ok: true,
    mediaType: 'video',
    container: src.split('.').pop()?.toLowerCase() || 'mp4',
    videoCodec: 'h264',
    streams: [{ codecType: 'video', codecName: 'h264' }]
  }
}

// 按扩展名把 URL 分桶到视频/音频兜底。不能识别时返回 unknown，让上层走错误路径
// 而不是猜一个很可能出错的 codec 进去。
export function fallbackMediaProbe(src: string): ProbeResult {
  const mediaType = detectMediaType(src)
  if (mediaType === 'video') {
    return fallbackH264Probe(src)
  }

  return {
    ok: true,
    mediaType,
    container: src.split('.').pop()?.toLowerCase() || 'unknown',
    audioCodec: mediaType === 'audio' ? 'mp3' : undefined,
    streams: mediaType === 'audio' ? [{ codecType: 'audio', codecName: 'mp3' }] : []
  }
}
