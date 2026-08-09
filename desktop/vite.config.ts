import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    {
      name: 'voidr-capture-csp',
      transformIndexHtml(html) {
        const stylePolicy = command === 'serve' ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'";
        return html.replace('__VOIDR_STYLE_POLICY__', stylePolicy);
      },
    },
  ],
  root: path.join(directory, 'src/renderer'),
  publicDir: path.join(directory, '../assets'),
  base: './',
  build: {
    outDir: path.join(directory, 'dist/renderer'),
    emptyOutDir: true,
  },
  resolve: {
    alias: [
      {
        find: '@voidr/capture-design-system/styles.css',
        replacement: path.join(directory, '../packages/capture-design-system/src/styles.css'),
      },
      { find: /^@voidr\/capture-contracts$/, replacement: path.join(directory, '../packages/capture-contracts/src/index.ts') },
      { find: /^@voidr\/capture-kernel$/, replacement: path.join(directory, '../packages/capture-kernel/src/index.ts') },
      { find: /^@voidr\/capture-presentation$/, replacement: path.join(directory, '../packages/capture-presentation/src/index.ts') },
      { find: /^@voidr\/capture-design-system$/, replacement: path.join(directory, '../packages/capture-design-system/src/index.tsx') },
    ],
  },
}));
