import type {
  Contact,
  CouponResult,
  LuggageOption,
  Order,
  OrderDraft,
  Passenger,
  RefundQuote,
  RefundStatus,
  SearchParams,
  SearchResult,
  SeatMapSegment,
  VerifyResult,
} from '../types';

export interface DraftOrderInput {
  verifiedFlightId: string;
  passengers: Passenger[];
  contact: Contact;
  selectedSeats?: string[];
  selectedLuggage?: string[];
  couponCode?: string;
}

/**
 * The booking backend, as the agent sees it.
 *
 * Two implementations exist: `mock` (fixture-driven, used until a FluxA wallet
 * is funded) and `flight402` (the live REST API). They are behaviourally
 * interchangeable — the mock simulates price drift, async ticketing, and the
 * refund status walk rather than returning canned success.
 *
 * Note the split between `draftOrder` and `placeOrder`. Drafting is pure: it
 * prices a booking without touching the airline. Placing is irreversible — it
 * holds real inventory and issues a payment link. The agent is given the first
 * and never the second.
 */
export interface BookingProvider {
  readonly name: string;

  // --- Shop (read-only) ---
  searchFlights(params: SearchParams): Promise<SearchResult>;
  verifyFlight(flightId: string): Promise<VerifyResult>;
  getSeats(verifiedFlightId: string): Promise<SeatMapSegment[]>;
  getLuggage(verifiedFlightId: string): Promise<LuggageOption[]>;
  checkCoupon(code: string, orderAmount?: number): Promise<CouponResult>;

  // --- Draft (pure — no booking, no money) ---
  draftOrder(input: DraftOrderInput): Promise<OrderDraft>;

  // --- Commit (human-gated; never exposed as an agent tool) ---
  placeOrder(draftId: string): Promise<Order>;
  /**
   * Settle an order.
   *
   * Two rails, because Atlas exposes two and most fares only accept one:
   *  - `card`    — the traveller's FluxA virtual card, charged by the airline.
   *                Only works where the fare lists VCC support.
   *  - `deposit` — the desk's agency balance with Atlas. Works on every fare,
   *                but the traveller has not paid: this is a settlement rail,
   *                not a funding source, so collection is a separate concern.
   */
  completePayment(
    orderId: string,
    options?: { cardId?: string; method?: 'card' | 'deposit' },
  ): Promise<Order>;

  // --- Follow ---
  getOrder(orderId: string): Promise<Order>;
  listOrders(): Promise<Order[]>;

  // --- Post-booking ---
  quoteRefund(orderId: string): Promise<RefundQuote>;
  submitRefund(orderId: string, refundOfferId: string): Promise<RefundStatus>;
  getRefund(orderId: string, refundId: string): Promise<RefundStatus>;
}
