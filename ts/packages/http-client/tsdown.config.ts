import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/bin/upload.ts'],
  format: ['esm'],
  dts: true,
  platform: 'node',
  target: 'node22',
  clean: true,
  fixedExtension: false,
});
