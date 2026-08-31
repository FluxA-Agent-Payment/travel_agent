import { describe, expect, it } from 'vitest';

import { BookingError, isBookingError } from '../types';

describe('BookingError', () => {
  it('carries message, code, and default retryable=false', () => {
    const err = new BookingError('offer expired', 'offer_expired');
    expect(err.message).toBe('offer expired');
    expect(err.code).toBe('offer_expired');
    expect(err.retryable).toBe(false);
    expect(err.name).toBe('BookingError');
  });

  it('accepts an explicit retryable flag', () => {
    const err = new BookingError('transient', 'network', true);
    expect(err.retryable).toBe(true);
  });

  it('is an instance of Error', () => {
    const err = new BookingError('msg', 'code');
    expect(err).toBeInstanceOf(Error);
  });

  it('exposes the isBookingError brand', () => {
    const err = new BookingError('msg', 'code');
    expect(err.isBookingError).toBe(true);
  });
});

describe('isBookingError', () => {
  it('recognises a BookingError by brand', () => {
    const err = new BookingError('msg', 'code');
    expect(isBookingError(err)).toBe(true);
  });

  it('recognises a BookingError from a duplicated module graph', () => {
    // Simulate the cross-module scenario: an object with the brand flag but
    // not an instance of the local BookingError class.
    const impostor = Object.assign(new Error('msg'), {
      isBookingError: true as const,
      code: 'offer_expired',
    });
    expect(isBookingError(impostor)).toBe(true);
  });

  it('rejects a plain Error', () => {
    expect(isBookingError(new Error('nope'))).toBe(false);
  });

  it('rejects null and undefined', () => {
    expect(isBookingError(null)).toBe(false);
    expect(isBookingError(undefined)).toBe(false);
  });

  it('rejects non-object values', () => {
    expect(isBookingError('string error')).toBe(false);
    expect(isBookingError(42)).toBe(false);
  });
});
