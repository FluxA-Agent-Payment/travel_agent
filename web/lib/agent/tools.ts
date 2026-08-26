import type Anthropic from '@anthropic-ai/sdk';

import { getBookingProvider } from '../booking';
import { listCards } from '../payments/fluxa';
import { expandTravellers, listTravellers } from '../travellers';
import { BookingError, isBookingError } from '../types';

interface ToolSpec {
  name: string;
  description: string;
  input_schema: Anthropic.Tool['input_schema'];
  run: (input: any) => Promise<unknown>;
}

/** Local shim so each tool reads as a single declaration. */
function betaTool(spec: {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool['input_schema'];
  run: (input: any) => Promise<unknown>;
}): ToolSpec {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: spec.inputSchema,
    run: spec.run,
  };
}

/**
 * The agent's tool surface.
 *
 * Every tool here is either read-only or produces a *draft*. Three operations
 * are deliberately absent and cannot be called by the model at any effort or
 * under any prompt: placing an order, completing a payment, and submitting a
 * refund. Those run only from an explicit human click on their own API routes.
 *
 * That is the whole safety design. It is structural rather than instructed —
 * the model cannot take an irreversible action because no such tool exists in
 * its schema, so no amount of prompt drift or injected text can produce one.
 */

export interface UiEvent {
  type: 'tool_start' | 'tool_result' | 'tool_error';
  tool: string;
  data?: unknown;
  message?: string;
  /** BookingError code, so the UI can tell a fault from an unavailable service. */
  code?: string;
}

export type Emit = (event: UiEvent) => void;

/** Wrap a tool body so failures reach the model as recoverable text. */
function guard<T>(
  emit: Emit,
  tool: string,
  fn: () => Promise<T>,
): Promise<T | string> {
  emit({ type: 'tool_start', tool });
  return fn()
    .then((result) => {
      emit({ type: 'tool_result', tool, data: result });
      return result;
    })
    .catch((err: unknown) => {
      const known = isBookingError(err);
      const message = known
        ? err.message
        : `Unexpected failure in ${tool}: ${(err as Error).message}`;
      emit({ type: 'tool_error', tool, message, code: known ? err.code : undefined });
      // Returned, not thrown: the model should read the problem and adapt
      // (re-search after an expiry, fix a field) rather than the turn dying.
      return `ERROR: ${message}`;
    });
}

/**
 * Strip travel-document numbers from anything handed back to the model.
 *
 * Expanding saved travellers server-side is pointless if the draft that comes
 * back carries the passport straight into the model's context and the
 * transcript — which is exactly what happened before this existed. The full
 * record stays in the server-side draft, so placing the order is unaffected;
 * only the copy the model and the browser see is redacted.
 *
 * The agent has no use for a document number: it never types one into Atlas.
 */
function redact<T>(payload: T): T {
  const scrub = (p: any) =>
    p && typeof p === 'object'
      ? { ...p, passportNumber: p.passportNumber ? '••••••' : undefined }
      : p;

  const walk = (node: any): any => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: any = { ...node };
    if (Array.isArray(out.passengers)) out.passengers = out.passengers.map(scrub);
    for (const k of Object.keys(out)) {
      if (k !== 'passengers' && out[k] && typeof out[k] === 'object') out[k] = walk(out[k]);
    }
    return out;
  };
  return walk(payload) as T;
}

