import 'server-only';
import { z } from 'zod';

/**
 * Server-side environment contract.
 *
 * This module is `server-only`: importing it from a client component is a build
 * error. That is the mechanism that keeps DATABASE_URL out of the browser
 * bundle. Nothing here may ever be re-exported from a client module.
 */

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'),
      'DATABASE_URL must be a PostgreSQL connection string. SQLite is not supported.',
    ),

  /** Comma-separated allowlist of admin email addresses. */
  ADMIN_EMAIL: z.string().default(''),

  /** Bearer token required by the scheduled ingestion endpoint. */
  CRON_SECRET: z.string().default(''),

  DATA_PROVIDER: z
    .enum(['csv', 'dse_official', 'third_party'])
    .default('csv'),

  DSE_API_URL: z.string().default(''),
  DSE_API_KEY: z.string().default(''),

  AI_API_KEY: z.string().default(''),
  AI_MODEL: z.string().default('claude-sonnet-5'),

  ENABLE_DEV_PARSERS: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Parses and caches the environment. Throws a readable error listing every
 * missing/invalid variable rather than failing later at query time.
 */
export function getEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill in the values.`,
    );
  }

  cached = parsed.data;
  return cached;
}

/** Admin allowlist, normalised to lowercase. */
export function adminEmails(): string[] {
  return getEnv()
    .ADMIN_EMAIL.split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isProduction(): boolean {
  return getEnv().NODE_ENV === 'production';
}

/**
 * Development-only source parsers are gated behind an explicit flag and are
 * hard-disabled in production. Unauthorised scraping must never become the
 * commercial architecture.
 */
export function devParsersEnabled(): boolean {
  return getEnv().ENABLE_DEV_PARSERS && !isProduction();
}
