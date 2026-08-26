import { randomUUID } from 'node:crypto';

import { sharedMap } from '../store';

import type { BookingProvider, DraftOrderInput } from './provider';
import {
  BookingError,
  type CouponResult,
  type LuggageOption,
  type Order,
  type OrderDraft,
  type RefundQuote,
  type RefundStatus,
  type SearchParams,
  type SearchResult,
  type SeatMapSegment,
  type VerifyResult,
} from '../types';

/**
 * Live provider — talks to the flight402 REST API, which wraps Atlas
 * (AtripTech) and settles in USDC over FluxA x402.
 *
 * Auth is a short-lived FluxA Agent Verifiable Credential minted with
 *   fluxa-wallet agent-vc --audience urn:flight402:api --challenge flight402
 * and supplied via FLIGHT402_AGENT_VC. It is read server-side only and never
 * reaches the browser.
 */

interface Flight402Config {
  baseUrl: string;
  agentVc: string;
}

/**
 * Drafts are held locally because flight402 has no "price without booking"
 * endpoint — its POST /v1/orders both books on Atlas and returns a payment
 * link. Keeping the draft on our side is what preserves the invariant that
 * pricing an order is free of side effects and placing one is not.
 */
const drafts = sharedMap<OrderDraft & { input: DraftOrderInput }>('flight402.drafts');

