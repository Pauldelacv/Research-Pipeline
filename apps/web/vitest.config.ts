import { defineConfig } from 'vitest/config';

/**
 * Unit tests only. The Playwright specs under `e2e/` need a running stack and
 * are driven by `pnpm test:e2e`, so vitest must not try to collect them.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
  },
});
