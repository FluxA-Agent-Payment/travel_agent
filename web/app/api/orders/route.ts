import { NextRequest } from 'next/server';

import { getBookingProvider } from '@/lib/booking';
import { expandTravellers } from '@/lib/travellers';
import { getMandateStatus, isMandateSigned } from '@/lib/payments/fluxa';
import { isBookingError, type Contact, type Passenger } from '@/lib/types';

export const runtime = 'nodejs';

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
          const mandate = await getMandateStatus(body.mandateId);
          if (!isMandateSigned(mandate)) {
            return Response.json(
              {
                error: 'That mandate has not been approved yet — sign it in FluxA first',
                approvalUrl: mandate.approvalUrl,
              },
              { status: 409 },
            );
          }
          const settled = await booking.completePayment(body.orderId, {
            method: 'deposit',
          });
          return Response.json({
            order: settled,
            // Stated on the wire, not just in the UI, so no caller can mistake
            // this for a completed charge.
            simulatedDeduction: true,
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
