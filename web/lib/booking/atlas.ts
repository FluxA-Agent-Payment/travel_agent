import { randomUUID } from 'node:crypto';

import { parsePhoneNumberFromString } from 'libphonenumber-js';

import { sharedMap, nextSeq } from '../store';

import {
  atlasConfigFromEnv,
  assertPaymentAllowed,
  isAlreadyPaid,
  payOrderWithCard,
  queryOrder,
  supportsVcc,
  supportsDeposit,
  type AtlasConfig,
  type BillingAddress,
} from '../payments/atlas-vcc';
import type { BookingProvider, DraftOrderInput } from './provider';
import {
  BookingError,
  type CouponResult,
  type FlightOffer,
  type LuggageOption,
  type Order,
  type OrderDraft,
  type OrderStatus,
  type Passenger,
  type RefundQuote,
  type RefundStatus,
  type SearchParams,
  type SearchResult,
  type SeatMapSegment,
  type Segment,
  type VerifyResult,
} from '../types';

/**
 * Real Atlas (AtripTech) booking provider.
 *
 * Talks to Atlas directly rather than through flight402, which is what makes
 * VCC pass-through (`paymentMethod: 3`) possible — flight402 only ever sends
 * method 1.
 *
 * Two Atlas behaviours shape this file:
 *  - Outcome lives in the `status` field, never the HTTP code. A rejected
 *    request is still HTTP 200.
 *  - Dates are `YYYYMMDD` on the wire and `yyyy-MM-dd HH:mm:ss` (SGT) for
 *    ticketing deadlines, so everything is converted at the boundary.
 */

interface Session {
  sessionId: string;
  routing: any;
  currency: string;
  adultTotal: number;
  childTotal: number;
  infantTotal: number;
  supportsVcc: boolean;
  supportsDeposit: boolean;
  createdAt: number;
}

/**
 * Short handles for Atlas offers.
 *
 * Atlas `routingIdentifier`s are long opaque tokens, and Atlas rejects any
 * value that differs from what search returned by even a character. Passing
 * one through the model as a tool argument means trusting an LLM to copy a
 * couple of hundred characters exactly — which fails often enough to be a
 * bug, and burns tokens on every search result besides. The model sees `f1`,
 * `f2`, …; the real identifier never leaves the server.
 */
const offers = sharedMap<{ routingIdentifier: string; routing: any }>('atlas.offers');
const sessions = sharedMap<Session>('atlas.sessions');
const drafts = sharedMap<OrderDraft & { input: DraftOrderInput }>('atlas.drafts');
const orders = sharedMap<Order & { atlasOrderNo: string }>('atlas.orders');

/* ---------- wire helpers ---------- */

/** Atlas dates are YYYYMMDD (and sometimes YYYYMMDDHHmm). */
function fromAtlasDate(raw: string): string {
  if (!raw) return new Date().toISOString();
  const d = String(raw);
  const y = d.slice(0, 4);
  const m = d.slice(4, 6);
  const day = d.slice(6, 8);
  const hh = d.length >= 12 ? d.slice(8, 10) : '00';
  const mm = d.length >= 12 ? d.slice(10, 12) : '00';
  return `${y}-${m}-${day}T${hh}:${mm}:00Z`;
}

function toAtlasDate(iso: string): string {
  return iso.replace(/-/g, '').slice(0, 8);
}

/**
 * Atlas wants `Family/Given`, and matches OTA baggage by this exact string —
 * so it is built in one place rather than at each call site.
 */
function atlasName(p: Passenger): string {
  return `${p.lastName.trim()}/${p.firstName.trim()}`.toUpperCase();
}

const PAX_TYPE: Record<Passenger['type'], number> = { adult: 0, child: 1, infant: 2 };

/**
 * Atlas wants the contact phone as `00<countryCode>-<nationalNumber>`
 * (e.g. `0065-91234599`) and rejects E.164 with status 410.
 *
 * Splitting that with a regex does not work: country codes are 1-3 digits and
 * a greedy match turns `+6591234599` into country `6591`, national `234599`.
 * libphonenumber knows the real code table, so it does the split.
 */
