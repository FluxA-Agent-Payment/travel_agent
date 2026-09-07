import { FluxaError, settlementAddress, signX402Payment } from './fluxa';
import { signX402PaymentViaApi, type X402Challenge } from './wallet-api';

/**
 * The desk as a merchant.
 *
 * The other rail in this app — `payoutWithMandate` — pushes money out of the
 * traveller's wallet to an address. That proves a mandate can move money, but
 * both ends are the same person's wallet, so it does not model commerce.
 *
 * This does. The desk holds its own FluxA identity and raises a real invoice;
 * the traveller's wallet settles it against a mandate they signed. Two
 * parties, a receipt on each side, and the money genuinely changes hands.
 *
 * The split of identities is the whole design, and it is easy to get wrong:
 *
 *   - the DESK's credentials create the payment link (who is being paid)
 *   - the TRAVELLER's wallet signs the x402 payment (who is paying)
 *
 * Signing the invoice with the desk's own credentials would have the desk pay
 * itself, which fails silently into looking like success. The two never mix
 * here: the desk half is always HTTP with the desk JWT, and the traveller half
 * is whichever wallet the caller names — their JWT when one is passed, the
 * server's local CLI wallet when none is.
 */

const WALLET_API = process.env.FLUXA_WALLET_API ?? 'https://walletapi.fluxapay.xyz';
const AGENT_ID_API = process.env.FLUXA_AGENT_ID_API ?? 'https://agentid.fluxapay.xyz';

export interface DeskIdentity {
  agentId: string;
  token: string;
  network: string;
}

