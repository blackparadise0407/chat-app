import { defineConfig } from 'vite';
export default defineConfig({
  root: 'client',
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
});
