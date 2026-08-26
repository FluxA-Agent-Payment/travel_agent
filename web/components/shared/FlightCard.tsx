'use client';

import { useEffect, useState } from 'react';

import { airlineName, airlineTint } from '@/lib/data/airports';
import type { FlightOffer, Price, Segment } from '@/lib/types';
import type { Weather, WeatherKind } from '@/lib/weather';

/* ---------- formatting ---------- */

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d
    .toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: 'UTC',
    })
    .replace(/^0/, '');
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function isoDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function hm(mins: number): string {
  if (!mins) return '';
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

function layoverMinutes(a: Segment, b: Segment): number {
  return Math.round(
    (new Date(b.departure.time).getTime() - new Date(a.arrival.time).getTime()) /
      60_000,
  );
}

/* ---------- weather ---------- */

const WEATHER_GLYPH: Record<WeatherKind, string> = {
  clear: '☀',
  cloudy: '☁',
  fog: '≈',
  rain: '☂',
  snow: '❄',
  storm: '⚡',
};

const WEATHER_WORD: Record<WeatherKind, string> = {
  clear: 'sunny',
  cloudy: 'cloudy',
  fog: 'foggy',
  rain: 'rainy',
  snow: 'snowy',
  storm: 'stormy',
};

/**
 * Destination weather for the arrival date, fetched once per airport+date.
 *
 * Rendered as a wash behind the card. It is ambience, so every failure path
 * simply yields nothing — the card never waits on it and never shows an error.
 */
function useWeather(airportCode?: string, date?: string) {
  const [weather, setWeather] = useState<Weather | null>(null);

  useEffect(() => {
    if (!airportCode || !date) return;
    let live = true;
    fetch(
      `/api/weather?airport=${encodeURIComponent(airportCode)}&date=${encodeURIComponent(date)}`,
    )
      .then((r) => (r.ok ? r.json() : { weather: null }))
      .then((body) => {
        if (live) setWeather(body.weather ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [airportCode, date]);

  return weather;
}

/* ---------- carrier mark ---------- */

/**
 * The airline's real logo, falling back to a tinted monogram.
 *
 * Logo CDNs are third-party and go down, rate-limit, or simply lack a carrier;
 * `onError` swaps in the monogram so a missing image never leaves a hole in
 * the card. Airhex was the other candidate but returns 401 without a key.
 */
function CarrierMark({ code }: { code: string }) {
  const [failed, setFailed] = useState(false);
  const iata = (code ?? '').toUpperCase();

  if (failed || !iata) {
    return (
      <span
        className="monogram"
        style={{ ['--carrier' as string]: airlineTint(iata) }}
        aria-hidden="true"
      >
        {iata}
      </span>
    );
  }

  return (
    <img
      className="carrier-logo"
      src={`https://images.kiwi.com/airlines/64/${iata}.png`}
      alt=""
      width={30}
      height={30}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/* ---------- card ---------- */

export function FlightCard({
  offer,
  badge,
  priceLabel = 'per adult',
  onBook,
  onFillIn,
  verification,
}: {
  offer: FlightOffer;
  badge?: string;
  priceLabel?: string;
  /** Hand this offer to the agent, which verifies and drafts it. */
  onBook?: (offer: FlightOffer) => void;
  /** Open the passenger form on this card instead. */
  onFillIn?: (offer: FlightOffer) => void;
  /** Live-fare check for this offer, folded in rather than shown separately. */
  verification?: { priceChanged: boolean; price: Price; previousPrice?: Price };
}) {
  const [expanded, setExpanded] = useState(false);

  const segments = offer.outbound ?? [];
  const last = segments.length ? segments[segments.length - 1] : undefined;

  // Every hook runs before the empty-segment bail-out below — calling
  // useWeather after an early return would break the Rules of Hooks.
  const weather = useWeather(
    last?.arrival.airport,
    last ? isoDate(last.arrival.time) : undefined,
  );

  if (!segments.length || !last) return null;

  const first = segments[0];
  const stops = segments.length - 1;
  const totalMinutes = segments.reduce((n, s) => n + (s.durationMinutes ?? 0), 0);
  const layovers = segments
    .slice(1)
    .reduce((n, s, i) => n + layoverMinutes(segments[i], s), 0);
  const elapsed = totalMinutes + layovers;

  const arrivesLater =
    new Date(last.arrival.time).getUTCDate() !==
    new Date(first.departure.time).getUTCDate();

  const tint = airlineTint(first.carrier);

  return (
    <article className="fcard" style={{ ['--carrier' as string]: tint }}>
      {/* Row 1 — carrier identity and price */}
      <header className="fcard-head">
        <CarrierMark code={first.carrier} />
        <div className="carrier">
          <span className="carrier-name">{airlineName(first.carrier)}</span>
          <span className="carrier-no">{first.flightNumber}</span>
        </div>
        <div className="fcard-price">
          {offer.price.adult.toFixed(2)}
          <span className="ccy"> USDC</span>
          <small>{priceLabel}</small>
        </div>
      </header>

      {/* Row 2 — route, date, and the journey itself */}
      <div className="fcard-body">
        <div className="fcard-od">
          <div className="od">
            {first.departure.airport}–{last.arrival.airport}
          </div>
          <div className="od-date">{shortDate(first.departure.time)}</div>
        </div>

        <div className="fcard-journey">
          <div className="fcard-times">
            <span className="t">{clock(first.departure.time)}</span>
            <span className="arrow" aria-hidden="true">
              <span className="arrow-line" />
              <span className="arrow-head" />
            </span>
            <span className="t">
              {clock(last.arrival.time)}
              {arrivesLater ? <sup>+1</sup> : null}
            </span>
          </div>
          <div className="fcard-elapsed">{hm(elapsed)}</div>
        </div>
      </div>

      {/* Row 3 — tags. Verification lands here rather than as its own card:
          the fact that matters is whether *this* fare still stands, so it
          belongs on the fare it describes. */}
      <div className="fcard-tags">
        {verification ? (
          verification.priceChanged ? (
            <span
              className="pill warn"
              title="The live fare differs from the search price"
            >
              price changed
              {verification.previousPrice
                ? ` ${verification.previousPrice.adult.toFixed(2)} → ${verification.price.adult.toFixed(2)}`
                : null}
            </span>
          ) : (
            <span className="pill ok" title="Re-checked with the airline just now">
              verified · price held
            </span>
          )
        ) : null}
        {/* Most Atlas fares settle by agency deposit and take no card at all.
            Said here so the choice is informed, rather than discovered at the
            payment step on an order that is already booked. */}
        {offer.cardPayable === false ? (
          <span
            className="pill warn"
            title="This airline settles by agency deposit for this fare — a FluxA card cannot pay it"
          >
            no card payment
          </span>
        ) : null}
        {badge ? <span className="pill ok">{badge}</span> : null}
        <span className="pill">{stops === 0 ? 'nonstop' : `${stops} stop`}</span>
        {offer.baggageIncluded ? (
          <span className="pill">bag included</span>
        ) : (
          <span className="pill">bag extra</span>
        )}
        {offer.refundable ? <span className="pill">refundable</span> : null}
        {typeof offer.seatsLeft === 'number' && offer.seatsLeft <= 3 ? (
          <span className="pill warn">
            {offer.seatsLeft} seat{offer.seatsLeft > 1 ? 's' : ''} left
          </span>
        ) : null}
      </div>

      {/* Destination conditions, written so it is obvious what it describes:
          which city, which day, and whether it is a real forecast or a
          seasonal norm. The earlier compact chip read as an orphan number. */}
      {weather ? (
        <div
          className={`wx-row wx-${weather.kind}`}
          // The forecast/seasonal-norm distinction moves to the tooltip rather
          // than being dropped — a climate average shown as a forecast would
          // be a quiet inaccuracy on a booking screen.
          title={
            weather.basis === 'forecast'
              ? `Forecast for ${weather.city} on ${weather.date}`
              : `Typical conditions for ${weather.city} around this date, averaged from recent years`
          }
        >
          <span className="wx-glyph" aria-hidden="true">
            {WEATHER_GLYPH[weather.kind]}
          </span>
          <span className="wx-text">
            <strong>{weather.city}</strong> on {shortDate(weather.date)}
            <span className="wx-sep">|</span>
            {WEATHER_WORD[weather.kind]}, {weather.tempMaxC}°/{weather.tempMinC}°C
          </span>
        </div>
      ) : null}

      {/* Row 4 — the connection detail, only when there is one */}
      {stops > 0 ? (
        <>
          <button
            className="fcard-more"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? 'Hide' : 'Show'} {stops} connection{stops > 1 ? 's' : ''}
            <span className={`chev ${expanded ? 'up' : ''}`} aria-hidden="true" />
          </button>

          {expanded ? (
            <ol className="legs">
              {segments.map((seg, i) => (
                <li key={`${seg.flightNumber}-${i}`}>
                  <div className="legline">
                    <span className="legno">{seg.flightNumber}</span>
                    <span className="legtime">
                      {clock(seg.departure.time)} {seg.departure.airport}
                    </span>
                    <span className="legdash">→</span>
                    <span className="legtime">
                      {clock(seg.arrival.time)} {seg.arrival.airport}
                    </span>
                    <span className="legdur">{hm(seg.durationMinutes ?? 0)}</span>
                  </div>
                  {i < segments.length - 1 ? (
                    <div className="layover">
                      {hm(layoverMinutes(seg, segments[i + 1]))} layover in{' '}
                      {seg.arrival.airport}
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
        </>
      ) : null}

      {/* Row 5 — the way into a booking.
          Deliberately not labelled "Buy": clicking this purchases nothing. The
          fare still has to be re-verified live and the traveller still has to
          approve a priced draft, so a label promising a completed purchase
          would misdescribe what the button does. */}
      {onBook ? (
        <div className="fcard-book">
          <button className="primary" onClick={() => onBook(offer)}>
            Book this · {offer.price.adult.toFixed(2)} USDC
          </button>
          {onFillIn ? (
            <button className="linkish" onClick={() => onFillIn(offer)}>
              fill in details myself
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
