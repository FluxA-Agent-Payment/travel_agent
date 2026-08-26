/**
 * Minimal airport reference: city name and coordinates.
 *
 * Coordinates exist so the destination's weather can be looked up for the
 * travel date. Unknown codes degrade gracefully — the card simply renders
 * without a weather background rather than guessing a location.
 */
export interface Airport {
  code: string;
  city: string;
  country: string;
  lat: number;
  lon: number;
}

export const AIRPORTS: Record<string, Airport> = {
  LHR: { code: 'LHR', city: 'London', country: 'GB', lat: 51.47, lon: -0.4543 },
  LON: { code: 'LON', city: 'London', country: 'GB', lat: 51.5074, lon: -0.1278 },
  LGW: { code: 'LGW', city: 'London', country: 'GB', lat: 51.1537, lon: -0.1821 },
  JFK: { code: 'JFK', city: 'New York', country: 'US', lat: 40.6413, lon: -73.7781 },
  NYC: { code: 'NYC', city: 'New York', country: 'US', lat: 40.7128, lon: -74.006 },
  EWR: { code: 'EWR', city: 'Newark', country: 'US', lat: 40.6895, lon: -74.1745 },
  LAX: { code: 'LAX', city: 'Los Angeles', country: 'US', lat: 33.9416, lon: -118.4085 },
  SFO: { code: 'SFO', city: 'San Francisco', country: 'US', lat: 37.6213, lon: -122.379 },
  ORD: { code: 'ORD', city: 'Chicago', country: 'US', lat: 41.9742, lon: -87.9073 },
  MIA: { code: 'MIA', city: 'Miami', country: 'US', lat: 25.7959, lon: -80.287 },
  SIN: { code: 'SIN', city: 'Singapore', country: 'SG', lat: 1.3644, lon: 103.9915 },
  HKG: { code: 'HKG', city: 'Hong Kong', country: 'HK', lat: 22.308, lon: 113.9185 },
  NRT: { code: 'NRT', city: 'Tokyo', country: 'JP', lat: 35.772, lon: 140.3929 },
  HND: { code: 'HND', city: 'Tokyo', country: 'JP', lat: 35.5494, lon: 139.7798 },
  TYO: { code: 'TYO', city: 'Tokyo', country: 'JP', lat: 35.6762, lon: 139.6503 },
  DXB: { code: 'DXB', city: 'Dubai', country: 'AE', lat: 25.2532, lon: 55.3657 },
  DOH: { code: 'DOH', city: 'Doha', country: 'QA', lat: 25.2609, lon: 51.6138 },
  CDG: { code: 'CDG', city: 'Paris', country: 'FR', lat: 49.0097, lon: 2.5479 },
  PAR: { code: 'PAR', city: 'Paris', country: 'FR', lat: 48.8566, lon: 2.3522 },
  AMS: { code: 'AMS', city: 'Amsterdam', country: 'NL', lat: 52.3105, lon: 4.7683 },
  FRA: { code: 'FRA', city: 'Frankfurt', country: 'DE', lat: 50.0379, lon: 8.5622 },
  MUC: { code: 'MUC', city: 'Munich', country: 'DE', lat: 48.3537, lon: 11.786 },
  MAD: { code: 'MAD', city: 'Madrid', country: 'ES', lat: 40.4983, lon: -3.5676 },
  BCN: { code: 'BCN', city: 'Barcelona', country: 'ES', lat: 41.2974, lon: 2.0833 },
  FCO: { code: 'FCO', city: 'Rome', country: 'IT', lat: 41.8003, lon: 12.2389 },
  IST: { code: 'IST', city: 'Istanbul', country: 'TR', lat: 41.2753, lon: 28.7519 },
  DEL: { code: 'DEL', city: 'Delhi', country: 'IN', lat: 28.5562, lon: 77.1 },
  BOM: { code: 'BOM', city: 'Mumbai', country: 'IN', lat: 19.0896, lon: 72.8656 },
  BKK: { code: 'BKK', city: 'Bangkok', country: 'TH', lat: 13.69, lon: 100.7501 },
  SYD: { code: 'SYD', city: 'Sydney', country: 'AU', lat: -33.9399, lon: 151.1753 },
  MEL: { code: 'MEL', city: 'Melbourne', country: 'AU', lat: -37.669, lon: 144.841 },
  PEK: { code: 'PEK', city: 'Beijing', country: 'CN', lat: 40.0799, lon: 116.6031 },
  PVG: { code: 'PVG', city: 'Shanghai', country: 'CN', lat: 31.1443, lon: 121.8083 },
  ICN: { code: 'ICN', city: 'Seoul', country: 'KR', lat: 37.4602, lon: 126.4407 },
  YYZ: { code: 'YYZ', city: 'Toronto', country: 'CA', lat: 43.6777, lon: -79.6248 },
  GRU: { code: 'GRU', city: 'São Paulo', country: 'BR', lat: -23.4356, lon: -46.4731 },
  JNB: { code: 'JNB', city: 'Johannesburg', country: 'ZA', lat: -26.1367, lon: 28.2411 },
  DUB: { code: 'DUB', city: 'Dublin', country: 'IE', lat: 53.4213, lon: -6.2701 },
  ZRH: { code: 'ZRH', city: 'Zurich', country: 'CH', lat: 47.4647, lon: 8.5492 },
  VIE: { code: 'VIE', city: 'Vienna', country: 'AT', lat: 48.1103, lon: 16.5697 },
  CPH: { code: 'CPH', city: 'Copenhagen', country: 'DK', lat: 55.6181, lon: 12.656 },
};

export function airport(code?: string): Airport | undefined {
  if (!code) return undefined;
  return AIRPORTS[code.toUpperCase()];
}

/** Airline display names and a brand tint for the monogram tile. */
export const AIRLINES: Record<string, { name: string; tint: string }> = {
  BA: { name: 'British Airways', tint: '#1d3f6e' },
  AA: { name: 'American Airlines', tint: '#0d4b8f' },
  EK: { name: 'Emirates', tint: '#9b1b30' },
  SQ: { name: 'Singapore Airlines', tint: '#1a3d6d' },
  LH: { name: 'Lufthansa', tint: '#12395b' },
  FR: { name: 'Ryanair', tint: '#123a86' },
  UA: { name: 'United Airlines', tint: '#12365e' },
  DL: { name: 'Delta', tint: '#7b1a2e' },
  AF: { name: 'Air France', tint: '#123b7a' },
  KL: { name: 'KLM', tint: '#1a5fa8' },
  QR: { name: 'Qatar Airways', tint: '#5c1035' },
  TK: { name: 'Turkish Airlines', tint: '#8f1420' },
  CX: { name: 'Cathay Pacific', tint: '#1a5c4f' },
  NH: { name: 'ANA', tint: '#12325e' },
  JL: { name: 'Japan Airlines', tint: '#8e1220' },
};

export function airlineName(code: string): string {
  return AIRLINES[code?.toUpperCase()]?.name ?? code;
}

export function airlineTint(code: string): string {
  return AIRLINES[code?.toUpperCase()]?.tint ?? '#3a4a5a';
}
