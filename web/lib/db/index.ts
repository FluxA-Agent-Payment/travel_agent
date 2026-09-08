import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Pool } from 'pg';

/**
 * The database connection.
 *
 * One pool per module graph. Next compiles route handlers separately, so
 * "one pool per process" is not something this can promise — each graph gets
 * its own, and the pool sizes below are set with that in mind rather than
 * assuming a single shared pool.
 *
 * Everything the app persists lives here now: accounts, sessions, saved
 * travellers, and the record of what has been paid for. That last one is the
 * reason this exists at all — it was a file on container disk, which does not
 * survive a redeploy and is not shared between instances, so the guard against
 * charging somebody twice was missing in precisely the conditions that create
 * the risk.
 */

let pool: Pool | null = null;
let ready: Promise<void> | null = null;

export function databaseUrl(): string | null {
  return process.env.DATABASE_URL?.trim() || null;
}

/** Whether the app has a database at all. */
export function hasDatabase(): boolean {
  return databaseUrl() !== null;
}

export class NoDatabase extends Error {
  readonly code = 'no_database';
  constructor() {
    super('This deployment has no database configured (DATABASE_URL is unset).');
    this.name = 'NoDatabase';
  }
}

function getPool(): Pool {
  const url = databaseUrl();
  if (!url) throw new NoDatabase();
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      // Managed providers terminate unencrypted connections, and their
      // certificates are usually not in the default trust store. Local
      // development is plain TCP to localhost and needs none of it.
      ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
    });
    // A pool that emits an unhandled 'error' takes the process down. Idle
    // clients get dropped by managed databases as a matter of course, so this
    // is a normal event, not a fault.
    pool.on('error', () => {});
  }
  return pool;
}

/**
 * Apply the schema, once per process.
 *
 * Deliberately lazy rather than a build step: the database may not exist when
 * the image is built, and a deploy that cannot reach it should fail on the
 * first request that needs it, with a legible error, rather than refuse to
 * boot at all.
 */
export async function migrate(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const sql = readFileSync(join(process.cwd(), 'lib', 'db', 'schema.sql'), 'utf8');
      await getPool().query(sql);
    })().catch((err) => {
      // Clear the cache so a transient failure — the database still starting,
      // say — is retried rather than remembered forever.
      ready = null;
      throw err;
    });
  }
  return ready;
}

export async function query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  await migrate();
  const result = await getPool().query(text, params);
  return result.rows as T[];
}

/** The single row a query is expected to produce, or null. */
export async function queryOne<T = any>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}
