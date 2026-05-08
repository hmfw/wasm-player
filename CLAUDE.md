# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 提供在此仓库中工作的指引。

## 常用命令

```bash
npm run dev       # 启动 Vite 开发服务器
npm run build     # 类型检查（vue-tsc）后构建
npm run preview   # 预览生产构建
npm run test      # 运行 vitest 单元测试（src/**/*.{test,spec}.ts）
npm run lint      # ESLint 检查
npm run format    # Prettier 格式化 src/
```

## 架构

这是一个基于 Vue 3 + TypeScript 的媒体播放器，支持 H.264、H.265/HEVC 视频和 MP3 等音频格式。核心挑战：浏览器不原生支持 H.265/HEVC，因此应用通过 FFmpeg WASM 在 Web Worker 中进行 probe（格式探测）和转码。

**播放决策流程：**

```
App.vue（选择 src）
  → WasmPlayer.vue（智能路由）
      → detectMediaType()        扩展名快判（音频直接路由）
      → lightProbeMP4()          轻量级 MP4 二进制 probe（无 WASM，H.264 到此结束）
      → probeMediaBySrc()        FFmpeg probe 兜底（非 MP4 或 moov 不在头部时）
      → resolveCodecPlayback()   按 codec feature 决策
          h264 → native（不加载 WASM）
          h265/hevc → loadFFmpeg() + StreamingPlayer（MSE 分段流式转码）
          mp3/audio → native
      → VideoPlayer.vue          视频渲染
      → AudioPlayer.vue          音频渲染
      → StreamingPlayer.vue      所有需转码的视频，MSE 分段流式转码
```

所有 `transcode` 路径统一走 StreamingPlayer（MSE 分段流式），不再区分时长。按 20s 切片边转边播，首段完成即可开始播放，峰值内存与视频时长无关。

**WASM 懒加载策略：** H.264 MP4 用户完全不加载 32MB WASM。`lightProbeMP4` 解析 MP4 box 结构识别 codec，成功则跳过 FFmpeg；`loadFFmpeg()` 推迟到确认需要转码时才调用。非 MP4 格式（MKV、FLV 等）或 moov 不在文件头部时，回退到 FFmpeg probe。

**各层职责：**

- `src/components/WasmPlayer.vue` — 统一入口，负责 probe、转码决策、路由到子播放器；在入口处对 `props.src` 做协议白名单（http/https/blob/data）
- `src/components/VideoPlayer.vue` — 纯视频渲染组件，仅接受 `src`，不含格式识别逻辑
- `src/components/AudioPlayer.vue` — 音频播放组件，仅接受 `src`
- `src/components/StreamingPlayer.vue` — 所有需转码视频的播放器：UI 绑定层，组合 `useMediaSourcePipeline` 与 `useSegmentScheduler`；展示失败段提示
- `src/components/PlayerControls.vue` — 公共控件组件（播放/暂停/重播按钮、进度条、时间显示、音量），纯展示，props in / emits out，被三个播放器组件共用
- `src/shared/` — 公共类型（`ProbeResult`、`PlaybackDecision`）、媒体类型判断、播放决策、probe 失败兜底、Worker 通信协议（`workerProtocol.ts`）、FFmpeg 日志解析（`probeLogParser.ts`）、轻量级 MP4 二进制 probe（`lightProbe.ts`）
- `src/composables/useFFmpeg.ts` — 管理 Worker 生命周期（模块级单例，懒加载），暴露 `loadFFmpeg()`、`probeMediaBySrc()`、`transcodeSegmentBySrc()`、`terminate()`；内部用 requestId 协议精确路由并发请求，按消息类型分别超时；WasmPlayer 在切换视频时调用 `terminate()` 显式停止 Worker
- `src/composables/useMediaSourcePipeline.ts` — MSE 管线 composable：`attach` / `enqueue` / `removeBefore` / `endOfStream` / `destroy` / `isReady`，封装 `updateend` 驱动的 append/remove 互斥状态机
- `src/composables/useSegmentScheduler.ts` — 分段转码调度 composable：按 20s 切片，单段最多 3 次尝试指数退避重试；失败段继续下一段，累计超 1/3 时触发 `onFatal`
- `src/workers/ffmpeg.worker.ts` — 在 Worker 线程中运行 FFmpeg；支持 `load`、`probe`、`transcode-segment` 三种消息；core 通过 Vite 的 `?url` 后缀从本地依赖 `@ffmpeg/core` 导出并打包到 `dist/assets/`；分段转码使用 `libx264 -preset ultrafast -crf 23 -movflags frag_keyframe+empty_moov+default_base_moof` 产出 fMP4；统一响应格式 `{type:'result'|'error', requestId, payload}`
- `src/utils/memory.ts` — 用于帧淘汰的 `FrameBuffer` 类（尚未接入主播放流程）

