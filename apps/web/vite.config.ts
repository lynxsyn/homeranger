import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Minimal M1 scaffold config. The real SPA (router, tRPC client, ListingsPage)
// lands in M3. Dev server on 5173 to match the root test:e2e:local base URL.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
  build: { outDir: 'dist' },
})
