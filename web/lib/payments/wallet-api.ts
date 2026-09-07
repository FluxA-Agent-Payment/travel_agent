import { FluxaError, type Mandate } from './fluxa';

/**
 * FluxA over HTTP, on behalf of whoever holds the JWT.
 *
 * The CLI module beside this one can only ever act as one wallet — the one
 * `FLUXA_DATA_DIR` points at, on the server. That is correct for a desk
 * operating its own wallet and completely wrong for a hosted service, where
 * the wallet being spent from belongs to the visitor, not to us.
 *
 * So every function here takes the payer's JWT as an argument rather than
 * reading an ambient identity. There is no default and no fallback to the
 * server's wallet: a missing JWT is an error, never "use ours". That is the
 * one property that keeps a hosted deployment from billing the operator for
 * a stranger's booking.
 *
 * We never mint these JWTs from a stored secret. They arrive per request from
 * a browser that registered its own FluxA agent, which is what keeps this a
 * payment path rather than custody of anyone's wallet.
 */

const WALLET_API = process.env.FLUXA_WALLET_API ?? 'https://walletapi.fluxapay.xyz';
const AGENT_ID_API = process.env.FLUXA_AGENT_ID_API ?? 'https://agentid.fluxapay.xyz';

/** The x402 challenge a merchant's 402 response carries. */
export interface X402Challenge {
  x402Version?: number;
  accepts: Array<{
    scheme?: string;
    network?: string;
    maxAmountRequired: string;
    resource: string;
    description?: string;
    payTo: string;
    asset?: string;
    maxTimeoutSeconds?: number;
    extra?: { name?: string; version?: string };
  }>;
}

async function walletFetch(
  jwt: string,
  path: string,
  init: RequestInit = {},
): Promise<any> {
  if (!jwt) {
    throw new FluxaError('No FluxA identity for this request', 'no_payer_jwt');
  }
  const res = await fetch(`${WALLET_API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
      Authorization: `Bearer ${jwt}`,
    },
  });
  const body = await res.json().catch(() => ({}));

  // A brand-new agent can create a mandate but cannot read one until the
  // person it belongs to has linked a wallet to it. FluxA says so precisely,
  // and the distinction matters: this is a step the traveller has not finished
  // yet, not a broken session. Conflating the two sends the browser off to
  // refresh a perfectly good token, forever.
  if (body?.code === 'agent_not_authorized') {
    throw new FluxaError(
      'This FluxA agent is not linked to a wallet yet — approve it in FluxA first',
      'agent_not_authorized',
    );
  }
  if (res.status === 401) {
    // Its own code so the caller refreshes rather than reporting a payment
    // failure. A token expiring is not a payment being refused.
    throw new FluxaError(
      'That FluxA session has expired — refresh it and try again',
      'jwt_expired',
    );
  }
  if (res.status === 403) {
    throw new FluxaError(
      body?.message ?? 'FluxA refused that request',
      'forbidden',
    );
  }
  if (!res.ok) {
    throw new FluxaError(
      body?.error ?? body?.message ?? `FluxA returned ${res.status}`,
      'wallet_api_error',
    );
  }
  return body;
}

/**
 * Whether an agent has been adopted into somebody's wallet.
 *
 * There is no endpoint that answers this directly. Listing mandates is the
 * call FluxA rejects with 403 while an agent is unlinked, so that rejection is
 * the signal — the same way the wallet CLI decides it. Anything other than a
 * clean 200 or a 403 is a real failure and is raised rather than reported as
 * "not linked", which would send the traveller to relink a wallet that was
 * never the problem.
 */
export async function isAgentLinked(jwt: string): Promise<boolean> {
  if (!jwt) throw new FluxaError('No FluxA identity for this request', 'no_payer_jwt');
  const res = await fetch(`${WALLET_API}/api/mandates`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (res.ok) return true;
  if (res.status === 403) return false;
  throw new FluxaError(
    `Could not check wallet linkage (${res.status})`,
    'link_check_failed',
  );
}

/** Mint a JWT from an agent's long-lived credentials. */
export async function refreshAgentJwt(agentId: string, token: string): Promise<string> {
  const res = await fetch(`${AGENT_ID_API}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, token }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.jwt) {
    throw new FluxaError(`Could not refresh that FluxA session (${res.status})`, 'refresh_failed');
  }
  return String(body.jwt);
}

