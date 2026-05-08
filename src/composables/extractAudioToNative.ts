import {
  Output, AdtsOutputFormat, BufferTarget,
  EncodedPacketSink, EncodedAudioPacketSource,
  type InputAudioTrack,
} from 'mediabunny'

// 将音频轨道的所有编码包重新封装为 ADTS 容器，返回可直接挂载到 <audio> 的 blob URL。
// 必须在播放前完整读取所有包（无法流式传输），因此仅适用于时长有限的文件。
export async function extractAudioToNative(
  audioTrack: InputAudioTrack,
): Promise<{ blobUrl: string } | null> {
  const audioCodec = await audioTrack.getCodec()
  if (!audioCodec) return null

  const audioSource = new EncodedAudioPacketSource(audioCodec)
  const audioOutput = new Output({
    format: new AdtsOutputFormat(),
    target: new BufferTarget(),
  })
  audioOutput.addAudioTrack(audioSource)
  await audioOutput.start()

  const decoderConfig = await audioTrack.getDecoderConfig()
  const sink = new EncodedPacketSink(audioTrack)
  let isFirst = true
  for await (const packet of sink.packets()) {
    // 负时间戳是 B 帧预卷帧，跳过以避免解码器报错
    if (packet.timestamp < 0) continue
    // 首包需要携带 decoderConfig，后续包不需要
    const meta = isFirst && decoderConfig ? { decoderConfig } : undefined
    await audioSource.add(packet, meta)
    isFirst = false
  }
  await audioOutput.finalize()

  const buffer = (audioOutput.target as BufferTarget).buffer
  if (!buffer) return null

  const mimeType = await audioOutput.getMimeType()
  const blob = new Blob([buffer], { type: mimeType })
  return { blobUrl: URL.createObjectURL(blob) }
}

export function applyAudioToElement(
  audioEl: HTMLAudioElement,
  blobUrl: string,
  volume: number,
): void {
  audioEl.src = blobUrl
  audioEl.volume = volume
}
