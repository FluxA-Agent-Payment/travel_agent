/**
 * The traveller's own FluxA identity, held in their browser.
 *
 * Every payment path before this one spent the server's wallet, because there
 * was only ever one traveller and they owned the server. Hosted, that is the
 * wrong shape: the person booking is not the operator, and charging the
 * operator's wallet for a stranger's ticket is the failure mode the whole
 * design has to exclude.
 *
 * So the visitor registers their *own* FluxA agent, here, in the browser. The
 * server never sees the token that identity is built on — only a short-lived
 * JWT, per request, which is enough to settle an invoice the visitor has
 * signed a mandate for and nothing else.
 *
 * Mandates are created directly against FluxA rather than through our API on
 * purpose. A mandate is the sentence a person is agreeing to; the fewer
 * parties standing between them and it, the less there is to trust.
 *
 * ONE DELIBERATE OMISSION: the agent token is kept in localStorage and is not
 * mirrored to our server. Ava does mirror it, so a user's payment identity
 * survives changing browsers — but that token can mint their JWT and spend
 * inside any mandate they have signed, so storing it is custody of a spending
 * credential. That may well be the right trade later; it should be a decision
 * someone makes on purpose, not one inherited by copying. Until then, a new
 * browser means a new agent.
 */

const AGENT_ID_KEY = 'flightdesk.fluxa.agentId';
const TOKEN_KEY = 'flightdesk.fluxa.agentToken';
const JWT_KEY = 'flightdesk.fluxa.jwt';

const AGENT_ID_API =
  process.env.NEXT_PUBLIC_FLUXA_AGENT_ID_API ?? 'https://agentid.fluxapay.xyz';
const WALLET_API =
  process.env.NEXT_PUBLIC_FLUXA_WALLET_API ?? 'https://walletapi.fluxapay.xyz';

const isBrowser = typeof window !== 'undefined';

/**
 * Whether the traveller pays from their own wallet.
 *
 * Off, the server's wallet pays — correct when the desk runs a single wallet
 * locally, and the reason this is opt-in rather than automatic: a hosted
 * deployment must turn it on deliberately, and a local demo keeps working
 * untouched.
 */
export function browserWalletEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FLUXA_BROWSER_WALLET === 'true';
}

export interface BrowserMandate {
  id: string;
  status?: string;
  approvalUrl?: string | null;
  signedAt?: string | null;
}

export class FluxaBrowserError extends Error {
  constructor(
    message: string,
    public code = 'fluxa_browser_error',
  ) {
    super(message);
    this.name = 'FluxaBrowserError';
  }
}

/* ---------- identity ---------- */

function read(key: string): string | null {
  if (!isBrowser) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    // Private browsing and blocked storage both throw. Treated as "no identity
    // yet" so the caller registers a fresh one rather than crashing.
    return null;
  }
}

function write(key: string, value: string): void {
  if (!isBrowser) return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — the identity lasts this page only */
  }
}

export function getAgentId(): string | null {
  return read(AGENT_ID_KEY);
}

export function getJwt(): string | null {
  return read(JWT_KEY);
}

/** Forget this browser's FluxA identity. The wallet behind it is untouched. */
export function clearIdentity(): void {
  if (!isBrowser) return;
  for (const key of [AGENT_ID_KEY, TOKEN_KEY, JWT_KEY]) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing to do */
    }
  }
}

/**
 * True when a JWT is expired, or close enough that a request would race it.
 *
 * The buffer matters: a token with four seconds left passes a naive check and
 * then fails mid-payment, which is the worst moment to discover it.
 */
function isJwtExpired(jwt: string, bufferSeconds = 60): boolean {
  try {
    const [, payload] = jwt.split('.');
    if (!payload) return true;
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (!decoded.exp) return true;
    return decoded.exp <= Math.floor(Date.now() / 1000) + bufferSeconds;
  } catch {
    return true;
  }
}

