import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
  resolve: {
    alias: {
      '@frp/schemas': new URL('../schemas/src/index.ts', import.meta.url).pathname,
    },
  },
});
