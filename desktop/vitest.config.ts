import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@voidr/capture-contracts': path.join(directory, '../packages/capture-contracts/src/index.ts'),
      '@voidr/capture-kernel': path.join(directory, '../packages/capture-kernel/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
