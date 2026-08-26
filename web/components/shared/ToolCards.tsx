'use client';

import { useState } from 'react';

import { useWallet } from '@/components/providers/WalletProvider';
import { BookingForm } from './BookingForm';
import { FlightCard } from './FlightCard';
import { DepositPayFlow } from './DepositPayFlow';
import { PayControl } from './PayControl';

import type {
  FlightOffer,
  LuggageOption,
  Order,
  OrderDraft,
  RefundQuote,
  Segment,
  SeatMapSegment,
  VerifyResult,
} from '@/lib/types';

const TOOL_LABELS: Record<string, string> = {
  search_flights: 'Searching flights',
  verify_flight: 'Verifying fare',
  get_seats: 'Loading seat map',
  get_luggage: 'Loading baggage options',
  check_coupon: 'Checking coupon',
  check_wallet: 'Checking wallet',
  prepare_order: 'Pricing booking',
  check_order: 'Checking order',
  list_orders: 'Loading bookings',
  quote_refund: 'Quoting refund',
};

export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool.replace(/_/g, ' ');
}

/**
 * Flight times are local to the airport, and Atlas returns them as naive
 * wall-clock values. Rendering them in the viewer's timezone silently shifts
 * every departure — a booking screen read in New York would show a Hong Kong
 * departure half a day out. Pinning UTC keeps the number exactly as the
 * airline states it, and matches FlightCard, which already does this.
 */