export function createFlight402Provider(config: Flight402Config): BookingProvider {
  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.agentVc}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
    } catch (err) {
      throw new BookingError(
        `Could not reach the booking service: ${(err as Error).message}`,
        'network',
        true,
      );
    }

    const text = await res.text();
    let payload: any;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new BookingError(
        `Booking service returned a non-JSON response (HTTP ${res.status})`,
        'bad_response',
      );
    }

    if (!res.ok) {
      // 402 is flight402's "payment not yet received" — a normal state in the
      // flow, not a fault, so it is surfaced as a distinct, non-retryable code.
      const code =
        res.status === 402
          ? 'payment_pending'
          : res.status === 401
            ? 'unauthorized'
            : res.status >= 500
              ? 'upstream'
              : 'bad_request';
      throw new BookingError(
        payload?.error ?? `Booking service error (HTTP ${res.status})`,
        code,
        res.status >= 500,
      );
    }
    return payload as T;
  }

  return {
    name: 'flight402',

    async searchFlights(params: SearchParams): Promise<SearchResult> {
      return call('POST', '/v1/flights/search', {
        from: params.from,
        to: params.to,
        date: params.date,
        returnDate: params.returnDate,
        adults: params.adults ?? 1,
        children: params.children ?? 0,
        infants: params.infants ?? 0,
        airlines: params.airlines,
      });
    },

    async verifyFlight(flightId: string): Promise<VerifyResult> {
      return call('POST', `/v1/flights/${encodeURIComponent(flightId)}/verify`);
    },

    async getSeats(verifiedFlightId: string): Promise<SeatMapSegment[]> {
      const res = await call<{ segments: SeatMapSegment[] }>(
        'GET',
        `/v1/flights/${encodeURIComponent(verifiedFlightId)}/seats`,
      );
      return res.segments ?? [];
    },

    async getLuggage(verifiedFlightId: string): Promise<LuggageOption[]> {
      const res = await call<{ options: LuggageOption[] }>(
        'GET',
        `/v1/flights/${encodeURIComponent(verifiedFlightId)}/luggage`,
      );
      return res.options ?? [];
    },

    async checkCoupon(code: string, orderAmount?: number): Promise<CouponResult> {
      return call('POST', '/v1/coupons/check', { code, orderAmount });
    },

    async draftOrder(input: DraftOrderInput): Promise<OrderDraft> {
      // Price the order from read-only calls only. Nothing is booked here.
      const verify = await this.verifyFlight(input.verifiedFlightId).catch(() => null);
      const luggage = await this.getLuggage(input.verifiedFlightId).catch(
        () => [] as LuggageOption[],
      );

      const adult = verify?.price.adult ?? 0;
      const child = verify?.price.child ?? adult * 0.78;
      const infant = verify?.price.infant ?? adult * 0.12;

      const baseTotal = round(
        input.passengers.reduce((sum, p) => {
          if (p.type === 'child') return sum + child;
          if (p.type === 'infant') return sum + infant;
          return sum + adult;
        }, 0),
      );

      const luggageTotal = round(
        (input.selectedLuggage ?? []).reduce((sum, id) => {
          const option = luggage.find((l) => l.id === id);
          return sum + (option?.price ?? 0);
        }, 0),
      );
      const seatsTotal = round((input.selectedSeats ?? []).length * 12);
      const subtotal = round(baseTotal + seatsTotal + luggageTotal);

      let discount = 0;
      if (input.couponCode) {
        const coupon = await this.checkCoupon(input.couponCode, subtotal);
        if (!coupon.valid) {
          throw new BookingError(`Coupon invalid: ${coupon.reason}`, 'coupon_invalid');
        }
        discount = coupon.discount ?? 0;
      }

      const draft: OrderDraft = {
        draftId: `dr_${randomUUID().slice(0, 12)}`,
        verifiedFlightId: input.verifiedFlightId,
        passengers: input.passengers,
        contact: input.contact,
        selectedSeats: input.selectedSeats ?? [],
        selectedLuggage: input.selectedLuggage ?? [],
        couponCode: input.couponCode,
        quote: {
          baseTotal,
          seatsTotal,
          luggageTotal,
          discount,
          total: round(subtotal - discount),
          currency: 'USDC',
        },
        outbound: verify?.outbound ?? [],
        inbound: verify?.inbound,
      };
      drafts.set(draft.draftId, { ...draft, input });
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
      const res = await call<any>('POST', '/v1/orders', {
        verifiedFlightId: draft.input.verifiedFlightId,
        passengers: draft.input.passengers,
        contact: draft.input.contact,
        selectedSeats: draft.input.selectedSeats,
        selectedLuggage: draft.input.selectedLuggage,
        couponCode: draft.input.couponCode,
      });
      drafts.delete(draftId);
      return {
        orderId: res.orderId,
        status: 'pending_payment',
        pnr: res.pnr,
        totalPrice: res.totalPrice,
        currency: 'USDC',
        paymentUrl: res.paymentUrl,
        expiresAt: res.expiresAt,
        outbound: draft.outbound,
        inbound: draft.inbound,
        passengers: draft.passengers,
        createdAt: new Date().toISOString(),
      };
    },

    async completePayment(orderId: string): Promise<Order> {
      await call('POST', `/v1/orders/${encodeURIComponent(orderId)}/complete-payment`);
      return this.getOrder(orderId);
    },

    async getOrder(orderId: string): Promise<Order> {
      const res = await call<any>('GET', `/v1/orders/${encodeURIComponent(orderId)}`);
      return {
        orderId: res.orderId,
        status: res.status,
        pnr: res.pnr,
        totalPrice: res.totalPrice,
        currency: 'USDC',
        paymentUrl: res.paymentUrl,
        outbound: res.flights?.outbound ?? [],
        inbound: res.flights?.inbound,
        passengers: res.passengers ?? [],
        tickets: res.tickets,
        refund: res.refund,
        createdAt: res.createdAt ?? new Date().toISOString(),
      };
    },

    async listOrders(): Promise<Order[]> {
      // flight402 exposes no per-agent order list on /v1; orders are tracked
      // by ID from the conversation. Returning empty keeps the tool honest
      // rather than inventing a listing the backend cannot provide.
      return [];
    },

    async quoteRefund(orderId: string): Promise<RefundQuote> {
      return call('POST', `/v1/orders/${encodeURIComponent(orderId)}/refund-quote`);
    },

    async submitRefund(orderId: string, refundOfferId: string): Promise<RefundStatus> {
      return call('POST', `/v1/orders/${encodeURIComponent(orderId)}/refund`, {
        refundOfferId,
      });
    },

    async getRefund(orderId: string, refundId: string): Promise<RefundStatus> {
      return call(
        'GET',
        `/v1/orders/${encodeURIComponent(orderId)}/refund/${encodeURIComponent(refundId)}`,
      );
    },
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
