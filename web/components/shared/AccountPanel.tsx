'use client';

import { useState } from 'react';

import { useAuth } from '@/components/providers/AuthProvider';

/**
 * Sign in, or make an account.
 *
 * One form with a mode switch rather than two screens. Someone who mistypes
 * their address on a site they have used before, and someone arriving for the
 * first time, both end up here — and the difference between "wrong password"
 * and "no account yet" is a single click, not a navigation.
 *
 * The warning about there being no password reset is stated on the form
 * itself, not buried. It is true, it is unusual, and finding out afterwards
 * would be worse than being told.
 */
export function AccountPanel({ onDone }: { onDone?: () => void }) {
  const { user, available, signIn, signUp, signOut } = useAuth();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!available) {
    return (
      <div className="account">
        <p className="note">
          Accounts are switched off on this deployment, so bookings are not kept
          between visits.
        </p>
      </div>
    );
  }

  if (user) {
    return (
      <div className="account">
        <p className="note">
          Signed in as <strong>{user.email}</strong>
        </p>
        <div className="actions">
          <button
            onClick={async () => {
              await signOut();
              onDone?.();
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await (mode === 'signin' ? signIn(email, password) : signUp(email, password));
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="account">
      <form onSubmit={submit}>
        <label>
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </label>
        <label>
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            // Tells a password manager whether to offer a saved password or
            // suggest a new one. Wrong here and it prompts to overwrite an
            // existing entry with whatever was just typed.
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            minLength={8}
            required
          />
        </label>

        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </button>
        </div>
      </form>

      {error ? <p className="note bad">{error}</p> : null}

      {mode === 'signup' ? (
        <p className="note warn">
          There is no password reset yet — this desk cannot send email. If you
          forget it, the account cannot be recovered.
        </p>
      ) : null}

      <p className="note">
        {mode === 'signin' ? 'No account yet? ' : 'Already have one? '}
        <button
          className="linklike"
          type="button"
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin');
            setError(null);
          }}
        >
          {mode === 'signin' ? 'Create one' : 'Sign in'}
        </button>
      </p>
    </div>
  );
}
