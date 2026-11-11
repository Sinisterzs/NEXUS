import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';

// No project .env files and no private workspace data over the dev HTTP server.
export default mergeConfig(base, defineConfig({
  envDir: '.nexus-lab/frontend-env',
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    hmr: { host: '127.0.0.1', port: 1420 },
    fs: { deny: [
      '**/.env', '**/.env.*', '**/*.{crt,pem}', '**/.git/**',
      '**/.nexus-lab/**', '**/.postgres/**', '**/postgres/**', '**/pg_data/**',
      '**/nexus-server/**', '**/src-tauri/**', '**/*.db*', '**/*.sqlite*',
      '**/nexus.config.json', '**/backups/**', '**/*.pk8', '**/*.key',
    ] },
    watch: { ignored: ['**/.nexus-lab/**', '**/.postgres/**', '**/src-tauri/**'] },
  },
}));
