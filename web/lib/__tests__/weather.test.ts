import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import type { Weather } from '../weather';

// The weather module uses module-level cache, so we reset it per test.
let getWeather: typeof import('../weather').getWeather;

beforeEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();
  const mod = await import('../weather');
  getWeather = mod.getWeather;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(responses: Array<{ ok: boolean; data: any }>) {
  let callIndex = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const resp = responses[callIndex++] ?? responses[responses.length - 1];
      return {
        ok: resp.ok,
        json: async () => resp.data,
      };
    }),
  );
}

describe('getWeather', () => {
  it('returns null for an unknown airport code', async () => {
    const result = await getWeather('ZZZZ', '2026-09-15');
    expect(result).toBeNull();
  });

  it('returns null for a malformed date', async () => {
    const result = await getWeather('LHR', 'not-a-date');
    expect(result).toBeNull();
  });

  it('returns null for an empty airport code', async () => {
    const result = await getWeather('', '2026-09-15');
    expect(result).toBeNull();
  });

  it('returns a forecast for dates within 16 days', async () => {
    mockFetch([
      {
        ok: true,
        data: {
          daily: {
            weather_code: [0],
            temperature_2m_max: [25.4],
            temperature_2m_min: [14.2],
          },
        },
      },
    ]);

    // Use a date that is within the next few days.
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const dateStr = tomorrow.toISOString().slice(0, 10);

    const result = await getWeather('LHR', dateStr);
    expect(result).not.toBeNull();
    expect(result!.airport).toBe('LHR');
    expect(result!.city).toBe('London');
    expect(result!.kind).toBe('clear');
    expect(result!.tempMaxC).toBe(25);
    expect(result!.tempMinC).toBe(14);
    expect(result!.basis).toBe('forecast');
  });

  it('returns a typical-climate result for dates far in the future', async () => {
    // Three responses for the three historical years.
    mockFetch([
      {
        ok: true,
        data: {
          daily: {
            weather_code: [2],
            temperature_2m_max: [22],
            temperature_2m_min: [12],
          },
        },
      },
      {
        ok: true,
        data: {
          daily: {
            weather_code: [3],
            temperature_2m_max: [24],
            temperature_2m_min: [14],
          },
        },
      },
      {
        ok: true,
        data: {
          daily: {
            weather_code: [2],
            temperature_2m_max: [20],
            temperature_2m_min: [10],
          },
        },
      },
    ]);

    // Use a date far in the future (next year).
    const nextYear = new Date().getUTCFullYear() + 1;
    const result = await getWeather('JFK', `${nextYear}-06-15`);
    expect(result).not.toBeNull();
    expect(result!.airport).toBe('JFK');
    expect(result!.city).toBe('New York');
    expect(result!.basis).toBe('typical');
    // Modal weather code: two "2" (cloudy) vs one "3" (cloudy) → cloudy.
    expect(result!.kind).toBe('cloudy');
    expect(result!.tempMaxC).toBe(22);
    expect(result!.tempMinC).toBe(12);
  });

  it('returns null when the API call fails gracefully', async () => {
    mockFetch([{ ok: false, data: null }]);

    const today = new Date();
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const dateStr = tomorrow.toISOString().slice(0, 10);

    const result = await getWeather('LHR', dateStr);
    expect(result).toBeNull();
  });

  it('returns null when fetch throws (network error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network unreachable');
      }),
    );

    const today = new Date();
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const dateStr = tomorrow.toISOString().slice(0, 10);

    const result = await getWeather('LHR', dateStr);
    expect(result).toBeNull();
  });

  it('caches results for the same airport+date pair', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        daily: {
          weather_code: [1],
          temperature_2m_max: [20],
          temperature_2m_min: [10],
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const today = new Date();
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const dateStr = tomorrow.toISOString().slice(0, 10);

    const first = await getWeather('SIN', dateStr);
    const second = await getWeather('SIN', dateStr);
    expect(first).toEqual(second);
    // Should only fetch once due to cache.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies weather codes correctly', async () => {
    const codes = [
      { code: 0, kind: 'clear' },
      { code: 1, kind: 'clear' },
      { code: 2, kind: 'cloudy' },
      { code: 3, kind: 'cloudy' },
      { code: 45, kind: 'fog' },
      { code: 48, kind: 'fog' },
      { code: 51, kind: 'rain' },
      { code: 63, kind: 'rain' },
      { code: 71, kind: 'snow' },
      { code: 77, kind: 'snow' },
      { code: 80, kind: 'rain' },
      { code: 85, kind: 'snow' },
      { code: 95, kind: 'storm' },
      { code: 99, kind: 'storm' },
    ];

    for (const { code, kind } of codes) {
      vi.resetModules();
      const mod = await import('../weather');

      mockFetch([
        {
          ok: true,
          data: {
            daily: {
              weather_code: [code],
              temperature_2m_max: [20],
              temperature_2m_min: [10],
            },
          },
        },
      ]);

      const today = new Date();
      const tomorrow = new Date(today.getTime() + 86_400_000);
      const dateStr = tomorrow.toISOString().slice(0, 10);

      const result = await mod.getWeather('LHR', dateStr);
      expect(result?.kind, `code ${code} should classify as ${kind}`).toBe(kind);
    }
  });
});
