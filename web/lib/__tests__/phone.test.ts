import { describe, expect, it } from 'vitest';

import { phoneProblem, toE164 } from '../phone';

/**
 * One check, shared by the form and the server. There used to be two that
 * disagreed — the form tested the shape of a number, the server tested whether
 * it was real — so a booking could pass the field and fail on submission.
 */

describe('toE164', () => {
  it('accepts numbers written the way people say them', () => {
    for (const written of [
      '+852 9876 5432',
      '+852-9876-5432',
      '+852 (9876) 5432',
      '+85298765432',
      ' +852 9876 5432 ',
    ]) {
      expect(toE164(written)).toBe('+85298765432');
    }
  });

  // 00 is the international prefix in most of the world and is exactly what a
  // plus stands for. Refusing it fails people for being correct.
  it('treats a leading 00 as a plus', () => {
    expect(toE164('008613928109091')).toBe('+8613928109091');
    expect(toE164('0044 7911 123456')).toBe('+447911123456');
  });

  it('rejects numbers with no country code rather than guessing one', () => {
    // Assuming a country here would put a stranger's number on a booking.
    expect(toE164('98765432')).toBeNull();
    expect(toE164('020 7183 8750')).toBeNull();
  });

  // Reserved-for-fiction ranges. Our own prompt used to offer +447700900123 as
  // the example to copy, which the validator then refused.
  it('rejects ranges reserved for fiction', () => {
    expect(toE164('+447700900123')).toBeNull();
    expect(toE164('+13115552368')).toBeNull();
  });

  it('rejects what is not a number at all', () => {
    for (const bad of ['', '   ', 'call me', '+', '+0', null, undefined, 12345]) {
      expect(toE164(bad as any)).toBeNull();
    }
  });

  it('is idempotent, so normalising twice changes nothing', () => {
    const once = toE164('+852 9876 5432')!;
    expect(toE164(once)).toBe(once);
  });
});

describe('phoneProblem', () => {
  it('says nothing when the number is fine', () => {
    expect(phoneProblem('+85298765432')).toBeNull();
    expect(phoneProblem('0044 7911 123456')).toBeNull();
  });

  // The two failures need different fixes, so they need different messages.
  it('distinguishes a missing country code from a bad number', () => {
    expect(phoneProblem('98765432')).toMatch(/country code/i);
    expect(phoneProblem('+447700900123')).toMatch(/not a working number/i);
  });

  it('asks for a number when there is none', () => {
    expect(phoneProblem('')).toMatch(/required/i);
  });

  // The form and the server must never disagree about one number, which is the
  // entire reason this module exists.
  it('agrees with toE164 on every case', () => {
    for (const n of [
      '+85298765432',
      '+852 9876 5432',
      '008613928109091',
      '98765432',
      '+447700900123',
      '',
      'nonsense',
    ]) {
      expect(phoneProblem(n) === null).toBe(toE164(n) !== null);
    }
  });
});
