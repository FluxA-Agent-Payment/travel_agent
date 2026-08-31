import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProvider } from '../booking/mock';
import type { BookingProvider } from '../booking/provider';
import { BookingError, isBookingError } from '../types';

let provider: BookingProvider;

beforeEach(() => {
  provider = createMockProvider();
});

/* ---------- searchFlights ---------- */

describe('searchFlights', () => {
  it('returns flights sorted by adult price ascending', async () => {
    const result = await provider.searchFlights({
      from: 'LHR',
      to: 'JFK',
      date: '2026-09-15',
    });
    expect(result.flights.length).toBeGreaterThan(0);
    for (let i = 1; i < result.flights.length; i++) {
      expect(result.flights[i].price.adult).toBeGreaterThanOrEqual(
        result.flights[i - 1].price.adult,
      );
    }
  });

  it('returns priced offers with flightIds', async () => {
    const result = await provider.searchFlights({
      from: 'SIN',
      to: 'HKG',
      date: '2026-10-01',
    });
    for (const f of result.flights) {
      expect(f.flightId).toBeTruthy();
      expect(f.price.currency).toBe('USDC');
      expect(f.price.adult).toBeGreaterThan(0);
    }
  });

  it('returns deterministic results for the same inputs', async () => {
    const a = await provider.searchFlights({ from: 'LHR', to: 'JFK', date: '2026-09-15' });
    const b = await provider.searchFlights({ from: 'LHR', to: 'JFK', date: '2026-09-15' });
    expect(a.flights.map((f) => f.flightId)).toEqual(b.flights.map((f) => f.flightId));
    expect(a.flights.map((f) => f.price.adult)).toEqual(b.flights.map((f) => f.price.adult));
  });

  it('throws on missing required parameters', async () => {
    await expect(provider.searchFlights({ from: '', to: 'JFK', date: '2026-09-15' }))
      .rejects.toThrow(/required/);
  });

  it('includes outbound segments with real flight data', async () => {
    const result = await provider.searchFlights({
      from: 'LHR',
      to: 'JFK',
      date: '2026-09-15',
    });
    const first = result.flights[0];
    expect(first.outbound.length).toBeGreaterThanOrEqual(1);
    expect(first.outbound[0].departure.airport).toBe('LHR');
    expect(first.outbound[0].arrival.airport).toBe('JFK');
    expect(first.outbound[0].flightNumber).toBeTruthy();
    expect(first.outbound[0].carrier).toBeTruthy();
  });

  it('includes return segments for round trips', async () => {
    const result = await provider.searchFlights({
      from: 'LHR',
      to: 'JFK',
      date: '2026-09-15',
      returnDate: '2026-09-22',
    });
    for (const f of result.flights) {
      expect(f.inbound).toBeDefined();
      expect(f.inbound!.length).toBeGreaterThanOrEqual(1);
      // First inbound segment departs from the destination.
      expect(f.inbound![0].departure.airport).toBe('JFK');
      // Final inbound segment arrives at the origin (may be a connecting flight).
      const lastSeg = f.inbound![f.inbound!.length - 1];
      expect(lastSeg.arrival.airport).toBe('LHR');
    }
  });

  it('respects airline filter', async () => {
    const result = await provider.searchFlights({
      from: 'LHR',
      to: 'JFK',
      date: '2026-09-15',
      airlines: ['BA'],
    });
    expect(result.flights).toHaveLength(1);
    expect(result.flights[0].outbound[0].carrier).toBe('BA');
  });

  it('applies child and infant pricing ratios', async () => {
    const result = await provider.searchFlights({
      from: 'LHR',
      to: 'JFK',
      date: '2026-09-15',
    });
    for (const f of result.flights) {
      expect(f.price.child).toBeCloseTo(f.price.adult * 0.78, 1);
      expect(f.price.infant).toBeCloseTo(f.price.adult * 0.12, 1);
    }
  });
});

