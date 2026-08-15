/**
 * Vitest global setup.
 *
 * Analytics, parsing and validation tests are pure and always run. Tests that
 * need PostgreSQL check `hasDatabase()` and skip themselves when DATABASE_URL
 * is absent, so `npm test` is green on a clean checkout without a database.
 */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env', quiet: true });

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
