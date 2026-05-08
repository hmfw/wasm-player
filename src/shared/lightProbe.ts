// 轻量级 MP4/MOV 二进制 probe，无需加载 FFmpeg WASM。
// 解析 box 结构提取 codec/duration，成功返回 ProbeResult，无法解析返回 null（调用方回退到 FFmpeg）。
//
// 支持范围：faststart 编码的 MP4/MOV（moov 在文件头部 512KB 内）。
// 不支持：moov 在文件末尾的非 faststart 文件、MKV、FLV、AVI 等——这些返回 null。

import type { ProbeResult, ProbeStreamInfo } from './types'

const MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso4', 'iso5', 'iso6',
  'mp41', 'mp42', 'M4V ', 'M4A ', 'M4P ',
  'avc1', 'qt  ', 'f4v ', 'mmp4', 'MSNV',
])

function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, false)
}

function readBoxType(buf: Uint8Array, offset: number): string {
  return String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3])
}

// 遍历 buf[start, start+length) 内的所有直接子 box，对每个 box 调用 visitor。
// visitor 返回 true 时停止遍历（找到目标）。
function walkBoxes(
  buf: Uint8Array,
  view: DataView,
  start: number,
  length: number,
  visitor: (type: string, boxStart: number, dataStart: number, dataLen: number) => boolean
): void {
  let pos = start
  const end = start + length
  while (pos + 8 <= end) {
    let size = readUint32(view, pos)
    const type = readBoxType(buf, pos + 4)
    let headerSize = 8

    if (size === 1) {
      // 64-bit extended size
      if (pos + 16 > end) break
      const hi = readUint32(view, pos + 8)
      const lo = readUint32(view, pos + 12)
      // 只处理在 buf 范围内的 box（hi 必须为 0）
      if (hi !== 0) { pos += 16; continue }
      size = lo
      headerSize = 16
    } else if (size === 0) {
      // box 延伸到文件末尾，跳过
      break
    }

    if (size < headerSize || pos + size > end) break

    const dataStart = pos + headerSize
    const dataLen = size - headerSize
    if (visitor(type, pos, dataStart, dataLen)) return
    pos += size
  }
}

function parseFtyp(buf: Uint8Array, dataStart: number, dataLen: number): boolean {
  if (dataLen < 4) return false
  const brand = readBoxType(buf, dataStart)
  if (MP4_BRANDS.has(brand)) return true
  // 检查 compatible brands（每 4 字节一个）
  for (let i = 8; i + 4 <= dataLen; i += 4) {
    if (MP4_BRANDS.has(readBoxType(buf, dataStart + i))) return true
  }
  return false
}

interface MvhdInfo {
  duration: number
}

function parseMvhd(view: DataView, dataStart: number, dataLen: number): MvhdInfo | null {
  if (dataLen < 20) return null
  const version = view.getUint8(dataStart)
  let timescale: number
  let durationRaw: number
  if (version === 1) {
    if (dataLen < 32) return null
    timescale = readUint32(view, dataStart + 20)
    const hi = readUint32(view, dataStart + 24)
    const lo = readUint32(view, dataStart + 28)
    durationRaw = hi * 0x100000000 + lo
  } else {
    if (dataLen < 20) return null
    timescale = readUint32(view, dataStart + 12)
    durationRaw = readUint32(view, dataStart + 16)
  }
  if (timescale === 0) return null
  return { duration: durationRaw / timescale }
}

function parseHdlr(buf: Uint8Array, dataStart: number, dataLen: number): 'vide' | 'soun' | null {
  // version(1) + flags(3) + pre_defined(4) + handler_type(4)
  if (dataLen < 12) return null
  const handlerType = readBoxType(buf, dataStart + 8)
  if (handlerType === 'vide') return 'vide'
  if (handlerType === 'soun') return 'soun'
  return null
}

function parseStsd(buf: Uint8Array, dataStart: number, dataLen: number): string | null {
  // stsd 是 FullBox: version(1)+flags(3)+entry_count(4) = 8 bytes，然后是第一个 entry
  // 每个 entry: size(4)+type(4)，所以 type 在 dataStart+8+4 = dataStart+12
  if (dataLen < 16) return null
  return readBoxType(buf, dataStart + 12)
}

