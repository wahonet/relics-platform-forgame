import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';
import path from 'node:path';

// 开发期（`npm run dev`）：
//   - base = '/'，访问 http://127.0.0.1:5173/ 直接进 SPA
//   - 代理 /api /admin/ /tiles /static 到 FastAPI 8000，cookie 同源
//   - 注意：代理规则故意写成 /admin/（带斜杠），否则 /admin-ui/ 这类路径会被误命中
// 生产期（`npm run build`）：
//   - base = '/admin-ui/'，让 vite 构建出的 asset 引用指向正确 URL
//   - FastAPI 检测到 dist/ 存在会自动挂到 /admin-ui/
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/admin-ui/' : '/',
  plugins: [
    vue(),
    AutoImport({
      resolvers: [ElementPlusResolver()],
      imports: ['vue', 'vue-router', 'pinia'],
      dts: 'src/auto-imports.d.ts',
    }),
    Components({
      resolvers: [ElementPlusResolver()],
      dts: 'src/components.d.ts',
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      // 所有后台接口都是 /api/* 前缀（含 /api/admin/...），一条规则够用
      '/api':    { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/tiles':  { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/static': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      // 静态目录（照片/图纸/边界/PDF/3D 模型），后端 StaticFiles 直接挂载
      '/photos':       { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/drawings':     { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/boundaries':   { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/worklog-pdfs': { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/3d':           { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/pdfs':         { target: 'http://127.0.0.1:8000', changeOrigin: true },
      '/survey-photos':{ target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          'element-plus': ['element-plus', '@element-plus/icons-vue'],
          'echarts': ['echarts', 'vue-echarts'],
        },
      },
    },
  },
}));
