import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Sensible code splitting: heavy feature libraries get their own
        // cached chunks instead of one ~790 kB monolithic bundle.
        manualChunks: {
          react: ['react', 'react-dom'],
          motion: ['framer-motion'],
          markdown: ['react-markdown'],
          xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links'],
          icons: ['react-icons'],
        },
      },
    },
  },
})