import { hasDatabase, query, queryOne } from './db';

/**
 * Who a booking belongs to.
 *
 * The booking provider keeps orders in a map keyed by order id and has no idea
 * who made any of them, which was fine when the only person who could reach
 * the server was the person running it. Hosted, it meant `listOrders` handed
 * every visitor everyone else's bookings — names, PNRs, routes.
 *
 * Rather than rewrite the provider to carry an owner through every call, the
 * relationship lives here and is applied at the edge. The provider still knows
 * nothing about accounts; the routes decide what a given person may see.
 *
 * An order with no row here belongs to nobody and is shown to nobody. That is
 * the safe direction: bookings made before this existed become invisible
 * rather than public.
 */

export async function claimOrder(orderId: string, userId: string): Promise<void> {
  await query(
    `INSERT INTO order_owners (order_id, user_id) VALUES ($1, $2)
     ON CONFLICT (order_id) DO NOTHING`,
    [orderId, userId],
  );
}

/** The order ids belonging to one person. */
export async function orderIdsFor(userId: string): Promise<Set<string>> {
  const rows = await query<{ order_id: string }>(
    `SELECT order_id FROM order_owners WHERE user_id = $1`,
    [userId],
  );
  return new Set(rows.map((r) => r.order_id));
}

/**
 * Whether this person may see this booking.
 *
 * False when nobody is signed in, when the order has no owner, and when it
 * belongs to somebody else — three different situations that all mean the same
 * thing to the caller, and none of which should be distinguishable from
 * outside. Telling an attacker apart "no such order" from "not yours" confirms
 * the order exists.
 */
export async function ownsOrder(
  orderId: string,
  userId: string | null,
): Promise<boolean> {
  if (!userId) return false;
  const row = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM order_owners WHERE order_id = $1`,
    [orderId],
  );
  return row?.user_id === userId;
}

/**
 * Whether bookings are scoped to accounts at all.
 *
 * Without a database there is nowhere to record ownership, so a deployment in
 * that state cannot separate one person's bookings from another's. It is a
 * single-user desk by definition, and the routes fall back to the old
 * behaviour rather than showing an empty list nobody can explain.
 */
export function scopingAvailable(): boolean {
  return hasDatabase();
}
