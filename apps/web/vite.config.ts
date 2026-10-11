import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Where the API / Socket.IO server runs during `npm run dev`.
const target = process.env.VITE_API_TARGET ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5180),
    strictPort: true,
    proxy: {
      '/api': target,
      '/health': target,
      '/socket.io': { target, ws: true },
    },
  },
  preview: { port: Number(process.env.WEB_PORT ?? 5180) },
});
