'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

/**
 * Who is signed in.
 *
 * Deliberately tolerant of there being no accounts at all: a deployment
 * without a database still works, it just cannot remember anyone. So
 * `available` is a first-class state rather than an error, and everything
 * that depends on an account checks it before offering one.
 */

export interface Account {
  id: string;
  email: string;
}

interface AuthValue {
  user: Account | null;
  /** False when this deployment has no database, so accounts cannot exist. */
  available: boolean;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

async function post(action: string, body: Record<string, unknown> = {}) {
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'That did not work');
  return data;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<Account | null>(null);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth');
      const data = await res.json();
      setUser(data.user ?? null);
      setAvailable(data.accounts === true);
    } catch {
      // A failed check means we do not know, and not knowing must read as
      // "signed out" rather than leaving a stale identity on screen.
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      available,
      loading,
      refresh,
      signIn: async (email, password) => {
        setUser((await post('signin', { email, password })).user);
      },
      signUp: async (email, password) => {
        setUser((await post('signup', { email, password })).user);
      },
      signOut: async () => {
        await post('signout');
        setUser(null);
      },
    }),
    [user, available, loading, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
