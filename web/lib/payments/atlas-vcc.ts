import { getCardSecrets, maskPan, type CardSecrets } from './fluxa';

/**
 * Pay an Atlas (AtripTech) order with a FluxA virtual card.
 *
 * Atlas calls this "VCC pass-through" — `paymentMethod: 3`. Card credentials
 * are read from FluxA at the moment of payment, forwarded once, and never
 * stored, logged, or returned to the browser.
 *
 * Field names come from the Atlas Payment & Ticketing reference, not from
 * memory: the card object is `creditCard`, the CVV field is `cardCVV`, and
 * `cardExpireYear` is TWO digits ("26", not "2026"). Getting any of these
 * wrong on a payment endpoint fails in ways that are expensive to debug.
 */

export interface AtlasConfig {
  /** Host for verify / order / pay / post-booking. */
  baseUrl: string;
  /**
   * Host for search.do only.
   *
   * Sandbox serves everything from one host; production splits them
   * (search-sg vs api-sg), so this must be addressed separately or search
   * silently hits the wrong endpoint.
   */
  searchBaseUrl: string;
  clientId: string;
  clientSecret: string;
  /** True when pointed at production — real bookings, real money. */
  isProduction: boolean;
}

/** Billing address Atlas requires alongside the card. */
export interface BillingAddress {
  firstName: string;
  lastName: string;
  /** ISO 3166-1 alpha-2, e.g. "GB". */
  country: string;
  /** Two-letter code only. */
  province: string;
  city: string;
  postCode: string;
  address: string;
}

export interface VccPaymentResult {
  ok: boolean;
  orderNo: string;
  status: number;
  message: string;
  /** Set when Atlas refused in a way a different card or retry may fix. */
  retryable: boolean;
}

export class AtlasError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryable = false,
  ) {
    super(message);
    this.name = 'AtlasError';
  }
}

/**
 * Atlas credentials from the environment.
 *
 * Names follow flight402's ATRIP_* family so one set of credentials works for
 * both codebases. They map onto Atlas's `x-atlas-client-id` /
 * `x-atlas-client-secret` headers.
 */
const SANDBOX = 'https://sandbox.atriptech.com';

export function atlasConfigFromEnv(): AtlasConfig | null {
  const baseUrl = (process.env.ATRIP_BASE_URL ?? SANDBOX).replace(/\/$/, '');
  const searchBaseUrl = (process.env.ATRIP_SEARCH_BASE_URL ?? baseUrl).replace(/\/$/, '');
  const clientId = process.env.ATRIP_ACCESS_KEY ?? process.env.ATRIP_CLIENT_ID;
  const clientSecret = process.env.ATRIP_SECRET_KEY ?? process.env.ATRIP_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  // Anything that isn't the sandbox host books real tickets and moves real
  // money. Callers use this to require an explicit opt-in rather than
  // discovering the difference from a charge.
  const isProduction = !baseUrl.includes('sandbox.atriptech.com');

  return { baseUrl, searchBaseUrl, clientId, clientSecret, isProduction };
}

/**
 * Guard for anything that spends money.
 *
 * Production is reachable with the same credentials as the sandbox — the only
 * difference is the hostname — so a mistyped env var is the whole distance
 * between a test and a real purchase. This makes that distance explicit.
 */
export function assertPaymentAllowed(config: AtlasConfig): void {
  if (config.isProduction && process.env.ATRIP_ALLOW_PRODUCTION !== 'true') {
    throw new AtlasError(
      'Refusing to pay against production Atlas. This books real tickets and charges real money. ' +
        'Set ATRIP_ALLOW_PRODUCTION=true only when that is genuinely intended.',
      403,
      false,
    );
  }
}

export function billingFromEnv(): BillingAddress | null {
  const raw = process.env.ATLAS_BILLING_ADDRESS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const required = [
      'firstName',
      'lastName',
      'country',
      'province',
      'city',
      'postCode',
      'address',
    ];
    if (required.some((k) => !parsed[k])) return null;
    return parsed as BillingAddress;
  } catch {
    return null;
  }
}

async function atlasPost<T = any>(
  config: AtlasConfig,
  endpoint: string,
  body: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Atlas documents `Accept: */*` as mandatory and rejects
        // `application/json`. Not a stylistic choice.
        Accept: '*/*',
        'Accept-Encoding': 'gzip',
        'x-atlas-client-id': config.clientId,
        'x-atlas-client-secret': config.clientSecret,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    throw new AtlasError(
      `Could not reach the airline provider: ${(err as Error).message}`,
      0,
      true,
    );
  }

  const text = await res.text();
  let payload: any;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new AtlasError(`Airline provider returned a non-JSON response`, res.status);
  }

  // Atlas signals business outcome in `status`, not the HTTP code.
  if (payload.status !== 0) {
    throw new AtlasError(
      payload.msg || `Airline provider rejected the request (status ${payload.status})`,
      payload.status ?? res.status,
      // 5xx-ish transport faults are worth retrying; a rejected card is not.
      res.status >= 500,
    );
  }
  return payload as T;
}

