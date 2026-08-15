import 'server-only';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getEnv } from '@/lib/env';
import * as schema from './schema';

/**
 * Railway PostgreSQL connection.
 *
 * A single pooled client is reused across requests and survives Next.js dev
 * hot-reloads via a global handle, otherwise every reload would leak a pool.
 *
 * Credentials come from DATABASE_URL only. This module is `server-only`, so it
 * cannot be pulled into a client bundle.
 */

declare global {
  var __kadiokoSql: ReturnType<typeof postgres> | undefined;
}

function createClient() {
  const env = getEnv();
  const isProd = env.NODE_ENV === 'production';

  return postgres(env.DATABASE_URL, {
    max: isProd ? 10 : 4,
    idle_timeout: 20,
    connect_timeout: 15,
    // Railway terminates TLS at the proxy with a self-signed chain.
    ssl: env.DATABASE_URL.includes('localhost') ? false : 'require',
    // Keep NUMERIC as string: exactness is preserved until an explicit
    // conversion in src/lib/db/num.ts.
    types: {},
    onnotice: isProd ? () => {} : undefined,
  });
}

export const sql = globalThis.__kadiokoSql ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__kadiokoSql = sql;
}

export const db = drizzle(sql, { schema, logger: false });

export type Database = typeof db;
export { schema };

/** Lightweight connectivity probe used by /api/health and the admin page. */
export async function pingDatabase(): Promise<{
  ok: boolean;
  latencyMs: number;
  error?: string;
}> {
  const started = Date.now();
  try {
    await sql`select 1 as ok`;
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'Unknown database error',
    };
  }
}
