import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The client lives in client/ and builds to client/dist (served by the Node
// server in production). In dev, Vite serves the client on :5173 and proxies
// the realtime/asset endpoints to the Node server on :5858 (ws: true for the
// WebSocket upgrade paths).
const SERVER = 'http://localhost:5858'

export default defineConfig({
  root: 'client',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/connect': { target: SERVER, ws: true },
      '/control': { target: SERVER, ws: true },
      '/uploads': { target: SERVER },
    },
  },
})