/* ---------- verifyFlight ---------- */

describe('verifyFlight', () => {
  it('returns a verifiedFlightId on success', async () => {
    const search = await provider.searchFlights({ from: 'LHR', to: 'JFK', date: '2026-09-15' });
    const result = await provider.verifyFlight(search.flights[0].flightId);
    expect(result.verifiedFlightId).toBeTruthy();
    expect(result.verifiedFlightId).toMatch(/^vf_/);
  });

  it('throws offer_expired for an unknown flightId', async () => {
    try {
      await provider.verifyFlight('fl_nonexistent');
      expect.fail('should have thrown');
    } catch (err) {
      expect(isBookingError(err)).toBe(true);
      expect((err as BookingError).code).toBe('offer_expired');
    }
  });

  it('carries outbound and inbound segments', async () => {
    const search = await provider.searchFlights({
      from: 'LHR',
      to: 'JFK',
      date: '2026-09-15',
      returnDate: '2026-09-22',
    });
    const result = await provider.verifyFlight(search.flights[0].flightId);
    expect(result.outbound.length).toBeGreaterThanOrEqual(1);
    expect(result.inbound!.length).toBeGreaterThanOrEqual(1);
  });

  it('reports bookingRequirements', async () => {
    const search = await provider.searchFlights({ from: 'LHR', to: 'JFK', date: '2026-09-15' });
    const result = await provider.verifyFlight(search.flights[0].flightId);
    expect(result.bookingRequirements).toContain('passportNumber');
    expect(result.bookingRequirements).toContain('dateOfBirth');
  });
});

/* ---------- session expiry ---------- */

