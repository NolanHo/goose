import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// The renderer source lives in the desktop package; import it directly.
const desktopSrc = fileURLToPath(new URL('../desktop/src/', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      // The renderer only imports types (IpcRendererEvent) from 'electron';
      // any runtime leak is stubbed out so the web bundle builds clean.
      electron: fileURLToPath(new URL('./src/electron-stub.ts', import.meta.url)),
      'electron-log': fileURLToPath(new URL('./src/electron-stub.ts', import.meta.url)),
    },
  },

  define: {
    'process.env.GOOSE_TUNNEL': JSON.stringify(false),
  },

  server: {
    port: 39248,
    host: '0.0.0.0',
    strictPort: true,
    // Allow access via reverse proxy / custom hostnames (e.g. goose.apeiria.cn).
    allowedHosts: true,
    // Proxy routes to goosed (:39247) and the ACP gateway (:39249).
    //   /acp    — WebSocket through the gateway (persistent ACP client).
    //   /health, /status — plain HTTP, no token required by goosed.
    proxy: {
      '/acp': { target: 'ws://localhost:39249', ws: true },
      '/health': 'http://localhost:39247',
      '/status': 'http://localhost:39247',
    },
  },

  optimizeDeps: {
    // Mirrors desktop: keep the SDK fresh in dev.
    exclude: ['@aaif/goose-sdk'],
  },

  build: {
    target: 'esnext',
    outDir: 'dist',
  },
});
