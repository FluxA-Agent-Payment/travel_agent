'use client';

import { useEffect, useState } from 'react';

import type { Contact, OrderDraft, Passenger } from '@/lib/types';

/**
 * Passenger details for a booking started from a flight card.
 *
 * The direct path to the same approval gate the agent's drafts reach: this
 * verifies the fare and prices the booking, and nothing more. It cannot place
 * an order — that is still a separate click on the draft it produces.
 *
 * Validation here is intentionally the same shape as the agent's, because the
 * failures it prevents are the expensive kind: a name that does not match the
 * travel document, or an implausible date of birth, produces a ticket the
 * passenger cannot board with and often cannot refund.
 */

interface Fields {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  gender: 'M' | 'F' | '';
  nationality: string;
  passportNumber: string;
  passportExpiry: string;
  email: string;
  phone: string;
}

const EMPTY: Fields = {
  firstName: '',
  lastName: '',
  dateOfBirth: '',
  gender: '',
  nationality: '',
  passportNumber: '',
  passportExpiry: '',
  email: '',
  phone: '',
};

function validate(f: Fields): string | null {
  if (!f.firstName.trim() || !f.lastName.trim()) {
    return 'Given names and surname are both required, exactly as printed on the travel document.';
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.dateOfBirth)) {
    return 'Date of birth must be a full date.';
  }
  const dob = new Date(f.dateOfBirth);
  const age = (Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000);
  if (Number.isNaN(age) || age < 0 || age > 120) {
    return `That date of birth gives an age of ${Math.floor(age)} — please check it.`;
  }
  if (!/^\S+@\S+\.\S+$/.test(f.email)) return 'A valid email address is required.';
  // E.164. The provider normalises this for the airline, but a local-format
  // number fails deep inside Atlas with an opaque message, so catch it here.
  if (!/^\+[1-9]\d{6,14}$/.test(f.phone.replace(/[\s-]/g, ''))) {
    return 'Phone must be international format with a country code, e.g. +6591234599.';
  }
  if (f.passportExpiry && f.passportExpiry < new Date().toISOString().slice(0, 10)) {
    return 'That passport expiry is in the past.';
  }
  return null;
}

export function BookingForm({
  flightId,
  onDrafted,
  onCancel,
}: {
  flightId: string;
  onDrafted: (draft: OrderDraft, priceChanged: boolean) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<Fields>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ id: string; name: string }[]>([]);
  // Typing a passport number twice is the worst part of booking, so saving is
  // the default once someone has bothered to enter one.
  const [remember, setRemember] = useState(true);

  useEffect(() => {
    fetch('/api/travellers')
      .then((r) => r.json())
      .then((b) => setSaved(b.travellers ?? []))
      .catch(() => {
        /* an empty address book is not an error worth showing */
      });
  }, []);

  /** Fill the form from a saved traveller, for editing before booking. */
  async function useSaved(id: string) {
    setError(null);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'draft', flightId, travellerIds: [id] }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not price this booking');
      onDrafted(body.draft, Boolean(body.priceChanged));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function set<K extends keyof Fields>(key: K, value: Fields[K]) {
    setF((prev) => ({ ...prev, [key]: value }));
  }

  async function submit() {
    const problem = validate(f);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);

    const passenger: Passenger = {
      firstName: f.firstName.trim(),
      lastName: f.lastName.trim(),
      dateOfBirth: f.dateOfBirth,
      type: 'adult',
      ...(f.gender ? { gender: f.gender } : {}),
      ...(f.nationality ? { nationality: f.nationality.trim().toUpperCase() } : {}),
      ...(f.passportNumber ? { passportNumber: f.passportNumber.trim() } : {}),
      ...(f.passportExpiry ? { passportExpiry: f.passportExpiry } : {}),
    };
    const contact: Contact = {
      email: f.email.trim(),
      phone: f.phone.replace(/[\s-]/g, ''),
    };

    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'draft',
          flightId,
          passengers: [passenger],
          contact,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not price this booking');

      // Save after the details have been accepted, never before — there is no
      // point keeping a passport number the airline just rejected.
      if (remember) {
        await fetch('/api/travellers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passenger, contact }),
        }).catch(() => {
          /* the booking matters more than the address book */
        });
      }

      onDrafted(body.draft, Boolean(body.priceChanged));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bookform">
      {/* Anyone already on file books in one click — the whole point of
          keeping them. The form below stays available for someone new. */}
      {saved.length ? (
        <div className="savedlist">
          <span className="issue-label">Book someone already saved</span>
          {saved.map((t) => (
            <button key={t.id} className="savedrow" onClick={() => void useSaved(t.id)}>
              <span>{t.name}</span>
              <span className="savedrow-go">use →</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="bookform-grid">
        <label>
          <span>Given names</span>
          <input
            value={f.firstName}
            onChange={(e) => set('firstName', e.target.value)}
            autoComplete="given-name"
          />
        </label>
        <label>
          <span>Surname</span>
          <input
            value={f.lastName}
            onChange={(e) => set('lastName', e.target.value)}
            autoComplete="family-name"
          />
        </label>
        <label>
          <span>Date of birth</span>
          <input
            type="date"
            value={f.dateOfBirth}
            onChange={(e) => set('dateOfBirth', e.target.value)}
          />
        </label>
        <label>
          <span>Gender</span>
          <select
            value={f.gender}
            onChange={(e) => set('gender', e.target.value as Fields['gender'])}
          >
            <option value="">—</option>
            <option value="F">Female</option>
            <option value="M">Male</option>
          </select>
        </label>
        <label>
          <span>Nationality</span>
          <input
            value={f.nationality}
            placeholder="SG"
            maxLength={2}
            onChange={(e) => set('nationality', e.target.value)}
          />
        </label>
        <label>
          <span>Passport number</span>
          <input
            value={f.passportNumber}
            onChange={(e) => set('passportNumber', e.target.value)}
          />
        </label>
        <label>
          <span>Passport expiry</span>
          <input
            type="date"
            value={f.passportExpiry}
            onChange={(e) => set('passportExpiry', e.target.value)}
          />
        </label>
        <label>
          <span>Email</span>
          <input
            type="email"
            value={f.email}
            onChange={(e) => set('email', e.target.value)}
            autoComplete="email"
          />
        </label>
        <label className="wide">
          <span>Phone (with country code)</span>
          <input
            value={f.phone}
            placeholder="+6591234599"
            onChange={(e) => set('phone', e.target.value)}
            autoComplete="tel"
          />
        </label>
      </div>

      <p className="note">
        Names must match the travel document exactly. A mismatch can mean being
        denied boarding, usually with no refund.
      </p>

      <label className="remember">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
        />
        <span>
          Remember this traveller for next time. Stored on this server only; the
          agent can use it to fill a booking but never sees the passport number.
        </span>
      </label>

      <div className="actions">
        <button className="primary" onClick={submit} disabled={busy}>
          {busy ? 'Checking the live fare…' : 'Continue'}
        </button>
        <button onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>

      {error ? <p className="note bad">{error}</p> : null}
    </div>
  );
}
