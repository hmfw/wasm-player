import type { PlaybackDecision, ProbeResult } from './types'
import { decidePlayback } from './playbackDecision'

export function resolveCodecPlayback(result: ProbeResult): PlaybackDecision {
  if (result.videoCodec === 'h264') {
    return { routeTarget: 'video', mode: 'native', reason: `h264 native: ${result.container}` }
  }

  if (result.videoCodec === 'hevc' || result.videoCodec === 'h265') {
    return { routeTarget: 'video', mode: 'transcode', reason: `h265 transcode: ${result.container}` }
  }

  if (result.audioCodec === 'mp3') {
    return { routeTarget: 'audio', mode: 'native', reason: `mp3 native: ${result.container}` }
  }

  return decidePlayback(result)
}

export * from './types'
export * from './mediaProbe'
export * from './playbackDecision'
export * from './probeFallback'
export * from './probeLogParser'
export * from './workerProtocol'
export * from './lightProbe'
