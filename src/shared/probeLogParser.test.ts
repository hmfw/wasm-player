import { describe, it, expect } from 'vitest'
import { parseProbeLog, normalizeCodec, guessContainerBySrc } from './probeLogParser'

describe('normalizeCodec', () => {
  it('归一 hevc/h264/avc1/h265/mp3', () => {
    expect(normalizeCodec('hevc')).toBe('hevc')
    expect(normalizeCodec('avc1')).toBe('h264')
    expect(normalizeCodec('h264')).toBe('h264')
    expect(normalizeCodec('h265')).toBe('h265')
    expect(normalizeCodec('mp3')).toBe('mp3')
  })

  it('未知 codec 保留小写原样', () => {
    expect(normalizeCodec('vp9')).toBe('vp9')
    expect(normalizeCodec('AV1')).toBe('av1')
  })

  it('空值返回 undefined', () => {
    expect(normalizeCodec(undefined)).toBeUndefined()
    expect(normalizeCodec('')).toBeUndefined()
  })
})

describe('guessContainerBySrc', () => {
  it('按扩展名推断,忽略 query string', () => {
    expect(guessContainerBySrc('https://x.com/a.mp4?token=x')).toBe('mp4')
    expect(guessContainerBySrc('a.mkv')).toBe('mkv')
    expect(guessContainerBySrc('nofile')).toBe('nofile')
  })
})

describe('parseProbeLog - H.264 snapshot', () => {
  const log = `
ffmpeg version 5.1 Copyright
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'input.mp4':
  Metadata:
    major_brand     : isom
  Duration: 00:00:30.50, start: 0.000000, bitrate: 1200 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo
At least one output file must be specified
`
  const r = parseProbeLog(log, 'https://x.com/a.mp4')
  it('识别容器/codec/duration', () => {
    expect(r.container).toBe('mov')
    expect(r.videoCodec).toBe('h264')
    expect(r.audioCodec).toBe('aac')
    expect(r.duration).toBeCloseTo(30.5, 2)
    expect(r.mediaType).toBe('video')
    expect(r.ok).toBe(true)
  })
})

describe('parseProbeLog - HEVC snapshot', () => {
  const log = `
Input #0, hevc, from 'input.mp4':
  Duration: N/A, bitrate: N/A
  Stream #0:0: Video: hevc (Main), yuv420p(tv, bt709), 3840x2160
`
  const r = parseProbeLog(log, 'a.mp4')
  it('识别 hevc', () => {
    expect(r.videoCodec).toBe('hevc')
    expect(r.mediaType).toBe('video')
  })

  it('缺 Duration 时 duration undefined', () => {
    expect(r.duration).toBeUndefined()
  })
})

describe('parseProbeLog - MP3 snapshot', () => {
  const log = `
Input #0, mp3, from 'input.mp3':
  Duration: 00:03:14.25, start: 0.025057, bitrate: 128 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s
`
  const r = parseProbeLog(log, 'a.mp3')
  it('识别 mp3 音频', () => {
    expect(r.container).toBe('mp3')
    expect(r.audioCodec).toBe('mp3')
    expect(r.videoCodec).toBeUndefined()
    expect(r.mediaType).toBe('audio')
    expect(r.duration).toBeCloseTo(194.25, 2)
  })
})

describe('parseProbeLog - 无法识别时兜底', () => {
  it('空日志返回 unknown 并带 error', () => {
    const r = parseProbeLog('', 'x.unknown')
    expect(r.mediaType).toBe('unknown')
    expect(r.ok).toBe(false)
    expect(r.error).toBeDefined()
  })
})
