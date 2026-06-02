import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev server on 5173 to match the root test:e2e:local base URL. The SPA's
// relative `/trpc` (tRPC) + `/api` (health/version) calls are proxied to the
// api dev server on :3000 in dev + E2E; same-origin in prod (behind CF Access).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/trpc': { target: 'http://localhost:3000', changeOrigin: true },
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist' },
})
