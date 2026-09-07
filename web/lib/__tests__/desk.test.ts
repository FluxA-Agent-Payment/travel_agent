import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `settlesRealMoney` decides whether every "no money moves" line in the UI and
 * the agent's prompt is true. Getting it wrong in the false direction tells a
 * traveller nothing was charged while charging them, so the env parsing behind
 * it is worth pinning down.
 */

const KEYS = [
  'FLUXA_DESK_AGENT_ID',
  'FLUXA_DESK_AGENT_TOKEN',
  'FLUXA_SETTLEMENT_ADDRESS',
  'NEXT_PUBLIC_FLUXA_BROWSER_WALLET',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  vi.resetModules();
});

async function loadDesk() {
  vi.resetModules();
  return await import('../payments/desk');
}

const ADDRESS = '0x1111111111111111111111111111111111111111';

describe('desk settlement configuration', () => {
  it('settles nothing when neither rail is configured', async () => {
    const { settlesRealMoney, deskIdentity } = await loadDesk();
    expect(deskIdentity()).toBeNull();
    expect(settlesRealMoney()).toBe(false);
  });

  it('is live once a payout address is set', async () => {
    process.env.FLUXA_SETTLEMENT_ADDRESS = ADDRESS;
    const { settlesRealMoney } = await loadDesk();
    expect(settlesRealMoney()).toBe(true);
  });

  it('is live once the desk has a merchant identity', async () => {
    process.env.FLUXA_DESK_AGENT_ID = 'agent-123';
    process.env.FLUXA_DESK_AGENT_TOKEN = 'tok-123';
    const { settlesRealMoney, deskIdentity } = await loadDesk();
    expect(deskIdentity()?.agentId).toBe('agent-123');
    expect(settlesRealMoney()).toBe(true);
  });

  // Half a merchant identity cannot raise an invoice, and must not be reported
  // as though it could.
  it('ignores a half-configured merchant identity', async () => {
    process.env.FLUXA_DESK_AGENT_ID = 'agent-123';
    const { settlesRealMoney, deskIdentity } = await loadDesk();
    expect(deskIdentity()).toBeNull();
    expect(settlesRealMoney()).toBe(false);
  });

  // Some loaders leave the quotes on. Failing the address check would take the
  // whole wallet down, so they are stripped rather than trusted.
  it('tolerates quoted env values', async () => {
    process.env.FLUXA_SETTLEMENT_ADDRESS = `"${ADDRESS}"`;
    process.env.FLUXA_DESK_AGENT_ID = "'agent-123'";
    process.env.FLUXA_DESK_AGENT_TOKEN = "'tok-123'";
    const { settlesRealMoney, deskIdentity } = await loadDesk();
    expect(deskIdentity()?.agentId).toBe('agent-123');
    expect(settlesRealMoney()).toBe(true);
  });

  it('refuses a malformed settlement address rather than ignoring it', async () => {
    process.env.FLUXA_SETTLEMENT_ADDRESS = '0xnot-an-address';
    const { settlesRealMoney } = await loadDesk();
    expect(() => settlesRealMoney()).toThrow(/not a valid Base address/);
  });
});

/**
 * The switch that decides whose wallet pays. It is read by both the browser
 * and the server from one variable precisely so the two cannot disagree — a
 * browser that thinks the visitor is paying while the server settles from its
 * own wallet is the failure this whole change exists to prevent.
 */
describe('requiresPayerIdentity', () => {
  it('is off by default, so the desk keeps paying from its own wallet', async () => {
    const { requiresPayerIdentity } = await loadDesk();
    expect(requiresPayerIdentity()).toBe(false);
  });

  it('is on when the browser wallet is enabled', async () => {
    process.env.NEXT_PUBLIC_FLUXA_BROWSER_WALLET = 'true';
    const { requiresPayerIdentity } = await loadDesk();
    expect(requiresPayerIdentity()).toBe(true);
  });

  // Anything other than an explicit "true" leaves the server paying, which is
  // the safe direction: a typo cannot silently switch a hosted deploy into
  // charging the operator, it can only fail to switch it out of that.
  it('treats any other value as off', async () => {
    for (const value of ['false', '1', 'yes', '']) {
      process.env.NEXT_PUBLIC_FLUXA_BROWSER_WALLET = value;
      const { requiresPayerIdentity } = await loadDesk();
      expect(requiresPayerIdentity()).toBe(false);
    }
  });
});
