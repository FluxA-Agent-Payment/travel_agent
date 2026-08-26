import { randomUUID } from 'node:crypto';

import { sharedMap } from '../store';

import type { BookingProvider, DraftOrderInput } from './provider';
import {
  BookingError,
  type CouponResult,
  type FlightOffer,
  type LuggageOption,
  type Order,
  type OrderDraft,
  type RefundQuote,
  type RefundStatus,
  type SearchParams,
  type SearchResult,
  type SeatMapSegment,
  type Segment,
  type VerifyResult,
} from '../types';

/**
 * Fixture-backed booking provider.
 *
 * This is a behavioural simulator, not a stub. It reproduces the parts of the
 * real flow that actually break bookings — price drift between search and
 * verify, ticketing completing several polls after payment, refunds walking
 * through airline processing before settling — so the UI and the agent are
 * exercised against realistic timing instead of instant success.
 *
 * State lives in module scope, which is fine for the single-operator v1. It
 * resets when the dev server restarts.
 */

const CARRIERS: Record<string, string> = {
  BA: 'British Airways',
  AA: 'American Airlines',
  EK: 'Emirates',
  SQ: 'Singapore Airlines',
  LH: 'Lufthansa',
  FR: 'Ryanair',
};

interface StoredOrder extends Order {
  /** Wall-clock ms when payment was confirmed; drives the ticketing sim. */
  paidAt?: number;
  refundRequestedAt?: number;
}

const drafts = sharedMap<OrderDraft>('mock.drafts');
const orders = sharedMap<StoredOrder>('mock.orders');
const verifiedSessions = sharedMap<{
  flightId: string;
  price: number;
  createdAt: number;
  offer: FlightOffer;
}>('mock.sessions');
const offers = sharedMap<FlightOffer>('mock.offers');

/** Deterministic pseudo-random in [0,1) from a string — keeps results stable. */
function hashUnit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Plausible connecting hubs, so a 1-stop itinerary names a real airport. */
const HUBS: Record<string, string[]> = {
  BA: ['LHR', 'DUB'],
  AA: ['ORD', 'MIA'],
  EK: ['DXB'],
  SQ: ['SIN', 'HKG'],
  LH: ['FRA', 'MUC'],
  FR: ['DUB', 'BCN'],
};

function buildSegments(
  from: string,
  to: string,
  date: string,
  carrier: string,
  seed: string,
): Segment[] {
  const u = hashUnit(seed);
  const depHour = 6 + Math.floor(u * 14);
  const totalDuration = 240 + Math.floor(u * 480);
  const dep = `${date}T${String(depHour).padStart(2, '0')}:${u > 0.5 ? '35' : '10'}:00Z`;
  const flightNo = 100 + Math.floor(u * 800);
  const origin = from.toUpperCase();
  const dest = to.toUpperCase();

  // Roughly a quarter of itineraries connect. Emit both legs plus a real
  // layover so the card has genuine detail to expand into, rather than a
  // "1 stop" label with nothing behind it.
  const connects = u > 0.72;
  if (!connects) {
    return [
      {
        flightNumber: `${carrier}${flightNo}`,
        carrier,
        departure: { airport: origin, time: dep },
        arrival: { airport: dest, time: addMinutes(dep, totalDuration) },
        durationMinutes: totalDuration,
        stops: 0,
      },
    ];
  }

  const options = (HUBS[carrier] ?? ['FRA', 'DXB']).filter(
    (h) => h !== origin && h !== dest,
  );
  const hub = options[Math.floor(u * options.length) % options.length] ?? 'FRA';
  const firstLeg = Math.round(totalDuration * (0.42 + u * 0.14));
  const layover = 55 + Math.floor(u * 130);
  const secondLeg = Math.max(60, totalDuration - firstLeg);
  const arriveHub = addMinutes(dep, firstLeg);
  const departHub = addMinutes(arriveHub, layover);

  return [
    {
      flightNumber: `${carrier}${flightNo}`,
      carrier,
      departure: { airport: origin, time: dep },
      arrival: { airport: hub, time: arriveHub },
      durationMinutes: firstLeg,
      stops: 0,
    },
    {
      flightNumber: `${carrier}${flightNo + 41}`,
      carrier,
      departure: { airport: hub, time: departHub },
      arrival: { airport: dest, time: addMinutes(departHub, secondLeg) },
      durationMinutes: secondLeg,
      stops: 0,
    },
  ];
}

