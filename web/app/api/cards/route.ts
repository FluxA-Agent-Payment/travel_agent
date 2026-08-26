import { NextRequest } from 'next/server';

import {
  FluxaError,
  createCard,
  createCardholder,
  createMandate,
  getCardBalance,
  getCardholder,
  getMandateStatus,
  isMandateSigned,
  listCards,
} from '@/lib/payments/fluxa';

export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * FluxA virtual cards.
 *
 * GET returns card summaries and cardholder status — never a PAN or CVV.
 * Card secrets are read server-side at the moment of payment and go straight
 * to the airline; nothing the browser renders needs them.
 *
 * POST covers the issuance handshake. Note the deliberate split: creating a
 * mandate produces an approval URL the *user* must sign, and only then can a
 * card be issued. That human step is FluxA's design and this route preserves
 * it rather than trying to collapse the two into one call.
 */
export async function GET(req: NextRequest) {
  const cardId = req.nextUrl.searchParams.get('cardId');
  const mandateId = req.nextUrl.searchParams.get('mandateId');

  try {
    if (mandateId) {
      const mandate = await getMandateStatus(mandateId);
      return Response.json({ mandate, signed: isMandateSigned(mandate) });
    }
    if (cardId) {
      return Response.json({ card: await getCardBalance(cardId) });
    }
    const [cards, cardholder] = await Promise.all([
      listCards(),
      getCardholder().catch(() => null),
    ]);
    return Response.json({ cards, cardholder });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  let body: {
    action?: string;
    amountUsd?: number;
    mandateId?: string;
    cardId?: string;
    firstName?: string;
    lastName?: string;
    country?: string;
    /** What the mandate is for. Decides the text the traveller signs. */
    purpose?: 'card' | 'ticket';
    /** PNR or order id, shown in the mandate so it is identifiable. */
    reference?: string;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  try {
    switch (body.action) {
      case 'cardholder-create': {
        if (!body.firstName || !body.lastName) {
          return Response.json(
            { error: 'firstName and lastName are required' },
            { status: 400 },
          );
        }
        const cardholder = await createCardholder({
          firstName: body.firstName,
          lastName: body.lastName,
          country: body.country,
        });
        return Response.json({ cardholder });
      }

      case 'mandate-create': {
        const amount = Number(body.amountUsd);
        if (!Number.isFinite(amount) || amount <= 0) {
          return Response.json({ error: 'A positive amountUsd is required' }, { status: 400 });
        }
        // Cap the blast radius of a mistyped amount. A demo card funding a
        // single fare has no business authorising four figures.
        if (amount > 500) {
          return Response.json(
            { error: 'Refusing to create a mandate above 500 USD' },
            { status: 400 },
          );
        }
        // The description is what the traveller reads on FluxA's approval
        // screen, so it has to describe the thing they are actually approving.
        // A mandate raised to settle a ticket said "Fund a virtual card",
        // which asks for consent to one action while performing another.
        //
        // Composed here from a closed set rather than accepted as free text:
        // a consent string must never be client-controlled prose.
        const reference = String(body.reference ?? '')
          .replace(/[^A-Za-z0-9-]/g, '')
          .slice(0, 24);
        const description =
          body.purpose === 'ticket'
            ? `Pay ${amount.toFixed(2)} USDC for flight booking${reference ? ` ${reference}` : ''}`
            : `Fund a virtual card with ${amount.toFixed(2)} USDC to pay for a flight`;

        const mandate = await createMandate({ description, amountUsd: amount });
        return Response.json({ mandate, signed: isMandateSigned(mandate) });
      }

      case 'card-create': {
        const amount = Number(body.amountUsd);
        if (!body.mandateId || !Number.isFinite(amount) || amount <= 0) {
          return Response.json(
            { error: 'mandateId and a positive amountUsd are required' },
            { status: 400 },
          );
        }
        // Re-check the signature server-side. The client having polled is not
        // evidence — this is the last gate before money moves.
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
        const card = await createCard({ amountUsd: amount, mandateId: body.mandateId });
        return Response.json({ card });
      }

      default:
        return Response.json(
          { error: 'action must be one of: cardholder-create, mandate-create, card-create' },
          { status: 400 },
        );
    }
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  if (err instanceof FluxaError) {
    return Response.json(
      { error: err.message, code: err.code },
      { status: err.code === 'cli_missing' ? 501 : 400 },
    );
  }
  return Response.json(
    { error: (err as Error).message ?? 'FluxA request failed' },
    { status: 500 },
  );
}
