import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  const humanToken = process.env.STEWARD_TASK_BOARD_HUMAN_TOKEN?.trim();
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: '0.0.0.0',
      port: 4173,
      proxy: {
        '/board-api': {
          target: 'http://127.0.0.1:4318',
          changeOrigin: false,
          headers: humanToken ? { authorization: `Bearer ${humanToken}` } : undefined,
          rewrite: (path: string) => path.replace(/^\/board-api/, ''),
          configure(proxy) {
            proxy.on('proxyReq', (request) => request.removeHeader('origin'));
          },
        },
      },
    },
    preview: {
      host: '0.0.0.0',
      port: 4173,
      proxy: {
        '/board-api': {
          target: 'http://127.0.0.1:4318',
          changeOrigin: false,
          headers: humanToken ? { authorization: `Bearer ${humanToken}` } : undefined,
          rewrite: (path: string) => path.replace(/^\/board-api/, ''),
          configure(proxy) {
            proxy.on('proxyReq', (request) => request.removeHeader('origin'));
          },
        },
      },
    },
  };
});
