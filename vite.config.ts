import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// FFmpeg WASM 依赖 SharedArrayBuffer（多线程与大文件 IO），浏览器启用它需要 cross-origin
// isolated 环境，即响应头同时带 COOP=same-origin 与 COEP=require-corp。任何部署都必须
// 复现下列 headers，否则 Worker 加载 WASM 会直接失败。
//
// 另外 @ffmpeg/ffmpeg 与 @ffmpeg/util 被排除在 Vite 预构建之外：它们的 ~30MB WASM core
// 在运行时由 Worker 从 CDN 按需加载，走 Vite 依赖优化反而会破坏 Worker 内的模块解析。
export default defineConfig({
  plugins: [vue()],
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util']
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  }
})
