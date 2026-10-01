import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.API_TARGET || 'http://127.0.0.1:8787';

export default defineConfig({
  root: 'client',
  publicDir: 'public',
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    cssCodeSplit: false,
    target: 'es2020',
    rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom', 'react-router-dom'] } } },
  },
  plugins: [react()],
  server: {
    port: Number(process.env.PORT_WEB || 5173),
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
      '/health': { target: API_TARGET, changeOrigin: false },
      '/sitemap.xml': { target: API_TARGET, changeOrigin: false },
      '/llms.txt': { target: API_TARGET, changeOrigin: false },
      '/llms-full.txt': { target: API_TARGET, changeOrigin: false },
      '^/wa(?:\\?|$)': { target: API_TARGET, changeOrigin: false },
      '^/tel(?:\\?|$)': { target: API_TARGET, changeOrigin: false },
      '/robots.txt': { target: API_TARGET, changeOrigin: false },
      '/media': { target: API_TARGET, changeOrigin: false },
      '/uploads': { target: API_TARGET, changeOrigin: false },
      '/manifest.webmanifest': { target: API_TARGET, changeOrigin: false },
      '/healthz': { target: API_TARGET, changeOrigin: false },
    },
  },
  preview: { port: Number(process.env.PORT_WEB || 5173), host: '0.0.0.0', allowedHosts: true },
});
