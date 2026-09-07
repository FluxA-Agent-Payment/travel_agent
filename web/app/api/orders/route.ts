import { NextRequest } from 'next/server';

import { getBookingProvider } from '@/lib/booking';
import { expandTravellers } from '@/lib/travellers';
import {
  FluxaError,
  awaitPayout,
  getMandateStatus,
  isMandateSigned,
  payoutWithMandate,
  settlementAddress,
} from '@/lib/payments/fluxa';
import { chargeWithMandate, deskIdentity, requiresPayerIdentity } from '@/lib/payments/desk';
import { findSettlement, recordSettlement, type Settlement } from '@/lib/payments/ledger';
import { getMandateViaApi } from '@/lib/payments/wallet-api';
import { isBookingError, type Contact, type Passenger } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * Take payment for an order — or don't, if this build settles nothing.
 *
 * Three rails, in preference order:
 *
 *   1. a merchant invoice, when the desk has its own FluxA identity. Two
 *      parties, money genuinely changing hands.
 *   2. a direct payout to a configured address. A real transfer, but from and
 *      to wallets the same person may well own.
 *   3. nothing. The sandbox default, and what `simulatedDeduction` reports.
 *
 * Returns null only for (3). Anything else either returns a recorded
 * settlement or throws — it never returns quietly having failed to charge,
 * because the caller's next act is to issue a ticket.
 */
async function chargeForOrder(params: {
  orderId: string;
  mandateId: string;
  amountUsd: number;
  reference: string;
  /**
   * The payer's FluxA JWT, when the caller has one.
   *
   * Absent, the server's own wallet pays — correct for a desk running a single
   * wallet locally, and the thing that must never happen once this is hosted,
   * because it would bill the operator for a stranger's ticket. The payout
   * rail below has no equivalent and stays single-wallet by construction,
   * which is why a hosted deployment must configure the merchant rail.
   */
  payerJwt?: string;
}): Promise<Settlement | null> {
  // Has this order already been paid for? Asked first, before any rail runs,
  // because a retried or double-submitted request is indistinguishable from a
  // genuine one and the charge cannot be taken back.
  const existing = findSettlement(params.orderId);
  if (existing) return existing;

  // Refuse rather than fall back. Once travellers are meant to pay from their
  // own wallets, a request without one is either a bug or someone else's
  // booking about to be charged to the operator — and both are worse than an
  // error the caller can see.
  if (requiresPayerIdentity() && !params.payerJwt) {
    throw new FluxaError(
      'No FluxA identity for this payment — connect a wallet before paying',
      'payer_required',
    );
  }

  const description = `Flight booking ${params.reference}`;
  const common = {
    orderId: params.orderId,
    amountUsd: params.amountUsd,
    mandateId: params.mandateId,
    settledAt: new Date().toISOString(),
  };

  if (deskIdentity()) {
    const charge = await chargeWithMandate({
      mandateId: params.mandateId,
      amountUsd: params.amountUsd,
      description,
      reference: params.reference,
      payerJwt: params.payerJwt,
    });
    const record: Settlement = { ...common, txHash: charge.txHash, rail: 'payment-link' };
    recordSettlement(record);
    return record;
  }

  const to = settlementAddress();
  if (!to) return null;

  const started = await payoutWithMandate({
    to,
    amountUsd: params.amountUsd,
    payoutId: `flightdesk-${params.orderId}`,
    mandateId: params.mandateId,
    description,
  });
  const final = await awaitPayout(started.payoutId);

  if (final.status !== 'succeeded') {
    // Deliberately thrown rather than returned. A payout still `processing`
    // may yet land, so this must not read as "no charge happened" — it reads
    // as "do not ticket, and go and look".
    throw new FluxaError(
      final.status === 'failed' || final.status === 'expired'
        ? `Payment did not go through — ${final.failureReason ?? final.status}. Nothing has been booked.`
        : `Payment is still settling (${final.status}). Nothing has been booked yet — check the order again shortly.`,
      `payout_${final.status}`,
    );
  }

  const record: Settlement = { ...common, txHash: final.txHash, rail: 'payout' };
  recordSettlement(record);
  return record;
}

/**
 * Place an order from an approved draft, or advance one that has been paid.
 *
 * These are the irreversible operations, and they live here — on a route the
 * human's click reaches and the model's tool schema does not. Nothing the
 * agent can emit reaches this handler.
 *
 * `draft` is the exception and is deliberately safe: it verifies a fare and
 * prices a booking without creating one, so the booking form on a flight card
 * can reach the same approval gate the agent's drafts do. It books nothing.
 */
