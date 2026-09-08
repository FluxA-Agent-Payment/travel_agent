import { describe, expect, it } from 'vitest';

import { hashPassword, normaliseEmail, passwordProblem, verifyPassword } from '../auth';

/**
 * The parts of authentication that do not need a database. The session and
 * rate-limit paths are exercised against a real Postgres rather than mocked,
 * since what matters about them is the SQL.
 */

describe('password hashing', () => {
  it('accepts the right password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batteryy', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  // Same password, different hash — so a stolen table cannot be attacked by
  // grouping identical hashes, and a rainbow table is useless.
  it('salts, so identical passwords hash differently', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('stores no trace of the password itself', async () => {
    const stored = await hashPassword('hunter2');
    expect(stored).not.toContain('hunter2');
    expect(stored.startsWith('scrypt$')).toBe(true);
  });

  // Sign-in verifies against a dummy hash when no user exists, so that path
  // must return false rather than throw — otherwise an unknown address 500s
  // and becomes distinguishable from a wrong password after all.
  it('returns false on a malformed stored hash instead of throwing', async () => {
    for (const bad of ['', 'nonsense', 'scrypt$', 'scrypt$00$00', 'bcrypt$a$b']) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });
});

describe('password rules', () => {
  it('requires eight characters', () => {
    expect(passwordProblem('short')).toMatch(/at least 8/);
    expect(passwordProblem('12345678')).toBeNull();
  });

  it('has no composition rules', () => {
    // "one capital, one number, one symbol" pushes people towards Password1!
    expect(passwordProblem('all lowercase words no digits')).toBeNull();
  });

  it('rejects a non-string and an absurd length', () => {
    expect(passwordProblem(undefined as any)).not.toBeNull();
    expect(passwordProblem('a'.repeat(201))).not.toBeNull();
  });
});

describe('email normalisation', () => {
  // Case and stray whitespace must not create a second account for one person,
  // and the address is the key everything else hangs off.
  it('lowercases and trims', () => {
    expect(normaliseEmail('  Test@Example.COM ')).toBe('test@example.com');
  });

  it('rejects addresses that could not be signed in with', () => {
    for (const bad of ['', 'nope', 'a@b', 'two@@at.com', 'has space@x.com', null, 42]) {
      expect(normaliseEmail(bad as any)).toBeNull();
    }
  });

  it('accepts ordinary addresses', () => {
    for (const good of ['a@b.co', 'first.last+tag@sub.example.org']) {
      expect(normaliseEmail(good)).toBe(good);
    }
  });
});