export function createMockProvider(): BookingProvider {
  return {
    name: 'mock',

    async searchFlights(params: SearchParams): Promise<SearchResult> {
      const { from, to, date, returnDate } = params;
      if (!from || !to || !date) {
        throw new BookingError('from, to and date are required', 'bad_request');
      }
      const carriers = params.airlines?.length
        ? params.airlines
        : Object.keys(CARRIERS);

      const flights: FlightOffer[] = carriers.slice(0, 6).map((carrier, i) => {
        const seed = `${from}${to}${date}${carrier}${i}`;
        const u = hashUnit(seed);
        const base = money(120 + u * 780);
        const flightId = `fl_${carrier}_${Math.floor(u * 1e6)}`;
        const offer: FlightOffer = {
          flightId,
          price: {
            currency: 'USDC',
            adult: base,
            child: money(base * 0.78),
            infant: money(base * 0.12),
          },
          outbound: buildSegments(from, to, date, carrier, seed),
          inbound: returnDate
            ? buildSegments(to, from, returnDate, carrier, seed + 'r')
            : undefined,
          cabinClass: 'economy',
          baggageIncluded: u > 0.45,
          refundable: u > 0.7,
          seatsLeft: 1 + Math.floor(u * 8),
        };
        offers.set(flightId, offer);
        return offer;
      });

      flights.sort((a, b) => a.price.adult - b.price.adult);
      return { flights };
    },

    async verifyFlight(flightId: string): Promise<VerifyResult> {
      const offer = offers.get(flightId);
      if (!offer) {
        throw new BookingError(
          `Offer ${flightId} is no longer available — search again`,
          'offer_expired',
        );
      }

      // Roughly one offer in four moves in price between search and verify.
      const u = hashUnit(flightId + 'verify');
      const priceChanged = u > 0.75;
      const adult = priceChanged
        ? money(offer.price.adult * (1 + (u - 0.75) * 0.4))
        : offer.price.adult;

      const verifiedFlightId = `vf_${randomUUID().slice(0, 12)}`;
      verifiedSessions.set(verifiedFlightId, {
        flightId,
        price: adult,
        createdAt: Date.now(),
        offer,
      });

      return {
        verifiedFlightId,
        priceChanged,
        price: {
          currency: 'USDC',
          adult,
          child: money(adult * 0.78),
          infant: money(adult * 0.12),
        },
        previousPrice: priceChanged ? offer.price : undefined,
        maxSeats: offer.seatsLeft,
        outbound: offer.outbound,
        inbound: offer.inbound,
        bookingRequirements: ['passportNumber', 'dateOfBirth'],
      };
    },

    async getSeats(verifiedFlightId: string): Promise<SeatMapSegment[]> {
      const session = requireSession(verifiedFlightId);
      return session.offer.outbound.map((seg) => ({
        flightNumber: seg.flightNumber,
        rows: Array.from({ length: 6 }, (_, r) => {
          const row = 10 + r;
          return {
            row,
            seats: ['A', 'B', 'C', 'D', 'E', 'F'].map((letter) => {
              const u = hashUnit(`${verifiedFlightId}${row}${letter}`);
              return {
                code: `${row}${letter}`,
                available: u > 0.35,
                price: letter === 'A' || letter === 'F' ? 18 : 9,
                position:
                  letter === 'A' || letter === 'F'
                    ? 'window'
                    : letter === 'C' || letter === 'D'
                      ? 'aisle'
                      : 'middle',
              };
            }),
          };
        }),
      }));
    },

    async getLuggage(verifiedFlightId: string): Promise<LuggageOption[]> {
      requireSession(verifiedFlightId);
      return [
        { id: 'bag_15', description: 'Checked bag', weightKg: 15, price: 32 },
        { id: 'bag_23', description: 'Checked bag', weightKg: 23, price: 48 },
        { id: 'bag_32', description: 'Heavy checked bag', weightKg: 32, price: 79 },
      ];
    },

    async checkCoupon(code: string, orderAmount?: number): Promise<CouponResult> {
      const normalised = code.trim().toUpperCase();
      if (normalised === 'FIRSTFLIGHT') {
        if (orderAmount !== undefined && orderAmount < 100) {
          return {
            valid: false,
            code: normalised,
            reason: 'Minimum order amount is 100 USDC',
          };
        }
        return {
          valid: true,
          code: normalised,
          discount: orderAmount ? money(Math.min(orderAmount * 0.1, 60)) : 0,
        };
      }
      return { valid: false, code: normalised, reason: 'Coupon not found' };
    },

    async draftOrder(input: DraftOrderInput): Promise<OrderDraft> {
      const session = requireSession(input.verifiedFlightId);
      const { passengers } = input;
      if (!passengers?.length) {
        throw new BookingError('At least one passenger is required', 'bad_request');
      }

      const baseTotal = money(
        passengers.reduce((sum, p) => {
          if (p.type === 'child') return sum + session.price * 0.78;
          if (p.type === 'infant') return sum + session.price * 0.12;
          return sum + session.price;
        }, 0),
      );

      const seats = input.selectedSeats ?? [];
      const luggage = input.selectedLuggage ?? [];
      const seatsTotal = money(seats.length * 12);
      const luggageTotal = money(
        luggage.reduce((sum, id) => {
          if (id === 'bag_15') return sum + 32;
          if (id === 'bag_23') return sum + 48;
          if (id === 'bag_32') return sum + 79;
          return sum;
        }, 0),
      );

      const subtotal = money(baseTotal + seatsTotal + luggageTotal);
      let discount = 0;
      if (input.couponCode) {
        const coupon = await this.checkCoupon(input.couponCode, subtotal);
        if (!coupon.valid) {
          throw new BookingError(
            `Coupon invalid: ${coupon.reason}`,
            'coupon_invalid',
          );
        }
        discount = coupon.discount ?? 0;
      }

      const draft: OrderDraft = {
        draftId: `dr_${randomUUID().slice(0, 12)}`,
        verifiedFlightId: input.verifiedFlightId,
        passengers,
        contact: input.contact,
        selectedSeats: seats,
        selectedLuggage: luggage,
        couponCode: input.couponCode,
        quote: {
          baseTotal,
          seatsTotal,
          luggageTotal,
          discount,
          total: money(subtotal - discount),
          currency: 'USDC',
        },
        outbound: session.offer.outbound,
        inbound: session.offer.inbound,
      };
      drafts.set(draft.draftId, draft);
      return draft;
    },

    async placeOrder(draftId: string): Promise<Order> {
      const draft = drafts.get(draftId);
      if (!draft) {
        throw new BookingError(
          'That draft has expired — rebuild the order',
          'draft_expired',
        );
      }
      const orderId = `ord_${randomUUID().slice(0, 12)}`;
      const order: StoredOrder = {
        orderId,
        status: 'pending_payment',
        pnr: `MK${randomUUID().slice(0, 4).toUpperCase()}`,
        totalPrice: draft.quote.total,
        currency: 'USDC',
        paymentUrl: `https://pay.fluxapay.xyz/mock/${orderId}`,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        outbound: draft.outbound,
        inbound: draft.inbound,
        passengers: draft.passengers,
        createdAt: new Date().toISOString(),
      };
      orders.set(orderId, order);
      drafts.delete(draftId);
      return order;
    },

    async completePayment(orderId: string): Promise<Order> {
      const order = requireOrder(orderId);
      if (order.status === 'ticketed' || order.status === 'ticketing') {
        return settle(order);
      }
      if (order.status !== 'pending_payment') {
        throw new BookingError(
          `Cannot pay an order in status ${order.status}`,
          'bad_state',
        );
      }
      order.status = 'ticketing';
      order.paidAt = Date.now();
      return settle(order);
    },

    async getOrder(orderId: string): Promise<Order> {
      return settle(requireOrder(orderId));
    },

    async listOrders(): Promise<Order[]> {
      return [...orders.values()]
        .map(settle)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async quoteRefund(orderId: string): Promise<RefundQuote> {
      const order = settle(requireOrder(orderId));
      if (order.status !== 'ticketed') {
        throw new BookingError(
          `Only ticketed orders can be refunded (this one is ${order.status})`,
          'bad_state',
        );
      }
      const u = hashUnit(orderId + 'refund');
      const penalty = money(order.totalPrice * (0.1 + u * 0.35));
      return {
        refundOfferId: `rq_${randomUUID().slice(0, 10)}`,
        orderId,
        refundAmount: money(order.totalPrice - penalty),
        penalty,
        currency: 'USDC',
        quoteType: u > 0.8 ? 'CannotQuote' : 'AccurateQuote',
        note:
          u > 0.8
            ? 'The airline could not confirm an exact amount; the final refund may differ.'
            : undefined,
      };
    },

    async submitRefund(orderId: string, refundOfferId: string): Promise<RefundStatus> {
      const order = requireOrder(orderId);
      const quote = await this.quoteRefund(orderId);
      order.refundRequestedAt = Date.now();
      order.refund = {
        refundId: `rf_${refundOfferId.slice(3)}`,
        orderId,
        status: 'processing',
        amount: quote.refundAmount,
        currency: 'USDC',
      };
      return order.refund;
    },

    async getRefund(orderId: string, refundId: string): Promise<RefundStatus> {
      const order = settle(requireOrder(orderId));
      if (!order.refund || order.refund.refundId !== refundId) {
        throw new BookingError('Refund not found', 'not_found');
      }
      return order.refund;
    },
  };
}

function requireSession(verifiedFlightId: string) {
  const session = verifiedSessions.get(verifiedFlightId);
  if (!session) {
    throw new BookingError(
      'That verified fare has expired — verify the flight again',
      'session_expired',
    );
  }
  // Real Atlas sessions live 2 hours; keep the same shape so the agent learns
  // to handle expiry rather than assuming sessions are permanent.
  if (Date.now() - session.createdAt > 2 * 60 * 60_000) {
    verifiedSessions.delete(verifiedFlightId);
    throw new BookingError(
      'That verified fare expired after 2 hours — verify again',
      'session_expired',
    );
  }
  return session;
}

function requireOrder(orderId: string): StoredOrder {
  const order = orders.get(orderId);
  if (!order) throw new BookingError(`Order ${orderId} not found`, 'not_found');
  return order;
}

/**
 * Advance an order's simulated async state.
 *
 * Ticketing completes 12s after payment and refunds settle 20s after
 * submission — long enough that the UI genuinely has to show a pending state,
 * short enough to demo.
 */
function settle(order: StoredOrder): StoredOrder {
  if (order.status === 'ticketing' && order.paidAt) {
    if (Date.now() - order.paidAt > 12_000) {
      order.status = 'ticketed';
      order.tickets = order.passengers.map((p, i) => ({
        passenger: `${p.firstName} ${p.lastName}`,
        ticketNumber: `${125}-${String(1000000 + i).slice(0, 7)}`,
      }));
    }
  }
  if (order.refund && order.refundRequestedAt) {
    const elapsed = Date.now() - order.refundRequestedAt;
    if (elapsed > 20_000) order.refund.status = 'refunded';
    else if (elapsed > 8_000) order.refund.status = 'airline_processing';
  }
  return order;
}
