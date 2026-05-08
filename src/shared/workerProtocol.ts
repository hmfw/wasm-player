// Worker 通信协议的单一真理源。主线程 (useFFmpeg.ts) 和 Worker (ffmpeg.worker.ts)
// 都从这里导入类型,确保两侧消息形状不漂移。
//
// 协议要点:
//   - 每个请求由主线程生成 requestId (UUID),Worker 响应必须回传同一 requestId
//   - Worker → 主线程的响应统一为 result / error 两种,按 requestId 精确归属
//   - progress 是单次请求内的进度回调,也带 requestId
//   - log 是 Worker 全局日志(加载阶段/所有任务的 FFmpeg stdout),不归属具体请求

import type { ProbeResult } from './types'

export type OutputFormat = 'mp4'

export interface LoadPayload {
  // 预留:未来可能传 core URL 或配置
}

export interface ProbePayload {
  src: string
}

export interface TranscodePayload {
  src: string
  outputFormat?: OutputFormat
}

export interface TranscodeSegmentPayload {
  src: string
  startTime: number
  duration: number
  outputFormat?: OutputFormat
}

export type MainToWorkerMessage =
  | { type: 'load'; requestId: string; payload?: LoadPayload }
  | { type: 'probe'; requestId: string; payload: ProbePayload }
  | { type: 'transcode'; requestId: string; payload: TranscodePayload }
  | { type: 'transcode-segment'; requestId: string; payload: TranscodeSegmentPayload }

export interface LoadResult {
  loaded: true
}

export interface TranscodeResult {
  blob: Blob
}

export interface TranscodeSegmentResult {
  blob: Blob
  startTime: number
}

export type RequestResult = LoadResult | ProbeResult | TranscodeResult | TranscodeSegmentResult

export interface ProgressPayload {
  progress: number
  time: number
}

export interface ErrorPayload {
  message: string
  name?: string
}

export type WorkerToMainMessage =
  | { type: 'result'; requestId: string; payload: RequestResult }
  | { type: 'error'; requestId: string; payload: ErrorPayload }
  | { type: 'progress'; requestId: string; payload: ProgressPayload }
  | { type: 'log'; payload: string }

export function isResultMessage(
  m: WorkerToMainMessage
): m is Extract<WorkerToMainMessage, { type: 'result' }> {
  return m.type === 'result'
}

export function isErrorMessage(
  m: WorkerToMainMessage
): m is Extract<WorkerToMainMessage, { type: 'error' }> {
  return m.type === 'error'
}

export function isProgressMessage(
  m: WorkerToMainMessage
): m is Extract<WorkerToMainMessage, { type: 'progress' }> {
  return m.type === 'progress'
}

export function isLogMessage(
  m: WorkerToMainMessage
): m is Extract<WorkerToMainMessage, { type: 'log' }> {
  return m.type === 'log'
}
