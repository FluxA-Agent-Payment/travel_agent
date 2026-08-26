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
 * The FluxA wallet, shared by everything that needs to know about cards.
 *
 * This exists because two very separate parts of the UI need the same facts:
 * the wallet panel lists cards, and an order card has to know whether the
 * selected card can actually cover the fare before offering to charge it.
 * Passing that down as props would thread wallet state through the whole tool
 * -rendering tree, so it lives here instead.
 *
 * Balances only. A PAN or CVV never enters this state — those are read
 * server-side at the moment of payment and go straight to the airline.
 */

export interface CardSummary {
  id: string;
  last4?: string;
  status?: string;
  /** Spendable balance — what remains, not what was loaded. */
  balance?: string;
  /** Amount originally loaded; constant as the card is spent. */
  funded?: string;
  currency?: string;
  expiryMonth?: string;
  expiryYear?: string;
  brand?: string;
}

export interface Cardholder {
  name?: string;
  firstName?: string;
  lastName?: string;
}

/**
 * A mandate the user has been sent off to sign.
 *
 * It lives here rather than inside the issuance component because that
 * component unmounts whenever the wallet menu closes, and the user signs in a
 * different tab. Holding the id at this level means a closed menu — or a
 * stray click — cannot strand a signature that has already been given.
 */
export interface PendingMandate {
  id: string;
  amountUsd: number;
}

interface WalletValue {
  cards: CardSummary[];
  cardholder: Cardholder | null;
  loading: boolean;
  error: string | null;
  selectedCardId?: string;
  selected?: CardSummary;
  selectCard: (id: string | undefined) => void;
  refresh: () => Promise<void>;
  pendingMandate: PendingMandate | null;
  setPendingMandate: (m: PendingMandate | null) => void;
  /** True while issuance is mid-flight, so menus do not close under it. */
  issuing: boolean;
  setIssuing: (v: boolean) => void;
}

const WalletContext = createContext<WalletValue | null>(null);

/**
 * Retry a request that failed at the network level.
 *
 * Only transport failures are retried — a fetch that never produced a
 * response. An HTTP error is a real answer from the server and is returned as
 * it stands, because retrying a 400 just asks the same wrong question again.
 */
async function withRetry(
  make: () => Promise<Response>,
  attempts = 3,
): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await make();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 600 * (i + 1)));
      }
    }
  }
  throw new Error(
    `Could not reach the wallet service (${(lastError as Error)?.message ?? 'network error'})`,
  );
}

/** Spendable balance as a number. Cards report it as a formatted string. */
export function balanceOf(card?: CardSummary): number {
  const n = Number(card?.balance ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [cardholder, setCardholder] = useState<Cardholder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string | undefined>();
  const [pendingMandate, setPendingMandate] = useState<PendingMandate | null>(null);
  const [issuing, setIssuing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      // Loading cards shells out to the FluxA CLI, so it is slow enough that a
      // page-load race or a dropped connection can lose it — and a lost first
      // load used to be permanent, leaving a wallet that looked empty. Retry
      // transient failures before believing them.
      const res = await withRetry(() => fetch('/api/cards'));
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not load cards');
      const next: CardSummary[] = body.cards ?? [];
      setCards(next);
      setCardholder(body.cardholder ?? null);
      setError(null);
      // Preselect the card most likely to be usable, so a first-time visitor
      // is not sent to the wallet panel just to tick a box. The richest card
      // is the one that can pay for the most fares.
      setSelectedCardId((current) => {
        if (current && next.some((c) => c.id === current)) return current;
        const best = [...next].sort((a, b) => balanceOf(b) - balanceOf(a))[0];
        return best && balanceOf(best) > 0 ? best.id : current;
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<WalletValue>(
    () => ({
      cards,
      cardholder,
      loading,
      error,
      selectedCardId,
      selected: cards.find((c) => c.id === selectedCardId),
      selectCard: setSelectedCardId,
      refresh,
      pendingMandate,
      setPendingMandate,
      issuing,
      setIssuing,
    }),
    [cards, cardholder, loading, error, selectedCardId, refresh, pendingMandate, issuing],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used inside a WalletProvider');
  return ctx;
}
