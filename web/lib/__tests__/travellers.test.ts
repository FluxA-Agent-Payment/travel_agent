import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Redirect the travellers file to a temp directory before importing the module.
let tempDir: string;
let dataDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'travellers-test-'));
  dataDir = join(tempDir, '.data');
  mkdirSync(dataDir, { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tempDir, { recursive: true, force: true });
});

// Import after the cwd mock is set up — the FILE constant resolves at import time.
// However, FILE is a module-level const, so we need to dynamically import after mocking.
async function loadTravellers() {
  // Reset module cache so the FILE const picks up the new cwd.
  vi.resetModules();
  // Re-apply the cwd mock after resetModules clears it.
  vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  return await import('../travellers');
}

const alice = {
  firstName: 'Alice',
  lastName: 'Smith',
  dateOfBirth: '1990-05-15',
  type: 'adult' as const,
  gender: 'F' as const,
  nationality: 'GB',
  passportNumber: 'GB12345678',
  passportExpiry: '2030-05-15',
};

const aliceContact = { phone: '+447700900001', email: 'alice@example.com' };

const bob = {
  firstName: 'Bob',
  lastName: 'Jones',
  dateOfBirth: '1985-11-20',
  type: 'adult' as const,
  gender: 'M' as const,
  nationality: 'US',
  passportNumber: 'US98765432',
  passportExpiry: '2028-11-20',
};

const bobContact = { phone: '+12025551234', email: 'bob@example.com' };

describe('listTravellers', () => {
  it('returns an empty array when no travellers are saved', async () => {
    const { listTravellers } = await loadTravellers();
    expect(listTravellers()).toEqual([]);
  });

  it('returns summaries after travellers are saved', async () => {
    const { saveTraveller, listTravellers } = await loadTravellers();
    saveTraveller(alice, aliceContact);
    const list = listTravellers();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Alice Smith');
    expect(list[0].hasPassport).toBe(true);
    expect(list[0].email).toBe('alice@example.com');
  });

  it('never exposes passport numbers in summaries', async () => {
    const { saveTraveller, listTravellers } = await loadTravellers();
    saveTraveller(alice, aliceContact);
    const [summary] = listTravellers();
    const serialised = JSON.stringify(summary);
    expect(serialised).not.toContain('GB12345678');
    expect(serialised).not.toContain('passportNumber');
  });
});

describe('saveTraveller', () => {
  it('creates a new traveller and returns a summary', async () => {
    const { saveTraveller } = await loadTravellers();
    const result = saveTraveller(alice, aliceContact);
    expect(result.id).toMatch(/^tv_/);
    expect(result.name).toBe('Alice Smith');
    expect(result.type).toBe('adult');
    expect(result.hasPassport).toBe(true);
  });

  it('updates an existing traveller matched by name+DOB', async () => {
    const { saveTraveller, listTravellers } = await loadTravellers();
    const first = saveTraveller(alice, aliceContact);

    // Update with a new passport number.
    const updated = { ...alice, passportNumber: 'GB99999999' };
    const second = saveTraveller(updated, aliceContact);

    expect(second.id).toBe(first.id);
    expect(listTravellers()).toHaveLength(1);
  });

  it('adds a second traveller with a different name+DOB', async () => {
    const { saveTraveller, listTravellers } = await loadTravellers();
    saveTraveller(alice, aliceContact);
    saveTraveller(bob, bobContact);
    expect(listTravellers()).toHaveLength(2);
  });
});

describe('expandTravellers', () => {
  it('returns full records including passport numbers', async () => {
    const { saveTraveller, expandTravellers } = await loadTravellers();
    const saved = saveTraveller(alice, aliceContact);
    const expanded = expandTravellers([saved.id]);
    expect(expanded).toHaveLength(1);
    expect(expanded[0].passenger.passportNumber).toBe('GB12345678');
    expect(expanded[0].contact.email).toBe('alice@example.com');
  });

  it('throws for an unknown id', async () => {
    const { expandTravellers } = await loadTravellers();
    expect(() => expandTravellers(['tv_nonexistent'])).toThrow(/No saved traveller/);
  });

  it('returns records in the order of the requested ids', async () => {
    const { saveTraveller, expandTravellers } = await loadTravellers();
    const a = saveTraveller(alice, aliceContact);
    const b = saveTraveller(bob, bobContact);
    const expanded = expandTravellers([b.id, a.id]);
    expect(expanded[0].passenger.firstName).toBe('Bob');
    expect(expanded[1].passenger.firstName).toBe('Alice');
  });
});

describe('deleteTraveller', () => {
  it('removes a traveller by id', async () => {
    const { saveTraveller, deleteTraveller, listTravellers } = await loadTravellers();
    const saved = saveTraveller(alice, aliceContact);
    expect(deleteTraveller(saved.id)).toBe(true);
    expect(listTravellers()).toHaveLength(0);
  });

  it('returns false for a non-existent id', async () => {
    const { deleteTraveller } = await loadTravellers();
    expect(deleteTraveller('tv_nonexistent')).toBe(false);
  });
});

describe('summarise', () => {
  it('reports hasPassport=false when no passport is on file', async () => {
    const { saveTraveller, listTravellers } = await loadTravellers();
    const noPassport = { ...alice, passportNumber: undefined };
    saveTraveller(noPassport, aliceContact);
    const [summary] = listTravellers();
    expect(summary.hasPassport).toBe(false);
  });
});
