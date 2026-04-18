import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    minify: 'esbuild',
    cssMinify: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'qr-scanner': ['html5-qrcode'],
          'pdf': ['pdfjs-dist'],
        },
      },
    },
  },
  optimizeDeps: {
    include: ['html5-qrcode'],
  },
})
