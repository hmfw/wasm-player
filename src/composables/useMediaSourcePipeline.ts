import { ref, type Ref } from 'vue'

// MSE 管线 composable:只管 MediaSource / SourceBuffer 的生命周期与 append/remove 互斥,
// 不关心"下一段从哪来"。转码调度由 useSegmentScheduler 负责,通过 enqueue 回传到这里。
//
// 核心约束(继承自原 StreamingPlayer.vue 实现):
//   - SourceBuffer 的 append/remove 是异步的,必须在 updateend 之后才能再次操作
//   - MediaSource 在 readyState='open' 之前不能 addSourceBuffer
//   - 组件卸载时必须置 cancelled,否则 await 里的 Blob.arrayBuffer() 回来后会写到已销毁的 sb

export interface MseSegment {
  blob: Blob
  offset: number
  index: number
}

export interface UseMsePipelineOptions {
  codecs: string
  totalDuration?: number
  onError: (err: Error) => void
}

export interface UseMsePipelineReturn {
  attach: (video: HTMLVideoElement) => void
  enqueue: (seg: MseSegment) => void
  removeBefore: (time: number) => void
  endOfStream: () => void
  destroy: () => void
  isReady: Readonly<Ref<boolean>>
}

export function useMediaSourcePipeline(opts: UseMsePipelineOptions): UseMsePipelineReturn {
  const isReady: Ref<boolean> = ref(false)
  let mediaSource: MediaSource | null = null
  let sourceBuffer: SourceBuffer | null = null
  let mediaSourceUrl: string | null = null
  let video: HTMLVideoElement | null = null

  // 管线状态机:append 与 remove 都触发 updateend,必须互斥——同时进行会抛 InvalidStateError
  let isAppending = false
  let isRemoving = false
  let pendingSegments: MseSegment[] = []
  let pendingRemoveBefore: number | null = null  // 最新的 remove 请求，只保留最大值
  let finished = false
  let cancelled = false

  function attach(el: HTMLVideoElement) {
    if (!('MediaSource' in window)) {
      opts.onError(new Error('浏览器不支持 MediaSource API'))
      return
    }
    video = el
    const ms = new MediaSource()
    mediaSource = ms
    mediaSourceUrl = URL.createObjectURL(ms)

    ms.addEventListener('sourceopen', () => {
      if (mediaSource !== ms || cancelled) return
      if (ms.sourceBuffers.length > 0) return
      try {
        const sb = ms.addSourceBuffer(opts.codecs)
        sb.mode = 'segments'
        sourceBuffer = sb

        // 预置总时长,避免 video.duration 返回 Infinity 导致 UI 显示 "Infinity:NaN"
        if (opts.totalDuration && Number.isFinite(opts.totalDuration) && opts.totalDuration > 0) {
          try {
            ms.duration = opts.totalDuration
          } catch {
            /* 某些实现在 addSourceBuffer 前/后窗口受限,忽略即可 */
          }
        }

        sb.addEventListener('updateend', () => {
          if (mediaSource !== ms) return
          if (isRemoving) {
            isRemoving = false
            pump()
            return
          }
          isAppending = false
          pump()
          maybeEndOfStream()
        })

        sb.addEventListener('error', () => {
          if (mediaSource !== ms) return
          opts.onError(new Error('SourceBuffer error'))
        })

        isReady.value = true
        pump()
      } catch (err) {
        if (mediaSource !== ms) return
        opts.onError(err as Error)
      }
    })

    el.src = mediaSourceUrl
  }

  function pump() {
    if (cancelled || isAppending || isRemoving) return
    if (!sourceBuffer || sourceBuffer.updating) return
    if (!mediaSource || mediaSource.readyState !== 'open') return

    // 优先执行 remove，再 append，避免 buffer 无限增长
    if (pendingRemoveBefore !== null) {
      const time = pendingRemoveBefore
      pendingRemoveBefore = null
      if (time > 0) {
        try {
          isRemoving = true
          sourceBuffer.remove(0, time)
        } catch {
          isRemoving = false
        }
        return
      }
    }

    if (pendingSegments.length === 0) return

    const segment = pendingSegments.shift()!
    isAppending = true

    segment.blob.arrayBuffer().then((buf) => {
      if (cancelled || !sourceBuffer || !mediaSource || mediaSource.readyState !== 'open') {
        isAppending = false
        return
      }
      try {
        sourceBuffer.timestampOffset = segment.offset
        sourceBuffer.appendBuffer(buf)
      } catch (err) {
        isAppending = false
        opts.onError(err as Error)
      }
    })
  }

  function maybeEndOfStream() {
    if (!finished) return
    if (pendingSegments.length > 0 || isAppending || isRemoving) return
    if (mediaSource && mediaSource.readyState === 'open') {
      try {
        mediaSource.endOfStream()
      } catch {
        // 已 ended 或 closed,忽略
      }
    }
  }

  function enqueue(seg: MseSegment) {
    if (cancelled) return
    pendingSegments.push(seg)
    pump()
  }

  function removeBefore(time: number) {
    if (cancelled || time <= 0) return
    // 记录最新的 remove 请求（取最大值），由 pump 在空闲时执行
    pendingRemoveBefore = pendingRemoveBefore === null ? time : Math.max(pendingRemoveBefore, time)
    pump()
  }

  function endOfStream() {
    finished = true
    maybeEndOfStream()
  }

  function destroy() {
    cancelled = true
    if (sourceBuffer && mediaSource && mediaSource.readyState === 'open') {
      try {
        sourceBuffer.abort()
        mediaSource.removeSourceBuffer(sourceBuffer)
      } catch {
        /* empty */
      }
    }
    if (mediaSource && mediaSource.readyState === 'open') {
      try {
        mediaSource.endOfStream()
      } catch {
        /* empty */
      }
    }
    if (video) {
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
    if (mediaSourceUrl) {
      URL.revokeObjectURL(mediaSourceUrl)
      mediaSourceUrl = null
    }
    pendingSegments = []
    pendingRemoveBefore = null
    sourceBuffer = null
    mediaSource = null
    video = null
  }

  return { attach, enqueue, removeBefore, endOfStream, destroy, isReady }
}
