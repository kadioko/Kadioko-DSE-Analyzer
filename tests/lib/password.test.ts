import { describe, expect, it } from 'vitest';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  needsRehash,
  validatePassword,
  verifyPassword,
} from '@/lib/password';

/**
 * Password handling is the one part of this codebase where a subtle bug is
 * indistinguishable from correct behaviour until a database leaks. These test
 * the properties that matter rather than the implementation.
 */

const GOOD = 'correct horse battery staple';

describe('hashing', () => {
  it('round-trips a password', async () => {
    const hash = await hashPassword(GOOD);
    expect(await verifyPassword(GOOD, hash)).toBe(true);
  });

  it('rejects the wrong password, including near misses', async () => {
    const hash = await hashPassword(GOOD);
    expect(await verifyPassword(`${GOOD} `, hash)).toBe(false);
    expect(await verifyPassword(GOOD.toUpperCase(), hash)).toBe(false);
    expect(await verifyPassword(GOOD.slice(0, -1), hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('never stores the password itself', async () => {
    const hash = await hashPassword(GOOD);
    expect(hash).not.toContain(GOOD);
    expect(hash).not.toContain('correct');
    expect(hash).not.toContain('staple');
  });

  it('salts, so the same password hashes differently every time', async () => {
    // Without this, identical passwords are visible as identical rows, and one
    // cracked hash breaks every account that shares it.
    const a = await hashPassword(GOOD);
    const b = await hashPassword(GOOD);
    expect(a).not.toBe(b);
    expect(await verifyPassword(GOOD, a)).toBe(true);
    expect(await verifyPassword(GOOD, b)).toBe(true);
  });

  it('records its own cost parameters so they can be raised later', async () => {
    // A hash that does not describe itself cannot be verified after the
    // parameters change, which means every password has to be reset.
    const hash = await hashPassword(GOOD);
    const [scheme, n, r, p] = hash.split('$');
    expect(scheme).toBe('scrypt');
    expect(Number(n)).toBeGreaterThanOrEqual(2 ** 15);
    expect(Number(r)).toBeGreaterThan(0);
    expect(Number(p)).toBeGreaterThan(0);
    expect(hash.split('$')).toHaveLength(6);
  });

  it('handles unicode and very long passphrases', async () => {
    const unicode = 'ninapenda soko la hisa la Dar es Salaam 🇹🇿';
    const hash = await hashPassword(unicode);
    expect(await verifyPassword(unicode, hash)).toBe(true);

    const long = 'a'.repeat(MAX_PASSWORD_LENGTH);
    expect(await verifyPassword(long, await hashPassword(long))).toBe(true);
  });
});

describe('verifying a stored value that is not a valid hash', () => {
  it('returns false rather than throwing', async () => {
    // A corrupted row must fail the sign-in quietly. Throwing produces a 500
    // that tells an attacker the account exists and its record is unusual.
    for (const stored of [
      null,
      undefined,
      '',
      'not-a-hash',
      'scrypt$only$three',
      'bcrypt$32768$8$1$c2FsdA$aGFzaA',
      'scrypt$notanumber$8$1$c2FsdA$aGFzaA',
      'scrypt$32768$8$1$$aGFzaA',
      'scrypt$32768$8$1$c2FsdA$',
      '$$$$$',
    ]) {
      await expect(verifyPassword(GOOD, stored), String(stored)).resolves.toBe(false);
    }
  });

  it('refuses absurd cost parameters instead of trying to honour them', async () => {
    // A tampered row could otherwise exhaust memory on every sign-in attempt.
    const hostile = `scrypt$${2 ** 30}$8$1$c2FsdA$aGFzaA`;
    await expect(verifyPassword(GOOD, hostile)).resolves.toBe(false);
  });
});

describe('choosing a password', () => {
  it('accepts a reasonable passphrase', () => {
    expect(validatePassword(GOOD)).toBeNull();
  });

  it('requires length rather than punctuation', () => {
    // Composition rules mostly produce Passw0rd!, so length is the rule.
    expect(validatePassword('Ab1!'.repeat(2))?.code).toBe('TOO_SHORT');
    expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });

  it('caps the length so a huge input cannot burn CPU', () => {
    expect(validatePassword('a'.repeat(MAX_PASSWORD_LENGTH + 1))?.code).toBe('TOO_LONG');
  });

  it('turns away the passwords people actually pick', () => {
    for (const bad of ['password123', 'PASSWORD123', '1234567890', 'kadioko123']) {
      expect(validatePassword(bad)?.code, bad).toBe('TOO_COMMON');
    }
  });

  it('sees through spacing and casing used to dodge the check', () => {
    expect(validatePassword('Pass word 123')?.code).toBe('TOO_COMMON');
    expect(validatePassword('pass-word-123')?.code).toBe('TOO_COMMON');
  });
});

describe('rehashing', () => {
  it('leaves a current hash alone', async () => {
    expect(needsRehash(await hashPassword(GOOD))).toBe(false);
  });

  it('flags a hash made with weaker parameters', () => {
    expect(needsRehash('scrypt$16384$8$1$c2FsdA$aGFzaA')).toBe(true);
  });

  it('flags anything missing or unreadable', () => {
    expect(needsRehash(null)).toBe(true);
    expect(needsRehash('')).toBe(true);
    expect(needsRehash('bcrypt$whatever')).toBe(true);
  });
});