function toMandate(raw: any): Mandate {
  const m = raw?.mandate ?? (Array.isArray(raw?.mandates) ? raw.mandates[0] : raw);
  return {
    id: m?.id ?? m?.mandateId,
    // `create-intent` answers { status: 'ok', mandateId, authorizationUrl } —
    // that 'ok' is the CALL succeeding, not the mandate's own state, and
    // carrying it through would report a brand-new unsigned mandate as though
    // 'ok' meant something about it. A fresh mandate is awaiting signature;
    // say that instead of repeating the envelope.
    status: m?.status === 'ok' ? 'pending_signature' : m?.status,
    approvalUrl: m?.approvalUrl ?? m?.authorizationUrl ?? m?.signUrl ?? null,
    limitAmountFormatted: m?.limitAmountFormatted,
    remainingAmountFormatted: m?.remainingAmountFormatted,
    signedAt: m?.signedAt ?? null,
    validUntil: m?.validUntil,
  };
}

/**
 * Create a mandate on the payer's own wallet.
 *
 * Exposed for callers that cannot reach FluxA directly. A browser should
 * create its own mandates against `walletapi` rather than routing them through
 * us — the fewer parties between a person and the thing they are authorising,
 * the better — but a server-side caller needs this.
 */
export async function createMandateViaApi(params: {
  jwt: string;
  description: string;
  amountUsd: number;
  seconds?: number;
  category?: string;
}): Promise<Mandate> {
  const body = await walletFetch(params.jwt, '/api/mandates/create-intent', {
    method: 'POST',
    body: JSON.stringify({
      intent: {
        naturalLanguage: params.description,
        category: params.category ?? 'general',
        currency: 'USDC',
        limitAmount: String(Math.round(params.amountUsd * 1_000_000)),
        validForSeconds: params.seconds ?? 3600,
        hostAllowlist: [],
      },
    }),
  });
  return toMandate(body);
}

export async function getMandateViaApi(params: {
  jwt: string;
  mandateId: string;
}): Promise<Mandate> {
  return toMandate(
    await walletFetch(params.jwt, `/api/mandates/agent/${encodeURIComponent(params.mandateId)}`),
  );
}

/**
 * Sign an x402 payment against a mandate, returning the `X-Payment` blob.
 *
 * The signed values are taken from the challenge rather than from our own
 * request, so what gets signed is what the merchant actually asked for. The
 * one exception is `network`: the 402 reports it in CAIP form (`eip155:8453`)
 * while this endpoint expects the plain name, so it is passed separately
 * instead of echoed back.
 */
export async function signX402PaymentViaApi(params: {
  jwt: string;
  mandateId: string;
  challenge: X402Challenge;
  network?: string;
}): Promise<string> {
  const accept = params.challenge?.accepts?.[0];
  if (!accept) {
    throw new FluxaError('That invoice carried no payment options', 'no_accepts');
  }

  const body = await walletFetch(params.jwt, '/api/payment/x402V3Payment', {
    method: 'POST',
    body: JSON.stringify({
      mandateId: params.mandateId,
      scheme: accept.scheme ?? 'exact',
      network: params.network ?? process.env.FLUXA_NETWORK ?? 'base',
      amount: accept.maxAmountRequired,
      currency: 'USDC',
      assetAddress: accept.asset,
      payTo: accept.payTo,
      host: new URL(WALLET_API).host,
      resource: `${WALLET_API}${accept.resource}`,
      description: accept.description ?? '',
      tokenName: accept.extra?.name ?? 'USD Coin',
      tokenVersion: accept.extra?.version ?? '2',
      validityWindowSeconds: accept.maxTimeoutSeconds ?? 60,
    }),
  });

  const blob = body?.xPaymentB64 ?? body?.xPayment ?? body?.payment;
  if (!blob) {
    throw new FluxaError('FluxA returned no X-Payment blob', 'x402_no_payment');
  }
  return String(blob);
}
