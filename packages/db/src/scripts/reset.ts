import { env } from '@frp/config';
import { sql } from 'drizzle-orm';
import { createDb } from '../client.js';

/**
 * Drops and recreates the public schema. Development convenience only — it is
 * intentionally noisy and refuses to run when NODE_ENV is production.
 */
async function main(): Promise<void> {
  if (env().NODE_ENV === 'production') {
    throw new Error('refusing to reset the database with NODE_ENV=production');
  }
  const { db, close } = createDb(env().DATABASE_URL);
  try {
    console.log('[reset] dropping schema public');
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`create schema public`);

    // Drizzle records applied migrations in its own schema. Dropping only
    // `public` would leave the journal intact, so the next `db:migrate` would
    // be a silent no-op against an empty database.
    console.log('[reset] dropping migration journal');
    await db.execute(sql`drop schema if exists drizzle cascade`);

    console.log('[reset] done — run `pnpm db:migrate` next');
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error('[reset] failed:', error);
  process.exit(1);
});
