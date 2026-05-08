// 协议层单元测试:sendRequest 按 requestId 路由,保证并发不错位。
// 不走真实 Worker(happy-dom 无 Worker 语义),而是 mock 全局 Worker 构造器。
//
// 这组测试的重点是复现修复前的"错位 reject"场景:老版在并发 probe 时一条 error
// 会让两个 Promise 同时 reject 到同一错误;新版按 requestId 精确归属。

import { describe, it, expect, beforeEach, vi } from 'vitest'

// 必须在 import useFFmpeg 之前替换 Worker。
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: ErrorEvent) => void) | null = null
  messageListeners: Array<(e: MessageEvent) => void> = []
  errorListeners: Array<(e: ErrorEvent) => void> = []
  terminated = false
  lastSent: any[] = []

  constructor(public url: string | URL, public opts?: any) {
    FakeWorker.instances.push(this)
  }

  addEventListener(type: string, handler: any) {
    if (type === 'message') this.messageListeners.push(handler)
    if (type === 'error') this.errorListeners.push(handler)
  }
  removeEventListener(type: string, handler: any) {
    if (type === 'message')
      this.messageListeners = this.messageListeners.filter((h) => h !== handler)
    if (type === 'error') this.errorListeners = this.errorListeners.filter((h) => h !== handler)
  }

  postMessage(msg: any) {
    this.lastSent.push(msg)
  }

  terminate() {
    this.terminated = true
  }

  // 测试助手:模拟 Worker 向主线程发消息
  emit(payload: any) {
    const event = { data: payload } as MessageEvent
    this.messageListeners.forEach((h) => h(event))
  }

  static instances: FakeWorker[] = []
  static reset() {
    FakeWorker.instances = []
  }
}

// @ts-expect-error 覆盖全局 Worker
globalThis.Worker = FakeWorker

// 清空所有已排队的 microtask + 一轮宏任务,确保 await 链全部解开
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

// 把某个 FakeWorker 上等待中的 load 请求放行
const resolveLoad = (w: FakeWorker) => {
  const loadMsg = w.lastSent.find((m) => m.type === 'load')
  if (!loadMsg) return
  w.emit({ type: 'result', requestId: loadMsg.requestId, payload: { loaded: true } })
}

describe('useFFmpeg sendRequest 协议', () => {
  let useFFmpeg: typeof import('./useFFmpeg').useFFmpeg
  let __testing: typeof import('./useFFmpeg').__testing

  beforeEach(async () => {
    vi.resetModules()
    FakeWorker.reset()
    const mod = await import('./useFFmpeg')
    useFFmpeg = mod.useFFmpeg
    __testing = mod.__testing
  })

  it('initWorker 首次调用才创建 Worker,复用不重建', async () => {
    const { probeMediaBySrc } = useFFmpeg()
    const { probeMediaBySrc: probe2 } = useFFmpeg()

    // Worker 在第一次实际使用时才创建（懒加载）
    probeMediaBySrc('a.mp4')
    await flush()
    expect(FakeWorker.instances.length).toBe(1)

    // 第二次调用复用同一个 Worker
    probe2('b.mp4')
    await flush()
    expect(FakeWorker.instances.length).toBe(1)
  })

  it('并发 probe 的结果按 requestId 精确归属,不错位', async () => {
    const { probeMediaBySrc } = useFFmpeg()

    const p1 = probeMediaBySrc('a.mp4')
    const p2 = probeMediaBySrc('b.mp4')

    await flush()
    const w = FakeWorker.instances[0]
    resolveLoad(w)
    await flush()

    const probeMsgs = w.lastSent.filter((m) => m.type === 'probe')
    expect(probeMsgs.length).toBe(2)
    const [m1, m2] = probeMsgs
    expect(m1.requestId).not.toBe(m2.requestId)

    // 把 m2 先 error,m1 后 result
    w.emit({
      type: 'error',
      requestId: m2.requestId,
      payload: { message: 'probe b failed' },
    })
    w.emit({
      type: 'result',
      requestId: m1.requestId,
      payload: { ok: true, mediaType: 'video', container: 'mp4', streams: [] },
    })

    await expect(p2).rejects.toThrow('probe b failed')
    await expect(p1).resolves.toMatchObject({ mediaType: 'video' })
  })

  it('超时会 reject 并从 pending 清除', async () => {
    const mod = await import('./useFFmpeg')
    mod.__testing.setTimeoutMs('probe', 50)
    mod.__testing.setTimeoutMs('load', 50)

    const { probeMediaBySrc } = useFFmpeg()

    const p = probeMediaBySrc('a.mp4').catch((e) => e)
    await flush()
    const w = FakeWorker.instances[0]
    resolveLoad(w)
    await flush()

    await new Promise((r) => setTimeout(r, 100))
    const result = await p
    expect((result as Error).message).toMatch(/timeout.*probe/)
    expect(__testing.getPendingSize()).toBe(0)
  })

  it('forceTerminate 会 reject 所有 pending 并清空 Map', async () => {
    const { probeMediaBySrc } = useFFmpeg()
    const p = probeMediaBySrc('a.mp4')
    await flush()
    const w = FakeWorker.instances[0]
    resolveLoad(w)
    await flush()

    expect(__testing.getPendingSize()).toBe(1)
    __testing.forceTerminate()
    await expect(p).rejects.toThrow('worker terminated')
    expect(__testing.getPendingSize()).toBe(0)
    expect(w.terminated).toBe(true)
  })

  it('load 幂等:多次 loadFFmpeg 并发调用共享同一 in-flight Promise', async () => {
    const { loadFFmpeg } = useFFmpeg()
    const p1 = loadFFmpeg()
    const p2 = loadFFmpeg()
    const w = FakeWorker.instances[0]

    const loadMsgs = w.lastSent.filter((m) => m.type === 'load')
    expect(loadMsgs.length).toBe(1)

    resolveLoad(w)
    await expect(p1).resolves.toBeUndefined()
    await expect(p2).resolves.toBeUndefined()
  })
})
