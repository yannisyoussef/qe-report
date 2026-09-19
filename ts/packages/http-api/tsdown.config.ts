import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/bin/server.ts', 'src/bin/admin.ts'],
  format: ['esm'],
  dts: true,
  platform: 'node',
  target: 'node22',
  clean: true,
  fixedExtension: false,
});
