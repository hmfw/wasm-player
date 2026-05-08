import type { PlaybackDecision, ProbeResult } from './types'

// 兜底决策：当某个 codec 尚未在 features/ 下单独实现策略时，resolveCodecPlayback 会回退到这里。
// 各 codec 专属决策（features/h264、h265、mp3）有明确匹配时优先使用对应模块，本函数仅处理
// 通用分支，保持决策分散而不是在单个 switch 里堆积。
export function decidePlayback(result: ProbeResult): PlaybackDecision {
  if (result.mediaType === 'audio') {
    return {
      routeTarget: 'audio',
      mode: 'native',
      reason: 'audio native playback'
    }
  }

  if (result.mediaType === 'video') {
    return {
      routeTarget: 'video',
      mode: 'native',
      reason: 'video native playback'
    }
  }

  return {
    routeTarget: 'video',
    mode: 'unsupported',
    reason: 'unsupported media type'
  }
}