/** Register a fresh FluxA agent for this browser. */
async function registerAgent(): Promise<string> {
  const unique = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const res = await fetch(`${AGENT_ID_API}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `flightdesk_${unique}@flightdesk.local`,
      agent_name: `FlightDesk-${unique.slice(-8)}`,
      client_info: isBrowser ? window.location.origin : 'flight-desk',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.token || !body?.jwt) {
    throw new FluxaBrowserError(
      body?.error ?? `Could not create a FluxA identity (${res.status})`,
      'register_failed',
    );
  }
  if (body.agent_id) write(AGENT_ID_KEY, String(body.agent_id));
  write(TOKEN_KEY, String(body.token));
  write(JWT_KEY, String(body.jwt));
  return String(body.jwt);
}

async function refreshJwt(): Promise<string> {
  const agentId = getAgentId();
  const token = read(TOKEN_KEY);
  if (!agentId || !token) return registerAgent();

  const res = await fetch(`${AGENT_ID_API}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, token }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.jwt) {
    // Credentials the service no longer recognises are worse than none: they
    // fail every call until cleared. Start over rather than retrying them.
    clearIdentity();
    return registerAgent();
  }
  write(JWT_KEY, String(body.jwt));
  return String(body.jwt);
}

/** A usable JWT for this browser's FluxA identity, registering one if needed. */
export async function ensureAuthenticated(): Promise<string> {
  const existing = getJwt();
  if (existing && !isJwtExpired(existing)) return existing;
  if (getAgentId() && read(TOKEN_KEY)) return refreshJwt();
  return registerAgent();
}

/* ---------- mandates ---------- */

function toMandate(raw: any): BrowserMandate {
  const m = raw?.mandate ?? (Array.isArray(raw?.mandates) ? raw.mandates[0] : raw);
  return {
    id: m?.mandateId ?? m?.id,
    status: m?.status,
    approvalUrl: m?.authorizationUrl ?? m?.approvalUrl ?? m?.signUrl ?? null,
    signedAt: m?.signedAt ?? null,
  };
}

/** Statuses meaning the mandate can no longer fund anything. */
const DEAD = new Set(['expired', 'revoked', 'cancelled', 'consumed']);

/** True once signed and still spendable. Mirrors the server's rule exactly. */
export function isSigned(m: BrowserMandate | null): boolean {
  if (!m) return false;
  const status = m.status ?? '';
  if (DEAD.has(status)) return false;
  return Boolean(m.signedAt) || status === 'signed' || status === 'active';
}

async function walletFetch(path: string, init: RequestInit = {}): Promise<any> {
  const send = (jwt: string) =>
    fetch(`${WALLET_API}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
        Authorization: `Bearer ${jwt}`,
      },
    });

  let res = await send(await ensureAuthenticated());
  if (res.status === 401 || res.status === 403) {
    res = await send(await refreshJwt());
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new FluxaBrowserError(
      body?.error ?? body?.message ?? `FluxA returned ${res.status}`,
      'wallet_error',
    );
  }
  return body;
}

/**
 * Create a mandate on the traveller's own wallet.
 *
 * `description` is the sentence they will read on FluxA's approval screen, so
 * it has to describe what actually happens next. It is composed by the caller
 * from a closed set, never from free text a request supplied — a consent
 * string that an attacker can write is not consent.
 */
export async function createMandate(params: {
  amountUsd: number;
  description: string;
  seconds?: number;
}): Promise<BrowserMandate> {
  const body = await walletFetch('/api/mandates/create-intent', {
    method: 'POST',
    body: JSON.stringify({
      intent: {
        naturalLanguage: params.description,
        category: 'general',
        currency: 'USDC',
        limitAmount: String(Math.round(params.amountUsd * 1_000_000)),
        validForSeconds: params.seconds ?? 3600,
        hostAllowlist: [],
      },
    }),
  });
  const mandate = toMandate(body);
  if (!mandate.id) {
    throw new FluxaBrowserError('FluxA returned a mandate with no id', 'mandate_malformed');
  }
  return mandate;
}

export async function getMandate(mandateId: string): Promise<BrowserMandate> {
  return toMandate(await walletFetch(`/api/mandates/agent/${encodeURIComponent(mandateId)}`));
}

/**
 * Headers identifying the payer for a request to our own API.
 *
 * Empty when the browser wallet is off, which is what makes every call site
 * safe to write unconditionally: with the feature disabled the header simply
 * is not there and the server falls back to its own wallet.
 */
export async function payerHeaders(): Promise<Record<string, string>> {
  if (!browserWalletEnabled()) return {};
  return { 'X-Fluxa-Jwt': await ensureAuthenticated() };
}
