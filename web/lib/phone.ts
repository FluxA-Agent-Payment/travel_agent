import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Phone numbers, in one place.
 *
 * The app speaks E.164 (`+85298765432`) everywhere — in the form, in the
 * agent's prompt, in what gets stored. The airline's own peculiar format is a
 * translation done at that boundary and nowhere else, so nothing upstream has
 * to know about it.
 *
 * This exists because there used to be two checks that disagreed. The form
 * tested the SHAPE of a number — a plus, then digits — while the server tested
 * whether it was a real number. `+447700900123` passes the first and fails the
 * second, so the form accepted it and the booking died later with a message
 * from the airline. One function now answers for both.
 *
 * It is also deliberately forgiving about what it accepts. People write their
 * own number the way they say it — with spaces, brackets, a leading 00 — and
 * rejecting that is a self-inflicted wound when the library can simply read
 * it. What it will NOT do is guess a missing country code: a bare local number
 * is genuinely ambiguous, and quietly assuming a country would put a stranger's
 * number on a booking.
 */

/** Canonical E.164, or null when it is not a real, complete number. */
export function toE164(input: unknown): string | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  // Tidy the punctuation people type, and treat the international 00 prefix
  // as the + it stands for.
  const cleaned = raw.replace(/[\s().\-–—]/g, '');
  const candidate = cleaned.startsWith('+')
    ? cleaned
    : cleaned.startsWith('00')
      ? `+${cleaned.slice(2)}`
      : cleaned;

  const parsed = parsePhoneNumberFromString(candidate);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

/**
 * Why a number was refused, in words worth showing someone.
 *
 * Distinguishes "you left off the country code" from "that is not a working
 * number", because the fix is different and "invalid phone" tells nobody which
 * mistake they made.
 */
export function phoneProblem(input: unknown): string | null {
  const raw = String(input ?? '').trim();
  if (!raw) return 'A contact phone number is required.';
  if (toE164(raw)) return null;

  const cleaned = raw.replace(/[\s().\-–—]/g, '');
  if (!cleaned.startsWith('+') && !cleaned.startsWith('00')) {
    return 'Include the country code, starting with + — for example +85298765432 for Hong Kong.';
  }
  // Reserved-for-fiction ranges land here, and the generic message would send
  // someone hunting for a typo in a number they copied correctly.
  return `“${raw}” is not a working number. Check the digits — ranges reserved for fiction (UK 07700 900xxx, US 555) are not accepted.`;
}
