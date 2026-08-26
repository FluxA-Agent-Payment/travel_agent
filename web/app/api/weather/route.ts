import { NextRequest } from 'next/server';

import { getWeather } from '@/lib/weather';

export const runtime = 'nodejs';

/**
 * Destination weather for a travel date, used as card ambience.
 *
 * Deliberately forgiving: an unknown airport, a bad date, or an upstream
 * outage all return `{ weather: null }` with a 200 rather than an error, so a
 * decorative lookup can never surface as a failure on a booking screen.
 */
export async function GET(req: NextRequest) {
  const airport = req.nextUrl.searchParams.get('airport');
  const date = req.nextUrl.searchParams.get('date');

  if (!airport || !date) {
    return Response.json({ weather: null });
  }

  try {
    const weather = await getWeather(airport, date);
    return Response.json(
      { weather },
      { headers: { 'Cache-Control': 'public, max-age=3600' } },
    );
  } catch {
    return Response.json({ weather: null });
  }
}
