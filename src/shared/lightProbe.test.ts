// lightProbe 单元测试：用构造的 MP4 二进制 fixture 验证解析逻辑。
// 不启动真实网络请求，通过 vi.stubGlobal 替换 fetch。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { lightProbeMP4 } from './lightProbe'

// ---- 二进制构造工具 ----

function writeUint32BE(buf: Uint8Array, offset: number, value: number) {
  buf[offset] = (value >>> 24) & 0xff
  buf[offset + 1] = (value >>> 16) & 0xff
  buf[offset + 2] = (value >>> 8) & 0xff
  buf[offset + 3] = value & 0xff
}

function ascii4(s: string): Uint8Array {
  return new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)])
}

function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const payload = concat(...children)
  const size = 8 + payload.byteLength
  const buf = new Uint8Array(size)
  writeUint32BE(buf, 0, size)
  buf.set(ascii4(type), 4)
  buf.set(payload, 8)
  return buf
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) { out.set(p, offset); offset += p.byteLength }
  return out
}

// ftyp box: major_brand(4) + minor_version(4) + compatible_brands(n*4)
function ftypBox(brand: string): Uint8Array {
  const payload = new Uint8Array(8)
  payload.set(ascii4(brand), 0)
  // minor_version = 0
  return box('ftyp', payload)
}

// mvhd box (version 0): version(1)+flags(3)+creation(4)+modification(4)+timescale(4)+duration(4)+...
function mvhdBox(timescale: number, duration: number): Uint8Array {
  const payload = new Uint8Array(96) // full mvhd v0 is 100 bytes payload
  // version=0, flags=0 (already 0)
  writeUint32BE(payload, 12, timescale)
  writeUint32BE(payload, 16, duration)
  return box('mvhd', payload)
}

// hdlr box: version(1)+flags(3)+pre_defined(4)+handler_type(4)+...
function hdlrBox(handlerType: string): Uint8Array {
  const payload = new Uint8Array(20)
  payload.set(ascii4(handlerType), 8)
  return box('hdlr', payload)
}

// stsd box (FullBox): version(1)+flags(3)+entry_count(4)+first_entry(size+type+...)
function stsdBox(codecType: string): Uint8Array {
  const fullBoxHeader = new Uint8Array(8) // version(1)+flags(3)+entry_count(4)
  writeUint32BE(fullBoxHeader, 4, 1)      // entry_count = 1
  // first entry: size(4)+type(4)+reserved(6)+data_ref_index(2) = 16 bytes minimum
  const entry = new Uint8Array(16)
  writeUint32BE(entry, 0, 16)
  entry.set(ascii4(codecType), 4)
  return box('stsd', fullBoxHeader, entry)
}

function videoTrak(codecType: string): Uint8Array {
  const stbl = box('stbl', stsdBox(codecType))
  const minf = box('minf', stbl)
  const mdia = box('mdia', hdlrBox('vide'), minf)
  return box('trak', mdia)
}

function audioTrak(codecType: string): Uint8Array {
  const stbl = box('stbl', stsdBox(codecType))
  const minf = box('minf', stbl)
  const mdia = box('mdia', hdlrBox('soun'), minf)
  return box('trak', mdia)
}

function buildMP4(videoCodecType: string, audioCodecType: string, durationSec: number): ArrayBuffer {
  const timescale = 1000
  const duration = Math.round(durationSec * timescale)
  const moov = box('moov', mvhdBox(timescale, duration), videoTrak(videoCodecType), audioTrak(audioCodecType))
  const ftyp = ftypBox('isom')
  return concat(ftyp, moov).buffer as ArrayBuffer
}

function mockFetch(buf: ArrayBuffer) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 206,
    arrayBuffer: () => Promise.resolve(buf),
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---- 测试 ----

describe('lightProbeMP4', () => {
  it('识别 H.264 MP4，返回 h264 + aac + duration', async () => {
    mockFetch(buildMP4('avc1', 'mp4a', 30))
    const result = await lightProbeMP4('https://example.com/video.mp4')
    expect(result).not.toBeNull()
    expect(result!.videoCodec).toBe('h264')
    expect(result!.audioCodec).toBe('aac')
    expect(result!.duration).toBeCloseTo(30, 1)
    expect(result!.container).toBe('mp4')
    expect(result!.mediaType).toBe('video')
    expect(result!.ok).toBe(true)
  })

  it('识别 H.265 MP4（hvc1），返回 hevc', async () => {
    mockFetch(buildMP4('hvc1', 'mp4a', 120))
    const result = await lightProbeMP4('https://example.com/video.mp4')
    expect(result).not.toBeNull()
    expect(result!.videoCodec).toBe('hevc')
    expect(result!.duration).toBeCloseTo(120, 1)
  })

  it('识别 H.265 MP4（hev1），返回 hevc', async () => {
    mockFetch(buildMP4('hev1', 'mp4a', 60))
    const result = await lightProbeMP4('https://example.com/video.mp4')
    expect(result!.videoCodec).toBe('hevc')
  })

  it('识别 avc3 为 h264', async () => {
    mockFetch(buildMP4('avc3', 'mp4a', 10))
    const result = await lightProbeMP4('https://example.com/video.mp4')
    expect(result!.videoCodec).toBe('h264')
  })

  it('fetch 失败时返回 null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
    const result = await lightProbeMP4('https://example.com/video.mp4')
    expect(result).toBeNull()
  })

  it('非 MP4 格式（无 ftyp）返回 null', async () => {
    // 构造一个没有 ftyp 的假 box 序列
    const unknownBox = box('mdat', new Uint8Array(16))
    const buf = unknownBox.buffer as ArrayBuffer
    mockFetch(buf)
    const result = await lightProbeMP4('https://example.com/video.mkv')
    expect(result).toBeNull()
  })

  it('有 ftyp 但无 moov（非 faststart）返回 null', async () => {
    const ftyp = ftypBox('isom')
    const mdat = box('mdat', new Uint8Array(16))
    const buf = concat(ftyp, mdat).buffer as ArrayBuffer
    mockFetch(buf)
    const result = await lightProbeMP4('https://example.com/video.mp4')
    expect(result).toBeNull()
  })

  it('streams 字段包含 video 和 audio 条目', async () => {
    mockFetch(buildMP4('avc1', 'mp4a', 5))
    const result = await lightProbeMP4('https://example.com/video.mp4')
    expect(result!.streams).toHaveLength(2)
    expect(result!.streams[0].codecType).toBe('video')
    expect(result!.streams[1].codecType).toBe('audio')
  })
})
