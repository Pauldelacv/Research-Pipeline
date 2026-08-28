import { env } from '@frp/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let database: Database | undefined;

export function createPool(connectionString = env().DATABASE_URL): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

/** Process-wide connection pool. Applications close it on shutdown. */
export function db(): Database {
  if (!database) {
    pool = createPool();
    database = drizzle(pool, { schema });
  }
  return database;
}

export function getPool(): pg.Pool | undefined {
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  database = undefined;
}

/** Builds an isolated database handle — used by scripts and integration tests. */
export function createDb(connectionString: string): { db: Database; close: () => Promise<void> } {
  const localPool = createPool(connectionString);
  return {
    db: drizzle(localPool, { schema }),
    close: () => localPool.end(),
  };
}

export { schema };
