'use client';

import { OrderCard, RefundCard } from './ToolCards';

import type { Order, RefundQuote } from '@/lib/types';

/**
 * Bookings, and everything you can do to one after it exists.
 *
 * This is the management half of the product, kept apart from search so that
 * shopping and administering a trip do not compete for the same column. It is
 * the only place orders are drawn: check_order and list_orders no longer
 * render cards of their own, because two renderers for "what state is my
 * booking in" is how a screen ends up contradicting itself.
 *
 * Orders live in server process memory (see lib/store.ts), so a restart empties
 * this. That is a demo constraint, and it is said on screen rather than left
 * for someone to discover as an apparently lost booking.
 */
export function TripsPanel({
  orders,
  loading,
  error,
  onReload,
  refundQuotes,
  onEvent,
}: {
  orders: Order[];
  loading: boolean;
  error: string | null;
  onReload: () => void;
  /** Refund quotes the agent produced; each carries its own approval gate. */
  refundQuotes: RefundQuote[];
  onEvent: (message: string) => void;
}) {
  return (
    <div className="trips">
      <div className="pane-head">
        <span>
          {orders.length === 1 ? '1 booking' : `${orders.length} bookings`}
        </span>
        <button className="linkish" onClick={onReload}>
          refresh
        </button>
      </div>

      {loading && !orders.length ? <p className="note">Loading bookings…</p> : null}
      {error ? <p className="note bad">{error}</p> : null}

      {!loading && !orders.length && !error ? (
        <div className="pane-empty">
          <div className="pane-empty-mark">🎫</div>
          <p>
            Bookings appear here once you approve one. Pay, follow ticketing and
            request a refund from this tab.
          </p>
        </div>
      ) : null}

      {orders.map((o) => (
        <div className="pane-item" key={o.orderId}>
          <OrderCard data={o} onEvent={onEvent} />
        </div>
      ))}

      {refundQuotes.map((q, i) => (
        <div className="pane-item" key={`${q.orderId}-${q.refundOfferId}-${i}`}>
          <RefundCard data={q} onEvent={onEvent} />
        </div>
      ))}

      {orders.length ? (
        <p className="note">
          Bookings are held in the server&rsquo;s memory for this demo, so
          restarting it clears this list. The order still exists at the airline.
        </p>
      ) : null}
    </div>
  );
}
