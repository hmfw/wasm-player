import { describe, it, expect } from 'vitest'
import { detectMediaType } from './mediaProbe'
import { resolveCodecPlayback } from './index'
import { fallbackMediaProbe, fallbackH264Probe } from './probeFallback'
import type { ProbeResult } from './types'

describe('detectMediaType', () => {
  it('识别常见视频扩展名', () => {
    expect(detectMediaType('https://x.com/a.mp4')).toBe('video')
    expect(detectMediaType('a.mkv')).toBe('video')
    expect(detectMediaType('a.webm?v=1')).toBe('video')
  })

  it('识别常见音频扩展名', () => {
    expect(detectMediaType('a.mp3')).toBe('audio')
    expect(detectMediaType('a.flac')).toBe('audio')
  })

  it('未知扩展名返回 unknown', () => {
    expect(detectMediaType('a.xyz')).toBe('unknown')
    expect(detectMediaType('https://x.com/nofile')).toBe('unknown')
  })
})

describe('resolveCodecPlayback', () => {
  const base: ProbeResult = { ok: true, mediaType: 'video', container: 'mp4', streams: [] }

  it('h264 走 native', () => {
    const d = resolveCodecPlayback({ ...base, videoCodec: 'h264' })
    expect(d).toEqual({ routeTarget: 'video', mode: 'native', reason: 'h264 native: mp4' })
  })

  it('hevc/h265 走 transcode', () => {
    expect(resolveCodecPlayback({ ...base, videoCodec: 'hevc' }).mode).toBe('transcode')
    expect(resolveCodecPlayback({ ...base, videoCodec: 'h265' }).mode).toBe('transcode')
  })

  it('mp3 走 audio native', () => {
    const d = resolveCodecPlayback({ ...base, mediaType: 'audio', audioCodec: 'mp3', container: 'mp3' })
    expect(d.routeTarget).toBe('audio')
    expect(d.mode).toBe('native')
  })

  it('未知 codec 走兜底', () => {
    const d = resolveCodecPlayback({ ...base, videoCodec: 'vp9' })
    expect(d.mode).toBe('native')
  })
})

describe('fallbackMediaProbe', () => {
  it('视频扩展名兜底为 h264', () => {
    const r = fallbackMediaProbe('a.mp4')
    expect(r.videoCodec).toBe('h264')
    expect(r.mediaType).toBe('video')
  })

  it('音频扩展名兜底为 mp3', () => {
    const r = fallbackMediaProbe('a.mp3')
    expect(r.audioCodec).toBe('mp3')
    expect(r.mediaType).toBe('audio')
  })

  it('fallbackH264Probe 总是返回 h264', () => {
    expect(fallbackH264Probe('a.mov').videoCodec).toBe('h264')
  })
})
