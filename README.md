# wasm-player

基于 Vue 3 + TypeScript + FFmpeg WASM 的媒体播放器，支持 H.264、H.265/HEVC 视频和 MP3 等音频格式。

## 特性

- H.264 视频原生播放
- H.265/HEVC 视频自动转码后播放（FFmpeg WASM，无需服务端）
- 所有需转码的视频统一走 MSE 分段流式转码，边转边播；单段失败自动指数退避重试，失败段不阻断整体播放
- MP3 等音频格式原生播放，独立音频播放器 UI
- 通过轻量级 MP4 二进制 probe（`lightProbe.ts`）准确识别 mp4 容器内的编解码器（h264 vs h265），无需加载 WASM；非 MP4 格式回退到 FFmpeg probe
- 转码在 Web Worker 中进行,不阻塞主线程;模块级单例 Worker 懒加载,多组件共享避免重复加载 32MB WASM;WasmPlayer 切换视频时显式调用 terminate() 停止转码
- Worker 通信采用 requestId 协议,并发请求按 id 精确路由,不会错位 reject
- URL 入口做协议白名单(http/https/blob/data)
- 按格式分层的架构，易于扩展新格式

## 技术栈

- **Vue 3** — 前端框架
- **Vite** — 构建工具
- **TypeScript** — 类型安全
- **@ffmpeg/ffmpeg** — FFmpeg WASM 库

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
      → lightProbeMP4()          轻量级 MP4 二进制 probe（无 WASM）
      → probeMediaBySrc()        FFmpeg probe 兜底（非 MP4 或 moov 不在头部）
      → resolveCodecPlayback()   按 codec feature 决策
          h264  → native（不加载 WASM）
          h265  → loadFFmpeg() + StreamingPlayer（MSE 分段流式转码）
          audio → native
      → VideoPlayer.vue          视频渲染
      → AudioPlayer.vue          音频渲染
      → StreamingPlayer.vue      所有需转码的视频，MSE 分段流式转码
```

所有 `transcode` 路径统一走 StreamingPlayer：按 20s 分段转码成 fMP4，通过 MediaSource 的 SourceBuffer 依次 append，边转边播，首段完成即可开始播放，峰值内存与视频时长无关。
段内逻辑拆分到两个 composable：`useMediaSourcePipeline` 管 MSE 管线状态机，
`useSegmentScheduler` 管转码调度与重试。单段失败会自动指数退避重试（最多 3 次），
失败段不阻断后续段；累计失败超过 1/3 时才升级为整体 error。

## 项目结构

```
src/
├── components/
│   ├── WasmPlayer.vue        # 智能路由入口(推荐使用)
│   ├── VideoPlayer.vue       # 纯视频渲染
│   ├── AudioPlayer.vue       # 音频播放
│   ├── StreamingPlayer.vue   # 所有需转码视频的 MSE 分段流式播放（UI 绑定层）
│   └── PlayerControls.vue    # 公共控件(播放/进度/音量),被上三者共用
├── shared/                   # 公共类型、媒体判断、播放决策、probe 兜底
│   ├── lightProbe.ts         # 轻量级 MP4 二进制 probe（无 WASM，解析 box 结构）
│   ├── workerProtocol.ts     # Worker 通信协议辨识联合类型(主线程/Worker 共用)
│   └── probeLogParser.ts     # FFmpeg 日志 → ProbeResult 纯函数(带快照测试)
├── composables/
│   ├── useFFmpeg.ts          # FFmpeg Worker 封装:模块级单例懒加载 + requestId 协议
│   ├── useMediaSourcePipeline.ts  # MSE 管线状态机
│   └── useSegmentScheduler.ts     # 分段转码调度 + 重试
├── workers/
│   └── ffmpeg.worker.ts      # FFmpeg WASM Worker
└── utils/
    ├── format.ts             # 旧格式检测(保留兼容)
    ├── decoder.ts            # 旧解码器(保留兼容)
    └── memory.ts             # 帧缓冲(未接入主流程)
```

## 扩展新格式

在 `src/shared/index.ts` 的 `resolveCodecPlayback` 中添加分支，实现对应的 `resolve<Codec>Playback` 函数：

```ts
// src/shared/index.ts — 在 resolveCodecPlayback 中添加：
if (result.videoCodec === 'vp9') {
  return { routeTarget: 'video', mode: 'native', reason: 'vp9 native' }
}
```

## CORS 要求

FFmpeg WASM 依赖 `SharedArrayBuffer`，部署时需要以下响应头：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

开发环境已在 `vite.config.ts` 中配置，生产部署需在服务器或 CDN 侧同步配置。

## 性能说明

- **H.264 MP4 用户不加载 WASM**：`lightProbeMP4` 通过解析 MP4 box 结构识别 codec，H.264 视频全程无 WASM 下载
- FFmpeg core 约 32MB，仅在 H.265 转码时按需加载；建议为 `dist/assets/ffmpeg-core-*.wasm` 开启长期缓存
- 转码在 Web Worker 中运行，不阻塞 UI
- 所有需转码视频统一分段流式转码，首段完成即可开始播放，峰值内存与视频时长无关
- H.265 转码速度取决于视频分辨率和设备性能

## 浏览器兼容性

- Chrome / Edge（最新版）
- Firefox（最新版）
- Safari（最新版，macOS）

## 测试

```bash
npm run test
```

覆盖范围:

- `src/shared/` 的决策函数与兜底
- `lightProbeMP4` 的 MP4 二进制解析（H.264/H.265 识别、fetch 失败、非 MP4、无 moov 等场景）
- FFmpeg 日志解析的快照回归(H.264 / HEVC / MP3),防止 FFmpeg 版本升级悄悄改变日志格式
- `useFFmpeg` 的 sendRequest 协议层:并发请求按 requestId 精确归属、超时、`terminate` reject-all、load 幂等
- `useSegmentScheduler` 的指数退避重试与失败阈值升级

MSE/真实 WASM 解码需要浏览器环境,建议搭配 Playwright 做冒烟测试(尚未配置)。

## 许可证

MIT