/** Atlas wants a two-digit year; FluxA may report either form. */
function twoDigitYear(year: string): string {
  const digits = year.replace(/\D/g, '');
  return digits.length > 2 ? digits.slice(-2) : digits.padStart(2, '0');
}

function buildCreditCard(card: CardSecrets, billing: BillingAddress) {
  return {
    cardNumber: card.pan.replace(/\s/g, ''),
    cardCVV: card.cvv,
    cardExpireMonth: card.expiryMonth.padStart(2, '0'),
    cardExpireYear: twoDigitYear(card.expiryYear),
    cardHolderFirstName: billing.firstName,
    cardHolderLastName: billing.lastName,
    cardHolderCountry: billing.country,
    cardHolderProvince: billing.province,
    cardHolderCity: billing.city,
    cardHolderPostCode: billing.postCode,
    cardHolderAddress: billing.address,
    // FluxA cards are single-purpose and funded per purchase.
    reusable: false,
  };
}

/**
 * Charge a FluxA card for an existing Atlas order.
 *
 * `paymentLimit` is passed as a hard ceiling so a fare that moved between
 * pricing and payment cannot quietly charge more than was approved.
 */
export async function payOrderWithCard(params: {
  config: AtlasConfig;
  billing: BillingAddress;
  orderNo: string;
  cardId: string;
  /** Maximum amount, in the order's currency, the caller approved. */
  paymentLimit?: number;
  clientIp?: string;
}): Promise<VccPaymentResult> {
  const { config, billing, orderNo, cardId, paymentLimit, clientIp } = params;

  const card = await getCardSecrets(cardId);
  const masked = maskPan(card.pan);

  const body: Record<string, unknown> = {
    orderNo,
    paymentMethod: 3,
    creditCard: buildCreditCard(card, billing),
  };
  if (paymentLimit != null) body.paymentLimit = Math.ceil(paymentLimit);
  if (clientIp) body.threeDS = { ip: clientIp };

  try {
    // Success is the absence of a thrown AtlasError; pay.do echoes back only
    // orderNo and paymentMethod, so there is nothing further to read.
    await atlasPost(config, 'pay.do', body);
    return {
      ok: true,
      orderNo,
      status: 0,
      message: `Charged ${masked}`,
      retryable: false,
    };
  } catch (err) {
    if (err instanceof AtlasError) {
      // The card number never reaches the message — only the masked form.
      return {
        ok: false,
        orderNo,
        status: err.status,
        message: `${err.message} (card ${masked})`,
        retryable: err.retryable,
      };
    }
    throw err;
  } finally {
    // Best-effort scrub. JS strings are immutable so this cannot truly wipe
    // memory, but it drops our last reference promptly rather than holding
    // card data alive in a closure.
    (card as Partial<CardSecrets>).pan = undefined;
    (card as Partial<CardSecrets>).cvv = undefined;
  }
}

/** Atlas order states, from the Query Order reference. */
export const ATLAS_ORDER_STATUS = {
  UNPAID: '0',
  TICKETING: '1',
  TICKETED: '2',
  CANCELLED: '-3',
} as const;

/** Both TICKETING and TICKETED mean pay.do already succeeded. */
export function isAlreadyPaid(orderStatus: unknown): boolean {
  const s = String(orderStatus);
  return s === ATLAS_ORDER_STATUS.TICKETING || s === ATLAS_ORDER_STATUS.TICKETED;
}

/**
 * Fetch an order's current state.
 *
 * Atlas returns `status: 0` with every field null for an order that does not
 * exist — a success envelope around nothing. Verified against the sandbox:
 *   queryOrderDetails.do {orderNo: "ORD-DOES-NOT-EXIST"}
 *     → {"status":0,"orderNo":null,"orderStatus":null,…}
 *
 * So absence has to be detected on the payload, not on an exception. Treating
 * "no error" as "order exists" would let a payment path proceed against an
 * order that was never created.
 */
export async function queryOrder(config: AtlasConfig, orderNo: string): Promise<any> {
  const result = await atlasPost(config, 'queryOrderDetails.do', { orderNo });
  if (result?.orderNo == null && result?.orderStatus == null) {
    throw new AtlasError(`Order ${orderNo} was not found`, 404, false);
  }
  return result;
}

/**
 * Which payment methods an offer supports.
 *
 * Atlas returns `supportPaymentMethods` per routing, and VCC availability
 * varies by airline and fare — so a card path must be gated on this rather
 * than assumed. `3` is VCC pass-through.
 */
export function supportsVcc(offer: { supportPaymentMethods?: unknown }): boolean {
  const methods = offer?.supportPaymentMethods;
  if (!Array.isArray(methods)) return false;
  return methods.some((m) => Number(m) === 3);
}

/**
 * Whether an offer can settle from the agency deposit. `1` is deposit.
 *
 * Nearly every Atlas fare lists it, but "nearly" is not "always" — and a fare
 * that supports neither rail must not be presented as payable at all.
 */
export function supportsDeposit(offer: { supportPaymentMethods?: unknown }): boolean {
  const methods = offer?.supportPaymentMethods;
  if (!Array.isArray(methods)) return false;
  return methods.some((m) => Number(m) === 1);
}
