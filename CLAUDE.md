# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 提供在此仓库中工作的指引。

## 目录结构

```
src/
├── components/
│   ├── WasmPlayer.vue            # 统一入口：probe → 决策 → 路由子播放器；协议白名单
│   ├── StreamingPlayer.vue       # H.265/HEVC 播放器，使用 mediabunny CanvasSink 渲染到 Canvas
│   ├── VideoPlayer.vue           # 原生视频渲染（H.264），纯展示
│   ├── AudioPlayer.vue           # 原生音频渲染，纯展示
│   └── PlayerControls.vue        # 公共控件（播放/暂停/进度/音量），props in / emits out
├── composables/
│   └── useMediabunnyPlayer.ts    # mediabunny 播放器核心：Input + CanvasSink + RAF 循环 + 时间管理
├── shared/
│   ├── types.ts                  # ProbeResult / PlaybackDecision / PlaybackMode / MediaType
│   ├── index.ts                  # resolveCodecPlayback()（播放决策入口，re-export 所有 shared）
│   ├── playbackDecision.ts       # decidePlayback()（codec → PlaybackDecision 映射）
│   ├── mediaProbe.ts             # detectMediaType()（扩展名快判）
│   ├── probeMedia.ts             # probeMediaBySrc()（主线程 mediabunny MP4 probe）
│   └── probeFallback.ts          # fallbackMediaProbe() / fallbackH264Probe()（probe 失败兜底）
```

## 任务导航

| 如果你要… | 去看这里 |
|-----------|---------|
| 修改播放决策逻辑（哪种 codec 走哪条路） | `src/shared/playbackDecision.ts` → `decidePlayback()` 和 `src/shared/index.ts` → `resolveCodecPlayback()` |
| 新增支持的格式 | `src/shared/index.ts` → `resolveCodecPlayback()` 加 codec 分支；复杂逻辑在 `src/shared/` 新建文件 |
| 修改 probe 策略（如何识别媒体类型） | `src/shared/probeMedia.ts`（主线程 MP4 probe）、`src/shared/probeFallback.ts`（兜底）、`src/shared/mediaProbe.ts`（扩展名快判） |
| 修改 H.265 播放器渲染逻辑 | `src/composables/useMediabunnyPlayer.ts`（RAF 循环、时间管理、seeking） |
| 修改播放器 UI / 控件 | `src/components/PlayerControls.vue`（公共控件）；各播放器组件负责自己的布局 |
| 添加单元测试 | `src/shared/shared.test.ts`（播放决策逻辑）、`src/composables/useMediabunnyPlayer.test.ts`（播放器逻辑） |

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

Vue 3 + TypeScript 媒体播放器，支持 H.264、H.265/HEVC 视频和 MP3 等音频。核心挑战：浏览器不原生支持 H.265/HEVC，通过 mediabunny CanvasSink 直接解码渲染到 Canvas。

**播放决策流程：**

```
App.vue（选择 src）
  → WasmPlayer.vue（智能路由）
      → detectMediaType()        扩展名快判（音频直接路由）
      → probeMediaBySrc()        mediabunny Input 主线程 probe
      → resolveCodecPlayback()   按 codec feature 决策
          h264 → native          → VideoPlayer.vue（<video> 原生播放）
          h265/hevc → transcode  → StreamingPlayer.vue（Canvas 渲染）
          mp3/audio → native     → AudioPlayer.vue（<audio> 原生播放）
```

**probe 策略：** `probeMediaBySrc` 用 mediabunny `Input` + `UrlSource` 直接在主线程解析 MP4 元数据，无需 Worker 往返。非 MP4 格式（MKV、FLV 等）probe 失败时回退到 `fallbackMediaProbe`（按扩展名猜测）。

## StreamingPlayer 架构

使用 mediabunny 的 CanvasSink API 直接解码 H.265/HEVC 视频并渲染到 Canvas：

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

**关键特性：**
- **自动解码管线**：mediabunny 内置 VideoDecoder 队列管理、B-frame 排序、RASL 帧跳过
- **智能预取**：LRU 缓存 + 网络优化预取策略
- **Canvas 池复用**：零拷贝，减少内存分配
- **时间同步**：使用 `performance.now()` 作为时钟源，asyncId 机制防止 seek 竞态
- **浏览器兼容**：内置 Safari/Chrome 兼容性修复

## 组件 Props

### WasmPlayer（推荐入口）

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `src` | `string` | 必填 | 媒体 URL（支持 http/https/blob/data） |
| `autoplay` | `boolean` | `false` | 自动播放 |
| `width` | `number` | `800` | 宽度（px） |
| `height` | `number` | `450` | 高度（px，仅视频） |
| `poster` | `string` | — | 封面图（仅视频） |

### VideoPlayer / AudioPlayer

VideoPlayer 同 WasmPlayer props（含 `height` / `poster`）。AudioPlayer 仅 `src` + `autoplay`。

### StreamingPlayer

由 WasmPlayer 在所有 `transcode` 分支下自动路由，一般不直接使用。

| Prop | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `src` | `string` | 必填 | 原始媒体 URL |
| `autoplay` | `boolean` | `false` | 自动播放 |
| `width` | `number` | `800` | 宽度（px） |
| `height` | `number` | `450` | 高度（px） |
| `poster` | `string` | — | 封面图 |

## 测试

- 单元测试：Vitest + happy-dom，覆盖 `src/shared/` 纯函数（播放决策逻辑）
- mediabunny 解码能力只能在真实浏览器中回归，建议搭配 Playwright 冒烟
- 新增组件或 composable 时：把纯逻辑抽到 composable 便于单测；DOM 相关事件顺序用 stub 测，不做真解码断言
