import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/main/index.ts',
    control: 'src/preload/control.ts',
  },
  outDir: 'dist/main',
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  sourcemap: false,
  clean: true,
  external: ['electron'],
  noExternal: ['@voidr/capture-contracts', '@voidr/capture-kernel'],
});
