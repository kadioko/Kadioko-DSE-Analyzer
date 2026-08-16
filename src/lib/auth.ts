import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { adminEmails, getEnv } from './env';

/**
 * Admin authorisation.
 *
 * This is a deliberately small, real mechanism rather than a placeholder: an
 * operator proves possession of ADMIN_TOKEN once, and receives an HMAC-signed,
 * httpOnly, expiring session cookie. Every admin route calls requireAdmin() on
 * the server. There is no client-side check anywhere, because a client-side
 * check is not a security control.
 *
 * Phase 11 replaces this with per-user accounts and roles. The interface below
 * (`requireAdmin`, `getAdminSession`) is what the rest of the application uses,
 * so that swap does not touch the routes.
 */

const COOKIE_NAME = 'kadioko_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

export interface AdminSession {
  email: string;
  expiresAt: number;
}

export class NotAuthorizedError extends Error {
  constructor(message = 'Administrator authorisation required.') {
    super(message);
    this.name = 'NotAuthorizedError';
  }
}

/** Constant-time comparison; avoids leaking the token through timing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still perform a comparison so the failure path costs the same.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function signingKey(): string {
  const token = getEnv().ADMIN_TOKEN;
  if (!token) {
    throw new NotAuthorizedError(
      'ADMIN_TOKEN is not configured. Admin routes are disabled until it is set.',
    );
  }
  return token;
}

function sign(payload: string): string {
  return createHmac('sha256', signingKey()).update(payload).digest('hex');
}

function serialize(session: AdminSession): string {
  const payload = `${session.email}:${session.expiresAt}`;
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sign(payload)}`;
}

function deserialize(value: string): AdminSession | null {
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;

  const encoded = value.slice(0, dot);
  const signature = value.slice(dot + 1);

  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  if (!safeEqual(signature, sign(payload))) return null;

  const separator = payload.lastIndexOf(':');
  if (separator <= 0) return null;

  const email = payload.slice(0, separator);
  const expiresAt = Number(payload.slice(separator + 1));
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;

  // The allowlist is re-checked on every request, so removing an address from
  // ADMIN_EMAIL revokes access immediately rather than at cookie expiry.
  if (!adminEmails().includes(email.toLowerCase())) return null;

  return { email, expiresAt };
}

/**
 * Verifies credentials and returns a session cookie value.
 * Returns null when either the email is not allowlisted or the token is wrong -
 * the caller must not distinguish the two in its response.
 */
export function authenticateAdmin(
  email: string,
  token: string,
): { cookieName: string; value: string; maxAgeSeconds: number } | null {
  const configured = getEnv().ADMIN_TOKEN;
  if (!configured) return null;

  const normalized = email.trim().toLowerCase();
  const allowed = adminEmails();
  if (allowed.length === 0) return null;

  const emailOk = allowed.includes(normalized);
  const tokenOk = safeEqual(token, configured);
  // Both checks always run before the decision, so a wrong email and a wrong
  // token are indistinguishable in timing.
  if (!emailOk || !tokenOk) return null;

  const session: AdminSession = {
    email: normalized,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  return {
    cookieName: COOKIE_NAME,
    value: serialize(session),
    maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/** Current admin session, or null. Never throws for an absent session. */
export async function getAdminSession(): Promise<AdminSession | null> {
  if (!getEnv().ADMIN_TOKEN) return null;
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  try {
    return deserialize(raw);
  } catch {
    return null;
  }
}

/** Throws NotAuthorizedError unless a valid admin session is present. */
export async function requireAdmin(): Promise<AdminSession> {
  const session = await getAdminSession();
  if (!session) throw new NotAuthorizedError();
  return session;
}

export const ADMIN_COOKIE_NAME = COOKIE_NAME;

/* -------------------------------------------------------------------------- */
/* Scheduled-job authorisation                                                */
/* -------------------------------------------------------------------------- */

/**
 * Verifies the bearer token on the scheduled ingestion endpoint.
 * Uses CRON_SECRET, which is separate from ADMIN_TOKEN so that a compromised
 * scheduler cannot reach the admin surfaces.
 */
export function isValidCronRequest(authorizationHeader: string | null): boolean {
  const secret = getEnv().CRON_SECRET;
  if (!secret) return false;
  if (!authorizationHeader) return false;

  const prefix = 'Bearer ';
  if (!authorizationHeader.startsWith(prefix)) return false;

  return safeEqual(authorizationHeader.slice(prefix.length), secret);
}
