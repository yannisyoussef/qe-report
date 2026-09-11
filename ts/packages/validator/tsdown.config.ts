import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  platform: 'node',
  target: 'node22',
  clean: true,
  fixedExtension: false,
});
