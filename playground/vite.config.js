import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        liveLogs: resolve(__dirname, 'live-logs.html'),
      },
    },
  },
  server: {
    proxy: {
      '/smartflo': {
        target: 'http://localhost:8000',
      },
      '/api': {
        target: 'http://localhost:8000',
      },
      '/admin': {
        target: 'http://localhost:8000',
      },
      '/health': {
        target: 'http://localhost:8000',
      },
      '/metrics': {
        target: 'http://localhost:8000',
      },
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
})