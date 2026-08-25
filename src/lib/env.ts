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

  /**
   * Shared secret an operator presents to obtain an admin session, and the key
   * the session cookie is signed with. Admin routes are disabled when unset.
   * Kept separate from CRON_SECRET so a compromised scheduler cannot reach the
   * admin surfaces.
   */
  ADMIN_TOKEN: z.string().default(''),

  /** Bearer token required by the scheduled ingestion endpoint. */
  CRON_SECRET: z.string().default(''),

  /**
   * Key that user session cookies are signed with.
   *
   * Deliberately separate from ADMIN_TOKEN: an operator's shared secret and a
   * member's session are different things, and rotating one should not silently
   * sign out or elevate the other. Accounts are disabled while this is unset,
   * in the same way admin routes are disabled without ADMIN_TOKEN, so a
   * deployment never falls back to an unsigned or default-keyed session.
   */
  SESSION_SECRET: z.string().default(''),

  /** Set to "true" to let anyone create an account on this deployment. */
  ALLOW_SELF_REGISTRATION: z.string().default('false'),

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
  return process.env.NODE_ENV === 'production';
}

/**
 * Whether a database connection string is present.
 *
 * Deliberately does NOT call getEnv(), so it never throws. Pages use it to show
 * a setup screen on a fresh checkout instead of an unhandled configuration
 * error, which tells a first-time operator nothing useful.
 */
export function isDatabaseConfigured(): boolean {
  const url = process.env.DATABASE_URL;
  return Boolean(
    url && (url.startsWith('postgres://') || url.startsWith('postgresql://')),
  );
}

/**
 * Development-only source parsers are gated behind an explicit flag and are
 * hard-disabled in production. Unauthorised scraping must never become the
 * commercial architecture.
 */
/**
 * Whether member accounts are usable on this deployment.
 *
 * False means every account route reports that accounts are not configured,
 * rather than falling back to an unsigned session or a default key.
 */
export function accountsEnabled(): boolean {
  return getEnv().SESSION_SECRET.length > 0;
}

/**
 * Whether a visitor may create their own account.
 *
 * Defaults to false. A public analytics deployment that silently accepts
 * open registration accumulates accounts nobody chose to admit.
 */
export function selfRegistrationEnabled(): boolean {
  return (
    accountsEnabled() &&
    getEnv().ALLOW_SELF_REGISTRATION.trim().toLowerCase() === 'true'
  );
}

export function devParsersEnabled(): boolean {
  return getEnv().ENABLE_DEV_PARSERS && !isProduction();
}
