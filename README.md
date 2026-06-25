# @hmfw/wasm-player

基于 Vue 3 + TypeScript + mediabunny 的媒体播放器，支持 H.264、H.265/HEVC 视频和 MP3 等音频格式。

## 特性

- H.264 视频原生播放（`<video>` 标签）
- H.265/HEVC 视频通过 mediabunny CanvasSink 直接解码渲染到 Canvas（无需转码，无 MSE 复杂度）
- MP3 等音频格式原生播放，独立音频播放器 UI
- 用 mediabunny `Input` 在主线程直接 probe，识别 MP4 容器内的编解码器（h264 vs h265），无需 Worker 往返
- 智能预取与 LRU 缓存，自动处理 B-frame 排序和 RASL 帧跳过
- URL 入口做协议白名单（http/https/blob/data）
- 按格式分层的架构，易于扩展新格式

## 技术栈

- **Vue 3** — 前端框架
- **Vite** — 构建工具
- **TypeScript** — 类型安全
- **mediabunny** — 纯 TypeScript 媒体处理库（MP4 demux + WebCodecs 解码管线）
- **WebCodecs API** — 浏览器原生硬件加速编解码

## 安装

```bash
npm install @hmfw/wasm-player
```

## 快速开始

```vue
<template>
  <WasmPlayer src="/videos/demo.mp4" :width="800" :height="450" />
  <WasmPlayer src="/audio/track.mp3" />
</template>

<script setup>
import { WasmPlayer } from '@hmfw/wasm-player'
import '@hmfw/wasm-player/dist/player.css'
</script>
```

> **注意：** 消费者项目需配置服务端 COOP/COEP 头，详见[服务端配置](#服务端配置)。

## 使用组件

推荐直接使用 `WasmPlayer`，它会自动识别格式并路由到对应播放器：

```vue
<!-- 视频（自动识别 H.264 / H.265） -->
<WasmPlayer src="/videos/demo.mp4" :width="800" :height="450" />

<!-- 音频 -->
<WasmPlayer src="/audio/track.mp3" />
```

也可以直接使用底层组件：

```vue
<VideoPlayer src="/videos/h264.mp4" />
<StreamingPlayer src="/videos/h265.mp4" />
<AudioPlayer src="/audio/track.mp3" />
```

### WasmPlayer Props

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `src` | `string` | 必填 | 媒体 URL（支持 http/https/blob/data） |
| `autoplay` | `boolean` | `false` | 自动播放 |
| `width` | `number` | `800` | 宽度（px） |
| `height` | `number` | `450` | 高度（px，仅视频） |
| `poster` | `string` | — | 封面图 URL（仅视频） |

### VideoPlayer / StreamingPlayer Props

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `src` | `string` | 必填 | 视频 URL |
| `autoplay` | `boolean` | `false` | 自动播放 |
| `width` | `number` | `800` | 宽度（px） |
| `height` | `number` | `450` | 高度（px） |
| `poster` | `string` | — | 封面图 URL |

### AudioPlayer Props

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `src` | `string` | 必填 | 音频 URL |
| `autoplay` | `boolean` | `false` | 自动播放 |

## 工作原理

```
WasmPlayer.vue（智能路由）
  → detectMediaType()        扩展名快判（音频直接路由）
  → probeMediaBySrc()        mediabunny Input 主线程 probe
  → resolveCodecPlayback()   按 codec feature 决策
      h264  → VideoPlayer.vue（<video> 原生播放）
      h265  → StreamingPlayer.vue（Canvas 渲染）
      audio → AudioPlayer.vue（<audio> 原生播放）
```

**H.265/HEVC 播放流程**：

```
StreamingPlayer.vue
  ↓ useMediabunnyPlayer
  ↓ Input + UrlSource（获取视频轨道）
  ↓ CanvasSink（poolSize: 2, fit: 'contain'）
  ↓ for await (const { canvas, timestamp } of videoSink.canvases())
  ↓ RAF 循环：检查 nextFrame.timestamp <= currentTime，绘制到 Canvas
<canvas> 渲染
```

音频通过 `extractAudioToNative` 将编码包重封装为 ADTS 容器，生成 blob URL 挂载到原生 `<audio>` 元素，以 `audioRef.currentTime` 作为视频帧渲染的时钟源，保证音视频同步。

## 扩展新格式

在 `src/shared/index.ts` 的 `resolveCodecPlayback` 中添加分支：

```ts
if (result.videoCodec === 'vp9') {
  return { routeTarget: 'video', mode: 'native', reason: 'vp9 native' }
}
```

## 性能说明

- **probe 无 Worker 往返**：mediabunny `Input` 直接在主线程解析 MP4 元数据
- **无 WASM 开销**：mediabunny 是纯 TypeScript，WebCodecs 使用浏览器原生硬件加速编解码
- **智能预取**：mediabunny 内置网络优化预取策略和 LRU 缓存
- **Canvas 池复用**：零拷贝，减少内存分配
- **解码在独立线程**：WebCodecs 的 VideoDecoder 在浏览器独立线程运行，不阻塞主线程

## 浏览器兼容性

WebCodecs API 要求：

| 浏览器 | 最低版本 |
|--------|---------|
| Chrome / Edge | 94+ |
| Safari | 16.4+ |
| Firefox | 不支持 H.264/HEVC（WebCodecs 部分实现） |

## 本地开发

```bash
npm install
npm run dev        # 开发服务器 http://localhost:5173
npm run build      # 类型检查 + 生产构建
npm run build:lib  # 构建 npm 包到 dist/
npm run test       # 运行 vitest 单元测试
npm run lint       # ESLint 检查
npm run format     # Prettier 格式化 src/
```

## 测试

```bash
npm run test
```

覆盖范围：`src/shared/` 的决策函数与兜底逻辑。mediabunny 解码能力只能在真实浏览器中回归，建议搭配 Playwright 做冒烟测试。

## 服务端配置

本库依赖 SharedArrayBuffer（通过 mediabunny），浏览器要求页面处于 cross-origin isolated 环境。消费者项目需配置以下响应头：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Vite 开发服务器配置示例：

```js
// vite.config.ts
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
```

Nginx 配置示例：

```nginx
add_header Cross-Origin-Opener-Policy "same-origin";
add_header Cross-Origin-Embedder-Policy "require-corp";
```

## 许可证

MIT
