import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import dts from 'vite-plugin-dts'
import { resolve } from 'path'

const isLibBuild = process.env.BUILD_MODE === 'lib'

// WebCodecs 依赖 SharedArrayBuffer，浏览器启用它需要 cross-origin isolated 环境。
// Worker 使用 ES module 格式（type: 'module'）以支持 Mediabunny 的动态 import。
export default defineConfig({
  plugins: [
    vue(),
    ...(isLibBuild
      ? [
          dts({
            include: [
              'src/index.ts',
              'src/components/**/*.vue',
              'src/composables/**/*.ts',
              'src/shared/**/*.ts',
            ],
            exclude: ['src/main.ts', 'src/App.vue', 'src/**/*.test.ts'],
            tsconfigPath: './tsconfig.lib.json',
          }),
        ]
      : []),
  ],
  worker: {
    format: 'es',
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  ...(isLibBuild && {
    build: {
      lib: {
        entry: resolve(__dirname, 'src/index.ts'),
        name: 'WasmPlayer',
        formats: ['es'],
        fileName: () => 'index.js',
      },
      rollupOptions: {
        external: ['vue', 'mediabunny'],
        output: {
          assetFileNames: (assetInfo) =>
            assetInfo.name === 'style.css' ? 'player.css' : (assetInfo.name ?? 'asset'),
          globals: { vue: 'Vue', mediabunny: 'Mediabunny' },
        },
      },
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: true,
    },
  }),
})
