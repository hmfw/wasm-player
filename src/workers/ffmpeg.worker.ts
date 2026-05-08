// FFmpeg WASM 运行在独立 Worker 线程,避免 30MB 核心加载和转码阻塞主线程 UI。
//
// 通信协议定义见 src/shared/workerProtocol.ts。本 Worker 的职责:
//   - 接收 { type, requestId, payload }
//   - 无论成功失败都用同一 requestId 回 { type: 'result', ... } 或 { type: 'error', ... }
//   - progress 事件也带 requestId,便于主线程按请求归属
//   - log 是全局广播(FFmpeg stdout),不带 requestId
//
// core 来自同 package 的 @ffmpeg/core,通过 Vite 的 ?url 后缀拿到最终资源 URL;
// 这样 core.js 与 core.wasm 走与应用本体相同的源,避免 COEP 下的跨源阻塞。
import { FFmpeg } from '@ffmpeg/ffmpeg'
import coreJsURL from '@ffmpeg/core?url'
import coreWasmURL from '@ffmpeg/core/wasm?url'
import { parseProbeLog } from '../shared/probeLogParser'
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  ProbePayload,
  TranscodePayload,
  TranscodeSegmentPayload,
} from '../shared/workerProtocol'
import type { ProbeResult } from '../shared/types'

// Worker 模块级状态:单例 FFmpeg 实例 + probe 期间的日志收集开关。
// isLoaded 保证重复 'load' 消息幂等;collectingLogs 只在 probe 时开启,
// 避免转码期间海量日志堆积导致 Worker 内存飙升。
//
// cachedInputFiles: src → 虚拟文件系统中的文件名。同一 Worker 生命周期内同一 src
// 只下载一次，后续分段转码直接复用，避免每段重复下载整个视频文件。
let ffmpeg: FFmpeg | null = null
let isLoaded = false
let currentLogs: string[] = []
let collectingLogs = false
let currentProgressRequestId: string | null = null
const cachedInputFiles = new Map<string, string>()

function post(msg: WorkerToMainMessage): void {
  self.postMessage(msg)
}

self.onmessage = async (e: MessageEvent<MainToWorkerMessage>) => {
  const msg = e.data
  const { type, requestId } = msg

  try {
    if (type === 'load') {
      if (isLoaded) {
        post({ type: 'result', requestId, payload: { loaded: true } })
        return
      }

      ffmpeg = new FFmpeg()

      // 全局日志:原样转发(供开发期 console);probe 期间额外拷贝到 currentLogs 供解析。
      ffmpeg.on('log', ({ message }) => {
        if (collectingLogs) currentLogs.push(message)
        post({ type: 'log', payload: message })
      })

      ffmpeg.on('progress', ({ progress, time }) => {
        // 把进度归属到当前正在执行的请求(probe 不触发,transcode/segment 才会)。
        if (currentProgressRequestId) {
          post({
            type: 'progress',
            requestId: currentProgressRequestId,
            payload: { progress, time },
          })
        }
      })

      await ffmpeg.load({ coreURL: coreJsURL, wasmURL: coreWasmURL })
      isLoaded = true
      post({ type: 'result', requestId, payload: { loaded: true } })
      return
    }

    if (!ffmpeg || !isLoaded) {
      throw new Error('FFmpeg not loaded')
    }

    if (type === 'probe') {
      const result = await handleProbe(msg.payload)
      post({ type: 'result', requestId, payload: result })
      return
    }

    if (type === 'transcode') {
      const result = await handleTranscode(msg.payload, requestId)
      post({ type: 'result', requestId, payload: result })
      return
    }

    if (type === 'transcode-segment') {
      const result = await handleTranscodeSegment(msg.payload, requestId)
      post({ type: 'result', requestId, payload: result })
      return
    }
  } catch (error) {
    const err = error as Error
    post({
      type: 'error',
      requestId,
      payload: { message: err.message, name: err.name },
    })
  }
}

