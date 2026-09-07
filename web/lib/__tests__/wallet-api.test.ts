import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { signX402PaymentViaApi, getMandateViaApi, refreshAgentJwt } from '../payments/wallet-api';

/**
 * The HTTP payer path. What matters here is not that it can sign a payment —
 * that was proven against the live API — but the two properties that make it
 * safe to host: it never acts as anyone but the JWT holder, and it signs the
 * amounts the merchant asked for rather than ones we assembled.
 */

// A real 402 from FluxA, kept verbatim: the CAIP network form and the string
// amount are exactly the shapes that would be papered over by a hand-written
// fixture, and both are load-bearing below.
const CHALLENGE = {
  x402Version: 1,
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      maxAmountRequired: '100000',
      resource: '/paymentlink/pl_test',
      description: 'Flight booking WKGJDJ',
      payTo: '0x1111111111111111111111111111111111111111',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      maxTimeoutSeconds: 60,
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

function reply(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function lastBody() {
  return JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
}

describe('signX402PaymentViaApi', () => {
  it('signs as the JWT holder', async () => {
    fetchMock.mockReturnValue(reply({ xPaymentB64: 'blob' }));
    const blob = await signX402PaymentViaApi({
      jwt: 'visitor-jwt',
      mandateId: 'mand_1',
      challenge: CHALLENGE,
    });

    expect(blob).toBe('blob');
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toContain('/api/payment/x402V3Payment');
    expect(init.headers.Authorization).toBe('Bearer visitor-jwt');
  });

  // Every signed field comes off the challenge. Reconstructing them would mean
  // signing over numbers the merchant never asserted.
  it('signs the amount and payee the merchant asked for', async () => {
    fetchMock.mockReturnValue(reply({ xPaymentB64: 'blob' }));
    await signX402PaymentViaApi({ jwt: 'j', mandateId: 'mand_1', challenge: CHALLENGE });

    const sent = lastBody();
    expect(sent.amount).toBe('100000');
    expect(sent.payTo).toBe('0x1111111111111111111111111111111111111111');
    expect(sent.assetAddress).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(sent.mandateId).toBe('mand_1');
    expect(sent.resource).toBe('https://walletapi.fluxapay.xyz/paymentlink/pl_test');
  });

  // The 402 reports eip155:8453; this endpoint wants the plain name. Echoing
  // the challenge's own value back is the obvious mistake and would be rejected.
  it('sends the plain network name, not the CAIP form from the challenge', async () => {
    fetchMock.mockReturnValue(reply({ xPaymentB64: 'blob' }));
    await signX402PaymentViaApi({
      jwt: 'j',
      mandateId: 'mand_1',
      challenge: CHALLENGE,
      network: 'base',
    });

    expect(lastBody().network).toBe('base');
  });

  // Refusing rather than defaulting is the property that stops a hosted deploy
  // from quietly billing the operator for a visitor's booking.
  it('refuses to sign without a JWT instead of falling back', async () => {
    await expect(
      signX402PaymentViaApi({ jwt: '', mandateId: 'mand_1', challenge: CHALLENGE }),
    ).rejects.toThrow(/No FluxA identity/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a challenge with no payment options', async () => {
    await expect(
      signX402PaymentViaApi({ jwt: 'j', mandateId: 'm', challenge: { accepts: [] } }),
    ).rejects.toThrow(/no payment options/);
  });

  it('reports an expired session distinctly from a refused payment', async () => {
    fetchMock.mockReturnValue(reply({ error: 'jwt expired' }, 401));
    await expect(
      signX402PaymentViaApi({ jwt: 'stale', mandateId: 'm', challenge: CHALLENGE }),
    ).rejects.toThrow(/session has expired/);
  });

  it('fails when FluxA returns no payment blob', async () => {
    fetchMock.mockReturnValue(reply({ status: 'ok' }));
    await expect(
      signX402PaymentViaApi({ jwt: 'j', mandateId: 'm', challenge: CHALLENGE }),
    ).rejects.toThrow(/no X-Payment blob/);
  });
});

describe('getMandateViaApi', () => {
  it('reads the mandate belonging to the JWT holder', async () => {
    fetchMock.mockReturnValue(
      reply({ mandateId: 'mand_1', status: 'signed', signedAt: '2026-09-07T04:54:51Z' }),
    );
    const m = await getMandateViaApi({ jwt: 'visitor-jwt', mandateId: 'mand_1' });

    expect(m.id).toBe('mand_1');
    expect(m.signedAt).toBe('2026-09-07T04:54:51Z');
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toContain('/api/mandates/agent/mand_1');
    expect(init.headers.Authorization).toBe('Bearer visitor-jwt');
  });

  // The endpoint has been seen to answer bare, wrapped, and as a list.
  it('unwraps whichever envelope FluxA uses', async () => {
    fetchMock.mockReturnValue(reply({ mandate: { mandateId: 'mand_2', status: 'signed' } }));
    expect((await getMandateViaApi({ jwt: 'j', mandateId: 'mand_2' })).id).toBe('mand_2');

    fetchMock.mockReturnValue(reply({ mandates: [{ mandateId: 'mand_3', status: 'signed' }] }));
    expect((await getMandateViaApi({ jwt: 'j', mandateId: 'mand_3' })).id).toBe('mand_3');
  });
});

describe('refreshAgentJwt', () => {
  it('mints a JWT from agent credentials', async () => {
    fetchMock.mockReturnValue(reply({ jwt: 'fresh' }));
    expect(await refreshAgentJwt('agent-1', 'tok-1')).toBe('fresh');
    expect(lastBody()).toEqual({ agent_id: 'agent-1', token: 'tok-1' });
  });

  it('throws when the credentials are rejected', async () => {
    fetchMock.mockReturnValue(reply({ error: 'bad token' }, 401));
    await expect(refreshAgentJwt('agent-1', 'nope')).rejects.toThrow(/Could not refresh/);
  });
});
