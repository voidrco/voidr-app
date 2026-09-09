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
  define: {
    'process.env.VOIDR_CAPTURE_APPLE_SIGNED': JSON.stringify(process.env.VOIDR_PUBLIC_RELEASE === '1' && Boolean(process.env.APPLE_CODESIGN_IDENTITY) ? 'true' : 'false'),
    'process.env.VOIDR_CAPTURE_RELEASE_CHANNEL': JSON.stringify(process.env.VITE_VOIDR_CAPTURE_CHANNEL || 'production'),
  },
  noExternal: ['@voidr/capture-contracts', '@voidr/capture-kernel'],
});
