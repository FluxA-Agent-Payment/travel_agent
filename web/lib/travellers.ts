import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Contact, Passenger } from './types';

/**
 * Saved travellers, so a passport number is typed once rather than every trip.
 *
 * Two decisions worth stating, because this is the only PII the app keeps.
 *
 * It is written to disk rather than held in memory like everything else. A
 * profile that evaporates on restart would not save anyone a keystroke, which
 * is the entire point.
 *
 * And the agent never sees a passport number. It lists travellers by id and
 * name, and passes ids to prepare_order; the server expands them here, on the
 * way to the airline. That keeps document numbers out of the model's context
 * and out of the conversation transcript, while still letting the agent fill a
 * booking without asking again.
 */

export interface SavedTraveller {
  id: string;
  passenger: Passenger;
  contact: Contact;
  savedAt: string;
}

/** What the agent and the browser are allowed to see: no document numbers. */
export interface TravellerSummary {
  id: string;
  name: string;
  type: Passenger['type'];
  nationality?: string;
  /** Whether a passport is on file, without revealing it. */
  hasPassport: boolean;
  passportExpiry?: string;
  email: string;
}

const FILE = join(process.cwd(), '.data', 'travellers.json');

/**
 * Whether the saved-traveller book is usable at all.
 *
 * It is ONE list, shared by everybody who reaches this server. That is exactly
 * right for a desk one person runs on their laptop, and a passport leak the
 * moment more than one person can reach it: `listTravellers` would hand every
 * visitor everyone else's details, and an id is the only thing needed to book
 * on somebody's document.
 *
 * So it is closed whenever travellers are paying as themselves, which is the
 * same signal that says this deployment has more than one user. Scoping the
 * book per account is the real fix and needs an auth layer; until that exists,
 * off is the only honest setting.
 */
function sharedBookAllowed(): boolean {
  return process.env.NEXT_PUBLIC_FLUXA_BROWSER_WALLET !== 'true';
}

export class TravellerBookDisabled extends Error {
  readonly code = 'traveller_book_disabled';
  constructor() {
    super(
      'Saved travellers are disabled on this deployment — every visitor would share one address book. Enter passenger details for this booking instead.',
    );
    this.name = 'TravellerBookDisabled';
  }
}

function readAll(): SavedTraveller[] {
  try {
    const raw = readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Missing or unreadable file is an empty address book, not an error.
    return [];
  }
}

function writeAll(rows: SavedTraveller[]): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(rows, null, 2), 'utf8');
}

export function summarise(t: SavedTraveller): TravellerSummary {
  return {
    id: t.id,
    name: `${t.passenger.firstName} ${t.passenger.lastName}`,
    type: t.passenger.type,
    nationality: t.passenger.nationality,
    hasPassport: Boolean(t.passenger.passportNumber),
    passportExpiry: t.passenger.passportExpiry,
    email: t.contact.email,
  };
}

export function listTravellers(): TravellerSummary[] {
  // Empty rather than throwing: "nobody is saved" is a state the UI and the
  // agent already handle, and it degrades into simply asking for details.
  if (!sharedBookAllowed()) return [];
  return readAll().map(summarise);
}

/** Full records, including document numbers. Server-side callers only. */
export function expandTravellers(ids: string[]): SavedTraveller[] {
  // This one throws. It returns passport numbers, so a caller that reaches it
  // on a shared deployment must fail loudly rather than be handed anything.
  if (!sharedBookAllowed()) throw new TravellerBookDisabled();
  const byId = new Map(readAll().map((t) => [t.id, t]));
  return ids.map((id) => {
    const found = byId.get(id);
    if (!found) throw new Error(`No saved traveller with id "${id}"`);
    return found;
  });
}

/**
 * Save a traveller, replacing any existing record for the same person.
 *
 * Matched on name plus date of birth rather than on id, so re-booking the same
 * person with a renewed passport updates them instead of accumulating
 * near-duplicates that are impossible to tell apart in a list.
 */
export function saveTraveller(passenger: Passenger, contact: Contact): TravellerSummary {
  if (!sharedBookAllowed()) throw new TravellerBookDisabled();
  const rows = readAll();
  const key = (p: Passenger) =>
    `${p.firstName.trim().toLowerCase()}|${p.lastName.trim().toLowerCase()}|${p.dateOfBirth}`;

  const existing = rows.findIndex((t) => key(t.passenger) === key(passenger));
  const record: SavedTraveller = {
    id: existing >= 0 ? rows[existing].id : `tv_${randomUUID().slice(0, 8)}`,
    passenger,
    contact,
    savedAt: new Date().toISOString(),
  };

  if (existing >= 0) rows[existing] = record;
  else rows.push(record);

  writeAll(rows);
  return summarise(record);
}

export function deleteTraveller(id: string): boolean {
  if (!sharedBookAllowed()) throw new TravellerBookDisabled();
  const rows = readAll();
  const next = rows.filter((t) => t.id !== id);
  if (next.length === rows.length) return false;
  writeAll(next);
  return true;
}