function atlasMobile(phone: string): string | null {
  const trimmed = String(phone ?? '').trim();
  if (!trimmed) return null;
  if (/^00\d{1,4}-\d{4,15}$/.test(trimmed)) return trimmed;

  const e164 = trimmed.startsWith('+') ? trimmed : `+${trimmed.replace(/^00/, '')}`;
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed || !parsed.isValid()) return null;

  // Atlas pads the country code to at least two digits: +1 → 0001, +65 → 0065.
  const cc = String(parsed.countryCallingCode).padStart(2, '0');
  return `00${cc}-${parsed.nationalNumber}`;
}

function mapSegments(raw: any[] | null | undefined): Segment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s) => ({
    flightNumber: `${s.carrier ?? ''}${s.flightNumber ?? ''}`,
    carrier: s.carrier ?? '',
    departure: { airport: s.depAirport, time: fromAtlasDate(s.depTime) },
    arrival: { airport: s.arrAirport, time: fromAtlasDate(s.arrTime) },
    durationMinutes: s.duration ?? undefined,
    stops: 0,
  }));
}

/**
 * Who and what a refund applies to, in the shape refundQuotation.do wants.
 *
 * Live order detail is preferred over our own record on both counts. Atlas
 * matches passengers on its canonical `FAMILY/GIVEN` string, and matches
 * segments on its own flight numbering — which sometimes already carries the
 * carrier prefix and sometimes does not. Sending back what it gave us avoids
 * a mismatch that surfaces as an unexplained empty quote.
 */
function refundSubject(
  details: any,
  known?: Order,
): {
  passengers: Array<{ lastName: string; firstName: string }>;
  segments: Array<{
    depDate: string;
    flightNo: string;
    depAirport: string;
    arrAirport: string;
  }>;
} {
  const live = details?.paxTicketInfos ?? [];
  const passengers = live.length
    ? live.map((p: any) => splitAtlasName(p.name ?? ''))
    : (known?.passengers ?? []).map((p) => ({
        lastName: p.lastName.toUpperCase(),
        firstName: p.firstName.toUpperCase(),
      }));

  const routing = details?.routing ?? {};
  const rawSegments = [...(routing.fromSegments ?? []), ...(routing.retSegments ?? [])];

  const segments = rawSegments.length
    ? rawSegments.map((s: any) => {
        const carrier = s.carrier ?? '';
        const flight = String(s.flightNumber ?? '');
        return {
          depDate: String(s.depTime ?? '').slice(0, 8),
          flightNo: flight.startsWith(carrier) ? flight : `${carrier}${flight}`,
          depAirport: s.depAirport ?? '',
          arrAirport: s.arrAirport ?? '',
        };
      })
    : [...(known?.outbound ?? []), ...(known?.inbound ?? [])].map((s) => ({
        depDate: toAtlasDate(s.departure.time),
        flightNo: s.flightNumber,
        depAirport: s.departure.airport,
        arrAirport: s.arrival.airport,
      }));

  return {
    passengers: passengers.filter(
      (p: { lastName: string; firstName: string }) => p.lastName && p.firstName,
    ),
    segments: segments.filter(
      (s) => s.depDate && s.flightNo && s.depAirport && s.arrAirport,
    ),
  };
}

/**
 * Run a refund call, distinguishing "not offered" from "went wrong".
 *
 * Atlas does not carry refund service for every airline and route, and answers
 * so in prose rather than with a distinct status code. Left alone that reads to
 * the traveller as a malfunction in this app — "Quoting refund failed" — when
 * the honest answer is simply that refunds are not available for this booking
 * here. Re-coding it lets the UI say that plainly instead of showing a fault,
 * and stops the agent from retrying something that will never succeed.
 */
async function refundCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const message = (err as Error)?.message ?? '';
    if (/not\s+(currently\s+)?support/i.test(message) && /refund/i.test(message)) {
      throw new BookingError(
        'Refunds are not available for this booking through Atlas — it does not carry ' +
          'refund service for this airline and route. The airline may still allow one directly.',
        'refund_unsupported',
      );
    }
    throw err;
  }
}

