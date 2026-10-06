import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// Read the same root .env file as Express so the proxy follows PORT changes.
const rootDirectory = fileURLToPath(new URL('../', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDirectory, 'PORT');
  const serverPort = process.env.PORT || env.PORT || '3001';

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': `http://127.0.0.1:${serverPort}`,
      },
    },
  };
});
