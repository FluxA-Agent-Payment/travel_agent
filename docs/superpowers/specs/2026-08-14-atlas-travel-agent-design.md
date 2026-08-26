# Atlas Travel Agent — Design

Date: 2026-08-14
Status: Approved for planning

## 1. Purpose

An autonomous LLM agent that books flights through the Atlas API
(atriptech). It searches and prices offers, assembles orders with
ancillaries, takes payment behind a human approval gate, follows
orders through asynchronous ticketing, and manages refunds, voids, and
booking records.

The agent converses; it does not improvise. Every step that expires or
moves money is governed by a deterministic state machine, not by the
model's judgement.

## 2. Scope

### In scope (v1)

| Area | Endpoints |
|---|---|
| Shop and price | `search`, `getOffers`, `getOfferPrice`, `verify` |
| In-flow ancillaries | seat, baggage |
| Order | create order, confirm order (Ryanair), pay, query order, order list |
| Post-booking | `refundQuotation`, `refund`, `queryRefundOrders`, void quotation/void/query, post-ticketing ancillaries |
| Utility | balance |

### Out of scope (v1)

`smartSearch`, `priceCompareSearch`, `pnrClaim`, `extractPnr`,
`regenerateOrder`, `stopTicketIssuance`, `confirmBaggageLoss`,
webhooks and incident APIs, route export, email query, ATRIP token.

Webhooks are deferred deliberately: v1 confirms ticketing by polling,
which the Atlas documentation requires regardless of whether webhooks
are registered.

### Decisions taken

| Decision | Choice | Rationale |
|---|---|---|
| Agent shape | Autonomous LLM agent app | Self-contained product, own prompt and policy |
| Autonomy | Approval required on money moves | Payment, refund, and void are irreversible |
| Stack | TypeScript, Next.js web app | Product-shaped, renders offers and approvals well |
| Architecture | State machine governs all calls, including reads | One uniform pattern, no passthrough escape hatch |
| Payment methods | Deposit (method 1) only | Keeps card data out of the app entirely; no PCI scope |
| Persistence | SQLite behind repository interfaces | Zero setup, swappable for Postgres |
| Users | Single operator, no auth | Smallest correct build |
| Credentials | Not yet issued — mock-first | Nothing blocks on credential approval |

## 3. Atlas API facts that drive the design

Established from the vendor documentation:

- Transport is `POST /<endpoint>.do` with a JSON body. There are no
  other verbs.
- Sandbox base URL is `https://sandbox.atriptech.com/`. Production
  base URLs differ per environment type (search versus transaction)
  and are issued in ATRIP under `My Profile → Company Information`.
- Authentication is two headers: `x-atlas-client-id` and
  `x-atlas-client-secret`. Server-side only.
- `Accept: */*` is mandatory. `Accept: application/json` is rejected.
- Responses may be gzip-encoded.
- Success is `status == 0`. The `msg` field must never drive business
  logic.
- Three identifiers thread the flow: `routingIdentifier`, `sessionId`,
  `orderNo`.

Expiry windows:

| Identifier | Produced by | Lifetime | On expiry |
|---|---|---|---|
| `routingIdentifier` | search | 6 hours | New search required |
| `sessionId` | verify | 2 hours | Restart from search |
| Order hold | create order | 30 minutes | Order lapses |
| Order hold (Fulfilment path) | `getOfferPrice` create order | 5 minutes | Order lapses |

Two facts govern payment safety:

1. Payment success does not mean ticketing is complete. Airline PNR
   and ticket numbers become final later, asynchronously.
2. Payment must not be retried blindly after `402`, `404`, `406`, or
   similar order-state errors. Order state must be queried first.

Refund lifecycle is three stages: quotation returns a `refundOfferId`;
application submits it and returns a `refundCode`; query reports
status `0`–`6` (`0` Atlas processing, `1` airline processing, `2`
refunded, `3` airline refunding, `4` rejected, `5` fulfillment done,
`6` withdrew). Quote type is either `AccurateQuote` or `CannotQuote`.
Refund reason codes: `"0"` involuntary, `"1"` voluntary, `"4"` void.
Full tickets only; partially-used itineraries are ineligible.

### Known discrepancy to resolve during implementation

