import 'server-only';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getEnv } from '@/lib/env';
import * as schema from './schema';

/**
 * Railway PostgreSQL connection.
 *
 * The connection is created lazily, on first query, rather than at module load.
 * That matters for two reasons:
 *
 *   1. `next build` imports every route module to collect page configuration.
 *      Connecting at import time would make the build require DATABASE_URL and
 *      a reachable database, which a CI build should not need.
 *   2. A route that never touches the database never opens a connection.
 *
 * A single pooled client is reused across requests and survives dev
 * hot-reloads via a global handle, which otherwise leaks a pool per reload.
 *
 * Credentials come from DATABASE_URL only. This module is `server-only`, so it
 * cannot be pulled into a client bundle.
 */

type Sql = ReturnType<typeof postgres>;

declare global {
  var __kadiokoSql: Sql | undefined;
  var __kadiokoDb: PostgresJsDatabase<typeof schema> | undefined;
}

function createClient(): Sql {
  const env = getEnv();
  const isProd = env.NODE_ENV === 'production';

  return postgres(env.DATABASE_URL, {
    max: isProd ? 10 : 4,
    idle_timeout: 20,
    connect_timeout: 15,
    // Railway terminates TLS at its proxy with a self-signed chain.
    ssl: env.DATABASE_URL.includes('localhost') ? false : 'require',
    // Keep NUMERIC as string: exactness is preserved until an explicit
    // conversion in src/lib/db/num.ts.
    types: {},
    onnotice: isProd ? () => {} : undefined,
  });
}

/** The raw postgres client, for hand-written SQL. Connects on first call. */
export function getSql(): Sql {
  if (!globalThis.__kadiokoSql) {
    globalThis.__kadiokoSql = createClient();
  }
  return globalThis.__kadiokoSql;
}

/** The Drizzle instance. Connects on first call. */
export function getDb(): PostgresJsDatabase<typeof schema> {
  if (!globalThis.__kadiokoDb) {
    globalThis.__kadiokoDb = drizzle(getSql(), { schema, logger: false });
  }
  return globalThis.__kadiokoDb;
}

/**
 * Ergonomic handle used throughout the repositories: `db.select()...`.
 *
 * A proxy rather than a direct instance, so that touching a property is what
 * triggers the connection. Repositories read exactly as if `db` were the
 * Drizzle instance itself.
 */
export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_target, property, receiver) {
    return Reflect.get(getDb(), property, receiver);
  },
});

export { schema };
export type Database = PostgresJsDatabase<typeof schema>;

/** Lightweight connectivity probe used by /api/health and the admin console. */
export async function pingDatabase(): Promise<{
  ok: boolean;
  latencyMs: number;
  error?: string;
}> {
  const started = Date.now();
  try {
    const sql = getSql();
    await sql`select 1 as ok`;
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      // The message can contain the host; it is only ever shown to an
      // authenticated administrator or logged server-side.
      error: error instanceof Error ? error.message : 'Unknown database error',
    };
  }
}
