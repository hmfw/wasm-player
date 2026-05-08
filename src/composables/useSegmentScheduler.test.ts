import { describe, it, expect, vi } from 'vitest'
import { useSegmentScheduler } from './useSegmentScheduler'

const makeBlob = () => new Blob([new Uint8Array([0])], { type: 'video/mp4' })

describe('useSegmentScheduler', () => {
  it('按段顺序产出 blob 并在完成时回调 onAllComplete', async () => {
    const seen: number[] = []
    const done = vi.fn()
    const s = useSegmentScheduler({
      src: 'x',
      totalDuration: 60,
      segmentDuration: 20,
      transcode: async (_src, start) => {
        seen.push(start)
        return makeBlob()
      },
      onSegmentReady: () => {},
      onAllComplete: done,
      onFatal: () => {},
    })
    expect(s.totalSegments).toBe(3)
    s.start()
    // 等所有段完成
    await new Promise((r) => setTimeout(r, 50))
    expect(seen).toEqual([0, 20, 40])
    expect(done).toHaveBeenCalledOnce()
  })

  it('单段失败会重试指定次数后标记失败,继续下一段', async () => {
    let call = 0
    const s = useSegmentScheduler({
      src: 'x',
      totalDuration: 40,
      segmentDuration: 20,
      maxRetries: 2,
      transcode: async (_src, start) => {
        call++
        if (start === 0) throw new Error('boom')
        return makeBlob()
      },
      onSegmentReady: () => {},
      onAllComplete: () => {},
      onFatal: () => {},
    })
    // 用假 timer 跳过退避延迟
    vi.useFakeTimers()
    s.start()
    // 推进重试退避:1000 + 2000 = 3000ms + 抖动
    await vi.advanceTimersByTimeAsync(5000)
    vi.useRealTimers()
    await new Promise((r) => setTimeout(r, 20))

    expect(s.failedSegments.value).toEqual([0])
    // 第一段:3 次尝试;第二段:1 次成功 → 共 4 次 transcode 调用
    expect(call).toBe(4)
  })

  it('失败段超过阈值时触发 onFatal', async () => {
    const fatal = vi.fn()
    const s = useSegmentScheduler({
      src: 'x',
      totalDuration: 60,
      segmentDuration: 20,
      maxRetries: 0, // 立即失败
      failureRatioThreshold: 0.3,
      transcode: async () => {
        throw new Error('all-fail')
      },
      onSegmentReady: () => {},
      onAllComplete: () => {},
      onFatal: fatal,
    })
    s.start()
    await new Promise((r) => setTimeout(r, 50))
    expect(fatal).toHaveBeenCalled()
  })

  it('cancel 后不再产出段', async () => {
    const ready = vi.fn()
    const s = useSegmentScheduler({
      src: 'x',
      totalDuration: 60,
      segmentDuration: 20,
      maxRetries: 0,
      transcode: async () => {
        await new Promise((r) => setTimeout(r, 20))
        return makeBlob()
      },
      onSegmentReady: ready,
      onAllComplete: () => {},
      onFatal: () => {},
    })
    s.start()
    s.cancel()
    await new Promise((r) => setTimeout(r, 80))
    expect(ready).not.toHaveBeenCalled()
  })
})
