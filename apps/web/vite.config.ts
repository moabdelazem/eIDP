import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // In a container the dev server has to bind every interface to be
    // reachable from the host; locally it stays on localhost.
    host: process.env.VITE_HOST ?? 'localhost',
    // Bind-mounted source does not always deliver inotify events. Set
    // VITE_POLLING=1 if edits stop triggering a reload.
    watch: process.env.VITE_POLLING ? { usePolling: true, interval: 300 } : undefined,
    proxy: { '/api': { target: 'http://localhost:3000', rewrite: (p) => p.replace(/^\/api/, '') } },
  },
})