## StreamingPlayer 的关键约束

- MSE 管线状态机封装在 `useMediaSourcePipeline` 内：SourceBuffer 的 `appendBuffer` / `remove` 必须在 `updateend` 后才能再次操作，composable 内部用 `isAppending` / `isRemoving` 互斥
- MSE codec 字符串 `avc1.42E01E, mp4a.40.2` 与 Worker 端转码参数（`libx264` + `aac`）强耦合，任一侧改动必须同步
- Worker 端 `-g 30` 保证每段起点都是关键帧；`-avoid_negative_ts make_zero` 让每段时间戳从 0 开始，由 composable 通过 `sourceBuffer.timestampOffset` 平移到全局时间线
- 组件卸载时 `scheduler.cancel()` 与 `pipeline.destroy()` 协同:scheduler 停止产出新段,pipeline 丢弃在途 `Blob.arrayBuffer()` 的结果并释放 MediaSource

## Worker 通信协议

主线程与 Worker 的消息类型定义在 `src/shared/workerProtocol.ts`,两侧共用:

- 主线程 → Worker:每条消息带 `requestId`(UUID);`{ type, requestId, payload }`
- Worker → 主线程:`{ type:'result'|'error', requestId, payload }` 精确归属;`progress` 也带 requestId;`log` 为全局广播
- `useFFmpeg` 内部维护 `pending: Map<requestId, {resolve, reject, timer}>`,按 id 路由响应。并发请求不会错位 reject
- 超时:probe 30s / transcode 10min / transcode-segment 60s / load 60s;超时后自动 reject 并清理 pending

## 关键 CORS 要求

FFmpeg WASM 需要 `SharedArrayBuffer`，这要求每个响应都带有以下请求头：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

已在 `vite.config.ts` 中配置。任何部署环境都必须复现这些请求头，否则 WASM 将无法加载。

## FFmpeg WASM 已从 Vite 优化中排除

`@ffmpeg/ffmpeg` 和 `@ffmpeg/util` 在 `vite.config.ts` 的 `optimizeDeps.exclude` 中（走 Vite 预构建会破坏 Worker 内的模块解析）。`@ffmpeg/core` 则通过 `?url` 后缀由 Vite 资产流水线处理，产出约 32MB 的 `ffmpeg-core.wasm` 与 114KB 的 `ffmpeg-core.js`，与应用同源加载，避免 COEP 下的跨源阻塞。

## 组件 Props

### WasmPlayer（推荐入口）

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `src` | `string` | 必填 | 媒体 URL |
| `autoplay` | `boolean` | `false` | 自动播放 |
| `width` | `number` | `800` | 宽度（px） |
| `height` | `number` | `450` | 高度（px，仅视频） |
| `poster` | `string` | — | 封面图（仅视频） |

### VideoPlayer

| Prop | 类型 | 默认值 |
|------|------|--------|
| `src` | `string` | 必填 |
| `autoplay` | `boolean` | `false` |
| `width` | `number` | `800` |
| `height` | `number` | `450` |
| `poster` | `string` | — |

### AudioPlayer

| Prop | 类型 | 默认值 |
|------|------|--------|
| `src` | `string` | 必填 |
| `autoplay` | `boolean` | `false` |

### StreamingPlayer

由 WasmPlayer 在所有 `transcode` 分支下自动路由，一般不直接使用。

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `src` | `string` | 必填 | 原始媒体 URL（由 Worker 自行拉取分段） |
| `duration` | `number` | 必填 | 视频总时长（秒），用于计算分段数 |
| `autoplay` | `boolean` | `false` | 自动播放 |
| `width` | `number` | `800` | 宽度（px） |
| `height` | `number` | `450` | 高度（px） |
| `poster` | `string` | — | 封面图 |

## 扩展新格式

在 `src/shared/index.ts` 的 `resolveCodecPlayback` 中添加对应 codec 分支，实现 `resolve<Codec>Playback(result: ProbeResult): PlaybackDecision` 函数即可。如果逻辑复杂，可在 `src/shared/` 下新建独立文件。

## 测试

- 单元测试用 Vitest + happy-dom,覆盖 `src/shared/` 的纯函数、FFmpeg 日志解析的快照回归、`useFFmpeg` 的 sendRequest 协议层(并发不错位、超时、terminate reject-all、load 幂等)、`useSegmentScheduler` 的重试退避与失败阈值
- Worker 通信在测试中通过 `globalThis.Worker = FakeWorker` mock,不启动真实 WASM
- MSE 与 FFmpeg 实际解码能力只能在真实浏览器中回归,建议搭配 Playwright 冒烟
- 新增组件或 composable 时:把纯逻辑抽到 composable 便于单测;DOM/MSE 相关的事件顺序用 stub 测,不做真解码断言
