import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

import { cookies } from 'next/headers';

import { query, queryOne } from './db';

/**
 * Accounts and sessions.
 *
 * Email and password, with no address verification and therefore no password
 * reset — both need a way to send mail, which this deployment does not have.
 * Two things follow from that and are load-bearing rather than incidental:
 *
 *   - A forgotten password is a lost account. Say so before anyone relies on
 *     it for something they care about.
 *   - Nobody has proved they own the address they typed. So an email
 *     identifies an account and MUST NOT be treated as a claim on anything
 *     filed under it. Bookings belong to the account that made them.
 *
 * Password hashing uses scrypt from the standard library rather than bcrypt or
 * argon2 from npm. It is a real password hash — memory-hard, salted, tunable —
 * and avoids a native module that would have to compile on the deploy host.
 */

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEYLEN = 64;
const SESSION_DAYS = 30;
const COOKIE = 'flightdesk_session';

/* ---------- passwords ---------- */

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Compare a password against a stored hash.
 *
 * The comparison is constant-time. A plain `===` on hex leaks how much of the
 * hash matched through timing, which is exactly the kind of small hole that
 * makes an offline guess into an online one.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Whether a password is acceptable.
 *
 * Length only. Composition rules ("one capital, one symbol") measurably push
 * people towards `Password1!` and are not worth the friction.
 */
export function passwordProblem(password: string): string | null {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  if (password.length > 200) return 'Password is too long';
  return null;
}

export function normaliseEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  // Deliberately loose. The only address that matters is one someone can
  // actually sign in with, and elaborate patterns reject valid addresses more
  // often than they catch typos.
  if (trimmed.length < 3 || trimmed.length > 320 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/* ---------- rate limiting ---------- */

const MAX_ATTEMPTS = 8;
const WINDOW_MINUTES = 15;

/** True when this address has failed too often lately to keep trying. */
export async function isRateLimited(email: string): Promise<boolean> {
  const row = await queryOne<{ count: string }>(
    `SELECT count(*) FROM login_attempts
      WHERE email = $1 AND at > now() - ($2 || ' minutes')::interval`,
    [email, String(WINDOW_MINUTES)],
  );
  return Number(row?.count ?? 0) >= MAX_ATTEMPTS;
}

export async function recordFailedAttempt(email: string): Promise<void> {
  await query(`INSERT INTO login_attempts (email) VALUES ($1)`, [email]);
  // Opportunistic cleanup, so the table does not grow without bound and no
  // scheduled job is needed to keep it in check.
  await query(`DELETE FROM login_attempts WHERE at < now() - interval '1 day'`);
}

export async function clearAttempts(email: string): Promise<void> {
  await query(`DELETE FROM login_attempts WHERE email = $1`, [email]);
}

/* ---------- users ---------- */

export interface User {
  id: string;
  email: string;
}

export async function createUser(email: string, password: string): Promise<User> {
  const id = `us_${randomUUID().slice(0, 12)}`;
  await query(`INSERT INTO users (id, email, password) VALUES ($1, $2, $3)`, [
    id,
    email,
    await hashPassword(password),
  ]);
  return { id, email };
}

export async function findUserByEmail(
  email: string,
): Promise<(User & { password: string }) | null> {
  return queryOne(`SELECT id, email, password FROM users WHERE email = $1`, [email]);
}

/* ---------- sessions ---------- */

/**
 * The cookie value is random and long; only its hash is stored.
 *
 * So a leaked database yields no working sessions — the same reason passwords
 * are hashed. There is no reason for the server to be able to reconstruct a
 * live session token from its own records.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function startSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [hashToken(token), userId, String(SESSION_DAYS)],
  );
  return token;
}

export async function endSession(token: string): Promise<void> {
  await query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

/** The signed-in user for a request, or null. */
export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;

  const row = await queryOne<User>(
    `SELECT u.id, u.email FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  return row;
}

export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Off in development so the cookie survives plain http on localhost.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export async function sessionToken(): Promise<string | null> {
  return (await cookies()).get(COOKIE)?.value ?? null;
}