function time(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

function day(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function duration(mins?: number): string {
  if (!mins) return '';
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

function usdc(n: number): string {
  return `${n.toFixed(2)} USDC`;
}

/**
 * One directional leg, laid out as a route line.
 *
 * Follows the pattern shared by Kiwi, Expedia and Navan: the two times are the
 * headline, airport codes sit quietly beneath them, and the connector carries
 * duration and stop count. It reads left-to-right the way the journey does,
 * which is why every flight-search product converges on it.
 */
function Leg({ segments, label }: { segments: Segment[]; label?: string }) {
  if (!segments?.length) return null;
  const first = segments[0];
  const last = segments[segments.length - 1];
  const stops = segments.reduce((n, s) => n + (s.stops ?? 0), segments.length - 1);
  const totalMinutes = segments.reduce((n, s) => n + (s.durationMinutes ?? 0), 0);
  const arrivesLater =
    new Date(last.arrival.time).getUTCDate() !==
    new Date(first.departure.time).getUTCDate();

  return (
    <div className="route">
      {label ? <div className="route-label">{label}</div> : null}
      <div className="route-line">
        <div className="endpoint">
          <div className="time">{time(first.departure.time)}</div>
          <div className="code">{first.departure.airport}</div>
        </div>

        <div className="connector">
          <div className="connector-meta">{duration(totalMinutes)}</div>
          <div className="connector-rule">
            <span className="node" />
            {stops > 0 ? <span className="stop-node" /> : null}
            <span className="node" />
          </div>
          <div className="connector-meta">
            {stops === 0 ? 'nonstop' : `${stops} stop${stops > 1 ? 's' : ''}`}
          </div>
        </div>

        <div className="endpoint end">
          <div className="time">
            {time(last.arrival.time)}
            {arrivesLater ? <sup>+1</sup> : null}
          </div>
          <div className="code">{last.arrival.airport}</div>
        </div>
      </div>
      <div className="route-meta">
        {day(first.departure.time)} · {first.carrier} {first.flightNumber}
      </div>
    </div>
  );
}

/* ---------- search_flights ---------- */

function legMinutes(segments: Segment[]): number {
  return segments.reduce((n, s) => n + (s.durationMinutes ?? 0), 0);
}

/** The handoff sentence a "Book this" click drops into the conversation. */
function bookingRequest(f: FlightOffer): string {
  const first = f.outbound[0];
  const last = f.outbound[f.outbound.length - 1];
  return (
    `I picked the ${first.carrier} ${first.flightNumber} at ${f.price.adult.toFixed(2)}, ` +
    `${first.departure.airport} ${time(first.departure.time)} → ${last.arrival.airport} ` +
    `on ${day(first.departure.time)}. Verify that fare and prepare the order — ` +
    `ask me for whatever passenger details you still need.`
  );
}

export function FlightResults({
  data,
  onEvent,
  verifications,
}: {
  data: { flights: FlightOffer[] };
  onEvent: (message: string) => void;
  /** flightId → live-fare check, folded into the matching card. */
  verifications?: Map<string, VerifyResult>;
}) {
  // Which card has its passenger form open, and the draft it produced. Both
  // live here rather than in FlightCard so that choosing a flight collapses
  // the list — once a booking is being priced, the other options are noise.
  const [formFor, setFormFor] = useState<string | null>(null);
  const [draft, setDraft] = useState<OrderDraft | null>(null);
  const [priceChanged, setPriceChanged] = useState(false);

  const flights = data?.flights ?? [];

  if (draft) {
    return (
      <>
        {priceChanged ? (
          <p className="note warn">
            The live fare differed from the search price — the total below is
            the one the airline will hold you to.
          </p>
        ) : null}
        <DraftCard data={draft} onPlaced={onEvent} />
      </>
    );
  }

  if (!flights.length) {
    return (
      <div className="card">
        <div className="card-body">
          <p className="note">No flights found for that route and date.</p>
        </div>
      </div>
    );
  }

  // Badge the two options most people actually pick between, the way every
  // flight-search product does. Computed here rather than trusted from the
  // model, so the labels can never contradict the prices on screen.
  const cheapestId = flights.reduce((best, f) =>
    f.price.adult < best.price.adult ? f : best,
  ).flightId;
  const fastestId = flights.reduce((best, f) =>
    legMinutes(f.outbound) < legMinutes(best.outbound) ? f : best,
  ).flightId;

  const first = flights[0].outbound[0];
  const last = flights[0].outbound[flights[0].outbound.length - 1];

  return (
    <>
      <div className="pane-head">
        <span>{flights.length} options</span>
        <span>
          {first.departure.airport} → {last.arrival.airport}
        </span>
      </div>
      <div className="flight-grid">
        {flights.map((f) => (
          <div className="flight-cell" key={f.flightId}>
            <FlightCard
              offer={f}
              badge={
                f.flightId === cheapestId
                  ? 'cheapest'
                  : f.flightId === fastestId
                    ? 'fastest'
                    : undefined
              }
              onBook={(offer) => onEvent(bookingRequest(offer))}
              onFillIn={(offer) => setFormFor(offer.flightId)}
              verification={verifications?.get(f.flightId)}
            />
            {/* The return leg is the same offer rendered again — it must not
                carry its own booking controls, or one trip looks like two. */}
            {f.inbound?.length ? (
              <FlightCard
                offer={{ ...f, outbound: f.inbound, inbound: undefined }}
                priceLabel="return leg"
              />
            ) : null}
            {formFor === f.flightId ? (
              <BookingForm
                flightId={f.flightId}
                onCancel={() => setFormFor(null)}
                onDrafted={(d, changed) => {
                  setFormFor(null);
                  setPriceChanged(changed);
                  setDraft(d);
                  // Tell the agent. Without this it keeps offering to verify a
                  // fare that is already drafted and would produce a second,
                  // duplicate draft if the traveller said yes.
                  const who = d.passengers[0];
                  onEvent(
                    `I filled in the details myself for the ${f.outbound[0].carrier} ` +
                      `${f.outbound[0].flightNumber} — ${who.firstName} ${who.lastName}. ` +
                      `It is priced at ${d.quote.total.toFixed(2)} and waiting for my approval` +
                      `${changed ? ', and the fare moved from the search price' : ''}. ` +
                      `No need to search or draft it again.`,
                  );
                }}
              />
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------- verify_flight ---------- */

function VerifyCard({ data }: { data: VerifyResult }) {
  return (
    <div className="card">
      <div className="card-head">
        <span>Fare verified</span>
        {data.priceChanged ? (
          <span className="pill warn">price changed</span>
        ) : (
          <span className="pill ok">price held</span>
        )}
      </div>
      <div className="card-body">
        <Leg segments={data.outbound} />
        {data.inbound?.length ? (
          <div style={{ marginTop: 10 }}>
            <Leg segments={data.inbound} />
          </div>
        ) : null}
        <div style={{ marginTop: 12 }} className="rows">
          <dt>Adult fare</dt>
          <dd>{usdc(data.price.adult)}</dd>
          {data.previousPrice ? (
            <>
              <dt>Was</dt>
              <dd style={{ textDecoration: 'line-through' }}>
                {usdc(data.previousPrice.adult)}
              </dd>
            </>
          ) : null}
        </div>
        {data.bookingRequirements?.length ? (
          <p className="note">
            The airline requires: {data.bookingRequirements.join(', ')}.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ---------- get_seats / get_luggage ---------- */

function SeatCard({ data }: { data: SeatMapSegment[] }) {
  const segments = Array.isArray(data) ? data : [];
  return (
    <div className="card">
      <div className="card-head">
        <span>Seat map</span>
      </div>
      <div className="card-body scroll-x">
        {segments.map((seg) => (
          <div key={seg.flightNumber} style={{ marginBottom: 10 }}>
            <div className="leg-meta" style={{ marginBottom: 6 }}>
              {seg.flightNumber}
            </div>
            {seg.rows.map((row) => (
              <div
                key={row.row}
                style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}
              >
                <span className="code" style={{ width: 22 }}>
                  {row.row}
                </span>
                {row.seats.map((s) => (
                  <span
                    key={s.code}
                    className={`pill ${s.available ? 'ok' : 'bad'}`}
                    style={{ margin: 0, minWidth: 34, textAlign: 'center' }}
                    title={
                      s.available
                        ? `${s.code} · ${s.position} · ${usdc(s.price)}`
                        : `${s.code} taken`
                    }
                  >
                    {s.code.replace(String(row.row), '')}
                  </span>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function LuggageCard({ data }: { data: LuggageOption[] }) {
  const options = Array.isArray(data) ? data : [];
  return (
    <div className="card">
      <div className="card-head">
        <span>Baggage options</span>
      </div>
      <div className="card-body">
        <dl className="rows">
          {options.map((o) => (
            <div key={o.id} style={{ display: 'contents' }}>
              <dt>
                {o.description} · {o.weightKg}kg
              </dt>
              <dd>{usdc(o.price)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/* ---------- prepare_order → the approval gate ---------- */

export function DraftCard({
  data,
  onPlaced,
}: {
  data: OrderDraft;
  onPlaced: (message: string) => void;
}) {
  const [state, setState] = useState<'idle' | 'placing' | 'placed' | 'error'>('idle');
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = data.quote;

  async function place() {
    setState('placing');
    setError(null);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'place', draftId: data.draftId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not place the order');
      setOrder(body.order);
      setState('placed');
      onPlaced(
        `I approved the booking. Order ${body.order.orderId} is created with PNR ${body.order.pnr}, total ${q.total} USDC, awaiting my payment.`,
      );
    } catch (err) {
      setError((err as Error).message);
      setState('error');
    }
  }

  if (state === 'placed' && order) {
    return <OrderCard data={order} onEvent={onPlaced} />;
  }

  return (
    <div className="card">
      <div className="card-head">
        <span>Ready for your approval</span>
        <span className="pill warn">not booked yet</span>
      </div>
      <div className="card-body">
        <Leg segments={data.outbound} />
        {data.inbound?.length ? (
          <div style={{ marginTop: 10 }}>
            <Leg segments={data.inbound} />
          </div>
        ) : null}

        <div style={{ marginTop: 14 }}>
          {data.passengers.map((p, i) => (
            <div className="leg-meta" key={i}>
              {p.firstName} {p.lastName} · {p.type} · {p.dateOfBirth}
            </div>
          ))}
          <div className="leg-meta">
            {data.contact.email} · {data.contact.phone}
          </div>
        </div>

        <dl className="rows" style={{ marginTop: 14 }}>
          <dt>Fare ({data.passengers.length} passenger{data.passengers.length > 1 ? 's' : ''})</dt>
          <dd>{usdc(q.baseTotal)}</dd>
          {q.seatsTotal > 0 ? (
            <>
              <dt>Seats ({data.selectedSeats.join(', ')})</dt>
              <dd>{usdc(q.seatsTotal)}</dd>
            </>
          ) : null}
          {q.luggageTotal > 0 ? (
            <>
              <dt>Baggage</dt>
              <dd>{usdc(q.luggageTotal)}</dd>
            </>
          ) : null}
          {q.discount > 0 ? (
            <>
              <dt>Discount ({data.couponCode})</dt>
              <dd>−{usdc(q.discount)}</dd>
            </>
          ) : null}
          <dt className="total">Total</dt>
          <dd className="total">{usdc(q.total)}</dd>
        </dl>

        {/* Better to learn this before booking than after: an order for a
            deposit-only fare cannot be paid from the wallet at all. */}
        {data.cardPayable === false ? (
          <p className="note warn">
            This airline settles this fare by agency deposit — a FluxA card
            cannot pay it. You can still book it, but payment will not be
            possible from your wallet.
          </p>
        ) : null}

        <div className="actions">
          <button
            className="primary"
            onClick={place}
            disabled={state === 'placing'}
          >
            {state === 'placing' ? 'Booking…' : `Approve and book · ${usdc(q.total)}`}
          </button>
        </div>
        {error ? <p className="note bad">{error}</p> : null}
        <p className="note">
          The agent cannot place this booking or move money. It happens only when
          you click, and payment is made from your own wallet.
        </p>
      </div>
    </div>
  );
}

/* ---------- orders ---------- */

const STATUS_PILL: Record<string, string> = {
  pending_payment: 'warn',
  paying: 'warn',
  paid: 'warn',
  ticketing: 'warn',
  ticketed: 'ok',
  cancelled: 'bad',
  failed: 'bad',
};

export function OrderCard({
  data,
  onEvent,
}: {
  data: Order;
  onEvent: (message: string) => void;
}) {
  const [order, setOrder] = useState<Order>(data);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wallet = useWallet();

  const awaitingPayment = order.status === 'pending_payment';

  // Which rails this fare accepts. `cardPayable` is only false when Atlas said
  // so; treat an absent flag as "available" so an older order still offers a
  // way to pay rather than silently offering none.
  const cardOk = order.cardPayable !== false;
  const depositOk = order.depositPayable !== false;
  const bothRails = cardOk && depositOk;

  // Default to the card when there is a choice: that spends the traveller's
  // own money, which is the honest default. The deposit spends the desk's.
  const [rail, setRail] = useState<'card' | 'deposit'>(cardOk ? 'card' : 'deposit');

  async function post(action: string, extra: Record<string, unknown> = {}) {
    setWorking(true);
    setError(null);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, orderId: order.orderId, ...extra }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Request failed');
      if (body.order) setOrder(body.order);
      return body;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setWorking(false);
    }
  }

  async function refresh() {
    setWorking(true);
    try {
      const res = await fetch(`/api/orders?orderId=${encodeURIComponent(order.orderId)}`);
      const body = await res.json();
      if (res.ok) setOrder(body.order);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="card">
      {/* Identify by PNR. Atlas order numbers share a long common prefix, so
          truncating them makes every booking look like the same one — the
          airline reference is both shorter and the thing you actually quote
          at a check-in desk. */}
      <div className="card-head">
        <span title={order.orderId}>
          {order.pnr ? `PNR ${order.pnr}` : `Order ${order.orderId.slice(-10)}`}
        </span>
        <span className={`pill ${STATUS_PILL[order.status] ?? ''}`}>
          {order.status.replace('_', ' ')}
        </span>
      </div>
      <div className="card-body">
        <Leg segments={order.outbound} />
        {order.inbound?.length ? (
          <div style={{ marginTop: 10 }}>
            <Leg segments={order.inbound} />
          </div>
        ) : null}

        <dl className="rows" style={{ marginTop: 14 }}>
          {order.pnr ? (
            <>
              <dt>Airline reference</dt>
              <dd style={{ fontFamily: 'var(--mono)' }}>{order.pnr}</dd>
            </>
          ) : null}
          <dt className="total">Total</dt>
          <dd className="total">{usdc(order.totalPrice)}</dd>
        </dl>

        {/* The outcome, stated at the size it deserves.
            Everything before this — searching, comparing, authorising — exists
            to produce a ticket, and it used to be reported in 11px grey beneath
            the fold. A settled booking should be the loudest thing on the card. */}
        {order.status === 'ticketed' || order.status === 'ticketing' ? (
          <div className={`outcome ${order.status}`}>
            <div className="outcome-mark" aria-hidden="true">
              {order.status === 'ticketed' ? '✓' : '•••'}
            </div>
            <div className="outcome-body">
              <div className="outcome-title">
                {order.status === 'ticketed' ? 'Ticketed' : 'Paid · ticketing'}
              </div>
              {order.tickets?.length ? (
                <div className="outcome-tickets">
                  {order.tickets.map((t) => (
                    <div key={t.ticketNumber}>
                      {t.passenger} · <strong>{t.ticketNumber}</strong>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="outcome-note">
                  Payment confirmed. The airline issues ticket numbers shortly.
                </div>
              )}
            </div>
          </div>
        ) : null}

        <div className="actions">
          {awaitingPayment && order.paymentUrl ? (
            <a
              className="btn primary"
              href={order.paymentUrl}
              target="_blank"
              rel="noreferrer"
            >
              Pay {usdc(order.totalPrice)} in your wallet
            </a>
          ) : null}
          {order.status === 'ticketing' ? (
            <button onClick={refresh} disabled={working}>
              {working ? 'Checking…' : 'Check ticketing status'}
            </button>
          ) : null}
          {/* Refunds start as a question, not an action: the agent quotes the
              penalty and you approve the amount. Without this the only way in
              is knowing to type it. */}
          {order.status === 'ticketed' ? (
            <button
              onClick={() =>
                onEvent(
                  `Quote a refund for order ${order.orderId} (PNR ${order.pnr ?? '—'}). ` +
                    `Show me the penalty and whether the quote is exact before I decide.`,
                )
              }
            >
              Quote a refund
            </button>
          ) : null}
        </div>

        {/* The funding gate. A prepaid card that cannot cover the fare is the
            usual reason a booking stops here, so the way out is offered in
            place rather than behind the wallet toggle. */}
        {/* Paying and choosing what to pay with are one control, so the
            button that spends money names the card it will spend from. */}
        {/* Atlas reports which rails a fare accepts, and many accept both. When
            it does, that is the traveller's choice to make — the two are not
            equivalent: a card spends their money, the deposit spends the
            desk's. Defaulting silently to one would hide that. */}
        {awaitingPayment && bothRails ? (
          <div className="railpick" role="radiogroup" aria-label="How to pay">
            <button
              role="radio"
              aria-checked={rail === 'card'}
              className={rail === 'card' ? 'on' : ''}
              onClick={() => setRail('card')}
            >
              <span className="railpick-title">FluxA card</span>
              <span className="railpick-note">Charged to your own card</span>
            </button>
            <button
              role="radio"
              aria-checked={rail === 'deposit'}
              className={rail === 'deposit' ? 'on' : ''}
              onClick={() => setRail('deposit')}
            >
              <span className="railpick-title">FluxA Deposit</span>
              <span className="railpick-note">Settled by the desk, you authorise</span>
            </button>
          </div>
        ) : null}

        {awaitingPayment && rail === 'deposit' ? (
          <DepositPayFlow
            orderId={order.orderId}
            reference={order.pnr}
            amount={order.totalPrice}
            currency="USDC"
            soleRail={!bothRails}
            onSettled={async (message) => {
              await refresh();
              onEvent(message);
            }}
          />
        ) : null}

        {awaitingPayment && rail === 'card' ? (
          <PayControl
            amount={order.totalPrice}
            currency="USDC"
            working={working}
            onPay={async (cardId) => {
              const body = await post('pay', { cardId });
              if (body?.order) {
                await wallet.refresh();
                onEvent(
                  `I paid order ${order.orderId} with my FluxA card. It is now ${body.order.status}.`,
                );
              }
            }}
          />
        ) : null}

        {awaitingPayment && !order.cardPayable && !order.depositPayable ? (
          <p className="note bad">
            The airline accepts neither a card nor the agency deposit for this
            fare, so it cannot be paid here.
          </p>
        ) : null}

        {error ? <p className="note bad">{error}</p> : null}
      </div>
    </div>
  );
}

function OrderList({
  data,
  onEvent,
}: {
  data: Order[];
  onEvent: (message: string) => void;
}) {
  const orders = Array.isArray(data) ? data : [];
  if (!orders.length) {
    return (
      <div className="card">
        <div className="card-body">
          <p className="note">No bookings yet.</p>
        </div>
      </div>
    );
  }
  return (
    <>
      {orders.map((o) => (
        <OrderCard key={o.orderId} data={o} onEvent={onEvent} />
      ))}
    </>
  );
}

/* ---------- refunds ---------- */

export function RefundCard({
  data,
  onEvent,
}: {
  data: RefundQuote;
  onEvent: (message: string) => void;
}) {
  const [state, setState] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setState('working');
    setError(null);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'refund',
          orderId: data.orderId,
          refundOfferId: data.refundOfferId,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not submit the refund');
      setState('done');
      onEvent(
        `I approved the refund for order ${data.orderId}. Refund ${body.refund.refundId} is ${body.refund.status}, for ${data.refundAmount} USDC.`,
      );
    } catch (err) {
      setError((err as Error).message);
      setState('error');
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <span>Refund quote</span>
        <span className={`pill ${data.quoteType === 'AccurateQuote' ? 'ok' : 'warn'}`}>
          {data.quoteType === 'AccurateQuote' ? 'exact' : 'estimate only'}
        </span>
      </div>
      <div className="card-body">
        <dl className="rows">
          <dt>Airline penalty</dt>
          <dd>−{usdc(data.penalty)}</dd>
          <dt className="total">You get back</dt>
          <dd className="total">{usdc(data.refundAmount)}</dd>
        </dl>
        {data.note ? <p className="note warn">{data.note}</p> : null}
        {state === 'done' ? (
          <p className="note">Refund submitted.</p>
        ) : (
          <div className="actions">
            <button className="primary" onClick={submit} disabled={state === 'working'}>
              {state === 'working' ? 'Submitting…' : 'Approve refund'}
            </button>
          </div>
        )}
        {error ? <p className="note bad">{error}</p> : null}
      </div>
    </div>
  );
}

/* ---------- dispatcher ---------- */

export function ToolResult({
  tool,
  data,
  onEvent,
}: {
  tool: string;
  data: any;
  onEvent: (message: string) => void;
}) {
  if (data == null) return null;
  try {
    switch (tool) {
      case 'search_flights':
        return <FlightResults data={data} onEvent={onEvent} />;
      case 'verify_flight':
        return <VerifyCard data={data} />;
      case 'get_seats':
        return <SeatCard data={data} />;
      case 'get_luggage':
        return <LuggageCard data={data} />;
      case 'prepare_order':
        return <DraftCard data={data} onPlaced={onEvent} />;
      case 'check_order':
        return <OrderCard data={data} onEvent={onEvent} />;
      case 'list_orders':
        return <OrderList data={data} onEvent={onEvent} />;
      case 'quote_refund':
        return <RefundCard data={data} onEvent={onEvent} />;
      default:
        return null;
    }
  } catch {
    // A malformed payload should never take the transcript down with it.
    return null;
  }
}
