import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

// The client builds to client/dist, which server/index.mjs serves. In development, `npm run dev`
// proxies /api to the server on 127.0.0.1:8787 (start it with `npm start`).
export default defineConfig({
  root: here,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:8787' } },
});
