import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
  resolve: {
    alias: {
      '@frp/schemas': new URL('../schemas/src/index.ts', import.meta.url).pathname,
      '@frp/scoring': new URL('../scoring/src/index.ts', import.meta.url).pathname,
      '@frp/config': new URL('../config/src/index.ts', import.meta.url).pathname,
      '@frp/core': new URL('../core/src/index.ts', import.meta.url).pathname,
    },
  },
});
