import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * FluxA virtual-card access, via the `fluxa-wallet` CLI.
 *
 * Deliberately a thin wrapper around the CLI rather than a reimplementation of
 * FluxA's HTTP API. The FluxA integration rules are explicit that payment
 * logic — mandate creation, x402 signing — must not live in application code;
 * agents drive the wallet through the CLI so the user's approval step stays
 * where FluxA put it.
 *
 * Issuance and recharge are spends. They are exposed here, but only against a
 * mandate the user has already signed in FluxA — this module never creates
 * money movement without that signature, and never bypasses it.
 *
 * One hard rule: a PAN or CVV must never reach the browser. `getCardSecrets`
 * is server-side only; everything the UI renders comes from `CardSummary`.
 */

export interface CardSummary {
  id: string;
  last4?: string;
  status?: string;
  /** Spendable balance — what remains, not what was loaded. */
  balance?: string;
  /** Amount originally loaded; constant as the card is spent. */
  funded?: string;
  currency?: string;
  expiryMonth?: string;
  expiryYear?: string;
  brand?: string;
}

/** Full card credentials. Server-side only — never serialise this to a client. */
export interface CardSecrets {
  id: string;
  pan: string;
  cvv: string;
  expiryMonth: string;
  expiryYear: string;
  holderName?: string;
}

export interface ThreeDsChallenge {
  cardId: string;
  code?: string;
  merchant?: string;
  amount?: string;
  createdAt?: string;
  raw: unknown;
}

export class FluxaError extends Error {
  constructor(
    message: string,
    public code = 'fluxa_error',
  ) {
    super(message);
    this.name = 'FluxaError';
  }
}

function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Lets a specific wallet profile be selected without touching the default
  // one — e.g. pointing at a funded agent while another is being set up.
  if (process.env.FLUXA_DATA_DIR) env.FLUXA_DATA_DIR = process.env.FLUXA_DATA_DIR;
  return env;
}

/**
 * Invoke the CLI and parse its JSON.
 *
 * The CLI prints human-readable progress lines ("[cli] JWT refreshed…") before
 * its JSON payload, so the parser finds the first balanced JSON value rather
 * than assuming stdout is clean.
 */
