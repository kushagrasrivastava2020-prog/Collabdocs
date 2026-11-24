import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API = process.env.API_URL ?? 'http://localhost:4000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin in dev: the session cookie and the WebSocket upgrade both go through the proxy.
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/ws': { target: API.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
})
