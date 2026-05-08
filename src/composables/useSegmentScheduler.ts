import { ref, type Ref } from 'vue'
import type { MseSegment } from './useMediaSourcePipeline'

// 段调度 composable:管理"下一段什么时候转、失败怎么重试"。
// 不触碰 DOM、不关心 SourceBuffer,通过回调把转好的 blob 交给 pipeline.enqueue。
//
// 重试策略:每段最多 3 次尝试(初次 + 2 次重试),指数退避 + 抖动。
// 失败段不阻断后续段,通过 failedSegments 汇报给 UI;失败段数超过阈值时才整体 error。

export interface UseSchedulerOptions {
  src: string
  totalDuration: number
  segmentDuration: number
  prefetchThresholdRatio?: number
  maxRetries?: number
  failureRatioThreshold?: number
  transcode: (src: string, startTime: number, duration: number) => Promise<Blob>
  onSegmentReady: (seg: MseSegment) => void
  onAllComplete: () => void
  onFatal: (err: Error) => void
}

export interface UseSchedulerReturn {
  start: () => void
  onTimeUpdate: (currentTime: number, bufferedEnd: number) => void
  cancel: () => void
  progress: Readonly<Ref<number>>
  failedSegments: Readonly<Ref<number[]>>
  totalSegments: number
}

export function useSegmentScheduler(opts: UseSchedulerOptions): UseSchedulerReturn {
  const {
    src,
    totalDuration,
    segmentDuration,
    prefetchThresholdRatio = 0.8,
    maxRetries = 2,
    failureRatioThreshold = 1 / 3,
    transcode,
    onSegmentReady,
    onAllComplete,
    onFatal,
  } = opts

  const totalSegments = Math.ceil(totalDuration / segmentDuration)
  const progress: Ref<number> = ref(0)
  const failedSegments: Ref<number[]> = ref([])

  let currentSegment = 0
  let isTranscoding = false
  let cancelled = false
  let currentAbortController: AbortController | null = null

  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  async function transcodeWithRetry(
    index: number,
    startTime: number,
    duration: number
  ): Promise<Blob | null> {
    // 为这次转码创建 AbortController,cancel() 时可以立即中断等待
    const abortController = new AbortController()
    currentAbortController = abortController

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (cancelled || abortController.signal.aborted) {
        currentAbortController = null
        return null
      }
      try {
        // 包装 transcode Promise,让它可以被 abort signal 中断
        const blob = await Promise.race([
          transcode(src, startTime, duration),
          new Promise<never>((_, reject) => {
            abortController.signal.addEventListener('abort', () => {
              reject(new Error('transcoding aborted'))
            })
          }),
        ])
        currentAbortController = null
        return blob
      } catch (err) {
        if (cancelled || abortController.signal.aborted) {
          currentAbortController = null
          return null
        }
        if (attempt === maxRetries) {
          failedSegments.value = [...failedSegments.value, index]
          currentAbortController = null
          return null
        }
        const backoff = 1000 * 2 ** attempt + Math.random() * 500
        await delay(backoff)
      }
    }
    currentAbortController = null
    return null
  }

  async function transcodeNext() {
    if (cancelled || isTranscoding) return
    if (currentSegment >= totalSegments) return

    isTranscoding = true
    const index = currentSegment
    const startTime = index * segmentDuration
    const duration = Math.min(segmentDuration, totalDuration - startTime)

    const blob = await transcodeWithRetry(index, startTime, duration)

    if (cancelled) {
      isTranscoding = false
      return
    }

    currentSegment++
    progress.value = currentSegment / totalSegments

    if (blob) {
      onSegmentReady({ blob, offset: startTime, index })
    }

    // 失败段累积超过阈值 → 整体 error
    if (failedSegments.value.length > Math.max(1, Math.floor(totalSegments * failureRatioThreshold))) {
      cancelled = true
      isTranscoding = false
      onFatal(new Error(`段转码失败过多 (${failedSegments.value.length}/${totalSegments})`))
      return
    }

    if (currentSegment >= totalSegments) {
      isTranscoding = false
      onAllComplete()
      return
    }
    // isTranscoding 保持 true 直到 microtask 执行,防止 onTimeUpdate 在此窗口触发重复转码。
    queueMicrotask(() => {
      isTranscoding = false
      transcodeNext()
    })
  }

  function start() {
    transcodeNext()
  }

  function onTimeUpdate(currentTime: number, bufferedEnd: number) {
    if (cancelled) return
    const remaining = bufferedEnd - currentTime
    if (remaining < segmentDuration * prefetchThresholdRatio && currentSegment < totalSegments) {
      transcodeNext()
    }
  }

  function cancel() {
    cancelled = true
    isTranscoding = false
    // 立即中断当前在途的转码请求,不再等待 Worker 返回
    if (currentAbortController) {
      currentAbortController.abort()
      currentAbortController = null
    }
  }

  return {
    start,
    onTimeUpdate,
    cancel,
    progress,
    failedSegments,
    totalSegments,
  }
}
