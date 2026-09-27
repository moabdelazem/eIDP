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
    // Bind every interface so the dev server is reachable from outside the
    // machine, or from the host when it runs in a container.
    host: true,
    // Accept any Host header. Vite otherwise refuses names it does not
    // recognise, which blocks reaching this by VM hostname. That check is
    // DNS-rebinding protection, so this is a development-only setting.
    allowedHosts: true,
    // Bind-mounted source does not always deliver inotify events. Set
    // VITE_POLLING=1 if edits stop triggering a reload.
    watch: process.env.VITE_POLLING ? { usePolling: true, interval: 300 } : undefined,
    proxy: { '/api': { target: 'http://localhost:3000', rewrite: (p) => p.replace(/^\/api/, '') } },
  },
})
