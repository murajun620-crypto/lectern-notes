import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH || './',
  build: {
    target: 'safari16.4',
    rollupOptions: {
      output: {
        manualChunks: {
          'pdf-render': ['pdfjs-dist'],
          'pdf-export': ['pdf-lib'],
          'react-vendor': ['react', 'react-dom'],
          backup: ['jszip'],
        },
      },
    },
  },
});
