// FFmpeg 日志文本 → ProbeResult 的纯函数解析。从 ffmpeg.worker.ts 抽出,
// 使主线程/Worker 双侧都能用同一份实现,并可在 jsdom 下做快照回归测试
// 以提前发现 FFmpeg 版本升级导致的日志格式漂移。
//
// 规则与原实现保持完全一致(见原 ffmpeg.worker.ts probeMedia 的解析段):
//   - Input #0, <container>, from ...  → container
//   - Video: <codec>                   → videoCodec
//   - Audio: <codec>                   → audioCodec
//   - Duration: HH:MM:SS.cc            → duration (秒,含百分秒)
//   - codec 别名归一: avc1/h264 → h264; hevc 保留; h265 → h265; mp3 包含匹配

import type { ProbeResult, ProbeStreamInfo } from './types'

export function normalizeCodec(codec?: string): string | undefined {
  if (!codec) return undefined
  const c = codec.toLowerCase()
  if (c === 'hevc') return 'hevc'
  if (c.includes('h264') || c === 'avc1') return 'h264'
  if (c.includes('h265')) return 'h265'
  if (c.includes('mp3')) return 'mp3'
  return c
}

export function guessContainerBySrc(src: string): string {
  const ext = src.split('?')[0].split('.').pop()?.toLowerCase()
  return ext || 'unknown'
}

export function parseProbeLog(rawLog: string, src: string): ProbeResult {
  const lowerLog = rawLog.toLowerCase()

  const containerMatch = rawLog.match(/Input #0,\s*([^,]+)/i)
  const container = containerMatch?.[1]?.trim().toLowerCase() || guessContainerBySrc(src)

  const videoMatch = rawLog.match(/Video:\s*([^,\s]+)/i)
  const audioMatch = rawLog.match(/Audio:\s*([^,\s]+)/i)

  const videoCodec = normalizeCodec(videoMatch?.[1])
  const audioCodec = normalizeCodec(audioMatch?.[1])

  const durationMatch = rawLog.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/i)
  let duration: number | undefined
  if (durationMatch) {
    const hours = parseInt(durationMatch[1], 10)
    const minutes = parseInt(durationMatch[2], 10)
    const seconds = parseInt(durationMatch[3], 10)
    const centiseconds = parseInt(durationMatch[4], 10)
    duration = hours * 3600 + minutes * 60 + seconds + centiseconds / 100
  }

  const streams: ProbeStreamInfo[] = []
  if (videoCodec) streams.push({ codecType: 'video', codecName: videoCodec })
  if (audioCodec) streams.push({ codecType: 'audio', codecName: audioCodec })

  const mediaType: ProbeResult['mediaType'] = videoCodec
    ? 'video'
    : audioCodec
      ? 'audio'
      : lowerLog.includes('video:')
        ? 'video'
        : lowerLog.includes('audio:')
          ? 'audio'
          : 'unknown'

  return {
    ok: mediaType !== 'unknown',
    mediaType,
    container,
    videoCodec,
    audioCodec,
    streams,
    duration,
    rawLog,
    error: mediaType === 'unknown' ? 'Unable to parse media info' : undefined,
  }
}
