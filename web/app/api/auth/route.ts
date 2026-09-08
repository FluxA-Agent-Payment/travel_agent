import { NextRequest } from 'next/server';

import {
  clearAttempts,
  clearSessionCookie,
  createUser,
  currentUser,
  endSession,
  findUserByEmail,
  isRateLimited,
  normaliseEmail,
  passwordProblem,
  recordFailedAttempt,
  sessionToken,
  setSessionCookie,
  startSession,
  verifyPassword,
} from '@/lib/auth';
import { hasDatabase } from '@/lib/db';

export const runtime = 'nodejs';

/**
 * Sign up, sign in, sign out, and "who am I".
 *
 * Two rules run through all of it.
 *
 * Sign-in never reveals whether an address has an account: the same message
 * and the same status come back for an unknown address and a wrong password.
 * Anything else turns this into a way to find out who has registered.
 *
 * Sign-UP cannot hide it — "that address is taken" is unavoidable if people
 * are to be told why they cannot register. That asymmetry is accepted rather
 * than papered over, because the alternative is a dead end with no explanation.
 */

const GENERIC = 'That email and password do not match an account';

export async function POST(req: NextRequest) {
  if (!hasDatabase()) {
    return Response.json(
      { error: 'Accounts are unavailable — this deployment has no database.', code: 'no_database' },
      { status: 503 },
    );
  }

  let body: { action?: string; email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.action === 'signout') {
    const token = await sessionToken();
    if (token) await endSession(token);
    await clearSessionCookie();
    return Response.json({ ok: true });
  }

  const email = normaliseEmail(body.email);
  if (!email) return Response.json({ error: 'Enter a valid email address' }, { status: 400 });

  try {
    if (body.action === 'signup') {
      const problem = passwordProblem(body.password ?? '');
      if (problem) return Response.json({ error: problem }, { status: 400 });

      if (await findUserByEmail(email)) {
        return Response.json(
          { error: 'An account already exists for that email', code: 'email_taken' },
          { status: 409 },
        );
      }

      const user = await createUser(email, body.password!);
      await setSessionCookie(await startSession(user.id));
      return Response.json({ user: { id: user.id, email: user.email } });
    }

    if (body.action === 'signin') {
      // Checked before the password is even looked at, so a locked-out address
      // costs an attacker the same whether or not they guessed correctly.
      if (await isRateLimited(email)) {
        return Response.json(
          {
            error: 'Too many attempts. Wait a few minutes and try again.',
            code: 'rate_limited',
          },
          { status: 429 },
        );
      }

      const found = await findUserByEmail(email);
      // The password is verified even when no such user exists, against a
      // throwaway hash, so the reply takes the same time either way. Returning
      // early on an unknown address makes the timing itself the answer.
      const ok = found
        ? await verifyPassword(body.password ?? '', found.password)
        : await verifyPassword(body.password ?? '', 'scrypt$00$00');

      if (!found || !ok) {
        await recordFailedAttempt(email);
        return Response.json({ error: GENERIC, code: 'bad_credentials' }, { status: 401 });
      }

      await clearAttempts(email);
      await setSessionCookie(await startSession(found.id));
      return Response.json({ user: { id: found.id, email: found.email } });
    }

    return Response.json(
      { error: 'action must be one of: signup, signin, signout' },
      { status: 400 },
    );
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}

/** Who is signed in, if anyone. Never an error — "nobody" is a valid answer. */
export async function GET() {
  if (!hasDatabase()) return Response.json({ user: null, accounts: false });
  try {
    return Response.json({ user: await currentUser(), accounts: true });
  } catch {
    return Response.json({ user: null, accounts: false });
  }
}
