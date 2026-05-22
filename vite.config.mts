import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function privateNetworkAccess(): Plugin {
  return {
    name: 'private-network-access',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Private-Network', 'true');
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), privateNetworkAccess()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
    passWithNoTests: true,
  },
  base: '',
  build: {
    outDir: 'build',
  },
  server: {
    host: 'localhost',
    port: 3000,
  },
});
