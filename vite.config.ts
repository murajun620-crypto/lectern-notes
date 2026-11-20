import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const version =
  process.env.GITHUB_SHA?.slice(0, 12) ||
  (() => {
    try {
      return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      return 'development';
    }
  })();
const manifest = JSON.stringify({ version, builtAt: new Date().toISOString() });
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'lectern-version',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: manifest });
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split('?')[0].endsWith('/version.json')) {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(manifest);
          } else next();
        });
      },
    },
  ],
  define: { __APP_VERSION__: JSON.stringify(version) },
  base: process.env.VITE_BASE_PATH || './',
  build: {
    target: 'safari16.4',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        oneDriveRedirect: fileURLToPath(new URL('./onedrive-redirect.html', import.meta.url)),
      },
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
