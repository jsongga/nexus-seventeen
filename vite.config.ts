import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { sharedContractAlias } from './tooling/aliases';
import { boardProxySecurityPlugin, createBoardProxy } from './tooling/vite-security';

export default defineConfig(() => {
  const humanToken = process.env.STEWARD_TASK_BOARD_HUMAN_TOKEN?.trim();
  return {
    plugins: [boardProxySecurityPlugin(), react(), tailwindcss()],
    resolve: { alias: sharedContractAlias },
    server: {
      host: '127.0.0.1',
      port: 4173,
      proxy: {
        '/board-api': createBoardProxy(humanToken),
      },
    },
    preview: {
      host: '127.0.0.1',
      port: 4173,
      proxy: {
        '/board-api': createBoardProxy(humanToken),
      },
    },
  };
});
