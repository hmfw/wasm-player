# wasm-player

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

## 快速开始

```bash
npm install
npm run dev      # 开发服务器 http://localhost:5173
npm run build    # 类型检查 + 生产构建
npm run preview  # 预览生产构建
npm run test     # 运行 vitest 单元测试
npm run lint     # ESLint 检查
npm run format   # Prettier 格式化 src/
```

## 使用组件

推荐直接使用 `WasmPlayer`，它会自动识别格式并路由到视频或音频播放器：

```vue
<WasmPlayer src="/videos/demo.mp4" :width="800" :height="450" />
<WasmPlayer src="/audio/track.mp3" />
```

也可以直接使用底层组件：

```vue
<VideoPlayer src="/videos/h264.mp4" />
<AudioPlayer src="/audio/track.mp3" />
```

### WasmPlayer Props

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `src` | `string` | 必填 | 媒体 URL |
| `autoplay` | `boolean` | `false` | 自动播放 |
| `width` | `number` | `800` | 宽度（px） |
| `height` | `number` | `450` | 高度（px，仅视频） |
| `poster` | `string` | — | 封面图（仅视频） |

### VideoPlayer Props

| Prop | 类型 | 默认值 |
|------|------|--------|
| `src` | `string` | 必填 |
| `autoplay` | `boolean` | `false` |
| `width` | `number` | `800` |
| `height` | `number` | `450` |
| `poster` | `string` | — |

### AudioPlayer Props

| Prop | 类型 | 默认值 |
|------|------|--------|
| `src` | `string` | 必填 |
| `autoplay` | `boolean` | `false` |

## 工作原理

```
App.vue（选择 src）
  → WasmPlayer.vue（智能路由）
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
  ↓ props: src（duration 由 Input 自动获取）
useMediabunnyPlayer
  ↓ Input + UrlSource（获取视频轨道）
  ↓ CanvasSink（poolSize: 2, fit: 'contain'）
  ↓ 迭代器模式：for await (const { canvas, timestamp } of videoSink.canvases())
  ↓ RAF 循环：检查 nextFrame.timestamp <= currentTime，绘制到 Canvas
<canvas> 渲染
```

mediabunny 的 CanvasSink 内置完整解码管线：
- 自动管理 VideoDecoder 队列
- 处理 B-frame 排序（Safari 特殊处理）
- 跳过 RASL 帧（HEVC）
- 智能预取与 LRU 缓存
- Canvas 池复用（零拷贝）

音频通过 `extractAudioToNative` 将编码包重封装为 ADTS 容器，生成 blob URL 挂载到原生 `<audio>` 元素，以 `audioRef.currentTime` 作为视频帧渲染的时钟源，保证音视频同步。

## 项目结构

```
src/
├── components/
│   ├── WasmPlayer.vue        # 智能路由入口（推荐使用）
│   ├── VideoPlayer.vue       # H.264 原生视频渲染
│   ├── AudioPlayer.vue       # 音频播放
│   ├── StreamingPlayer.vue   # H.265/HEVC Canvas 渲染
│   └── PlayerControls.vue    # 公共控件（播放/进度/音量）
├── shared/
│   ├── probeMedia.ts         # mediabunny Input 主线程 probe
│   ├── types.ts              # ProbeResult、PlaybackDecision 等核心类型
│   ├── mediaProbe.ts         # 扩展名快判
│   ├── playbackDecision.ts   # 播放决策逻辑
│   └── probeFallback.ts      # probe 失败时按扩展名猜测
└── composables/
    ├── useMediabunnyPlayer.ts    # mediabunny 播放器核心逻辑（RAF 循环、时间管理、seeking）
    └── extractAudioToNative.ts   # 音频提取工具：将音频轨道封装为 ADTS blob URL
```

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

- Chrome / Edge 94+
- Safari 16.4+
- Firefox 不支持 H.264/HEVC 编码（WebCodecs 部分实现）

## 测试

```bash
npm run test
```

覆盖范围：

- `src/shared/` 的决策函数与兜底逻辑

mediabunny 解码能力只能在真实浏览器中回归，建议搭配 Playwright 做冒烟测试（尚未配置）。

## 许可证

MIT
