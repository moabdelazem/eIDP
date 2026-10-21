import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: {
        /*
         * The libraries every page loads, in a chunk of their own: a deploy
         * that changes only the portal's code leaves this file's hash — and
         * every browser's cached copy — as it was. Only libraries the first
         * page already needs: a group catching all of node_modules would pull
         * the lazy ones (charts, Shiki, React Flow) into the first load.
         */
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/, priority: 20 },
            { name: 'vendor', test: /node_modules[\\/](@tanstack[\\/]|next-themes|sonner)/, priority: 10 },
          ],
        },
      },
    },
  },
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
