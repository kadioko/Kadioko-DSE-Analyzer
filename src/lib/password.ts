import 'server-only';
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing.
 *
 * scrypt, from Node's own crypto module. It is a memory-hard key derivation
 * function, which is the property that matters: an attacker with a stolen
 * database and a GPU is slowed by memory bandwidth rather than helped by
 * parallelism. Choosing it over argon2 or bcrypt avoids a native build step,
 * which on a platform like Railway is a real source of deployment failure.
 *
 * Never store, log or compare a password directly. The only thing that leaves
 * this module is a self-describing hash string.
 */

/**
 * Cost parameters, stored inside every hash so they can be raised later without
 * invalidating existing passwords.
 *
 * N is the memory/CPU cost. 2^15 costs roughly 32 MB and tens of milliseconds,
 * which is slow enough to matter to an attacker and fast enough that a sign-in
 * does not feel broken.
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** scrypt refuses to run if it would exceed maxmem; 128*N*r plus headroom. */
const MAX_MEM = 128 * PARAMS.N * PARAMS.r * 2;

/**
 * The shortest password accepted.
 *
 * Length beats composition rules: forcing a symbol and a digit produces
 * `Passw0rd!` far more often than it produces anything strong.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** Longer than this is refused, so a huge input cannot be used to burn CPU. */
export const MAX_PASSWORD_LENGTH = 256;

export interface PasswordProblem {
  code: 'TOO_SHORT' | 'TOO_LONG' | 'TOO_COMMON';
  message: string;
}

/**
 * A small list of the passwords that actually get chosen. Not a substitute for
 * a breach corpus, but it catches the handful that would otherwise appear in
 * any real deployment.
 */
const OBVIOUS = new Set([
  'password', 'password1', 'password123', 'passw0rd', 'letmein',
  'qwerty', 'qwertyuiop', '123456', '1234567', '12345678', '123456789',
  '1234567890', 'iloveyou', 'admin', 'administrator', 'welcome',
  'welcome123', 'abc123', 'monkey', 'dragon', 'football', 'baseball',
  'kadioko', 'kadioko123', 'dse', 'tanzania', 'daressalaam',
]);

/** Checks a candidate password before it is ever hashed. */
export function validatePassword(password: string): PasswordProblem | null {
  if (password.length > MAX_PASSWORD_LENGTH) {
    return {
      code: 'TOO_LONG',
      message: `Use at most ${MAX_PASSWORD_LENGTH} characters.`,
    };
  }

  /*
   * Commonness is checked before length, even though most common passwords are
   * also too short. Told "use at least 12 characters", someone who typed
   * password123 types password1234; told that it is one of the most guessed
   * passwords, they pick something else. Naming the real problem is what
   * changes the outcome.
   */
  const normalized = password.toLowerCase().replace(/[\s_-]/g, '');
  if (OBVIOUS.has(normalized)) {
    return {
      code: 'TOO_COMMON',
      message: 'That is one of the most commonly guessed passwords. Choose something else - a short phrase of ordinary words works well.',
    };
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      code: 'TOO_SHORT',
      message: `Use at least ${MIN_PASSWORD_LENGTH} characters. A longer phrase is stronger than a short password with symbols in it.`,
    };
  }

  return null;
}

/**
 * Hashes a password.
 *
 * The result is self-describing — `scrypt$N$r$p$salt$hash` — so a hash made
 * today can still be verified after the cost parameters are raised.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    ...PARAMS,
    maxmem: MAX_MEM,
  });

  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false for anything it cannot parse rather than throwing: a corrupted
 * row must fail the sign-in, not produce a 500 that tells an attacker the
 * account exists and its record is unusual.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);

  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }
  // Refuse absurd parameters from a tampered row, which could otherwise be used
  // to exhaust memory on every sign-in attempt.
  if (N < 2 || N > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(rawSalt ?? '', 'base64url');
    expected = Buffer.from(rawHash ?? '', 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });
  } catch {
    return false;
  }

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * True when a stored hash was made with weaker parameters than the current
 * ones, so it can be transparently upgraded on the next successful sign-in.
 */
export function needsRehash(stored: string | null | undefined): boolean {
  if (!stored) return true;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < PARAMS.N;
}
