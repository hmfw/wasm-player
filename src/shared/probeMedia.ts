import { Input, MP4, UrlSource } from 'mediabunny'
import type { ProbeResult } from './types'

function normalizeCodec(codec: string): string {
  const lower = codec.toLowerCase()
  if (lower === 'h264' || lower === 'avc') return 'h264'
  if (lower === 'hevc' || lower === 'h265') return 'h265'
  if (lower === 'aac') return 'aac'
  if (lower === 'mp3') return 'mp3'
  return lower
}

export async function probeMediaBySrc(src: string): Promise<ProbeResult> {
  try {
    const input = new Input({ formats: [MP4], source: new UrlSource(src) })

    const videoTrack = await input.getPrimaryVideoTrack()
    const audioTrack = await input.getPrimaryAudioTrack()

    if (!videoTrack && !audioTrack) {
      return { ok: false, mediaType: 'unknown', container: 'unknown', streams: [], error: 'No tracks found' }
    }

    const duration = await input.computeDuration()
    const videoCodecRaw = videoTrack ? await videoTrack.getCodec() : null
    const audioCodecRaw = audioTrack ? await audioTrack.getCodec() : null

    const streams = []
    if (videoTrack && videoCodecRaw) streams.push({ codecType: 'video' as const, codecName: videoCodecRaw })
    if (audioTrack && audioCodecRaw) streams.push({ codecType: 'audio' as const, codecName: audioCodecRaw })

    return {
      ok: true,
      mediaType: videoTrack ? 'video' : 'audio',
      container: 'mp4',
      videoCodec: videoCodecRaw ? normalizeCodec(videoCodecRaw) : undefined,
      audioCodec: audioCodecRaw ? normalizeCodec(audioCodecRaw) : undefined,
      streams,
      duration: duration ?? undefined,
    }
  } catch (err) {
    const error = err as Error
    return { ok: false, mediaType: 'unknown', container: 'unknown', streams: [], error: error.message }
  }
}
