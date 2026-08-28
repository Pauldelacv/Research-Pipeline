import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { env } from '@frp/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from '../client.js';

/**
 * Applies pending SQL migrations. Safe to run on every boot: Drizzle records
 * applied migrations in `__drizzle_migrations` and skips them.
 */
// Overridable because the bundled build lands at a different depth than the
// TypeScript source; the container sets it explicitly.
const migrationsFolder =
  process.env.DRIZZLE_MIGRATIONS_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

async function main(): Promise<void> {
  const url = env().DATABASE_URL;
  const { db, close } = createDb(url);
  const redacted = url.replace(/\/\/([^:]+):[^@]*@/, '//$1:***@');
  console.log(`[migrate] applying migrations from ${migrationsFolder} to ${redacted}`);
  try {
    await migrate(db, { migrationsFolder });
    console.log('[migrate] done');
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error('[migrate] failed:', error);
  process.exit(1);
});
