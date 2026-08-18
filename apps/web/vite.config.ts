// `vitest/config` rather than `vite` — the same defineConfig, but with the `test` block
// in its type. Importing from 'vite' typechecks everything except the test options,
// which then fail silently at the type level.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Tailwind v4's Vite plugin, not a PostCSS config. v4 ships a first-party Vite
  // integration that is faster and needs no postcss.config.js.
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The API is a separate origin in development. Proxying rather than enabling CORS
    // means the browser sees one origin, so cookies and same-origin assumptions behave
    // exactly as they will in production behind a single ingress.
    proxy: {
      '/v1': { target: 'http://localhost:3000', changeOrigin: true },
      '/graphql': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
