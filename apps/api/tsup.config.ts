import { defineConfig } from 'tsup';

/**
 * The API image also carries the migration and seed entry points, so the
 * container can bring the schema up to date and populate the demo without a
 * TypeScript runtime. Named entries keep the output flat (`dist/index.js`,
 * `dist/migrate.js`, `dist/seed.js`) rather than mirroring the source tree.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    migrate: '../../packages/db/src/scripts/migrate.ts',
    seed: '../../packages/db/src/scripts/seed.ts',
  },
  format: ['esm'],
  target: 'node22',
  clean: true,
  sourcemap: true,
  // Workspace packages are inlined; everything else stays external.
  noExternal: [/^@frp\//],
});
