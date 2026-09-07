import { NextRequest } from 'next/server';

import { FluxaError } from '@/lib/payments/fluxa';
import { createMandateViaApi, getMandateViaApi, isAgentLinked } from '@/lib/payments/wallet-api';

export const runtime = 'nodejs';

/**
 * The traveller's own wallet, reached through us.
 *
 * The browser would rather call FluxA directly — a mandate is the sentence
 * someone is agreeing to, and the fewer parties between them and it the
 * better. FluxA's wallet API refuses the cross-origin preflight from any
 * origin it has not allowlisted, so that is not available to us and this
 * proxy exists instead.
 *
 * What it does NOT change is who pays. Every call here is made with the
 * caller's own JWT, which arrives per request and is never stored. Without
 * one there is nothing to fall back on: this route has no wallet of its own
 * and cannot act for anybody. It is a hop, not an identity.
 *
 * The proxy is deliberately not general. Two named operations, no arbitrary
 * path or method — a passthrough taking a URL from the client would let a
 * visitor aim our server at anything, using their token as the excuse.
 */

function payerJwt(req: NextRequest): string | null {
  return req.headers.get('x-fluxa-jwt')?.trim() || null;
}

function unauthenticated() {
  return Response.json(
    { error: 'No FluxA identity on this request', code: 'payer_required' },
    { status: 401 },
  );
}

function failure(err: unknown) {
  if (err instanceof FluxaError) {
    // 409 for the agent that has not been linked to a wallet yet: the request
    // was well formed and the token is good, there is simply a step the
    // traveller has not done. Polling treats it as "still waiting", so it must
    // not arrive looking like a broken session.
    const status =
      err.code === 'jwt_expired' ? 401 : err.code === 'agent_not_authorized' ? 409 : 400;
    return Response.json({ error: err.message, code: err.code }, { status });
  }
  return Response.json({ error: (err as Error).message }, { status: 500 });
}

/** Read one of the caller's mandates. */
export async function GET(req: NextRequest) {
  const jwt = payerJwt(req);
  if (!jwt) return unauthenticated();

  // Has this agent been adopted into a wallet yet? Deliberately answered as
  // a plain boolean rather than an error: before linking, "no" is the normal
  // state of a brand-new visitor, not a fault.
  if (req.nextUrl.searchParams.get('probe') === 'linked') {
    try {
      return Response.json({ linked: await isAgentLinked(jwt) });
    } catch (err) {
      return failure(err);
    }
  }

  const mandateId = req.nextUrl.searchParams.get('mandateId');
  if (!mandateId) {
    return Response.json({ error: 'mandateId is required' }, { status: 400 });
  }

  try {
    return Response.json({ mandate: await getMandateViaApi({ jwt, mandateId }) });
  } catch (err) {
    return failure(err);
  }
}

export async function POST(req: NextRequest) {
  const jwt = payerJwt(req);
  if (!jwt) return unauthenticated();

  let body: { action?: string; amountUsd?: number; reference?: string; seconds?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.action !== 'mandate-create') {
    return Response.json({ error: 'action must be: mandate-create' }, { status: 400 });
  }

  const amount = Number(body.amountUsd);
  if (!Number.isFinite(amount) || amount <= 0) {
    return Response.json({ error: 'A positive amountUsd is required' }, { status: 400 });
  }
  // Caps a mistyped or tampered amount. The traveller would still have to sign
  // it, but a mandate is easier to approve than to read closely.
  if (amount > 500) {
    return Response.json({ error: 'Refusing to create a mandate above 500 USD' }, { status: 400 });
  }

  // The consent sentence is composed here, from a closed template and a
  // sanitised reference — never from prose the client supplied. A description
  // an attacker can write is not consent, and this is the screen the traveller
  // reads before authorising money.
  const reference = String(body.reference ?? '')
    .replace(/[^A-Za-z0-9-]/g, '')
    .slice(0, 24);
  const description = `Pay ${amount.toFixed(2)} USDC for flight booking${
    reference ? ` ${reference}` : ''
  }`;

  try {
    const mandate = await createMandateViaApi({
      jwt,
      description,
      amountUsd: amount,
      seconds: body.seconds,
    });
    return Response.json({ mandate });
  } catch (err) {
    return failure(err);
  }
}