The product guides and the API reference disagree on endpoint names:
the guides use `order.do`, `orderCommit.do`, and
`queryOrderDetails.do`, while the reference indexes Create Order,
Confirm Order, and Query Order. Exact paths must be pinned from the
API reference pages before any client code is written. Do not guess a
path.

## 4. Repository layout

```
travel_agent/
├── src/                          # @travel-agent/core, no Next.js dependency
│   ├── atlas/
│   │   ├── client.ts             # POST transport, headers, gzip, status check
│   │   ├── errors.ts             # AtlasError taxonomy
│   │   ├── endpoints/            # one typed module per endpoint
│   │   ├── schemas/              # zod request and response schemas
│   │   └── mock/                 # fixture-backed implementation
│   ├── booking/
│   │   ├── machine.ts            # states, transitions, guards
│   │   ├── executor.ts           # performs calls, applies transitions
│   │   ├── approval.ts           # pending approval records
│   │   ├── payment.ts            # idempotency and reconciliation
│   │   └── poller.ts             # ticketing and refund status polling
│   ├── agent/
│   │   ├── loop.ts               # Anthropic SDK conversation loop
│   │   ├── tools.ts              # tool schemas generated from legal actions
│   │   └── prompts/
│   ├── store/                    # repository interfaces, SQLite adapters
│   ├── types/
│   └── tests/mocks/
├── web/                          # Next.js app
│   ├── app/
│   │   ├── api/chat/route.ts
│   │   ├── api/approvals/[id]/route.ts
│   │   └── page.tsx
│   ├── components/{layout,pages,providers,shared,ui}/
│   ├── hooks/
│   └── lib/
├── scripts/
├── logs/
└── docs/
```

`web` consumes `@travel-agent/core` through npm workspaces and
`transpilePackages`. The core builds and tests without Next.js, which
is what makes the state machine independently verifiable.

## 5. Atlas transport layer

A single client owns the wire format. Base URL is selected by
`ATLAS_MODE` (`mock` | `sandbox` | `production`). It sets the four
mandatory headers, decodes gzip, and treats `status === 0` as the only
success signal.

Every endpoint has a zod schema for both request and response.
Responses are parsed rather than cast, so vendor drift fails a test
instead of silently feeding the model a missing field.

Failures become a typed `AtlasError` carrying the numeric status and a
classification the state machine reacts to:

| Class | Meaning | Machine response |
|---|---|---|
| `retryable` | Transient transport or upstream fault | Retry with backoff, reads only |
| `terminal` | Request is invalid or refused | Fail the transition, report upward |
| `needs-reprice` | Offer or session no longer valid | Route to `EXPIRED` or `PRICE_CHANGED` |
| `order-state` | 402/404/406 and similar | Route to `PAYMENT_UNCERTAIN`, never retry |

Retries apply to read operations only. `pay.do` is never retried
automatically under any classification.

## 6. Mock layer

`src/atlas/mock/` implements the same interface as the live client,
backed by JSON fixtures shaped to the documented schemas. It is a
behavioural simulator, not a stub, and reproduces:

- `routingIdentifier` expiring at 6 hours and `sessionId` at 2 hours
- Order hold expiry at 30 minutes, and 5 minutes on the Fulfilment path
- Price movement between search and verify
- Payment succeeding while ticketing completes several polls later
- Refund status advancing `0 → 1 → 2`, and terminating at `4` rejected
- Injectable failures: `402`, `404`, `406`, ticketing failure, timeout

Time is injected, not read from the system clock, so expiry tests run
instantly.

Once sandbox credentials arrive, real request and response pairs are
recorded from the audit log into this fixture set so the mock
converges on observed behaviour rather than drifting from it.

## 7. Booking state machine

The state machine is the core of the system. It owns every identifier,
every expiry clock, and every legal transition. No Atlas call is made
outside it.

### States

```
IDLE → SEARCHED → VERIFIED → ANCILLARIES → ORDER_CREATED
     → [CONFIRMED]  (Ryanair only)
     → AWAITING_APPROVAL → PAYING → PAID → TICKETING → TICKETED

Terminal or recovery states:
  EXPIRED · PRICE_CHANGED · PAYMENT_UNCERTAIN · FAILED · CANCELLED

Post-booking sub-machines, keyed by orderNo:
  REFUND_QUOTED → REFUND_REQUESTED → REFUNDED | REJECTED
  VOID_QUOTED   → VOID_REQUESTED   → VOIDED
```

