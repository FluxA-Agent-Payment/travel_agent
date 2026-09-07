import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The settlement ledger is the only thing standing between a retried request
 * and a second irreversible charge, so what is tested here is mostly its
 * behaviour under failure: a missing file, a corrupt one, and a process that
 * restarted between the charge and the retry.
 */

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ledger-test-'));
  mkdirSync(join(tempDir, '.data'), { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

// FILE resolves at import time, so the module is loaded after the cwd mock.
async function loadLedger() {
  vi.resetModules();
  vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  return await import('../payments/ledger');
}

const entry = {
  orderId: 'ORD-1',
  amountUsd: 107.06,
  txHash: '0xabc',
  rail: 'payment-link' as const,
  mandateId: 'mand_1',
  settledAt: '2026-09-02T10:00:00.000Z',
};

describe('settlement ledger', () => {
  it('reports nothing settled when the file does not exist', async () => {
    const { findSettlement } = await loadLedger();
    expect(findSettlement('ORD-1')).toBeNull();
  });

  it('finds a settlement it recorded', async () => {
    const { findSettlement, recordSettlement } = await loadLedger();
    recordSettlement(entry);
    expect(findSettlement('ORD-1')).toEqual(entry);
  });

  it('keeps orders separate', async () => {
    const { findSettlement, recordSettlement } = await loadLedger();
    recordSettlement(entry);
    expect(findSettlement('ORD-2')).toBeNull();
  });

  // The case the ledger exists for: the server restarted between taking the
  // money and the retry arriving. An in-memory guard would have forgotten.
  it('survives a module reload', async () => {
    const first = await loadLedger();
    first.recordSettlement(entry);

    const second = await loadLedger();
    expect(second.findSettlement('ORD-1')?.txHash).toBe('0xabc');
  });

  // Fails towards charging rather than silently skipping a payment. A corrupt
  // ledger must not be read as "already paid" for every order in existence.
  it('treats a corrupt ledger as empty', async () => {
    writeFileSync(join(tempDir, '.data', 'settlements.json'), '{not json', 'utf8');
    const { findSettlement } = await loadLedger();
    expect(findSettlement('ORD-1')).toBeNull();
  });

  it('records both rails distinguishably', async () => {
    const { findSettlement, recordSettlement } = await loadLedger();
    recordSettlement(entry);
    recordSettlement({ ...entry, orderId: 'ORD-2', rail: 'payout', txHash: '0xdef' });

    expect(findSettlement('ORD-1')?.rail).toBe('payment-link');
    expect(findSettlement('ORD-2')?.rail).toBe('payout');
  });
});
