/**
 * Shared types for the booking agent.
 *
 * These mirror the flight402 `/v1/*` contract (see its public/llms.txt), not
 * the raw Atlas/AtripTech schema — flight402 already normalises Atlas offers
 * into USDC-priced flights, so the agent never sees Atlas field names.
 */

export type CabinClass = 'economy' | 'premium' | 'business' | 'first';

export interface SearchParams {
  from: string;
  to: string;
  date: string;
  returnDate?: string;
  adults?: number;
  children?: number;
  infants?: number;
  airlines?: string[];
}

export interface Segment {
  flightNumber: string;
  carrier: string;
  departure: { airport: string; time: string };
  arrival: { airport: string; time: string };
  durationMinutes?: number;
  stops?: number;
}

export interface Price {
  /** ISO currency Atlas quoted in — USD, SGD, etc. Not always USDC. */
  currency: string;
  adult: number;
  child?: number;
  infant?: number;
}

export interface FlightOffer {
  flightId: string;
  price: Price;
  outbound: Segment[];
  inbound?: Segment[];
  cabinClass?: CabinClass;
  baggageIncluded?: boolean;
  refundable?: boolean;
  seatsLeft?: number;
  /**
   * Whether the airline accepts a virtual card for this fare.
   *
   * Atlas reports `supportPaymentMethods` per routing, and many fares are
   * deposit-only — no card of any kind can pay them. Carried all the way from
   * search to the order so a fare that cannot be paid by card is never
   * presented as if it can.
   */
  cardPayable?: boolean;
  /** Whether this fare can settle from the desk's agency deposit. */
  depositPayable?: boolean;
}

export interface SearchResult {
  flights: FlightOffer[];
}

export interface VerifyResult {
  verifiedFlightId: string;
  priceChanged: boolean;
  price: Price;
  previousPrice?: Price;
  maxSeats?: number;
  outbound: Segment[];
  inbound?: Segment[];
  /** Fields the airline demands per passenger, e.g. passport number. */
  bookingRequirements?: string[];
}

export interface SeatOption {
  code: string;
  available: boolean;
  price: number;
  position?: string;
}

export interface SeatMapSegment {
  flightNumber: string;
  rows: { row: number; seats: SeatOption[] }[];
}

export interface LuggageOption {
  id: string;
  description: string;
  weightKg: number;
  price: number;
  segment?: string;
}

export interface Passenger {
  firstName: string;
  lastName: string;
  /** ISO date, YYYY-MM-DD. */
  dateOfBirth: string;
  type: 'adult' | 'child' | 'infant';
  gender?: 'M' | 'F';
  nationality?: string;
  passportNumber?: string;
  passportExpiry?: string;
}

export interface Contact {
  /** E.164, e.g. "+8613928109091". flight402 normalises this for Atlas. */
  phone: string;
  email: string;
}

export interface CouponResult {
  valid: boolean;
  code: string;
  discount?: number;
  reason?: string;
}

/**
 * A priced, fully-specified order that has NOT been placed.
 *
 * The agent can produce these freely; only a human clicking approve turns one
 * into a real booking. See lib/agent/tools.ts for why the booking call is not
 * exposed to the model at all.
 */
export interface OrderDraft {
  draftId: string;
  verifiedFlightId: string;
  /** False when the airline takes deposit only and no card can pay this. */
  cardPayable?: boolean;
  /** Whether this fare can settle from the desk's agency deposit. */
  depositPayable?: boolean;
  passengers: Passenger[];
  contact: Contact;
  selectedSeats: string[];
  selectedLuggage: string[];
  couponCode?: string;
  quote: {
    baseTotal: number;
    seatsTotal: number;
    luggageTotal: number;
    discount: number;
    total: number;
    currency: string;
  };
  outbound: Segment[];
  inbound?: Segment[];
  expiresAt?: string;
}

export type OrderStatus =
  | 'pending_payment'
  | 'paid'
  | 'paying'
  | 'ticketing'
  | 'ticketed'
  | 'cancelled'
  | 'failed';

export interface Order {
  orderId: string;
  status: OrderStatus;
  pnr?: string;
  totalPrice: number;
  currency: string;
  /** FluxA payment link. The human pays this — the agent never can. */
  paymentUrl?: string;
  expiresAt?: string;
  outbound: Segment[];
  inbound?: Segment[];
  passengers: Passenger[];
  tickets?: { passenger: string; ticketNumber: string }[];
  refund?: RefundStatus;
  /** False when the airline takes deposit only and no card can pay this. */
  cardPayable?: boolean;
  /** Whether this fare can settle from the desk's agency deposit. */
  depositPayable?: boolean;
  createdAt: string;
}

export interface RefundQuote {
  refundOfferId: string;
  orderId: string;
  refundAmount: number;
  penalty: number;
  currency: string;
  quoteType: 'AccurateQuote' | 'CannotQuote';
  note?: string;
}

export interface RefundStatus {
  refundId: string;
  orderId: string;
  status:
    | 'processing'
    | 'airline_processing'
    | 'refunded'
    | 'rejected'
    | 'withdrawn';
  amount: number;
  currency: string;
  txHash?: string;
}

/** Every provider method throws this on a business-level failure. */
export class BookingError extends Error {
  /**
   * Brand used instead of `instanceof` for recognition.
   *
   * Next.js compiles route handlers as separate module graphs, so this module
   * can be evaluated more than once in a single process — which yields two
   * distinct BookingError classes and makes `instanceof` return false across
   * them. The visible symptom is a well-classified, recoverable error being
   * reported as "Unexpected failure in <tool>", which reads as a crash to the
   * traveller and encourages the model to give up rather than adapt. A brand
   * survives module duplication; the class identity does not.
   */
  readonly isBookingError = true as const;

  constructor(
    message: string,
    public code: string,
    public retryable = false,
  ) {
    super(message);
    this.name = 'BookingError';
  }
}

/** Recognise a BookingError across duplicated module instances. */
export function isBookingError(err: unknown): err is BookingError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as BookingError).isBookingError === true
  );
}
