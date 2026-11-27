import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { readProductionVisitorConfig } from './src/visitor-config.ts';

export default defineConfig(({ command, mode }) => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  if (command === 'build') readProductionVisitorConfig(loadEnv(mode, root, 'VITE_NATCUT_'));
  return {
    publicDir: fileURLToPath(new URL('../../packages/render/catalog/artwork/', import.meta.url)),
    plugins: [react()],
    envPrefix: 'VITE_NATCUT_',
  };
});