async function handleProbe(payload: ProbePayload): Promise<ProbeResult> {
  const { src } = payload
  const inputName = `probe_${getExt(src)}`

  // moov 位于文件头部是 faststart 再编码后的常见布局;只拉 512KB 即可识别容器/codec。
  // probe 用独立文件名，不进入 cachedInputFiles，用完即删。
  await fetchToVirtualFS(src, inputName, 512 * 1024)

  currentLogs = []
  collectingLogs = true

  try {
    await ffmpeg!.exec(['-i', inputName])
  } catch {
    // 只传 -i 时 FFmpeg 必定非零退出,但日志已经收齐——故意利用这一点采集输入信息。
  } finally {
    collectingLogs = false
    await ffmpeg!.deleteFile(inputName).catch(() => {})
  }

  return parseProbeLog(currentLogs.join('\n'), src)
}

async function handleTranscode(
  payload: TranscodePayload,
  requestId: string
): Promise<{ blob: Blob }> {
  const { src, outputFormat = 'mp4' } = payload
  const inputName = await ensureCachedInput(src)
  const outputName = `output_${requestId.slice(0, 8)}.${outputFormat}`

  currentProgressRequestId = requestId
  try {
    await ffmpeg!.exec([
      '-i', inputName,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      outputName,
    ])
    const data = await ffmpeg!.readFile(outputName)
    const blobPart: BlobPart = data instanceof Uint8Array ? new Uint8Array(data) : (data as string)
    const blob = new Blob([blobPart], { type: `video/${outputFormat}` })
    return { blob }
  } finally {
    currentProgressRequestId = null
    await ffmpeg!.deleteFile(outputName).catch(() => {})
  }
}

async function handleTranscodeSegment(
  payload: TranscodeSegmentPayload,
  requestId: string
): Promise<{ blob: Blob; startTime: number }> {
  const { src, startTime, duration, outputFormat = 'mp4' } = payload
  const inputName = await ensureCachedInput(src)
  const outputName = `seg_${requestId.slice(0, 8)}_${startTime}.${outputFormat}`

  currentProgressRequestId = requestId
  try {
    // 分段转码参数:-ss/-t 精确切片;-avoid_negative_ts make_zero 让每段从 0 计时;
    // -g 30 固定 GOP 保证每段起点是关键帧;-movflags frag_keyframe+empty_moov+default_base_moof
    // 产出 fMP4,MSE append 所必需。
    await ffmpeg!.exec([
      '-ss', startTime.toString(),
      '-t', duration.toString(),
      '-i', inputName,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-avoid_negative_ts', 'make_zero',
      '-fflags', '+genpts',
      '-g', '30',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      outputName,
    ])
    const data = await ffmpeg!.readFile(outputName)
    const blobPart: BlobPart = data instanceof Uint8Array ? new Uint8Array(data) : (data as string)
    const blob = new Blob([blobPart], { type: `video/${outputFormat}` })
    return { blob, startTime }
  } finally {
    currentProgressRequestId = null
    await ffmpeg!.deleteFile(outputName).catch(() => {})
  }
}

function getExt(src: string): string {
  return src.split('?')[0].split('.').pop()?.toLowerCase() || 'mp4'
}

// 确保 src 对应的完整文件已写入虚拟文件系统，返回文件名。
// 同一 src 在 Worker 生命周期内只下载一次，后续调用直接返回缓存文件名。
async function ensureCachedInput(src: string): Promise<string> {
  const cached = cachedInputFiles.get(src)
  if (cached) return cached
  const filename = `input_${cachedInputFiles.size}.${getExt(src)}`
  await fetchToVirtualFS(src, filename)
  cachedInputFiles.set(src, filename)
  return filename
}

async function fetchToVirtualFS(src: string, filename: string, maxBytes?: number): Promise<void> {
  const headers: Record<string, string> = {}
  if (maxBytes) headers['Range'] = `bytes=0-${maxBytes - 1}`
  const response = await fetch(src, { headers })
  if (!response.ok && response.status !== 206) {
    throw new Error(`fetch failed: ${response.status} ${response.statusText} (${src})`)
  }
  const buffer = await response.arrayBuffer()
  await ffmpeg!.writeFile(filename, new Uint8Array(buffer))
}
