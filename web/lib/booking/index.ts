import { createAtlasProviderFromEnv } from './atlas';
import { createFlight402Provider } from './flight402';
import { createMockProvider } from './mock';
import { sharedMap } from '../store';
import type { BookingProvider } from './provider';

// The provider itself must also be one instance per process, not per module
// copy, so its internal caches line up with the shared maps above.
const providerCache = sharedMap<BookingProvider>('booking.provider');
const CACHE_KEY = 'active';

/**
 * Resolve the booking backend from the environment.
 *
 * BOOKING_BACKEND=mock (the default) runs entirely offline against fixtures,
 * so the whole flow is demoable before a FluxA wallet is funded. Switching to
 * flight402 is one env var plus an Agent VC — no code changes.
 */
export function getBookingProvider(): BookingProvider {
  const existing = providerCache.get(CACHE_KEY);
  if (existing) return existing;

  const backend = (process.env.BOOKING_BACKEND ?? 'mock').toLowerCase();

  if (backend === 'flight402') {
    const baseUrl = process.env.FLIGHT402_BASE_URL;
    const agentVc = process.env.FLIGHT402_AGENT_VC;
    if (!baseUrl || !agentVc) {
      throw new Error(
        'BOOKING_BACKEND=flight402 requires FLIGHT402_BASE_URL and FLIGHT402_AGENT_VC. ' +
          'Mint a credential with: fluxa-wallet agent-vc --audience urn:flight402:api --challenge flight402',
      );
    }
    const provider402 = createFlight402Provider({
      baseUrl: baseUrl.replace(/\/$/, ''),
      agentVc,
    });
    providerCache.set(CACHE_KEY, provider402);
    return provider402;
  }

  if (backend === 'atlas') {
    const provider = createAtlasProviderFromEnv();
    if (!provider) {
      throw new Error(
        'BOOKING_BACKEND=atlas requires ATRIP_ACCESS_KEY and ATRIP_SECRET_KEY in .env.local',
      );
    }
    providerCache.set(CACHE_KEY, provider);
    return provider;
  }

  if (backend !== 'mock') {
    throw new Error(
      `Unknown BOOKING_BACKEND "${backend}" — expected "mock", "atlas" or "flight402"`,
    );
  }

  const mock = createMockProvider();
  providerCache.set(CACHE_KEY, mock);
  return mock;
}

export type { BookingProvider, DraftOrderInput } from './provider';
