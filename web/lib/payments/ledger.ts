import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * A record of every settlement this desk has taken, keyed by order.
 *
 * This exists for exactly one reason: a charge is irreversible, and every
 * other guard in the payment path is advisory. A double-clicked button, a
 * retried fetch, a browser reload mid-settlement — each of them arrives at the
 * server as a second, entirely valid-looking request to charge for a booking
 * that has already been paid for.
 *
 * So the order id is the idempotency key, checked before money moves and
 * written after it has. It is on disk rather than in memory because a restart
 * between the charge and the retry is precisely when the memory would be gone
 * and the traveller would be billed twice.
 *
 * It is not an accounting system. It answers one question — has this order
 * already been settled, and with what evidence — and nothing else.
 */

export interface Settlement {
  orderId: string;
  amountUsd: number;
  /** On-chain evidence. Absent when the rail could not produce one. */
  txHash?: string | null;
  /** Which rail took the money: a direct payout, or a merchant invoice. */
  rail: 'payout' | 'payment-link';
  /** The mandate the traveller signed to authorise it. */
  mandateId: string;
  settledAt: string;
}

const FILE = join(process.cwd(), '.data', 'settlements.json');

function readAll(): Record<string, Settlement> {
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A missing ledger means nothing has been settled yet. An unreadable one
    // is treated the same way deliberately: see the note in `recordSettlement`
    // about which direction this fails in.
    return {};
  }
}

/** The settlement for an order, or null if it has never been charged. */
export function findSettlement(orderId: string): Settlement | null {
  return readAll()[orderId] ?? null;
}

/**
 * Record a completed charge.
 *
 * Written immediately after the money moves and before anything else can
 * fail, because the window between "charged" and "recorded" is the window in
 * which a retry double-charges.
 *
 * A write failure throws rather than being swallowed. Losing this record is
 * worse than failing the request: the charge has already happened, and a
 * caller who sees an error will at least look, where one who sees success
 * would go on to charge again.
 */
export function recordSettlement(entry: Settlement): void {
  const all = readAll();
  all[entry.orderId] = entry;
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(all, null, 2), 'utf8');
}