describe('session expiry', () => {
  it('rejects an expired verified session (2h TTL)', async () => {
    const search = await provider.searchFlights({ from: 'LHR', to: 'JFK', date: '2026-09-15' });
    const verified = await provider.verifyFlight(search.flights[0].flightId);

    // Advance time past the 2-hour window.
    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 60 * 60_000 + 1;
    try {
      await provider.draftOrder({
        verifiedFlightId: verified.verifiedFlightId,
        passengers: [{ firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', type: 'adult' }],
        contact: { phone: '+447700900001', email: 'a@b.com' },
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(isBookingError(err)).toBe(true);
      expect((err as BookingError).code).toBe('session_expired');
    } finally {
      Date.now = realNow;
    }
  });
});

/* ---------- getSeats ---------- */

describe('getSeats', () => {
  it('returns seat maps for each outbound segment', async () => {
    const search = await provider.searchFlights({ from: 'LHR', to: 'JFK', date: '2026-09-15' });
    const verified = await provider.verifyFlight(search.flights[0].flightId);
    const seats = await provider.getSeats(verified.verifiedFlightId);
    expect(seats.length).toBeGreaterThanOrEqual(1);
    expect(seats[0].rows.length).toBe(6);
    expect(seats[0].rows[0].seats).toHaveLength(6);
  });

  it('prices window seats higher than middle/aisle', async () => {
    const search = await provider.searchFlights({ from: 'LHR', to: 'JFK', date: '2026-09-15' });
    const verified = await provider.verifyFlight(search.flights[0].flightId);
    const seats = await provider.getSeats(verified.verifiedFlightId);
    const row = seats[0].rows[0];
    const windowA = row.seats.find((s) => s.code.endsWith('A'))!;
    const middle = row.seats.find((s) => s.code.endsWith('B'))!;
    expect(windowA.price).toBe(18);
    expect(middle.price).toBe(9);
  });

  it('labels seat positions correctly', async () => {
    const search = await provider.searchFlights({ from: 'LHR', to: 'JFK', date: '2026-09-15' });
    const verified = await provider.verifyFlight(search.flights[0].flightId);
    const seats = await provider.getSeats(verified.verifiedFlightId);
    const row = seats[0].rows[0];
    expect(row.seats.find((s) => s.code.endsWith('A'))!.position).toBe('window');
    expect(row.seats.find((s) => s.code.endsWith('B'))!.position).toBe('middle');
    expect(row.seats.find((s) => s.code.endsWith('C'))!.position).toBe('aisle');
  });

  it('throws for an expired session', async () => {
    await expect(provider.getSeats('vf_nonexistent')).rejects.toThrow(/expired/);
  });
});

/* ---------- getLuggage ---------- */

describe('getLuggage', () => {
  it('returns three baggage options', async () => {
    const search = await provider.searchFlights({ from: 'LHR', to: 'JFK', date: '2026-09-15' });
    const verified = await provider.verifyFlight(search.flights[0].flightId);
    const bags = await provider.getLuggage(verified.verifiedFlightId);
    expect(bags).toHaveLength(3);
    expect(bags.map((b) => b.weightKg)).toEqual([15, 23, 32]);
    expect(bags.map((b) => b.price)).toEqual([32, 48, 79]);
  });
});

/* ---------- checkCoupon ---------- */

describe('checkCoupon', () => {
  it('validates FIRSTFLIGHT with sufficient amount', async () => {
    const result = await provider.checkCoupon('FIRSTFLIGHT', 200);
    expect(result.valid).toBe(true);
    expect(result.discount).toBe(20); // 10% of 200
  });

  it('caps FIRSTFLIGHT discount at 60 USDC', async () => {
    const result = await provider.checkCoupon('FIRSTFLIGHT', 1000);
    expect(result.valid).toBe(true);
    expect(result.discount).toBe(60);
  });

  it('rejects FIRSTFLIGHT below minimum order amount', async () => {
    const result = await provider.checkCoupon('FIRSTFLIGHT', 50);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/minimum/i);
  });

  it('rejects unknown coupons', async () => {
    const result = await provider.checkCoupon('INVALIDCODE', 200);
    expect(result.valid).toBe(false);
  });

  it('normalises coupon codes to uppercase', async () => {
    const result = await provider.checkCoupon('firstflight', 200);
    expect(result.valid).toBe(true);
    expect(result.code).toBe('FIRSTFLIGHT');
  });
});

/* ---------- draftOrder ---------- */

describe('draftOrder', () => {
  async function verifiedId() {
    const search = await provider.searchFlights({ from: 'LHR', to: 'JFK', date: '2026-09-15' });
    const verified = await provider.verifyFlight(search.flights[0].flightId);
    return verified;
  }

  it('produces a priced draft with full breakdown', async () => {
    const verified = await verifiedId();
    const draft = await provider.draftOrder({
      verifiedFlightId: verified.verifiedFlightId,
      passengers: [{ firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', type: 'adult' }],
      contact: { phone: '+447700900001', email: 'a@b.com' },
    });
    expect(draft.draftId).toMatch(/^dr_/);
    expect(draft.quote.baseTotal).toBeGreaterThan(0);
    expect(draft.quote.total).toBeGreaterThan(0);
    expect(draft.quote.currency).toBe('USDC');
    expect(draft.passengers).toHaveLength(1);
  });

  it('includes luggage totals in the draft', async () => {
    const verified = await verifiedId();
    const draft = await provider.draftOrder({
      verifiedFlightId: verified.verifiedFlightId,
      passengers: [{ firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', type: 'adult' }],
      contact: { phone: '+447700900001', email: 'a@b.com' },
      selectedLuggage: ['bag_23'],
    });
    expect(draft.quote.luggageTotal).toBe(48);
  });

  it('includes seats totals in the draft', async () => {
    const verified = await verifiedId();
    const draft = await provider.draftOrder({
      verifiedFlightId: verified.verifiedFlightId,
      passengers: [{ firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', type: 'adult' }],
      contact: { phone: '+447700900001', email: 'a@b.com' },
      selectedSeats: ['10A', '10B'],
    });
    // Mock uses a flat $12/seat regardless of seat position.
    expect(draft.quote.seatsTotal).toBe(24);
  });

  it('applies coupon discount to the draft total', async () => {
    const verified = await verifiedId();
    const draft = await provider.draftOrder({
      verifiedFlightId: verified.verifiedFlightId,
      passengers: [{ firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', type: 'adult' }],
      contact: { phone: '+447700900001', email: 'a@b.com' },
      couponCode: 'FIRSTFLIGHT',
    });
    expect(draft.quote.discount).toBeGreaterThan(0);
  });

  it('rejects an invalid coupon', async () => {
    const verified = await verifiedId();
    try {
      await provider.draftOrder({
        verifiedFlightId: verified.verifiedFlightId,
        passengers: [{ firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', type: 'adult' }],
        contact: { phone: '+447700900001', email: 'a@b.com' },
        couponCode: 'BADCODE',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(isBookingError(err)).toBe(true);
      expect((err as BookingError).code).toBe('coupon_invalid');
    }
  });

  it('throws on zero passengers', async () => {
    const verified = await verifiedId();
    await expect(
      provider.draftOrder({
        verifiedFlightId: verified.verifiedFlightId,
        passengers: [],
        contact: { phone: '+447700900001', email: 'a@b.com' },
      }),
    ).rejects.toThrow(/passenger/i);
  });

  it('prices child and infant passengers correctly', async () => {
    const verified = await verifiedId();
    const adultPrice = verified.price.adult;
    const draft = await provider.draftOrder({
      verifiedFlightId: verified.verifiedFlightId,
      passengers: [
        { firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', type: 'adult' },
        { firstName: 'C', lastName: 'B', dateOfBirth: '2018-01-01', type: 'child' },
        { firstName: 'D', lastName: 'B', dateOfBirth: '2025-06-01', type: 'infant' },
      ],
      contact: { phone: '+447700900001', email: 'a@b.com' },
    });
    const expected = adultPrice + adultPrice * 0.78 + adultPrice * 0.12;
    expect(draft.quote.baseTotal).toBeCloseTo(expected, 1);
  });
});

/* ---------- placeOrder ---------- */

describe('placeOrder', () => {
  async function draftId() {
    const search = await provider.searchFlights({ from: 'LHR', to: 'JFK', date: '2026-09-15' });
    const verified = await provider.verifyFlight(search.flights[0].flightId);
    const draft = await provider.draftOrder({
      verifiedFlightId: verified.verifiedFlightId,
      passengers: [{ firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', type: 'adult' }],
      contact: { phone: '+447700900001', email: 'a@b.com' },
    });
    return draft.draftId;
  }

  it('creates a pending_payment order from a draft', async () => {
    const id = await draftId();
    const order = await provider.placeOrder(id);
    expect(order.orderId).toMatch(/^ord_/);
    expect(order.status).toBe('pending_payment');
    expect(order.pnr).toBeTruthy();
    expect(order.totalPrice).toBeGreaterThan(0);
    expect(order.expiresAt).toBeTruthy();
  });

  it('invalidates the draft after placing', async () => {
    const id = await draftId();
    await provider.placeOrder(id);
    await expect(provider.placeOrder(id)).rejects.toThrow(/expired/);
  });

  it('throws draft_expired for an unknown draftId', async () => {
    await expect(provider.placeOrder('dr_nonexistent')).rejects.toThrow(/expired/);
  });
});

/* ---------- completePayment and async ticketing ---------- */

describe('completePayment', () => {
  async function pendingOrder() {
    const search = await provider.searchFlights({ from: 'LHR', to: 'JFK', date: '2026-09-15' });
    const verified = await provider.verifyFlight(search.flights[0].flightId);
    const draft = await provider.draftOrder({
      verifiedFlightId: verified.verifiedFlightId,
      passengers: [{ firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', type: 'adult' }],
      contact: { phone: '+447700900001', email: 'a@b.com' },
    });
    const order = await provider.placeOrder(draft.draftId);
    return order.orderId;
  }

  it('moves an order to ticketing on payment', async () => {
    const orderId = await pendingOrder();
    const paid = await provider.completePayment(orderId);
    expect(paid.status).toBe('ticketing');
  });

  it('auto-advances to ticketed after 12 seconds', async () => {
    const orderId = await pendingOrder();
    await provider.completePayment(orderId);

    // Advance time 13 seconds.
    const realNow = Date.now;
    Date.now = () => realNow() + 13_000;
    try {
      const order = await provider.getOrder(orderId);
      expect(order.status).toBe('ticketed');
      expect(order.tickets).toBeDefined();
      expect(order.tickets!.length).toBeGreaterThan(0);
      expect(order.tickets![0].ticketNumber).toBeTruthy();
    } finally {
      Date.now = realNow;
    }
  });

  it('rejects payment on an order that is not pending', async () => {
    const orderId = await pendingOrder();
    await provider.completePayment(orderId);

    // Already ticketing — should return the settled state, not throw.
    const again = await provider.completePayment(orderId);
    expect(['ticketing', 'ticketed']).toContain(again.status);
  });

  it('throws for an unknown order', async () => {
    await expect(provider.completePayment('ord_nonexistent')).rejects.toThrow();
  });
});

/* ---------- getOrder and listOrders ---------- */

describe('getOrder / listOrders', () => {
  it('retrieves an order by id', async () => {
    const search = await provider.searchFlights({ from: 'LHR', to: 'JFK', date: '2026-09-15' });
    const verified = await provider.verifyFlight(search.flights[0].flightId);
    const draft = await provider.draftOrder({
      verifiedFlightId: verified.verifiedFlightId,
      passengers: [{ firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', type: 'adult' }],
      contact: { phone: '+447700900001', email: 'a@b.com' },
    });
    const order = await provider.placeOrder(draft.draftId);
    const fetched = await provider.getOrder(order.orderId);
    expect(fetched.orderId).toBe(order.orderId);
  });

  it('lists orders most recent first', async () => {
    const search = await provider.searchFlights({ from: 'LHR', to: 'JFK', date: '2026-09-15' });
    const v1 = await provider.verifyFlight(search.flights[0].flightId);
    const d1 = await provider.draftOrder({
      verifiedFlightId: v1.verifiedFlightId,
      passengers: [{ firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', type: 'adult' }],
      contact: { phone: '+447700900001', email: 'a@b.com' },
    });
    await provider.placeOrder(d1.draftId);

    const v2 = await provider.verifyFlight(search.flights[1].flightId);
    const d2 = await provider.draftOrder({
      verifiedFlightId: v2.verifiedFlightId,
      passengers: [{ firstName: 'C', lastName: 'D', dateOfBirth: '1985-06-01', type: 'adult' }],
      contact: { phone: '+447700900002', email: 'c@d.com' },
    });
    await provider.placeOrder(d2.draftId);

    const orders = await provider.listOrders();
    expect(orders.length).toBeGreaterThanOrEqual(2);
    expect(new Date(orders[0].createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(orders[1].createdAt).getTime(),
    );
  });
});

/* ---------- quoteRefund ---------- */

describe('quoteRefund', () => {
  async function ticketedOrder() {
    const search = await provider.searchFlights({ from: 'LHR', to: 'JFK', date: '2026-09-15' });
    const verified = await provider.verifyFlight(search.flights[0].flightId);
    const draft = await provider.draftOrder({
      verifiedFlightId: verified.verifiedFlightId,
      passengers: [{ firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', type: 'adult' }],
      contact: { phone: '+447700900001', email: 'a@b.com' },
    });
    const order = await provider.placeOrder(draft.draftId);
    await provider.completePayment(order.orderId);

    // Advance past ticketing delay.
    const realNow = Date.now;
    Date.now = () => realNow() + 13_000;
    try {
      const ticketed = await provider.getOrder(order.orderId);
      return ticketed.orderId;
    } finally {
      Date.now = realNow;
    }
  }

  it('returns a refund quote for a ticketed order', async () => {
    const orderId = await ticketedOrder();
    // Need to re-advance time for the settle() inside quoteRefund.
    const realNow = Date.now;
    Date.now = () => realNow() + 13_000;
    try {
      const quote = await provider.quoteRefund(orderId);
      expect(quote.refundOfferId).toBeTruthy();
      expect(quote.refundAmount).toBeGreaterThan(0);
      expect(quote.penalty).toBeGreaterThanOrEqual(0);
      expect(quote.currency).toBe('USDC');
      expect(['AccurateQuote', 'CannotQuote']).toContain(quote.quoteType);
    } finally {
      Date.now = realNow;
    }
  });

  it('rejects refund on a non-ticketed order', async () => {
    const search = await provider.searchFlights({ from: 'LHR', to: 'JFK', date: '2026-09-15' });
    const verified = await provider.verifyFlight(search.flights[0].flightId);
    const draft = await provider.draftOrder({
      verifiedFlightId: verified.verifiedFlightId,
      passengers: [{ firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', type: 'adult' }],
      contact: { phone: '+447700900001', email: 'a@b.com' },
    });
    const order = await provider.placeOrder(draft.draftId);
    try {
      await provider.quoteRefund(order.orderId);
      expect.fail('should have thrown');
    } catch (err) {
      expect(isBookingError(err)).toBe(true);
      expect((err as BookingError).code).toBe('bad_state');
    }
  });
});

/* ---------- submitRefund and async refund lifecycle ---------- */

describe('submitRefund', () => {
  async function refundedSetup() {
    const search = await provider.searchFlights({ from: 'LHR', to: 'JFK', date: '2026-09-15' });
    const verified = await provider.verifyFlight(search.flights[0].flightId);
    const draft = await provider.draftOrder({
      verifiedFlightId: verified.verifiedFlightId,
      passengers: [{ firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', type: 'adult' }],
      contact: { phone: '+447700900001', email: 'a@b.com' },
    });
    const order = await provider.placeOrder(draft.draftId);
    await provider.completePayment(order.orderId);

    const realNow = Date.now;
    Date.now = () => realNow() + 13_000;
    try {
      const ticketed = await provider.getOrder(order.orderId);
      const quote = await provider.quoteRefund(ticketed.orderId);
      return { orderId: ticketed.orderId, refundOfferId: quote.refundOfferId };
    } finally {
      Date.now = realNow;
    }
  }

  it('submits a refund and returns processing status', async () => {
    const { orderId, refundOfferId } = await refundedSetup();
    const refund = await provider.submitRefund(orderId, refundOfferId);
    expect(refund.refundId).toBeTruthy();
    expect(refund.status).toBe('processing');
    expect(refund.amount).toBeGreaterThan(0);
  });

  it('advances to airline_processing after 8s', async () => {
    const { orderId, refundOfferId } = await refundedSetup();
    await provider.submitRefund(orderId, refundOfferId);

    const realNow = Date.now;
    Date.now = () => realNow() + 9_000;
    try {
      const order = await provider.getOrder(orderId);
      expect(order.refund!.status).toBe('airline_processing');
    } finally {
      Date.now = realNow;
    }
  });

  it('advances to refunded after 20s', async () => {
    const { orderId, refundOfferId } = await refundedSetup();
    await provider.submitRefund(orderId, refundOfferId);

    const realNow = Date.now;
    Date.now = () => realNow() + 21_000;
    try {
      const order = await provider.getOrder(orderId);
      expect(order.refund!.status).toBe('refunded');
    } finally {
      Date.now = realNow;
    }
  });
});