export async function POST(req: NextRequest) {
  let body: {
    action?: string;
    draftId?: string;
    orderId?: string;
    refundOfferId?: string;
    cardId?: string;
    method?: 'card' | 'deposit';
    mandateId?: string;
    flightId?: string;
    travellerIds?: string[];
    passengers?: Passenger[];
    contact?: Contact;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const booking = getBookingProvider();

  // The payer's FluxA identity, when the caller brought one. Taken from a
  // header rather than the JSON body so it cannot be confused with anything
  // the agent is able to emit — the model has no way to reach this value, and
  // that separation is deliberate.
  const payerJwt = req.headers.get('x-fluxa-jwt')?.trim() || undefined;

  try {
    switch (body.action) {
      case 'draft': {
        // Saved travellers are expanded here rather than sent by the client,
        // so a passport number is never round-tripped through the browser.
        const fromSaved = body.travellerIds?.length
          ? expandTravellers(body.travellerIds)
          : [];
        const passengers = [
          ...fromSaved.map((t) => t.passenger),
          ...(body.passengers ?? []),
        ];
        const contact = body.contact ?? fromSaved[0]?.contact;

        if (!body.flightId || !passengers.length || !contact) {
          return Response.json(
            { error: 'flightId, and either travellerIds or passengers + contact, are required' },
            { status: 400 },
          );
        }
        // Verify first. A search price is indicative, and drafting against a
        // stale one would show the traveller a total the airline will not
        // honour — the same reason the agent must verify before quoting.
        const verified = await booking.verifyFlight(body.flightId);
        const draft = await booking.draftOrder({
          verifiedFlightId: verified.verifiedFlightId,
          passengers,
          contact,
        });
        return Response.json({ draft, priceChanged: verified.priceChanged });
      }

      case 'place': {
        if (!body.draftId) {
          return Response.json({ error: 'draftId is required' }, { status: 400 });
        }
        const order = await booking.placeOrder(body.draftId);
        return Response.json({ order });
      }

      case 'pay': {
        if (!body.orderId) {
          return Response.json({ error: 'orderId is required' }, { status: 400 });
        }

        // The deposit rail settles a fare no card can pay. The traveller still
        // signs a FluxA mandate for the amount, and that signature is checked
        // here rather than trusted from the client — the browser having polled
        // is not evidence. In this sandbox build the deduction against that
        // mandate is deliberately NOT executed; see the note on the response.
        if (body.method === 'deposit') {
          if (!body.mandateId) {
            return Response.json(
              { error: 'A signed FluxA mandate is required to settle this order' },
              { status: 400 },
            );
          }
          // Refused before any wallet is touched. `chargeForOrder` checks this
          // too and is the real backstop, but reaching it means having already
          // looked up a mandate on the wrong wallet — work that cannot succeed
          // and whose failure would read as a mandate problem rather than a
          // missing identity.
          if (requiresPayerIdentity() && !payerJwt) {
            return Response.json(
              {
                error: 'Connect a FluxA wallet before paying — this desk does not pay for you',
                code: 'payer_required',
              },
              { status: 401 },
            );
          }

          // Checked against the payer's own wallet when they have one, so the
          // signature verified is the signature that will be spent. Verifying
          // a mandate on the server's wallet and then charging someone else's
          // would be checking the wrong lock.
          const mandate = payerJwt
            ? await getMandateViaApi({ jwt: payerJwt, mandateId: body.mandateId })
            : await getMandateStatus(body.mandateId);
          if (!isMandateSigned(mandate)) {
            return Response.json(
              {
                error: 'That mandate has not been approved yet — sign it in FluxA first',
                approvalUrl: mandate.approvalUrl,
              },
              { status: 409 },
            );
          }
          // Charge BEFORE ticketing. This rail's claim is "no ticket without
          // payment", so the payment is the gate: if the charge does not land,
          // nothing gets booked.
          const pending = await booking.getOrder(body.orderId);
          const settlement = await chargeForOrder({
            orderId: body.orderId,
            mandateId: body.mandateId,
            amountUsd: pending.totalPrice,
            reference: pending.pnr ?? body.orderId,
            payerJwt,
          });

          const settled = await booking.completePayment(body.orderId, {
            method: 'deposit',
          });
          return Response.json({
            order: settled,
            // Stated on the wire, not just in the UI, so no caller can mistake
            // one for the other. With a desk address configured this is a real
            // on-chain charge and carries its txHash; without one, no money moved.
            simulatedDeduction: !settlement,
            settlement,
          });
        }

        // cardId selects a FluxA virtual card for Atlas VCC pass-through.
        // Backends that settle another way simply ignore it.
        const order = await booking.completePayment(body.orderId, {
          cardId: body.cardId,
        });
        return Response.json({ order });
      }

      case 'refund': {
        if (!body.orderId || !body.refundOfferId) {
          return Response.json(
            { error: 'orderId and refundOfferId are required' },
            { status: 400 },
          );
        }
        const refund = await booking.submitRefund(body.orderId, body.refundOfferId);
        return Response.json({ refund });
      }

      default:
        return Response.json(
          { error: 'action must be one of: draft, place, pay, refund' },
          { status: 400 },
        );
    }
  } catch (err) {
    if (isBookingError(err)) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: err.code === 'not_found' ? 404 : 400 },
      );
    }
    // A wallet failure during settlement — most often too little USDC to cover
    // the fare. It is the traveller's problem to fix, not a server fault, so it
    // gets a 402 and its own message rather than a generic 500.
    if (err instanceof FluxaError) {
      return Response.json(
        { error: err.message, code: err.code, settlementFailed: true },
        { status: 402 },
      );
    }
    return Response.json(
      { error: (err as Error).message ?? 'Unexpected failure' },
      { status: 500 },
    );
  }
}

/** Poll a single order — used by the UI while ticketing settles. */
export async function GET(req: NextRequest) {
  const orderId = req.nextUrl.searchParams.get('orderId');
  const booking = getBookingProvider();

  try {
    if (orderId) {
      return Response.json({ order: await booking.getOrder(orderId) });
    }
    return Response.json({ orders: await booking.listOrders() });
  } catch (err) {
    if (isBookingError(err)) {
      return Response.json({ error: err.message, code: err.code }, { status: 404 });
    }
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
