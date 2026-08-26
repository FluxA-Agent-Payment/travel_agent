import { airport } from './data/airports';

/**
 * Destination weather for a travel date, via Open-Meteo (no API key).
 *
 * Two regimes, because a booking can be tomorrow or a year out:
 *  - within the forecast horizon (~16 days) → the actual forecast
 *  - beyond it → the historical average for that calendar date over recent
 *    years, labelled as typical rather than predicted
 *
 * The distinction is carried in `basis` and surfaced in the UI. Presenting a
 * climate normal as a forecast would be a small lie on a booking screen.
 */

export type WeatherKind = 'clear' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm';

export interface Weather {
  airport: string;
  city: string;
  date: string;
  kind: WeatherKind;
  tempMaxC: number;
  tempMinC: number;
  basis: 'forecast' | 'typical';
}

/** WMO weather interpretation codes → a small set we can draw. */
function classify(code: number): WeatherKind {
  if (code === 0 || code === 1) return 'clear';
  if (code === 2 || code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 67) return 'rain';
  if (code >= 71 && code <= 77) return 'snow';
  if (code >= 80 && code <= 82) return 'rain';
  if (code >= 85 && code <= 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'cloudy';
}

const cache = new Map<string, { at: number; value: Weather | null }>();
const TTL_MS = 6 * 60 * 60 * 1000;

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    // Weather is decoration. A failure here must never break a booking card.
    return null;
  }
}

export async function getWeather(
  airportCode: string,
  date: string,
): Promise<Weather | null> {
  const place = airport(airportCode);
  if (!place || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const key = `${place.code}:${date}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const target = new Date(`${date}T00:00:00Z`);
  const daysOut = Math.round((target.getTime() - Date.now()) / 86_400_000);
  const coords = `latitude=${place.lat}&longitude=${place.lon}`;
  let value: Weather | null = null;

  if (daysOut >= -1 && daysOut <= 15) {
    const data = await getJson(
      `https://api.open-meteo.com/v1/forecast?${coords}` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min` +
        `&start_date=${date}&end_date=${date}&timezone=UTC`,
    );
    const d = data?.daily;
    if (d?.weather_code?.length) {
      value = {
        airport: place.code,
        city: place.city,
        date,
        kind: classify(d.weather_code[0]),
        tempMaxC: Math.round(d.temperature_2m_max[0]),
        tempMinC: Math.round(d.temperature_2m_min[0]),
        basis: 'forecast',
      };
    }
  } else {
    // Average the same calendar date across recent years for a climate normal.
    const thisYear = new Date().getUTCFullYear();
    const mmdd = date.slice(5);
    const years = [1, 2, 3].map((n) => thisYear - n);
    const results = await Promise.all(
      years.map((y) =>
        getJson(
          `https://archive-api.open-meteo.com/v1/archive?${coords}` +
            `&daily=weather_code,temperature_2m_max,temperature_2m_min` +
            `&start_date=${y}-${mmdd}&end_date=${y}-${mmdd}&timezone=UTC`,
        ),
      ),
    );

    const codes: number[] = [];
    const maxes: number[] = [];
    const mins: number[] = [];
    for (const r of results) {
      const d = r?.daily;
      if (d?.weather_code?.[0] == null) continue;
      codes.push(d.weather_code[0]);
      if (d.temperature_2m_max?.[0] != null) maxes.push(d.temperature_2m_max[0]);
      if (d.temperature_2m_min?.[0] != null) mins.push(d.temperature_2m_min[0]);
    }

    if (codes.length) {
      // Modal condition, not mean — averaging weather codes is meaningless.
      const tally = new Map<WeatherKind, number>();
      for (const c of codes) {
        const k = classify(c);
        tally.set(k, (tally.get(k) ?? 0) + 1);
      }
      const kind = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const avg = (xs: number[]) =>
        Math.round(xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1));
      value = {
        airport: place.code,
        city: place.city,
        date,
        kind,
        tempMaxC: avg(maxes),
        tempMinC: avg(mins),
        basis: 'typical',
      };
    }
  }

  cache.set(key, { at: Date.now(), value });
  return value;
}
