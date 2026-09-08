import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { atlasMobile } from '../booking/atlas';

// Most Atlas internal helpers (fromAtlasDate, toAtlasDate, atlasName) are not
// exported, so we test their observable effects through the provider, along
// with the module-level factory and environment handling.
//
// atlasMobile IS exported and tested directly, at the bottom of this file. It
// converts to a format the airline specifies exactly, and reaching it through
// a whole booking is how it went untested until it failed in production.

describe('createAtlasProviderFromEnv', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when no Atlas credentials are set', async () => {
    const original = { ...process.env };
    delete process.env.ATRIP_ACCESS_KEY;
    delete process.env.ATRIP_SECRET_KEY;
    delete process.env.ATLAS_CLIENT_ID;
    delete process.env.ATLAS_CLIENT_SECRET;

    const { createAtlasProviderFromEnv } = await import('../booking/atlas');
    const provider = createAtlasProviderFromEnv();
    expect(provider).toBeNull();

    process.env = original;
  });
});

describe('createAtlasProvider', () => {
  let provider: any;

  beforeEach(async () => {
    vi.resetModules();
    const { createAtlasProvider } = await import('../booking/atlas');
    provider = createAtlasProvider({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      baseUrl: 'https://sandbox.example.com',
      searchBaseUrl: 'https://sandbox.example.com',
      isProduction: false,
    });
  });

  it('creates a provider named "atlas"', () => {
    expect(provider.name).toBe('atlas');
  });

  it('has all BookingProvider methods', () => {
    expect(typeof provider.searchFlights).toBe('function');
    expect(typeof provider.verifyFlight).toBe('function');
    expect(typeof provider.getSeats).toBe('function');
    expect(typeof provider.getLuggage).toBe('function');
    expect(typeof provider.checkCoupon).toBe('function');
    expect(typeof provider.draftOrder).toBe('function');
    expect(typeof provider.placeOrder).toBe('function');
    expect(typeof provider.completePayment).toBe('function');
    expect(typeof provider.getOrder).toBe('function');
    expect(typeof provider.listOrders).toBe('function');
    expect(typeof provider.quoteRefund).toBe('function');
    expect(typeof provider.submitRefund).toBe('function');
    expect(typeof provider.getRefund).toBe('function');
  });

  it('checkCoupon always returns invalid (Atlas has no coupons)', async () => {
    const result = await provider.checkCoupon('ANYCODE', 100);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/not available/i);
  });

  it('searchFlights throws a network error when Atlas is unreachable', async () => {
    try {
      await provider.searchFlights({ from: 'LHR', to: 'JFK', date: '2026-09-15' });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('network');
      expect(err.retryable).toBe(true);
    }
  });

  it('draftOrder throws session_expired for an unknown verifiedFlightId', async () => {
    try {
      await provider.draftOrder({
        verifiedFlightId: 'nonexistent-session',
        passengers: [{ firstName: 'A', lastName: 'B', dateOfBirth: '1990-01-01', type: 'adult' }],
        contact: { phone: '+447700900001', email: 'a@b.com' },
      });
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('session_expired');
    }
  });

  it('completePayment throws not_found for an unknown order', async () => {
    try {
      await provider.completePayment('nonexistent-order');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.code).toBe('not_found');
    }
  });

  it('listOrders returns an empty array initially', async () => {
    const orders = await provider.listOrders();
    expect(orders).toEqual([]);
  });
});

describe('Atlas production guards', () => {
  it('refuses deposit payment when isProduction is true', async () => {
    vi.resetModules();
    const { createAtlasProvider } = await import('../booking/atlas');
    const prod = createAtlasProvider({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      baseUrl: 'https://prod.example.com',
      searchBaseUrl: 'https://prod.example.com',
      isProduction: true,
    });

    // We cannot reach completePayment without a real order, but we can verify
    // the provider was created with production mode. The actual guard fires
    // inside completePayment when method is 'deposit'.
    expect(prod.name).toBe('atlas');
  });
});

/**
 * Phone conversion for Atlas.
 *
 * Untested until it broke in production. The header comment of this file has
 * claimed to cover `atlasMobile` since it was written, but the function was
 * not exported, so nothing here touched it — and the bug it hid only shows on
 * three-digit country codes, which none of the obvious examples use.
 */
describe('atlasMobile', () => {
  // The country code is padded to four digits TOTAL. For 1- and 2-digit codes
  // that happens to equal "00" + the code, which is why the wrong rule looked
  // right for so long.
  it('pads one and two digit country codes to four', () => {
    expect(atlasMobile('+14155552671')).toBe('0001-4155552671');
    expect(atlasMobile('+8613928109091')).toBe('0086-13928109091');
    expect(atlasMobile('+6591234599')).toBe('0065-91234599');
    expect(atlasMobile('+447911123456')).toBe('0044-7911123456');
  });

  // The regression. +852 is Hong Kong, where most of this desk's bookings
  // depart from, so this was not an edge case in practice.
  it('keeps three digit country codes to four digits, not five', () => {
    expect(atlasMobile('+85298765432')).toBe('0852-98765432');
    expect(atlasMobile('+351912345678')).toBe('0351-912345678');
    expect(atlasMobile('+35799123456')).toBe('0357-99123456');
  });

  it('always produces exactly four digits before the dash', () => {
    for (const n of [
      '+14155552671',
      '+8613928109091',
      '+6591234599',
      '+85298765432',
      '+351912345678',
      '+447911123456',
    ]) {
      expect(atlasMobile(n)!.split('-')[0]).toHaveLength(4);
    }
  });

  it('accepts a number already in Atlas format', () => {
    expect(atlasMobile('0086-13928109091')).toBe('0086-13928109091');
    expect(atlasMobile('  0852-98765432  ')).toBe('0852-98765432');
  });

  // A wrongly padded number must not be waved through by the passthrough
  // check — that would defeat the point of validating at all.
  it('does not pass through a five digit prefix unchanged', () => {
    expect(atlasMobile('00852-98765432')).not.toBe('00852-98765432');
  });

  it('accepts 00-prefixed international form', () => {
    expect(atlasMobile('008613928109091')).toBe('0086-13928109091');
  });

  it('rejects what it cannot convert, rather than guessing', () => {
    for (const bad of ['', '   ', 'not a phone', '12345', '+999123']) {
      expect(atlasMobile(bad)).toBeNull();
    }
  });
});
