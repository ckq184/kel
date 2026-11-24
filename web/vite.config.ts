import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 端口隔离（dual-desktop-port-isolation）：本仓 dev 端口 5174/后端 3001，
// 与 Personnal-agent-main 的 5173/3000 并存，两仓网页服务可同时运行。
const API_PROXY_TARGET =
  process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3001';
const WS_PROXY_TARGET =
  process.env.VITE_WS_PROXY_TARGET || 'ws://127.0.0.1:3001';

const APP_BASE = (() => {
  const raw = (process.env.VITE_BASE_PATH || '/').trim();
  if (!raw) return '/';
  let base = raw;
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.endsWith('/')) base = `${base}/`;
  return base;
})();

export default defineConfig({
  base: APP_BASE,
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    host: '0.0.0.0',
    strictPort: true,
    allowedHosts: true,
    hmr: {
      // VS Code Remote port forwarding requires explicit HMR client config
      clientPort: 5174,
    },
    proxy: {
      '/api': API_PROXY_TARGET,
      '/ws': {
        target: WS_PROXY_TARGET,
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
  },
});
