import { ref } from 'vue'
import type { ProbeResult } from '../shared'
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  TranscodeResult,
  TranscodeSegmentResult,
  LoadResult,
} from '../shared/workerProtocol'
import {
  isErrorMessage,
  isLogMessage,
  isProgressMessage,
  isResultMessage,
} from '../shared/workerProtocol'

// 主线程侧的 FFmpeg Worker 封装。设计要点:
//   1) 模块级单例 Worker:多个组件共享同一 Worker 避免重复加载 30MB WASM。
//      由 WasmPlayer 在切换视频时调用 terminate() 显式停止。
//   2) requestId 协议:每个请求生成 UUID,pending Map 按 id 路由响应,彻底避免
//      并发请求时"一条 error 同时 reject 多个 Promise"的错位问题。
//   3) 超时兜底:若 Worker 崩溃不回消息,定时器在设定时间后 reject + 清理 pending。

export interface FFmpegProgress {
  progress: number
  time: number
}

type Pending = {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

let worker: Worker | null = null
let listenerAttached = false
const pending = new Map<string, Pending>()
let loadPromise: Promise<void> | null = null

const isLoaded = ref(false)
const isLoading = ref(false)
const progress = ref<FFmpegProgress>({ progress: 0, time: 0 })
const error = ref<string | null>(null)

const TIMEOUT_MS: Record<string, number> = {
  load: 60_000,
  probe: 30_000,
  transcode: 10 * 60_000,
  'transcode-segment': 60_000,
}

function genRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function attachListener(w: Worker) {
  if (listenerAttached) return
  w.addEventListener('message', (e: MessageEvent<WorkerToMainMessage>) => {
    const msg = e.data

    if (isLogMessage(msg)) {
      if (import.meta.env.DEV) console.log('[FFmpeg]', msg.payload)
      return
    }

    if (isProgressMessage(msg)) {
      progress.value = msg.payload
      return
    }

    if (isResultMessage(msg) || isErrorMessage(msg)) {
      const p = pending.get(msg.requestId)
      if (!p) return // 请求已超时或已销毁,忽略迟到的响应
      if (p.timer) clearTimeout(p.timer)
      pending.delete(msg.requestId)
      if (isResultMessage(msg)) p.resolve(msg.payload)
      else {
        error.value = msg.payload.message
        p.reject(new Error(msg.payload.message))
      }
    }
  })
  w.addEventListener('error', (e: ErrorEvent) => {
    rejectAllPending(new Error(`worker error: ${e.message}`))
  })
  listenerAttached = true
}

function initWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('../workers/ffmpeg.worker.ts', import.meta.url), { type: 'module' })
  attachListener(worker)
  return worker
}

function rejectAllPending(err: Error) {
  for (const [, p] of pending) {
    if (p.timer) clearTimeout(p.timer)
    p.reject(err)
  }
  pending.clear()
}

function sendRequest<Res>(
  msg: Omit<MainToWorkerMessage, 'requestId'>,
  timeoutMs: number
): Promise<Res> {
  const requestId = genRequestId()
  const w = initWorker()
  return new Promise<Res>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(requestId)) return
      pending.delete(requestId)
      reject(new Error(`timeout: ${msg.type} after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(requestId, {
      resolve: resolve as (v: unknown) => void,
      reject,
      timer,
    })
    w.postMessage({ ...msg, requestId } as MainToWorkerMessage)
  })
}

function forceTerminate() {
  if (worker) {
    worker.terminate()
    worker = null
  }
  rejectAllPending(new Error('worker terminated'))
  listenerAttached = false
  loadPromise = null
  isLoaded.value = false
  isLoading.value = false
  progress.value = { progress: 0, time: 0 }
  error.value = null
}

async function loadFFmpegInternal(): Promise<void> {
  if (isLoaded.value) return
  if (loadPromise) return loadPromise
  isLoading.value = true
  error.value = null
  loadPromise = sendRequest<LoadResult>({ type: 'load' }, TIMEOUT_MS.load)
    .then(() => {
      isLoaded.value = true
      isLoading.value = false
    })
    .catch((err) => {
      isLoading.value = false
      loadPromise = null
      throw err
    })
  return loadPromise
}

export function useFFmpeg() {
  const loadFFmpeg = () => loadFFmpegInternal()

  const probeMediaBySrc = async (src: string): Promise<ProbeResult> => {
    await loadFFmpegInternal()
    error.value = null
    return sendRequest<ProbeResult>({ type: 'probe', payload: { src } }, TIMEOUT_MS.probe)
  }

  const transcodeVideoBySrc = async (src: string, outputFormat = 'mp4'): Promise<Blob> => {
    await loadFFmpegInternal()
    error.value = null
    progress.value = { progress: 0, time: 0 }
    const result = await sendRequest<TranscodeResult>(
      { type: 'transcode', payload: { src, outputFormat: outputFormat as 'mp4' } },
      TIMEOUT_MS.transcode
    )
    return result.blob
  }

  const transcodeSegmentBySrc = async (
    src: string,
    startTime: number,
    duration: number,
    outputFormat = 'mp4'
  ): Promise<Blob> => {
    await loadFFmpegInternal()
    error.value = null
    const result = await sendRequest<TranscodeSegmentResult>(
      {
        type: 'transcode-segment',
        payload: { src, startTime, duration, outputFormat: outputFormat as 'mp4' },
      },
      TIMEOUT_MS['transcode-segment']
    )
    return result.blob
  }

  const terminate = () => {
    forceTerminate()
  }

  return {
    isLoaded,
    isLoading,
    progress,
    error,
    loadFFmpeg,
    probeMediaBySrc,
    transcodeVideoBySrc,
    transcodeSegmentBySrc,
    terminate,
  }
}

// 导出给测试使用的内部状态检查钩子。不进入公共 API。
export const __testing = {
  getPendingSize: () => pending.size,
  getWorker: () => worker,
  rejectAllPending,
  forceTerminate,
  setTimeoutMs: (key: string, ms: number) => {
    TIMEOUT_MS[key] = ms
  },
}