### Rules

Every state record carries its identifier plus `issuedAt` and
`expiresAt`. **Every transition evaluates the clock before it
evaluates anything else.** An expired identifier routes to `EXPIRED`
carrying a message that names the exact step to redo.

Transitions are pure functions from `(state, event) → state`. The
executor performs the Atlas call, then applies the resulting
transition, then persists. State is persisted after every transition,
so a crash mid-flow is recoverable and never leaves an order in an
unknown local state.

An illegal transition raises `IllegalTransitionError`, surfaced to the
model as a recoverable tool error naming the current state and the
required next step — for example, "cannot pay: session expired at
14:02, re-verify first".

`verify` compares the returned fare against the searched fare. Any
delta routes to `PRICE_CHANGED`, which invalidates any existing
approval and requires a fresh one before payment can proceed.

Reads are transitions too. `queryOrder`, `orderList`, balance, and
refund status all execute through the machine, so every call is
audited and every result is applied to state through one code path.

## 8. Approval gate

Money-moving operations — pay, refund submission, void submission —
cannot be executed directly by a tool call. The tool creates a
`PendingApproval` and returns a reference; execution happens only
after a human approves.

Each `PendingApproval` renders a full summary for the human:

- Itinerary with carriers, flight numbers, times, and stops
- Passengers by type
- Fare breakdown per passenger type, taxes, transaction fee and its
  mode (`PER_SEGMENT` / `PER_TICKET` / `PER_PAX` / `PER_BOOKING`)
- Selected seats and baggage with prices
- Total in booking currency
- Refund and change rules
- For refunds: the quoted amount, the penalty, and whether the quote
  is `AccurateQuote` or `CannotQuote`

An approval is bound to a hash of the cart state and is single-use, so
nothing can change between approval and execution. It expires with the
order hold window; an expired approval cannot be redeemed.

Rejection routes the session to `CANCELLED`.

## 9. Payment safety

Payment executes in a fixed order that cannot be bypassed:

1. Query current order state.
2. Assert the order is unpaid. If it is paying, paid, or ticketed,
   abort — do not pay.
3. Assert sufficient hold window remains. Refuse if below the
   configured floor (default 60 seconds standard, 30 seconds on the
   Fulfilment path).
4. Redeem the approval, verifying the cart hash still matches.
5. Record an idempotency key and a payment attempt record.
6. Call pay exactly once.

On `402`, `404`, `406`, or any `order-state` error, the session routes
to `PAYMENT_UNCERTAIN`. The only exit is a successful `queryOrder`
reconciliation that establishes the true state. No automatic retry
occurs from this state, and the model is not offered a payment tool
while in it.

Payment method is fixed to deposit (method 1) in v1. VCC pass-through
and MoR are modelled in the schemas but disabled behind
`ENABLE_CARD_PAYMENTS`, which defaults to false. No card data is
accepted, stored, or logged by v1.

## 10. Ticketing and refund pollers

A background poller advances orders in `TICKETING` by calling query
order with exponential backoff until a final state is reached, then
writes the airline PNR and `ticketNos` into the booking record. A
matching poller advances refund requests until status reaches `2`,
`4`, `5`, or `6`.

Polling is infrastructure, not agent behaviour. The model never loops
on a query call; it reads the current record and reports status.

## 11. Agent runtime

An Anthropic SDK conversation loop streams to the UI.

The defining property of this architecture: **tool schemas are
generated from the state machine's currently legal actions.** In
`SEARCHED`, no payment tool exists in the model's schema. In
`PAYMENT_UNCERTAIN`, only reconciliation is offered. The guard is
structural rather than an instruction the model might disregard.

Tools exposed, gated by state:

