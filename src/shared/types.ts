// 播放决策流水线里流转的两类核心数据结构：
//   - ProbeResult：FFmpeg 探测结果的归一化表达，上层据此选路
//   - PlaybackDecision：最终产出的"去哪渲染 + 怎么播"两元组
// 字段命名与 features/shared 及各 codec 策略模块对齐；新增 codec 时优先复用这两类型，
// 避免策略之间传递异构对象。

export type MediaType = 'video' | 'audio' | 'unknown'

export interface ProbeStreamInfo {
  codecType: 'video' | 'audio' | 'subtitle' | 'data' | 'unknown'
  codecName: string
}

// ok=false 但 mediaType!=='unknown' 的情形允许存在：probe 流程失败但扩展名兜底能给出结论时，
// 仍视作可以继续播放。只有 mediaType==='unknown' 才是完全失败。
export interface ProbeResult {
  ok: boolean
  mediaType: MediaType
  container: string
  videoCodec?: string
  audioCodec?: string
  streams: ProbeStreamInfo[]
  duration?: number
  rawLog?: string
  error?: string
}

// native：浏览器可直接播，走 <video>/<audio>
// transcode：需要 FFmpeg 转码为 H.264/AAC
// unsupported：已探测但无可行路径，交由上层展示错误
export type PlaybackMode = 'native' | 'transcode' | 'unsupported'

export interface PlaybackDecision {
  routeTarget: 'video' | 'audio'
  mode: PlaybackMode
  // 保留自由文本 reason 便于在日志/UI 里回溯决策来源，而不是再引入一个枚举。
  reason: string
}
