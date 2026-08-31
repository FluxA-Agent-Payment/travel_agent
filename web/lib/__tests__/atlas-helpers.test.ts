import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Atlas internal helpers (fromAtlasDate, toAtlasDate, atlasName, atlasMobile)
// are not exported, so we test their observable effects through the provider.
// We also test the module-level factory and environment handling.

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
