'use client';

import { isInFlight } from '@/hooks/useOrders';

import type { Order } from '@/lib/types';

/**
 * A one-line dock for orders that are still moving.
 *
 * Payment and ticketing resolve over minutes, and the previous design reported
 * that as a full card in the results stream — pushing the flights you were
 * shopping for off screen to say one word. A strip says the word and stays out
 * of the way.
 *
 * Renders nothing when nothing is in flight, so a settled screen is quiet.
 */

const WORDING: Record<string, string> = {
  pending_payment: 'awaiting payment',
  paying: 'charging card',
  paid: 'paid, awaiting the airline',
  ticketing: 'ticketing',
};

export function StatusStrip({
  orders,
  onOpen,
}: {
  orders: Order[];
  onOpen: () => void;
}) {
  const live = orders.filter(isInFlight);
  if (!live.length) return null;

  return (
    <div className="statusdock">
      {live.slice(0, 2).map((o) => (
        <button className="statusrow" key={o.orderId} onClick={onOpen}>
          <span className="statusrow-dot" aria-hidden="true" />
          <span className="statusrow-ref">{o.pnr ?? o.orderId.slice(0, 10)}</span>
          <span className="statusrow-state">{WORDING[o.status] ?? o.status}</span>
          <span className="statusrow-amt">{o.totalPrice.toFixed(2)}</span>
          <span className="statusrow-go">open →</span>
        </button>
      ))}
      {live.length > 2 ? (
        <button className="statusrow more" onClick={onOpen}>
          and {live.length - 2} more
        </button>
      ) : null}
    </div>
  );
}
