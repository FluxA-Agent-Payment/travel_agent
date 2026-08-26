'use client';

import { useState } from 'react';

import { balanceOf, useWallet } from '@/components/providers/WalletProvider';

/**
 * FluxA wallet: the cards available to pay with, and how to open a new one.
 *
 * Card state lives in WalletProvider rather than here, because an order card
 * needs the same balances to decide whether it can offer to charge one.
 */
export function WalletPanel() {
  const wallet = useWallet();
  const [error, setError] = useState<string | null>(null);

  async function setupCardholder() {
    setError(null);
    try {
      const res = await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'cardholder-create',
          firstName: 'Flight',
          lastName: 'Desk',
          country: 'US',
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Request failed');
      await wallet.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const { cards, cardholder, loading } = wallet;

  return (
    <div className="card wallet">
      <div className="card-head">
        <span>FluxA wallet</span>
        {/* A failed load is not evidence of absence — saying "no cardholder"
            when the request never arrived sends the user to create one they
            already have. */}
        {cardholder ? (
          <span className="pill ok">{cardholder.name ?? 'cardholder set'}</span>
        ) : wallet.error ? (
          <span className="pill bad">unavailable</span>
        ) : loading ? (
          <span className="pill">checking…</span>
        ) : (
          <span className="pill warn">no cardholder</span>
        )}
      </div>

      <div className="card-body">
        {loading ? <p className="note">Loading cards…</p> : null}

        {!loading && !cardholder && !wallet.error ? (
          <>
            <p className="note">
              A cardholder must exist before any card can be issued. It is
              created once and shared by every agent on this wallet.
            </p>
            <div className="actions">
              <button onClick={setupCardholder}>Create cardholder</button>
            </div>
          </>
        ) : null}

        {cards.length > 0 ? (
          <div className="cardlist">
            {cards.map((c) => {
              const selected = c.id === wallet.selectedCardId;
              const spent = balanceOf(c) === 0;
              return (
                <button
                  key={c.id}
                  className={`cardrow ${selected ? 'selected' : ''}`}
                  onClick={() => wallet.selectCard(c.id)}
                  title={c.id}
                >
                  <span className="cardrow-brand">{c.brand ?? 'card'}</span>
                  <span className="cardrow-pan">•••• {c.last4 ?? '????'}</span>
                  <span className="cardrow-exp">
                    {c.expiryMonth}/{String(c.expiryYear ?? '').slice(-2)}
                  </span>
                  <span
                    className={`cardrow-bal ${spent ? 'spent' : ''}`}
                    title={c.funded ? `Loaded $${c.funded}` : undefined}
                  >
                    ${balanceOf(c).toFixed(2)}
                    {c.funded && Number(c.funded) !== balanceOf(c) ? (
                      <span className="cardrow-funded">
                        {' '}
                        / {Number(c.funded).toFixed(2)}
                      </span>
                    ) : null}
                  </span>
                  {selected ? <span className="pill ok">paying with</span> : null}
                </button>
              );
            })}
          </div>
        ) : !loading && cardholder ? (
          <p className="note">
            No cards yet. One can be opened from the pay button when you book.
          </p>
        ) : null}

        {/* Issuance deliberately does not live here. Opening a card is only
            ever wanted at the moment of paying for something, so it belongs on
            the pay control where the amount is already known — not in a menu
            you have to visit first. */}
        {error ? <p className="note bad">{error}</p> : null}
        {wallet.error ? (
          <>
            <p className="note bad">{wallet.error}</p>
            <div className="actions">
              <button onClick={() => void wallet.refresh()}>Try again</button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