/** The desk's merchant identity, or null when it has none configured. */
export function deskIdentity(): DeskIdentity | null {
  const agentId = process.env.FLUXA_DESK_AGENT_ID?.trim().replace(/^["']|["']$/g, '');
  const token = process.env.FLUXA_DESK_AGENT_TOKEN?.trim().replace(/^["']|["']$/g, '');
  if (!agentId || !token) return null;
  return {
    agentId,
    token,
    network: process.env.FLUXA_NETWORK?.trim() ?? 'base',
  };
}

/**
 * Whether this build actually takes the traveller's money, by any rail.
 *
 * Single source of truth for it, because the answer is what every "no money
 * moves" string in the UI and the agent's prompt depends on. Working it out
 * separately in each place is how one of them ends up lying after a rail is
 * added — which is exactly what adding the merchant rail would otherwise have
 * done to the copy written for the payout one.
 */
export function settlesRealMoney(): boolean {
  return deskIdentity() !== null || settlementAddress() !== null;
}

/**
 * Whether travellers pay from their own wallets rather than the server's.
 *
 * Read from the same variable the browser reads, so the two halves cannot
 * disagree about which wallet is supposed to be paying.
 *
 * When this is on, a request arriving with no payer identity must be REFUSED,
 * not quietly settled from the desk's wallet. The fallback is a convenience
 * for a single-wallet demo and a way to bill the operator for a stranger's
 * ticket everywhere else, so enabling this turns the fallback off.
 */
export function requiresPayerIdentity(): boolean {
  return process.env.NEXT_PUBLIC_FLUXA_BROWSER_WALLET === 'true';
}

/**
 * Cached desk JWT.
 *
 * Route handlers are compiled as separate module graphs in this app, so this
 * cache is per-graph rather than per-process. That is fine — the worst case is
 * one extra refresh call — but it is the reason this is not treated as a
 * reliable single source of truth anywhere.
 */
let cachedJwt: { value: string; at: number } | null = null;
const JWT_TTL_MS = 20 * 60 * 1000;

async function refreshDeskJwt(desk: DeskIdentity): Promise<string> {
  const res = await fetch(`${AGENT_ID_API}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: desk.agentId, token: desk.token }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.jwt) {
    throw new FluxaError(
      `Could not authenticate the desk with FluxA (${res.status}) — check FLUXA_DESK_AGENT_ID and FLUXA_DESK_AGENT_TOKEN`,
      'desk_auth_failed',
    );
  }
  cachedJwt = { value: String(body.jwt), at: Date.now() };
  return cachedJwt.value;
}

async function deskJwt(desk: DeskIdentity): Promise<string> {
  if (cachedJwt && Date.now() - cachedJwt.at < JWT_TTL_MS) return cachedJwt.value;
  return refreshDeskJwt(desk);
}

/** Desk-authenticated request, refreshing once on a 401 rather than failing. */
async function deskFetch(
  desk: DeskIdentity,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const send = (jwt: string) =>
    fetch(`${WALLET_API}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
        Authorization: `Bearer ${jwt}`,
      },
    });

  let res = await send(await deskJwt(desk));
  if (res.status === 401) {
    cachedJwt = null;
    res = await send(await refreshDeskJwt(desk));
  }
  return res;
}

export interface PaymentLink {
  linkId: string;
  url: string;
}

/**
 * Raise an invoice for a fare.
 *
 * `maxUses: 1` is load-bearing rather than tidy: a reusable link is a standing
 * claim on the traveller's mandate, and this one is settled exactly once.
 */
export async function createPaymentLink(params: {
  amountUsd: number;
  description: string;
  reference: string;
  expiresHours?: number;
}): Promise<PaymentLink> {
  const desk = deskIdentity();
  if (!desk) throw new FluxaError('The desk has no FluxA identity configured', 'no_desk');

  const expiresAt = new Date(
    Date.now() + (params.expiresHours ?? 24) * 3_600_000,
  ).toISOString();

  const res = await deskFetch(desk, '/api/payment-links', {
    method: 'POST',
    body: JSON.stringify({
      amount: String(Math.round(params.amountUsd * 1_000_000)),
      currency: 'USDC',
      network: desk.network,
      description: params.description,
      resourceContent: JSON.stringify({
        service: 'flight-desk',
        booking: params.reference,
      }),
      expiresAt,
      maxUses: 1,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new FluxaError(
      `Could not raise an invoice for this booking (${res.status}): ${body?.error ?? body?.message ?? 'unknown error'}`,
      'link_failed',
    );
  }
  const link = body.paymentLink ?? body;
  if (!link?.linkId || !link?.url) {
    throw new FluxaError('FluxA returned a payment link with no id or url', 'link_malformed');
  }
  return { linkId: String(link.linkId), url: String(link.url) };
}

export interface DeskCharge {
  linkId: string;
  txHash?: string | null;
  amountUsd: number;
}

/**
 * Charge the traveller for a booking: invoice, then settle against a mandate.
 *
 * The four steps are FluxA's x402 flow and are not interchangeable — the 402
 * challenge carries the amount, asset and payee the payment must be signed
 * over, so it has to be fetched rather than reconstructed. Signing anything we
 * assembled ourselves would be signing over numbers the merchant never
 * asserted.
 */
export async function chargeWithMandate(params: {
  mandateId: string;
  amountUsd: number;
  description: string;
  reference: string;
  /**
   * The payer's own FluxA JWT.
   *
   * Supplied, the invoice is settled from that person's wallet over HTTP —
   * the only correct behaviour for a hosted deployment, where the traveller
   * is not the operator. Omitted, it falls back to the server's local CLI
   * wallet, which is right for a desk running its own single wallet and
   * wrong for everyone else. Hosted callers must always pass this.
   */
  payerJwt?: string;
}): Promise<DeskCharge> {
  const desk = deskIdentity();
  if (!desk) throw new FluxaError('The desk has no FluxA identity configured', 'no_desk');

  // 1. The desk raises the invoice, as itself.
  const link = await createPaymentLink({
    amountUsd: params.amountUsd,
    description: params.description,
    reference: params.reference,
  });

  // 2. Fetch the 402 challenge. A link that does not answer 402 is not asking
  //    for money, and paying it would be paying for nothing.
  const challengeRes = await fetch(link.url);
  if (challengeRes.status !== 402) {
    throw new FluxaError(
      `Invoice ${link.linkId} did not ask for payment (HTTP ${challengeRes.status})`,
      'no_challenge',
    );
  }
  const challenge: X402Challenge = await challengeRes.json();
  if (!Array.isArray(challenge?.accepts) || challenge.accepts.length === 0) {
    throw new FluxaError('Invoice carried no payment options', 'no_accepts');
  }

  // 3. The TRAVELLER's wallet signs it, against the mandate they signed.
  const xPayment = params.payerJwt
    ? await signX402PaymentViaApi({
        jwt: params.payerJwt,
        mandateId: params.mandateId,
        challenge,
        network: desk.network,
      })
    : await signX402Payment({ mandateId: params.mandateId, challenge });

  // 4. Present the proof of payment back to the invoice to settle it.
  const settleRes = await fetch(link.url, { headers: { 'X-Payment': xPayment } });
  const settled = await settleRes.json().catch(() => ({}));

  if (!settleRes.ok || settled?.status !== 'success') {
    throw new FluxaError(
      `Payment was signed but did not settle: ${settled?.error ?? settled?.reason ?? `HTTP ${settleRes.status}`}`,
      'settle_failed',
    );
  }

  return {
    linkId: link.linkId,
    txHash: settled.receipt?.txHash ?? null,
    amountUsd: params.amountUsd,
  };
}
