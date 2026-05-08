import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// WebCodecs 依赖 SharedArrayBuffer，浏览器启用它需要 cross-origin isolated 环境。
// Worker 使用 ES module 格式（type: 'module'）以支持 Mediabunny 的动态 import。
export default defineConfig({
  plugins: [vue()],
  worker: {
    format: 'es',
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