| Tool | Legal in |
|---|---|
| `find_flights` | `IDLE`, `SEARCHED`, `EXPIRED` |
| `price_offer` | `SEARCHED` |
| `list_ancillaries`, `select_ancillaries` | `VERIFIED`, `ANCILLARIES` |
| `place_order` | `ANCILLARIES`, `VERIFIED` |
| `confirm_order` | `ORDER_CREATED` (Ryanair) |
| `request_payment_approval` | `ORDER_CREATED`, `CONFIRMED` |
| `check_order` | `ORDER_CREATED` onward |
| `reconcile_payment` | `PAYMENT_UNCERTAIN` |
| `list_bookings` | always |
| `quote_refund`, `request_refund_approval` | `TICKETED` |
| `quote_void`, `request_void_approval` | `TICKETED` within void window |
| `add_post_ticket_ancillary` | `TICKETED` |
| `check_balance` | always |

The system prompt covers role and policy, date and currency
discipline, a prohibition on inventing prices or availability, a
requirement to cite the specific offer under discussion, and a
requirement to surface fare and refund rules before requesting
approval.

## 12. Persistence and audit

Repository interfaces over SQLite via better-sqlite3. Entities:
booking session, booking record, approval, payment attempt,
conversation, and audit entry.

Every Atlas request and response is persisted to the audit log with a
correlation id. This is both the compliance trail and the source of
recorded fixtures for the mock layer.

Repositories are interfaces so Postgres can replace SQLite without the
state machine changing.

## 13. Web UI

- `app/page.tsx` — chat
- `app/api/chat/route.ts` — SSE stream from the agent loop
- `app/api/approvals/[id]/route.ts` — approve and reject

Tool results render as components, never raw JSON: `FlightOfferCard`,
`FareRulesPanel`, `AncillaryPicker`, `OrderSummary`, `ApprovalDialog`,
`TicketStatusBadge`, `RefundQuotePanel`, `BookingRecordTable`.

Components are organised as `layout/`, `pages/`, `providers/`,
`shared/`, `ui/`. Logging uses pino throughout; `console.log` is not
used.

## 14. Configuration

Environment is validated with zod at startup and fails fast:

| Variable | Purpose |
|---|---|
| `ATLAS_MODE` | `mock` \| `sandbox` \| `production` |
| `ATLAS_CLIENT_ID`, `ATLAS_CLIENT_SECRET` | Atlas credentials, required unless mode is `mock` |
| `ATLAS_SEARCH_BASE_URL`, `ATLAS_TXN_BASE_URL` | Production splits these |
| `ANTHROPIC_API_KEY` | Agent loop |
| `DATABASE_PATH` | SQLite file |
| `ENABLE_CARD_PAYMENTS` | Defaults to false |
| `MAX_ORDER_VALUE` | Hard ceiling; approvals above it are refused |

Secrets live in `.env.local` and are never committed.

## 15. Testing

Test-driven throughout.

- **Unit** — exhaustive transition coverage, including every expiry
  path and every illegal move from every state.
- **Contract** — each zod schema validated against fixtures; schema
  drift fails the suite.
- **Integration** — full flows against the mock: one-way, round trip,
  with ancillaries, refund, and void.
- **Adversarial** — the suite this design exists to satisfy:
  - identifier expires mid-flow at each stage
  - price changes at verify, after approval
  - payment returns 402, 404, 406
  - payment times out with unknown outcome
  - ticketing fails after successful payment
  - the same approval is redeemed twice
  - two payment attempts race on one order
  - refund attempted on a partially-used itinerary
  - order hold expires while awaiting approval

## 16. Risks

| Risk | Mitigation |
|---|---|
| Endpoint paths differ between guide and reference | Pin from API reference before writing client code |
| No sandbox credentials yet | Mock-first; single switch to sandbox |
| Duplicate payment | Query-then-pay ordering, idempotency keys, `PAYMENT_UNCERTAIN` with no auto-retry |
| Model takes an illegal step | Tool schemas generated from legal actions only |
| Fulfilment path's 5-minute window | Window floor check before payment; approval expiry tied to hold |
| Vendor schema drift | Parsed responses, contract tests |
| PCI exposure | Deposit only in v1; card payments flagged off |

## 17. Open items for implementation

1. Pin exact endpoint paths and field names from each API reference
   page before writing the corresponding client module.
2. Confirm the void endpoint set and its window, which the
   documentation describes as `voidQuotation.do`, `void.do`, and
   `queryVoidOrders.do`, against the current reference page.
3. Confirm whether the balance endpoint is required before payment
   under deposit, and if so make it a payment precondition.