async function cli<T = any>(args: string[]): Promise<T> {
  let stdout: string;
  try {
    const result = await run('fluxa-wallet', args, {
      env: cliEnv(),
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new FluxaError(
        'The fluxa-wallet CLI is not installed. Install it with: npm install -g @fluxa-pay/fluxa-wallet',
        'cli_missing',
      );
    }
    // A non-zero exit still often carries a useful JSON error on stdout.
    stdout = err?.stdout ?? '';
    if (!stdout) {
      throw new FluxaError(
        err?.stderr?.trim() || err?.message || 'fluxa-wallet failed',
        'cli_failed',
      );
    }
  }

  const parsed = extractJson(stdout);
  if (parsed == null) {
    throw new FluxaError('Could not parse fluxa-wallet output', 'bad_output');
  }
  if (parsed.success === false) {
    throw new FluxaError(parsed.error ?? 'fluxa-wallet reported a failure', parsed.code);
  }
  return (parsed.data ?? parsed) as T;
}

/** Find the first `{...}` or `[...]` in mixed CLI output. */
function extractJson(text: string): any | null {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === ch) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(i, j + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function normaliseCard(raw: any): CardSummary {
  return {
    id: raw.id ?? raw.cardId ?? raw.card_id,
    last4: raw.last4 ?? raw.lastFour ?? raw.last_four,
    status: raw.status,
    // `remainingAmountUsd` is the spendable balance and the field that decides
    // whether a card can cover a fare; `fundedAmountUsd` is what was originally
    // loaded and stays constant as the card is spent. Reading the wrong one
    // makes every card look either empty or full.
    balance: raw.remainingAmountUsd ?? raw.balanceFormatted ?? raw.balance,
    funded: raw.fundedAmountUsd,
    currency: raw.currency ?? 'USD',
    expiryMonth: raw.expiryMonth ?? raw.expMonth,
    expiryYear: raw.expiryYear ?? raw.expYear,
    brand: raw.brand ?? raw.network,
  };
}

/** Cards owned by the configured agent. Safe to send to the browser. */
export async function listCards(): Promise<CardSummary[]> {
  const data = await cli<any>(['card', 'list']);
  const rows = Array.isArray(data) ? data : (data?.cards ?? []);
  return rows.map(normaliseCard).filter((c: CardSummary) => c.id);
}

export async function getCardBalance(cardId: string): Promise<CardSummary> {
  const data = await cli<any>(['card', 'balance', '--id', cardId]);
  return normaliseCard({ id: cardId, ...data });
}

export async function getCardTransactions(cardId: string): Promise<unknown[]> {
  const data = await cli<any>(['card', 'transactions', '--id', cardId]);
  return Array.isArray(data) ? data : (data?.transactions ?? []);
}

/**
 * Reveal PAN, CVV and expiry for a card.
 *
 * The only legitimate caller is the server-side payment step, which forwards
 * these straight to the airline provider. The result must never be logged,
 * cached, stored, or returned from an API route — everything the browser needs
 * is already in `CardSummary`.
 */
export async function getCardSecrets(cardId: string): Promise<CardSecrets> {
  const data = await cli<any>(['card', 'details', '--id', cardId]);
  const pan = data.pan ?? data.cardNumber ?? data.number;
  const cvv = data.cvv ?? data.cvc ?? data.securityCode;
  const expiryMonth = String(data.expiryMonth ?? data.expMonth ?? '').padStart(2, '0');
  const expiryYear = String(data.expiryYear ?? data.expYear ?? '');

  if (!pan || !cvv || !expiryMonth || !expiryYear) {
    throw new FluxaError(
      'Card details were incomplete — cannot use this card for payment',
      'incomplete_card',
    );
  }
  return {
    id: cardId,
    pan: String(pan),
    cvv: String(cvv),
    expiryMonth,
    expiryYear,
    holderName: data.holderName ?? data.cardholderName,
  };
}

/**
 * The newest 3DS challenge for a card.
 *
 * Airline card charges frequently trigger one; without a way to surface it the
 * payment simply stalls with no explanation.
 */
export async function getLatest3ds(cardId: string): Promise<ThreeDsChallenge | null> {
  try {
    const data = await cli<any>(['card', '3ds', 'latest', '--id', cardId]);
    if (!data || (Array.isArray(data) && data.length === 0)) return null;
    const item = Array.isArray(data) ? data[0] : data;
    return {
      cardId,
      code: item.code ?? item.otp ?? item.challengeCode,
      merchant: item.merchant ?? item.merchantName,
      amount: item.amount,
      createdAt: item.createdAt ?? item.created_at,
      raw: item,
    };
  } catch {
    // No challenge is the common case and is not an error.
    return null;
  }
}

/* ---------- cardholder ---------- */

export interface Cardholder {
  name?: string;
  firstName?: string;
  lastName?: string;
  country?: string;
  status?: string;
}

/** The account cardholder, or null if one has never been set up. */
export async function getCardholder(): Promise<Cardholder | null> {
  try {
    return await cli<Cardholder>(['card', 'holder', 'me']);
  } catch (err) {
    if (err instanceof FluxaError && err.code === 'cardholder_not_found') return null;
    throw err;
  }
}

/**
 * Create the account cardholder.
 *
 * One-time and immutable: FluxA shares the holder across every agent linked to
 * the same wallet, and the name cannot be changed after approval.
 */
export async function createCardholder(params: {
  firstName: string;
  lastName: string;
  country?: string;
}): Promise<Cardholder> {
  return cli<Cardholder>([
    'card', 'holder', 'create',
    '--first-name', params.firstName,
    '--last-name', params.lastName,
    '--country', params.country ?? 'US',
  ]);
}

/* ---------- mandates ---------- */

export interface Mandate {
  id: string;
  status?: string;
  approvalUrl?: string | null;
  limitAmountFormatted?: string;
  remainingAmountFormatted?: string;
  signedAt?: string | null;
  validUntil?: string;
}

/**
 * The two mandate commands return different shapes, and conflating them is a
 * silent failure rather than a loud one:
 *
 *   mandate-create → { status: 'ok', mandateId, authorizationUrl, … }
 *   mandate-status → { status: 'ok', mandate: { status: 'pending_signature',
 *                                               signedAt, signUrl, … } }
 *
 * That outer `status: 'ok'` is the *call* succeeding, not the mandate being
 * signed. Reading it as the mandate's own status makes `signedAt` permanently
 * undefined, so a mandate the user really has signed still looks unsigned and
 * issuance waits forever. Unwrap before reading anything.
 */
function normaliseMandate(raw: any): Mandate {
  const m = raw?.mandate ?? raw;
  return {
    id: m.id ?? m.mandateId ?? m.mandate_id,
    status: m.status,
    approvalUrl: m.approvalUrl ?? m.authorizationUrl ?? m.signUrl ?? null,
    limitAmountFormatted: m.limitAmountFormatted,
    remainingAmountFormatted: m.remainingAmountFormatted,
    signedAt: m.signedAt ?? null,
    validUntil: m.validUntil,
  };
}

/**
 * Create a spending mandate — the budget a card is funded from.
 *
 * Returns an `approvalUrl` the user must open and sign. This is the step that
 * cannot be automated away: FluxA puts the human in the loop before any money
 * moves, and issuing a card is a spend.
 *
 * `--amount` is in atomic units (USDC has 6 decimals), so a dollar figure is
 * converted here rather than at each call site.
 */
export async function createMandate(params: {
  description: string;
  amountUsd: number;
  seconds?: number;
}): Promise<Mandate> {
  const atomic = Math.round(params.amountUsd * 1_000_000);
  const raw = await cli<any>([
    'mandate-create',
    '--desc', params.description,
    '--amount', String(atomic),
    '--seconds', String(params.seconds ?? 3600),
  ]);
  return normaliseMandate(raw);
}

export async function getMandateStatus(mandateId: string): Promise<Mandate> {
  return normaliseMandate(await cli<any>(['mandate-status', '--id', mandateId]));
}

/** Statuses that mean the mandate can no longer fund anything. */
const DEAD_MANDATE = new Set(['expired', 'revoked', 'cancelled', 'consumed']);

/**
 * True once the user has signed and the mandate can still fund a card.
 *
 * A signature is necessary but not sufficient — a signed mandate that has
 * since expired must not be treated as spendable, or issuance fails at the
 * FluxA call with a far less obvious error than "sign it first".
 */
export function isMandateSigned(m: Mandate): boolean {
  const status = m.status ?? '';
  if (DEAD_MANDATE.has(status)) return false;
  return Boolean(m.signedAt) || status === 'signed' || status === 'active';
}

/* ---------- issuance ---------- */

/**
 * Issue a funded virtual card against a signed mandate.
 *
 * This spends real money. It is reachable only from an explicit user action
 * that already carried a signed mandate — never from the agent's tool surface.
 */
export async function createCard(params: {
  amountUsd: number;
  mandateId: string;
}): Promise<CardSummary> {
  const raw = await cli<any>([
    'card', 'create',
    '--amount', params.amountUsd.toFixed(2),
    '--mandate', params.mandateId,
  ]);
  return normaliseCard(raw);
}

/** Add funds to an existing card. Also a spend, also mandate-gated. */
export async function rechargeCard(params: {
  cardId: string;
  amountUsd: number;
  mandateId: string;
}): Promise<CardSummary> {
  const raw = await cli<any>([
    'card', 'recharge',
    '--id', params.cardId,
    '--amount', params.amountUsd.toFixed(2),
    '--mandate', params.mandateId,
  ]);
  return normaliseCard(raw);
}

/** Redact a PAN for logs and error messages. */
export function maskPan(pan: string): string {
  const digits = pan.replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `•••• ${digits.slice(-4)}`;
}