function normalizeVideoCodec(stsdType: string): 'h264' | 'hevc' | null {
  if (stsdType === 'avc1' || stsdType === 'avc3') return 'h264'
  if (stsdType === 'hvc1' || stsdType === 'hev1' || stsdType === 'dvhe' || stsdType === 'dvh1') return 'hevc'
  return null
}

function normalizeAudioCodec(stsdType: string): 'aac' | 'mp3' | null {
  if (stsdType === 'mp4a') return 'aac'
  if (stsdType === '.mp3' || stsdType === 'mp3 ') return 'mp3'
  return null
}

interface TrackInfo {
  trackType: 'vide' | 'soun'
  codec: string
}

function parseTrak(
  buf: Uint8Array,
  view: DataView,
  trakDataStart: number,
  trakDataLen: number
): TrackInfo | null {
  let trackType: 'vide' | 'soun' | null = null
  let codec: string | null = null

  // mdia box
  walkBoxes(buf, view, trakDataStart, trakDataLen, (type, _bs, ds, dl) => {
    if (type !== 'mdia') return false
    walkBoxes(buf, view, ds, dl, (mtype, _mbs, mds, mdl) => {
      if (mtype === 'hdlr') {
        trackType = parseHdlr(buf, mds, mdl)
        return false
      }
      if (mtype === 'minf') {
        walkBoxes(buf, view, mds, mdl, (itype, _ibs, ids, idl) => {
          if (itype !== 'stbl') return false
          walkBoxes(buf, view, ids, idl, (stype, _sbs, sds, sdl) => {
            if (stype !== 'stsd') return false
            codec = parseStsd(buf, sds, sdl)
            return true
          })
          return true
        })
        return true
      }
      return false
    })
    return true
  })

  if (!trackType || !codec) return null
  return { trackType, codec }
}

export async function lightProbeMP4(src: string): Promise<ProbeResult | null> {
  try {
    const response = await fetch(src, { headers: { Range: 'bytes=0-524287' } })
    if (!response.ok && response.status !== 206) return null
    const buffer = await response.arrayBuffer()
    const buf = new Uint8Array(buffer)
    const view = new DataView(buffer)

    let isMP4 = false
    let duration: number | undefined
    let videoCodec: 'h264' | 'hevc' | undefined
    let audioCodec: 'aac' | 'mp3' | undefined
    let moovFound = false

    walkBoxes(buf, view, 0, buf.byteLength, (type, _bs, ds, dl) => {
      if (type === 'ftyp') {
        isMP4 = parseFtyp(buf, ds, dl)
        return false
      }
      if (type === 'moov') {
        moovFound = true
        // mvhd
        walkBoxes(buf, view, ds, dl, (mtype, _mbs, mds, mdl) => {
          if (mtype === 'mvhd') {
            const info = parseMvhd(view, mds, mdl)
            if (info) duration = info.duration
            return false
          }
          if (mtype === 'trak') {
            const track = parseTrak(buf, view, mds, mdl)
            if (track) {
              if (track.trackType === 'vide' && !videoCodec) {
                videoCodec = normalizeVideoCodec(track.codec) ?? undefined
              } else if (track.trackType === 'soun' && !audioCodec) {
                audioCodec = normalizeAudioCodec(track.codec) ?? undefined
              }
            }
            return false
          }
          return false
        })
        return true
      }
      return false
    })

    if (!isMP4 || !moovFound) return null

    const streams: ProbeStreamInfo[] = []
    if (videoCodec) streams.push({ codecType: 'video', codecName: videoCodec })
    if (audioCodec) streams.push({ codecType: 'audio', codecName: audioCodec })

    const mediaType = videoCodec ? 'video' : audioCodec ? 'audio' : 'unknown'
    if (mediaType === 'unknown') return null

    return {
      ok: true,
      mediaType,
      container: 'mp4',
      videoCodec,
      audioCodec,
      streams,
      duration,
    }
  } catch {
    return null
  }
}