export function buildTools(emit: Emit) {
  const booking = getBookingProvider();

  const searchFlights = betaTool({
    name: 'search_flights',
    description:
      'Search for available flights between two cities on a given date. Returns priced offers, each with a flightId used for verification. Call this whenever the traveller names a route and date, or changes either one.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Departure city or airport IATA code, e.g. "LHR"' },
        to: { type: 'string', description: 'Arrival city or airport IATA code, e.g. "JFK"' },
        date: { type: 'string', description: 'Departure date, YYYY-MM-DD' },
        returnDate: { type: 'string', description: 'Return date for round trips, YYYY-MM-DD' },
        adults: { type: 'integer', description: 'Adults, 1-9. Defaults to 1.' },
        children: { type: 'integer', description: 'Children aged 2-11. Defaults to 0.' },
        infants: { type: 'integer', description: 'Infants under 2. Defaults to 0.' },
        airlines: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict to these airline IATA codes.',
        },
      },
      required: ['from', 'to', 'date'],
    },
    run: (input: any) => guard(emit, 'search_flights', () => booking.searchFlights(input)),
  });

  const verifyFlight = betaTool({
    name: 'verify_flight',
    description:
      'Confirm the live price and availability of one offer before booking. Returns a verifiedFlightId required for seats, baggage and order drafting, plus a priceChanged flag. Always verify before quoting a final price — search prices can move.',
    inputSchema: {
      type: 'object',
      properties: {
        flightId: { type: 'string', description: 'flightId from search_flights' },
      },
      required: ['flightId'],
    },
    run: (input: any) =>
      guard(emit, 'verify_flight', async () => {
        const result = await booking.verifyFlight(input.flightId);
        // Carry the offer this verified back with the result. The UI folds
        // verification into the flight card it belongs to rather than showing
        // a card of its own, and without this it cannot tell which card.
        return { ...result, flightId: input.flightId };
      }),
  });

  const getSeats = betaTool({
    name: 'get_seats',
    description:
      'Get the seat map and per-seat prices for a verified flight. Call when the traveller asks about seating or wants to pick a seat.',
    inputSchema: {
      type: 'object',
      properties: {
        verifiedFlightId: { type: 'string', description: 'From verify_flight' },
      },
      required: ['verifiedFlightId'],
    },
    run: (input: any) =>
      guard(emit, 'get_seats', () => booking.getSeats(input.verifiedFlightId)),
  });

  const getLuggage = betaTool({
    name: 'get_luggage',
    description:
      'Get purchasable checked-baggage options and prices for a verified flight. Call when the traveller mentions luggage, bags, or asks what is included.',
    inputSchema: {
      type: 'object',
      properties: {
        verifiedFlightId: { type: 'string', description: 'From verify_flight' },
      },
      required: ['verifiedFlightId'],
    },
    run: (input: any) =>
      guard(emit, 'get_luggage', () => booking.getLuggage(input.verifiedFlightId)),
  });

  const checkCoupon = betaTool({
    name: 'check_coupon',
    description:
      'Validate a discount code and compute its discount against an order amount. Call when the traveller supplies a code, before including it in a draft.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        orderAmount: {
          type: 'number',
          description: 'Order subtotal in USDC, so the discount can be computed.',
        },
      },
      required: ['code'],
    },
    run: (input: any) =>
      guard(emit, 'check_coupon', () =>
        booking.checkCoupon(input.code, input.orderAmount),
      ),
  });

  const prepareOrder = betaTool({
    name: 'prepare_order',
    description:
      'Price a complete booking and present it to the traveller for approval. This books nothing and charges nothing — it produces a draft with a full fare breakdown that the traveller must approve before any order is placed. Call this once you have a verified flight, every passenger detail, and contact details. If a required passenger field is missing, ask for it instead of guessing.',
    inputSchema: {
      type: 'object',
      properties: {
        verifiedFlightId: { type: 'string', description: 'From verify_flight' },
        travellerIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Ids from list_travellers, for people already on file. Their passport and contact details are filled in server-side — you never need to see or ask for them. Use this instead of `passengers` whenever the traveller is saved.',
        },
        passengers: {
          type: 'array',
          description:
            'One entry per traveller. Only needed for someone not already saved — prefer travellerIds.',
          items: {
            type: 'object',
            properties: {
              firstName: { type: 'string' },
              lastName: { type: 'string' },
              dateOfBirth: { type: 'string', description: 'YYYY-MM-DD' },
              type: { type: 'string', enum: ['adult', 'child', 'infant'] },
              gender: { type: 'string', enum: ['M', 'F'] },
              nationality: { type: 'string', description: 'ISO country code' },
              passportNumber: { type: 'string' },
              passportExpiry: { type: 'string', description: 'YYYY-MM-DD' },
            },
            required: ['firstName', 'lastName', 'dateOfBirth', 'type'],
          },
        },
        contact: {
          type: 'object',
          properties: {
            phone: {
              type: 'string',
              description: 'E.164 with country code, e.g. "+447700900123"',
            },
            email: { type: 'string' },
          },
          required: ['phone', 'email'],
        },
        selectedSeats: {
          type: 'array',
          items: { type: 'string' },
          description: 'Seat codes from get_seats, e.g. ["12A"]',
        },
        selectedLuggage: {
          type: 'array',
          items: { type: 'string' },
          description: 'Baggage option ids from get_luggage',
        },
        couponCode: { type: 'string' },
      },
      required: ['verifiedFlightId'],
    },
    run: (input: any) =>
      guard(emit, 'prepare_order', () => {
        // Expand saved travellers here, on the server. The model passes ids;
        // document numbers are read from disk and handed to the airline
        // without ever entering its context or the transcript.
        const ids: string[] = input.travellerIds ?? [];
        if (ids.length) {
          const saved = expandTravellers(ids);
          return booking
            .draftOrder({
              ...input,
              passengers: [...saved.map((t) => t.passenger), ...(input.passengers ?? [])],
              contact: input.contact ?? saved[0].contact,
            })
            .then(redact);
        }
        if (!input.passengers?.length) {
          throw new BookingError(
            'Either travellerIds or passengers is required',
            'bad_request',
          );
        }
        return booking.draftOrder(input).then(redact);
      }),
  });

  const checkOrder = betaTool({
    name: 'check_order',
    description:
      'Look up the current state of an existing order — payment status, PNR, and ticket numbers once issued. Ticketing is asynchronous, so an order can sit in "ticketing" for a short while after payment; call this again rather than assuming it failed.',
    inputSchema: {
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
    },
    run: (input: any) =>
      guard(emit, 'check_order', () => booking.getOrder(input.orderId).then(redact)),
  });

  const listOrders = betaTool({
    name: 'list_orders',
    description:
      'List the traveller\'s bookings, most recent first. Call when they ask about "my trips", "my bookings", or an order whose id they do not have to hand.',
    inputSchema: { type: 'object', properties: {} },
    run: () => guard(emit, 'list_orders', () => booking.listOrders().then(redact)),
  });

  const quoteRefund = betaTool({
    name: 'quote_refund',
    description:
      'Get a refund quote for a ticketed order: the refundable amount, the airline penalty, and whether the quote is exact. This does not submit anything — the traveller approves the refund separately. Always show the penalty and the quote type before they decide.',
    inputSchema: {
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
    },
    run: (input: any) =>
      guard(emit, 'quote_refund', () => booking.quoteRefund(input.orderId)),
  });

  const checkWallet = betaTool({
    name: 'check_wallet',
    description:
      "Look at the traveller's FluxA wallet: the virtual cards they hold, each card's last four digits and remaining balance. Read-only — you cannot open a card, add funds, or spend from one. Call this when a fare is about to be paid, so you can tell them whether a card covers it and how much short they are if not. FluxA cards are prepaid: a card holding less than the fare cannot pay it, and opening a new card requires the traveller to sign a mandate themselves.",
    inputSchema: { type: 'object', properties: {} },
    run: () =>
      guard(emit, 'check_wallet', async () => {
        const cards = await listCards();
        // Balances and last four only. A PAN or CVV must never enter the
        // model's context — they are read server-side at payment and go
        // straight to the airline.
        return {
          cards: cards.map((c) => ({
            last4: c.last4,
            balanceUsd: Number(c.balance ?? 0),
            status: c.status,
          })),
        };
      }),
  });

  const listSavedTravellers = betaTool({
    name: 'list_travellers',
    description:
      "The travellers whose details are already on file. Returns names and ids only — never a passport number. Call this before asking for passenger details: if the traveller they name is already saved, pass its id to prepare_order as travellerIds instead of asking them to type it all again. Ask only for what is genuinely missing.",
    inputSchema: { type: 'object', properties: {} },
    run: () => guard(emit, 'list_travellers', async () => ({ travellers: listTravellers() })),
  });

  const specs: ToolSpec[] = [
    searchFlights,
    verifyFlight,
    getSeats,
    getLuggage,
    checkCoupon,
    prepareOrder,
    checkOrder,
    listOrders,
    quoteRefund,
    checkWallet,
    listSavedTravellers,
  ];

  const byName = new Map(specs.map((s) => [s.name, s]));

  return {
    /** Wire-format definitions sent to the model. */
    definitions: specs.map(({ name, description, input_schema }) => ({
      name,
      description,
      input_schema,
    })) satisfies Anthropic.Tool[],

    /** Execute one tool_use block and return its result as a string. */
    async dispatch(name: string, input: unknown): Promise<string> {
      const spec = byName.get(name);
      if (!spec) return `ERROR: unknown tool "${name}"`;
      const result = await spec.run(input);
      return typeof result === 'string' ? result : JSON.stringify(result);
    },
  };
}
