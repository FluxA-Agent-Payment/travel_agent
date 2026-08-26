'use client';

import { useCallback, useEffect, useState } from 'react';

import type { Order } from '@/lib/types';

/** States that are still moving, and so worth re-polling. */
const IN_FLIGHT = new Set(['pending_payment', 'paying', 'paid', 'ticketing']);

export function isInFlight(order: Order): boolean {
  return IN_FLIGHT.has(order.status);
}

/**
 * The traveller's bookings, fetched once for everything that needs them.
 *
 * Three separate consumers want this list — the Trips tab, the status dock,
 * and the tab badge. Each fetching independently would mean three pollers
 * against the same endpoint and three chances to render a different answer to
 * "what state is my booking in", so it is fetched here and passed down.
 *
 * Polling runs only while something is actually in flight. Ticketing settles
 * asynchronously over a minute or two; a list of settled trips needs no timer.
 */
export function useOrders(reloadKey: number) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/orders', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not load bookings');
      setOrders(body.orders ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  const anyInFlight = orders.some(isInFlight);
  useEffect(() => {
    if (!anyInFlight) return;
    const timer = setInterval(() => void reload(), 15_000);
    return () => clearInterval(timer);
  }, [anyInFlight, reload]);

  return { orders, loading, error, reload };
}