/** Atlas refund states, shared by submit and poll so the two cannot diverge. */
const REFUND_STATUS: Record<string, RefundStatus['status']> = {
  '0': 'processing',
  '1': 'airline_processing',
  '2': 'refunded',
  '3': 'airline_processing',
  '4': 'rejected',
  '5': 'refunded',
  '6': 'withdrawn',
};

/** Split Atlas's `FAMILY/GIVEN` back into its parts. */
function splitAtlasName(name: string): { lastName: string; firstName: string } {
  const [lastName = '', firstName = ''] = String(name).split('/');
  return { lastName: lastName.trim(), firstName: firstName.trim() };
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ---------- provider ---------- */

export function createAtlasProvider(config: AtlasConfig): BookingProvider {
  async function post<T = any>(endpoint: string, body: unknown, search = false): Promise<T> {
    const host = search ? config.searchBaseUrl : config.baseUrl;
    let res: Response;
    try {
      res = await fetch(`${host}/${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Documented as mandatory; `application/json` is rejected.
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
      throw new BookingError(
        `Could not reach the airline provider: ${(err as Error).message}`,
        'network',
        true,
      );
    }

    const text = await res.text();
    let payload: any;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new BookingError('Airline provider returned a non-JSON response', 'bad_response');
    }

    // Atlas answers HTTP 200 even when it refuses. Branching on res.ok here
    // would read an auth failure as a successful empty result.
    if (payload.status !== 0) {
      throw new BookingError(
        payload.msg || `Airline provider rejected the request (status ${payload.status})`,
        `atlas_${payload.status}`,
        res.status >= 500,
      );
    }
    return payload as T;
  }

  function priceFrom(routing: any) {
    const adult = round(num(routing.adultPrice) + num(routing.adultTax));
    const child = routing.childPrice != null
      ? round(num(routing.childPrice) + num(routing.childTax))
      : adult;
    const infant = routing.infantPrice != null
      ? round(num(routing.infantPrice) + num(routing.infantTax))
      : 0;
    return { adult, child, infant, currency: routing.currency ?? 'USD' };
  }

  const provider: BookingProvider = {
    name: 'atlas',

    async searchFlights(params: SearchParams): Promise<SearchResult> {
      const data = await post(
        'search.do',
        {
          tripType: params.returnDate ? '2' : '1',
          adultNum: params.adults ?? 1,
          childNum: params.children ?? 0,
          infantNum: params.infants ?? 0,
          fromCity: params.from.toUpperCase(),
          toCity: params.to.toUpperCase(),
          fromDate: toAtlasDate(params.date),
          retDate: params.returnDate ? toAtlasDate(params.returnDate) : undefined,
          airlines: params.airlines?.length ? params.airlines : undefined,
        },
        true,
      );

      const routings: any[] = data.routings ?? [];
      const flights: FlightOffer[] = routings.map((r) => {
        const id = `f${nextSeq('atlas.offer')}`;
        offers.set(id, { routingIdentifier: r.routingIdentifier, routing: r });
        const p = priceFrom(r);
        const baggage = r.rule?.baggageElements ?? [];
        return {
          flightId: id,
          price: {
            currency: p.currency,
            adult: p.adult,
            child: p.child,
            infant: p.infant,
          },
          outbound: mapSegments(r.fromSegments),
          inbound: r.retSegments?.length ? mapSegments(r.retSegments) : undefined,
          baggageIncluded: r.rule?.hasBaggage === 1 || baggage.length > 0,
          refundable: Array.isArray(r.rule?.refundRules) && r.rule.refundRules.length > 0,
          seatsLeft: r.fromSegments?.[0]?.seatCount ?? undefined,
          // Most Atlas fares are deposit-only. Surfacing this at search time
          // stops a traveller choosing a fare their wallet can never pay.
          cardPayable: supportsVcc(r),
          depositPayable: supportsDeposit(r),
        };
      });

      flights.sort((a, b) => a.price.adult - b.price.adult);
      return { flights };
    },

    async verifyFlight(flightId: string): Promise<VerifyResult> {
      const entry = offers.get(flightId);
      if (!entry) {
        throw new BookingError(
          `Offer ${flightId} is no longer available — search again and pick from the new results`,
          'offer_expired',
        );
      }
      const data = await post('verify.do', {
        routingIdentifier: entry.routingIdentifier,
      });
      const routing = data.routing ?? {};
      const p = priceFrom(routing);
      const change = data.priceChange ?? {};
      const changed = change.isPriceChange === true;

      sessions.set(data.sessionId, {
        sessionId: data.sessionId,
        routing,
        currency: p.currency,
        adultTotal: p.adult,
        childTotal: p.child,
        infantTotal: p.infant,
        supportsVcc: supportsVcc(routing),
        supportsDeposit: supportsDeposit(routing),
        createdAt: Date.now(),
      });

      // bookingRequirement is an object keyed by field name; the agent only
      // needs to know which fields the airline demands.
      const required = Object.keys(data.bookingRequirement?.passenger ?? {});

      return {
        verifiedFlightId: data.sessionId,
        priceChanged: changed,
        price: { currency: p.currency, adult: p.adult, child: p.child, infant: p.infant },
        previousPrice: changed
          ? {
              currency: p.currency,
              adult: round(num(change.originalAdultPrice) + num(change.originalAdultTax)),
            }
          : undefined,
        maxSeats: data.maxSeats,
        outbound: mapSegments(routing.fromSegments),
        inbound: routing.retSegments?.length ? mapSegments(routing.retSegments) : undefined,
        bookingRequirements: required.length ? required : undefined,
      };
    },

    async getSeats(verifiedFlightId: string): Promise<SeatMapSegment[]> {
      const data = await post('seatAvailability.do', { sessionId: verifiedFlightId });
      const segs: any[] = data.segmentSeats ?? data.segments ?? [];
      return segs.map((seg: any) => ({
        flightNumber: `${seg.carrier ?? ''}${seg.flightNumber ?? ''}`,
        rows: (seg.rows ?? seg.seatRows ?? []).map((row: any) => ({
          row: num(row.rowNumber ?? row.row),
          seats: (row.seats ?? row.columns ?? []).map((s: any) => ({
            code: `${row.rowNumber ?? row.row}${s.column ?? s.code ?? ''}`,
            available: s.available !== false && s.status !== 'OCCUPIED',
            price: num(s.price ?? s.salePrice),
            position: s.position ?? undefined,
          })),
        })),
      }));
    },

    async getLuggage(verifiedFlightId: string): Promise<LuggageOption[]> {
      const data = await post('getLuggage.do', { offerId: verifiedFlightId });
      const groups: any[] = data.luggages ?? data.baggages ?? [];
      const out: LuggageOption[] = [];
      for (const g of groups) {
        for (const price of g.baggagePrices ?? g.prices ?? []) {
          out.push({
            id: `${g.flight ?? ''}:${price.weight ?? 0}:${price.pkgNumber ?? 1}`,
            description: `Checked bag${price.pkgNumber > 1 ? ` ×${price.pkgNumber}` : ''}`,
            weightKg: num(price.weight),
            price: num(price.bookSalePrice ?? price.salePrice),
            segment: g.flight ?? undefined,
          });
        }
      }
      return out;
    },

    async checkCoupon(code: string): Promise<CouponResult> {
      // Coupons are a flight402 construct; Atlas has no equivalent.
      return { valid: false, code, reason: 'Discount codes are not available on this backend' };
    },

    async draftOrder(input: DraftOrderInput): Promise<OrderDraft> {
      const session = sessions.get(input.verifiedFlightId);
      if (!session) {
        throw new BookingError(
          'That verified fare is no longer held — verify the flight again',
          'session_expired',
        );
      }
      if (!input.passengers?.length) {
        throw new BookingError('At least one passenger is required', 'bad_request');
      }

      // Validate the contact here, while the order is still a draft and the
      // details can be corrected. This used to run in placeOrder — that is,
      // *after* the traveller had approved and committed — so a mistyped phone
      // surfaced at the one moment there was no way back to the field.
      if (!atlasMobile(input.contact?.phone ?? '')) {
        throw new BookingError(
          `The contact phone "${input.contact?.phone ?? ''}" is not usable. It must be ` +
            'international format with a country code, e.g. +6591234567. Ask the traveller ' +
            'which country the number is from rather than guessing a prefix.',
          'bad_phone',
        );
      }
      if (!input.contact?.email?.includes('@')) {
        throw new BookingError(
          'A contact email is required before an order can be priced.',
          'bad_email',
        );
      }

      const baseTotal = round(
        input.passengers.reduce((sum, p) => {
          if (p.type === 'child') return sum + session.childTotal;
          if (p.type === 'infant') return sum + session.infantTotal;
          return sum + session.adultTotal;
        }, 0),
      );
      const fee = round(num(session.routing.transactionFee));

      const draft: OrderDraft = {
        draftId: `dr_${randomUUID().slice(0, 12)}`,
        cardPayable: session.supportsVcc,
        depositPayable: session.supportsDeposit,
        verifiedFlightId: input.verifiedFlightId,
        passengers: input.passengers,
        contact: input.contact,
        selectedSeats: input.selectedSeats ?? [],
        selectedLuggage: input.selectedLuggage ?? [],
        quote: {
          baseTotal,
          seatsTotal: 0,
          luggageTotal: 0,
          discount: 0,
          total: round(baseTotal + fee),
          currency: session.currency,
        },
        outbound: mapSegments(session.routing.fromSegments),
        inbound: session.routing.retSegments?.length
          ? mapSegments(session.routing.retSegments)
          : undefined,
      };
      drafts.set(draft.draftId, { ...draft, input });
      return draft;
    },

    async placeOrder(draftId: string): Promise<Order> {
      const draft = drafts.get(draftId);
      if (!draft) {
        throw new BookingError('That draft has expired — rebuild the order', 'draft_expired');
      }

      // Defence in depth. draftOrder rejects an unusable phone before the
      // traveller ever sees an approval card, so reaching this means the draft
      // was built by some other path — not that the traveller mistyped.
      const mobile = atlasMobile(draft.contact.phone);
      if (!mobile) {
        throw new BookingError(
          'This booking cannot be placed — its contact phone is not in a usable format. Rebuild the order.',
          'bad_phone',
        );
      }

      const contactName = atlasName(draft.passengers[0]);
      const data = await post('order.do', {
        sessionId: draft.verifiedFlightId,
        passengers: draft.passengers.map((p) => ({
          name: atlasName(p),
          passengerType: PAX_TYPE[p.type],
          gender: p.gender ?? 'M',
          birthday: p.dateOfBirth?.replace(/-/g, '') || undefined,
          cardType: p.passportNumber ? 'PP' : undefined,
          cardNum: p.passportNumber || undefined,
          cardIssuePlace: p.nationality || undefined,
          cardExpired: p.passportExpiry?.replace(/-/g, '') || undefined,
          nationality: p.nationality || undefined,
        })),
        contact: {
          name: contactName,
          email: draft.contact.email,
          mobile,
        },
        clientContact: { email: draft.contact.email },
      });

      const order: Order & { atlasOrderNo: string } = {
        orderId: data.orderNo,
        atlasOrderNo: data.orderNo,
        status: 'pending_payment',
        cardPayable: draft.cardPayable,
        depositPayable: draft.depositPayable,
        pnr: data.pnrCode,
        totalPrice: round(num(data.totalPrice) + num(data.totalTransactionFee)),
        currency: data.currency ?? draft.quote.currency,
        expiresAt: data.tktLimitTime,
        outbound: mapSegments(data.routing?.fromSegments) ?? draft.outbound,
        inbound: data.routing?.retSegments?.length
          ? mapSegments(data.routing.retSegments)
          : draft.inbound,
        passengers: draft.passengers,
        createdAt: new Date().toISOString(),
      };
      orders.set(order.orderId, order);
      drafts.delete(draftId);
      return order;
    },

    async completePayment(
      orderId: string,
      options?: { cardId?: string; method?: 'card' | 'deposit' },
    ): Promise<Order> {
      const order = orders.get(orderId);
      if (!order) throw new BookingError(`Order ${orderId} not found`, 'not_found');

      assertPaymentAllowed(config);

      // Query before paying. Atlas reports both TICKETING and TICKETED as
      // already-paid, and paying twice is the failure this prevents.
      const current = await queryOrder(config, order.atlasOrderNo).catch(() => null);
      if (current && isAlreadyPaid(current.orderStatus)) {
        order.status = String(current.orderStatus) === '2' ? 'ticketed' : 'ticketing';
        return order;
      }

      // --- deposit rail ---------------------------------------------------
      // Settles from the desk's agency balance with Atlas, which every fare
      // accepts. The traveller has not paid anything here: this rail moves the
      // desk's money, not theirs, so it is refused outright against production
      // where that balance is real.
      if (options?.method === 'deposit') {
        if (order.depositPayable === false) {
          throw new BookingError(
            'This fare cannot be settled from the agency deposit either — the airline ' +
              'accepts neither rail for it.',
            'deposit_not_accepted',
          );
        }
        if (config.isProduction) {
          throw new BookingError(
            'Deposit settlement is disabled against production — it would spend the ' +
              'desk\'s real agency balance rather than the traveller\'s money.',
            'deposit_forbidden',
          );
        }
        await post('pay.do', { orderNo: order.atlasOrderNo, paymentMethod: 1 });
        order.status = 'ticketing';
        return order;
      }

      // --- card rail ------------------------------------------------------
      // Atlas reports card support per fare, and most fares are deposit-only.
      // Catching it here turns a vendor message written for integrators
      // ("Switch to deposit mode or a supported card type") into something the
      // traveller can act on, and saves a pointless round trip.
      if (order.cardPayable === false) {
        throw new BookingError(
          'This airline does not accept card payment for this fare — it settles by ' +
            'agency deposit only, so no FluxA card can pay it.',
          'card_not_accepted',
        );
      }

      if (!options?.cardId) {
        throw new BookingError(
          'A FluxA card must be selected to pay this order',
          'card_required',
        );
      }

      const billing = billingFromConfig();
      const result = await payOrderWithCard({
        config,
        billing,
        orderNo: order.atlasOrderNo,
        cardId: options.cardId,
        paymentLimit: order.totalPrice,
      });

      if (!result.ok) {
        throw new BookingError(result.message, `pay_${result.status}`, result.retryable);
      }
      order.status = 'ticketing';
      return order;
    },

    async getOrder(orderId: string): Promise<Order> {
      const known = orders.get(orderId);
      const data = await queryOrder(config, known?.atlasOrderNo ?? orderId);

      const status: OrderStatus =
        String(data.orderStatus) === '2'
          ? 'ticketed'
          : String(data.orderStatus) === '1'
            ? 'ticketing'
            : String(data.orderStatus) === '-3'
              ? 'cancelled'
              : 'pending_payment';

      const tickets = (data.paxTicketInfos ?? [])
        .flatMap((p: any) =>
          (p.ticketNos ?? []).map((t: string) => ({ passenger: p.name, ticketNumber: t })),
        )
        .filter((t: any) => t.ticketNumber);

      const merged: Order & { atlasOrderNo: string } = {
        orderId,
        atlasOrderNo: known?.atlasOrderNo ?? orderId,
        status,
        pnr: data.pnrCode ?? known?.pnr,
        totalPrice: known?.totalPrice ?? num(data.totalPrice),
        currency: data.currency ?? known?.currency ?? 'USD',
        expiresAt: data.tktLimitTime ?? known?.expiresAt,
        outbound: known?.outbound ?? [],
        inbound: known?.inbound,
        passengers: known?.passengers ?? [],
        tickets: tickets.length ? tickets : undefined,
        cardPayable: known?.cardPayable,
        depositPayable: known?.depositPayable,
        createdAt: known?.createdAt ?? new Date().toISOString(),
      };
      orders.set(orderId, merged);
      return merged;
    },

    async listOrders(): Promise<Order[]> {
      return [...orders.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async quoteRefund(orderId: string): Promise<RefundQuote> {
      const order = orders.get(orderId);
      const orderNo = order?.atlasOrderNo ?? orderId;

      // Atlas does not refund an order, it refunds named passengers off named
      // segments — `orderNo` alone is rejected with "refundRequestList is
      // required". Both lists are read back from the live order rather than
      // from our own record, because the airline matches on its own canonical
      // spelling of a name and its own flight numbering.
      const details = await queryOrder(config, orderNo);
      const { passengers, segments } = refundSubject(details, order);

      if (!passengers.length || !segments.length) {
        throw new BookingError(
          'That order has no passenger or flight detail to refund against — check the order first.',
          'refund_incomplete',
        );
      }

      const data = await refundCall(() =>
        post('refundQuotation.do', {
          orderNo,
          refundRequestList: passengers.map((p) => ({
            lastName: p.lastName,
            firstName: p.firstName,
            // '1' is voluntary — the traveller changing their mind. '0' is
            // involuntary (a cancellation by the airline) and carries different
            // rules, so it must not be assumed.
            refundReason: '1',
            segments,
          })),
        }),
      );

      const amount = num(data.refundAmount);
      const penalty = num(data.penaltyAmount);
      const total = order?.totalPrice ?? num(data.totalPrice);
      const refundable = data.isRefundable !== false;

      return {
        refundOfferId: data.refundOfferId ?? '',
        orderId,
        refundAmount: round(amount),
        // Prefer the airline's own penalty. Deriving it as total − refund is
        // only a fallback, and is wrong whenever taxes are handled separately.
        penalty: round(penalty || Math.max(0, total - amount)),
        currency: data.currency ?? order?.currency ?? 'USD',
        quoteType: refundable && amount > 0 ? 'AccurateQuote' : 'CannotQuote',
        note: !refundable
          ? 'The airline reports this ticket as non-refundable.'
          : amount === 0
            ? 'The airline could not confirm an amount; the final refund may differ.'
            : undefined,
      };
    },

    async submitRefund(orderId: string, refundOfferId: string): Promise<RefundStatus> {
      const order = orders.get(orderId);
      const data = await refundCall(() =>
        post('refund.do', {
          orderNo: order?.atlasOrderNo ?? orderId,
          refundOfferId,
        }),
      );
      return {
        refundId: data.refundCode ?? data.refundId ?? refundOfferId,
        orderId,
        // Atlas answers with a real state here. Reporting a flat "processing"
        // would show a rejected refund as still in progress.
        status: REFUND_STATUS[String(data.refundStatus)] ?? 'processing',
        amount: num(data.refundAmount),
        currency: data.currency ?? order?.currency ?? 'USD',
      };
    },

    async getRefund(orderId: string, refundId: string): Promise<RefundStatus> {
      const order = orders.get(orderId);
      const data = await post('queryRefundOrders.do', {
        orderNo: order?.atlasOrderNo ?? orderId,
        refundCode: refundId,
      });
      const row = (data.refundOrders ?? [])[0] ?? data;
      return {
        refundId,
        orderId,
        status: REFUND_STATUS[String(row.refundStatus)] ?? 'processing',
        amount: num(row.refundAmount),
        currency: row.currency ?? order?.currency ?? 'USD',
      };
    },
  };

  return provider;
}

/**
 * Billing address for VCC payments.
 *
 * Atlas requires a full billing address alongside the card, and it must match
 * what the card issuer holds or the charge is declined.
 */
function billingFromConfig(): BillingAddress {
  const raw = process.env.ATRIP_BILLING_ADDRESS;
  if (!raw) {
    throw new BookingError(
      'ATRIP_BILLING_ADDRESS is not set. Atlas requires a billing address for card payments — ' +
        'set it to a JSON object with firstName, lastName, country, province, city, postCode, address.',
      'billing_missing',
    );
  }
  try {
    return JSON.parse(raw) as BillingAddress;
  } catch {
    throw new BookingError('ATRIP_BILLING_ADDRESS is not valid JSON', 'billing_invalid');
  }
}

export function createAtlasProviderFromEnv(): BookingProvider | null {
  const config = atlasConfigFromEnv();
  return config ? createAtlasProvider(config) : null;
}
