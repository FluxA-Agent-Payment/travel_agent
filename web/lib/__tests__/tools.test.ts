import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { UiEvent, Emit } from '../agent/tools';

// ── guard() ────────────────────────────────────────────────────────
// guard() is not exported, so we test it through buildTools.dispatch().
// But we can test the redact function by importing the module and exercising
// the tool surface, since redact runs on every prepare_order result.

describe('tool dispatch', () => {
  it('returns an error string for unknown tools', async () => {
    // We need to set up a booking provider for buildTools to work.
    vi.spyOn(process, 'env', 'get').mockReturnValue({ ...process.env, BOOKING_BACKEND: 'mock' } as any);
    vi.resetModules();
    const { buildTools } = await import('../agent/tools');

    const events: UiEvent[] = [];
    const emit: Emit = (e) => events.push(e);
    const tools = buildTools(emit);

    const result = await tools.dispatch('nonexistent_tool', {});
    expect(result).toMatch(/ERROR.*unknown tool/);
  });

  it('provides all 11 tool definitions', async () => {
    vi.resetModules();
    const { buildTools } = await import('../agent/tools');

    const events: UiEvent[] = [];
    const emit: Emit = (e) => events.push(e);
    const tools = buildTools(emit);

    expect(tools.definitions).toHaveLength(11);
    const names = tools.definitions.map((d) => d.name);
    expect(names).toContain('search_flights');
    expect(names).toContain('verify_flight');
    expect(names).toContain('get_seats');
    expect(names).toContain('get_luggage');
    expect(names).toContain('check_coupon');
    expect(names).toContain('prepare_order');
    expect(names).toContain('check_order');
    expect(names).toContain('list_orders');
    expect(names).toContain('quote_refund');
    expect(names).toContain('check_wallet');
    expect(names).toContain('list_travellers');
  });

  it('does NOT expose irreversible tools (place, pay, refund)', async () => {
    vi.resetModules();
    const { buildTools } = await import('../agent/tools');

    const events: UiEvent[] = [];
    const emit: Emit = (e) => events.push(e);
    const tools = buildTools(emit);

    const names = tools.definitions.map((d) => d.name);
    expect(names).not.toContain('place_order');
    expect(names).not.toContain('complete_payment');
    expect(names).not.toContain('submit_refund');
    expect(names).not.toContain('pay');
    expect(names).not.toContain('place');
  });

  it('emits tool_start and tool_result on a successful call', async () => {
    vi.resetModules();
    const { buildTools } = await import('../agent/tools');

    const events: UiEvent[] = [];
    const emit: Emit = (e) => events.push(e);
    const tools = buildTools(emit);

    await tools.dispatch('list_orders', {});

    const starts = events.filter((e) => e.type === 'tool_start');
    const results = events.filter((e) => e.type === 'tool_result');
    expect(starts.length).toBeGreaterThanOrEqual(1);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(starts[0].tool).toBe('list_orders');
  });

  it('emits tool_error and returns ERROR: prefix on failure', async () => {
    vi.resetModules();
    const { buildTools } = await import('../agent/tools');

    const events: UiEvent[] = [];
    const emit: Emit = (e) => events.push(e);
    const tools = buildTools(emit);

    // search_flights with empty from should trigger a BookingError.
    const result = await tools.dispatch('search_flights', { from: '', to: 'JFK', date: '2026-09-15' });
    expect(result).toMatch(/^ERROR:/);
    const errors = events.filter((e) => e.type === 'tool_error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});

// ── redact() ───────────────────────────────────────────────────────
// redact is called on prepare_order results. We test it indirectly through
// the tool, or we can replicate the logic and test the shape.

describe('redact behaviour via prepare_order', () => {
  it('strips passport numbers from the draft returned to the model', async () => {
    vi.resetModules();
    const { buildTools } = await import('../agent/tools');

    const events: UiEvent[] = [];
    const emit: Emit = (e) => events.push(e);
    const tools = buildTools(emit);

    // Search, verify, then draft with a passenger carrying a passport.
    const searchResult = JSON.parse(
      await tools.dispatch('search_flights', { from: 'LHR', to: 'JFK', date: '2026-09-15' }),
    );
    const flightId = searchResult.flights[0].flightId;

    const verifyResult = JSON.parse(
      await tools.dispatch('verify_flight', { flightId }),
    );

    const draftResult = await tools.dispatch('prepare_order', {
      verifiedFlightId: verifyResult.verifiedFlightId,
      passengers: [
        {
          firstName: 'Alice',
          lastName: 'Smith',
          dateOfBirth: '1990-05-15',
          type: 'adult',
          passportNumber: 'GB12345678',
        },
      ],
      contact: { phone: '+447700900001', email: 'alice@example.com' },
    });

    // The passport must not appear in the result.
    expect(draftResult).not.toContain('GB12345678');
    // The redacted placeholder should be present instead.
    expect(draftResult).toContain('••••••');
  });
});

// ── search_flights tool ────────────────────────────────────────────

describe('search_flights tool', () => {
  it('returns JSON with a flights array', async () => {
    vi.resetModules();
    const { buildTools } = await import('../agent/tools');

    const events: UiEvent[] = [];
    const emit: Emit = (e) => events.push(e);
    const tools = buildTools(emit);

    const result = JSON.parse(
      await tools.dispatch('search_flights', { from: 'LHR', to: 'JFK', date: '2026-09-15' }),
    );
    expect(result.flights).toBeInstanceOf(Array);
    expect(result.flights.length).toBeGreaterThan(0);
  });
});

// ── list_travellers tool ───────────────────────────────────────────

describe('list_travellers tool', () => {
  it('returns a travellers array', async () => {
    vi.resetModules();
    const { buildTools } = await import('../agent/tools');

    const events: UiEvent[] = [];
    const emit: Emit = (e) => events.push(e);
    const tools = buildTools(emit);

    const result = JSON.parse(await tools.dispatch('list_travellers', {}));
    expect(result).toHaveProperty('travellers');
    expect(result.travellers).toBeInstanceOf(Array);
  });
});

// ── tool definition schemas ────────────────────────────────────────

describe('tool schemas', () => {
  it('every tool has a name, description, and input_schema', async () => {
    vi.resetModules();
    const { buildTools } = await import('../agent/tools');

    const events: UiEvent[] = [];
    const emit: Emit = (e) => events.push(e);
    const tools = buildTools(emit);

    for (const def of tools.definitions) {
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.description.length).toBeGreaterThan(10);
      expect(def.input_schema).toBeDefined();
      expect(def.input_schema.type).toBe('object');
    }
  });

  it('search_flights requires from, to, and date', async () => {
    vi.resetModules();
    const { buildTools } = await import('../agent/tools');

    const events: UiEvent[] = [];
    const emit: Emit = (e) => events.push(e);
    const tools = buildTools(emit);

    const search = tools.definitions.find((d) => d.name === 'search_flights')!;
    expect(search.input_schema.required).toContain('from');
    expect(search.input_schema.required).toContain('to');
    expect(search.input_schema.required).toContain('date');
  });

  it('prepare_order requires verifiedFlightId', async () => {
    vi.resetModules();
    const { buildTools } = await import('../agent/tools');

    const events: UiEvent[] = [];
    const emit: Emit = (e) => events.push(e);
    const tools = buildTools(emit);

    const draft = tools.definitions.find((d) => d.name === 'prepare_order')!;
    expect(draft.input_schema.required).toContain('verifiedFlightId');
  });
});
